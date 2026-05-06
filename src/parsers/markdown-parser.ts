import { BaseParser } from './base.js';
import { generateId } from '../utils/hash.js';
import { getLogger } from '../utils/logger.js';
import type { ScannedFile, StructuredDocument, DocumentSection } from '../types/index.js';

const logger = getLogger('markdown-parser');

interface HeadingNode {
  level: number;
  title: string;
  startLine: number;
  content: string[];
}

export class MarkdownParser extends BaseParser {
  readonly supportedLanguages = ['markdown'];

  async parse(file: ScannedFile, content: string): Promise<StructuredDocument> {
    const id = generateId('doc', file.relativePath);
    const lines = content.split('\n');
    const sections: DocumentSection[] = [];
    const headings: HeadingNode[] = [];

    let currentHeading: HeadingNode | null = null;
    let inCodeBlock = false;
    const codeBlocks: string[] = [];
    let currentCodeBlock: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      // Track code blocks
      if (line.startsWith('```') || line.startsWith('~~~')) {
        if (inCodeBlock) {
          codeBlocks.push(currentCodeBlock.join('\n'));
          currentCodeBlock = [];
          inCodeBlock = false;
        } else {
          inCodeBlock = true;
        }
        currentHeading?.content.push(line);
        continue;
      }

      if (inCodeBlock) {
        currentCodeBlock.push(line);
        currentHeading?.content.push(line);
        continue;
      }

      // Detect headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        if (currentHeading) {
          headings.push(currentHeading);
        }
        currentHeading = {
          level: headingMatch[1]!.length,
          title: headingMatch[2]!.trim(),
          startLine: i + 1,
          content: [line],
        };
      } else {
        currentHeading?.content.push(line);
      }
    }

    if (currentHeading) headings.push(currentHeading);

    // Build sections
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i]!;
      const nextH = headings[i + 1];
      const endLine = nextH ? nextH.startLine - 1 : lines.length;

      sections.push({
        id: `${id}_section_${i}`,
        title: h.title,
        level: h.level,
        content: h.content.join('\n'),
        startLine: h.startLine,
        endLine,
      });
    }

    // Extract title from first H1
    const title = headings.find(h => h.level === 1)?.title;

    // Extract tags from content (e.g., #tag patterns)
    const tagMatches = content.match(/(?<!\w)#([a-zA-Z][a-zA-Z0-9_-]*)/g) ?? [];
    const tags = [...new Set(tagMatches.map(t => t.slice(1)))].slice(0, 20);

    const pathParts = file.relativePath.split('/');
    const module = pathParts.length > 1 ? pathParts[0] ?? null : null;

    logger.debug({ path: file.relativePath, sections: sections.length, headings: headings.length }, 'Markdown parsed');

    return {
      id,
      path: file.absolutePath,
      relativePath: file.relativePath,
      type: 'documentation',
      language: 'markdown',
      module,
      symbols: [],
      dependencies: [],
      sections,
      rawText: content,
      metadata: {
        title,
        tags,
        codeBlockCount: codeBlocks.length,
        headingCount: headings.length,
      },
      fingerprint: file,
    };
  }
}
