import { BaseParser } from './base.js';
import { generateId } from '../utils/hash.js';
import { getLogger } from '../utils/logger.js';
import type { ScannedFile, StructuredDocument, DocumentSection } from '../types/index.js';

const logger = getLogger('fallback-parser');

const PARAGRAPH_MIN_CHARS = 50;
const MAX_SECTION_CHARS = 2000;

export class FallbackParser extends BaseParser {
  readonly supportedLanguages: string[] = []; // matches everything via override

  override supports(_file: ScannedFile): boolean {
    return true; // always fallback
  }

  async parse(file: ScannedFile, content: string): Promise<StructuredDocument> {
    const id = generateId('doc', file.relativePath);
    const sections = this.segmentText(id, content);
    const pathParts = file.relativePath.split('/');
    const module = pathParts.length > 1 ? pathParts[0] ?? null : null;

    logger.debug({ path: file.relativePath, sections: sections.length }, 'Fallback parsed');

    return {
      id,
      path: file.absolutePath,
      relativePath: file.relativePath,
      type: 'unknown',
      language: file.language,
      module,
      symbols: [],
      dependencies: [],
      sections,
      rawText: content,
      metadata: {},
      fingerprint: file,
    };
  }

  private segmentText(docId: string, content: string): DocumentSection[] {
    const lines = content.split('\n');
    const sections: DocumentSection[] = [];
    let current: string[] = [];
    let startLine = 1;
    let idx = 0;

    const flush = (endLine: number): void => {
      const text = current.join('\n').trim();
      if (text.length >= PARAGRAPH_MIN_CHARS) {
        sections.push({
          id: `${docId}_s${idx++}`,
          title: `segment_${idx}`,
          level: 1,
          content: text,
          startLine,
          endLine,
        });
      }
      current = [];
      startLine = endLine + 1;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      current.push(line);

      const currentText = current.join('\n');
      if (
        (line.trim() === '' && current.length > 3) ||
        currentText.length > MAX_SECTION_CHARS
      ) {
        flush(i + 1);
      }
    }

    if (current.length > 0) flush(lines.length);

    if (sections.length === 0) {
      sections.push({
        id: `${docId}_s0`,
        title: 'content',
        level: 1,
        content: content.slice(0, MAX_SECTION_CHARS),
        startLine: 1,
        endLine: lines.length,
      });
    }

    return sections;
  }
}
