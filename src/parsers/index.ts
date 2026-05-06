import { globalRegistry } from './registry.js';
import { CodeParser } from './code-parser.js';
import { MarkdownParser } from './markdown-parser.js';
import { ConfigParser } from './config-parser.js';
import { CsvParser } from './csv-parser.js';
import { FallbackParser } from './fallback-parser.js';
import { getLogger } from '../utils/logger.js';
import { readFile } from 'fs/promises';
import type { ScannedFile, StructuredDocument } from '../types/index.js';

const logger = getLogger('parsers');

// Register all parsers (order matters — fallback last)
const codeParser = new CodeParser();
const markdownParser = new MarkdownParser();
const configParser = new ConfigParser();
const csvParser = new CsvParser();
const fallbackParser = new FallbackParser();

globalRegistry.register(codeParser);
globalRegistry.register(markdownParser);
globalRegistry.register(configParser);
globalRegistry.register(csvParser);
globalRegistry.register(fallbackParser);

export async function parseFile(file: ScannedFile): Promise<StructuredDocument | null> {
  if (file.isBinary) {
    logger.debug({ path: file.relativePath }, 'Skipping binary file');
    return null;
  }

  const parser = globalRegistry.getParser(file);
  if (!parser) {
    logger.warn({ path: file.relativePath }, 'No parser found');
    return null;
  }

  try {
    const content = await readFile(file.absolutePath, 'utf-8');
    const doc = await parser.parse(file, content);
    logger.debug({ path: file.relativePath, type: doc.type, symbols: doc.symbols.length }, 'Parsed');
    return doc;
  } catch (err) {
    logger.error({ path: file.relativePath, err }, 'Parse error');
    return null;
  }
}

export async function parseFiles(files: ScannedFile[]): Promise<StructuredDocument[]> {
  const results: StructuredDocument[] = [];
  for (const file of files) {
    const doc = await parseFile(file);
    if (doc) results.push(doc);
  }
  return results;
}

export { globalRegistry, codeParser, markdownParser, configParser, csvParser, fallbackParser };
export type { IParser } from './base.js';
