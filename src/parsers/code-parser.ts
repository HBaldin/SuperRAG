import { BaseParser } from './base.js';
import { generateId } from '../utils/hash.js';
import { getLogger } from '../utils/logger.js';
import type { ScannedFile, StructuredDocument, Symbol, DocumentSection } from '../types/index.js';

const logger = getLogger('code-parser');

// ─── Tree-sitter Dynamic Loader ──────────────────────────────────────────────

interface TreeSitterNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TreeSitterNode[];
  namedChildren: TreeSitterNode[];
  childForFieldName(name: string): TreeSitterNode | null;
  descendantsOfType(type: string): TreeSitterNode[];
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface TreeSitterLanguage {
  // opaque
}

interface TreeSitterParser {
  setLanguage(lang: TreeSitterLanguage): void;
  parse(source: string): TreeSitterTree;
}

interface TreeSitterModule {
  Parser: new () => TreeSitterParser;
}

// Lazy-loaded tree-sitter
let TreeSitter: TreeSitterModule | null = null;

async function getTreeSitter(): Promise<TreeSitterModule> {
  if (!TreeSitter) {
    TreeSitter = (await import('tree-sitter')) as unknown as TreeSitterModule;
  }
  return TreeSitter;
}

const languageModuleMap: Record<string, string> = {
  javascript: 'tree-sitter-javascript',
  typescript: 'tree-sitter-typescript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  c: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
  csharp: 'tree-sitter-c-sharp',
  ruby: 'tree-sitter-ruby',
  php: 'tree-sitter-php',
  bash: 'tree-sitter-bash',
};

const loadedLanguages = new Map<string, TreeSitterLanguage>();

async function loadLanguage(language: string): Promise<TreeSitterLanguage | null> {
  if (loadedLanguages.has(language)) return loadedLanguages.get(language)!;

  const moduleName = languageModuleMap[language];
  if (!moduleName) return null;

  try {
    const mod = await import(moduleName) as { default?: unknown };
    // TypeScript grammar has typescript and tsx sub-grammars
    let lang: unknown;
    if (language === 'typescript') {
      lang = (mod.default as Record<string, unknown>)?.['typescript'] ?? mod.default;
    } else {
      lang = mod.default;
    }
    if (lang) {
      loadedLanguages.set(language, lang as TreeSitterLanguage);
      return lang as TreeSitterLanguage;
    }
  } catch (err) {
    logger.warn({ language, err }, 'Failed to load tree-sitter language');
  }
  return null;
}

// ─── Symbol Extraction ───────────────────────────────────────────────────────

function extractText(node: TreeSitterNode): string {
  return node.text ?? '';
}

function getNodeLines(node: TreeSitterNode): { startLine: number; endLine: number } {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function findDocComment(node: TreeSitterNode, source: string): string | undefined {
  const lines = source.split('\n');
  const startLine = node.startPosition.row;
  if (startLine === 0) return undefined;

  const prevLine = lines[startLine - 1]?.trim() ?? '';
  if (prevLine.startsWith('//') || prevLine.startsWith('*') || prevLine.startsWith('/*')) {
    return prevLine.replace(/^\/\/\s*|^\*\s*|^\/\*\s*|\s*\*\/$/, '').trim();
  }
  return undefined;
}

// Generic symbol extractor for JS/TS
function extractJsTsSymbols(rootNode: TreeSitterNode, source: string): Symbol[] {
  const symbols: Symbol[] = [];

  function visit(node: TreeSitterNode): void {
    switch (node.type) {
      case 'function_declaration':
      case 'function_expression':
      case 'arrow_function': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const { startLine, endLine } = getNodeLines(node);
          symbols.push({
            name: extractText(nameNode),
            kind: 'function',
            startLine,
            endLine,
            docComment: findDocComment(node, source),
          });
        }
        break;
      }
      case 'class_declaration':
      case 'class': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const { startLine, endLine } = getNodeLines(node);
          symbols.push({
            name: extractText(nameNode),
            kind: 'class',
            startLine,
            endLine,
            docComment: findDocComment(node, source),
          });
        }
        break;
      }
      case 'method_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const { startLine, endLine } = getNodeLines(node);
          symbols.push({
            name: extractText(nameNode),
            kind: 'method',
            startLine,
            endLine,
          });
        }
        break;
      }
      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const { startLine, endLine } = getNodeLines(node);
          symbols.push({
            name: extractText(nameNode),
            kind: 'interface',
            startLine,
            endLine,
          });
        }
        break;
      }
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return symbols;
}

// Python symbol extractor
function extractPythonSymbols(rootNode: TreeSitterNode, source: string): Symbol[] {
  const symbols: Symbol[] = [];

  function visit(node: TreeSitterNode): void {
    if (node.type === 'function_definition' || node.type === 'async_function_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const { startLine, endLine } = getNodeLines(node);
        symbols.push({
          name: extractText(nameNode),
          kind: 'function',
          startLine,
          endLine,
          docComment: findDocComment(node, source),
        });
      }
    } else if (node.type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const { startLine, endLine } = getNodeLines(node);
        symbols.push({
          name: extractText(nameNode),
          kind: 'class',
          startLine,
          endLine,
        });
      }
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return symbols;
}

// Generic extractor for other languages
function extractGenericSymbols(rootNode: TreeSitterNode, source: string, _language: string): Symbol[] {
  const symbols: Symbol[] = [];
  const functionTypes = new Set([
    'function_declaration', 'function_definition', 'method_declaration',
    'function_item', // Rust
    'func_declaration', // Go
    'method_spec',
  ]);
  const classTypes = new Set([
    'class_declaration', 'class_definition', 'struct_item', // Rust
    'type_declaration', // Go
    'impl_item', // Rust
  ]);

  function visit(node: TreeSitterNode): void {
    if (functionTypes.has(node.type)) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const { startLine, endLine } = getNodeLines(node);
        symbols.push({ name: extractText(nameNode), kind: 'function', startLine, endLine });
      }
    } else if (classTypes.has(node.type)) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const { startLine, endLine } = getNodeLines(node);
        symbols.push({ name: extractText(nameNode), kind: 'class', startLine, endLine });
      }
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return symbols;
}

// ─── Import/Export Extraction ────────────────────────────────────────────────

function extractImports(rootNode: TreeSitterNode, _language: string): string[] {
  const imports: string[] = [];

  function visit(node: TreeSitterNode): void {
    if (
      node.type === 'import_statement' ||
      node.type === 'import_declaration' ||
      node.type === 'import_from_statement'
    ) {
      imports.push(node.text.split('\n')[0]?.trim() ?? node.text.slice(0, 100));
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return imports.slice(0, 50); // cap at 50
}

// ─── Code Parser ─────────────────────────────────────────────────────────────

export class CodeParser extends BaseParser {
  readonly supportedLanguages = Object.keys(languageModuleMap);

  async parse(file: ScannedFile, content: string): Promise<StructuredDocument> {
    const id = generateId('doc', file.relativePath);
    const language = file.language ?? 'unknown';

    let symbols: Symbol[] = [];
    let imports: string[] = [];

    try {
      const ts = await getTreeSitter();
      const lang = await loadLanguage(language);

      if (lang) {
        const parser = new ts.Parser();
        parser.setLanguage(lang);
        const tree = parser.parse(content);
        const root = tree.rootNode;

        if (language === 'javascript' || language === 'typescript') {
          symbols = extractJsTsSymbols(root, content);
          imports = extractImports(root, language);
        } else if (language === 'python') {
          symbols = extractPythonSymbols(root, content);
          imports = extractImports(root, language);
        } else {
          symbols = extractGenericSymbols(root, content, language);
          imports = extractImports(root, language);
        }
      }
    } catch (err) {
      logger.warn({ path: file.relativePath, language, err }, 'Tree-sitter parse failed, using fallback');
    }

    // Build sections from symbols
    const sections = symbols
      .filter(s => s.kind === 'function' || s.kind === 'class' || s.kind === 'method')
      .map((s, i): DocumentSection => ({
        id: `${id}_section_${i}`,
        title: `${s.kind}: ${s.name}`,
        level: s.kind === 'class' ? 1 : 2,
        content: content.split('\n').slice(s.startLine - 1, s.endLine).join('\n'),
        startLine: s.startLine,
        endLine: s.endLine,
      }));

    // Detect module from path
    const pathParts = file.relativePath.split('/');
    const module = pathParts.length > 1 ? pathParts[0] ?? null : null;

    return {
      id,
      path: file.absolutePath,
      relativePath: file.relativePath,
      type: 'code',
      language,
      module,
      symbols,
      dependencies: imports,
      sections,
      rawText: content,
      metadata: {
        imports,
        exports: symbols.filter(s => s.isExported).map(s => s.name),
        testFile: file.relativePath.includes('.test.') ||
          file.relativePath.includes('.spec.') ||
          file.relativePath.includes('__tests__'),
      },
      fingerprint: file,
    };
  }
}
