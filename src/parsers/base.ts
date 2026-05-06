import type { StructuredDocument, ScannedFile } from '../types/index.js';

export interface IParser {
  /** Linguagens/extensões suportadas */
  readonly supportedLanguages: string[];
  /** Parsear arquivo e retornar documento estruturado */
  parse(file: ScannedFile, content: string): Promise<StructuredDocument>;
  /** Verificar se suporta este arquivo */
  supports(file: ScannedFile): boolean;
}

export abstract class BaseParser implements IParser {
  abstract readonly supportedLanguages: string[];

  abstract parse(file: ScannedFile, content: string): Promise<StructuredDocument>;

  supports(file: ScannedFile): boolean {
    return file.language !== null && this.supportedLanguages.includes(file.language);
  }
}
