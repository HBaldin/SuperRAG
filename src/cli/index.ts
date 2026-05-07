#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'path';
import { indexProject } from '../core/indexer.js';
import { runQueryPipeline } from '../core/query-pipeline.js';
import { FileWatcher } from '../watchers/watcher.js';
import { getStorageStats, getAllFingerprints } from '../storage/sqlite.js';
import type { IndexProgressEvent } from '../core/indexer.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function exitWithError(message: string): never {
  console.error(`✗ Error: ${message}`);
  process.exit(1);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Program Factory ──────────────────────────────────────────────────────────

export function createProgram(): Command {
  const program = new Command();

  program
    .name('rag')
    .description('SuperRAG — Hierarchical Multimodal Local RAG Engine')
    .version('0.1.0');

  // ─── index ──────────────────────────────────────────────────────────────────

  program
    .command('index <projectPath>')
    .description('Index a project directory')
    .option('-f, --force', 'Reindex everything (ignore cache)', false)
    .option('-w, --watch', 'Start file watcher after indexing', false)
    .option('-v, --verbose', 'Show detailed progress', false)
    .action(async (projectPath: string, opts: { force: boolean; watch: boolean; verbose: boolean }) => {
      try {
        const absPath = resolve(projectPath);
        console.log(`⟳ Indexing ${absPath}…`);

        const onProgress = opts.verbose
          ? (event: IndexProgressEvent) => {
              const pct = event.total > 0 ? Math.round((event.current / event.total) * 100) : 0;
              const fileInfo = event.file ? ` — ${event.file}` : '';
              process.stdout.write(`\r  [${event.phase}] ${event.current}/${event.total} (${pct}%)${fileInfo}   `);
            }
          : undefined;

        const result = await indexProject({ projectPath: absPath, force: opts.force, onProgress });

        if (opts.verbose) process.stdout.write('\n');

        const duration = formatDuration(result.durationMs);
        console.log(`✓ Indexed ${result.filesIndexed} files, ${result.chunksCreated} chunks in ${duration}`);

        if (result.errors.length > 0) {
          console.warn(`⚠ ${result.errors.length} error(s) during indexing`);
          if (opts.verbose) {
            for (const err of result.errors) {
              console.warn(`  • [${err.phase}] ${err.path}: ${err.error}`);
            }
          }
        }

        if (opts.watch) {
          console.log('👁 Starting file watcher…');
          const watcher = new FileWatcher({
            projectPath: absPath,
            onIndexed: (path) => console.log(`  ↻ Re-indexed: ${path}`),
            onRemoved: (path) => console.log(`  ✕ Removed: ${path}`),
            onError: (path, err) => console.error(`  ✗ Error (${path}): ${err.message}`),
          });
          await watcher.start();
          console.log('Watching for changes. Press Ctrl+C to stop.');

          const shutdown = async () => {
            console.log('\nStopping watcher…');
            await watcher.stop();
            process.exit(0);
          };
          process.on('SIGINT', () => { void shutdown(); });
          process.on('SIGTERM', () => { void shutdown(); });
        }
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err));
      }
    });

  // ─── watch ──────────────────────────────────────────────────────────────────

  program
    .command('watch <projectPath>')
    .description('Watch a project directory for changes and re-index automatically')
    .action(async (projectPath: string) => {
      try {
        const absPath = resolve(projectPath);

        // Warn if no index exists
        try {
          const fps = getAllFingerprints();
          if (fps.size === 0) {
            console.warn(`⚠ No index found. Run 'rag index ${projectPath}' first.`);
          }
        } catch {
          console.warn(`⚠ No index found. Run 'rag index ${projectPath}' first.`);
        }

        const watcher = new FileWatcher({
          projectPath: absPath,
          onIndexed: (path) => console.log(`  ↻ Re-indexed: ${path}`),
          onRemoved: (path) => console.log(`  ✕ Removed: ${path}`),
          onError: (path, err) => console.error(`  ✗ Error (${path}): ${err.message}`),
        });

        await watcher.start();
        console.log(`👁 Watching ${absPath}. Press Ctrl+C to stop.`);

        const shutdown = async () => {
          console.log('\nStopping watcher…');
          await watcher.stop();
          process.exit(0);
        };
        process.on('SIGINT', () => { void shutdown(); });
        process.on('SIGTERM', () => { void shutdown(); });
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err));
      }
    });

  // ─── query ──────────────────────────────────────────────────────────────────

  program
    .command('query <query>')
    .description('Query the indexed codebase')
    .option('-p, --path <path>', 'Project path', process.cwd())
    .option('-k, --top-k <n>', 'Number of results to return', '10')
    .option('--json', 'Output raw JSON', false)
    .action(async (query: string, opts: { path: string; topK: string; json: boolean }) => {
      try {
        const topK = parseInt(opts.topK, 10);
        const result = await runQueryPipeline({
          query,
          projectPath: resolve(opts.path),
          topK: isNaN(topK) ? 10 : topK,
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`\n🔍 Query: ${result.query}`);
        console.log(`   Intent: ${result.intent} | Time: ${result.metadata.totalTimeMs}ms | Cache: ${result.metadata.cacheHit ? 'HIT' : 'MISS'}`);
        console.log(`   Chunks: ${result.chunks.length}\n`);

        for (let i = 0; i < result.chunks.length; i++) {
          const chunk = result.chunks[i]!;
          const score = (chunk.score * 100).toFixed(1);
          console.log(`─── [${i + 1}] ${chunk.title} (score: ${score}%)`);
          console.log(`    📄 ${chunk.relativePath}:${chunk.startLine}-${chunk.endLine} [${chunk.kind}]`);
          const preview = (chunk.compressed ?? chunk.content).slice(0, 200).replace(/\n/g, ' ');
          console.log(`    ${preview}${preview.length >= 200 ? '…' : ''}`);
          console.log();
        }
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err));
      }
    });

  // ─── stats ──────────────────────────────────────────────────────────────────

  program
    .command('stats')
    .description('Show index statistics')
    .option('--json', 'Output raw JSON', false)
    .action(async (opts: { json: boolean }) => {
      try {
        const stats = getStorageStats();

        if (opts.json) {
          console.log(JSON.stringify(stats, null, 2));
          return;
        }

        console.log('\n📊 SuperRAG Index Statistics\n');
        console.log(`  Files indexed   : ${stats.fingerprints}`);
        console.log(`  Chunks stored   : ${stats.chunks}`);
        console.log(`  File summaries  : ${stats.files}`);
        console.log(`  Module summaries: ${stats.modules}`);
        console.log(`  Projects        : ${stats.projects}`);
        console.log();
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err));
      }
    });

  // ─── rebuild ────────────────────────────────────────────────────────────────

  program
    .command('rebuild <projectPath>')
    .description('Alias for index --force: reindex everything from scratch')
    .option('-v, --verbose', 'Show detailed progress', false)
    .action(async (projectPath: string, opts: { verbose: boolean }) => {
      try {
        const absPath = resolve(projectPath);
        console.log(`⟳ Rebuilding index for ${absPath}…`);

        const onProgress = opts.verbose
          ? (event: IndexProgressEvent) => {
              const pct = event.total > 0 ? Math.round((event.current / event.total) * 100) : 0;
              process.stdout.write(`\r  [${event.phase}] ${event.current}/${event.total} (${pct}%)   `);
            }
          : undefined;

        const result = await indexProject({ projectPath: absPath, force: true, onProgress });

        if (opts.verbose) process.stdout.write('\n');

        const duration = formatDuration(result.durationMs);
        console.log(`✓ Rebuilt index: ${result.filesIndexed} files, ${result.chunksCreated} chunks in ${duration}`);
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err));
      }
    });

  // ─── inspect ────────────────────────────────────────────────────────────────

  program
    .command('inspect <projectPath> [filePath]')
    .description('Inspect chunks for a file or project summary')
    .option('--json', 'Output raw JSON', false)
    .action(async (projectPath: string, filePath: string | undefined, opts: { json: boolean }) => {
      try {
        const stats = getStorageStats();
        const fps = getAllFingerprints();

        if (filePath) {
          // Filter fingerprints for the given file
          const matching = [...fps.values()].filter((fp) => fp.path.includes(filePath) || fp.absolutePath.includes(filePath));

          if (opts.json) {
            console.log(JSON.stringify({ projectPath, filePath, fingerprints: matching }, null, 2));
            return;
          }

          if (matching.length === 0) {
            console.log(`⚠ No indexed data found for: ${filePath}`);
          } else {
            console.log(`\n📄 Inspect: ${filePath}\n`);
            for (const fp of matching) {
              console.log(`  Path    : ${fp.path}`);
              console.log(`  Hash    : ${fp.hash}`);
              console.log(`  Size    : ${fp.size} bytes`);
              console.log();
            }
          }
        } else {
          if (opts.json) {
            console.log(JSON.stringify({ projectPath, stats, totalFiles: fps.size }, null, 2));
            return;
          }

          console.log(`\n🗂 Project: ${resolve(projectPath)}\n`);
          console.log(`  Files indexed   : ${stats.fingerprints}`);
          console.log(`  Chunks stored   : ${stats.chunks}`);
          console.log(`  File summaries  : ${stats.files}`);
          console.log(`  Module summaries: ${stats.modules}`);
          console.log();
        }
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err));
      }
    });

  return program;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

// Only run when executed directly (not imported in tests)
const isMain = process.argv[1]?.endsWith('cli/index.ts') ||
               process.argv[1]?.endsWith('cli/index.js') ||
               process.argv[1]?.endsWith('rag');

if (isMain) {
  const program = createProgram();
  program.parseAsync(process.argv).catch((err: unknown) => {
    exitWithError(err instanceof Error ? (err as Error).message : String(err));
  });
}
