# logger.py — Thin wrapper around Live's log_message
#
# Live's log_message() is only available after ControlSurface.__init__ runs.
# We store a reference to it here so all modules can call logger.info() etc.
# without having to pass self around.
#
# Output goes to:
#   Windows: %APPDATA%\Ableton\Live x.x\Preferences\Log.txt
#   macOS:   ~/Library/Preferences/Ableton/Live x.x/Log.txt
#
# Each line is prefixed with [Addie] so it's easy to grep.

_log_fn = None

PREFIX = '[Addie]'


def set_log_fn(fn):
    global _log_fn
    _log_fn = fn


def _emit(level, msg):
    line = '{} [{}] {}'.format(PREFIX, level, msg)
    if _log_fn:
        try:
            _log_fn(line)
        except Exception:
            pass
    else:
        # Outside Live (unit tests, static analysis)
        print(line)


def info(msg):
    _emit('INFO', msg)


def error(msg):
    _emit('ERROR', msg)


def debug(msg):
    _emit('DEBUG', msg)
