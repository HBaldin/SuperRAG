import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { scanDirectory, computeDelta, IgnoreManager } from './scanner.js';
import type { FileFingerprint } from '../types/index.js';

const TMP = '/tmp/superrag-scanner-test';

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, 'src'), { recursive: true });
  mkdirSync(join(TMP, 'node_modules/foo'), { recursive: true });
  writeFileSync(join(TMP, 'src/index.ts'), 'export const x = 1;');
  writeFileSync(join(TMP, 'src/utils.ts'), 'export function add(a: number, b: number) { return a + b; }');
  writeFileSync(join(TMP, 'README.md'), '# Test Project');
  writeFileSync(join(TMP, 'node_modules/foo/index.js'), 'module.exports = {}');
  writeFileSync(join(TMP, '.gitignore'), 'node_modules\n');
});

describe('scanDirectory', () => {
  it('should scan files and exclude node_modules', async () => {
    const result = await scanDirectory({ rootPath: TMP });
    const paths = result.files.map(f => f.relativePath);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/utils.ts');
    expect(paths).toContain('README.md');
    expect(paths.some(p => p.includes('node_modules'))).toBe(false);
  });

  it('should detect language correctly', async () => {
    const result = await scanDirectory({ rootPath: TMP });
    const tsFile = result.files.find(f => f.relativePath === 'src/index.ts');
    expect(tsFile?.language).toBe('typescript');
    const mdFile = result.files.find(f => f.relativePath === 'README.md');
    expect(mdFile?.language).toBe('markdown');
  });

  it('should generate consistent hashes', async () => {
    const r1 = await scanDirectory({ rootPath: TMP });
    const r2 = await scanDirectory({ rootPath: TMP });
    const f1 = r1.files.find(f => f.relativePath === 'src/index.ts');
    const f2 = r2.files.find(f => f.relativePath === 'src/index.ts');
    expect(f1?.hash).toBe(f2?.hash);
  });
});

describe('computeDelta', () => {
  it('should detect new files', async () => {
    const result = await scanDirectory({ rootPath: TMP });
    const delta = computeDelta(new Map(), result.files);
    expect(delta.newFiles.length).toBe(result.files.length);
    expect(delta.modifiedFiles.length).toBe(0);
    expect(delta.deletedPaths.length).toBe(0);
  });

  it('should detect modified files', async () => {
    const result = await scanDirectory({ rootPath: TMP });
    const prevMap = new Map<string, FileFingerprint>(
      result.files.map(f => [f.relativePath, { ...f, hash: 'old-hash' }])
    );
    const delta = computeDelta(prevMap, result.files);
    expect(delta.modifiedFiles.length).toBe(result.files.length);
  });

  it('should detect deleted files', async () => {
    const result = await scanDirectory({ rootPath: TMP });
    const prevMap = new Map<string, FileFingerprint>([
      ['deleted/file.ts', { path: 'deleted/file.ts', absolutePath: '/tmp/deleted/file.ts', hash: 'abc', modifiedTime: 0, size: 0, encoding: 'utf-8', mimeType: 'text/plain', isBinary: false }],
      ...result.files.map(f => [f.relativePath, f] as [string, FileFingerprint]),
    ]);
    const delta = computeDelta(prevMap, result.files);
    expect(delta.deletedPaths).toContain('deleted/file.ts');
  });
});
