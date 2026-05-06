import type { IParser } from './base.js';
import type { ScannedFile } from '../types/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('parser-registry');

export class ParserRegistry {
  private parsers: IParser[] = [];

  register(parser: IParser): void {
    this.parsers.push(parser);
    logger.debug({ languages: parser.supportedLanguages }, 'Parser registered');
  }

  getParser(file: ScannedFile): IParser | null {
    for (const parser of this.parsers) {
      if (parser.supports(file)) return parser;
    }
    return null;
  }

  listParsers(): Array<{ languages: string[] }> {
    return this.parsers.map(p => ({ languages: p.supportedLanguages }));
  }
}

export const globalRegistry = new ParserRegistry();
