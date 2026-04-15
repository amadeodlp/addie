# scripts/

Development and build-time scripts. Not shipped with the app.

---

## build_index.py

Pre-builds the RAG knowledge index from PDFs in `knowledge/`.
Run this once from the project root whenever you add new PDFs.

**Requirements (build-time only):**
```bash
pip install pymupdf sentence-transformers numpy
```

**Usage:**
```bash
python scripts/build_index.py
```

Output: `knowledge/.index/chunks.json` and `knowledge/.index/vectors.npy`

Commit the `.index/` folder so end users get RAG out of the box without
needing to run anything.

---

## query_index.py

Runtime retrieval helper. Spawned as a long-lived subprocess by `app/rag.js`.
Do not run this manually — `rag.js` manages its lifecycle automatically.

**Requirements (runtime, must be installed in the Python environment
that the app uses):**
```bash
pip install sentence-transformers numpy
```

The embedding model (`all-MiniLM-L6-v2`, ~80MB) is downloaded once on
first run and cached in the default sentence-transformers cache directory.

---

## Adding new knowledge sources

1. Add PDFs to `knowledge/`
2. Run `python scripts/build_index.py`
3. Commit the updated `knowledge/.index/` files
4. Restart the app — `rag.js` will pick up the new index automatically
