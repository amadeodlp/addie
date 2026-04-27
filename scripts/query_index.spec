# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for query_index.py
#
# Produces a single-file executable with Python + sentence-transformers + numpy
# bundled. No Python installation required on the end user's machine.
#
# Build (run from repo root):
#   pip install pyinstaller sentence-transformers numpy
#   pyinstaller scripts/query_index.spec
#
# Output:
#   dist/query_index        (macOS/Linux)
#   dist/query_index.exe    (Windows)
#
# Move the output to build-bin/ before running electron-builder:
#   mkdir -p build-bin
#   mv dist/query_index build-bin/   (or dist/query_index.exe on Windows)

import sys
from PyInstaller.utils.hooks import collect_data_files, collect_all

# sentence-transformers ships tokenizer configs and model data as package data
datas = []
datas += collect_data_files('sentence_transformers')
datas += collect_data_files('tokenizers')
datas += collect_data_files('transformers')

hiddenimports = [
    'sentence_transformers',
    'transformers',
    'tokenizers',
    'numpy',
    'numpy.core._methods',
    'numpy.lib.format',
    'tqdm',
    'huggingface_hub',
    'filelock',
    'packaging',
]

a = Analysis(
    ['query_index.py'],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['matplotlib', 'PIL', 'IPython', 'jupyter', 'notebook', 'pytest'],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='query_index',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,   # needs stdin/stdout — must be console app
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
