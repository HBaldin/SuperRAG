# TODO — Desenvolvedor / SuperRAG

## Fase 23 — Scaffold Completo

- [done] Criar estrutura de diretórios (src/*, data/*, python/*, tests/*, docs/)
- [done] Criar package.json com todas as dependências
- [done] Criar tsconfig.json
- [done] Criar .gitignore, .env.example, rag.config.json
- [done] Criar src/config/index.ts (módulo de configuração central)
- [done] Criar src/types/index.ts (tipos globais)
- [done] Criar src/utils/logger.ts
- [done] Criar src/utils/hash.ts
- [done] Criar src/utils/tokens.ts
- [done] Criar src/utils/language-map.ts
- [done] npm install — concluído (378 pacotes, apenas warnings)
- [done] tsc --noEmit — passou sem erros

## Fase 2 — Parsers Universais Plugáveis

- [done] Criar src/parsers/base.ts (IParser + BaseParser)
- [done] Criar src/parsers/registry.ts (ParserRegistry + globalRegistry)
- [done] Criar src/parsers/code-parser.ts (tree-sitter, 12 linguagens)
- [done] Criar src/parsers/markdown-parser.ts
- [done] Criar src/parsers/config-parser.ts (JSON/YAML/TOML/Dockerfile)
- [done] Criar src/parsers/csv-parser.ts
- [done] Criar src/parsers/fallback-parser.ts
- [done] Criar src/parsers/index.ts (orquestrador)
- [done] tsc --noEmit — passou sem erros
- [done] vitest run — 27/27 testes passando


