/**
 * i18n.js — Internationalization for Addie UI
 *
 * Supports: English (en), Spanish (es)
 * Usage:  t('key')  returns the translated string for the active language.
 *         setLanguage('es')  switches language and re-renders all data-i18n elements.
 */

console.log('[addie-debug] i18n.js loading');

const TRANSLATIONS = {
  en: {
    // ── Projects page ──
    'projects.title': 'Projects',
    'projects.new': 'New project',
    'projects.prompt_name': 'Project name:',

    // ── Project detail ──
    'detail.back': '← Projects',
    'detail.conversations': 'CONVERSATIONS',
    'detail.new_conv': '+ New',
    'detail.knowledge': 'PROJECT KNOWLEDGE',
    'detail.knowledge_hint': 'Notes and references Addie reads before every message in this project.',
    'detail.add_knowledge': '+ Add',
    'detail.no_knowledge': 'No knowledge files yet.',
    'detail.delete_project': 'Delete project',
    'detail.delete_confirm': 'Delete project "{name}" and all its conversations and knowledge? This cannot be undone.',
    'detail.delete_conv_confirm': 'Delete "{title}"?',
    'detail.cant_delete_last': "Can't delete the last conversation.",
    'detail.edit_desc_placeholder': 'Project description...',

    // ── Chat view ──
    'chat.back': '← Projects',
    'chat.new_conv': '+ New conversation',
    'chat.sync_now': '↺ Sync now',
    'chat.settings': '⚙ Settings',
    'chat.no_sync': 'No sync yet',
    'chat.synced': 'Synced · {count} tracks',
    'chat.placeholder': 'Talk to Addie...',
    'chat.saved': 'Chat saved.',
    'chat.connection_lost': '⚠ Connection lost. Reopen Addie.',
    'chat.syncing': 'Syncing session...',
    'chat.sync_progress': 'Syncing… {stage}',
    'chat.session_synced': 'Session synced · {count} tracks',
    'chat.sync_error': '⚠ Sync error: {error}',
    'chat.label_you': 'you',
    'chat.label_addie': 'addie',
    'chat.rename_prompt': 'Rename conversation:',
    'chat.conversation': 'Conversation',
    'chat.bridge_connected': 'Addie Bridge connected',
    'chat.bridge_not_detected': 'Addie Bridge not detected',
    'chat.bridge_help': 'Bridge setup help',

    // ── Actions ──
    'actions.all_failed': 'All {count} action(s) failed',
    'actions.mixed': '{ok} succeeded, {fail} failed',
    'actions.self_corrected': '{count} self-corrected',
    'actions.executed': '{count} action(s) executed',
    'actions.show_thinking': 'show thinking',
    'actions.hide_thinking': 'hide thinking',

    // ── Settings ──
    'settings.title': 'Settings',
    'settings.api_key_label': 'LLM API KEY OR LOCAL ENDPOINT',
    'settings.api_key': 'LLM API KEY OR LOCAL ENDPOINT',
    'settings.api_key_placeholder': 'Paste API key or local endpoint (e.g. http://localhost:11434/v1)',
    'settings.what_key': '? What key do I need?',
    'settings.what_key_close': '✕  Close',
    'settings.producer_prefs': 'PRODUCER PREFERENCES',
    'settings.producer_prefs_hint': 'Addie uses these to give better context-aware advice. Edit anytime.',
    'settings.endpoint': 'LOCAL / CUSTOM ENDPOINT',
    'settings.endpoint_optional': '(optional)',
    'settings.endpoint_placeholder': 'e.g. http://localhost:11434/v1',
    'settings.endpoint_hint': 'For Ollama, LM Studio, or any OpenAI-compatible server.',
    'settings.model_id': 'MODEL ID',
    'settings.model_placeholder': 'e.g. llama3-70b-8192',
    'settings.provider_guide': 'PROVIDER GUIDE',
    'settings.control_surface': 'CONTROL SURFACE',
    'settings.reinstall': 'Reinstall into Ableton',
    'settings.theme': 'THEME',
    'settings.language': 'LANGUAGE',
    'settings.save': 'Save',
    'settings.saved': 'Saved.',
    'settings.looking_ableton': 'Looking for Ableton...',
    'settings.ableton_not_found': 'Ableton not found. Copy control_surface/ manually to MIDI Remote Scripts/Addie/',
    'settings.installing_into': 'Installing into {version}...',
    'settings.installed_into': 'Installed into {version}. Restart Ableton to pick up changes.',
    'settings.install_failed': 'Failed: {error}',
    'settings.onboarding_label': 'ONBOARDING',
    'settings.redo_onboarding': 'Redo onboarding wizard',
    'settings.onboarding_reset': 'Restarting…',

    // ── Kickstarts ──
    'kickstarts.greeting': 'What are we working on?',
    'kickstarts.subtitle': 'Pick a starting point, or type anything below.',
    'kickstarts.new_project': 'New project',
    'kickstarts.wip': 'Work in progress',

    // ── Onboarding ──
    'ob.welcome_l1': "Hey. I'm Addie.",
    'ob.welcome_l2': "I'm your AI co-producer inside Ableton Live.",
    'ob.welcome_l3': "I can hear what's in your session, diagnose mix problems, and control your devices. Let's get you set up.",
    'ob.lets_go': "Let's go",
    'ob.llm_title': 'First, I need a brain.',
    'ob.llm_desc': 'I use a language model to understand your session and talk with you. You can use a free API key, or run a local model with no key at all.',
    'ob.api_key': 'API key',
    'ob.recommended': 'Recommended',
    'ob.api_desc': 'OpenAI, Anthropic, DeepSeek, and OpenRouter are all supported. Or run a local model with no key at all.',
    'ob.local_model': 'Local model',
    'ob.local_desc': 'Run Ollama or LM Studio on this machine. No key, no cost, fully private.',
    'ob.checking_local': 'Checking for local models...',
    'ob.local_detected': '{name} detected — ready to use',
    'ob.no_local': 'No local model found',
    'ob.continue': 'Continue',
    'ob.set_up_later': 'Set up later',
    'ob.install_title': 'Installing Addie into Ableton.',
    'ob.install_desc': 'I need to copy a small script into your Ableton Remote Scripts folder. This is what lets me see and control your session.',
    'ob.searching_ableton': 'Looking for Ableton installations...',
    'ob.install_not_found': 'Ableton installation not found automatically.',
    'ob.enable_title': 'One manual step in Ableton.',
    'ob.enable_desc': 'Ableton requires you to enable Remote Scripts from its Preferences. This is a one-time setup.',
    'ob.enable_waiting': 'Waiting for Addie to connect to Ableton...',
    'ob.enable_connected': 'Connected to Ableton.',
    'ob.prefs_title': 'Tell me about how you work.',
    'ob.prefs_desc': 'This helps me give better advice from day one. Everything is optional — you can edit or add to this anytime in producer.md.',
    'ob.genre': 'Genre / style',
    'ob.genre_placeholder': 'e.g. Hip-hop, Techno, Pop, Jazz...',
    'ob.experience': 'Experience level',
    'ob.beginner': 'Beginner',
    'ob.intermediate': 'Intermediate',
    'ob.advanced': 'Advanced',
    'ob.professional': 'Professional',
    'ob.monitoring': 'Monitoring setup',
    'ob.monitors': 'Studio monitors',
    'ob.headphones': 'Headphones',
    'ob.both': 'Both',
    'ob.plugins': 'Plugins / tools you use',
    'ob.plugins_placeholder': 'e.g. Serum, Fabfilter, Valhalla...',
    'ob.references': 'Reference artists or target sound',
    'ob.references_placeholder': 'e.g. Metro Boomin, Burial, Charlotte de Witte...',
    'ob.start_producing': 'Start producing',
    'ob.skip': 'Skip',

    // ── Misc ──
    'misc.save': 'Save',
    'misc.cancel': 'Cancel',
    'misc.ok': 'OK',
    'misc.delete': 'Delete',
    'misc.just_now': 'just now',
    'misc.minutes_ago': '{n}m ago',
    'misc.hours_ago': '{n}h ago',
    'misc.days_ago': '{n}d ago',
  },

  es: {
    // ── Página de proyectos ──
    'projects.title': 'Proyectos',
    'projects.new': 'Nuevo proyecto',
    'projects.prompt_name': 'Nombre del proyecto:',

    // ── Detalle del proyecto ──
    'detail.back': '← Proyectos',
    'detail.conversations': 'CONVERSACIONES',
    'detail.new_conv': '+ Nueva',
    'detail.knowledge': 'BASE DE CONOCIMIENTO',
    'detail.knowledge_hint': 'Notas y referencias que Addie lee antes de cada mensaje en este proyecto.',
    'detail.add_knowledge': '+ Agregar',
    'detail.no_knowledge': 'Sin archivos de conocimiento aún.',
    'detail.delete_project': 'Eliminar proyecto',
    'detail.delete_confirm': '¿Eliminar proyecto "{name}" y todas sus conversaciones y conocimiento? Esto no se puede deshacer.',
    'detail.delete_conv_confirm': '¿Eliminar "{title}"?',
    'detail.cant_delete_last': 'No se puede eliminar la última conversación.',
    'detail.edit_desc_placeholder': 'Descripción del proyecto...',

    // ── Vista de chat ──
    'chat.back': '← Proyectos',
    'chat.new_conv': '+ Nueva conversación',
    'chat.sync_now': '↺ Sincronizar',
    'chat.settings': '⚙ Ajustes',
    'chat.no_sync': 'Sin sincronizar',
    'chat.synced': 'Sincronizado · {count} pistas',
    'chat.placeholder': 'Habla con Addie...',
    'chat.saved': 'Chat guardado.',
    'chat.connection_lost': '⚠ Conexión perdida. Reabrí Addie.',
    'chat.syncing': 'Sincronizando sesión...',
    'chat.sync_progress': 'Sincronizando… {stage}',
    'chat.session_synced': 'Sesión sincronizada · {count} pistas',
    'chat.sync_error': '⚠ Error de sincronización: {error}',
    'chat.label_you': 'vos',
    'chat.label_addie': 'addie',
    'chat.rename_prompt': 'Renombrar conversación:',
    'chat.conversation': 'Conversación',
    'chat.bridge_connected': 'Addie Bridge conectado',
    'chat.bridge_not_detected': 'Addie Bridge no detectado',
    'chat.bridge_help': 'Ayuda con el bridge',

    // ── Acciones ──
    'actions.all_failed': 'Las {count} acción(es) fallaron',
    'actions.mixed': '{ok} exitosas, {fail} fallidas',
    'actions.self_corrected': '{count} auto-corregida(s)',
    'actions.executed': '{count} acción(es) ejecutada(s)',
    'actions.show_thinking': 'mostrar razonamiento',
    'actions.hide_thinking': 'ocultar razonamiento',

    // ── Ajustes ──
    'settings.title': 'Ajustes',
    'settings.api_key_label': 'CLAVE API O ENDPOINT LOCAL',
    'settings.api_key': 'CLAVE API O ENDPOINT LOCAL',
    'settings.api_key_placeholder': 'Pegá tu clave API o endpoint local (ej. http://localhost:11434/v1)',
    'settings.what_key': '? ¿Qué clave necesito?',
    'settings.what_key_close': '✕  Cerrar',
    'settings.producer_prefs': 'PREFERENCIAS DE PRODUCTOR',
    'settings.producer_prefs_hint': 'Addie las usa para dar consejos más contextuales. Editables en cualquier momento.',
    'settings.endpoint': 'ENDPOINT LOCAL / CUSTOM',
    'settings.endpoint_optional': '(opcional)',
    'settings.endpoint_placeholder': 'ej. http://localhost:11434/v1',
    'settings.endpoint_hint': 'Para Ollama, LM Studio, o cualquier servidor compatible con OpenAI.',
    'settings.model_id': 'ID DEL MODELO',
    'settings.model_placeholder': 'ej. llama3-70b-8192',
    'settings.provider_guide': 'GUÍA DE PROVEEDORES',
    'settings.control_surface': 'CONTROL SURFACE',
    'settings.reinstall': 'Reinstalar en Ableton',
    'settings.theme': 'TEMA',
    'settings.language': 'IDIOMA',
    'settings.save': 'Guardar',
    'settings.saved': 'Guardado.',
    'settings.looking_ableton': 'Buscando Ableton...',
    'settings.ableton_not_found': 'Ableton no encontrado. Copiá control_surface/ manualmente a MIDI Remote Scripts/Addie/',
    'settings.installing_into': 'Instalando en {version}...',
    'settings.installed_into': 'Instalado en {version}. Reiniciá Ableton para aplicar cambios.',
    'settings.install_failed': 'Falló: {error}',
    'settings.onboarding_label': 'ONBOARDING',
    'settings.redo_onboarding': 'Repetir wizard de onboarding',
    'settings.onboarding_reset': 'Reiniciando…',

    // ── Kickstarts ──
    'kickstarts.greeting': '¿En qué estamos trabajando?',
    'kickstarts.subtitle': 'Elegí un punto de partida, o escribí lo que quieras abajo.',
    'kickstarts.new_project': 'Proyecto nuevo',
    'kickstarts.wip': 'Trabajo en progreso',

    // ── Onboarding ──
    'ob.welcome_l1': 'Hola. Soy Addie.',
    'ob.welcome_l2': 'Soy tu co-productor IA dentro de Ableton Live.',
    'ob.welcome_l3': 'Puedo escuchar lo que hay en tu sesión, diagnosticar problemas de mezcla y controlar tus dispositivos. Vamos a configurar todo.',
    'ob.lets_go': 'Arranquemos',
    'ob.llm_title': 'Primero, necesito un cerebro.',
    'ob.llm_desc': 'Uso un modelo de lenguaje para entender tu sesión y hablar con vos. Podés usar una clave API gratuita, o correr un modelo local sin costo.',
    'ob.api_key': 'Clave API',
    'ob.recommended': 'Recomendado',
    'ob.api_desc': 'OpenAI, Anthropic, DeepSeek y OpenRouter están todos soportados. O corrés un modelo local sin clave.',
    'ob.local_model': 'Modelo local',
    'ob.local_desc': 'Corré Ollama o LM Studio en esta máquina. Sin clave, sin costo, totalmente privado.',
    'ob.checking_local': 'Buscando modelos locales...',
    'ob.local_detected': '{name} detectado — listo para usar',
    'ob.no_local': 'No se encontró ningún modelo local',
    'ob.continue': 'Continuar',
    'ob.set_up_later': 'Configurar después',
    'ob.install_title': 'Instalando Addie en Ableton.',
    'ob.install_desc': 'Necesito copiar un pequeño script en tu carpeta de Remote Scripts de Ableton. Esto es lo que me permite ver y controlar tu sesión.',
    'ob.searching_ableton': 'Buscando instalaciones de Ableton...',
    'ob.install_not_found': 'No se encontró la instalación de Ableton automáticamente.',
    'ob.enable_title': 'Un paso manual en Ableton.',
    'ob.enable_desc': 'Ableton requiere que habilites los Remote Scripts desde Preferencias. Es una configuración única.',
    'ob.enable_waiting': 'Esperando que Addie se conecte a Ableton...',
    'ob.enable_connected': 'Conectado a Ableton.',
    'ob.prefs_title': 'Contame cómo trabajás.',
    'ob.prefs_desc': 'Esto me ayuda a dar mejores consejos desde el día uno. Todo es opcional — podés editarlo cuando quieras en producer.md.',
    'ob.genre': 'Género / estilo',
    'ob.genre_placeholder': 'ej. Hip-hop, Techno, Pop, Jazz...',
    'ob.experience': 'Nivel de experiencia',
    'ob.beginner': 'Principiante',
    'ob.intermediate': 'Intermedio',
    'ob.advanced': 'Avanzado',
    'ob.professional': 'Profesional',
    'ob.monitoring': 'Monitoreo',
    'ob.monitors': 'Monitores de estudio',
    'ob.headphones': 'Auriculares',
    'ob.both': 'Ambos',
    'ob.plugins': 'Plugins / herramientas que usás',
    'ob.plugins_placeholder': 'ej. Serum, Fabfilter, Valhalla...',
    'ob.references': 'Artistas de referencia o sonido objetivo',
    'ob.references_placeholder': 'ej. Metro Boomin, Burial, Charlotte de Witte...',
    'ob.start_producing': 'Empezar a producir',
    'ob.skip': 'Saltar',

    // ── Misc ──
    'misc.save': 'Guardar',
    'misc.cancel': 'Cancelar',
    'misc.ok': 'OK',
    'misc.delete': 'Eliminar',
    'misc.just_now': 'recién',
    'misc.minutes_ago': 'hace {n}m',
    'misc.hours_ago': 'hace {n}h',
    'misc.days_ago': 'hace {n}d',
  },
};

// ── Spanish kickstarts ──
const KICKSTARTS_ES = {
  newProject: [
    { text: 'Voy a grabar voces femeninas cálidas, armemos una cadena de vocal pro', world: 'creative_intent', icon: '🎤' },
    { text: 'Preparame para un beat de hip-hop — necesito drums, bajo y un synth lead', world: 'creative_intent', icon: '🥁' },
    { text: 'Quiero layerear pads analógicos gruesos, armá un track con Diva y efectos', world: 'creative_intent', icon: '🎹' },
    { text: 'Creá un template de mezcla con drum bus, vocal bus y master chain', world: 'creative_intent', icon: '🎚️' },
    { text: 'Armemos returns — reverb, delay, y quizás un chorus send', world: 'creative_intent', icon: '↩️' },
    { text: 'Estoy por grabar guitarra en vivo, ayudame a planear la cadena de procesamiento', world: 'creative_intent', icon: '🎸' },
    { text: 'Poné el tempo en 128 y creá un loop de 8 compases para bocetar ideas', world: 'creative_intent', icon: '⏱️' },
    { text: '¿Qué debería saber sobre gain staging antes de empezar a mezclar?', world: 'educational', icon: '📖' },
  ],
  workInProgress: [
    { text: 'Los graves están embarrados, ¿qué está compitiendo ahí abajo?', world: 'diagnostic', icon: '🔍' },
    { text: 'La mezcla suena plana y sin vida, ¿qué me falta?', world: 'diagnostic', icon: '📉' },
    { text: 'Explicame qué hace cada dispositivo en mi drum bus', world: 'educational', icon: '📖' },
    { text: 'Dame un análisis completo de la mezcla — gain staging, ruteo de buses, todo', world: 'big_picture', icon: '🔭' },
    { text: '¿Qué cambiaría un profesional en mi master chain?', world: 'educational', icon: '🏆' },
    { text: 'Soleá el kick y decime si el transiente se está aplastando', world: 'diagnostic', icon: '👂' },
    { text: 'Las voces suenan ásperas en los medios-altos, ¿podés domarlas?', world: 'sound_design', icon: '✨' },
    { text: 'Agrupá mis tracks de batería y armá un bus de compresión paralela', world: 'surgical', icon: '⚙️' },
  ],
};

// ── STATE ──

let _currentLang = 'en';
try { _currentLang = localStorage.getItem('addie-lang') || 'en'; } catch(e) {}

function _translate(key, params = {}) {
  const dict = TRANSLATIONS[_currentLang] || TRANSLATIONS.en;
  let str = dict[key] || TRANSLATIONS.en[key] || key;
  for (const [k, v] of Object.entries(params)) {
    str = str.replace(`{${k}}`, v);
  }
  return str;
}

function getLanguage() { return _currentLang; }

function setLanguage(lang) {
  if (!TRANSLATIONS[lang]) return;
  _currentLang = lang;
  try { localStorage.setItem('addie-lang', lang); } catch(e) {}
  applyTranslations();
}

/** Re-render all elements with data-i18n attribute */
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = _translate(key);
    } else if (!el.children.length) {
      el.textContent = _translate(key);
    }
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = _translate(el.getAttribute('data-i18n-title'));
  });
}

function getKickstarts() {
  return _currentLang === 'es' ? KICKSTARTS_ES : null; // null = use default JSON
}

// ── EXPORTS ──
window.i18n = { t: _translate, getLanguage, setLanguage, applyTranslations, getKickstarts };
console.log('[addie-debug] i18n.js fully loaded, window.i18n:', !!window.i18n);
