/**
 * electron/main.js — Addie's Electron entry point.
 */

const { app, BrowserWindow, shell, ipcMain, dialog, utilityProcess } = require('electron');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');
const net  = require('net');

const isDev = process.argv.includes('--dev');
const DEFAULT_UI_PORT = 3000;
/** Actual UI port after startup (may differ if DEFAULT_UI_PORT is busy). */
let serverPort = DEFAULT_UI_PORT;

// How long to wait for the server before giving up.
// node-machine-id + node_modules cold-load can take 20–30s on slow machines.
const SERVER_READY_TIMEOUT = 120000; // 2 minutes

// How long between health-check polls while waiting.
const POLL_INTERVAL_MS = 500;

let mainWindow    = null;
let loadingWindow = null;
let serverProcess = null;
let quitting      = false;

// ─── APP LIFECYCLE ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await showLoadingWindow();
  setLoadingStatus('Starting…', 'Preparing the app');

  try {
    setLoadingStatus('Checking port…', `Default is ${DEFAULT_UI_PORT}`);
    serverPort = await findAvailableListenPort(DEFAULT_UI_PORT);
    if (serverPort !== DEFAULT_UI_PORT) {
      setLoadingStatus(
        'Checking port…',
        `Port ${DEFAULT_UI_PORT} is in use — using ${serverPort}`
      );
    }
  } catch (err) {
    closeLoadingWindow();
    dialog.showErrorBox(
      'Addie — Startup Error',
      `Could not find a free network port for the app.\n\nDetail: ${err.message}`
    );
    quit();
    return;
  }

  setLoadingStatus(
    'Starting backend…',
    'Loading the server (first launch can take a minute on some PCs)'
  );
  startBackendServer(serverPort);

  try {
    await waitForServer(serverPort, SERVER_READY_TIMEOUT, (elapsedMs) => {
      const secs = Math.floor(elapsedMs / 1000);
      setLoadingStatus(
        'Waiting for server…',
        `${secs}s — still loading; antivirus can slow the first run`
      );
    });
  } catch (err) {
    closeLoadingWindow();
    dialog.showErrorBox(
      'Addie — Startup Error',
      `Backend server did not start after ${SERVER_READY_TIMEOUT / 1000}s (port ${serverPort}).\n\nDetail: ${err.message}`
    );
    quit();
    return;
  }

  closeLoadingWindow();
  createWindow();
});

app.on('window-all-closed', () => {
  if (BrowserWindow.getAllWindows().length === 0 && process.platform !== 'darwin') quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', (e) => {
  if (quitting) return;           // Already flushing — let it go
  quitting = true;

  e.preventDefault();             // Hold quit until flush completes

  // Flush all pending chat buffers via HTTP, then kill the server
  fetch(`http://localhost:${serverPort}/api/save-chat`, { method: 'POST' })
    .catch(() => {})              // Server may already be gone
    .finally(() => {
      if (serverProcess) serverProcess.kill();
      app.exit(0);
    });
});

// ─── LOADING WINDOW ───────────────────────────────────────────────────────────
//
// Shown while the server boots so the user sees something immediately
// instead of just a blank taskbar icon. Closed once /health responds.

function showLoadingWindow() {
  return new Promise((resolve) => {
    loadingWindow = new BrowserWindow({
      width: 420,
      height: 200,
      frame: false,
      resizable: false,
      center: true,
      backgroundColor: '#0e0e0e',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    loadingWindow.webContents.once('did-finish-load', () => resolve());

    // Inline HTML — no file needed
    loadingWindow.loadURL(
      'data:text/html,' +
      encodeURIComponent(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            background: #0e0e0e;
            color: #e0e0e0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            gap: 12px;
            user-select: none;
            padding: 16px 20px;
          }
          .title { font-size: 22px; font-weight: 600; letter-spacing: 0.02em; }
          .main  { font-size: 13px; color: #aaa; text-align: center; max-width: 360px; line-height: 1.35; }
          .detail {
            font-size: 12px; color: #555; text-align: center; max-width: 360px;
            line-height: 1.4; min-height: 2.8em;
          }
          .dots  { display: flex; gap: 6px; }
          .dot   {
            width: 7px; height: 7px; border-radius: 50%;
            background: #444;
            animation: pulse 1.2s ease-in-out infinite;
          }
          .dot:nth-child(2) { animation-delay: 0.2s; }
          .dot:nth-child(3) { animation-delay: 0.4s; }
          @keyframes pulse {
            0%, 80%, 100% { background: #444; }
            40%            { background: #888; }
          }
        </style>
      </head>
      <body>
        <div class="title">Addie</div>
        <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
        <div class="main" id="status-main">Starting up…</div>
        <div class="detail" id="status-detail"></div>
      </body>
      </html>
    `)
    );
  });
}

/** Update the loading window copy (safe for arbitrary text). */
function setLoadingStatus(mainLine, detailLine) {
  if (!loadingWindow || loadingWindow.isDestroyed()) return;
  const a = JSON.stringify(mainLine ?? '');
  const b = JSON.stringify(detailLine ?? '');
  loadingWindow.webContents
    .executeJavaScript(
      `document.getElementById('status-main').textContent = ${a};
       document.getElementById('status-detail').textContent = ${b};`
    )
    .catch(() => {});
}

function closeLoadingWindow() {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.close();
    loadingWindow = null;
  }
}

// ─── PORT CLEANUP ─────────────────────────────────────────────────────────────

async function freePort(port) {
  const inUse = await isPortInUse(port);
  if (!inUse) return;

  console.log(`[electron] Port ${port} in use — killing stale process...`);

  try {
    if (process.platform === 'win32') {
      const output = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf8', timeout: 3000 }
      );
      const match = output.trim().match(/(\d+)\s*$/m);
      if (match) {
        const pid = parseInt(match[1], 10);
        if (pid && pid !== process.pid) {
          execSync(`taskkill /PID ${pid} /F`, { timeout: 3000 });
          console.log(`[electron] Killed PID ${pid} on port ${port}.`);
        }
      }
    } else {
      execSync(`lsof -ti tcp:${port} | xargs kill -9`, { timeout: 3000 });
      console.log(`[electron] Freed port ${port}.`);
    }
  } catch (e) {
    console.warn(`[electron] Could not free port ${port}: ${e.message}`);
  }

  await sleep(400);
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(true));
    tester.once('listening', () => { tester.close(); resolve(false); });
    tester.listen(port, '127.0.0.1');
  });
}

/**
 * Prefer `preferred` (usually 3000). Try to free a stale Addie listener there,
 * then fall back to the next free port if something else still holds it.
 */
async function findAvailableListenPort(preferred) {
  if (!(await isPortInUse(preferred))) return preferred;

  setLoadingStatus('Freeing port…', `Trying to stop a previous Addie instance on port ${preferred}`);
  await freePort(preferred);
  if (!(await isPortInUse(preferred))) return preferred;

  const max = Math.min(preferred + 64, 65535);
  for (let p = preferred + 1; p <= max; p++) {
    if (!(await isPortInUse(p))) {
      console.warn(`[electron] UI port ${preferred} busy — using ${p}`);
      return p;
    }
  }
  throw new Error(`No free port between ${preferred + 1} and ${max}`);
}

// ─── WINDOW ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 600,
    minHeight: 480,
    backgroundColor: '#0e0e0e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: path.join(__dirname, '..', 'ui', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('close', async (e) => {
    // Always flush any pending chat turns to disk before closing.
    // No confirmation dialog — conversations should always persist.
    try {
      await fetch(`http://localhost:${serverPort}/api/save-chat`, { method: 'POST' });
    } catch { /* server may already be gone — that's fine */ }
  });

  mainWindow.loadURL(`http://localhost:${serverPort}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) mainWindow.webContents.openDevTools();
}

// ─── BACKEND SERVER ───────────────────────────────────────────────────────────

function startBackendServer(port) {
  const serverPath = path.join(__dirname, '..', 'app', 'server.js');

  // utilityProcess is Electron's built-in way to run a Node.js child process.
  // Unlike fork(), it works correctly inside packaged asars on all platforms,
  // including Windows where fork() has known module resolution issues.
  serverProcess = utilityProcess.fork(serverPath, [], {
    env: {
      ...process.env,
      ADDIE_ROOT:      path.join(__dirname, '..'),
      ADDIE_RESOURCES: process.resourcesPath || '',
      ADDIE_USER_DATA: app.getPath('userData'),
      ADDIE_UI_PORT:   String(port),
      NODE_ENV:        isDev ? 'development' : 'production',
    },
    stdio: 'inherit',
  });

  serverProcess.on('exit', (code) => {
    console.error(`[electron] Server exited with code ${code}`);
    const windowUp =
      (mainWindow && !mainWindow.isDestroyed()) ||
      (loadingWindow && !loadingWindow.isDestroyed());
    if (code !== 0 && !quitting && windowUp) {
      closeLoadingWindow();
      dialog.showErrorBox(
        'Addie — Server Error',
        'The backend server stopped unexpectedly. If this happens on first install, check the log and try again. Please restart Addie.'
      );
    }
  });
}

// ─── WAIT FOR SERVER ──────────────────────────────────────────────────────────

function waitForServer(port, timeout, onProgress) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let settled = false;

    function poll() {
      if (onProgress) onProgress(Date.now() - start);
      const req = http.get(`http://localhost:${port}/health`, (res) => {
        res.resume();
        if (!settled && res.statusCode === 200) {
          settled = true;
          resolve();
        } else if (!settled) {
          scheduleRetry();
        }
      });
      req.on('error', () => { if (!settled) scheduleRetry(); });
      req.setTimeout(1000, () => req.destroy());
    }

    function scheduleRetry() {
      if (Date.now() - start > timeout) {
        settled = true;
        reject(new Error('Server did not start in time.'));
      } else {
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    setTimeout(poll, 500);
  });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function quit() {
  if (serverProcess) serverProcess.kill();
  app.quit();
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('pick-context-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Context files', extensions: ['md', 'txt', 'pdf'] }],
  });
  return result.filePaths[0] || null;
});

// Expose platform and app root to renderer for onboarding
ipcMain.handle('get-app-info', () => ({
  platform: process.platform,
  appRoot:  path.join(__dirname, '..'),
}));

// Find all Ableton Live installations on this machine.
// Returns array of { version, scriptsPath } sorted newest first.
ipcMain.handle('find-ableton-paths', () => {
  const fs = require('fs');
  const results = [];

  const candidates = process.platform === 'win32'
    ? (() => {
        // Ableton stores its scripts under ProgramData on whatever drive it's installed on.
        // PROGRAMDATA env var only reflects the system drive, so we probe C/D/E as well.
        const seen  = new Set();
        const paths = [];
        const envPd    = process.env.PROGRAMDATA || 'C:\\ProgramData';
        const envDrive = envPd.slice(0, 2).toUpperCase(); // "C:" etc.
        for (const d of [envDrive, 'C:', 'D:', 'E:']) {
          const p = `${d}\\ProgramData\\Ableton`;
          if (!seen.has(p)) { seen.add(p); paths.push(p); }
        }
        return paths;
      })()
    : [
        '/Applications',
        path.join(require('os').homedir(), 'Applications'),
      ];

  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    let entries;
    try { entries = fs.readdirSync(base); } catch { continue; }

    for (const entry of entries) {
      if (!/live/i.test(entry)) continue;
      let scriptsPath;

      if (process.platform === 'win32') {
        // ProgramData\Ableton\Live X.X.X\Resources\MIDI Remote Scripts
        scriptsPath = path.join(base, entry, 'Resources', 'MIDI Remote Scripts');
      } else {
        // /Applications/Ableton Live X Suite.app/Contents/App-Resources/MIDI Remote Scripts
        scriptsPath = path.join(base, entry, 'Contents', 'App-Resources', 'MIDI Remote Scripts');
      }

      if (fs.existsSync(scriptsPath)) {
        results.push({ version: entry, scriptsPath });
      }
    }
  }

  // Sort newest first by version string
  results.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return results;
});

// Find Ableton's User Library path.
// Windows: %USERPROFILE%\Documents\Ableton\User Library
// Mac: ~/Music/Ableton/User Library
ipcMain.handle('find-user-library-path', () => {
  const fs = require('fs');
  const os = require('os');
  const home = os.homedir();

  const candidates = process.platform === 'win32'
    ? [
        path.join(home, 'Documents', 'Ableton', 'User Library'),
        path.join(home, 'OneDrive', 'Documents', 'Ableton', 'User Library'),
      ]
    : [
        // Standard macOS location
        path.join(home, 'Music', 'Ableton', 'User Library'),
        // iCloud Drive sync location (common when iCloud Desktop & Documents is on)
        path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs',
                  'Music', 'Ableton', 'User Library'),
      ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
});
