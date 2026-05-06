import { getLogger } from '../utils/logger.js';
import { estimateTokens, truncateToTokens } from '../utils/tokens.js';
import { getConfig } from '../config/index.js';
import type {
  Chunk,
  StructuredDocument,
  ChunkSummary,
  FileSummary,
  ModuleSummary,
  ProjectSummary,
  SemanticDomain,
  ArchitecturalPattern,
} from '../types/index.js';

const logger = getLogger('summarizer');

// ─── Level 1: Chunk Summary ───────────────────────────────────────────────────

export function summarizeChunk(chunk: Chunk): ChunkSummary {
  const config = getConfig().summarization;

  // Extract first meaningful lines as summary
  const lines = chunk.content.split('\n').filter(l => l.trim().length > 0);
  const firstLines = lines.slice(0, 5).join(' ').replace(/\s+/g, ' ');
  const summary = truncateToTokens(firstLines, config.maxChunkSummaryTokens);

  // Extract responsibilities from content heuristically
  const responsibilities = extractResponsibilities(chunk);

  // Extract inputs/outputs from function signatures
  const { inputs, outputs } = extractSignatureInfo(chunk);

  // Extract side effects
  const sideEffects = extractSideEffects(chunk);

  return {
    chunkId: chunk.id,
    summary,
    responsibilities,
    inputs,
    outputs,
    dependencies: chunk.dependencies,
    sideEffects,
    tags: chunk.tags,
  };
}

function extractResponsibilities(chunk: Chunk): string[] {
  const responsibilities: string[] = [];
  const content = chunk.content.toLowerCase();

  // Heuristic patterns
  if (content.includes('validate') || content.includes('validation')) responsibilities.push('validation');
  if (content.includes('auth') || content.includes('token') || content.includes('jwt')) responsibilities.push('authentication');
  if (content.includes('database') || content.includes('query') || content.includes('sql') || content.includes('db.')) responsibilities.push('database');
  if (content.includes('http') || content.includes('fetch') || content.includes('axios') || content.includes('request')) responsibilities.push('http-client');
  if (content.includes('log') || content.includes('logger') || content.includes('console.')) responsibilities.push('logging');
  if (content.includes('cache') || content.includes('redis') || content.includes('memcache')) responsibilities.push('caching');
  if (content.includes('event') || content.includes('emit') || content.includes('subscribe')) responsibilities.push('event-handling');
  if (content.includes('transform') || content.includes('map(') || content.includes('filter(')) responsibilities.push('data-transformation');
  if (content.includes('error') || content.includes('exception') || content.includes('catch')) responsibilities.push('error-handling');
  if (content.includes('config') || content.includes('env') || content.includes('settings')) responsibilities.push('configuration');
  if (content.includes('test') || content.includes('expect') || content.includes('assert')) responsibilities.push('testing');
  if (content.includes('render') || content.includes('component') || content.includes('jsx')) responsibilities.push('ui-rendering');
  if (content.includes('parse') || content.includes('serialize') || content.includes('deserialize')) responsibilities.push('serialization');
  if (content.includes('encrypt') || content.includes('decrypt') || content.includes('hash')) responsibilities.push('cryptography');
  if (content.includes('file') || content.includes('fs.') || content.includes('readfile')) responsibilities.push('file-io');
  if (content.includes('queue') || content.includes('worker') || content.includes('job')) responsibilities.push('async-processing');
  if (content.includes('migrate') || content.includes('migration') || content.includes('schema')) responsibilities.push('database-migration');

  return [...new Set(responsibilities)];
}

function extractSignatureInfo(chunk: Chunk): { inputs: string[]; outputs: string[] } {
  const inputs: string[] = [];
  const outputs: string[] = [];

  if (!chunk.language) return { inputs, outputs };

  const lines = chunk.content.split('\n');
  const firstLine = lines[0] ?? '';

  // TypeScript/JavaScript function signature
  const tsMatch = firstLine.match(/function\s+\w+\s*\(([^)]*)\)/);
  const arrowMatch = firstLine.match(/(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\(([^)]*)\)/);
  const methodMatch = firstLine.match(/(?:async\s+)?\w+\s*\(([^)]*)\)/);

  const paramStr = tsMatch?.[1] ?? arrowMatch?.[1] ?? methodMatch?.[1] ?? '';
  if (paramStr.trim()) {
    inputs.push(...paramStr.split(',').map(p => p.trim().split(':')[0]?.trim() ?? '').filter(Boolean));
  }

  // Return type
  const returnMatch = firstLine.match(/\):\s*([^{]+)/);
  if (returnMatch?.[1]) {
    outputs.push(returnMatch[1].trim());
  }

  return { inputs: inputs.slice(0, 5), outputs: outputs.slice(0, 3) };
}

function extractSideEffects(chunk: Chunk): string[] {
  const effects: string[] = [];
  const content = chunk.content.toLowerCase();

  if (content.includes('console.log') || content.includes('console.error')) effects.push('console-output');
  if (content.includes('process.exit')) effects.push('process-exit');
  if (content.includes('writefile') || content.includes('appendfile') || content.includes('unlink')) effects.push('file-write');
  if (content.includes('setstate') || content.includes('dispatch(') || content.includes('store.')) effects.push('state-mutation');
  if (content.includes('emit(') || content.includes('publish(')) effects.push('event-emission');
  if (content.includes('insert') || content.includes('update') || content.includes('delete') || content.includes('save(')) effects.push('database-write');
  if (content.includes('send(') || content.includes('sendmail') || content.includes('smtp')) effects.push('external-communication');

  return effects;
}

// ─── Level 2: File Summary ────────────────────────────────────────────────────

export function summarizeFile(doc: StructuredDocument, chunks: Chunk[]): FileSummary {
  const config = getConfig().summarization;

  const exports = doc.symbols
    .filter(s => s.isExported || s.kind === 'function' || s.kind === 'class' || s.kind === 'interface')
    .map(s => s.name)
    .slice(0, 20);

  const domain = detectDomain(doc);
  const architecturalRole = detectArchitecturalRole(doc);

  // Build summary from filename + top symbols
  const symbolNames = doc.symbols.slice(0, 5).map(s => s.name).join(', ');
  const rawSummary = `${doc.relativePath}: ${architecturalRole}. Contains: ${symbolNames || 'text content'}.`;
  const summary = truncateToTokens(rawSummary, config.maxFileSummaryTokens);

  const tags = [
    domain,
    ...detectTags(doc),
  ].filter(Boolean);

  return {
    fileId: doc.id,
    path: doc.relativePath,
    summary,
    purpose: architecturalRole,
    exports,
    dependencies: doc.dependencies.slice(0, 20),
    architecturalRole,
    domain,
    tags: [...new Set(tags)],
  };
}

function detectDomain(doc: StructuredDocument): SemanticDomain {
  const path = doc.relativePath.toLowerCase();
  const content = doc.rawText.toLowerCase();

  if (path.includes('test') || path.includes('spec') || path.includes('__tests__')) return 'tests';
  if (path.includes('auth') || content.includes('jwt') || content.includes('oauth')) return 'auth';
  if (path.includes('security') || content.includes('encrypt') || content.includes('bcrypt')) return 'security';
  if (path.includes('database') || path.includes('db') || path.includes('migration') || path.includes('repository')) return 'database';
  if (path.includes('config') || path.includes('settings') || path.includes('.env')) return 'config';
  if (path.includes('log') || content.includes('pino') || content.includes('winston')) return 'logging';
  if (path.includes('message') || path.includes('queue') || path.includes('kafka') || path.includes('rabbitmq')) return 'messaging';
  if (path.includes('infra') || path.includes('terraform') || path.includes('docker') || path.includes('k8s')) return 'infra';
  if (path.includes('component') || path.includes('page') || path.includes('view') || path.includes('ui')) return 'frontend';
  if (path.includes('api') || path.includes('route') || path.includes('controller') || path.includes('handler')) return 'backend';
  if (path.includes('docs') || path.includes('readme') || doc.type === 'documentation') return 'docs';
  if (path.includes('util') || path.includes('helper') || path.includes('common')) return 'utils';

  return 'unknown';
}

function detectArchitecturalRole(doc: StructuredDocument): string {
  const path = doc.relativePath.toLowerCase();

  if (path.includes('controller')) return 'HTTP controller handling requests and responses';
  if (path.includes('service')) return 'Business logic service layer';
  if (path.includes('repository') || path.includes('repo')) return 'Data access layer / repository pattern';
  if (path.includes('middleware')) return 'Middleware for request/response pipeline';
  if (path.includes('model') || path.includes('entity') || path.includes('schema')) return 'Data model / entity definition';
  if (path.includes('router') || path.includes('routes')) return 'Route definitions and URL mapping';
  if (path.includes('config')) return 'Configuration and settings management';
  if (path.includes('util') || path.includes('helper')) return 'Utility functions and helpers';
  if (path.includes('test') || path.includes('spec')) return 'Test suite';
  if (path.includes('index')) return 'Module entry point / barrel file';
  if (path.includes('migration')) return 'Database migration';
  if (path.includes('seed')) return 'Database seed data';
  if (doc.type === 'documentation') return 'Documentation';
  if (doc.type === 'config') return 'Configuration file';

  return 'General purpose module';
}

function detectTags(doc: StructuredDocument): string[] {
  const tags: string[] = [];
  const content = doc.rawText.toLowerCase();
  const path = doc.relativePath.toLowerCase();

  if (doc.language) tags.push(doc.language);
  if (content.includes('async') || content.includes('await') || content.includes('promise')) tags.push('async');
  if (content.includes('class ')) tags.push('oop');
  if (content.includes('interface ') || content.includes('type ')) tags.push('typed');
  if (content.includes('export default') || content.includes('module.exports')) tags.push('exported');
  if (path.includes('test') || path.includes('spec')) tags.push('test');
  if (content.includes('TODO') || content.includes('FIXME') || content.includes('HACK')) tags.push('has-todos');

  return tags;
}

// ─── Level 3: Module Summary ──────────────────────────────────────────────────

export function summarizeModule(
  moduleName: string,
  fileSummaries: FileSummary[],
  docs: StructuredDocument[]
): ModuleSummary {
  const config = getConfig().summarization;

  const moduleId = `module_${moduleName}`;
  const allDeps = [...new Set(fileSummaries.flatMap(f => f.dependencies))].slice(0, 30);
  const allExports = [...new Set(fileSummaries.flatMap(f => f.exports))].slice(0, 30);
  const allTags = [...new Set(fileSummaries.flatMap(f => f.tags))];

  // Determine dominant domain
  const domainCounts = new Map<string, number>();
  for (const f of fileSummaries) {
    domainCounts.set(f.domain, (domainCounts.get(f.domain) ?? 0) + 1);
  }
  const domain = ([...domainCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown') as SemanticDomain;

  const rawSummary = `Module '${moduleName}': ${fileSummaries.length} files. Purpose: ${fileSummaries[0]?.purpose ?? 'general'}. Exports: ${allExports.slice(0, 5).join(', ')}.`;
  const summary = truncateToTokens(rawSummary, config.maxModuleSummaryTokens);

  return {
    moduleId,
    name: moduleName,
    summary,
    purpose: fileSummaries[0]?.purpose ?? 'General module',
    files: fileSummaries.map(f => f.path),
    publicApi: allExports,
    dependencies: allDeps,
    domain,
    tags: allTags,
  };
}

// ─── Level 4: Project Summary ─────────────────────────────────────────────────

export function summarizeProject(
  projectName: string,
  moduleSummaries: ModuleSummary[],
  docs: StructuredDocument[]
): ProjectSummary {
  const config = getConfig().summarization;

  const projectId = `project_${projectName}`;

  // Detect languages
  const langCounts = new Map<string, number>();
  for (const doc of docs) {
    if (doc.language) langCounts.set(doc.language, (langCounts.get(doc.language) ?? 0) + 1);
  }
  const mainLanguages = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang]) => lang);

  // Detect frameworks
  const frameworks = detectFrameworks(docs);

  // Detect architectural patterns
  const patterns = detectPatterns(docs);

  // Collect domains
  const domains = [...new Set(moduleSummaries.map(m => m.domain))];

  // Entry points
  const entryPoints = docs
    .filter(d => d.relativePath.match(/^(index|main|app|server|cmd)\.(ts|js|py|go|rs|java)$/))
    .map(d => d.relativePath)
    .slice(0, 5);

  const allTags = [...new Set(moduleSummaries.flatMap(m => m.tags))].slice(0, 30);

  const rawSummary = `Project '${projectName}': ${docs.length} files across ${moduleSummaries.length} modules. Languages: ${mainLanguages.join(', ')}. Frameworks: ${frameworks.join(', ') || 'none detected'}.`;
  const summary = truncateToTokens(rawSummary, config.maxProjectSummaryTokens);

  return {
    projectId,
    name: projectName,
    summary,
    purpose: detectProjectPurpose(docs),
    modules: moduleSummaries.map(m => m.name),
    mainLanguages,
    frameworks,
    architecturalPatterns: patterns,
    domains,
    entryPoints,
    tags: allTags,
  };
}

function detectFrameworks(docs: StructuredDocument[]): string[] {
  const frameworks = new Set<string>();
  const allContent = docs.map(d => d.rawText).join('\n').toLowerCase();
  const allPaths = docs.map(d => d.relativePath).join('\n').toLowerCase();

  if (allContent.includes('express') || allPaths.includes('express')) frameworks.add('Express');
  if (allContent.includes('fastify') || allPaths.includes('fastify')) frameworks.add('Fastify');
  if (allContent.includes('nestjs') || allContent.includes('@nestjs')) frameworks.add('NestJS');
  if (allContent.includes('react') || allContent.includes('jsx')) frameworks.add('React');
  if (allContent.includes('vue') || allContent.includes('nuxt')) frameworks.add('Vue');
  if (allContent.includes('angular') || allContent.includes('@angular')) frameworks.add('Angular');
  if (allContent.includes('django') || allPaths.includes('django')) frameworks.add('Django');
  if (allContent.includes('fastapi') || allContent.includes('from fastapi')) frameworks.add('FastAPI');
  if (allContent.includes('flask') || allContent.includes('from flask')) frameworks.add('Flask');
  if (allContent.includes('spring') || allContent.includes('@springbootapplication')) frameworks.add('Spring');
  if (allContent.includes('gin.') || allContent.includes('"github.com/gin-gonic')) frameworks.add('Gin');
  if (allContent.includes('actix') || allContent.includes('use actix_web')) frameworks.add('Actix');
  if (allContent.includes('next/') || allPaths.includes('next.config')) frameworks.add('Next.js');
  if (allContent.includes('prisma') || allPaths.includes('prisma')) frameworks.add('Prisma');
  if (allContent.includes('typeorm') || allContent.includes('@entity')) frameworks.add('TypeORM');

  return [...frameworks].slice(0, 10);
}

function detectPatterns(docs: StructuredDocument[]): ArchitecturalPattern[] {
  const patterns = new Set<ArchitecturalPattern>();
  const allPaths = docs.map(d => d.relativePath).join('\n').toLowerCase();
  const allContent = docs.map(d => d.rawText).join('\n').toLowerCase();

  if (allPaths.includes('repository') || allPaths.includes('repo')) patterns.add('repository');
  if (allPaths.includes('service') || allContent.includes('service layer')) patterns.add('service');
  if (allPaths.includes('controller') || allPaths.includes('handler')) patterns.add('controller');
  if (allPaths.includes('middleware')) patterns.add('middleware');
  if (allContent.includes('singleton') || allContent.includes('instance =')) patterns.add('singleton');
  if (allContent.includes('factory') || allContent.includes('createinstance')) patterns.add('factory');
  if (allContent.includes('observer') || allContent.includes('eventemitter')) patterns.add('observer');
  if (allContent.includes('decorator') || allContent.includes('@injectable')) patterns.add('decorator');
  if (allContent.includes('command') || allContent.includes('icommand')) patterns.add('command');
  if (allContent.includes('cqrs') || allContent.includes('queryhandler')) patterns.add('cqrs');
  if (allContent.includes('domain') || allContent.includes('aggregate')) patterns.add('ddd');
  if (allContent.includes('event-driven') || allContent.includes('eventbus')) patterns.add('event-driven');

  return [...patterns].slice(0, 8);
}

function detectProjectPurpose(docs: StructuredDocument[]): string {
  const allContent = docs.map(d => d.rawText).join('\n').toLowerCase();
  const allPaths = docs.map(d => d.relativePath).join('\n').toLowerCase();

  if (allPaths.includes('api') && (allContent.includes('route') || allContent.includes('endpoint'))) return 'REST API backend service';
  if (allContent.includes('react') || allContent.includes('vue') || allContent.includes('angular')) return 'Frontend web application';
  if (allContent.includes('cli') || allContent.includes('commander') || allContent.includes('argv')) return 'Command-line tool';
  if (allContent.includes('microservice') || allContent.includes('grpc')) return 'Microservice';
  if (allContent.includes('machine learning') || allContent.includes('tensorflow') || allContent.includes('pytorch')) return 'Machine learning project';
  if (allPaths.includes('terraform') || allPaths.includes('kubernetes') || allPaths.includes('helm')) return 'Infrastructure as code';
  if (allContent.includes('library') || allContent.includes('npm publish') || allContent.includes('package')) return 'Library / package';

  return 'Software project';
}
