/**
 * JSON files shared between the running gateway and the `pnpm grants` command.
 *
 * Writes go to a temporary file and are renamed into place, so a reader never
 * sees half a file — a torn grants file would otherwise read as "no grants" or,
 * worse, fail to parse and take the gateway down.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt file must not be mistaken for valid state. Callers treat the
    // fallback as "nothing granted", which fails closed.
    return fallback;
  }
}

export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
