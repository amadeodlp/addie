# compat.py — Cross-version compatibility shims for Ableton Live 10 / 11 / 12
#
# Live's Python API has evolved across major versions. This module centralises
# every place where the API differs so the rest of the codebase can call a
# single function and not worry about which version is running.
#
# Live version detection is done lazily on first use via _detect_live_version().
# The detected version is cached in _LIVE_VERSION after the first call.
#
# Supported matrix:
#   Live 10  — Windows / macOS
#   Live 11  — Windows / macOS
#   Live 12  — Windows / macOS
#
# API differences handled here:
#   1. Clip note reading  — get_notes_extended (11+) vs get_notes tuple (10)
#   2. Clip note writing  — add_new_notes (11.1+) vs set_notes tuple (10/11.0)
#   3. Clip note removal  — remove_notes_extended (11+) vs select+replace (10)
#   4. Track routing      — output_routing_type.display_name (11+, fragile in 10)
#   5. Framework import   — _Framework.ControlSurface path varies by platform

from . import logger

# ─── VERSION DETECTION ────────────────────────────────────────────────────────

_LIVE_VERSION = None   # cached after first detection: (major, minor, patch)


def get_live_version():
    """Return (major, minor, patch) tuple. Cached after first call.
    Falls back to (0, 0, 0) if detection fails — callers treat that as
    'assume oldest supported behaviour'.
    """
    global _LIVE_VERSION
    if _LIVE_VERSION is not None:
        return _LIVE_VERSION
    _LIVE_VERSION = _detect_live_version()
    logger.info('Detected Live version: {}.{}.{}'.format(*_LIVE_VERSION))
    return _LIVE_VERSION


def _detect_live_version():
    """Probe the Live API for version info. Multiple strategies, first wins."""
    # Strategy 1: Live.Application.get_application().get_major_version() etc.
    try:
        import Live
        app = Live.Application.get_application()
        major = app.get_major_version()
        minor = app.get_minor_version()
        bugfix = app.get_bugfix_version()
        return (int(major), int(minor), int(bugfix))
    except Exception:
        pass

    # Strategy 2: inspect a known API symbol introduced in Live 11
    try:
        from Live import Clip
        # get_notes_extended was added in Live 11
        if hasattr(Clip.Clip, 'get_notes_extended'):
            return (11, 0, 0)
        else:
            return (10, 0, 0)
    except Exception:
        pass

    # Strategy 3: check add_new_notes (Live 11.1+)
    try:
        from Live import Clip
        if hasattr(Clip.Clip, 'add_new_notes'):
            return (11, 1, 0)
    except Exception:
        pass

    logger.error('compat: could not detect Live version, assuming 10.x')
    return (0, 0, 0)


# ─── CLIP NOTE READING ────────────────────────────────────────────────────────

def get_clip_notes(clip):
    """Read all MIDI notes from a clip.

    Returns a list of dicts:
        [{ 'pitch', 'start', 'duration', 'velocity', 'mute' }, ...]

    API strategy:
        Live 11+  — clip.get_notes_extended(from_pitch, pitch_span, from_time, time_span)
                    Returns MidiNote objects with attribute access.
        Live 10   — clip.get_notes(from_time, from_pitch, time_span, pitch_span)
                    Returns tuples: (pitch, start, duration, velocity, mute)
    """
    # Try modern API first (Live 11+)
    try:
        notes_raw = clip.get_notes_extended(
            from_pitch=0, pitch_span=128,
            from_time=0,  time_span=clip.length,
        )
        return [
            {
                'pitch':    note.pitch,
                'start':    note.start_time,
                'duration': note.duration,
                'velocity': note.velocity,
                'mute':     note.mute,
            }
            for note in notes_raw
        ]
    except AttributeError:
        pass  # Live 10 — fall through to legacy API
    except Exception as e:
        logger.error('get_notes_extended failed unexpectedly: {}'.format(e))

    # Legacy API (Live 10): get_notes(from_time, from_pitch, time_span, pitch_span)
    try:
        notes_raw = clip.get_notes(0, 0, clip.length, 128)
        return [
            {
                'pitch':    n[0],
                'start':    n[1],
                'duration': n[2],
                'velocity': n[3],
                'mute':     bool(n[4]),
            }
            for n in notes_raw
        ]
    except Exception as e:
        raise RuntimeError('get_clip_notes failed on both APIs: {}'.format(e))


# ─── CLIP NOTE REMOVAL ────────────────────────────────────────────────────────

def remove_clip_notes(clip, from_pitch=0, pitch_span=128, from_time=0, time_span=None):
    """Remove notes from a clip within the given range.

    API strategy:
        Live 11+  — clip.remove_notes_extended(from_pitch, pitch_span, from_time, time_span)
        Live 10   — select_all_notes() + replace_selected_notes(()) to clear,
                    then re-add any notes outside the removal range.
    """
    if time_span is None:
        time_span = clip.length

    # Try modern API first (Live 11+)
    try:
        clip.remove_notes_extended(
            from_pitch=from_pitch, pitch_span=pitch_span,
            from_time=from_time,   time_span=time_span,
        )
        return
    except AttributeError:
        pass  # Live 10
    except Exception as e:
        logger.error('remove_notes_extended failed: {}'.format(e))
        raise

    # Legacy: read all notes, filter out the ones in range, re-write rest
    try:
        all_notes = clip.get_notes(0, 0, clip.length, 128)
        keep = []
        for n in all_notes:
            n_pitch, n_start, n_dur, n_vel, n_mute = n[0], n[1], n[2], n[3], n[4]
            in_pitch_range = (from_pitch <= n_pitch < from_pitch + pitch_span)
            in_time_range  = (n_start >= from_time and n_start < from_time + time_span)
            if not (in_pitch_range and in_time_range):
                keep.append(n)
        clip.select_all_notes()
        clip.replace_selected_notes(tuple(keep))
    except Exception as e:
        raise RuntimeError('remove_clip_notes legacy path failed: {}'.format(e))


# ─── CLIP NOTE WRITING ────────────────────────────────────────────────────────

def set_clip_notes(clip, notes_data, clear_existing=False):
    """Write MIDI notes to a clip.

    notes_data: list of dicts with keys pitch, start, duration, velocity, mute.

    API strategy:
        Live 11.1+ — remove_notes_extended + add_new_notes (MidiNoteSpecification)
        Live 11.0  — remove_notes_extended + set_notes tuple (no add_new_notes)
        Live 10    — select_all_notes + replace_selected_notes tuple

    Returns number of notes written.
    """
    if clear_existing:
        remove_clip_notes(clip)  # uses compat shim above

    note_tuples = []
    for n in notes_data:
        pitch    = max(0, min(127, int(n.get('pitch', 60))))
        start    = float(n.get('start', 0.0))
        duration = max(0.01, float(n.get('duration', 0.25)))
        velocity = max(0, min(127, float(n.get('velocity', 100))))
        mute     = bool(n.get('mute', False))
        note_tuples.append((pitch, start, duration, velocity, mute))

    # Try add_new_notes (Live 11.1+)
    try:
        import Live
        NoteSpec = Live.Clip.MidiNoteSpecification
        specs = [
            NoteSpec(
                pitch=t[0], start_time=t[1], duration=t[2],
                velocity=t[3], mute=t[4],
            )
            for t in note_tuples
        ]
        clip.add_new_notes(tuple(specs))
        return len(specs)
    except (AttributeError, ImportError):
        pass  # older Live — fall through
    except Exception as e:
        logger.error('add_new_notes failed: {}'.format(e))

    # Fallback: namedtuple shim for add_new_notes on Live 11.0
    try:
        from collections import namedtuple
        NoteSpec = namedtuple(
            'NoteSpec', ['pitch', 'start_time', 'duration', 'velocity', 'mute']
        )
        specs = [NoteSpec(t[0], t[1], t[2], t[3], t[4]) for t in note_tuples]
        clip.add_new_notes(tuple(specs))
        return len(specs)
    except AttributeError:
        pass  # Live 10 — add_new_notes doesn't exist
    except Exception as e:
        logger.error('add_new_notes (namedtuple shim) failed: {}'.format(e))

    # Legacy (Live 10): set_notes / replace_selected_notes
    try:
        if clear_existing:
            # clear_existing already ran remove_clip_notes above.
            # On Live 10 that used select+replace, so we just write:
            clip.set_notes(tuple(note_tuples))
        else:
            # Merge: read existing, append new, replace all
            existing = clip.get_notes(0, 0, clip.length, 128)
            merged = list(existing) + note_tuples
            clip.select_all_notes()
            clip.replace_selected_notes(tuple(merged))
        return len(note_tuples)
    except Exception as e:
        raise RuntimeError('set_clip_notes failed on all APIs: {}'.format(e))


# ─── TRACK ROUTING DISPLAY ────────────────────────────────────────────────────

def get_routing_display(track):
    """Return the output routing display name for a track.

    Live 11+ exposes output_routing_type.display_name reliably.
    Live 10 has the attribute but it can raise on some track types
    (return tracks, master in certain configurations).

    Returns a string or None on failure.
    """
    try:
        return track.output_routing_type.display_name
    except Exception:
        # Graceful degradation — routing info just won't appear in context
        return None


# ─── FRAMEWORK IMPORT HELPER ─────────────────────────────────────────────────

def get_control_surface_base():
    """Return the ControlSurface base class appropriate for this platform.

    Live loads MIDI Remote Scripts from different internal paths on Windows
    and macOS, and the _Framework package structure changed in Live 12.

    Priority:
        1. _Framework.ControlSurface   (Live 10/11/12 — primary path)
        2. _AbletonDevicesFramework.ControlSurface  (Live 12 alt path)
        3. Stub class with no-op methods  (unit tests / static analysis)
    """
    try:
        from _Framework.ControlSurface import ControlSurface
        logger.info('compat: using _Framework.ControlSurface')
        return ControlSurface
    except ImportError:
        pass

    try:
        from _AbletonDevicesFramework.ControlSurface import ControlSurface
        logger.info('compat: using _AbletonDevicesFramework.ControlSurface')
        return ControlSurface
    except ImportError:
        pass

    logger.error('compat: no ControlSurface framework found — using stub. '
                 'Control surface will not function in Live.')

    class _StubControlSurface:
        def __init__(self, c_instance):
            self._c_instance = c_instance
        def song(self):           return None
        def application(self):   return None
        def log_message(self, m): print(m)
        def disconnect(self):    pass
        def update_display(self): pass

    return _StubControlSurface
