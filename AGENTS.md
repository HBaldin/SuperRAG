AGENTS.md

Propósito
-------
Este arquivo é um guia orientado a máquinas para instalação e uso de agentes LLM (Claude, GPT-4, Gemini, Copilot, etc.) que utilizarão o SuperRAG como ferramenta de contexto local. Leia e siga cada instrução exatamente. Use os exemplos como modelos.

Pré-condições
--------------
- Sistema hospedeiro: recomenda-se Linux ou macOS.
- Docker instalado e executável pelo processo do agente (para Qdrant) ou Qdrant acessível pela URL configurada.
 - Docker ou Podman instalados (recomendado). Alternativamente, o repositório pode ser executado em um único container self-contained fornecido nesta árvore (`Dockerfile` + `docker-compose.yml`).
- Python 3.9+ e Node 18+ disponíveis.
- Acesso de rede às portas localhost 3000, 8001, 8002, 6333, salvo alteração na configuração.

Instalação rápida (comandos exatos)
-----------------------------
Execute estes comandos na raiz do repositório (/home/hrosa/Source/SuperRAG):

1) Instalar dependências Node

```bash
npm ci
```

2) Preparar o servidor de embeddings

```bash
cd python/embedding_server
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8001 --host 127.0.0.1 &
cd -
```

3) Preparar o servidor de reranker (opcional, mas recomendado)

```bash
cd python/reranker_server
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8002 --host 127.0.0.1 &
cd -
```

4) Iniciar Qdrant (Docker)

```bash
docker run -d --rm -p 6333:6333 qdrant/qdrant
```

5) Iniciar a API do SuperRAG (local)

```bash
# a partir da raiz do repositório
NODE_ENV=development node ./src/api/server.js
# ou execute seu inicializador de node (pm2/systemd) pois o agente requer processo persistente
```

6) Configuração mínima

Coloque um arquivo `rag.config.json` mínimo na raiz do repositório ou defina a variável de ambiente `RAG_CONFIG` apontando para o arquivo.

```json
{
  "dataDir": "./data",
  "embedding": { "serverUrl": "http://localhost:8001", "dimensions": 1024 },
  "rerank": { "serverUrl": "http://localhost:8002", "enabled": true },
  "qdrant": { "url": "http://localhost:6333" }
}
```

Observação: o repositório também fornece um Dockerfile multi-stage e um docker-compose.yml para subir todos os componentes (Qdrant + embedding server + reranker + API) em um único container. Veja a seção "Container único (Docker/Podman)" no README ou `docs/docker.md` para instruções de uso.

Verificações de saúde
-------------
Verifique cada serviço com os comandos abaixo. Espere respostas HTTP 200 / JSON.

1) Servidor de embeddings

```bash
curl -sS http://localhost:8001/health
```

2) Servidor de reranker

```bash
curl -sS http://localhost:8002/health
```

3) Qdrant

```bash
curl -sS http://localhost:6333/health
```

4) API do SuperRAG

```bash
curl -sS http://localhost:3000/health
```

Indexação
--------
Objetivo: produzir um índice persistente para o projeto em <path>.

CLI (rápido)

```bash
# indexar uma vez
rag index /absolute/path/to/project --force

# observar e indexação incremental
rag index /absolute/path/to/project --watch
```

API (requisição exata)

```bash
curl -X POST http://localhost:3000/index \
  -H 'Content-Type: application/json' \
  -d '{"projectPath":"/absolute/path/to/project","force":true}'
```

TypeScript (programático)

```js
import { indexProject } from './src/core/indexer.js';

await indexProject({ projectPath: '/absolute/path/to/project', force: true });
```

Após a indexação: verifique o endpoint `/stats` ou confirme que `dataDir/<project>` existe.

Consultas e recebimento do ContextPackage
-----------------------------------
Objetivo: solicitar dados contextualizados para uma consulta de texto e receber um `ContextPackage`.

CLI

```bash
rag query "how does auth work?" --path /absolute/path/to/project --top-k 10 --json
```

API (QueryResult)

```bash
curl -sS -X POST http://localhost:3000/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"how does auth work?","projectPath":"/absolute/path/to/project","topK":10}'
```

API (ContextPackage para agentes)

```bash
curl -sS -X POST http://localhost:3000/query/agent \
  -H 'Content-Type: application/json' \
  -d '{"query":"how does auth work?","projectPath":"/absolute/path/to/project","maxTokens":8000}'
```

TypeScript (modo agente)

```js
import { queryAndBuildContext, serializeContextPackage } from './src/adapters/agent-adapter.js';

const ctx = await queryAndBuildContext({ query: 'how does auth work?', projectPath: '/abs/path' }, { projectPath: '/abs/path', maxTokens: 8000 });
const promptString = serializeContextPackage(ctx);
```

Interpretando o ContextPackage (campos e uso)
------------------------------------------
Você receberá um `ContextPackage`. Use os campos abaixo exatamente como descritos.

- `ctx.query`: string com a consulta original.
- `ctx.chunks`: array ordenado de `Chunk`. Cada chunk possui `id`, `content`, `compressed` (opcional), `relativePath`, `startLine`, `endLine`, `language`, `kind`, `score`, `title`, `summary`, `tags`, `domain`.
  - Prefira `chunk.compressed` quando disponível para economizar tokens; descomprima somente se necessário.
- `ctx.relations`: `GraphEdge[]` descrevendo links semânticos. Use para localizar definições, call-sites e relações entre módulos.
- `ctx.summaries`: sumários hierárquicos (documento → arquivo → intervalo). Use como contexto de alto nível primeiro.
- `ctx.metadata.projectPath`: caminho absoluto do projeto indexado.
- `ctx.metadata.indexedAt`: timestamp da última indexação.
- `ctx.metadata.truncated`: booleano indicando se o pacote foi truncado por limite de tokens.
- `ctx.metadata.chunksOmitted`: número de chunks omitidos quando houve truncamento.

Ao montar prompts:
- Inclua `ctx.summaries` primeiro como contexto de sistema.
- Inclua os top N chunks por `score` até atingir o orçamento de tokens.
- Use `ctx.relations` para adicionar frases de ligação: "O arquivo A chama a função X no arquivo B (linhas)."

Padrões e fluxos de trabalho recomendados para agentes
-----------------------------------------------------
1) Resposta curta do assistente com grounding
   - Solicite um `ContextPackage` com `maxTokens` pequeno (ex.: 2000).
   - Monte o `system prompt` com `summaries` + top 3 chunks.

2) Análise profunda / alteração de código
   - Solicite `ContextPackage` com `maxTokens` grande (ex.: 8000).
   - Use `summaries` + 20–50 chunks + `relations`.
   - Refaça a consulta após raciocínio local se faltar informação.

3) Loop multi-etapa com ferramentas (preferido)
   - Etapa 1: executar `query/agent` para obter o `ContextPackage`.
   - Etapa 2: executar o raciocínio do modelo restringido a esse contexto.
   - Etapa 3: se surgir nova pergunta, faça nova consulta com filtros mais estreitos (paths/kinds).

Filtros e parâmetros (como refinar consultas)
---------------------------------------------
Forneça `QueryFilters` no corpo da requisição. Exemplos:

```json
{
  "query": "how does auth work?",
  "projectPath": "/abs/path",
  "topK": 20,
  "filters": {
    "languages": ["typescript"],
    "paths": ["src/auth"],
    "kinds": ["function","class"],
    "tags": ["security"]
  }
}
```

Parâmetros principais:
- `topK`: retorna os top K chunks (estágio vetorial) antes do rerank.
- `includeGraph` / `includeCompressed`: alterna a inclusão de `relations` ou strings comprimidas.
- `maxTokens` (endpoint agent): orçamento de tokens alvo para composição final do `ContextPackage`.

Limites e comportamentos (o que esperar)
--------------------------------------
- Servidor de embeddings: depende de CPU/GPU; espere ~50–500ms por batch em cargas pequenas.
- Servidor de reranker adiciona latência (~50–200ms) dependendo do modelo.
- Qdrant: latência de busca vetorial ~10–100ms local.
- Timeouts da API: timeout padrão do servidor Node ~60s; endpoints agent podem impor limites menores.
- Truncamento: o `ContextPackage` pode ser truncado para respeitar `maxTokens`; `metadata.truncated===true` e `metadata.chunksOmitted` indicam omissões.
- Erros: a API retorna 4xx para erros de validação e 5xx para erros internos. Verifique `/logs` no host do servidor.

Integração em prompts (padrão exato)
------------------------------------
Use este template para injetar contexto no `system prompt`. Substitua os PLACEHOLDERS exatamente.

Template de `system prompt`:

```text
System: You have the following context about PROJECT_PATH: {{ctx.metadata.projectPath}} (indexedAt: {{ctx.metadata.indexedAt}}).
Start with SUMMARY block, then CHUNKS. Do not use information outside this context unless asked.

SUMMARY:
{{ctx.summaries.document}}

CHUNKS (ordered):
1) File: {{chunk.relativePath}} lines {{chunk.startLine}}-{{chunk.endLine}}
   Content: {{chunk.compressed || chunk.content}}

Use relations to answer: {{ctx.relations}}
```

Exemplos (fim a fim)
-------------------
Exemplo 1 — resposta rápida

1) Inicie os servidores (veja Instalação rápida).
2) Indexe o projeto: `rag index /abs/path --force`.
3) Solicite contexto para o agente:

```bash
curl -sS -X POST http://localhost:3000/query/agent \
  -H 'Content-Type: application/json' \
  -d '{"query":"where is the login flow?","projectPath":"/abs/path","maxTokens":2000}'
```

4) Monte o system prompt: inclua `summaries` + top 3 chunks. Peça ao modelo para retornar o caminho e os nomes das funções.

Exemplo 2 — proposta de alteração

1) Indexe.
2) Consulte com `topK=50` e `maxTokens=8000`.
3) Use `ctx.relations` para encontrar o grafo de chamadas da função que será alterada.
4) Peça ao modelo uma proposta de patch mínima; verifique reconsultando arquivos específicos.

Exemplo 3 — filtrar por linguagem e caminho

```bash
curl -sS -X POST http://localhost:3000/query/agent \
  -H 'Content-Type: application/json' \
  -d '{"query":"authorization checks","projectPath":"/abs/path","filters":{"languages":["go"],"paths":["/abs/path/services/auth"]},"maxTokens":3000}'
```

Solução de problemas
------------------
- "500 internal error" em `/query`: verifique as URLs do embedding e do qdrant em `rag.config.json`.
- Chunks vazios: execute `rag index /path --force` novamente e confirme se o servidor de embeddings retornou vetores.
- `ContextPackage` truncado: aumente `maxTokens` ou refine os filtros (reduza paths/languages/topK).
- Conexão recusada ao Qdrant: garanta que o container Docker está em execução e que `rag.config.json` tem `qdrant.url` correto.

Referência rápida
---------------
- API base: http://localhost:3000
- `POST /index`        { projectPath, force? }
- `POST /refresh`      { projectPath }
- `POST /query`        { query, projectPath?, topK?, filters? } -> QueryResult
- `POST /query/agent`  { query, projectPath?, maxTokens?, filters? } -> ContextPackage
- `GET /health`
- `GET /stats`

Locais de armazenamento
----------------------
- `dataDir` (padrão `./data`) contém índices por projeto e arquivos sqlite. Verifique para persistência.

Fim
