import { createHash } from 'crypto';
import { readFileSync } from 'fs';

export function hashString(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
}

export function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

export function generateId(prefix: string, ...parts: string[]): string {
  const combined = parts.join(':');
  const hash = hashString(combined);
  return `${prefix}_${hash}`;
}
