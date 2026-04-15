/**
 * themes.js — Theme system for Addie UI
 *
 * Themes: midnight (default dark), clear (light), carmesi (crimson dark), turquesa (teal dark)
 * Applies CSS variables to :root and stores preference in localStorage.
 */

console.log('[addie-debug] themes.js loading');

const THEMES = {
  midnight: {
    label: 'Midnight',
    labelEs: 'Medianoche',
    swatch: '#0e0e0e',
    dotColor: '#0e0e0e',
    vars: {
      '--bg':           '#0e0e0e',
      '--surface':      '#161616',
      '--border':       '#242424',
      '--accent':       '#c8ff00',
      '--accent-dim':   '#8acc00',
      '--text':         '#e8e8e8',
      '--text-dim':     '#666',
      '--user-bubble':  '#1a1a1a',
      '--addie-bubble': '#111',
      '--danger':       '#cc4444',
      '--ok':           '#8acc00',
      '--warn':         '#cc9900',
    }
  },
  clear: {
    label: 'Clear',
    labelEs: 'Claro',
    swatch: '#f2f0ed',
    dotColor: '#f2f0ed',
    vars: {
      '--bg':           '#f2f0ed',
      '--surface':      '#ffffff',
      '--border':       '#ddd8d0',
      '--accent':       '#1a1a1a',
      '--accent-dim':   '#555',
      '--text':         '#1a1a1a',
      '--text-dim':     '#888',
      '--user-bubble':  '#e8e5e0',
      '--addie-bubble': '#f8f6f3',
      '--danger':       '#c03030',
      '--ok':           '#2d7a30',
      '--warn':         '#9a7a20',
    }
  },
  carmesi: {
    label: 'Carmesí',
    labelEs: 'Carmesí',
    swatch: '#3d0a10',
    dotColor: '#ff3b5c',
    vars: {
      '--bg':           '#150508',
      '--surface':      '#220d10',
      '--border':       '#3a1a1e',
      '--accent':       '#ff3b5c',
      '--accent-dim':   '#cc2040',
      '--text':         '#f0e0e0',
      '--text-dim':     '#775555',
      '--user-bubble':  '#1e1414',
      '--addie-bubble': '#160e0e',
      '--danger':       '#ff4444',
      '--ok':           '#ff6080',
      '--warn':         '#cc6633',
    }
  },
  turquesa: {
    label: 'Turquesa',
    labelEs: 'Turquesa',
    swatch: '#070e10',
    dotColor: '#00e5c8',
    vars: {
      '--bg':           '#070e10',
      '--surface':      '#0e1a1e',
      '--border':       '#1a2e34',
      '--accent':       '#00e5c8',
      '--accent-dim':   '#00b09a',
      '--text':         '#ddf0ee',
      '--text-dim':     '#557777',
      '--user-bubble':  '#0e1a1c',
      '--addie-bubble': '#091416',
      '--danger':       '#ff5555',
      '--ok':           '#00e5c8',
      '--warn':         '#c0a840',
    }
  },
};

let _currentTheme = 'midnight';
try {
  const saved = localStorage.getItem('addie-theme');
  _currentTheme = (saved && THEMES[saved]) ? saved : 'midnight';
} catch(e) {}

function getTheme() { return _currentTheme; }
function getThemes() { return THEMES; }

function setTheme(name) {
  if (!THEMES[name]) return;
  _currentTheme = name;
  try { localStorage.setItem('addie-theme', name); } catch(e) {}
  applyTheme();
}

function applyTheme() {
  const root = document.documentElement;
  const theme = THEMES[_currentTheme] || THEMES.midnight;
  const defaults = THEMES.midnight.vars;

  // Remove all theme classes
  for (const key of Object.keys(THEMES)) {
    root.classList.remove(`theme-${key}`);
  }
  root.classList.add(`theme-${_currentTheme}`);

  // Always reset to midnight defaults first, then overlay current theme
  for (const [prop, val] of Object.entries(defaults)) {
    root.style.setProperty(prop, val);
  }
  if (_currentTheme !== 'midnight') {
    for (const [prop, val] of Object.entries(theme.vars)) {
      root.style.setProperty(prop, val);
    }
  }
}

// Apply on load
applyTheme();

window.themes = { getTheme, getThemes, setTheme, applyTheme, THEMES };
