import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archiveRoot = 'Dijital360-PrintShop';
const expectedVersion = 'v24.19.0';
const requiredSource = [
  'LICENSE', 'package.json', 'package-lock.json', 'scripts/windows-launch.mjs',
  'server/local.ts', 'server/windowsLauncher.ts', 'server/windowsCredentials.ts',
  'server/http.ts', 'server/database.ts', 'server/repository.ts',
  'packaging/windows/Baslat.cmd', 'packaging/windows/Giris-Bilgileri.cmd', 'packaging/windows/BENI-OKU.txt',
];

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!['--runtime-dir', '--output', '--owner-email'].includes(name) || !argv[index + 1] || result[name]) {
      throw new Error('Usage: node scripts/package-windows.mjs --runtime-dir DIR --output FILE.zip --owner-email ADDRESS');
    }
    result[name] = argv[index + 1];
  }
  if (Object.keys(result).length !== 3) throw new Error('All three packaging arguments are required.');
  const ownerEmail = result['--owner-email'].trim().toLowerCase();
  if (ownerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) || /[\u0000-\u001f\u007f]/.test(ownerEmail)) {
    throw new Error('A valid non-secret owner email address is required.');
  }
  const output = path.resolve(result['--output']);
  if (!output.toLowerCase().endsWith('.zip')) throw new Error('The output path must end in .zip.');
  const relativeOutput = path.relative(repository, output);
  if (!relativeOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOutput)) {
    throw new Error('Write release artifacts outside the source checkout.');
  }
  return { runtimeDirectory: path.resolve(result['--runtime-dir']), output, ownerEmail };
}

async function command(executable, args, configuration = {}) {
  return execute(executable, args, { cwd: repository, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...configuration });
}

async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function regularFile(file) {
  const status = await fs.lstat(file);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`A regular file is required: ${file}`);
  return status;
}

function forbiddenSource(relative) {
  const parts = relative.split('/');
  const name = parts.at(-1);
  return parts.some((part) => ['.git', 'node_modules', '.provenance', '.print-shop.local'].includes(part) || part.endsWith('.local'))
    || (name.startsWith('.env') && !['.env.example', '.env.sample', '.env.template'].includes(name))
    || name === '.npmrc' || /\.(?:sqlite3?|db)(?:-(?:wal|shm))?$/i.test(name)
    || parts[0] === 'dist';
}

async function cleanSource(expectedCommit) {
  const { stdout: status } = await command('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.length) throw new Error('Packaging requires a clean Git checkout. Commit the Windows helpers and all source changes first.');
  const commit = (await command('git', ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit) || (expectedCommit && expectedCommit !== commit)) {
    throw new Error('The source commit changed during packaging. Start again from a clean committed revision.');
  }
  const source = (await command('git', ['ls-tree', '-rz', 'HEAD'])).stdout.split('\0').filter(Boolean).map((entry) => {
    const match = /^(\d+) \S+ [0-9a-f]+\t(.+)$/s.exec(entry);
    if (!match || !['100644', '100755'].includes(match[1])) throw new Error('Source archives must not contain symlinks or unexpanded submodules.');
    const relative = match[2];
    if (forbiddenSource(relative)) throw new Error(`Private or generated material must not be committed to a portable source release: ${relative}`);
    return relative;
  });
  for (const required of requiredSource) if (!source.includes(required)) throw new Error(`Commit the required Windows release file first: ${required}`);
  return { commit, source };
}

async function verifyRuntime(directory) {
  const manifestPath = path.join(directory, 'runtime-manifest.json');
  await regularFile(manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.version !== expectedVersion || manifest.checksumManifestUrl !== `https://nodejs.org/dist/${expectedVersion}/SHASUMS256.txt`) {
    throw new Error('Use the verified official Node v24.19.0 Windows runtime bundle.');
  }
  const checksumFile = path.join(directory, 'downloads', 'SHASUMS256.txt');
  await regularFile(checksumFile);
  if (await sha256(checksumFile) !== manifest.checksumManifestSha256) throw new Error('The official runtime checksum manifest changed.');
  const officialChecksums = new Map((await fs.readFile(checksumFile, 'utf8')).trim().split(/\r?\n/).map((line) => {
    const [hash, filename] = line.trim().split(/\s+/);
    return [filename, hash];
  }));
  for (const [architecture, machine] of [['x64', 0x8664], ['arm64', 0xaa64]]) {
    const entry = manifest[architecture];
    const filename = `node-${expectedVersion}-win-${architecture}.zip`;
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.exeSha256) || entry.archiveSha256 !== officialChecksums.get(filename)
      || entry.url !== `https://nodejs.org/dist/${expectedVersion}/${filename}`) throw new Error(`Invalid official runtime provenance: ${architecture}`);
    const archive = path.join(directory, 'downloads', filename);
    await regularFile(archive);
    if (await sha256(archive) !== entry.archiveSha256) throw new Error(`The verified runtime archive changed: ${architecture}`);
    const executable = path.join(directory, 'runtime', architecture, 'node.exe');
    await regularFile(executable);
    if (await sha256(executable) !== entry.exeSha256) throw new Error(`Runtime executable checksum mismatch: ${architecture}`);
    const handle = await fs.open(executable, 'r');
    try {
      const dos = Buffer.alloc(64);
      await handle.read(dos, 0, dos.length, 0);
      if (dos.toString('ascii', 0, 2) !== 'MZ') throw new Error(`Invalid Windows executable: ${architecture}`);
      const pe = Buffer.alloc(6);
      await handle.read(pe, 0, pe.length, dos.readUInt32LE(60));
      if (pe.toString('binary', 0, 4) !== 'PE\0\0' || pe.readUInt16LE(4) !== machine) throw new Error(`Wrong Windows runtime architecture: ${architecture}`);
    } finally { await handle.close(); }
    const license = path.join(directory, 'runtime', architecture, 'LICENSE');
    await regularFile(license);
    if (!entry.licenseSha256 || await sha256(license) !== entry.licenseSha256) throw new Error(`Runtime license checksum mismatch: ${architecture}`);
  }
  return manifest;
}

async function stageRuntime(source, destination) {
  await fs.copyFile(path.join(source, 'runtime-manifest.json'), path.join(destination, 'runtime-manifest.json'));
  for (const architecture of ['x64', 'arm64']) {
    const target = path.join(destination, 'runtime', architecture);
    await fs.mkdir(target, { recursive: true });
    for (const filename of ['node.exe', 'LICENSE']) await fs.copyFile(path.join(source, 'runtime', architecture, filename), path.join(target, filename));
  }
}

async function dependencyInstall(app, scratch) {
  const env = { ...process.env, NODE_ENV: 'production', npm_config_strict_ssl: 'true', NPM_CONFIG_STRICT_SSL: 'true' };
  // Reuse the managed trust binding and proxy environment; never disable TLS.
  if (!env.NODE_EXTRA_CA_CERTS && process.env.CODEX_PROXY_CERT) {
    if (!(await fs.stat(process.env.CODEX_PROXY_CERT)).isFile()) throw new Error('The configured proxy CA file is unavailable.');
    env.NODE_EXTRA_CA_CERTS = process.env.CODEX_PROXY_CERT;
  }
  const cache = process.env.PRINT_SHOP_NPM_CACHE || path.join(scratch, 'npm-cache');
  const before = await sha256(path.join(app, 'package-lock.json'));
  try {
    await command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--strict-ssl=true', '--no-audit', '--no-fund', '--cache', cache], { cwd: app, env });
  } catch {
    throw new Error('Production dependency installation failed. Check registry access and the configured TLS trust before retrying.');
  }
  if (await sha256(path.join(app, 'package-lock.json')) !== before) throw new Error('The locked production install unexpectedly changed package-lock.json.');
}

async function inspectTree(root) {
  const files = [];
  async function visit(directory, relative = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const dependency = name.startsWith('app/node_modules/');
      if (dependency && entry.name === '.bin') { await fs.rm(absolute, { recursive: true, force: true }); continue; }
      const status = await fs.lstat(absolute);
      if (status.isSymbolicLink()) throw new Error(`Portable archives do not permit symlinks: ${name}`);
      if (status.isDirectory()) { await visit(absolute, name); continue; }
      if (!status.isFile()) throw new Error(`Unexpected non-file entry in portable archive: ${name}`);
      if (entry.name === '.npmrc' || (entry.name.startsWith('.env') && !['.env.example', '.env.sample', '.env.template'].includes(entry.name))) {
        throw new Error(`Environment or private npm configuration found in package: ${name}`);
      }
      if (dependency) {
        const handle = await fs.open(absolute, 'r');
        const signature = Buffer.alloc(4);
        try { await handle.read(signature, 0, 4, 0); } finally { await handle.close(); }
        const magic = signature.toString('hex');
        if (/\.(?:node|exe|dll|dylib|so(?:\.\d+)*)$/i.test(entry.name)
          || ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic)
          || signature.toString('ascii', 0, 2) === 'MZ') throw new Error(`A platform-native dependency cannot be bundled for both Windows architectures: ${name}`);
      }
      files.push(name);
    }
  }
  await visit(root);
  return files.sort();
}

const pythonZip = String.raw`
import datetime, os, pathlib, stat, sys, time, zipfile
source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
epoch = float(sys.argv[3])
if hasattr(time, 'tzset'): time.tzset()
files = []
for current, directories, names in os.walk(source, followlinks=False):
    directories.sort()
    names.sort()
    for name in directories + names:
        item = pathlib.Path(current) / name
        if item.is_symlink(): raise RuntimeError('Symlinks are forbidden in the release archive')
    for name in names:
        item = pathlib.Path(current) / name
        if not item.is_file(): raise RuntimeError('Only regular files can be archived')
        files.append(item)
with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True) as archive:
    for item in sorted(files, key=lambda value: value.relative_to(source).as_posix()):
        os.utime(item, (epoch, epoch), follow_symlinks=False)
        archive.write(item, arcname=source.name + '/' + item.relative_to(source).as_posix(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
with zipfile.ZipFile(destination) as archive:
    if archive.testzip() is not None: raise RuntimeError('ZIP CRC verification failed')
`;

async function main() {
  const config = options(process.argv.slice(2));
  const source = await cleanSource();
  const runtime = await verifyRuntime(config.runtimeDirectory);
  // Vite automatically reads root .env files; keep a private deployment's
  // configuration out of an otherwise clean, portable browser build.
  const environmentFiles = (await fs.readdir(repository)).filter((name) => name.startsWith('.env') && !['.env.example', '.env.sample', '.env.template'].includes(name));
  if (environmentFiles.length) throw new Error('Build portable releases from a checkout without private .env files.');
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'print-shop-windows-package-'));
  let partial;
  try {
    const stage = path.join(scratch, archiveRoot);
    const app = path.join(stage, 'app');
    await fs.mkdir(app, { recursive: true });
    const tar = path.join(scratch, 'source.tar');
    await command('git', ['archive', '--format=tar', `--output=${tar}`, 'HEAD']);
    await command('tar', ['-xf', tar, '-C', app]);
    for (const file of requiredSource) await regularFile(path.join(app, file));
    await stageRuntime(config.runtimeDirectory, stage);
    for (const filename of ['Baslat.cmd', 'Giris-Bilgileri.cmd', 'BENI-OKU.txt']) {
      const from = path.join(app, 'packaging', 'windows', filename);
      if (filename.endsWith('.cmd')) {
        const data = await fs.readFile(from);
        const text = data.toString('utf8');
        if (data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || !text.includes('\r\n') || text.replaceAll('\r\n', '').includes('\n') || text.includes('\\r\\n')) {
          throw new Error(`Windows command files require actual CRLF lines without a byte-order mark: ${filename}`);
        }
      }
      await fs.copyFile(from, path.join(stage, filename));
    }
    const buildEnv = { ...process.env, VITE_PRINT_SHOP_MODE: 'live', VITE_ADMINIUM_API_BASE_URL: '', VITE_ADMINIUM_PUBLISHABLE_KEY: '', VITE_ADMINIUM_SURFACE_SIDE: '' };
    try { await command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:shop'], { env: buildEnv }); }
    catch { throw new Error('The fresh live-shop build failed; no portable archive was published.'); }
    await cleanSource(source.commit);
    await regularFile(path.join(repository, 'dist', 'index.html'));
    await fs.cp(path.join(repository, 'dist'), path.join(app, 'dist'), { recursive: true, dereference: false, errorOnExist: true });
    await dependencyInstall(app, scratch);
    await fs.writeFile(path.join(app, 'windows-owner.json'), `${JSON.stringify({ ownerEmail: config.ownerEmail }, null, 2)}\n`, { mode: 0o600 });
    const files = await inspectTree(stage);
    const critical = new Set([
      'Baslat.cmd', 'Giris-Bilgileri.cmd', 'BENI-OKU.txt', 'runtime-manifest.json',
      'runtime/x64/node.exe', 'runtime/x64/LICENSE', 'runtime/arm64/node.exe', 'runtime/arm64/LICENSE',
      'app/LICENSE', 'app/package.json', 'app/package-lock.json', 'app/windows-owner.json',
      'app/scripts/windows-launch.mjs', 'app/server/local.ts', 'app/server/windowsLauncher.ts',
      'app/server/windowsCredentials.ts', 'app/server/http.ts', 'app/server/database.ts', 'app/server/repository.ts',
      ...files.filter((file) => file.startsWith('app/dist/') || file.startsWith('app/db/migrations/')
        || /^app\/server\/[^/]+\.ts$/.test(file) || /^app\/src\/lib\/[^/]+\.ts$/.test(file)),
      'app/db/schema.sql', 'app/src/data/shopContract.ts', 'app/src/data/types.ts',
    ]);
    const criticalHashes = {};
    for (const file of [...critical].sort()) { await regularFile(path.join(stage, file)); criticalHashes[file] = await sha256(path.join(stage, file)); }
    const preparedAt = new Date().toISOString();
    await fs.writeFile(path.join(stage, 'package-manifest.json'), `${JSON.stringify({ formatVersion: 1, sourceCommit: source.commit,
      nodeVersion: runtime.version, buildNodeVersion: process.version, preparedAt, ownerEmail: config.ownerEmail, criticalHashes }, null, 2)}\n`);
    await inspectTree(stage);
    await fs.mkdir(path.dirname(config.output), { recursive: true });
    partial = `${config.output}.${process.pid}.partial`;
    await command('python3', ['-c', pythonZip, stage, partial, String(Date.parse(preparedAt) / 1000)], { env: { ...process.env, TZ: 'UTC' } });
    const checksum = await sha256(partial);
    const sizeBytes = (await fs.stat(partial)).size;
    await fs.rename(partial, config.output);
    partial = undefined;
    const checksumPath = `${config.output}.sha256`;
    await fs.writeFile(checksumPath, `${checksum}  ${path.basename(config.output)}\n`);
    console.log(JSON.stringify({ path: config.output, sizeBytes, sha256: checksum, checksumPath }));
  } finally {
    if (partial) await fs.rm(partial, { force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Windows package preparation failed.');
  process.exitCode = 1;
});
