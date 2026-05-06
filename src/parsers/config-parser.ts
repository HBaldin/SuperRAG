import { BaseParser } from './base.js';
import { generateId } from '../utils/hash.js';
import { getLogger } from '../utils/logger.js';
import type { ScannedFile, StructuredDocument, DocumentSection } from '../types/index.js';

const logger = getLogger('config-parser');

export class ConfigParser extends BaseParser {
  readonly supportedLanguages = ['json', 'yaml', 'toml', 'xml', 'env', 'ini', 'terraform', 'hcl', 'dockerfile'];

  async parse(file: ScannedFile, content: string): Promise<StructuredDocument> {
    const id = generateId('doc', file.relativePath);
    const language = file.language ?? 'unknown';
    const sections: DocumentSection[] = [];
    let parsed: unknown = null;

    try {
      if (language === 'json') {
        parsed = JSON.parse(content);
        sections.push(...this.jsonToSections(id, parsed, content));
      } else if (language === 'yaml') {
        const yaml = await import('yaml');
        parsed = yaml.parse(content);
        sections.push(...this.objectToSections(id, parsed, content));
      } else if (language === 'toml') {
        const toml = await import('toml');
        parsed = (toml as { parse: (s: string) => unknown }).parse(content);
        sections.push(...this.objectToSections(id, parsed, content));
      } else if (language === 'dockerfile') {
        sections.push(...this.dockerfileToSections(id, content));
      } else {
        // Generic: split by blank lines
        sections.push(...this.genericSections(id, content));
      }
    } catch (err) {
      logger.warn({ path: file.relativePath, language, err }, 'Config parse failed, using raw text');
      sections.push({
        id: `${id}_section_0`,
        title: file.relativePath,
        level: 1,
        content,
        startLine: 1,
        endLine: content.split('\n').length,
      });
    }

    const pathParts = file.relativePath.split('/');
    const module = pathParts.length > 1 ? pathParts[0] ?? null : null;

    return {
      id,
      path: file.absolutePath,
      relativePath: file.relativePath,
      type: 'config',
      language,
      module,
      symbols: [],
      dependencies: [],
      sections,
      rawText: content,
      metadata: { parsed: parsed !== null },
      fingerprint: file,
    };
  }

  private jsonToSections(docId: string, parsed: unknown, raw: string): DocumentSection[] {
    if (typeof parsed !== 'object' || parsed === null) {
      return [{ id: `${docId}_s0`, title: 'root', level: 1, content: raw, startLine: 1, endLine: raw.split('\n').length }];
    }
    const sections: DocumentSection[] = [];
    let idx = 0;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      sections.push({
        id: `${docId}_s${idx++}`,
        title: key,
        level: 1,
        content: JSON.stringify({ [key]: value }, null, 2),
        startLine: 1,
        endLine: 1,
      });
    }
    return sections;
  }

  private objectToSections(docId: string, parsed: unknown, raw: string): DocumentSection[] {
    return this.jsonToSections(docId, parsed, raw);
  }

  private dockerfileToSections(docId: string, content: string): DocumentSection[] {
    const lines = content.split('\n');
    const sections: DocumentSection[] = [];
    let current: string[] = [];
    let startLine = 1;
    let idx = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.startsWith('FROM') || line.startsWith('RUN') || line.startsWith('COPY') || line.startsWith('CMD') || line.startsWith('ENTRYPOINT')) {
        if (current.length > 0) {
          sections.push({
            id: `${docId}_s${idx++}`,
            title: current[0]?.split(' ')[0] ?? 'block',
            level: 1,
            content: current.join('\n'),
            startLine,
            endLine: i,
          });
        }
        current = [line];
        startLine = i + 1;
      } else {
        current.push(line);
      }
    }

    if (current.length > 0) {
      sections.push({
        id: `${docId}_s${idx}`,
        title: current[0]?.split(' ')[0] ?? 'block',
        level: 1,
        content: current.join('\n'),
        startLine,
        endLine: lines.length,
      });
    }

    return sections;
  }

  private genericSections(docId: string, content: string): DocumentSection[] {
    const lines = content.split('\n');
    const sections: DocumentSection[] = [];
    let current: string[] = [];
    let startLine = 1;
    let idx = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '' && current.length > 0) {
        sections.push({
          id: `${docId}_s${idx++}`,
          title: `block_${idx}`,
          level: 1,
          content: current.join('\n'),
          startLine,
          endLine: i,
        });
        current = [];
        startLine = i + 2;
      } else {
        current.push(line);
      }
    }

    if (current.length > 0) {
      sections.push({
        id: `${docId}_s${idx}`,
        title: `block_${idx}`,
        level: 1,
        content: current.join('\n'),
        startLine,
        endLine: lines.length,
      });
    }

    return sections.length > 0 ? sections : [{
      id: `${docId}_s0`,
      title: 'content',
      level: 1,
      content,
      startLine: 1,
      endLine: lines.length,
    }];
  }
}
