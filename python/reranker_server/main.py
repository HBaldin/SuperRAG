"""
SuperRAG Reranker Server
Serves BGE-reranker cross-encoder via FastAPI for local reranking.
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("reranker-server")

# ─── Config ───────────────────────────────────────────────────────────────────

MODEL_NAME = os.getenv("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
PORT = int(os.getenv("RERANKER_PORT", "8002"))
HOST = os.getenv("RERANKER_HOST", "0.0.0.0")
MAX_DOCS = int(os.getenv("RERANKER_MAX_DOCS", "100"))

# ─── Device Detection ─────────────────────────────────────────────────────────

def detect_device() -> str:
    if torch.cuda.is_available():
        logger.info(f"GPU: {torch.cuda.get_device_name(0)}")
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        logger.info("Apple Silicon MPS")
        return "mps"
    logger.info("CPU mode")
    return "cpu"

# ─── State ────────────────────────────────────────────────────────────────────

class AppState:
    model: CrossEncoder | None = None
    device: str = "cpu"
    load_time_ms: float = 0.0
    total_requests: int = 0

state = AppState()

# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Loading reranker: {MODEL_NAME}")
    t0 = time.time()
    state.device = detect_device()
    state.model = CrossEncoder(MODEL_NAME, device=state.device, max_length=512)
    state.load_time_ms = (time.time() - t0) * 1000
    logger.info(f"Reranker loaded in {state.load_time_ms:.0f}ms | device={state.device}")
    yield
    logger.info("Reranker server shutdown")

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="SuperRAG Reranker Server", version="0.1.0", lifespan=lifespan)

# ─── Models ───────────────────────────────────────────────────────────────────

class RerankRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=4096)
    documents: list[str] = Field(..., min_length=1)
    top_k: int | None = Field(default=None, ge=1, le=100)

class ScoredDocument(BaseModel):
    index: int
    score: float

class RerankResponse(BaseModel):
    scores: list[ScoredDocument]
    model: str
    duration_ms: float

class HealthResponse(BaseModel):
    status: str
    model: str
    device: str
    total_requests: int
    load_time_ms: float

# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/rerank", response_model=RerankResponse)
async def rerank(req: RerankRequest) -> RerankResponse:
    if state.model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if len(req.documents) > MAX_DOCS:
        raise HTTPException(status_code=400, detail=f"Maximum {MAX_DOCS} documents per request")

    state.total_requests += 1
    t0 = time.time()

    # Build pairs: (query, doc) for cross-encoder
    pairs = [(req.query, doc) for doc in req.documents]
    raw_scores: list[float] = state.model.predict(pairs, show_progress_bar=False).tolist()

    # Sort by score descending
    indexed = sorted(enumerate(raw_scores), key=lambda x: x[1], reverse=True)

    # Apply top_k
    if req.top_k is not None:
        indexed = indexed[: req.top_k]

    duration_ms = (time.time() - t0) * 1000
    logger.info(f"Reranked {len(req.documents)} docs in {duration_ms:.1f}ms")

    return RerankResponse(
        scores=[ScoredDocument(index=i, score=round(float(s), 6)) for i, s in indexed],
        model=MODEL_NAME,
        duration_ms=duration_ms,
    )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok" if state.model is not None else "loading",
        model=MODEL_NAME,
        device=state.device,
        total_requests=state.total_requests,
        load_time_ms=state.load_time_ms,
    )


# ─── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
