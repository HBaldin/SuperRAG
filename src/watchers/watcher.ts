import { relative } from 'path';
import chokidar from 'chokidar';
import { getLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { indexFile, removeFile } from '../core/indexer.js';

const logger = getLogger('watcher');

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface WatcherOptions {
  projectPath: string;
  debounceMs?: number;
  onIndexed?: (path: string) => void;
  onRemoved?: (path: string) => void;
  onError?: (path: string, err: Error) => void;
}

// ─── FileWatcher ──────────────────────────────────────────────────────────────

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(private options: WatcherOptions) {}

  async start(): Promise<void> {
    if (this.watcher) return;

    const { projectPath, onIndexed, onRemoved, onError } = this.options;
    const debounceMs = this.options.debounceMs ?? getConfig().indexing.watchDebounceMs;

    this.watcher = chokidar.watch(projectPath, {
      ignoreInitial: true,
      persistent: true,
      ignored: /(^|[/\\])\..|(node_modules)/,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    const scheduleIndex = (absolutePath: string): void => {
      const existing = this.debounceTimers.get(absolutePath);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.debounceTimers.delete(absolutePath);
        const relPath = relative(projectPath, absolutePath);

        indexFile(absolutePath, projectPath)
          .then(() => {
            onIndexed?.(relPath);
            logger.debug({ path: relPath }, 'File indexed');
          })
          .catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            onError?.(relPath, error);
            logger.warn({ path: relPath, err }, 'indexFile failed');
          });
      }, debounceMs);

      this.debounceTimers.set(absolutePath, timer);
    };

    const scheduleRemove = (absolutePath: string): void => {
      const existing = this.debounceTimers.get(absolutePath);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.debounceTimers.delete(absolutePath);
        const relPath = relative(projectPath, absolutePath);

        removeFile(relPath, projectPath)
          .then(() => {
            onRemoved?.(relPath);
            logger.debug({ path: relPath }, 'File removed from index');
          })
          .catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            onError?.(relPath, error);
            logger.warn({ path: relPath, err }, 'removeFile failed');
          });
      }, debounceMs);

      this.debounceTimers.set(absolutePath, timer);
    };

    this.watcher
      .on('add', (filePath: string) => scheduleIndex(filePath))
      .on('change', (filePath: string) => scheduleIndex(filePath))
      .on('unlink', (filePath: string) => scheduleRemove(filePath))
      .on('error', (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        onError?.('', error);
        logger.error({ err }, 'Watcher error');
      });

    logger.info({ projectPath, debounceMs }, 'FileWatcher started');
  }

  async stop(): Promise<void> {
    // Cancel all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      logger.info('FileWatcher stopped');
    }
  }

  isRunning(): boolean {
    return this.watcher !== null;
  }
}
