import { describe, it, expect, beforeEach } from 'vitest';
import { MarkdownParser } from './markdown-parser.js';
import { ConfigParser } from './config-parser.js';
import { FallbackParser } from './fallback-parser.js';
import { CsvParser } from './csv-parser.js';
import { ParserRegistry } from './registry.js';
import type { ScannedFile } from '../types/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFile(overrides: Partial<ScannedFile> = {}): ScannedFile {
  return {
    path: '/tmp/test-file',
    absolutePath: '/tmp/test-file',
    relativePath: 'test-file',
    extension: '.txt',
    language: null,
    category: 'unknown',
    hash: 'abc123',
    modifiedTime: Date.now(),
    size: 100,
    encoding: 'utf-8',
    mimeType: 'text/plain',
    isBinary: false,
    ...overrides,
  };
}

// ─── MarkdownParser ───────────────────────────────────────────────────────────

describe('MarkdownParser', () => {
  const parser = new MarkdownParser();

  it('supports markdown language', () => {
    const file = makeFile({ language: 'markdown' });
    expect(parser.supports(file)).toBe(true);
  });

  it('does not support non-markdown', () => {
    const file = makeFile({ language: 'json' });
    expect(parser.supports(file)).toBe(false);
  });

  it('parses headings into sections', async () => {
    const file = makeFile({ language: 'markdown', relativePath: 'README.md' });
    const content = `# Title\n\nSome intro text.\n\n## Section One\n\nContent here.\n\n## Section Two\n\nMore content.`;
    const doc = await parser.parse(file, content);

    expect(doc.type).toBe('documentation');
    expect(doc.language).toBe('markdown');
    expect(doc.sections).toHaveLength(3);
    expect(doc.sections[0]!.title).toBe('Title');
    expect(doc.sections[0]!.level).toBe(1);
    expect(doc.sections[1]!.title).toBe('Section One');
    expect(doc.sections[1]!.level).toBe(2);
    expect(doc.sections[2]!.title).toBe('Section Two');
  });

  it('extracts title from first H1', async () => {
    const file = makeFile({ language: 'markdown', relativePath: 'doc.md' });
    const content = `# My Document\n\nContent.`;
    const doc = await parser.parse(file, content);

    expect(doc.metadata['title']).toBe('My Document');
  });

  it('counts code blocks', async () => {
    const file = makeFile({ language: 'markdown', relativePath: 'guide.md' });
    const content = `# Guide\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\nSome text.\n\n\`\`\`bash\necho hello\n\`\`\``;
    const doc = await parser.parse(file, content);

    expect(doc.metadata['codeBlockCount']).toBe(2);
  });

  it('returns empty sections for content with no headings', async () => {
    const file = makeFile({ language: 'markdown', relativePath: 'plain.md' });
    const content = `Just some plain text without any headings.`;
    const doc = await parser.parse(file, content);

    expect(doc.sections).toHaveLength(0);
    expect(doc.rawText).toBe(content);
  });

  it('detects module from path', async () => {
    const file = makeFile({ language: 'markdown', relativePath: 'docs/guide.md' });
    const content = `# Guide`;
    const doc = await parser.parse(file, content);

    expect(doc.module).toBe('docs');
  });
});

// ─── ConfigParser ─────────────────────────────────────────────────────────────

describe('ConfigParser', () => {
  const parser = new ConfigParser();

  it('supports json, yaml, toml', () => {
    expect(parser.supports(makeFile({ language: 'json' }))).toBe(true);
    expect(parser.supports(makeFile({ language: 'yaml' }))).toBe(true);
    expect(parser.supports(makeFile({ language: 'toml' }))).toBe(true);
  });

  it('does not support code files', () => {
    expect(parser.supports(makeFile({ language: 'typescript' }))).toBe(false);
  });

  it('parses JSON into sections per top-level key', async () => {
    const file = makeFile({ language: 'json', relativePath: 'config.json' });
    const content = JSON.stringify({ name: 'super-rag', version: '0.1.0', debug: true });
    const doc = await parser.parse(file, content);

    expect(doc.type).toBe('config');
    expect(doc.language).toBe('json');
    expect(doc.sections.length).toBeGreaterThanOrEqual(3);
    const titles = doc.sections.map(s => s.title);
    expect(titles).toContain('name');
    expect(titles).toContain('version');
    expect(titles).toContain('debug');
  });

  it('marks parsed=true on successful JSON parse', async () => {
    const file = makeFile({ language: 'json', relativePath: 'pkg.json' });
    const content = `{"key": "value"}`;
    const doc = await parser.parse(file, content);

    expect(doc.metadata['parsed']).toBe(true);
  });

  it('falls back gracefully on invalid JSON', async () => {
    const file = makeFile({ language: 'json', relativePath: 'bad.json' });
    const content = `{ invalid json `;
    const doc = await parser.parse(file, content);

    expect(doc.type).toBe('config');
    expect(doc.sections).toHaveLength(1);
    expect(doc.metadata['parsed']).toBe(false);
  });

  it('parses YAML into sections', async () => {
    const file = makeFile({ language: 'yaml', relativePath: 'config.yaml' });
    const content = `name: super-rag\nversion: 0.1.0\ndebug: true`;
    const doc = await parser.parse(file, content);

    expect(doc.type).toBe('config');
    expect(doc.sections.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── FallbackParser ───────────────────────────────────────────────────────────

describe('FallbackParser', () => {
  const parser = new FallbackParser();

  it('supports any file (always returns true)', () => {
    expect(parser.supports(makeFile({ language: null }))).toBe(true);
    expect(parser.supports(makeFile({ language: 'typescript' }))).toBe(true);
    expect(parser.supports(makeFile({ language: 'unknown-lang' }))).toBe(true);
  });

  it('parses plain text into segments', async () => {
    const file = makeFile({ language: null, relativePath: 'notes.txt' });
    const content = `This is a long paragraph with enough characters to be included as a section in the output.\n\nThis is another paragraph that also has enough content to be segmented properly by the fallback parser.`;
    const doc = await parser.parse(file, content);

    expect(doc.type).toBe('unknown');
    expect(doc.sections.length).toBeGreaterThan(0);
    expect(doc.rawText).toBe(content);
  });

  it('returns at least one section for any non-empty content', async () => {
    const file = makeFile({ language: null, relativePath: 'data.bin' });
    const content = `x`.repeat(100);
    const doc = await parser.parse(file, content);

    expect(doc.sections.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves language from file', async () => {
    const file = makeFile({ language: 'sql', relativePath: 'query.sql' });
    const content = `SELECT * FROM users WHERE id = 1;`;
    const doc = await parser.parse(file, content);

    expect(doc.language).toBe('sql');
  });
});

// ─── CsvParser ────────────────────────────────────────────────────────────────

describe('CsvParser', () => {
  const parser = new CsvParser();

  it('supports csv language', () => {
    expect(parser.supports(makeFile({ language: 'csv' }))).toBe(true);
    expect(parser.supports(makeFile({ language: 'json' }))).toBe(false);
  });

  it('parses CSV headers and row count', async () => {
    const file = makeFile({ language: 'csv', relativePath: 'data.csv' });
    const content = `id,name,email\n1,Alice,alice@example.com\n2,Bob,bob@example.com\n3,Carol,carol@example.com`;
    const doc = await parser.parse(file, content);

    expect(doc.type).toBe('data');
    expect(doc.metadata['headers']).toEqual(['id', 'name', 'email']);
    expect(doc.metadata['rowCount']).toBe(3);
    expect(doc.metadata['columnCount']).toBe(3);
  });

  it('creates schema and sample sections', async () => {
    const file = makeFile({ language: 'csv', relativePath: 'users.csv' });
    const content = `name,age\nAlice,30\nBob,25`;
    const doc = await parser.parse(file, content);

    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0]!.title).toBe('Schema');
    expect(doc.sections[1]!.title).toBe('Sample Data');
  });
});

// ─── ParserRegistry ───────────────────────────────────────────────────────────

describe('ParserRegistry', () => {
  let registry: ParserRegistry;

  beforeEach(() => {
    registry = new ParserRegistry();
    registry.register(new MarkdownParser());
    registry.register(new ConfigParser());
    registry.register(new CsvParser());
    registry.register(new FallbackParser());
  });

  it('returns MarkdownParser for markdown files', () => {
    const file = makeFile({ language: 'markdown' });
    const parser = registry.getParser(file);
    expect(parser).toBeInstanceOf(MarkdownParser);
  });

  it('returns ConfigParser for json files', () => {
    const file = makeFile({ language: 'json' });
    const parser = registry.getParser(file);
    expect(parser).toBeInstanceOf(ConfigParser);
  });

  it('returns ConfigParser for yaml files', () => {
    const file = makeFile({ language: 'yaml' });
    const parser = registry.getParser(file);
    expect(parser).toBeInstanceOf(ConfigParser);
  });

  it('returns CsvParser for csv files', () => {
    const file = makeFile({ language: 'csv' });
    const parser = registry.getParser(file);
    expect(parser).toBeInstanceOf(CsvParser);
  });

  it('returns FallbackParser for unknown language', () => {
    const file = makeFile({ language: null });
    const parser = registry.getParser(file);
    expect(parser).toBeInstanceOf(FallbackParser);
  });

  it('returns FallbackParser for unregistered language', () => {
    const file = makeFile({ language: 'cobol' });
    const parser = registry.getParser(file);
    expect(parser).toBeInstanceOf(FallbackParser);
  });

  it('lists all registered parsers', () => {
    const list = registry.listParsers();
    expect(list.length).toBe(4);
  });
});
