#!/usr/bin/env python3
"""
scripts/query_index.py

Runtime retrieval helper. Called as a subprocess by app/rag.js.

Reads the pre-built index once, then accepts queries on stdin (one per line)
and writes JSON results to stdout. Stays alive between queries to avoid
reloading the model on every message.

Protocol:
  stdin  <- one query string per line
  stdout -> one JSON array per line: [{ "text": "...", "source": "..." }, ...]
  stderr -> diagnostic messages (not read by Node)

Designed to be spawned once at server startup and kept alive.

Requirements (runtime, bundled with app):
    pip install sentence-transformers numpy
    (model weights: ~80MB, downloaded once and cached)
"""

import json
import os
import sys

INDEX_DIR  = os.path.join(os.path.dirname(__file__), '..', 'knowledge', '.index')
MODEL_NAME = os.environ.get('ADDIE_EMBED_MODEL', 'all-MiniLM-L6-v2')
TOP_K      = int(os.environ.get('ADDIE_RAG_TOP_K', '5'))

# ---------------------------------------------------------------------------
# Load index
# ---------------------------------------------------------------------------

def load_index():
    chunks_path  = os.path.join(INDEX_DIR, 'chunks.json')
    vectors_path = os.path.join(INDEX_DIR, 'vectors.npy')

    if not os.path.exists(chunks_path) or not os.path.exists(vectors_path):
        print(json.dumps({'error': f'Index not found at {INDEX_DIR}'}), flush=True)
        sys.exit(1)

    try:
        import numpy as np
    except ImportError:
        print(json.dumps({'error': 'numpy not installed'}), flush=True)
        sys.exit(1)

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print(json.dumps({'error': 'sentence-transformers not installed'}), flush=True)
        sys.exit(1)

    print('[rag] Loading index...', file=sys.stderr, flush=True)

    with open(chunks_path, 'r', encoding='utf-8') as f:
        chunks = json.load(f)

    vectors = np.load(vectors_path).astype(np.float32)

    print(f'[rag] {len(chunks)} chunks loaded', file=sys.stderr, flush=True)
    print(f'[rag] Loading embedding model: {MODEL_NAME}', file=sys.stderr, flush=True)

    model = SentenceTransformer(MODEL_NAME)

    print('[rag] Ready', file=sys.stderr, flush=True)

    return chunks, vectors, model, np

# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------

def retrieve(query, chunks, vectors, model, np, top_k=TOP_K):
    """
    Embed the query and return the top_k most similar chunks.
    Vectors are pre-normalized so dot product == cosine similarity.
    """
    q_vec  = model.encode([query], convert_to_numpy=True, normalize_embeddings=True)[0]
    scores = vectors @ q_vec                       # shape: (n_chunks,)
    top_i  = scores.argsort()[::-1][:top_k]       # descending

    results = []
    for i in top_i:
        results.append({
            'text':   chunks[i]['text'],
            'source': chunks[i]['source'],
            'score':  float(scores[i]),
        })

    return results

# ---------------------------------------------------------------------------
# Main loop — one query per stdin line
# ---------------------------------------------------------------------------

def main():
    chunks, vectors, model, np = load_index()

    # Signal to Node that we're ready
    print(json.dumps({'ready': True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
            query   = payload.get('query', '')
            top_k   = payload.get('top_k', TOP_K)
        except json.JSONDecodeError:
            # Plain string fallback
            query = line
            top_k = TOP_K

        if not query:
            print(json.dumps([]), flush=True)
            continue

        try:
            results = retrieve(query, chunks, vectors, model, np, top_k)
            print(json.dumps(results), flush=True)
        except Exception as e:
            print(json.dumps({'error': str(e)}), flush=True)


if __name__ == '__main__':
    main()
