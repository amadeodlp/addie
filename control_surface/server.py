# server.py — Lightweight HTTP server for the bridge
#
# Runs on a background thread. Receives JSON commands from the Node.js backend,
# parks them in a Future, and blocks until update_display() resolves them on
# the Live main thread. Then writes the JSON response back.
#
# Uses ThreadingMixIn so concurrent requests (watchdog health pings, command
# POSTs) don't block each other while a Future is waiting.
#
# Protocol:
#
#   GET  /health
#        Returns { ok: true, heartbeat: <epoch>, queue: <int> }.
#        Used by Node.js bridge detector. The heartbeat field is the last time
#        update_display() ran — if it's stale, the bridge is braindead.
#
#   POST /api/bridge/command
#        Node.js sends { id, command, params } and blocks until the result is
#        ready. Server responds with { id, result }.
#
#   GET  /api/bridge/poll       (legacy compat — returns 204)
#   POST /api/bridge/result     (legacy no-op — returns 200)
#
# Why BaseHTTPServer instead of Flask/aiohttp?
#   Live's Python is a frozen distribution. No pip. We can only use the stdlib.

import json
import time
import threading

try:
    from http.server import HTTPServer, BaseHTTPRequestHandler
except ImportError:
    from BaseHTTPServer import HTTPServer, BaseHTTPRequestHandler  # Python 2 shim (Live 9)

try:
    from socketserver import ThreadingMixIn
except ImportError:
    from SocketServer import ThreadingMixIn  # Python 2 shim

from . import logger


class _Future:
    """
    Minimal one-shot result holder.
    Background thread waits on it; main thread resolves it.
    """

    def __init__(self):
        self._event = threading.Event()
        self._result = None

    def set_result(self, result):
        self._result = result
        self._event.set()

    def wait(self, timeout=8.0):
        """Returns (result, timed_out)."""
        fired = self._event.wait(timeout=timeout)
        return (self._result, not fired)


class _Handler(BaseHTTPRequestHandler):
    """HTTP request handler. One instance per request (one thread per request
    thanks to ThreadingMixIn)."""

    # suppress default request logging — Live's log gets noisy fast
    def log_message(self, fmt, *args):
        pass

    def log_error(self, fmt, *args):
        logger.error('BridgeServer: ' + fmt % args)

    # ── routing ───────────────────────────────────────────────────────────────

    def do_GET(self):
        if self.path == '/health':
            self._json(200, {
                'ok': True,
                'heartbeat': self.server.last_heartbeat,
                'queue': self.server.queue_size(),
            })
        elif self.path == '/api/bridge/poll':
            self._json(204, None)
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path == '/api/bridge/command':
            self._handle_command()
        elif self.path == '/api/bridge/result':
            self._read_body()
            self._json(200, {'ok': True})
        else:
            self._read_body()
            self._json(404, {'error': 'not found'})

    # ── command handling ───────────────────────────────────────────────────────

    def _handle_command(self):
        body = self._read_body()
        if body is None:
            self._json(400, {'error': 'empty body'})
            return

        try:
            msg = json.loads(body)
        except ValueError as e:
            self._json(400, {'error': 'invalid JSON: {}'.format(e)})
            return

        cmd_id  = msg.get('id', '')
        command = msg.get('command', '')
        params  = msg.get('params', {})

        if not command:
            self._json(400, {'error': 'missing command'})
            return

        # Check heartbeat — if update_display stopped running, don't enqueue
        # (the future would never resolve and we'd just block for 8s for nothing).
        heartbeat_age = time.time() - self.server.last_heartbeat
        if self.server.last_heartbeat > 0 and heartbeat_age > 5.0:
            logger.error('Rejecting command {} — update_display stale ({:.1f}s)'.format(
                command, heartbeat_age))
            self._json(503, {
                'id': cmd_id,
                'error': 'update_display not running (stale {:.1f}s)'.format(heartbeat_age),
            })
            return

        # Create a future, hand it to the main thread via enqueue_fn
        future = _Future()
        try:
            self.server.enqueue_fn(command, params, future)
        except Exception as e:
            logger.error('Failed to enqueue command {}: {}'.format(command, e))
            self._json(500, {'id': cmd_id, 'error': 'enqueue failed: {}'.format(e)})
            return

        # Block this thread until update_display() resolves the future.
        # ThreadingMixIn means other requests (health pings) are handled
        # concurrently on separate threads — we won't deadlock the server.
        result, timed_out = future.wait(timeout=8.0)

        if timed_out:
            logger.error('Command timed out: {} (heartbeat age: {:.1f}s)'.format(
                command, time.time() - self.server.last_heartbeat))
            self._json(504, {'id': cmd_id, 'error': 'Live main thread timeout'})
        else:
            self._json(200, {'id': cmd_id, 'result': result})

    # ── helpers ───────────────────────────────────────────────────────────────

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length == 0:
            return None
        return self.rfile.read(length).decode('utf-8')

    def _json(self, status, data):
        try:
            body = json.dumps(data).encode('utf-8') if data is not None else b''
        except (TypeError, ValueError) as e:
            # Result contained non-serializable data (e.g. a Live API object
            # leaked through). Log it and send a safe error response instead
            # of letting the exception kill the handler thread.
            logger.error('JSON serialization failed: {}'.format(e))
            body = json.dumps({'error': 'response serialization failed: {}'.format(e)}).encode('utf-8')
            status = 500

        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            # The Node side timed out and closed the socket before we could
            # write back. Harmless — silently swallow to avoid log spam.
            pass
        except Exception as e:
            # Catch-all: don't let ANY write error propagate up and kill the
            # handler thread or corrupt server state.
            logger.error('_json write error: {}'.format(e))


class BridgeServer(ThreadingMixIn, HTTPServer):
    """
    Threaded HTTP server. Each request runs on its own thread so a blocked
    Future.wait() on a command POST doesn't prevent health pings or other
    requests from being served.

    ThreadingMixIn must come first in the MRO so its process_request()
    overrides HTTPServer's synchronous version.
    """

    # Let handler threads die when the main thread exits
    daemon_threads = True

    def __init__(self, host, port, enqueue_fn):
        HTTPServer.__init__(self, (host, port), _Handler)
        self.enqueue_fn = enqueue_fn
        self.last_heartbeat = 0.0  # epoch — updated by update_display()
        self._queue_lock_ref = None  # set by Addie after init
        self._queue_ref = None       # set by Addie after init

    def set_queue_ref(self, queue, lock):
        """Give the server a read-only reference to the command queue
        so /health can report queue depth."""
        self._queue_ref = queue
        self._queue_lock_ref = lock

    def queue_size(self):
        if self._queue_ref is None:
            return -1
        try:
            with self._queue_lock_ref:
                return len(self._queue_ref)
        except Exception:
            return -1

    def update_heartbeat(self):
        self.last_heartbeat = time.time()
