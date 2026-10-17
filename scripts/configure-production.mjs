import { randomBytes } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { domainToASCII } from 'node:url';

const args = process.argv.slice(2);
const supplied = args.length === 1 ? args[0].trim().toLowerCase() : '';
const domain = /^[\p{L}\p{N}\p{M}.-]+$/u.test(supplied) ? domainToASCII(supplied) : '';
const labels = domain.split('.');
if (!domain || domain.length > 253 || labels.length < 2
  || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  || !/[a-z]/.test(labels.at(-1)) || args[0]?.includes('://')) {
  console.error('Usage: node scripts/configure-production.mjs <public-domain>');
  process.exitCode = 1;
} else {
  const target = '.env.production';
  let file;
  try {
    file = await open(target, 'wx', 0o600);
    try {
      await file.writeFile(`# Private production settings; keep this file out of Git.\nPRINT_SHOP_DOMAIN=${domain}\nPRINT_SHOP_DB_PASSWORD=${randomBytes(32).toString('hex')}\n`);
      await file.sync();
    } catch (error) {
      await file.close(); file = undefined;
      await unlink(target);
      throw error;
    }
    console.info('Created private .env.production. Database password was generated and was not printed.');
    console.info('Follow deploy/README.md to create the staff account before starting the public web service.');
  } catch (error) {
    console.error(error?.code === 'EEXIST'
      ? '.env.production already exists and was left unchanged.'
      : 'Could not create production settings. Check this directory is writable.');
    process.exitCode = 1;
  } finally {
    await file?.close();
  }
}
