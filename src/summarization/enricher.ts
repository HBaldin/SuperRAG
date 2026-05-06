import { getLogger } from '../utils/logger.js';
import type {
  Chunk,
  ChunkMetadata,
  SemanticDomain,
  ComplexityLevel,
  ArchitecturalPattern,
} from '../types/index.js';

const logger = getLogger('enricher');

// ─── Complexity Detection ─────────────────────────────────────────────────────

function detectComplexity(chunk: Chunk): ComplexityLevel {
  const content = chunk.content;
  const tokens = chunk.tokenEstimate;

  // Count complexity indicators
  let score = 0;

  // Nesting depth (count indentation levels)
  const maxIndent = Math.max(...content.split('\n').map(l => {
    const match = l.match(/^(\s+)/);
    return match ? Math.floor(match[1]!.length / 2) : 0;
  }));
  score += Math.min(maxIndent, 5);

  // Cyclomatic complexity indicators
  const conditions = (content.match(/\bif\b|\belse\b|\bswitch\b|\bcase\b|\bwhile\b|\bfor\b|\bcatch\b|\?\s/g) ?? []).length;
  score += Math.min(conditions, 10);

  // Size
  if (tokens > 400) score += 3;
  else if (tokens > 200) score += 2;
  else if (tokens > 100) score += 1;

  if (score <= 3) return 'low';
  if (score <= 7) return 'medium';
  if (score <= 12) return 'high';
  return 'very-high';
}

// ─── Domain Detection ─────────────────────────────────────────────────────────

function detectChunkDomain(chunk: Chunk): SemanticDomain {
  const content = chunk.content.toLowerCase();
  const path = chunk.relativePath.toLowerCase();
  const title = chunk.title.toLowerCase();

  if (path.includes('test') || path.includes('spec') || title.includes('test')) return 'tests';
  if (content.includes('jwt') || content.includes('oauth') || content.includes('bcrypt') || title.includes('auth')) return 'auth';
  if (content.includes('encrypt') || content.includes('decrypt') || content.includes('hash') || content.includes('crypto')) return 'security';
  if (content.includes('select ') || content.includes('insert ') || content.includes('query(') || content.includes('.find(') || content.includes('.save(')) return 'database';
  if (content.includes('log.') || content.includes('logger.') || content.includes('console.log')) return 'logging';
  if (content.includes('emit(') || content.includes('publish(') || content.includes('subscribe(') || content.includes('queue')) return 'messaging';
  if (path.includes('config') || path.includes('.env') || content.includes('process.env')) return 'config';
  if (path.includes('infra') || path.includes('terraform') || path.includes('docker')) return 'infra';
  if (content.includes('render(') || content.includes('component') || content.includes('usestate') || content.includes('jsx')) return 'frontend';
  if (content.includes('router') || content.includes('route') || content.includes('controller') || content.includes('handler')) return 'backend';
  if (path.includes('docs') || path.includes('readme') || chunk.kind === 'section') return 'docs';
  if (path.includes('util') || path.includes('helper')) return 'utils';

  return 'unknown';
}

// ─── Pattern Detection ────────────────────────────────────────────────────────

function detectChunkPatterns(chunk: Chunk): ArchitecturalPattern[] {
  const patterns = new Set<ArchitecturalPattern>();
  const content = chunk.content.toLowerCase();

  if (content.includes('singleton') || content.match(/static\s+instance\s*=/)) patterns.add('singleton');
  if (content.includes('factory') || content.match(/create\w+\(/)) patterns.add('factory');
  if (content.includes('repository') || content.match(/\.find\(|\.save\(|\.delete\(/)) patterns.add('repository');
  if (content.includes('service') && (content.includes('class') || content.includes('function'))) patterns.add('service');
  if (content.match(/app\.(get|post|put|delete|patch)\(/) || content.includes('router.')) patterns.add('controller');
  if (content.includes('next(') || content.includes('middleware')) patterns.add('middleware');
  if (content.includes('eventemitter') || content.includes('.on(') || content.includes('.emit(')) patterns.add('observer');
  if (content.match(/@\w+\s*\n?\s*(class|function|method)/) || content.includes('@injectable')) patterns.add('decorator');
  if (content.includes('strategy') || content.match(/interface\s+i\w+strategy/)) patterns.add('strategy');
  if (content.includes('command') || content.match(/interface\s+i\w+command/)) patterns.add('command');

  return [...patterns];
}

// ─── Tag Generation ───────────────────────────────────────────────────────────

function generateTags(chunk: Chunk): string[] {
  const tags = new Set<string>();
  const content = chunk.content.toLowerCase();
  const path = chunk.relativePath.toLowerCase();

  // Language tag
  if (chunk.language) tags.add(chunk.language);

  // Kind tag
  tags.add(chunk.kind);

  // Domain-specific tags
  if (content.includes('async') || content.includes('await')) tags.add('async');
  if (content.includes('promise') || content.includes('.then(')) tags.add('promise');
  if (content.includes('class ')) tags.add('class');
  if (content.includes('interface ')) tags.add('interface');
  if (content.includes('export')) tags.add('exported');
  if (content.includes('import')) tags.add('has-imports');
  if (content.includes('error') || content.includes('exception') || content.includes('catch')) tags.add('error-handling');
  if (content.includes('test') || content.includes('expect(') || content.includes('assert')) tags.add('test');
  if (content.includes('todo') || content.includes('fixme') || content.includes('hack')) tags.add('has-todos');
  if (content.includes('deprecated') || content.includes('@deprecated')) tags.add('deprecated');
  if (content.includes('public') || content.includes('export default')) tags.add('public-api');
  if (content.includes('private') || content.includes('#')) tags.add('private');
  if (content.includes('abstract')) tags.add('abstract');
  if (content.includes('generic') || content.match(/<[a-z]\w*>/i)) tags.add('generic');
  if (content.includes('recursive')) tags.add('recursive');
  if (content.includes('regex') || content.includes('regexp') || content.match(/\/[^/]+\/[gimsuy]*/)) tags.add('regex');
  if (content.includes('sql') || content.includes('select ') || content.includes('insert ')) tags.add('sql');
  if (content.includes('http') || content.includes('fetch(') || content.includes('axios')) tags.add('http');
  if (content.includes('websocket') || content.includes('ws://') || content.includes('socket.io')) tags.add('websocket');
  if (content.includes('graphql') || content.includes('gql`')) tags.add('graphql');
  if (content.includes('grpc') || content.includes('protobuf')) tags.add('grpc');

  // Path-based tags
  if (path.includes('test') || path.includes('spec')) tags.add('test-file');
  if (path.includes('migration')) tags.add('migration');
  if (path.includes('seed')) tags.add('seed');
  if (path.includes('config')) tags.add('config-file');

  return [...tags].slice(0, 20);
}

// ─── Side Effects ─────────────────────────────────────────────────────────────

function detectSideEffects(chunk: Chunk): string[] {
  const effects: string[] = [];
  const content = chunk.content.toLowerCase();

  if (content.includes('console.log') || content.includes('console.error') || content.includes('console.warn')) effects.push('console-output');
  if (content.includes('process.exit')) effects.push('process-exit');
  if (content.includes('writefile') || content.includes('appendfile') || content.includes('unlink') || content.includes('rmdir')) effects.push('file-system-write');
  if (content.includes('setstate') || content.includes('dispatch(') || content.includes('store.')) effects.push('state-mutation');
  if (content.includes('emit(') || content.includes('publish(') || content.includes('broadcast(')) effects.push('event-emission');
  if (content.includes('insert') || content.includes('update') || content.includes('delete') || content.includes('.save(')) effects.push('database-write');
  if (content.includes('send(') || content.includes('sendmail') || content.includes('smtp') || content.includes('nodemailer')) effects.push('email-send');
  if (content.includes('settimeout') || content.includes('setinterval')) effects.push('timer');
  if (content.includes('global.') || content.includes('window.') || content.includes('globalthis.')) effects.push('global-mutation');
  if (content.includes('process.env')) effects.push('env-read');
  if (content.includes('http.') || content.includes('fetch(') || content.includes('axios.')) effects.push('network-call');

  return effects;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function enrichChunk(chunk: Chunk): Chunk {
  const domain = detectChunkDomain(chunk);
  const complexity = detectComplexity(chunk);
  const patterns = detectChunkPatterns(chunk);
  const tags = generateTags(chunk);
  const sideEffects = detectSideEffects(chunk);

  const isPublicApi = chunk.content.includes('export') ||
    chunk.content.includes('public ') ||
    chunk.kind === 'function' ||
    chunk.kind === 'class' ||
    chunk.kind === 'interface';

  const isEntryPoint = chunk.relativePath.match(/^(index|main|app|server)\.(ts|js|py|go|rs)$/) !== null;

  const enrichedMetadata: ChunkMetadata = {
    ...chunk.metadata,
    domain,
    complexity,
    responsibilities: [],
    patterns,
    sideEffects,
    isEntryPoint,
    isPublicApi,
  };

  return {
    ...chunk,
    tags,
    metadata: enrichedMetadata,
  };
}

export function enrichChunks(chunks: Chunk[]): Chunk[] {
  logger.debug({ count: chunks.length }, 'Enriching chunks');
  return chunks.map(enrichChunk);
}
