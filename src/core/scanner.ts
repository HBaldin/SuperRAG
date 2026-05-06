import { readdir, stat, readFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { resolve, join, relative, extname } from 'path';
import type { Dirent } from 'fs';
import ignore, { type Ignore } from 'ignore';
import { createHash } from 'crypto';
import { getLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import {
  getLanguageFromPath,
  isBinaryPath,
  getFileCategory,
} from '../utils/language-map.js';
import type { ScannedFile, FileFingerprint } from '../types/index.js';

const logger = getLogger('scanner');

// ─── Binary Detection ────────────────────────────────────────────────────────

const BINARY_SNIFF_BYTES = 8192;

function hasBinaryBytes(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    const byte = buffer[i]!;
    // NULL bytes or non-printable control chars (except tab, LF, CR, FF)
    if (byte === 0) return true;
    if (byte < 8 || (byte > 13 && byte < 32 && byte !== 27)) {
      // Allow ESC for ANSI sequences in logs
      if (byte !== 27) return true;
    }
  }
  return false;
}

// ─── Encoding Detection ──────────────────────────────────────────────────────

function detectEncoding(buffer: Buffer): string {
  // BOM detection
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8-bom';
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16-le';
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16-be';
  // Default assumption
  return 'utf-8';
}

// ─── MIME Type ───────────────────────────────────────────────────────────────

function getMimeType(language: string | null, isBinary: boolean): string {
  if (isBinary) return 'application/octet-stream';
  if (!language) return 'text/plain';
  const mimeMap: Record<string, string> = {
    javascript: 'application/javascript',
    typescript: 'application/typescript',
    python: 'text/x-python',
    json: 'application/json',
    yaml: 'application/yaml',
    html: 'text/html',
    css: 'text/css',
    markdown: 'text/markdown',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv',
  };
  return mimeMap[language] ?? 'text/plain';
}

// ─── Ignore Manager ──────────────────────────────────────────────────────────

export class IgnoreManager {
  private ig: Ignore;
  private rootPath: string;

  constructor(rootPath: string, extraPatterns: string[] = []) {
    this.rootPath = rootPath;
    this.ig = ignore();

    // Load .gitignore if present
    const gitignorePath = join(rootPath, '.gitignore');
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      this.ig.add(content);
    }

    // Load .ragignore if present
    const ragignorePath = join(rootPath, '.ragignore');
    if (existsSync(ragignorePath)) {
      const content = readFileSync(ragignorePath, 'utf-8');
      this.ig.add(content);
    }

    // Add config patterns
    const config = getConfig();
    this.ig.add(config.ignorePatterns);

    // Add extra patterns
    if (extraPatterns.length > 0) {
      this.ig.add(extraPatterns);
    }

    // Always ignore these
    this.ig.add([
      'node_modules',
      '.git',
      'dist',
      'build',
      'bin',
      'obj',
      'coverage',
      '.cache',
      'venv',
      '__pycache__',
      '*.pyc',
      '*.pyo',
      '*.class',
    ]);
  }

  shouldIgnore(relativePath: string): boolean {
    // Normalize path separators
    const normalized = relativePath.replace(/\\/g, '/');
    return this.ig.ignores(normalized);
  }
}

// ─── File Fingerprint ────────────────────────────────────────────────────────

export async function createFingerprint(
  absolutePath: string,
  relativePath: string
): Promise<FileFingerprint> {
  const stats = await stat(absolutePath);
  const buffer = await readFile(absolutePath);
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const isBinary = isBinaryPath(absolutePath) || hasBinaryBytes(buffer);
  const encoding = isBinary ? 'binary' : detectEncoding(buffer);
  const language = getLanguageFromPath(relativePath);
  const mimeType = getMimeType(language, isBinary);

  return {
    path: relativePath,
    absolutePath,
    hash,
    modifiedTime: stats.mtimeMs,
    size: stats.size,
    encoding,
    mimeType,
    isBinary,
  };
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

export interface ScanOptions {
  rootPath: string;
  extraIgnorePatterns?: string[];
  maxFileSizeBytes?: number;
  includeBinary?: boolean;
  onProgress?: (scanned: number, current: string) => void;
}

export interface ScanResult {
  files: ScannedFile[];
  rootPath: string;
  scannedAt: number;
  durationMs: number;
  totalFiles: number;
  skippedFiles: number;
  errors: Array<{ path: string; error: string }>;
}

export async function scanDirectory(options: ScanOptions): Promise<ScanResult> {
  const {
    rootPath,
    extraIgnorePatterns = [],
    maxFileSizeBytes = 10 * 1024 * 1024, // 10MB default
    includeBinary = false,
    onProgress,
  } = options;

  const absoluteRoot = resolve(rootPath);
  const ignoreManager = new IgnoreManager(absoluteRoot, extraIgnorePatterns);
  const files: ScannedFile[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  let totalFiles = 0;
  let skippedFiles = 0;
  const startTime = Date.now();

  logger.info({ rootPath: absoluteRoot }, 'Starting directory scan');

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true }) as unknown as Dirent[];
    } catch (err) {
      errors.push({ path: dir, error: String(err) });
      return;
    }

    for (const entry of entries) {
      const absolutePath = join(dir, entry.name as string);
      const relativePath = relative(absoluteRoot, absolutePath);

      // Check ignore
      if (ignoreManager.shouldIgnore(relativePath)) {
        skippedFiles++;
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;

      totalFiles++;

      try {
        const stats = await stat(absolutePath);

        // Skip oversized files
        if (stats.size > maxFileSizeBytes) {
          logger.debug({ path: relativePath, size: stats.size }, 'Skipping oversized file');
          skippedFiles++;
          continue;
        }

        const fingerprint = await createFingerprint(absolutePath, relativePath);

        // Skip binary unless requested
        if (fingerprint.isBinary && !includeBinary) {
          skippedFiles++;
          continue;
        }

        const language = getLanguageFromPath(relativePath);
        const category = getFileCategory(language);
        const ext = extname(entry.name).toLowerCase();

        const scannedFile: ScannedFile = {
          ...fingerprint,
          relativePath,
          extension: ext,
          language,
          category,
        };

        files.push(scannedFile);
        onProgress?.(files.length, relativePath);

        logger.debug({ path: relativePath, language, category }, 'Scanned file');
      } catch (err) {
        errors.push({ path: relativePath, error: String(err) });
        logger.warn({ path: relativePath, err }, 'Error scanning file');
      }
    }
  }

  await walk(absoluteRoot);

  const durationMs = Date.now() - startTime;

  logger.info(
    { totalFiles, indexed: files.length, skipped: skippedFiles, errors: errors.length, durationMs },
    'Scan complete'
  );

  return {
    files,
    rootPath: absoluteRoot,
    scannedAt: Date.now(),
    durationMs,
    totalFiles,
    skippedFiles,
    errors,
  };
}

// ─── Incremental Delta ───────────────────────────────────────────────────────

export interface FileDelta {
  newFiles: ScannedFile[];
  modifiedFiles: ScannedFile[];
  deletedPaths: string[];
  unchangedFiles: ScannedFile[];
}

export function computeDelta(
  previousFingerprints: Map<string, FileFingerprint>,
  currentFiles: ScannedFile[]
): FileDelta {
  const currentMap = new Map(currentFiles.map(f => [f.relativePath, f]));
  const newFiles: ScannedFile[] = [];
  const modifiedFiles: ScannedFile[] = [];
  const unchangedFiles: ScannedFile[] = [];

  for (const file of currentFiles) {
    const prev = previousFingerprints.get(file.relativePath);
    if (!prev) {
      newFiles.push(file);
    } else if (prev.hash !== file.hash || prev.modifiedTime !== file.modifiedTime) {
      modifiedFiles.push(file);
    } else {
      unchangedFiles.push(file);
    }
  }

  const deletedPaths: string[] = [];
  for (const [path] of previousFingerprints) {
    if (!currentMap.has(path)) {
      deletedPaths.push(path);
    }
  }

  return { newFiles, modifiedFiles, deletedPaths, unchangedFiles };
}
