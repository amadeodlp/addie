#!/usr/bin/env python3
"""
scripts/build_index.py

Pre-build the RAG index from all PDFs in knowledge/.
Run this once whenever you add new PDFs to the knowledge folder.

Requirements (build-time only, not needed at app runtime):
    pip install pymupdf sentence-transformers numpy

Usage:
    python scripts/build_index.py
    python scripts/build_index.py --knowledge-dir /path/to/knowledge
"""

import argparse
import json
import os
import re
import sys
import time

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

parser = argparse.ArgumentParser()
parser.add_argument(
    '--knowledge-dir',
    default=os.path.join(os.path.dirname(__file__), '..', 'knowledge'),
    help='Path to the knowledge/ folder containing PDFs',
)
parser.add_argument('--chunk-size', type=int, default=400,
    help='Target chunk size in words (default: 400)')
parser.add_argument('--overlap', type=int, default=50,
    help='Word overlap between consecutive chunks (default: 50)')
parser.add_argument('--model', default='all-MiniLM-L6-v2',
    help='sentence-transformers model name (default: all-MiniLM-L6-v2)')
args = parser.parse_args()

KNOWLEDGE_DIR = os.path.abspath(args.knowledge_dir)
INDEX_DIR     = os.path.join(KNOWLEDGE_DIR, '.index')
CHUNK_SIZE    = args.chunk_size
OVERLAP       = args.overlap
MODEL_NAME    = args.model

# ---------------------------------------------------------------------------
# Imports
# ---------------------------------------------------------------------------

try:
    import fitz  # PyMuPDF
except ImportError:
    print('ERROR: PyMuPDF not installed. Run: pip install pymupdf')
    sys.exit(1)

try:
    import numpy as np
except ImportError:
    print('ERROR: numpy not installed. Run: pip install numpy')
    sys.exit(1)

try:
    from sentence_transformers import SentenceTransformer
except (ImportError, Exception) as e:
    print(f'ERROR: Could not import sentence-transformers: {e}')
    print('\nThis usually means PyTorch is not loadable. Try:')
    print('  pip uninstall torch torchvision torchaudio -y')
    print('  pip install torch --index-url https://download.pytorch.org/whl/cpu')
    sys.exit(1)

# ---------------------------------------------------------------------------
# PDF extraction
# ---------------------------------------------------------------------------

def extract_pdf_text(pdf_path):
    """
    Extract text from a PDF, page by page.
    Returns list of (page_num, text) tuples.
    Skips pages with very little text (scanned images, diagrams).
    """
    doc   = fitz.open(pdf_path)
    pages = []
    for page_num, page in enumerate(doc, start=1):
        text = page.get_text('text')
        if len(text.strip()) < 80:
            continue
        pages.append((page_num, text))
    doc.close()
    return pages

# ---------------------------------------------------------------------------
# Cleaning and chunking
# ---------------------------------------------------------------------------

def clean_text(text):
    """Normalize whitespace and remove common PDF artifacts."""
    text = re.sub(r'\n{3,}', '\n\n', text)        # collapse excess blank lines
    text = re.sub(r'[ \t]{2,}', ' ', text)         # collapse inline whitespace
    text = re.sub(r'-\n(\w)', r'\1', text)          # rejoin hyphenated line breaks
    text = re.sub(r'(\w)\n(\w)', r'\1 \2', text)   # rejoin mid-sentence line breaks
    return text.strip()


def detect_chapter(text):
    """
    Try to extract a chapter or section heading from the top of a page.
    Used to prefix chunks so retrieved passages carry their source context.
    """
    lines = text.strip().split('\n')
    for line in lines[:6]:
        line = line.strip()
        if re.match(r'^(chapter|part|section)\s+\d+', line, re.IGNORECASE):
            return line[:80]
        if re.match(r'^\d+[\.\s]+[A-Z]', line):
            return line[:80]
        if 8 < len(line) < 80 and line.isupper():
            return line[:80]
    return ''


def chunk_text(text, source, chapter_hint=''):
    """
    Split text into overlapping word-based chunks.
    Prepends [chapter_hint] to each chunk so the LLM knows the context.
    Returns list of { text, source } dicts.
    """
    words  = text.split()
    chunks = []
    i      = 0

    while i < len(words):
        chunk_words = words[i:i + CHUNK_SIZE]
        chunk_str   = ' '.join(chunk_words)

        if chapter_hint:
            chunk_str = f'[{chapter_hint}] {chunk_str}'

        chunks.append({'text': chunk_str, 'source': source})
        i += CHUNK_SIZE - OVERLAP

    return chunks

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    os.makedirs(INDEX_DIR, exist_ok=True)

    pdf_files = sorted(f for f in os.listdir(KNOWLEDGE_DIR) if f.lower().endswith('.pdf'))
    if not pdf_files:
        print(f'No PDFs found in {KNOWLEDGE_DIR}')
        sys.exit(1)

    print(f'Found {len(pdf_files)} PDF(s)')
    print(f'Chunk size: {CHUNK_SIZE} words | Overlap: {OVERLAP} words | Model: {MODEL_NAME}\n')

    all_chunks = []

    for pdf_file in pdf_files:
        pdf_path = os.path.join(KNOWLEDGE_DIR, pdf_file)
        source   = os.path.splitext(pdf_file)[0]
        print(f'Extracting: {pdf_file}')

        try:
            pages = extract_pdf_text(pdf_path)
        except Exception as e:
            print(f'  ERROR: {e}')
            continue

        print(f'  {len(pages)} pages')
        book_chunks     = []
        current_chapter = ''

        for page_num, raw_text in pages:
            text    = clean_text(raw_text)
            chapter = detect_chapter(raw_text)
            if chapter:
                current_chapter = chapter

            page_chunks = chunk_text(
                text,
                source=f'{source} p.{page_num}',
                chapter_hint=current_chapter,
            )
            book_chunks.extend(page_chunks)

        print(f'  {len(book_chunks)} chunks')
        all_chunks.extend(book_chunks)

    print(f'\nTotal: {len(all_chunks)} chunks across all books')

    # -- Embed ---------------------------------------------------------------
    print(f'\nLoading embedding model: {MODEL_NAME}')
    t0    = time.time()
    model = SentenceTransformer(MODEL_NAME)
    print(f'Loaded in {time.time() - t0:.1f}s')

    print(f'Embedding...')
    t0 = time.time()
    vectors = model.encode(
        [c['text'] for c in all_chunks],
        show_progress_bar=True,
        convert_to_numpy=True,
        normalize_embeddings=True,  # dot product becomes cosine similarity
    )
    print(f'Done in {time.time() - t0:.1f}s — shape: {vectors.shape}')

    # -- Save ----------------------------------------------------------------
    chunks_path  = os.path.join(INDEX_DIR, 'chunks.json')
    vectors_path = os.path.join(INDEX_DIR, 'vectors.npy')

    with open(chunks_path, 'w', encoding='utf-8') as f:
        json.dump(all_chunks, f, ensure_ascii=False, indent=2)

    np.save(vectors_path, vectors.astype(np.float32))

    chunks_kb  = os.path.getsize(chunks_path)  / 1024
    vectors_mb = os.path.getsize(vectors_path) / 1024 / 1024

    print(f'\nIndex written to {INDEX_DIR}')
    print(f'  chunks.json  {chunks_kb:.0f} KB  ({len(all_chunks)} chunks)')
    print(f'  vectors.npy  {vectors_mb:.1f} MB  ({vectors.shape[0]} x {vectors.shape[1]} float32)')
    print('\nCommit the .index/ folder to ship the pre-built index with the app.')


if __name__ == '__main__':
    main()
