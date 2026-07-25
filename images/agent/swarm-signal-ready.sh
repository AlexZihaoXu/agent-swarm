#!/bin/sh
# Tell the terminal supervisor that the claude boot chain has finished its slow
# part (the npm update) and the TUI is about to start.
#
# This exists because "claude is ready" was previously guessed with a fixed
# timer, which loses the boot nudge whenever an update runs long. With this
# signal the supervisor knows the real moment and waits a short settle instead.
#
# Deliberately best-effort and silent: the boot chain calls it with `;`, never
# `&&`, so a missing curl, a supervisor that isn't listening yet, or any other
# failure can never stop claude from launching. Without it the supervisor just
# falls back to its timer, exactly as before.
exec curl -fsS -m 5 -o /dev/null -X POST \
  "http://127.0.0.1:${TERMINALS_PORT:-7681}/api/session-ready" 2>/dev/null || true
