# handlers.py — Live API command implementations
#
# Every function here runs on Live's MAIN THREAD (called from addie.py
# _dispatch, which is called from update_display).
#
# Rules:
#   - Never block (no sleep, no network I/O, no large loops)
#   - Always return a plain dict — JSON-serialisable, no Live objects
#   - Prefer defensive access — Live objects can be None if session is empty
#
# Cross-version compatibility (Live 10 / 11 / 12, Windows / macOS) is handled
# by compat.py. Import shims from there instead of inlining try/except blocks.

from . import logger
from . import compat


# ─── PING ─────────────────────────────────────────────────────────────────────

def handle_ping():
    return {'pong': True}


# ─── TEMPO ────────────────────────────────────────────────────────────────────

def handle_tempo(song):
    if song is None:
        return {'error': 'no song loaded'}
    return {'tempo': song.tempo}


# ─── TRACK COUNT ──────────────────────────────────────────────────────────────

def handle_track_count(song):
    if song is None:
        return {'error': 'no song loaded'}
    count = len(song.tracks) + len(song.return_tracks) + 1
    return {'count': count}

# ─── GET PARAM COUNT ────────────────────────────────────────────────────────────────

def handle_param_count(song, params):
    track = _find_track_by_name(song, params.get('trackName', ''))
    device = _get_device(track, int(params.get('deviceIndex', 0)))
    param_list = list(device.parameters)
    return {
        'count': len(param_list),
        'names': [p.name for p in param_list[:30]],
    }

# ─── TRACK GET ────────────────────────────────────────────────────────────────

def handle_track_get(song, params):
    if song is None:
        return {'error': 'no song loaded'}

    track_index = params.get('trackIndex', 0)
    all_tracks  = _all_tracks(song)

    if track_index < 0 or track_index >= len(all_tracks):
        return {'error': 'track index out of range: {}'.format(track_index)}

    track, track_type = all_tracks[track_index]
    return _serialize_track(track, track_index, track_type)


# ─── SNAPSHOT TIER 1 ─────────────────────────────────────────────────────────
#
# Cheap read — always available, always in context.
# Returns global session state + per-track mixer/routing data only.
# No devices, no parameters. Safe to call on 100+ track sessions.

def handle_snapshot_tier1(song):
    if song is None:
        return {'error': 'no song loaded'}

    tracks_out = []
    for index, (track, track_type) in enumerate(_all_tracks(song)):
        tracks_out.append(_serialize_track_tier1(track, index, track_type))

    return_names = [t.name for t in song.return_tracks]

    # Probe the mixer volume/send scale once — it's the same for all tracks.
    # This gives the LLM the raw→display mapping for set_mixer values.
    mixer_scale = {}
    try:
        # Use master track's mixer as the reference
        master_vol = song.master_track.mixer_device.volume
        lo, hi = master_vol.min, master_vol.max
        q1 = lo + (hi - lo) * 0.25
        mid = lo + (hi - lo) * 0.5
        q3 = lo + (hi - lo) * 0.75
        mixer_scale['volume'] = [
            [round(lo, 6),  master_vol.str_for_value(lo)],
            [round(q1, 6),  master_vol.str_for_value(q1)],
            [round(mid, 6), master_vol.str_for_value(mid)],
            [round(q3, 6),  master_vol.str_for_value(q3)],
            [round(hi, 6),  master_vol.str_for_value(hi)],
        ]
        mixer_scale['volumeRange'] = [lo, hi]
        master_pan = song.master_track.mixer_device.panning
        mixer_scale['panRange'] = [master_pan.min, master_pan.max]
        # Probe send scale from first track that has sends
        for t in song.tracks:
            sends = list(t.mixer_device.sends)
            if sends:
                s = sends[0]
                slo, shi = s.min, s.max
                sq1 = slo + (shi - slo) * 0.25
                smid = slo + (shi - slo) * 0.5
                sq3 = slo + (shi - slo) * 0.75
                mixer_scale['send'] = [
                    [round(slo, 6),  s.str_for_value(slo)],
                    [round(sq1, 6),  s.str_for_value(sq1)],
                    [round(smid, 6), s.str_for_value(smid)],
                    [round(sq3, 6),  s.str_for_value(sq3)],
                    [round(shi, 6),  s.str_for_value(shi)],
                ]
                mixer_scale['sendRange'] = [slo, shi]
                break
    except Exception as e:
        logger.error('Could not probe mixer scale: {}'.format(e))

    return {
        'tempo':        song.tempo,
        'return_names': return_names,
        'tracks':       tracks_out,
        'mixerScale':   mixer_scale,
    }


# ─── SNAPSHOT TIER 2 ─────────────────────────────────────────────────────────
#
# On-demand read — device names + enabled state for specific tracks only.
# No parameter values. Called when the pre-call identifies relevant tracks.
# params: { trackNames: ["Kick", "Bass", ...] }

def handle_snapshot_tier2(song, params):
    if song is None:
        return {'error': 'no song loaded'}

    requested = [n.lower().strip() for n in params.get('trackNames', [])]
    if not requested:
        return {'error': 'trackNames list is required'}

    tracks_out = []
    for index, (track, track_type) in enumerate(_all_tracks(song)):
        if track.name.lower().strip() in requested:
            tracks_out.append(_serialize_track_tier2(track, index, track_type))

    return {'tracks': tracks_out}


# ─── SNAPSHOT (TIER 3 — targeted full param read) ─────────────────────────────
#
# Full parameter read, optionally scoped to specific track names.
# If trackNames provided, only those tracks are serialized.
# params: { trackNames: ["Kick"] }  — or empty for full session dump (legacy)

def handle_snapshot(song, params=None):
    if song is None:
        return {'error': 'no song loaded'}

    requested = None
    if params:
        names = params.get('trackNames', [])
        if names:
            requested = [n.lower().strip() for n in names]

    tracks_out = []
    for index, (track, track_type) in enumerate(_all_tracks(song)):
        if requested is None or track.name.lower().strip() in requested:
            tracks_out.append(_serialize_track(track, index, track_type))

    return {
        'tempo':  song.tempo,
        'tracks': tracks_out,
    }


# ─── PARAM GET ────────────────────────────────────────────────────────────────

def handle_param_get(song, params):
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    device, err = _resolve_device_from_params(track, params)
    if err:
        return err

    param_name = params.get('paramName', '')
    param = _find_param_by_name(device, param_name)
    if param is None:
        available = [p.name for p in device.parameters if p.name != 'Device On']
        return {'error': 'parameter not found: "{}". Available: {}'.format(
            param_name, ', '.join(available))}

    return {'value': param.value, 'display': param.str_for_value(param.value)}


# ─── PARAM SET ────────────────────────────────────────────────────────────────

def handle_param_set(song, params):
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    device, err = _resolve_device_from_params(track, params)
    if err:
        return err

    param_name = params.get('paramName', '')
    value      = params.get('value')

    if value is None:
        return {'error': 'missing value'}

    param = _find_param_by_name(device, param_name)
    if param is None:
        available = [p.name for p in device.parameters if p.name != 'Device On']
        return {'error': 'parameter not found: "{}". Device "{}". Available: {}'.format(
            param_name, device.name, ', '.join(available))}

    value_str = str(value).strip()

    # ═══════════════════════════════════════════════════════════════════════
    # QUANTIZED PARAMS — finite set of choices, always resolvable
    # ═══════════════════════════════════════════════════════════════════════
    if param.is_quantized:
        items = list(param.value_items) if param.value_items else []
        resolved_index = _resolve_quantized(value_str, items, param)

        if resolved_index is None:
            return {'error': (
                'Cannot resolve "{}" for quantized parameter "{}". '
                'Send one of these exact choice names: {}'
            ).format(value_str, param_name,
                     ', '.join('"{}"'.format(item) for item in items))}

        param.value = float(resolved_index)
        return {
            'value':      param.value,
            'display':    param.str_for_value(param.value),
            'resolved':   'Set to choice "{}" (index {})'.format(
                items[resolved_index] if resolved_index < len(items) else '?', resolved_index),
        }

    # ═══════════════════════════════════════════════════════════════════════
    # CONTINUOUS PARAMS — single resolution cascade, no guessing
    #
    # The LLM sends a target display value (e.g. "-20 dB", "350 Hz",
    # "10:1", "40%", "1.5 kHz", or a bare number like "-10").
    # We ALWAYS try display→raw conversion first. If the sent value
    # matches a point in the parameter's display scale, that's the
    # answer. Only if display conversion fails do we treat it as raw.
    # ═══════════════════════════════════════════════════════════════════════

    raw_value = None
    method = None

    # Step 1: Try display→raw (works for ANY format: "-20 dB", "10:1", "350 Hz", "40%", bare "-10")
    raw_from_display, display_result = _display_to_raw(param, value_str)
    if raw_from_display is not None:
        raw_value = raw_from_display
        method = 'display'
        logger.info('param_set resolved via display: "{}" → raw {:.6f} (→ {})'.format(
            value_str, raw_value, display_result))
    else:
        # Step 2: Try as raw numeric — only if display conversion genuinely failed
        try:
            numeric = float(value_str)
            if param.min <= numeric <= param.max:
                raw_value = numeric
                method = 'raw'
            else:
                # Number is outside raw range — could be a display value that
                # _display_to_raw couldn't parse (e.g. edge cases). Clamp it
                # but warn so the retry system can catch it.
                raw_value = max(param.min, min(param.max, numeric))
                method = 'raw_clamped'
                logger.error(
                    'param_set: "{}" on {} is outside raw range {}–{}, clamped to {}. '
                    'Likely a display-unit value sent without units.'
                    .format(value_str, param_name, param.min, param.max, raw_value))
        except (ValueError, TypeError):
            return {'error': (
                'Cannot resolve "{}" for parameter "{}". '
                'Send the value in display units (e.g. "{}") or as a raw number in range {:.4f}–{:.4f}.'
            ).format(value_str, param_name,
                     param.str_for_value((param.min + param.max) / 2),
                     param.min, param.max)}

    param.value = raw_value
    actual_display = param.str_for_value(param.value)

    result = {
        'value':   param.value,
        'display': actual_display,
    }

    if method == 'display':
        result['resolved'] = 'Converted "{}" → raw {:.6f} (display: {})'.format(
            value_str, raw_value, actual_display)
    elif method == 'raw_clamped':
        result['warning'] = (
            'Value {} was clamped to {} (range: {:.4f}–{:.4f}). '
            'Result: {}. If this is wrong, resend with units (e.g. "{}").'
        ).format(value_str, raw_value, param.min, param.max,
                 actual_display, param.str_for_value(param.max))

    return result


def _resolve_quantized(value_str, items, param):
    """Resolve any input to a valid quantized index. Returns int or None.

    Resolution order:
      1. Exact choice name match (case-insensitive)
      2. Substring/prefix match (unique only)
      3. Display string match via str_for_value scan
      4. Integer index
    """
    val_lower = value_str.lower().strip()

    # 1. Exact name match
    for i, item in enumerate(items):
        if item.lower().strip() == val_lower:
            return i

    # 2. Substring/prefix match — only if exactly one item matches
    prefix_matches = [i for i, item in enumerate(items)
                      if item.lower().strip().startswith(val_lower)]
    if len(prefix_matches) == 1:
        return prefix_matches[0]

    contains_matches = [i for i, item in enumerate(items)
                        if val_lower in item.lower().strip()]
    if len(contains_matches) == 1:
        return contains_matches[0]

    # 3. Display string match — scan str_for_value at each index
    #    This catches cases like "10:1" where the display string is "10 : 1"
    target_num = _extract_number(value_str)
    if target_num is not None:
        for i in range(len(items)):
            display_at_i = param.str_for_value(float(i))
            display_num = _extract_number(display_at_i)
            if display_num is not None and abs(display_num - target_num) < 0.01:
                return i

    # 4. Integer index
    try:
        float_val = float(value_str)
        if float_val == int(float_val):
            idx = int(float_val)
            if 0 <= idx < len(items):
                return idx
    except (ValueError, TypeError):
        pass

    return None


# ─── BROWSER LIST ─────────────────────────────────────────────────────────────
#
# Returns all loadable devices/presets from the browser, grouped by category.
#
# Live's browser object exposes these attributes (Live 11):
#
#   DEVICE CATEGORIES (factory + third-party):
#     sounds          — Instrument Racks and instrument presets by sound type
#     drums           — Drum Racks and drum hit presets
#     instruments     — Raw instruments + presets, organised by device
#     audio_effects   — Raw audio effects + presets
#     midi_effects    — Raw MIDI effects + presets
#     plugins         — Third-party VST/AU plug-ins  ← main location for 3rd-party
#
#   PLACES (user content + packs):
#     packs           — Installed Ableton Packs (can contain 3rd-party presets)
#     user_library    — User-saved presets, Racks, samples
#     current_project — Files in the open project folder
#
# We search ALL of these so third-party VSTs (which live under `plugins`),
# user presets wrapping those VSTs (which live under `user_library`), and
# Pack-delivered presets (which live under `packs`) are all found.
#
# `sounds`, `drums`, `current_project` are omitted from listing — they're
# mostly samples and presets we can't usefully load by name, and they bloat
# the response without adding actionable device info.

_BROWSER_CATEGORIES = {
    'instruments':   'instruments',
    'audio_effects': 'audio_effects',
    'midi_effects':  'midi_effects',
    'plugins':       'plugins',
    'packs':         'packs',
    'user_library':  'user_library',
}


def handle_browser_list(app, params):
    if app is None:
        return {'error': 'application not available'}

    browser   = app.browser
    requested = params.get('category', None)

    if requested and requested not in _BROWSER_CATEGORIES:
        return {'error': 'unknown category: {}. Use: {}'.format(
            requested, ', '.join(_BROWSER_CATEGORIES.keys())
        )}

    categories_to_scan = (
        {requested: _BROWSER_CATEGORIES[requested]}
        if requested
        else _BROWSER_CATEGORIES
    )

    result = {}
    for label, attr in categories_to_scan.items():
        root = getattr(browser, attr, None)
        if root is None:
            continue
        names_by_folder = {}
        try:
            root_name = root.name
        except Exception:
            root_name = None
        for folder, name, _item in _walk_browser_root(root, root_name):
            key = folder if folder else '_root'
            names_by_folder.setdefault(key, []).append(name)
        if names_by_folder:
            result[label] = names_by_folder

    return result


def _walk_browser_root(root, _folder=None, _depth=0, _max_depth=5):
    """Canonical browser traversal. Yields (folder_name, item_name, item).

    folder_name preserves up to two levels of hierarchy joined by ' > '
    (e.g. 'VST3 > Waves'), so the LLM sees manufacturer groupings rather
    than a flat list where all plugins share the same 'VST3' bucket.
    """
    if _depth > _max_depth:
        return

    try:
        children = root.children
    except Exception:
        return

    for child in children:
        try:
            name        = child.name
            is_folder   = getattr(child, 'is_folder', False)
            is_loadable = getattr(child, 'is_loadable', False)
        except Exception:
            continue

        if is_folder and is_loadable:
            # Dual-nature node: loadable itself AND contains children.
            yield (_folder, name, child)
            folder_label = name if _folder is None else '{} > {}'.format(_folder, name)
            for item in _walk_browser_root(child, folder_label, _depth + 1, _max_depth):
                yield item
        elif is_folder:
            # Pure folder — recurse, building the breadcrumb path.
            folder_label = name if _folder is None else '{} > {}'.format(_folder, name)
            for item in _walk_browser_root(child, folder_label, _depth + 1, _max_depth):
                yield item
        elif is_loadable:
            # Leaf item — preset, plugin, rack file.
            yield (_folder, name, child)
        else:
            # Navigation-only node (is_folder=False, is_loadable=False).
            # Pass _folder unchanged — don't pollute the breadcrumb with
            # visual-only grouping nodes (e.g. "Dynamics", "EQ & Filters").
            for item in _walk_browser_root(child, _folder, _depth + 1, _max_depth):
                yield item


# ─── BROWSER INSERT ───────────────────────────────────────────────────────────
#
# Searches the browser for a device by name and loads it onto the target track.
#
# Search order:
#   1. plugins       — third-party VST/AU (most likely target for explicit requests)
#   2. instruments   — Ableton built-in instruments
#   3. audio_effects — Ableton built-in audio effects
#   4. midi_effects  — Ableton built-in MIDI effects
#   5. user_library  — user-saved presets and Racks
#   6. packs         — Pack-delivered content
#
# plugins is searched first because if a user says "load Serum" they mean
# the VST, not a factory preset. user_library and packs are searched last
# as fallbacks — they may contain presets wrapping the same devices.

_SEARCH_ROOTS = [
    'plugins',
    'instruments',
    'audio_effects',
    'midi_effects',
    'user_library',
    'packs',
]


def handle_browser_debug(app, params):
    """Dump raw structure of a browser category without any filtering logic.
    Used to diagnose why audio_effects returns empty from _walk_browser_root.
    Returns first 2 levels: root children and their children, with all properties.
    """
    if app is None:
        return {'error': 'application not available'}

    cat = params.get('category', 'audio_effects')
    browser = app.browser
    root = getattr(browser, cat, None)
    if root is None:
        return {'error': 'category not found: {}'.format(cat)}

    def _dump_node(node, depth, max_depth=4):
        try:
            name        = node.name
            is_folder   = getattr(node, 'is_folder', '?')
            is_loadable = getattr(node, 'is_loadable', '?')
        except Exception as e:
            return {'error': str(e)}
        entry = {'name': name, 'is_folder': is_folder, 'is_loadable': is_loadable}
        if depth < max_depth:
            try:
                entry['children'] = [_dump_node(c, depth + 1, max_depth) for c in node.children]
            except Exception as e:
                entry['children_error'] = str(e)
        return entry

    try:
        top_children = [_dump_node(c, 0) for c in root.children]
    except Exception as e:
        return {'error': 'root.children failed: {}'.format(e)}

    return {'category': cat, 'children': top_children}


def handle_browser_insert(app, song, params):
    if app is None or song is None:
        return {'error': 'application or song not available'}

    track_name  = params.get('trackName', '')
    device_name = params.get('deviceName', '')

    if not track_name or not device_name:
        return {'error': 'trackName and deviceName are required'}

    track = _find_track_by_name(song, track_name)
    if track is None:
        return {'error': 'track not found: {}'.format(track_name)}

    try:
        song.view.selected_track = track
    except Exception as e:
        return {'error': 'could not select track: {}'.format(e)}

    browser = app.browser
    item    = _find_browser_item(browser, device_name)

    if item is None:
        return {'error': 'device not found in browser: {}'.format(device_name)}

    try:
        browser.load_item(item)
    except Exception as e:
        return {'error': 'browser.load_item failed: {}'.format(e)}

    logger.info('Inserted "{}" onto track "{}"'.format(device_name, track_name))
    return {'ok': True, 'device': device_name, 'track': track_name}


def _find_browser_item(browser, device_name):
    """Search all browser roots for a loadable item by name.

    Uses _walk_browser_root — the same traversal that builds the browser list
    shown to the LLM — so any name the LLM was given is guaranteed to resolve.

    Match priority across all roots (in _SEARCH_ROOTS order):
      1. Exact match (lowercased)
      2. Starts-with match
      3. Contains match

    plugins is searched first so "Serum" finds the VST before any preset.
    """
    query = device_name.lower().strip()

    exact      = []
    startswith = []
    contains   = []

    for root_attr in _SEARCH_ROOTS:
        root = getattr(browser, root_attr, None)
        if root is None:
            continue
        for _folder, name, item in _walk_browser_root(root):
            name_lower = name.lower()
            if name_lower == query:
                exact.append((root_attr, name, item))
            elif name_lower.startswith(query):
                startswith.append((root_attr, name, item))
            elif query in name_lower:
                contains.append((root_attr, name, item))

    if exact:
        root_attr, name, item = exact[0]
        logger.info('Browser match (exact): "{}" in {} for query "{}"'.format(name, root_attr, query))
        return item
    if startswith:
        root_attr, name, item = startswith[0]
        logger.info('Browser match (startswith): "{}" in {} for query "{}"'.format(name, root_attr, query))
        return item
    if contains:
        root_attr, name, item = contains[0]
        logger.info('Browser match (contains): "{}" in {} for query "{}"'.format(name, root_attr, query))
        return item

    # Nothing found — log the canonical names we actually walked so debugging
    # tells us exactly what was visible, not just the top-level structure.
    logger.error('Browser search FAILED for "{}". Canonical names per category:'.format(query))
    for root_attr in _SEARCH_ROOTS:
        root = getattr(browser, root_attr, None)
        if root is None:
            continue
        names = [name for _f, name, _i in _walk_browser_root(root)]
        if names:
            logger.info('  {}: {}'.format(root_attr, ', '.join(names[:40])))

    return None


# ─── SERIALIZATION ────────────────────────────────────────────────────────────

def _serialize_track(track, index, track_type):
    """
    Convert a Live track object to a plain dict.
    Uses _safe_get() for properties that don't exist on master/return tracks.
    """
    devices = []
    try:
        for d_idx, device in enumerate(track.devices):
            devices.append(_serialize_device(device, d_idx))
    except Exception as e:
        logger.error('Could not read devices on track {}: {}'.format(index, e))

    out = {
        'index':   index,
        'type':    track_type,
        'name':    track.name,
        'muted':   _safe_get(track, 'mute',  False),
        'solo':    _safe_get(track, 'solo',  False),
        'devices': devices,
    }

    try:
        mixer         = track.mixer_device
        out['volume'] = mixer.volume.value
        out['volumeDisplay'] = mixer.volume.str_for_value(mixer.volume.value)
        out['pan']    = mixer.panning.value
        out['panDisplay'] = mixer.panning.str_for_value(mixer.panning.value)
    except Exception:
        out['volume'] = None
        out['volumeDisplay'] = None
        out['pan']    = None
        out['panDisplay'] = None

    out['routingTarget'] = compat.get_routing_display(track)

    return out


def _serialize_track_tier1(track, index, track_type):
    """Tier 1 - mixer state + routing only, no devices."""
    out = {
        'index':  index,
        'type':   track_type,
        'name':   track.name,
        'muted':  _safe_get(track, 'mute', False),
        'solo':   _safe_get(track, 'solo', False),
    }
    try:
        mixer         = track.mixer_device
        out['volume'] = mixer.volume.value
        out['volumeDisplay'] = mixer.volume.str_for_value(mixer.volume.value)
        out['pan']    = mixer.panning.value
        out['panDisplay'] = mixer.panning.str_for_value(mixer.panning.value)
        out['sends']  = [
            {'value': round(s.value, 4), 'display': s.str_for_value(s.value)}
            for s in mixer.sends
        ]
    except Exception:
        out['volume'] = None
        out['volumeDisplay'] = None
        out['pan']    = None
        out['panDisplay'] = None
        out['sends']  = []
    out['routingTarget'] = compat.get_routing_display(track)

    # Output routing options — needed so the LLM knows the exact display names
    # to use in set_routing without guessing. Only read for audio/midi tracks;
    # return and master tracks are routing destinations, not sources.
    if track_type in ('audio', 'midi'):
        try:
            out['outputRoutingTypes'] = [
                t.display_name for t in track.available_output_routing_types
            ]
        except Exception:
            out['outputRoutingTypes'] = []

    return out


def _serialize_track_tier2(track, index, track_type):
    """Tier 2 - device names + enabled state, no parameters.
    Also reports inner devices for Racks so the LLM knows what's inside."""
    devices = []
    try:
        for d_idx, device in enumerate(track.devices):
            entry = {
                'deviceIndex': d_idx,
                'name':        device.name,
                'enabled':     device.is_active,
            }
            # Peek inside Racks to list inner device names
            try:
                if getattr(device, 'can_have_chains', False) and device.chains:
                    entry['isRack'] = True
                    inner = []
                    for chain in device.chains:
                        for inner_dev in chain.devices:
                            inner.append({
                                'name':    inner_dev.name,
                                'enabled': inner_dev.is_active,
                            })
                    entry['innerDevices'] = inner
            except Exception:
                pass
            # Drum Rack pad summary for Tier 2 (lightweight: just note + name)
            try:
                if getattr(device, 'can_have_drum_pads', False) and device.drum_pads:
                    pads = []
                    for pad in device.drum_pads:
                        try:
                            if list(pad.chains) and any(list(c.devices) for c in pad.chains):
                                pads.append({'note': pad.note, 'name': pad.name})
                        except Exception:
                            pass
                    if pads:
                        entry['drumPads'] = pads
            except Exception:
                pass
            devices.append(entry)
    except Exception as e:
        logger.error('Tier2: could not read devices on track {}: {}'.format(index, e))
    return {
        'index':   index,
        'type':    track_type,
        'name':    track.name,
        'devices': devices,
    }


def _serialize_device(device, device_index):
    params = {}
    try:
        for param in device.parameters:
            if param.name == 'Device On':
                continue
            entry = {
                'value':        param.value,
                'min':          param.min,
                'max':          param.max,
                'display':      param.str_for_value(param.value),
                'is_quantized': param.is_quantized,
                'value_items':  list(param.value_items) if param.is_quantized else [],
            }
            # Scale probing: for continuous params, sample str_for_value at
            # key points so the LLM can see the full raw→display mapping.
            if not param.is_quantized:
                try:
                    lo = param.min
                    hi = param.max
                    mid = (lo + hi) / 2.0
                    q1 = lo + (hi - lo) * 0.25
                    q3 = lo + (hi - lo) * 0.75
                    entry['scale'] = [
                        [round(lo, 6),  param.str_for_value(lo)],
                        [round(q1, 6),  param.str_for_value(q1)],
                        [round(mid, 6), param.str_for_value(mid)],
                        [round(q3, 6),  param.str_for_value(q3)],
                        [round(hi, 6),  param.str_for_value(hi)],
                    ]
                except Exception:
                    pass
            params[param.name] = entry
    except Exception as e:
        logger.error('Could not read params for device {}: {}'.format(device.name, e))

    out = {
        'deviceIndex': device_index,
        'name':        device.name,
        'enabled':     device.is_active,
        'parameters':  params,
    }

    # ── Rack traversal ────────────────────────────────────────────────────
    # If this device is a Rack (Instrument Rack, Audio Effect Rack, etc.),
    # walk into its chains and serialize the nested devices. This is how
    # Addie sees through Racks to reach third-party plugins inside.
    out['isRack']    = False
    out['innerDevices'] = []
    try:
        if getattr(device, 'can_have_chains', False) and device.chains:
            out['isRack'] = True
            inner_idx = 0
            for chain in device.chains:
                for inner_device in chain.devices:
                    inner_out = _serialize_device(inner_device, inner_idx)
                    inner_out['chainName'] = chain.name
                    out['innerDevices'].append(inner_out)
                    inner_idx += 1
    except Exception as e:
        logger.error('Could not traverse rack {}: {}'.format(device.name, e))

    # ── Drum Rack pad introspection ───────────────────────────────────
    # If this device is a Drum Rack, read which pads have samples/instruments
    # loaded so the LLM knows the MIDI note → sound mapping.
    # This is essential for composition: "kick on 1 and 3" requires knowing
    # which MIDI note triggers the kick.
    out['drumPads'] = []
    try:
        if getattr(device, 'can_have_drum_pads', False) and device.drum_pads:
            for pad in device.drum_pads:
                # Only include pads that have something loaded (non-empty chains)
                try:
                    chains = list(pad.chains)
                    if not chains:
                        continue
                    # A pad with chains but no devices is also empty
                    has_content = False
                    chain_names = []
                    for c in chains:
                        devs = list(c.devices)
                        if devs:
                            has_content = True
                            chain_names.append(c.name if c.name else devs[0].name)
                    if not has_content:
                        continue
                    out['drumPads'].append({
                        'note':    pad.note,
                        'name':    pad.name,
                        'chains':  chain_names,
                    })
                except Exception:
                    # Some pads may not be accessible; skip silently
                    pass
    except Exception as e:
        logger.error('Could not read drum pads on {}: {}'.format(device.name, e))

    return out


# ─── INTERNAL HELPERS ─────────────────────────────────────────────────────────

def _safe_get(obj, attr, default=None):
    try:
        return getattr(obj, attr, default)
    except Exception:
        return default


def _all_tracks(song):
    result = []
    for t in song.tracks:
        track_type = 'midi' if t.has_midi_input else 'audio'
        result.append((t, track_type))
    for t in song.return_tracks:
        result.append((t, 'return'))
    result.append((song.master_track, 'master'))
    return result


def _find_track_by_name(song, name):
    name_lower = name.lower().strip()
    for (track, _) in _all_tracks(song):
        if track.name.lower().strip() == name_lower:
            return track
    for (track, _) in _all_tracks(song):
        if name_lower in track.name.lower():
            return track
    return None


def _get_device(track, device_index):
    try:
        devices = list(track.devices)
        if 0 <= device_index < len(devices):
            return devices[device_index]
    except Exception:
        pass
    return None


def _find_device_by_name(track, name):
    """Find a device on a track by name (case-insensitive, substring fallback).
    Returns (device, live_index) or (None, -1).
    Raises ValueError if more than one device matches — ambiguous name.
    """
    name_lower = name.lower().strip()
    exact   = []
    partial = []
    try:
        for idx, device in enumerate(track.devices):
            dn = device.name.lower().strip()
            if dn == name_lower:
                exact.append((device, idx))
            elif name_lower in dn:
                partial.append((device, idx))
    except Exception:
        return None, -1

    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise ValueError(
            'Ambiguous device name "{}": {} devices match on track "{}". Rename one.'.format(
                name, len(exact), track.name))
    if len(partial) == 1:
        return partial[0]
    if len(partial) > 1:
        raise ValueError(
            'Ambiguous device name "{}": {} devices match on track "{}". Be more specific.'.format(
                name, len(partial), track.name))
    return None, -1


def _find_inner_device_by_name(track, rack_name, inner_name, chain_name=None):
    """Find an inner device inside a named Rack on a track.
    Returns (inner_device, rack_live_index, inner_live_index) or (None, -1, -1).

    chain_name: optional — if provided, only searches within the chain whose name
    matches (case-insensitive). Required when multiple chains contain devices with
    the same name (e.g. two "Compressor" devices in a parallel processing Rack).
    """
    rack, rack_idx = _find_device_by_name(track, rack_name)
    if rack is None:
        return None, -1, -1
    try:
        if not getattr(rack, 'can_have_chains', False) or not rack.chains:
            return None, rack_idx, -1
        inner_name_lower  = inner_name.lower().strip()
        chain_name_lower  = chain_name.lower().strip() if chain_name else None
        inner_idx = 0
        for chain in rack.chains:
            # If chainName specified, skip non-matching chains but keep counting idx
            if chain_name_lower and chain.name.lower().strip() != chain_name_lower:
                inner_idx += len(list(chain.devices))
                continue
            for dev in chain.devices:
                if dev.name.lower().strip() == inner_name_lower:
                    return dev, rack_idx, inner_idx
                inner_idx += 1
    except Exception:
        pass
    return None, rack_idx, -1


def _get_inner_device(track, device_index, inner_device_index):
    """Get a device nested inside a Rack.
    device_index points to the Rack on the track.
    inner_device_index points to the device within the Rack's
    flattened chain list (chain0.dev0, chain0.dev1, chain1.dev0, ...).
    """
    rack = _get_device(track, device_index)
    if rack is None:
        return None
    try:
        if not getattr(rack, 'can_have_chains', False) or not rack.chains:
            return None
        idx = 0
        for chain in rack.chains:
            for dev in chain.devices:
                if idx == inner_device_index:
                    return dev
                idx += 1
    except Exception:
        pass
    return None


def _extract_number(display_str):
    """Extract the first numeric value from a display string like '-20.0 dB', '350 Hz', '40.0%', '25R'.
    Returns float or None if no number is found.
    Handles: negative signs, decimals, 'inf', 'k' suffix (e.g. '1.5 kHz' → 1500),
    and pan directions ('25R' → 25, '25L' → -25, 'C' → 0)."""
    import re
    if display_str is None:
        return None
    s = display_str.strip()
    if not s:
        return None
    # Handle center pan
    if s == 'C' or s == 'c':
        return 0.0
    # Handle -inf / inf
    if 'inf' in s.lower():
        return float('-inf') if '-' in s else float('inf')
    # Handle pan: "25R" → 25, "25L" → -25, "50R" → 50, etc.
    m = re.match(r'^(\d+(?:\.\d+)?)\s*([RL])$', s, re.IGNORECASE)
    if m:
        val = float(m.group(1))
        return val if m.group(2).upper() == 'R' else -val
    # Look for number with 'k' suffix for kilo
    m = re.search(r'(-?\d+(?:\.\d+)?)\s*k', s, re.IGNORECASE)
    if m:
        return float(m.group(1)) * 1000.0
    m = re.search(r'(-?\d+(?:\.\d+)?)', s)
    if m:
        return float(m.group(1))
    return None


def _display_to_raw(param, target_display):
    """Convert a display-unit value string to the corresponding raw value
    using binary search over param.str_for_value().

    Works for any parameter on any device — native or third-party.
    The only requirement is that the parameter's display values are monotonic
    (either always increasing or always decreasing as raw increases).

    Returns (raw_value, actual_display_string) or (None, error_message)."""

    target_num = _extract_number(target_display)
    if target_num is None:
        return None, 'Could not extract a number from: {}'.format(target_display)

    lo = param.min
    hi = param.max

    # Determine direction: is the display value increasing or decreasing with raw?
    lo_display_num = _extract_number(param.str_for_value(lo))
    hi_display_num = _extract_number(param.str_for_value(hi))

    if lo_display_num is None or hi_display_num is None:
        return None, 'Could not read display values at range boundaries'

    # Handle -inf: if lo maps to -inf, bump lo slightly for the search
    if lo_display_num == float('-inf'):
        lo_display_num = _extract_number(param.str_for_value(lo + (hi - lo) * 0.001))
        if lo_display_num is None:
            return None, 'Could not determine scale near minimum'

    ascending = lo_display_num < hi_display_num

    # Check if target is within the parameter's display range
    if ascending:
        if target_num < lo_display_num or target_num > hi_display_num:
            return None, 'Target {} is outside display range {}–{}'.format(
                target_display, param.str_for_value(lo), param.str_for_value(hi))
    else:
        if target_num > lo_display_num or target_num < hi_display_num:
            return None, 'Target {} is outside display range {}–{}'.format(
                target_display, param.str_for_value(lo), param.str_for_value(hi))

    # Binary search: 30 iterations gives precision of (hi-lo)/2^30
    best_raw = lo
    best_diff = float('inf')
    for _ in range(30):
        mid = (lo + hi) / 2.0
        mid_display = param.str_for_value(mid)
        mid_num = _extract_number(mid_display)
        if mid_num is None:
            break

        diff = abs(mid_num - target_num)
        if diff < best_diff:
            best_diff = diff
            best_raw = mid

        # Close enough — the display string would round to the same value
        if diff < 0.05:
            break

        if ascending:
            if mid_num < target_num:
                lo = mid
            else:
                hi = mid
        else:
            if mid_num > target_num:
                lo = mid
            else:
                hi = mid

    actual_display = param.str_for_value(best_raw)
    return best_raw, actual_display


def _resolve_mixer_value(param, value):
    """Resolve a mixer value that could be either a raw number or a display string.
    Returns (raw_value, conversion_note_or_None) or (None, error_message)."""
    import re
    value_str = str(value).strip()
    is_display = bool(re.search(r'[a-zA-Z%]', value_str))

    if is_display:
        raw_val, actual_display = _display_to_raw(param, value_str)
        if raw_val is None:
            return None, 'Could not convert "{}": {}'.format(value_str, actual_display)
        logger.info('set_mixer display→raw: {} → {:.6f} (→ {})'.format(value_str, raw_val, actual_display))
        return raw_val, 'Converted "{}" → raw {:.4f} (display: {})'.format(value_str, raw_val, actual_display)
    else:
        try:
            raw_val = float(value)
        except (ValueError, TypeError):
            return None, 'Invalid value: {}'.format(value)
        clamped = max(param.min, min(param.max, raw_val))
        if abs(raw_val - clamped) > 0.0001:
            logger.error('set_mixer CLAMPED: sent {} but range is {}–{}, clamped to {}'.format(
                raw_val, param.min, param.max, clamped))
        return clamped, None


def _display_to_raw_mixer(mixer_param, target_display):
    """Same as _display_to_raw but for mixer parameters (volume, sends).
    These are DeviceParameter objects too, so the same approach works."""
    return _display_to_raw(mixer_param, target_display)


def _resolve_device_from_params(track, params):
    """Shared device resolution for param_get and param_set.
    Accepts name-based params:
      deviceName                          — outer device on the track
      deviceName + innerDeviceName        — inner device inside a named Rack
      deviceName + innerDeviceName + chainName — disambiguate when multiple chains
                                            contain a device with the same name
    Returns (device, None) on success or (None, error_dict) on failure.
    """
    device_name = params.get('deviceName', '')
    inner_name  = params.get('innerDeviceName')
    chain_name  = params.get('chainName')

    if not device_name:
        return None, {'error': 'deviceName is required'}

    if inner_name:
        device, rack_idx, inner_idx = _find_inner_device_by_name(
            track, device_name, inner_name, chain_name=chain_name)
        if device is None:
            if rack_idx == -1:
                available = [d.name for d in track.devices]
                return None, {'error': 'rack not found: "{}". Devices on track: {}'.format(
                    device_name, ', '.join(available))}
            # Rack found but inner not found — include chain info in error
            rack = _get_device(track, rack_idx)
            inner_names = []
            try:
                for chain in rack.chains:
                    for dev in chain.devices:
                        inner_names.append('"{}"/chain:"{}"'.format(dev.name, chain.name))
            except Exception:
                pass
            hint = ' (chainName: "{}" filtered search)'.format(chain_name) if chain_name else ''
            return None, {'error': 'inner device not found: "{}"{} in rack "{}". Available: {}'.format(
                inner_name, hint, device_name, ', '.join(inner_names))}
        return device, None
    else:
        try:
            device, _ = _find_device_by_name(track, device_name)
        except ValueError as e:
            return None, {'error': str(e)}
        if device is None:
            available = [d.name for d in track.devices]
            return None, {'error': 'device not found: "{}". Devices on track: {}'.format(
                device_name, ', '.join(available))}
        return device, None


def _find_param_by_name(device, name):
    name_lower = name.lower().strip()
    try:
        for param in device.parameters:
            if param.name.lower().strip() == name_lower:
                return param
    except Exception:
        pass
    return None



# ─── GET CLIPS ────────────────────────────────────────────────────────────────
#
# Returns clip slot info for specified tracks in Session View.
# Gives Addie its first view of the timeline — which slots have clips,
# their lengths, loop settings, and whether they're currently playing.
#
# params: { trackNames: ["Pad", "Lead"] }
#   — or omit trackNames to get clips for ALL tracks (use sparingly)

def handle_get_clips(song, params):
    if song is None:
        return {'error': 'no song loaded'}

    requested = None
    if params:
        names = params.get('trackNames', [])
        if names:
            requested = [n.lower().strip() for n in names]

    scene_count = len(song.scenes)
    tracks_out  = []

    for index, (track, track_type) in enumerate(_all_tracks(song)):
        # Master and return tracks don't have clip slots
        if track_type in ('master', 'return'):
            continue
        if requested is not None and track.name.lower().strip() not in requested:
            continue

        slots = []
        try:
            for slot_idx, cs in enumerate(track.clip_slots):
                if slot_idx >= scene_count:
                    break
                slot_info = {
                    'slotIndex':  slot_idx,
                    'hasClip':    cs.has_clip,
                }
                if cs.has_clip:
                    clip = cs.clip
                    slot_info['clipName']      = clip.name
                    slot_info['length']        = clip.length
                    slot_info['looping']       = clip.looping
                    slot_info['loopStart']     = clip.loop_start
                    slot_info['loopEnd']       = clip.loop_end
                    slot_info['isPlaying']     = clip.is_playing
                    slot_info['isTriggered']   = clip.is_triggered
                    slot_info['hasEnvelopes']  = clip.has_envelopes
                slots.append(slot_info)
        except Exception as e:
            logger.error('Could not read clip slots on track {}: {}'.format(
                track.name, e))

        tracks_out.append({
            'index':     index,
            'type':      track_type,
            'name':      track.name,
            'clipSlots': slots,
        })

    return {
        'tempo':      song.tempo,
        'sceneCount': scene_count,
        'isPlaying':  song.is_playing,
        'tracks':     tracks_out,
    }


# ─── RESOLVE PARAMETER ────────────────────────────────────────────────────────
#
# Shared helper: resolve a parameter from the various addressing modes
# used by automation commands. Supports device params, inner device params
# (inside Racks), and mixer params (volume, pan, sends).
#
# Returns (param, error_dict). If param is None, error_dict has the reason.

def _resolve_parameter(song, params):
    """Resolve a DeviceParameter object from the params dict.

    Addressing modes (checked in order):
      1. mixerParam   — 'volume', 'pan', 'send_A', 'send_B', etc.
      2. deviceName + innerDeviceName — parameter inside a named Rack
      3. deviceName + paramName — standard device parameter
    """
    track_name = params.get('trackName', '')
    track = _find_track_by_name(song, track_name)
    if track is None:
        return None, {'error': 'track not found: {}'.format(track_name)}

    # ── Mixer parameters ──────────────────────────────────────────────────
    mixer_param = params.get('mixerParam')
    if mixer_param:
        try:
            mixer = track.mixer_device
            mp = mixer_param.lower().strip()
            if mp == 'volume':
                return mixer.volume, None
            elif mp == 'pan':
                return mixer.panning, None
            elif mp.startswith('send_'):
                letter = mp.split('_', 1)[1].upper()
                send_idx = ord(letter) - ord('A')
                sends = list(mixer.sends)
                if 0 <= send_idx < len(sends):
                    return sends[send_idx], None
                return None, {'error': 'send index out of range: {} (track has {} sends)'.format(
                    letter, len(sends))}
            else:
                return None, {'error': 'unknown mixer param: {}. Use volume, pan, or send_A/B/C/...'.format(mixer_param)}
        except Exception as e:
            return None, {'error': 'could not access mixer: {}'.format(e)}

    # ── Device parameters ─────────────────────────────────────────────────
    device_name_req = params.get('deviceName', '')
    inner_name_req  = params.get('innerDeviceName')
    param_name      = params.get('paramName', '')

    if not device_name_req:
        return None, {'error': 'deviceName is required for automation'}

    device, err = _resolve_device_from_params(track, params)
    if err:
        return None, err

    param = _find_param_by_name(device, param_name)
    if param is None:
        available = [p.name for p in device.parameters if p.name != 'Device On']
        return None, {'error': 'parameter not found: "{}". Device "{}". Available: {}'.format(
            param_name, device.name, ', '.join(available))}

    return param, None


# ─── FIND CLIP ────────────────────────────────────────────────────────────────
#
# Shared helper: find a Session View clip on a track.
# Supports slotIndex (int) or 'playing' to target the currently playing clip.

def _find_clip(song, track, slot_ref):
    """Find a clip on the given track.

    slot_ref must be an explicit slot index (int or numeric string).
    Always pass the slotIndex from the CLIP LAYOUT — never omit it.
    Returns (clip, error_dict). If clip is None, error_dict has the reason.
    """
    # Explicit slot index — the only valid input
    try:
        slot_idx = int(slot_ref)
    except (ValueError, TypeError):
        return None, {'error': 'slotIndex must be a number (e.g. 0, 1, 2). Got: "{}". Check CLIP LAYOUT for the correct slot.'.format(slot_ref)}

    try:
        slots = list(track.clip_slots)
        if slot_idx < 0 or slot_idx >= len(slots):
            return None, {'error': 'slot index {} out of range (track has {} slots)'.format(
                slot_idx, len(slots))}
        cs = slots[slot_idx]
        if not cs.has_clip:
            return None, {'error': 'slot {} on track "{}" is empty — no clip to write automation to'.format(
                slot_idx, track.name)}
        return cs.clip, None
    except Exception as e:
        return None, {'error': 'could not access clip slot: {}'.format(e)}


# ─── CREATE AUTOMATION ────────────────────────────────────────────────────────
#
# Writes automation breakpoints to a Session View clip's envelope.
# This is the core handler that gives Addie the ability to create
# parameter automation that evolves over time.
#
# params: {
#   trackName:        "Pad",
#   slotIndex:        2  |  "playing",
#   breakpoints:      [[time, value, duration], ...],
#   clearExisting:    true/false  (default false),
#
#   // Parameter addressing — one of these modes:
#   mixerParam:       "volume" | "pan" | "send_A"
#   // — or —
#   deviceIndex:      0,
#   paramName:        "Threshold",
#   // — or (for Rack-nested devices) —
#   deviceIndex:      0,
#   innerDeviceIndex: 0,
#   paramName:        "Frequency",
# }
#
# IMPORTANT: automation_envelope() only works on Session View clips.
# It returns None for Arrangement clips. The handler checks this and
# returns a clear error rather than a cryptic traceback.

def handle_create_automation(song, params):
    if song is None:
        return {'error': 'no song loaded'}

    track_name = params.get('trackName', '')
    track = _find_track_by_name(song, track_name)
    if track is None:
        return {'error': 'track not found: {}'.format(track_name)}

    # ── Resolve the clip ──────────────────────────────────────────────────
    slot_ref = params.get('slotIndex')
    if slot_ref is None:
        return {'error': 'slotIndex is required'}
    clip, err = _find_clip(song, track, slot_ref)
    if clip is None:
        return err

    # ── Resolve the parameter ─────────────────────────────────────────────
    param, err = _resolve_parameter(song, params)
    if param is None:
        return err

    # ── Get or create the automation envelope ────────────────────────────
    try:
        envelope = clip.automation_envelope(param)
        if envelope is None:
            envelope = clip.create_automation_envelope(param)
    except Exception as e:
        return {'error': 'could not get automation envelope: {}'.format(e)}

    if envelope is None:
        return {'error': (
            'Could not create automation envelope for "{}". '
            'This parameter may not be automatable, or the clip is in Arrangement View. '
            'Make sure the clip is in Session View.'
        ).format(params.get('paramName') or params.get('mixerParam', '?'))}

    # ── Clear existing envelope if requested ──────────────────────────────
    clear_existing = params.get('clearExisting', False)
    if clear_existing:
        try:
            clip.clear_envelope(param)
            # Re-acquire envelope after clearing
            envelope = clip.automation_envelope(param)
            if envelope is None:
                return {'error': 'envelope lost after clear — unexpected Live behavior'}
        except Exception as e:
            return {'error': 'could not clear envelope: {}'.format(e)}

    # ── Write breakpoints ─────────────────────────────────────────────────
    breakpoints = params.get('breakpoints', [])
    if not breakpoints:
        return {'error': 'breakpoints array is empty'}

    written = 0
    p_min   = param.min
    p_max   = param.max

    for bp in breakpoints:
        if len(bp) < 3:
            logger.error('Skipping malformed breakpoint (need [time, value, duration]): {}'.format(bp))
            continue
        time_beats = float(bp[0])
        value      = float(bp[1])
        duration   = float(bp[2])

        # Clamp value to parameter range
        clamped = max(p_min, min(p_max, value))

        try:
            envelope.insert_step(time_beats, clamped, duration)
            written += 1
        except Exception as e:
            logger.error('insert_step failed at time={}: {}'.format(time_beats, e))

    logger.info('Wrote {} automation breakpoints for "{}" on track "{}"'.format(
        written, params.get('paramName') or params.get('mixerParam', '?'), track_name))

    return {
        'ok':      True,
        'written': written,
        'total':   len(breakpoints),
        'track':   track_name,
        'param':   params.get('paramName') or params.get('mixerParam', ''),
    }


# ─── READ AUTOMATION ──────────────────────────────────────────────────────────
#
# Samples an automation envelope at evenly-spaced points using value_at_time().
# Used for verification after writing, and for the LLM to describe existing
# automation curves.
#
# params: {
#   trackName:        "Pad",
#   slotIndex:        2  |  "playing",
#   samplePoints:     8,            (default: 8)
#
#   // Parameter addressing — same modes as create_automation
#   mixerParam | deviceIndex+paramName | deviceIndex+innerDeviceIndex+paramName
# }

def handle_read_automation(song, params):
    if song is None:
        return {'error': 'no song loaded'}

    track_name = params.get('trackName', '')
    track = _find_track_by_name(song, track_name)
    if track is None:
        return {'error': 'track not found: {}'.format(track_name)}

    # ── Resolve clip ──────────────────────────────────────────────────────
    slot_ref = params.get('slotIndex')
    if slot_ref is None:
        return {'error': 'slotIndex is required'}
    clip, err = _find_clip(song, track, slot_ref)
    if clip is None:
        return err

    # ── Resolve parameter ─────────────────────────────────────────────────
    param, err = _resolve_parameter(song, params)
    if param is None:
        return err

    # ── Get envelope ──────────────────────────────────────────────────────
    try:
        envelope = clip.automation_envelope(param)
    except Exception as e:
        return {'error': 'could not get automation envelope: {}'.format(e)}

    if envelope is None:
        return {'error': 'no automation envelope found for "{}". Nothing written yet on this parameter.'.format(
            params.get('paramName') or params.get('mixerParam', '?'))}

    # ── Sample the envelope ───────────────────────────────────────────────
    sample_count = int(params.get('samplePoints', 8))
    clip_length  = clip.length

    if clip_length <= 0:
        return {'error': 'clip has zero length'}

    samples = []
    step = clip_length / max(sample_count, 1)
    for i in range(sample_count):
        t = i * step
        try:
            val = envelope.value_at_time(t)
            samples.append([round(t, 4), round(val, 6)])
        except Exception as e:
            logger.error('value_at_time({}) failed: {}'.format(t, e))
            samples.append([round(t, 4), None])

    return {
        'ok':         True,
        'track':      track_name,
        'param':      params.get('paramName') or params.get('mixerParam', ''),
        'clipLength': clip_length,
        'samples':    samples,
        'paramMin':   param.min,
        'paramMax':   param.max,
        'display':    param.str_for_value(param.value),
    }


# ─── CLEAR AUTOMATION ─────────────────────────────────────────────────────────
#
# Clears automation for a specific parameter on a clip, or clears all
# envelopes on the clip.
#
# params: {
#   trackName:   "Pad",
#   slotIndex:   2 | "playing",
#   clearAll:    true/false  (default false — clear only the specified param)
#
#   // If clearAll is false, parameter addressing is required:
#   mixerParam | deviceIndex+paramName | deviceIndex+innerDeviceIndex+paramName
# }

def handle_clear_automation(song, params):
    if song is None:
        return {'error': 'no song loaded'}

    track_name = params.get('trackName', '')
    track = _find_track_by_name(song, track_name)
    if track is None:
        return {'error': 'track not found: {}'.format(track_name)}

    slot_ref = params.get('slotIndex')
    if slot_ref is None:
        return {'error': 'slotIndex is required'}
    clip, err = _find_clip(song, track, slot_ref)
    if clip is None:
        return err

    clear_all = params.get('clearAll', False)

    if clear_all:
        try:
            clip.clear_all_envelopes()
            logger.info('Cleared all automation on clip in track "{}"'.format(track_name))
            return {'ok': True, 'cleared': 'all', 'track': track_name}
        except Exception as e:
            return {'error': 'clear_all_envelopes failed: {}'.format(e)}

    # Clear a specific parameter's envelope
    param, err = _resolve_parameter(song, params)
    if param is None:
        return err

    try:
        clip.clear_envelope(param)
        logger.info('Cleared automation for "{}" on track "{}"'.format(
            params.get('paramName') or params.get('mixerParam', '?'), track_name))
        return {
            'ok':      True,
            'cleared': params.get('paramName') or params.get('mixerParam', ''),
            'track':   track_name,
        }
    except Exception as e:
        return {'error': 'clear_envelope failed: {}'.format(e)}


# ═══════════════════════════════════════════════════════════════════════════════
# NEW LOM HANDLERS — Full session control
# ═══════════════════════════════════════════════════════════════════════════════


# ─── TRACK MANAGEMENT ─────────────────────────────────────────────────────────

def handle_create_track(song, params):
    """Create an audio or MIDI track.
    params: { type: 'audio'|'midi', index: -1 (append), name: 'optional' }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track_type = params.get('type', 'audio').lower()
    index = int(params.get('index', -1))

    # Snapshot count before creation so we can locate the new track by delta.
    count_before = len(song.tracks)

    try:
        if track_type == 'midi':
            idx = song.create_midi_track(index)
        else:
            idx = song.create_audio_track(index)
    except Exception as e:
        return {'error': 'create_track failed: {}'.format(e)}

    # Live 11 returns an int index from create_midi_track/create_audio_track.
    # Live 12 returns the Track object directly.
    # Both cases are handled below: if we got a Track object we use it directly;
    # if we got an int we locate the track by its position in song.tracks.
    # See compat.py and DOCS.md §18 for the full version compatibility matrix.
    if hasattr(idx, 'name'):
        # Live 12: idx IS the track object
        track_obj = idx
        track_idx = None
    else:
        # Live 11: idx is an int — locate the track by position
        track_obj = None
        track_idx = idx
        try:
            count_after = len(song.tracks)
            if count_after > count_before:
                if track_idx is None or not (0 <= track_idx < count_after):
                    track_obj = song.tracks[count_after - 1]
                else:
                    track_obj = song.tracks[track_idx]
        except Exception as e:
            logger.error('create_track: could not resolve track by index: {}'.format(e))

    # Name the track if requested
    name = params.get('name')
    if name and track_obj is not None:
        try:
            track_obj.name = str(name)
        except Exception as e:
            logger.error('create_track: rename failed: {}'.format(e))

    if track_obj is not None:
        return {
            'ok':   True,
            'name': track_obj.name,
            'type': track_type,
        }
    return {'ok': True, 'type': track_type}


def handle_delete_track(song, params):
    """Delete a track by name or index.
    params: { trackName: 'Kick' } or { trackIndex: 3 }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track_name = params.get('trackName')
    track_index = params.get('trackIndex')

    if track_name:
        # Find the index in song.tracks (not _all_tracks which includes returns/master)
        target_idx = None
        for i, t in enumerate(song.tracks):
            if t.name.lower().strip() == track_name.lower().strip():
                target_idx = i
                break
        if target_idx is None:
            return {'error': 'track not found: {}'.format(track_name)}
    elif track_index is not None:
        target_idx = int(track_index)
    else:
        return {'error': 'trackName or trackIndex required'}

    try:
        song.delete_track(target_idx)
        return {'ok': True, 'deleted': track_name or target_idx}
    except Exception as e:
        return {'error': 'delete_track failed: {}'.format(e)}


def handle_rename_track(song, params):
    """Rename a track.
    params: { trackName: 'old name', newName: 'new name' }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    new_name = params.get('newName', '')
    if not new_name:
        return {'error': 'newName required'}

    try:
        track.name = str(new_name)
        return {'ok': True, 'name': track.name}
    except Exception as e:
        return {'error': 'rename failed: {}'.format(e)}


def handle_duplicate_track(song, params):
    """Duplicate a track.
    params: { trackName: 'Kick' }
    """
    if song is None:
        return {'error': 'no song loaded'}

    # Find index in song.tracks
    track_name = params.get('trackName', '')
    target_idx = None
    for i, t in enumerate(song.tracks):
        if t.name.lower().strip() == track_name.lower().strip():
            target_idx = i
            break
    if target_idx is None:
        return {'error': 'track not found: {}'.format(track_name)}

    try:
        song.duplicate_track(target_idx)
        return {'ok': True, 'duplicated': track_name}
    except Exception as e:
        return {'error': 'duplicate_track failed: {}'.format(e)}


def handle_set_track_color(song, params):
    """Set a track's color.
    params: { trackName: 'Kick', colorIndex: 12 }
    Ableton color indices: 0-69 in Live 11+.
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    color_index = params.get('colorIndex')
    if color_index is None:
        return {'error': 'colorIndex required'}

    try:
        track.color_index = int(color_index)
        return {'ok': True, 'colorIndex': track.color_index}
    except Exception as e:
        return {'error': 'set color failed: {}'.format(e)}


# ─── MIXER ────────────────────────────────────────────────────────────────────

def handle_set_mixer(song, params):
    """Set mixer parameters: volume, pan, sends.
    Values can be raw numbers OR display-unit strings (e.g. "-6 dB", "25R", "-20 dB").
    params: {
        trackName: 'Kick',
        volume: "-6 dB" or 0.71,  (optional)
        pan: "25R" or 0.5,         (optional)
        sends: { 'A': "-20 dB" or 0.38, 'B': 0.3 }  (optional)
    }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    try:
        mixer = track.mixer_device
    except Exception as e:
        return {'error': 'could not access mixer: {}'.format(e)}

    result = {'ok': True, 'track': track.name}

    # Volume
    vol = params.get('volume')
    if vol is not None:
        try:
            p = mixer.volume
            raw_val, note = _resolve_mixer_value(p, vol)
            if raw_val is None:
                result['volumeError'] = note
            else:
                p.value = raw_val
                result['volume'] = p.value
                result['volumeDisplay'] = p.str_for_value(p.value)
                if note:
                    result.setdefault('conversions', []).append(note)
        except Exception as e:
            result['volumeError'] = str(e)

    # Pan — pan uses real units (-1 to 1) so display conversion is less critical,
    # but we still support display strings like "25R", "10L", "C"
    pan = params.get('pan')
    if pan is not None:
        try:
            p = mixer.panning
            raw_val, note = _resolve_mixer_value(p, pan)
            if raw_val is None:
                result['panError'] = note
            else:
                p.value = raw_val
                result['pan'] = p.value
                result['panDisplay'] = p.str_for_value(p.value)
                if note:
                    result.setdefault('conversions', []).append(note)
        except Exception as e:
            result['panError'] = str(e)

    # Sends
    sends = params.get('sends')
    if sends and isinstance(sends, dict):
        try:
            send_list = list(mixer.sends)
            for letter, val in sends.items():
                idx = ord(letter.upper()) - ord('A')
                if 0 <= idx < len(send_list):
                    p = send_list[idx]
                    raw_val, note = _resolve_mixer_value(p, val)
                    if raw_val is None:
                        result.setdefault('sendErrors', {})[letter] = note
                    else:
                        p.value = raw_val
                        result.setdefault('sends', {})[letter.upper()] = p.value
                        result.setdefault('sendDisplays', {})[letter.upper()] = p.str_for_value(p.value)
                        if note:
                            result.setdefault('conversions', []).append(note)
                else:
                    result.setdefault('sendErrors', {})[letter] = 'index out of range'
        except Exception as e:
            result['sendError'] = str(e)

    return result


def handle_set_mute(song, params):
    """Mute or unmute a track.
    params: { trackName: 'Kick', mute: true/false }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    mute_val = params.get('mute', True)
    try:
        track.mute = bool(mute_val)
        return {'ok': True, 'track': track.name, 'muted': track.mute}
    except Exception as e:
        return {'error': 'set mute failed: {}'.format(e)}


def handle_set_solo(song, params):
    """Solo or unsolo a track.
    params: { trackName: 'Kick', solo: true/false }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    solo_val = params.get('solo', True)
    try:
        track.solo = bool(solo_val)
        return {'ok': True, 'track': track.name, 'solo': track.solo}
    except Exception as e:
        return {'error': 'set solo failed: {}'.format(e)}


def handle_arm_track(song, params):
    """Arm or disarm a track for recording.
    params: { trackName: 'Vocals', arm: true/false }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    arm_val = params.get('arm', True)
    try:
        track.arm = bool(arm_val)
        return {'ok': True, 'track': track.name, 'armed': track.arm}
    except Exception as e:
        return {'error': 'arm failed: {}'.format(e)}


def handle_set_crossfade(song, params):
    """Set crossfade assignment for a track.
    params: { trackName: 'Kick', assign: 'A'|'B'|'NONE' }
    Values: 0=NONE, 1=A, 2=B
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    assign = params.get('assign', 'NONE').upper()
    mapping = {'NONE': 0, 'A': 1, 'B': 2}
    val = mapping.get(assign)
    if val is None:
        return {'error': 'assign must be A, B, or NONE'}

    try:
        track.mixer_device.crossfade_assign = val
        return {'ok': True, 'track': track.name, 'crossfade': assign}
    except Exception as e:
        return {'error': 'set crossfade failed: {}'.format(e)}


# ─── ROUTING ──────────────────────────────────────────────────────────────────

def handle_get_routing_options(song, params):
    """Get available routing types and channels for a track.
    params: { trackName: 'Bass' }
    Returns input and output routing options so the LLM knows what's available.
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    result = {'ok': True, 'track': track.name}

    try:
        # Output routing
        out_types = list(track.available_output_routing_types)
        result['outputTypes'] = [{'display': t.display_name} for t in out_types]
        result['currentOutput'] = track.output_routing_type.display_name
    except Exception as e:
        result['outputError'] = str(e)

    try:
        # Output channels
        out_channels = list(track.available_output_routing_channels)
        result['outputChannels'] = [{'display': c.display_name} for c in out_channels]
        result['currentOutputChannel'] = track.output_routing_channel.display_name
    except Exception as e:
        result['outputChannelError'] = str(e)

    try:
        # Input routing
        in_types = list(track.available_input_routing_types)
        result['inputTypes'] = [{'display': t.display_name} for t in in_types]
        result['currentInput'] = track.input_routing_type.display_name
    except Exception as e:
        result['inputError'] = str(e)

    try:
        # Input channels
        in_channels = list(track.available_input_routing_channels)
        result['inputChannels'] = [{'display': c.display_name} for c in in_channels]
        result['currentInputChannel'] = track.input_routing_channel.display_name
    except Exception as e:
        result['inputChannelError'] = str(e)

    return result


def handle_set_routing(song, params):
    """Set input or output routing for a track.
    params: {
        trackName: 'Bass',
        outputType: 'Sends Only',        (optional — display name from get_routing_options)
        outputChannel: 'Post Mixer',     (optional)
        inputType: 'Ext. In',            (optional)
        inputChannel: '1/2',             (optional)
    }
    Matches by display_name against available_*_routing_types/channels.
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    result = {'ok': True, 'track': track.name}
    any_error = False  # track if any requested routing failed to resolve

    # Output type
    out_type = params.get('outputType')
    if out_type:
        try:
            available = list(track.available_output_routing_types)
            match = _match_routing(available, out_type)
            if match:
                track.output_routing_type = match
                result['outputType'] = match.display_name
            else:
                names = [t.display_name for t in available]
                result['outputTypeError'] = 'not found: "{}". Available: {}'.format(out_type, names)
                any_error = True
        except Exception as e:
            result['outputTypeError'] = str(e)
            any_error = True

    # Output channel
    out_channel = params.get('outputChannel')
    if out_channel:
        try:
            available = list(track.available_output_routing_channels)
            match = _match_routing(available, out_channel)
            if match:
                track.output_routing_channel = match
                result['outputChannel'] = match.display_name
            else:
                names = [c.display_name for c in available]
                result['outputChannelError'] = 'not found: "{}". Available: {}'.format(out_channel, names)
                any_error = True
        except Exception as e:
            result['outputChannelError'] = str(e)
            any_error = True

    # Input type
    in_type = params.get('inputType')
    if in_type:
        try:
            available = list(track.available_input_routing_types)
            match = _match_routing(available, in_type)
            if match:
                track.input_routing_type = match
                result['inputType'] = match.display_name
            else:
                names = [t.display_name for t in available]
                result['inputTypeError'] = 'not found: "{}". Available: {}'.format(in_type, names)
                any_error = True
        except Exception as e:
            result['inputTypeError'] = str(e)
            any_error = True

    # Input channel
    in_channel = params.get('inputChannel')
    if in_channel:
        try:
            available = list(track.available_input_routing_channels)
            match = _match_routing(available, in_channel)
            if match:
                track.input_routing_channel = match
                result['inputChannel'] = match.display_name
            else:
                names = [c.display_name for c in available]
                result['inputChannelError'] = 'not found: "{}". Available: {}'.format(in_channel, names)
                any_error = True
        except Exception as e:
            result['inputChannelError'] = str(e)
            any_error = True

    # If any routing value failed to resolve, surface it as a top-level error
    # so executeSingleAction treats it as a failure and the retry system kicks in.
    if any_error:
        errors = [v for k, v in result.items() if k.endswith('Error')]
        result['error'] = ' | '.join(errors)
        result['ok'] = False

    return result


def _match_routing(available_items, display_name):
    """Match a routing type/channel by display_name. Case-insensitive, exact first, then contains."""
    query = display_name.lower().strip()
    # Exact match
    for item in available_items:
        if item.display_name.lower().strip() == query:
            return item
    # Contains match
    for item in available_items:
        if query in item.display_name.lower():
            return item
    return None


# ─── DEVICE MANAGEMENT ────────────────────────────────────────────────────────

def handle_delete_device(song, params):
    """Delete a device from a track's device chain by name.
    params: { trackName: 'Kick', deviceName: 'Pro-Q 3' }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    device_name_req = params.get('deviceName', '')
    if not device_name_req:
        return {'error': 'deviceName is required'}

    try:
        device, device_index = _find_device_by_name(track, device_name_req)
    except ValueError as e:
        return {'error': str(e)}

    if device is None:
        available = [d.name for d in track.devices]
        return {'error': 'device not found: "{}". Devices on track: {}'.format(
            device_name_req, ', '.join(available))}

    confirmed_name = device.name
    try:
        track.delete_device(device_index)
        return {'ok': True, 'deleted': confirmed_name, 'track': track.name}
    except Exception as e:
        return {'error': 'delete_device failed: {}'.format(e)}


def handle_move_device(song, params):
    """Move a device to a new position in the chain.
    params: { trackName: 'Kick', deviceName: 'Compressor', newIndex: 2 }
    Source device resolved by name; destination is a numeric position.
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    device_name_req = params.get('deviceName', '')
    if not device_name_req:
        return {'error': 'deviceName is required'}

    try:
        device, device_index = _find_device_by_name(track, device_name_req)
    except ValueError as e:
        return {'error': str(e)}

    if device is None:
        available = [d.name for d in track.devices]
        return {'error': 'device not found: "{}". Devices on track: {}'.format(
            device_name_req, ', '.join(available))}

    new_index = int(params.get('newIndex', 0))
    confirmed_name = device.name
    try:
        track.move_device(device, new_index)
        return {'ok': True, 'moved': confirmed_name, 'from': device_index, 'to': new_index}
    except Exception as e:
        return {'error': 'move_device failed: {}'.format(e)}


def handle_enable_device(song, params):
    """Enable or bypass a device by name.
    params: { trackName: 'Kick', deviceName: 'Compressor', enabled: true/false }
    For inner devices: { trackName: 'Lead', deviceName: 'Instrument Rack', innerDeviceName: 'Diva', enabled: false }
    For inner devices in multi-chain Racks: add chainName: 'High' to disambiguate.
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    device_name_req = params.get('deviceName', '')
    inner_name_req  = params.get('innerDeviceName')
    chain_name_req  = params.get('chainName')

    if not device_name_req:
        return {'error': 'deviceName is required'}

    if inner_name_req:
        device, rack_idx, inner_idx = _find_inner_device_by_name(
            track, device_name_req, inner_name_req, chain_name=chain_name_req)
        if device is None:
            hint = ' in chain "{}"'.format(chain_name_req) if chain_name_req else ''
            return {'error': 'inner device not found: rack="{}", inner="{}"{}'.format(
                device_name_req, inner_name_req, hint)}
    else:
        try:
            device, _ = _find_device_by_name(track, device_name_req)
        except ValueError as e:
            return {'error': str(e)}
        if device is None:
            available = [d.name for d in track.devices]
            return {'error': 'device not found: "{}". Devices on track: {}'.format(
                device_name_req, ', '.join(available))}

    enabled = params.get('enabled', True)
    try:
        on_param = None
        for p in device.parameters:
            if p.name == 'Device On':
                on_param = p
                break
        if on_param:
            on_param.value = 1.0 if enabled else 0.0
        else:
            device.is_enabled = bool(enabled)
        return {'ok': True, 'device': device.name, 'enabled': bool(enabled)}
    except Exception as e:
        return {'error': 'enable_device failed: {}'.format(e)}


# ─── CLIPS & SCENES ──────────────────────────────────────────────────────────

def handle_create_clip(song, params):
    """Create an empty clip in a clip slot.
    params: { trackName: 'Bass', slotIndex: 0, length: 4.0 }
    length is in beats (4.0 = one bar at 4/4).
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    slot_index = int(params.get('slotIndex', 0))
    length = float(params.get('length', 4.0))

    try:
        slots = list(track.clip_slots)
        if slot_index < 0 or slot_index >= len(slots):
            return {'error': 'slot index out of range: {}'.format(slot_index)}
        cs = slots[slot_index]
        if cs.has_clip:
            return {'error': 'slot {} already has a clip. Delete it first or use a different slot.'.format(slot_index)}
        cs.create_clip(length)
        return {'ok': True, 'track': track.name, 'slot': slot_index, 'length': length}
    except Exception as e:
        return {'error': 'create_clip failed: {}'.format(e)}


def handle_delete_clip(song, params):
    """Delete a clip from a clip slot.
    params: { trackName: 'Bass', slotIndex: 0 }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    slot_index = int(params.get('slotIndex', 0))
    try:
        slots = list(track.clip_slots)
        if slot_index < 0 or slot_index >= len(slots):
            return {'error': 'slot index out of range: {}'.format(slot_index)}
        cs = slots[slot_index]
        if not cs.has_clip:
            return {'error': 'slot {} is already empty'.format(slot_index)}
        cs.delete_clip()
        return {'ok': True, 'track': track.name, 'slot': slot_index}
    except Exception as e:
        return {'error': 'delete_clip failed: {}'.format(e)}


def handle_fire_clip(song, params):
    """Launch a clip.
    params: { trackName: 'Bass', slotIndex: 0 }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    slot_index = int(params.get('slotIndex', 0))
    try:
        slots = list(track.clip_slots)
        if slot_index < 0 or slot_index >= len(slots):
            return {'error': 'slot index out of range: {}'.format(slot_index)}
        slots[slot_index].fire()
        return {'ok': True, 'track': track.name, 'slot': slot_index}
    except Exception as e:
        return {'error': 'fire_clip failed: {}'.format(e)}


def handle_stop_clip(song, params):
    """Stop a clip on a track.
    params: { trackName: 'Bass', slotIndex: 0 }
    If slotIndex is omitted, stops all clips on the track.
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    slot_index = params.get('slotIndex')
    try:
        if slot_index is not None:
            slots = list(track.clip_slots)
            idx = int(slot_index)
            if idx < 0 or idx >= len(slots):
                return {'error': 'slot index out of range: {}'.format(idx)}
            slots[idx].stop()
        else:
            track.stop_all_clips()
        return {'ok': True, 'track': track.name}
    except Exception as e:
        return {'error': 'stop_clip failed: {}'.format(e)}


def handle_fire_scene(song, params):
    """Launch a scene.
    params: { sceneIndex: 0 }
    """
    if song is None:
        return {'error': 'no song loaded'}

    scene_index = int(params.get('sceneIndex', 0))
    try:
        scenes = list(song.scenes)
        if scene_index < 0 or scene_index >= len(scenes):
            return {'error': 'scene index out of range: {}'.format(scene_index)}
        scenes[scene_index].fire()
        return {'ok': True, 'scene': scene_index, 'name': scenes[scene_index].name}
    except Exception as e:
        return {'error': 'fire_scene failed: {}'.format(e)}


def handle_create_scene(song, params):
    """Create a new scene.
    params: { index: -1 }  (-1 = append at end)
    """
    if song is None:
        return {'error': 'no song loaded'}

    index = int(params.get('index', -1))
    try:
        scene = song.create_scene(index)
        return {'ok': True, 'name': scene.name, 'index': index}
    except Exception as e:
        return {'error': 'create_scene failed: {}'.format(e)}


def handle_set_clip_name(song, params):
    """Rename a clip.
    params: { trackName: 'Bass', slotIndex: 0, name: 'Verse riff' }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    slot_ref = params.get('slotIndex', 'playing')
    clip, err = _find_clip(song, track, slot_ref)
    if clip is None:
        return err

    name = params.get('name', '')
    if not name:
        return {'error': 'name required'}

    try:
        clip.name = str(name)
        return {'ok': True, 'track': track.name, 'clipName': clip.name}
    except Exception as e:
        return {'error': 'set clip name failed: {}'.format(e)}


def handle_get_clip_notes(song, params):
    """Read MIDI notes from a clip.
    params: { trackName: 'Bass', slotIndex: 0 }
    Returns notes as [{pitch, start, duration, velocity, mute}, ...]
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    slot_ref = params.get('slotIndex')
    if slot_ref is None:
        return {'error': 'slotIndex is required'}
    clip, err = _find_clip(song, track, slot_ref)
    if clip is None:
        return err

    try:
        notes = compat.get_clip_notes(clip)
        return {
            'ok':        True,
            'track':     track.name,
            'clipLength': clip.length,
            'noteCount': len(notes),
            'notes':     notes,
        }
    except Exception as e:
        return {'error': 'get_clip_notes failed: {}'.format(e)}


def handle_set_clip_notes(song, params):
    """Write MIDI notes to a clip. Replaces existing notes in the given range.
    params: {
        trackName: 'Bass',
        slotIndex: 0,
        notes: [
            { pitch: 60, start: 0.0, duration: 0.5, velocity: 100, mute: false },
            ...
        ],
        clearExisting: true/false  (default: false)
    }
    pitch: 0-127 MIDI note number
    start: position in beats (0 = clip start)
    duration: length in beats
    velocity: 0-127
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    slot_ref = params.get('slotIndex')
    if slot_ref is None:
        return {'error': 'slotIndex is required'}
    clip, err = _find_clip(song, track, slot_ref)
    if clip is None:
        return err

    notes_data     = params.get('notes', [])
    clear_existing = params.get('clearExisting', False)

    if not notes_data:
        return {'error': 'notes array is empty'}

    try:
        written = compat.set_clip_notes(clip, notes_data, clear_existing=clear_existing)
        logger.info('Wrote {} notes to clip on track "{}"'.format(written, track.name))
        return {'ok': True, 'track': track.name, 'written': written}
    except Exception as e:
        return {'error': 'set_clip_notes failed: {}'.format(e)}


# ─── TRANSPORT ────────────────────────────────────────────────────────────────

def handle_play(song, params):
    """Start or continue playback.
    params: { from_start: false }  (true = restart from beginning)
    """
    if song is None:
        return {'error': 'no song loaded'}

    from_start = params.get('from_start', False)
    try:
        if from_start:
            song.start_playing()
        else:
            song.continue_playing()
        return {'ok': True, 'playing': True}
    except Exception as e:
        return {'error': 'play failed: {}'.format(e)}


def handle_stop(song, params):
    """Stop playback.
    params: {}
    """
    if song is None:
        return {'error': 'no song loaded'}

    try:
        song.stop_playing()
        return {'ok': True, 'playing': False}
    except Exception as e:
        return {'error': 'stop failed: {}'.format(e)}


def handle_set_tempo(song, params):
    """Set the session tempo.
    params: { tempo: 128.0 }  (20.0 - 999.0 BPM)
    """
    if song is None:
        return {'error': 'no song loaded'}

    tempo = params.get('tempo')
    if tempo is None:
        return {'error': 'tempo required'}

    try:
        clamped = max(20.0, min(999.0, float(tempo)))
        song.tempo = clamped
        return {'ok': True, 'tempo': song.tempo}
    except Exception as e:
        return {'error': 'set tempo failed: {}'.format(e)}


def handle_set_time_signature(song, params):
    """Set the time signature.
    params: { numerator: 4, denominator: 4 }
    """
    if song is None:
        return {'error': 'no song loaded'}

    try:
        num = int(params.get('numerator', 4))
        den = int(params.get('denominator', 4))
        song.signature_numerator = num
        song.signature_denominator = den
        return {'ok': True, 'numerator': num, 'denominator': den}
    except Exception as e:
        return {'error': 'set time signature failed: {}'.format(e)}


def handle_tap_tempo(song, params):
    """Tap tempo. Call repeatedly to set tempo from tap intervals.
    params: {}
    """
    if song is None:
        return {'error': 'no song loaded'}

    try:
        song.tap_tempo()
        return {'ok': True, 'tempo': song.tempo}
    except Exception as e:
        return {'error': 'tap_tempo failed: {}'.format(e)}


def handle_set_loop(song, params):
    """Set arrangement loop. Enable/disable and set boundaries.
    params: {
        enabled: true/false,
        start: 0.0,      (in beats)
        length: 16.0,     (in beats)
    }
    """
    if song is None:
        return {'error': 'no song loaded'}

    result = {'ok': True}

    enabled = params.get('enabled')
    if enabled is not None:
        try:
            song.loop = bool(enabled)
            result['loopEnabled'] = song.loop
        except Exception as e:
            result['loopError'] = str(e)

    start = params.get('start')
    if start is not None:
        try:
            song.loop_start = float(start)
            result['loopStart'] = song.loop_start
        except Exception as e:
            result['loopStartError'] = str(e)

    length = params.get('length')
    if length is not None:
        try:
            song.loop_length = float(length)
            result['loopLength'] = song.loop_length
        except Exception as e:
            result['loopLengthError'] = str(e)

    return result


def handle_get_transport(song, params):
    """Get current transport state.
    Returns tempo, time sig, playing state, loop settings, song position.
    """
    if song is None:
        return {'error': 'no song loaded'}

    try:
        return {
            'ok': True,
            'tempo': song.tempo,
            'signatureNumerator': song.signature_numerator,
            'signatureDenominator': song.signature_denominator,
            'isPlaying': song.is_playing,
            'loop': song.loop,
            'loopStart': song.loop_start,
            'loopLength': song.loop_length,
            'currentTime': song.current_song_time,
        }
    except Exception as e:
        return {'error': 'get_transport failed: {}'.format(e)}


# ─── RETURN TRACKS ────────────────────────────────────────────────────────────

def handle_create_return(song, params):
    """Create a new return track.
    params: { name: 'Reverb' }  (optional)
    """
    if song is None:
        return {'error': 'no song loaded'}

    try:
        song.create_return_track()
        # The new return track is the last one
        new_return = song.return_tracks[-1]
        name = params.get('name')
        if name:
            new_return.name = str(name)
        return {
            'ok': True,
            'name': new_return.name,
            'index': len(song.return_tracks) - 1,
        }
    except Exception as e:
        return {'error': 'create_return failed: {}'.format(e)}


def handle_delete_return(song, params):
    """Delete a return track.
    params: { returnIndex: 0 }  or  { trackName: 'A-Reverb' }
    """
    if song is None:
        return {'error': 'no song loaded'}

    return_index = params.get('returnIndex')
    track_name = params.get('trackName')

    if return_index is not None:
        idx = int(return_index)
    elif track_name:
        idx = None
        for i, rt in enumerate(song.return_tracks):
            if rt.name.lower().strip() == track_name.lower().strip():
                idx = i
                break
        if idx is None:
            return {'error': 'return track not found: {}'.format(track_name)}
    else:
        return {'error': 'returnIndex or trackName required'}

    try:
        song.delete_return_track(idx)
        return {'ok': True, 'deleted': idx}
    except Exception as e:
        return {'error': 'delete_return failed: {}'.format(e)}


# ─── GROUP TRACKS ─────────────────────────────────────────────────────────────

def handle_group_tracks(song, params):
    """Group tracks together. Creates a group track wrapping the specified tracks.
    params: { trackNames: ['Kick', 'Snare', 'HiHat'] }
    The tracks must be contiguous in the track list. If they're not,
    Addie should reorder them first (not yet supported) or report an error.
    """
    if song is None:
        return {'error': 'no song loaded'}

    track_names = params.get('trackNames', [])
    if len(track_names) < 2:
        return {'error': 'need at least 2 track names to group'}

    # Find indices in song.tracks (not _all_tracks)
    indices = []
    for name in track_names:
        found = False
        for i, t in enumerate(song.tracks):
            if t.name.lower().strip() == name.lower().strip():
                indices.append(i)
                found = True
                break
        if not found:
            return {'error': 'track not found: {}'.format(name)}

    # Check contiguity
    indices.sort()
    for i in range(len(indices) - 1):
        if indices[i + 1] - indices[i] != 1:
            return {'error': 'tracks must be contiguous. Found gap between "{}" (index {}) and next selected (index {}). Reorder tracks first.'.format(
                song.tracks[indices[i]].name, indices[i], indices[i + 1])}

    try:
        # Select the tracks by setting them as the selection in session view
        # Live's API: select the range, then call create_group
        # We need to use song.view to set track selection
        song.view.selected_track = song.tracks[indices[0]]

        # The LOM doesn't have a direct multi-select API.
        # However, song.create_group() groups the tracks between
        # the first and last selected track indices.
        # We'll use the range approach.
        first_idx = indices[0]
        last_idx  = indices[-1]

        # Move view to first track, select range
        for idx in indices:
            song.tracks[idx].solo = False  # ensure no solo conflicts

        # Ableton's group creation groups consecutive tracks
        # The cleanest way: select first track, then call group on the range
        song.view.selected_track = song.tracks[first_idx]

        # Unfortunately the LOM API for grouping varies by Live version.
        # In Live 11+, we can try:
        song.create_group_track(first_idx, last_idx + 1)

        # Name the group if requested
        group_name = params.get('groupName')
        if group_name:
            # The group track is inserted at first_idx
            song.tracks[first_idx].name = str(group_name)

        return {
            'ok': True,
            'groupName': song.tracks[first_idx].name,
            'groupedTracks': track_names,
        }
    except Exception as e:
        return {'error': 'group_tracks failed: {}'.format(e)}


# ─── UNGROUP TRACKS ───────────────────────────────────────────────────────────

def handle_ungroup_tracks(song, params):
    """Ungroup a group track, releasing its children.
    params: { trackName: 'Drums' }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track_name = params.get('trackName', '')
    for i, t in enumerate(song.tracks):
        if t.name.lower().strip() == track_name.lower().strip():
            try:
                if not t.is_foldable:
                    return {'error': '"{}" is not a group track'.format(track_name)}
                song.ungroup_track(i)
                return {'ok': True, 'ungrouped': track_name}
            except Exception as e:
                return {'error': 'ungroup failed: {}'.format(e)}


# ─── TRACK DELAY ──────────────────────────────────────────────────────────────
#
# Set the track delay in milliseconds.
# Positive = delay (audio arrives later), negative = advance (earlier).
# Useful for phase alignment, Haas stereo widening, latency compensation.
#
# params: { trackName: 'Guitar Double', delayMs: 20.0 }
# delayMs range: approximately -100 ms to +100 ms (Live's Track Delay range)

def handle_set_track_delay(song, params):
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    delay_ms = params.get('delayMs')
    if delay_ms is None:
        return {'error': 'delayMs required (float, milliseconds, negative to advance)'}

    try:
        delay_param = track.mixer_device.track_delay
        delay_param.value = float(delay_ms)
        return {
            'ok':      True,
            'track':   track.name,
            'delayMs': delay_param.value,
            'display': delay_param.str_for_value(delay_param.value),
        }
    except AttributeError:
        return {'error': 'track_delay not available on this track type (master/return tracks not supported)'}
    except Exception as e:
        return {'error': 'set_track_delay failed: {}'.format(e)}


# ─── FREEZE / FLATTEN ─────────────────────────────────────────────────────────
#
# Freeze: renders a track with all effects into a temporary audio file, freeing CPU.
#         The track becomes read-only. Call with freeze=false to unfreeze.
# Flatten: converts a frozen track's rendered audio into a permanent audio clip.
#          IRREVERSIBLE (except Ctrl+Z in Ableton). Track must be frozen first.

def handle_freeze_track(song, params):
    """Freeze or unfreeze a track.
    params: { trackName: 'Synth Pad', freeze: true/false }
    Default: freeze = true.
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    freeze_val = bool(params.get('freeze', True))

    try:
        current = track.is_frozen
        if freeze_val == current:
            state = 'frozen' if current else 'unfrozen'
            return {'ok': True, 'track': track.name, 'frozen': current,
                    'note': 'Track is already {}'.format(state)}
    except AttributeError:
        return {'error': 'is_frozen not available on this track type'}

    try:
        track.freeze_to_free_ram = freeze_val
        return {'ok': True, 'track': track.name, 'frozen': freeze_val}
    except AttributeError:
        pass
    except Exception as e:
        return {'error': 'freeze_track failed: {}'.format(e)}

    # Fallback for Live versions that expose freeze differently
    try:
        if freeze_val:
            track.freeze()
        else:
            track.unfreeze()
        return {'ok': True, 'track': track.name, 'frozen': freeze_val}
    except Exception as e:
        return {'error': 'freeze_track failed: {}'.format(e)}


def handle_flatten_track(song, params):
    """Flatten a frozen track to permanent audio. IRREVERSIBLE.
    Track must be frozen first. After flattening, MIDI and devices are gone.
    params: { trackName: 'Synth Pad' }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    try:
        if not track.is_frozen:
            return {'error': 'track "{}" is not frozen — freeze it first'.format(track.name)}
    except AttributeError:
        return {'error': 'is_frozen not available on this track type'}

    try:
        track.flatten()
        return {
            'ok':   True,
            'track': track.name,
            'note': 'Flattened to audio. Undo via Ctrl+Z in Ableton if needed.',
        }
    except Exception as e:
        return {'error': 'flatten_track failed: {}'.format(e)}


# ─── WARP MARKERS ─────────────────────────────────────────────────────────────
#
# Warp markers anchor positions in an audio clip's original file timeline
# to positions in Live's beat-based timeline. Used for tempo-syncing samples,
# aligning transients to the grid, and creating time-stretch effects.
#
# warped_time: beat position in Live's timeline (inside the clip)
# sample_time: position in the original audio file (seconds)

def handle_get_warp_markers(song, params):
    """Read warp markers from an audio clip.
    params: { trackName: 'Drums Loop', slotIndex: 0 }
    Returns: [{ warped_time, sample_time }, ...]
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    slot_ref = params.get('slotIndex')
    if slot_ref is None:
        return {'error': 'slotIndex is required'}
    clip, err = _find_clip(song, track, slot_ref)
    if clip is None:
        return err

    try:
        if not clip.is_audio_clip:
            return {'error': 'warp markers are only available on audio clips'}
        markers = [{'warped_time': m.warped_time, 'sample_time': m.sample_time}
                   for m in clip.warp_markers]
        return {
            'ok':          True,
            'track':       track.name,
            'warp_mode':   clip.warp_mode,
            'warpMarkers': markers,
            'count':       len(markers),
        }
    except AttributeError:
        return {'error': 'warp_markers not available — audio clip required, Live 11+'}
    except Exception as e:
        return {'error': 'get_warp_markers failed: {}'.format(e)}


def handle_set_warp_marker(song, params):
    """Add or replace a single warp marker on an audio clip.
    params: {
        trackName:   'Drums Loop',
        slotIndex:   0,
        warped_time: 1.0,   # beat position in Live timeline (inside clip)
        sample_time: 0.5,   # original position in seconds in the audio file
        warp_mode:   5,     # optional: 0=Beats,1=Tones,2=Texture,3=Re-Pitch,4=Complex,5=ComplexPro
    }
    Any existing marker within 0.001 beats of warped_time is replaced.
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    slot_ref = params.get('slotIndex')
    if slot_ref is None:
        return {'error': 'slotIndex is required'}
    clip, err = _find_clip(song, track, slot_ref)
    if clip is None:
        return err

    warped_time = params.get('warped_time')
    sample_time = params.get('sample_time')
    if warped_time is None or sample_time is None:
        return {'error': 'warped_time and sample_time are required'}

    try:
        if not clip.is_audio_clip:
            return {'error': 'warp markers are only available on audio clips'}

        warp_mode = params.get('warp_mode')
        if warp_mode is not None:
            clip.warp_mode = int(warp_mode)

        # Remove existing marker at the same position (within tolerance)
        for m in list(clip.warp_markers):
            if abs(m.warped_time - float(warped_time)) < 0.001:
                try:
                    clip.remove_warp_marker(m)
                except Exception:
                    pass
                break

        clip.set_warp_marker(float(warped_time), float(sample_time))
        return {
            'ok':          True,
            'track':       track.name,
            'warped_time': float(warped_time),
            'sample_time': float(sample_time),
            'warp_mode':   clip.warp_mode,
        }
    except AttributeError:
        return {'error': 'set_warp_marker not available — audio clip required, Live 11+'}
    except Exception as e:
        return {'error': 'set_warp_marker failed: {}'.format(e)}


def handle_clear_warp_markers(song, params):
    """Remove all warp markers from an audio clip (resets to default warping).
    params: { trackName: 'Drums Loop', slotIndex: 0 }
    """
    if song is None:
        return {'error': 'no song loaded'}

    track = _find_track_by_name(song, params.get('trackName', ''))
    if track is None:
        return {'error': 'track not found: {}'.format(params.get('trackName'))}

    slot_ref = params.get('slotIndex')
    if slot_ref is None:
        return {'error': 'slotIndex is required'}
    clip, err = _find_clip(song, track, slot_ref)
    if clip is None:
        return err

    try:
        if not clip.is_audio_clip:
            return {'error': 'warp markers are only available on audio clips'}
        removed = 0
        for m in list(clip.warp_markers):
            try:
                clip.remove_warp_marker(m)
                removed += 1
            except Exception:
                pass
        return {'ok': True, 'track': track.name, 'removed': removed}
    except AttributeError:
        return {'error': 'warp_markers not available — audio clip required, Live 11+'}
    except Exception as e:
        return {'error': 'clear_warp_markers failed: {}'.format(e)}

    return {'error': 'track not found: {}'.format(track_name)}
