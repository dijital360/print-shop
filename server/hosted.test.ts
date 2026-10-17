import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "./database.ts";
import { bootstrapHosted, readHostedConfig } from "./hosted.ts";
import { hashPassword, verifyPassword } from "./http.ts";
import { ShopRepository } from "./repository.ts";

const DATABASE_URL = "postgresql://hosted_user:fixture-database-password@database.invalid:5432/print_shop";
const EMAIL = "owner@example.test";
const PASSWORD = "Initial staff password for tests";
const directories: string[] = [];
const openConnections = new Set<Database>();

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PRINT_SHOP_PUBLIC_ORIGIN: "https://shop.example.test",
    DATABASE_URL,
    ...overrides,
  };
}

function configuredEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return environment({
    PRINT_SHOP_INITIAL_STAFF_EMAIL: EMAIL,
    PRINT_SHOP_INITIAL_STAFF_PASSWORD: PASSWORD,
    ...overrides,
  });
}

async function caught(operation: () => unknown | Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected hosted setup to fail.");
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "print-shop-hosted-"));
  directories.push(directory);
  const receivedOptions: { connectionString: string }[] = [];
  let closeCalls = 0;
  const localDatabase = async () => {
    const database = await openDatabase({ connectionString: "", dataDir: join(directory, "database") });
    openConnections.add(database);
    return database;
  };
  const close = async (database: Database) => {
    try { await database.close(); }
    finally { openConnections.delete(database); }
  };
  return {
    receivedOptions,
    get closeCalls() { return closeCalls; },
    async open(options: { connectionString: string }): Promise<Database> {
      receivedOptions.push(options);
      const database = await localDatabase();
      return {
        ...database,
        async close() {
          closeCalls++;
          await close(database);
        },
      };
    },
    async withRepository<T>(callback: (repository: ShopRepository, database: Database) => Promise<T>): Promise<T> {
      const database = await localDatabase();
      try {
        const repository = new ShopRepository(database);
        await repository.initialize();
        return await callback(repository, database);
      } finally { await close(database); }
    },
  };
}

afterEach(async () => {
  for (const database of openConnections) {
    try { await database.close(); }
    finally { openConnections.delete(database); }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("hosted configuration", () => {
  it("uses an explicit HTTPS origin, PostgreSQL and the default public port", () => {
    const config = readHostedConfig(environment());
    expect(config.publicOrigin).toBe("https://shop.example.test");
    expect(config.port).toBe(8080);
    expect(config.connectionString).toBe(DATABASE_URL);
    expect(config.initialStaff).toBeUndefined();
  });

  it("normalizes the initial staff email while preserving the password", () => {
    const config = readHostedConfig(configuredEnvironment({ PRINT_SHOP_INITIAL_STAFF_EMAIL: " Owner@Example.Test " }));
    expect(config.initialStaff).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it("accepts exact HTTPS origins with an explicit nondefault port", () => {
    expect(readHostedConfig(environment({ PRINT_SHOP_PUBLIC_ORIGIN: "https://shop.example.test:8443" })).publicOrigin)
      .toBe("https://shop.example.test:8443");
  });

  it("uses the Railway public domain before the Render URL", () => {
    const config = readHostedConfig(environment({
      PRINT_SHOP_PUBLIC_ORIGIN: undefined,
      RAILWAY_PUBLIC_DOMAIN: "print-shop-production.up.railway.app",
      RENDER_EXTERNAL_URL: "https://print-shop.onrender.com",
    }));
    expect(config.publicOrigin).toBe("https://print-shop-production.up.railway.app");
  });

  it("uses the Render URL when the other public origins are absent", () => {
    expect(readHostedConfig(environment({
      PRINT_SHOP_PUBLIC_ORIGIN: undefined,
      RENDER_EXTERNAL_URL: "https://print-shop.onrender.com",
    })).publicOrigin).toBe("https://print-shop.onrender.com");
  });

  it("prefers the explicit origin without validating unused platform fallbacks", () => {
    expect(readHostedConfig(environment({
      RAILWAY_PUBLIC_DOMAIN: "unused-invalid/domain",
      RENDER_EXTERNAL_URL: "http://unused.example.test/path",
    })).publicOrigin).toBe("https://shop.example.test");
  });

  it("requires a public HTTPS origin and rejects credentials, paths and normalized variants", () => {
    const invalid = [
      undefined, "http://shop.example.test", "https://shop.example.test/", "https://shop.example.test/path",
      "https://shop.example.test?query=1", "https://shop.example.test#fragment",
      "https://user:secret@shop.example.test", " https://shop.example.test", "https://SHOP.example.test",
      "https://shop.example.test:443", "not-a-url", "//shop.example.test",
    ];
    for (const origin of invalid) {
      expect(() => readHostedConfig(environment({ PRINT_SHOP_PUBLIC_ORIGIN: origin }))).toThrow(/HTTPS origin/i);
    }
  });

  it("applies origin validation to platform-provided addresses too", () => {
    for (const domain of ["https://railway.example.test", "railway.example.test/path", "user:secret@railway.example.test"]) {
      expect(() => readHostedConfig(environment({ PRINT_SHOP_PUBLIC_ORIGIN: undefined, RAILWAY_PUBLIC_DOMAIN: domain })))
        .toThrow(/HTTPS origin/i);
    }
    expect(() => readHostedConfig(environment({ PRINT_SHOP_PUBLIC_ORIGIN: undefined, RENDER_EXTERNAL_URL: "http://shop.onrender.com" })))
      .toThrow(/HTTPS origin/i);
  });

  it("accepts valid public TCP ports and reserves the internal API port", () => {
    for (const port of ["1", "8081", "65535"]) expect(readHostedConfig(environment({ PORT: port })).port).toBe(Number(port));
    for (const port of ["", "0", "-1", "65536", "4100", "1.5", "not-a-port", "Infinity"]) {
      expect(() => readHostedConfig(environment({ PORT: port }))).toThrow(/TCP port/i);
    }
  });

  it("requires a PostgreSQL connection string", () => {
    for (const connectionString of [undefined, "", "not-a-url", "https://database.example.test/db", "sqlite:///tmp/shop.db"]) {
      expect(() => readHostedConfig(environment({ DATABASE_URL: connectionString }))).toThrow(/DATABASE_URL/i);
    }
    expect(readHostedConfig(environment({ DATABASE_URL: "postgres://user:password@database.invalid/shop" })).connectionString)
      .toBe("postgres://user:password@database.invalid/shop");
  });

  it("requires both initial staff fields and a valid normalized email", () => {
    const invalid: NodeJS.ProcessEnv[] = [
      { PRINT_SHOP_INITIAL_STAFF_EMAIL: EMAIL },
      { PRINT_SHOP_INITIAL_STAFF_PASSWORD: PASSWORD },
      { PRINT_SHOP_INITIAL_STAFF_EMAIL: EMAIL, PRINT_SHOP_INITIAL_STAFF_PASSWORD: "" },
      { PRINT_SHOP_INITIAL_STAFF_EMAIL: "", PRINT_SHOP_INITIAL_STAFF_PASSWORD: PASSWORD },
      { PRINT_SHOP_INITIAL_STAFF_EMAIL: "not-an-email", PRINT_SHOP_INITIAL_STAFF_PASSWORD: PASSWORD },
      { PRINT_SHOP_INITIAL_STAFF_EMAIL: `${"a".repeat(250)}@example.test`, PRINT_SHOP_INITIAL_STAFF_PASSWORD: PASSWORD },
    ];
    for (const fields of invalid) expect(() => readHostedConfig(environment(fields))).toThrow(/initial staff/i);
  });

  it("defers initial password length validation until a new account is created", () => {
    expect(readHostedConfig(configuredEnvironment({ PRINT_SHOP_INITIAL_STAFF_PASSWORD: "short" })).initialStaff?.password).toBe("short");
  });

  it("does not echo supplied credentials in configuration errors", async () => {
    const secret = "do-not-echo-this-password";
    const failure = await caught(() => readHostedConfig(configuredEnvironment({
      PRINT_SHOP_PUBLIC_ORIGIN: `https://${EMAIL}:${secret}@shop.example.test`,
      PRINT_SHOP_INITIAL_STAFF_PASSWORD: secret,
    })));
    expect(failure.message).toMatch(/HTTPS origin/i);
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain(EMAIL);
    expect(failure.message).not.toContain(DATABASE_URL);
  });
});

describe("hosted database bootstrap", () => {
  it("creates the initial staff account with a verified hash and closes the durable database", async () => {
    const setup = await fixture();
    const config = readHostedConfig(configuredEnvironment({ PRINT_SHOP_INITIAL_STAFF_EMAIL: " Owner@Example.Test " }));
    await bootstrapHosted(config, { openDatabase: setup.open });
    expect(setup.receivedOptions).toEqual([{ connectionString: DATABASE_URL }]);
    expect(setup.closeCalls).toBe(1);
    await setup.withRepository(async (repository, database) => {
      const staff = await repository.findStaff(EMAIL);
      expect(staff).not.toBeNull();
      expect(staff!.passwordHash).not.toBe(PASSWORD);
      expect(staff!.passwordHash).toMatch(/^scrypt\$/);
      expect(await verifyPassword(PASSWORD, staff!.passwordHash)).toBe(true);
      expect((await database.query("SELECT id FROM print_shop.staff")).rows).toHaveLength(1);
    });
  });

  it("never resets an existing account when startup credentials change", async () => {
    const setup = await fixture();
    await bootstrapHosted(readHostedConfig(configuredEnvironment()), { openDatabase: setup.open });
    const original = await setup.withRepository((repository) => repository.findStaff(EMAIL));
    // A short replacement also proves hashing is skipped for an existing account.
    await bootstrapHosted(readHostedConfig(configuredEnvironment({ PRINT_SHOP_INITIAL_STAFF_PASSWORD: "short" })), { openDatabase: setup.open });
    expect(setup.closeCalls).toBe(2);
    await setup.withRepository(async (repository, database) => {
      const staff = await repository.findStaff(EMAIL);
      expect(staff).toEqual(original);
      expect(await verifyPassword(PASSWORD, staff!.passwordHash)).toBe(true);
      expect(await verifyPassword("short", staff!.passwordHash)).toBe(false);
      expect((await database.query("SELECT id FROM print_shop.staff")).rows).toHaveLength(1);
    });
  });

  it("starts without initial credentials when a staff account already exists", async () => {
    const setup = await fixture();
    const existingEmail = "existing@example.test";
    const passwordHash = await hashPassword(PASSWORD);
    await setup.withRepository(async (repository) => repository.createStaff(existingEmail, passwordHash));
    await bootstrapHosted(readHostedConfig(environment()), { openDatabase: setup.open });
    expect(setup.closeCalls).toBe(1);
    await setup.withRepository(async (repository, database) => {
      expect((await repository.findStaff(existingEmail))?.passwordHash).toBe(passwordHash);
      expect((await database.query("SELECT id FROM print_shop.staff")).rows).toHaveLength(1);
    });
  });

  it("blocks an empty database without initial credentials and closes it after failure", async () => {
    const setup = await fixture();
    const failure = await caught(() => bootstrapHosted(readHostedConfig(environment()), { openDatabase: setup.open }));
    expect(failure.message).toMatch(/initial staff account/i);
    expect(setup.closeCalls).toBe(1);
    await setup.withRepository(async (_repository, database) => {
      expect((await database.query("SELECT id FROM print_shop.staff")).rows).toEqual([]);
    });
  });

  it("sanitizes a failed initial account setup and still closes its database", async () => {
    const setup = await fixture();
    const config = readHostedConfig(configuredEnvironment({ PRINT_SHOP_INITIAL_STAFF_PASSWORD: "short" }));
    const failure = await caught(() => bootstrapHosted(config, { openDatabase: setup.open }));
    expect(failure.message).toMatch(/initial staff/i);
    expect(failure.message).not.toContain(EMAIL);
    expect(failure.message).not.toContain("short");
    expect(failure.message).not.toContain(DATABASE_URL);
    expect(setup.closeCalls).toBe(1);
    await setup.withRepository(async (_repository, database) => {
      expect((await database.query("SELECT id FROM print_shop.staff")).rows).toEqual([]);
    });
  });

  it("does not expose a database connection error containing credentials", async () => {
    const failure = await caught(() => bootstrapHosted(readHostedConfig(configuredEnvironment()), {
      openDatabase: async () => { throw new Error(`Cannot connect to ${DATABASE_URL}`); },
    }));
    expect(failure.message).toMatch(/database/i);
    expect(failure.message).not.toContain(DATABASE_URL);
    expect(failure.message).not.toContain("fixture-database-password");
    expect(failure.message).not.toContain(EMAIL);
  });
});
