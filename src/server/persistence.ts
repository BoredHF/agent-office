import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** Replace authoritative JSON only after the complete new record is on disk. */
export function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function backupLegacy(file: string) {
  if (!existsSync(`${file}.legacy.bak`)) copyFileSync(file, `${file}.legacy.bak`);
}
