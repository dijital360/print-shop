// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type Database } from "./database.ts";
import { createWindowsBackup } from "./windowsBackup.ts";

const copyFault = vi.hoisted(() => ({ mode: "" as "" | "throw" | "corrupt", copies: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async copyFile(...args: Parameters<typeof fs.copyFile>) {
      await fs.copyFile(...args);
      if (copyFault.mode && ++copyFault.copies === 2) {
        if (copyFault.mode === "throw") throw new Error("Injected partial copy failure.");
        const bytes = await fs.readFile(args[1]);
        bytes[0] = bytes[0]! ^ 0xff;
        await fs.writeFile(args[1], bytes);
      }
    },
  };
});

const roots: string[] = [];
const databases = new Set<Database>();
const sockets: SocketServer[] = [];
const CIPHERTEXT = Buffer.from("opaque DPAPI ciphertext fixture").toString("base64");
const OWNER_BYTES = Buffer.from(`${JSON.stringify({ version: 1, protection: "windows-dpapi-current-user", ciphertext: CIPHERTEXT }, null, 2)}\n`);

interface ManifestEntry { path: string; size: number; sha256: string }
interface Manifest { application: string; formatVersion: number; createdAt: string; files: ManifestEntry[] }
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function inventory(root: string): Promise<Record<string, { sha256: string; size: number; mode: number; mtime: number }>> {
  const files: Record<string, { sha256: string; size: number; mode: number; mtime: number }> = {};
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) {
        const metadata = await stat(filename);
        files[relative(root, filename).split(sep).join("/")] = {
          sha256: digest(await readFile(filename)), size: metadata.size, mode: metadata.mode, mtime: metadata.mtimeMs,
        };
      }
    }
  };
  await visit(root);
  return files;
}

async function fixture(realDatabase = false) {
  const root = await mkdtemp(join(tmpdir(), "print-shop-backup-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const backupRoot = join(root, "backups");
  const databaseDir = join(dataRoot, "database");
  await mkdir(databaseDir, { recursive: true });
  await mkdir(backupRoot);
  if (realDatabase) {
    const database = await openDatabase({ connectionString: "", dataDir: databaseDir });
    try {
      await database.exec("CREATE TABLE backup_roundtrip(id integer PRIMARY KEY,label text NOT NULL,payload bytea NOT NULL)");
      await database.query("INSERT INTO backup_roundtrip(id,label,payload) VALUES($1,$2,$3)", [1, "Durable portable order", Buffer.from([0, 255, 10, 20])]);
    } finally { await database.close(); }
  } else {
    await mkdir(join(databaseDir, "nested"));
    await writeFile(join(databaseDir, "PG_VERSION"), "17\n");
    await writeFile(join(databaseDir, "nested", "orders.bin"), Buffer.from([0, 255, 19, 83, 0]));
  }
  await writeFile(join(dataRoot, "owner-protected.json"), OWNER_BYTES);
  await writeFile(join(dataRoot, "local-instance.json"), '{"instanceId":"must-not-be-copied"}');
  await writeFile(join(dataRoot, "session.lock"), "unrelated-lock-must-not-be-copied");
  await writeFile(join(dataRoot, ".env"), "PASSWORD=private-fixture-not-for-the-manifest");
  return { root, dataRoot, backupRoot, databaseDir, lockPath: `${databaseDir}.lock` };
}

async function manifest(directory: string): Promise<{ text: string; value: Manifest }> {
  const text = await readFile(join(directory, "backup-manifest.json"), "utf8");
  return { text, value: JSON.parse(text) as Manifest };
}

afterEach(async () => {
  copyFault.mode = "";
  copyFault.copies = 0;
  await Promise.all(sockets.splice(0).map((socket) => new Promise<void>((resolve) => socket.close(() => resolve()))));
  for (const database of databases) {
    try { await database.close(); }
    finally { databases.delete(database); }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("stopped portable Windows backups", () => {
  it("restores a real closed PGlite database and preserves only verified database and ciphertext bytes", async () => {
    const setup = await fixture(true);
    const before = await inventory(setup.dataRoot);
    const result = await createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.backupRoot });
    expect(isAbsolute(result.directory)).toBe(true);
    expect(dirname(result.directory)).toBe(setup.backupRoot);
    expect(basename(result.directory).startsWith(".")).toBe(false);
    expect(await inventory(setup.dataRoot)).toEqual(before);
    expect(await readdir(setup.backupRoot)).toEqual([basename(result.directory)]);
    await expect(readFile(setup.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(join(result.directory, "owner-protected.json"))).equals(OWNER_BYTES)).toBe(true);
    const { text, value } = await manifest(result.directory);
    expect(value.application).toBe("dijital360-print-shop");
    expect(value.formatVersion).toBe(1);
    expect(Number.isNaN(Date.parse(value.createdAt))).toBe(false);
    expect(Object.keys(value).sort()).toEqual(["application", "createdAt", "files", "formatVersion"]);
    expect(result.files).toBe(value.files.length);
    expect(result.files).toBeGreaterThan(2);
    for (const entry of value.files) {
      expect(Object.keys(entry).sort()).toEqual(["path", "sha256", "size"]);
      expect(isAbsolute(entry.path)).toBe(false);
      expect(entry.path).not.toContain("\\");
      expect(entry.path.split("/")).not.toContain("..");
      expect(entry.path.startsWith("database/") || entry.path === "owner-protected.json").toBe(true);
      const copied = await readFile(join(result.directory, entry.path));
      expect(entry.size).toBe(copied.byteLength);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.sha256).toBe(digest(copied));
      expect(entry.sha256).toBe(before[entry.path]!.sha256);
    }
    for (const forbidden of [setup.root, CIPHERTEXT, "private-fixture-not-for-the-manifest", "must-not-be-copied", "session.lock", "local-instance.json"]) expect(text).not.toContain(forbidden);
    expect((await readdir(result.directory)).sort()).toEqual(["backup-manifest.json", "database", "owner-protected.json"]);
    const restored = await openDatabase({ connectionString: "", dataDir: join(result.directory, "database") });
    databases.add(restored);
    const row = (await restored.query<{ label: string; payload: Uint8Array }>("SELECT label,payload FROM backup_roundtrip WHERE id=1")).rows[0]!;
    expect(row.label).toBe("Durable portable order");
    expect(Array.from(row.payload)).toEqual([0, 255, 10, 20]);
  });

  it("refuses a running database without changing its live lock or publishing a backup", async () => {
    const setup = await fixture(true);
    const database = await openDatabase({ connectionString: "", dataDir: setup.databaseDir });
    databases.add(database);
    const lock = await readFile(setup.lockPath);
    await expect(createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.backupRoot }))
      .rejects.toMatchObject({ code: "DATABASE_IN_USE", message: expect.stringContaining("Ctrl+C") });
    expect((await readFile(setup.lockPath)).equals(lock)).toBe(true);
    expect(await readdir(setup.backupRoot)).toEqual([]);
    expect((await database.query("SELECT label FROM backup_roundtrip WHERE id=1")).rows).toEqual([{ label: "Durable portable order" }]);
  });

  it("preserves a foreign lock instead of treating its unknown owner as stale", async () => {
    const setup = await fixture();
    const lock = Buffer.from(JSON.stringify({ pid: process.pid, hostname: "foreign-host.invalid", token: "foreign-lock-fixture" }));
    await writeFile(setup.lockPath, lock);
    const before = await inventory(setup.dataRoot);
    await expect(createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.backupRoot }))
      .rejects.toMatchObject({ code: "DATABASE_IN_USE" });
    expect((await readFile(setup.lockPath)).equals(lock)).toBe(true);
    expect(await inventory(setup.dataRoot)).toEqual(before);
    expect(await readdir(setup.backupRoot)).toEqual([]);
  });

  it("rejects relative, nested-source and package destinations before creating them", async () => {
    const setup = await fixture();
    const packageRoot = join(setup.root, "extracted-package");
    await mkdir(packageRoot);
    const before = await inventory(setup.dataRoot);
    for (const options of [
      { dataRoot: "relative-data", backupRoot: setup.backupRoot },
      { dataRoot: setup.dataRoot, backupRoot: "relative-backup" },
      { dataRoot: `${setup.dataRoot}${sep}.${sep}`, backupRoot: setup.backupRoot },
      { dataRoot: setup.dataRoot, backupRoot: `${setup.backupRoot}${sep}..${sep}backups` },
      { dataRoot: setup.dataRoot, backupRoot: join(setup.backupRoot, "not-created", "NUL") },
      { dataRoot: setup.dataRoot, backupRoot: join(setup.backupRoot, "not-created", "file:stream") },
      { dataRoot: setup.dataRoot, backupRoot: setup.dataRoot },
      { dataRoot: setup.dataRoot, backupRoot: join(setup.dataRoot, "new-backups") },
      { dataRoot: setup.dataRoot, backupRoot: join(setup.databaseDir, "new-backups") },
      { dataRoot: setup.dataRoot, backupRoot: setup.backupRoot, packageRoot: "relative-package" },
      { dataRoot: setup.dataRoot, backupRoot: packageRoot, packageRoot },
      { dataRoot: setup.dataRoot, backupRoot: join(packageRoot, "new-backups"), packageRoot },
    ]) {
      await expect(createWindowsBackup(options)).rejects.toMatchObject({ code: "INVALID_BACKUP_PATH" });
    }
    expect(await inventory(setup.dataRoot)).toEqual(before);
    expect(await readdir(packageRoot)).toEqual([]);
    expect(await readdir(setup.backupRoot)).toEqual([]);
    const missing = join(setup.root, "missing-data");
    await expect(createWindowsBackup({ dataRoot: missing, backupRoot: setup.backupRoot }))
      .rejects.toMatchObject({ code: "DATABASE_NOT_FOUND" });
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports safe outside nested destinations and ancestor directories without recursive source copying", async () => {
    const setup = await fixture();
    const before = await inventory(setup.dataRoot);
    const nestedRoot = join(setup.root, "new", "nested", "backups");
    const nested = await createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: nestedRoot });
    expect(dirname(nested.directory)).toBe(nestedRoot);
    const ancestor = await createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.root });
    expect(dirname(ancestor.directory)).toBe(setup.root);
    expect((await manifest(ancestor.directory)).value.files).toHaveLength(3);
    expect(await inventory(setup.dataRoot)).toEqual(before);
  });

  it("rejects source links and linked target components without following them", async () => {
    const setup = await fixture();
    const external = join(setup.root, "external");
    await mkdir(external);
    await writeFile(join(external, "private.txt"), "private-outside-backup-source");
    const sourceLink = join(setup.databaseDir, "external");
    await symlink(external, sourceLink, "junction");
    await expect(createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.backupRoot }))
      .rejects.toMatchObject({ code: "UNSAFE_BACKUP_SOURCE" });
    expect(await readdir(setup.backupRoot)).toEqual([]);
    await expect(readFile(setup.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(sourceLink);
    const targetLink = join(setup.root, "linked-backups");
    await symlink(setup.backupRoot, targetLink, "junction");
    await expect(createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: join(targetLink, "new-child") }))
      .rejects.toMatchObject({ code: "UNSAFE_BACKUP_SOURCE" });
    expect(await readdir(setup.backupRoot)).toEqual([]);
    expect((await readFile(join(external, "private.txt"))).toString()).toBe("private-outside-backup-source");
  });

  it.skipIf(process.platform === "win32")("rejects special source files during preflight and releases its own lock", async () => {
    const setup = await fixture();
    const socket = createSocketServer();
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(join(setup.databaseDir, "special.sock"), () => { socket.off("error", reject); resolve(); });
    });
    await expect(createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.backupRoot }))
      .rejects.toMatchObject({ code: "UNSAFE_BACKUP_SOURCE" });
    expect(await readdir(setup.backupRoot)).toEqual([]);
    await expect(readFile(setup.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects plaintext or unexpected credential fields and linked credential files", async () => {
    const setup = await fixture();
    const ownerPath = join(setup.dataRoot, "owner-protected.json");
    for (const owner of [
      { email: "private-owner@example.test", password: "must-not-be-backed-up" },
      { version: 1, protection: "windows-dpapi-current-user", ciphertext: CIPHERTEXT, password: "unexpected" },
      { version: 1, protection: "windows-dpapi-current-user", ciphertext: "not valid base64!" },
    ]) {
      const bytes = Buffer.from(JSON.stringify(owner));
      await writeFile(ownerPath, bytes);
      await expect(createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.backupRoot }))
        .rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
      expect((await readFile(ownerPath)).equals(bytes)).toBe(true);
      expect(await readdir(setup.backupRoot)).toEqual([]);
      await expect(readFile(setup.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await rm(ownerPath);
    await symlink(setup.backupRoot, ownerPath, "junction");
    await expect(createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.backupRoot }))
      .rejects.toMatchObject({ code: "UNSAFE_BACKUP_SOURCE" });
    expect(await readdir(setup.backupRoot)).toEqual([]);
  });

  it("cleans partial or corrupted copies, leaves the source intact and releases the lock for a later retry", async () => {
    const setup = await fixture();
    const before = await inventory(setup.dataRoot);
    for (const mode of ["throw", "corrupt"] as const) {
      copyFault.mode = mode;
      copyFault.copies = 0;
      await expect(createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.backupRoot }))
        .rejects.toMatchObject({ code: mode === "throw" ? "BACKUP_FAILED" : "BACKUP_VERIFICATION_FAILED" });
      expect(copyFault.copies).toBe(2);
      copyFault.mode = "";
      expect(await readdir(setup.backupRoot)).toEqual([]);
      expect(await inventory(setup.dataRoot)).toEqual(before);
      await expect(readFile(setup.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const retry = await createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.backupRoot });
    expect(retry.files).toBe(3);
    expect(await readdir(setup.backupRoot)).toEqual([basename(retry.directory)]);
  });

  it("creates unique backups and also supports installations without saved owner credentials", async () => {
    const setup = await fixture();
    await rm(join(setup.dataRoot, "owner-protected.json"));
    const first = await createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.backupRoot });
    const second = await createWindowsBackup({ dataRoot: setup.dataRoot, backupRoot: setup.backupRoot });
    expect(first.directory).not.toBe(second.directory);
    expect(first.files).toBe(2);
    expect(second.files).toBe(2);
    expect((await readdir(setup.backupRoot)).sort()).toEqual([basename(first.directory), basename(second.directory)].sort());
    expect((await manifest(first.directory)).value.files).toEqual((await manifest(second.directory)).value.files);
  });
});
