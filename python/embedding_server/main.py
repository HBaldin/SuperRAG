"""
SuperRAG Embedding Server
Serves BGE-M3 embeddings via FastAPI with persistent cache and GPU support.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

import diskcache
import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("embedding-server")

# ─── Config ───────────────────────────────────────────────────────────────────

MODEL_NAME = os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3")
CACHE_DIR = os.getenv("EMBEDDING_CACHE_DIR", "./cache/embeddings")
CACHE_SIZE_LIMIT = int(os.getenv("EMBEDDING_CACHE_SIZE_GB", "2")) * 1024 ** 3
MAX_BATCH_SIZE = int(os.getenv("EMBEDDING_MAX_BATCH", "64"))
PORT = int(os.getenv("EMBEDDING_PORT", "8001"))
HOST = os.getenv("EMBEDDING_HOST", "0.0.0.0")

# ─── Device Detection ─────────────────────────────────────────────────────────

def detect_device() -> str:
    if torch.cuda.is_available():
        device = "cuda"
        logger.info(f"GPU detected: {torch.cuda.get_device_name(0)}")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = "mps"
        logger.info("Apple Silicon MPS detected")
    else:
        device = "cpu"
        logger.info("Using CPU")
    return device

# ─── Global State ─────────────────────────────────────────────────────────────

class AppState:
    model: SentenceTransformer | None = None
    cache: diskcache.Cache | None = None
    device: str = "cpu"
    dimensions: int = 1024
    load_time_ms: float = 0.0
    total_requests: int = 0
    cache_hits: int = 0

state = AppState()

# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info(f"Loading model: {MODEL_NAME}")
    t0 = time.time()

    state.device = detect_device()
    state.model = SentenceTransformer(MODEL_NAME, device=state.device)

    # Warm up with a dummy embedding to get dimensions
    dummy = state.model.encode(["warmup"], normalize_embeddings=True)
    state.dimensions = dummy.shape[1]
    state.load_time_ms = (time.time() - t0) * 1000

    logger.info(
        f"Model loaded in {state.load_time_ms:.0f}ms | "
        f"device={state.device} | dimensions={state.dimensions}"
    )

    # Init cache
    os.makedirs(CACHE_DIR, exist_ok=True)
    state.cache = diskcache.Cache(CACHE_DIR, size_limit=CACHE_SIZE_LIMIT)
    logger.info(f"Cache initialized at {CACHE_DIR} (limit={CACHE_SIZE_LIMIT // 1024**3}GB)")

    yield

    # Shutdown
    if state.cache:
        state.cache.close()
    logger.info("Server shutdown")

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="SuperRAG Embedding Server",
    version="0.1.0",
    lifespan=lifespan,
)

# ─── Models ───────────────────────────────────────────────────────────────────

class EmbedRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=32000)
    model: str | None = None

class EmbedResponse(BaseModel):
    embedding: list[float]
    model: str
    dimensions: int
    cached: bool
    duration_ms: float

class EmbedBatchRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=512)
    model: str | None = None

class EmbedBatchResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    dimensions: int
    count: int
    cache_hits: int
    duration_ms: float

class HealthResponse(BaseModel):
    status: str
    model: str
    device: str
    dimensions: int
    total_requests: int
    cache_hits: int
    cache_hit_rate: float
    load_time_ms: float

class InfoResponse(BaseModel):
    model: str
    device: str
    dimensions: int
    max_batch_size: int
    cache_dir: str
    cache_size_bytes: int

# ─── Cache Helpers ────────────────────────────────────────────────────────────

def cache_key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def get_cached(text: str) -> list[float] | None:
    if state.cache is None:
        return None
    key = cache_key(text)
    result = state.cache.get(key)
    if result is not None:
        state.cache_hits += 1
        return result
    return None

def set_cached(text: str, embedding: list[float]) -> None:
    if state.cache is None:
        return
    key = cache_key(text)
    state.cache.set(key, embedding)

# ─── Embedding Logic ──────────────────────────────────────────────────────────

def embed_texts(texts: list[str]) -> tuple[list[list[float]], int]:
    """Embed texts with cache lookup. Returns (embeddings, cache_hits)."""
    if state.model is None:
        raise RuntimeError("Model not loaded")

    results: list[list[float] | None] = [None] * len(texts)
    uncached_indices: list[int] = []
    uncached_texts: list[str] = []
    hits = 0

    # Check cache
    for i, text in enumerate(texts):
        cached = get_cached(text)
        if cached is not None:
            results[i] = cached
            hits += 1
        else:
            uncached_indices.append(i)
            uncached_texts.append(text)

    # Embed uncached in batches
    if uncached_texts:
        for batch_start in range(0, len(uncached_texts), MAX_BATCH_SIZE):
            batch = uncached_texts[batch_start : batch_start + MAX_BATCH_SIZE]
            batch_indices = uncached_indices[batch_start : batch_start + MAX_BATCH_SIZE]

            embeddings_np: np.ndarray = state.model.encode(
                batch,
                normalize_embeddings=True,
                show_progress_bar=False,
                batch_size=min(len(batch), MAX_BATCH_SIZE),
            )

            for local_i, (global_i, emb) in enumerate(zip(batch_indices, embeddings_np)):
                emb_list = emb.tolist()
                results[global_i] = emb_list
                set_cached(uncached_texts[batch_start + local_i], emb_list)

    return [r for r in results if r is not None], hits

# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/embed", response_model=EmbedResponse)
async def embed_single(req: EmbedRequest) -> EmbedResponse:
    if state.model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    state.total_requests += 1
    t0 = time.time()

    cached_emb = get_cached(req.text)
    if cached_emb is not None:
        return EmbedResponse(
            embedding=cached_emb,
            model=MODEL_NAME,
            dimensions=state.dimensions,
            cached=True,
            duration_ms=(time.time() - t0) * 1000,
        )

    embeddings, _ = embed_texts([req.text])
    duration_ms = (time.time() - t0) * 1000

    return EmbedResponse(
        embedding=embeddings[0],
        model=MODEL_NAME,
        dimensions=state.dimensions,
        cached=False,
        duration_ms=duration_ms,
    )


@app.post("/embed-batch", response_model=EmbedBatchResponse)
async def embed_batch(req: EmbedBatchRequest) -> EmbedBatchResponse:
    if state.model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if len(req.texts) > 512:
        raise HTTPException(status_code=400, detail="Maximum 512 texts per batch")

    state.total_requests += 1
    t0 = time.time()

    embeddings, hits = embed_texts(req.texts)
    duration_ms = (time.time() - t0) * 1000

    logger.info(
        f"Batch embed: {len(req.texts)} texts, {hits} cache hits, {duration_ms:.1f}ms"
    )

    return EmbedBatchResponse(
        embeddings=embeddings,
        model=MODEL_NAME,
        dimensions=state.dimensions,
        count=len(embeddings),
        cache_hits=hits,
        duration_ms=duration_ms,
    )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    hit_rate = (
        state.cache_hits / state.total_requests
        if state.total_requests > 0
        else 0.0
    )
    return HealthResponse(
        status="ok" if state.model is not None else "loading",
        model=MODEL_NAME,
        device=state.device,
        dimensions=state.dimensions,
        total_requests=state.total_requests,
        cache_hits=state.cache_hits,
        cache_hit_rate=round(hit_rate, 4),
        load_time_ms=state.load_time_ms,
    )


@app.get("/info", response_model=InfoResponse)
async def info() -> InfoResponse:
    cache_size = 0
    if state.cache is not None:
        try:
            cache_size = state.cache.volume()
        except Exception:
            pass

    return InfoResponse(
        model=MODEL_NAME,
        device=state.device,
        dimensions=state.dimensions,
        max_batch_size=MAX_BATCH_SIZE,
        cache_dir=CACHE_DIR,
        cache_size_bytes=cache_size,
    )


# ─── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
