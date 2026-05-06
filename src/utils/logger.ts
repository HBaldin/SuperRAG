import pino from 'pino';
import { getConfig } from '../config/index.js';

let _logger: pino.Logger | null = null;

export function getLogger(name?: string): pino.Logger {
  if (!_logger) {
    const config = getConfig();
    _logger = pino({
      level: config.logging.level,
      transport: config.logging.pretty
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
        : undefined,
    });
  }
  return name ? _logger.child({ module: name }) : _logger;
}
