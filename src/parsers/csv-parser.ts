import { BaseParser } from './base.js';
import { generateId } from '../utils/hash.js';
import { getLogger } from '../utils/logger.js';
import type { ScannedFile, StructuredDocument, DocumentSection } from '../types/index.js';

const logger = getLogger('csv-parser');

export class CsvParser extends BaseParser {
  readonly supportedLanguages = ['csv'];

  async parse(file: ScannedFile, content: string): Promise<StructuredDocument> {
    const id = generateId('doc', file.relativePath);
    const lines = content.split('\n').filter(l => l.trim());
    const headers = lines[0]?.split(',').map(h => h.trim().replace(/^"|"$/g, '')) ?? [];
    const rowCount = Math.max(0, lines.length - 1);
    const sampleRows = lines.slice(1, 6).map(l =>
      l.split(',').map(v => v.trim().replace(/^"|"$/g, ''))
    );

    const summary = `CSV file with ${headers.length} columns and ${rowCount} rows. Headers: ${headers.join(', ')}`;

    const sections: DocumentSection[] = [
      {
        id: `${id}_schema`,
        title: 'Schema',
        level: 1,
        content: `Headers: ${headers.join(', ')}\nRow count: ${rowCount}`,
        startLine: 1,
        endLine: 1,
      },
      {
        id: `${id}_sample`,
        title: 'Sample Data',
        level: 2,
        content: [headers.join(' | '), ...sampleRows.map(r => r.join(' | '))].join('\n'),
        startLine: 1,
        endLine: Math.min(6, lines.length),
      },
    ];

    const pathParts = file.relativePath.split('/');
    const module = pathParts.length > 1 ? pathParts[0] ?? null : null;

    logger.debug({ path: file.relativePath, headers: headers.length, rows: rowCount }, 'CSV parsed');

    return {
      id,
      path: file.absolutePath,
      relativePath: file.relativePath,
      type: 'data',
      language: 'csv',
      module,
      symbols: [],
      dependencies: [],
      sections,
      rawText: summary,
      metadata: { headers, rowCount, columnCount: headers.length },
      fingerprint: file,
    };
  }
}
