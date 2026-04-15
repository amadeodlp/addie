# addie.py — Main control surface class

import threading
from . import logger
from . import compat
from .server import BridgeServer

# Resolve the ControlSurface base class at import time.
# compat.get_control_surface_base() only does an import — no Live API calls —
# so it's safe to call before the logger is wired up. The log line inside
# get_control_surface_base() will use print() as fallback until logger is ready.
ControlSurface = compat.get_control_surface_base()


COMMANDS_PER_TICK = 3


class Addie(ControlSurface):

    def __init__(self, c_instance):
        super().__init__(c_instance)

        logger.set_log_fn(self.log_message)
        logger.info('Addie control surface initializing...')

        # Detect and log Live version now that the logger is active
        compat.get_live_version()  # result is cached; side-effect is the log line

        self._command_queue = []
        self._queue_lock    = threading.Lock()

        self._server = BridgeServer(
            host='127.0.0.1',
            port=3001,
            enqueue_fn=self._enqueue_command,
        )
        # Give the server read access to the queue for /health diagnostics
        self._server.set_queue_ref(self._command_queue, self._queue_lock)

        self._server_thread = threading.Thread(
            target=self._run_server,
            name='addie-bridge',
            daemon=True,
        )
        self._server_thread.start()

        logger.info('Addie bridge listening on http://127.0.0.1:3001')

        # Log browser attributes on startup so we can see what's available
        self._schedule_browser_probe()

    def _run_server(self):
        """Wrapper around serve_forever that catches unexpected crashes
        so we get a log entry instead of a silent daemon thread death."""
        try:
            self._server.serve_forever()
        except Exception as e:
            logger.error('BridgeServer.serve_forever() crashed: {}'.format(e))

    def _schedule_browser_probe(self):
        """Log all browser attributes to Log.txt on first load."""
        try:
            browser = self.application().browser
            attrs   = [a for a in dir(browser) if not a.startswith('_')]
            logger.info('Browser attributes: {}'.format(', '.join(attrs)))
        except Exception as e:
            logger.error('Could not probe browser: {}'.format(e))

    def disconnect(self):
        logger.info('Addie disconnecting...')
        try:
            self._server.shutdown()
        except Exception as e:
            logger.error('Error shutting down server: {}'.format(e))
        super().disconnect()

    def update_display(self):
        """Called by Ableton on every display tick. Drains the command queue.

        CRITICAL: This method must NEVER raise an unhandled exception.
        If it does, Ableton silently stops calling it and the bridge dies
        permanently — health pings still respond but no commands execute.
        """
        try:
            # Update heartbeat so the HTTP server can detect if we stop running
            self._server.update_heartbeat()

            with self._queue_lock:
                batch = self._command_queue[:COMMANDS_PER_TICK]
                del self._command_queue[:COMMANDS_PER_TICK]

            for (command, params, future) in batch:
                try:
                    result = self._dispatch(command, params)
                    future.set_result(result)
                except Exception as e:
                    logger.error('Command {} failed: {}'.format(command, e))
                    future.set_result({'error': str(e)})
        except Exception as e:
            # Nuclear catch: if the queue lock, batch slicing, or anything
            # else fails, log it but do NOT let it propagate to Ableton.
            # If this fires, something is seriously wrong — but at least
            # update_display keeps getting called.
            logger.error('update_display CRITICAL error: {}'.format(e))

    def _enqueue_command(self, command, params, future):
        with self._queue_lock:
            self._command_queue.append((command, params, future))

    def _dispatch(self, command, params):
        from .handlers import (
            handle_ping, handle_tempo, handle_track_count, handle_track_get,
            handle_snapshot_tier1, handle_snapshot_tier2, handle_snapshot,
            handle_param_get, handle_param_set, handle_param_count,
            handle_browser_list, handle_browser_insert, handle_browser_debug,
            handle_get_clips, handle_create_automation, handle_read_automation, handle_clear_automation,
            handle_create_track, handle_delete_track, handle_rename_track,
            handle_duplicate_track, handle_set_track_color,
            handle_set_mixer, handle_set_mute, handle_set_solo,
            handle_get_routing_options, handle_set_routing,
            handle_delete_device, handle_move_device, handle_enable_device,
            handle_create_clip, handle_delete_clip,
            handle_create_scene, handle_set_clip_name,
            handle_get_clip_notes, handle_set_clip_notes,
            handle_set_tempo, handle_set_time_signature,
            handle_set_loop, handle_get_transport,
            handle_create_return, handle_delete_return,
            handle_group_tracks, handle_ungroup_tracks,
            handle_set_track_delay,
            handle_freeze_track, handle_flatten_track,
            handle_get_warp_markers, handle_set_warp_marker, handle_clear_warp_markers,
        )

        song = self.song()
        app  = self.application()

        handlers = {
            'ping':              lambda p: handle_ping(),
            'tempo':             lambda p: handle_tempo(song),
            'track_count':       lambda p: handle_track_count(song),
            'track_get':         lambda p: handle_track_get(song, p),
            'snapshot_tier1':    lambda p: handle_snapshot_tier1(song),
            'snapshot_tier2':    lambda p: handle_snapshot_tier2(song, p),
            'snapshot':          lambda p: handle_snapshot(song, p),
            'param_get':         lambda p: handle_param_get(song, p),
            'param_set':         lambda p: handle_param_set(song, p),
            'param_count':       lambda p: handle_param_count(song, p),
            'browser_list':      lambda p: handle_browser_list(app, p),
            'browser_insert':    lambda p: handle_browser_insert(app, song, p),
            'browser_debug':     lambda p: handle_browser_debug(app, p),
            'get_clips':         lambda p: handle_get_clips(song, p),
            'create_automation': lambda p: handle_create_automation(song, p),
            'read_automation':   lambda p: handle_read_automation(song, p),
            'clear_automation':  lambda p: handle_clear_automation(song, p),
            'create_track':      lambda p: handle_create_track(song, p),
            'delete_track':      lambda p: handle_delete_track(song, p),
            'rename_track':      lambda p: handle_rename_track(song, p),
            'duplicate_track':   lambda p: handle_duplicate_track(song, p),
            'set_track_color':   lambda p: handle_set_track_color(song, p),
            'set_mixer':         lambda p: handle_set_mixer(song, p),
            'set_mute':          lambda p: handle_set_mute(song, p),
            'set_solo':          lambda p: handle_set_solo(song, p),
            'get_routing_options': lambda p: handle_get_routing_options(song, p),
            'set_routing':       lambda p: handle_set_routing(song, p),
            'delete_device':     lambda p: handle_delete_device(song, p),
            'move_device':       lambda p: handle_move_device(song, p),
            'enable_device':     lambda p: handle_enable_device(song, p),
            'create_clip':       lambda p: handle_create_clip(song, p),
            'delete_clip':       lambda p: handle_delete_clip(song, p),
            'create_scene':      lambda p: handle_create_scene(song, p),
            'set_clip_name':     lambda p: handle_set_clip_name(song, p),
            'get_clip_notes':    lambda p: handle_get_clip_notes(song, p),
            'set_clip_notes':    lambda p: handle_set_clip_notes(song, p),
            'set_tempo':         lambda p: handle_set_tempo(song, p),
            'set_time_signature': lambda p: handle_set_time_signature(song, p),
            'set_loop':          lambda p: handle_set_loop(song, p),
            'get_transport':     lambda p: handle_get_transport(song, p),
            'create_return':     lambda p: handle_create_return(song, p),
            'delete_return':     lambda p: handle_delete_return(song, p),
            'group_tracks':      lambda p: handle_group_tracks(song, p),
            'ungroup_tracks':    lambda p: handle_ungroup_tracks(song, p),
            'set_track_delay':   lambda p: handle_set_track_delay(song, p),
            'freeze_track':      lambda p: handle_freeze_track(song, p),
            'flatten_track':     lambda p: handle_flatten_track(song, p),
            'get_warp_markers':  lambda p: handle_get_warp_markers(song, p),
            'set_warp_marker':   lambda p: handle_set_warp_marker(song, p),
            'clear_warp_markers': lambda p: handle_clear_warp_markers(song, p),
        }

        handler = handlers.get(command)
        if handler is None:
            return {'error': 'unknown command: {}'.format(command)}

        return handler(params)
