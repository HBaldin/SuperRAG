Container único (Docker / Podman)
================================

Este documento descreve como usar a imagem/container self-contained incluída no repositório. A imagem agrupa Qdrant, os servidores Python (embedding + reranker) e a API Node.js em um único container para facilitar testes locais e uso por agentes/LLMs.

Arquivos relevantes
- `Dockerfile` — build multi-stage (extrai Qdrant, prepara venv Python, compila Node.js e monta a imagem final)
- `docker-compose.yml` — exemplo de deploy com volume persistente `superrag-data` e variável `REPO_PATH` para montar o repositório a indexar
- `docker/rag.config.container.json` — configuração pronta para execução intra-container (aponta todos os serviços para localhost)
- `docker/supervisord.conf` — orquestra Qdrant + embedding + reranker + API
- `docker/entrypoint.sh` — entrypoint que prepara diretórios de dados e inicia supervisord
- `docker/auto-index.sh` — indexa `/workspace` e ativa o file watcher para mudanças incrementais

Build e execução
-----------------

1) Build da imagem (local):

```bash
docker build -t superrag:latest .
# ou com docker-compose
docker compose build
```

2) Subir a imagem apontando um repositório para indexar:

```bash
# Usando docker run
docker run -d --name superrag -p 3000:3000 \
  -v /caminho/do/seu/projeto:/workspace:ro \
  -v superrag-data:/app/data \
  superrag:latest

# Usando docker compose (recomendado)
REPO_PATH=/caminho/do/seu/projeto docker compose up -d
```

3) Verificar saúde:

```bash
curl http://localhost:3000/health
```

Comportamento
------------

- A imagem inicia Qdrant primeiro, depois os servidores Python e, por fim, a API Node.js. A API só sobe depois que `/health` dos serviços dependentes responderem.
- Se `REPO_PATH` (ou `/workspace`) estiver montado, o container tentará indexar o conteúdo e ativar o file watcher para indexação incremental.
- Dados persistentes (SQLite, Qdrant storage, cache) ficam em `/app/data` — monte um volume para manter o estado entre reinicializações.

Variáveis de ambiente úteis
- `REPO_PATH` — caminho do repositório no host, montado em `/workspace` (definido no docker-compose)
- `AUTO_INDEX` — true/false (default: true) — dispara indexação automática na inicialização
- `WATCH_ENABLED` — true/false (default: true) — ativa o file watcher para indexação incremental
- `RAG_CONFIG` — caminho para um `rag.config.json` customizado (se não definido, o container copia `docker/rag.config.container.json` para `/app/rag.config.json`)

Persistência e volumes
- Monte `/app/data` para persistência dos índices e bancos (ex.: `-v superrag-data:/app/data`).
- Recomenda-se montar o repositório em `/workspace` como read-only: `-v /host/repo:/workspace:ro` para evitar que o container modifique o repositório do host.

Observações e trade-offs
- A imagem pré-baixa modelos ML durante o build para reduzir tempo de inicialização em runtime. Isso aumenta o tamanho da imagem (~5-6GB). Se preferir imagens menores, altere o Dockerfile para baixar modelos em runtime.
- A imagem está configurada para CPU-only (torch CPU wheels). Para uso com GPU, ajuste a etapa Python do Dockerfile e os pacotes torch adequadamente.

Problemas comuns
- Container não indexa: verifique se `/workspace` está montado e não vazio.
- Porta 3000 em uso: mapeie outra porta no host (ex.: `-p 8080:3000`).
- Permissões em volumes: monte com permissões adequadas ou use `:rw` quando necessário.

Se precisar de ajuda adicional, abra uma issue com logs (`docker logs superrag`) e a saída de `curl http://localhost:3000/health`.
