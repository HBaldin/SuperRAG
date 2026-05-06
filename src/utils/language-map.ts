export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // JavaScript / TypeScript
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  // Python
  '.py': 'python',
  '.pyw': 'python',
  '.pyi': 'python',
  // C#
  '.cs': 'csharp',
  '.csx': 'csharp',
  // Java
  '.java': 'java',
  // Go
  '.go': 'go',
  // Rust
  '.rs': 'rust',
  // C / C++
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  // PHP
  '.php': 'php',
  // Kotlin
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  // Swift
  '.swift': 'swift',
  // Ruby
  '.rb': 'ruby',
  '.rake': 'ruby',
  // Shell
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.fish': 'bash',
  // SQL
  '.sql': 'sql',
  // Data formats
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.csv': 'csv',
  // Web
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.sass': 'css',
  '.less': 'css',
  // Docs
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.rst': 'rst',
  '.txt': 'text',
  '.adoc': 'asciidoc',
  // Config
  '.env': 'env',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  // Infrastructure
  '.tf': 'terraform',
  '.hcl': 'hcl',
  // Containers
  Dockerfile: 'dockerfile',
  '.dockerfile': 'dockerfile',
  // Rich docs
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.odt': 'odt',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  // Logs
  '.log': 'log',
};

export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib',
  '.wasm', '.pyc', '.pyo', '.class',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.db', '.sqlite', '.sqlite3',
]);

export const TREE_SITTER_LANGUAGES = new Set([
  'javascript', 'typescript', 'python', 'go', 'rust',
  'java', 'c', 'cpp', 'csharp', 'ruby', 'php', 'bash',
  'sql', 'json', 'yaml', 'toml', 'html', 'css',
]);

export const CODE_LANGUAGES = new Set([
  'javascript', 'typescript', 'python', 'csharp', 'java',
  'go', 'rust', 'c', 'cpp', 'php', 'kotlin', 'swift',
  'ruby', 'bash', 'sql',
]);

export const DOC_LANGUAGES = new Set([
  'markdown', 'rst', 'text', 'asciidoc', 'html',
]);

export const RICH_DOC_LANGUAGES = new Set([
  'pdf', 'docx', 'odt', 'pptx', 'xlsx', 'csv',
]);

export const CONFIG_LANGUAGES = new Set([
  'json', 'yaml', 'toml', 'xml', 'env', 'ini',
  'terraform', 'hcl', 'dockerfile',
]);

export function getLanguageFromPath(filePath: string): string | null {
  const basename = filePath.split('/').pop() ?? '';
  const ext = '.' + basename.split('.').pop();

  // Check exact filename first (e.g., Dockerfile)
  if (EXTENSION_TO_LANGUAGE[basename]) return EXTENSION_TO_LANGUAGE[basename]!;
  if (EXTENSION_TO_LANGUAGE[ext]) return EXTENSION_TO_LANGUAGE[ext]!;
  return null;
}

export function isBinaryPath(filePath: string): boolean {
  const ext = '.' + (filePath.split('.').pop() ?? '');
  return BINARY_EXTENSIONS.has(ext.toLowerCase());
}

export function getFileCategory(language: string | null): import('../types/index.js').FileCategory {
  if (!language) return 'unknown';
  if (CODE_LANGUAGES.has(language)) return 'code';
  if (DOC_LANGUAGES.has(language)) return 'documentation';
  if (RICH_DOC_LANGUAGES.has(language)) return 'data';
  if (CONFIG_LANGUAGES.has(language)) return 'config';
  if (language === 'terraform' || language === 'hcl' || language === 'dockerfile') return 'infrastructure';
  return 'unknown';
}
