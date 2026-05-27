#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = ["python-xlib"]
# ///
"""Computer-use MCP server for an agent's X desktop.

A minimal Model Context Protocol stdio server — JSON-RPC 2.0 over
stdin/stdout, newline-delimited, hand-rolled (no MCP SDK). Vision via
ImageMagick `import`; typing via `xdotool`; everything else (smooth bezier
motion, button/key synthesis, and querying which buttons/keys are currently
held) via the X protocol through python-xlib + XTEST.

Coordinates are {x, y, sys} where sys is one of:
  low    720x480     medium  1280x720     full  native resolution
The tool translates between systems internally, so you can mix them (e.g.
look_at a `medium` point, then move_to a `full` point read off the crop).

Register with:
  claude mcp add -e DISPLAY=:1 computer-use -- uv run /opt/agent-tools/computer_use.py
"""

import base64
import json
import math
import os
import subprocess
import sys
import time

_DEBUG = os.environ.get("CU_DEBUG")


def _log(tag: str, s: str) -> None:
    if _DEBUG:
        try:
            with open(_DEBUG, "a") as f:
                f.write(f"{tag} {s}\n")
        except OSError:
            pass

from Xlib import X, XK, display
from Xlib.ext import xtest

PROTOCOL_VERSION = "2025-06-18"

INSTRUCTIONS = (
    "Control this Linux desktop. Coordinates are objects {x, y, sys} where sys is "
    "'low' (720x480), 'medium' (1280x720), or 'full' (native res); you may mix "
    "systems freely and the tool converts. WORKFLOW: 1) `glance` (low/normal) to "
    "see the screen cheaply and locate UI; 2) `look_at` for pixel-precise work "
    "(dragging, resizing, small targets) — it returns a native crop plus its "
    "full_res origin so a crop pixel (px,py) maps to full coord (origin_x+px, "
    "origin_y+py); 3) act (move/click/type/key); 4) glance/look_at again to verify, "
    "since the screen changes after actions. Before a relative move (move_rel), "
    "glance/look_at with cursor:true so you can see where the pointer currently "
    "is. Use list_keys for valid key names (keydown/keyup/press/hotkey). Mouse "
    "moves follow a smooth ease-in-out curve automatically."
)

# X connection is opened lazily (by _connect, before the first tool call) so the
# server starts cleanly even if the X display isn't up yet at launch.
d = None
_root = None
NATIVE_W = NATIVE_H = 0
SYS_DIMS: dict = {}


def _connect() -> None:
    global d, _root, NATIVE_W, NATIVE_H, SYS_DIMS
    if d is not None:
        return
    d = display.Display()
    _root = d.screen().root
    g = _root.get_geometry()
    NATIVE_W, NATIVE_H = int(g.width), int(g.height)
    SYS_DIMS = {"low": (720, 480), "medium": (1280, 720), "full": (NATIVE_W, NATIVE_H)}


BUTTONS = {"left": 1, "middle": 2, "right": 3}
BUTTON_MASKS = {"left": X.Button1Mask, "middle": X.Button2Mask, "right": X.Button3Mask}

# Friendly key aliases → X keysym names (xdotool/X11 names otherwise pass through).
KEY_ALIASES = {
    "ctrl": "Control_L", "control": "Control_L", "alt": "Alt_L", "option": "Alt_L",
    "shift": "Shift_L", "super": "Super_L", "win": "Super_L", "cmd": "Super_L", "meta": "Super_L",
    "enter": "Return", "return": "Return", "esc": "Escape", "escape": "Escape",
    "space": "space", "tab": "Tab", "backspace": "BackSpace", "delete": "Delete", "del": "Delete",
    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next",
    "capslock": "Caps_Lock", "insert": "Insert",
}
LISTED_KEYS = sorted(
    set(KEY_ALIASES)
    | {chr(c) for c in range(ord("a"), ord("z") + 1)}
    | {str(n) for n in range(10)}
    | {f"f{n}" for n in range(1, 13)}
    | {"Return", "Escape", "Tab", "space", "BackSpace", "Delete", "Up", "Down", "Left", "Right",
       "Home", "End", "Prior", "Next", "Control_L", "Alt_L", "Shift_L", "Super_L"}
)


def _keycode(name: str) -> int:
    sym = XK.string_to_keysym(KEY_ALIASES.get(name.lower(), name))
    if not sym:
        sym = XK.string_to_keysym(name.capitalize())
    code = d.keysym_to_keycode(sym) if sym else 0
    if not code:
        raise ValueError(f"unknown key: {name!r} (see list_keys)")
    return code


def _to_native(x: float, y: float, sys: str) -> tuple[int, int]:
    if sys not in SYS_DIMS:
        raise ValueError(f"unknown coordinate system {sys!r} (low|medium|full)")
    sw, sh = SYS_DIMS[sys]
    return round(x * NATIVE_W / sw), round(y * NATIVE_H / sh)


def _from_native(nx: int, ny: int, sys: str) -> dict:
    sw, sh = SYS_DIMS[sys]
    return {"x": round(nx * sw / NATIVE_W), "y": round(ny * sh / NATIVE_H), "sys": sys}


def _coord(c: dict) -> tuple[int, int]:
    return _to_native(c["x"], c["y"], c.get("sys", "full"))


def _pointer() -> tuple[int, int, int]:
    p = _root.query_pointer()
    return p.root_x, p.root_y, p.mask


def _warp(nx: int, ny: int) -> None:
    xtest.fake_input(d, X.MotionNotify, x=int(nx), y=int(ny))
    d.sync()


# --- vision ----------------------------------------------------------------
def _capture(args: list[str], fmt: str) -> bytes | None:
    r = subprocess.run(["import", "-silent", "-window", "root", *args, f"{fmt}:-"], capture_output=True)
    return r.stdout if r.returncode == 0 and r.stdout else None


def _overlay_cursor(data: bytes, fmt: str, mx: int, my: int) -> bytes:
    # `import` doesn't capture the hardware cursor, so draw a marker (ring +
    # crosshair) at the pointer position, with a white halo for visibility.
    marker = (
        f"circle {mx},{my} {mx},{my + 8} "
        f"line {mx - 13},{my} {mx + 13},{my} line {mx},{my - 13} {mx},{my + 13}"
    )
    r = subprocess.run(
        ["convert", "-", "-fill", "none",
         "-stroke", "white", "-strokewidth", "4", "-draw", marker,
         "-stroke", "red", "-strokewidth", "2", "-draw", marker, f"{fmt}:-"],
        input=data, capture_output=True,
    )
    return r.stdout if r.returncode == 0 and r.stdout else data


def _image(data: bytes, mime: str, note: str) -> dict:
    return {
        "content": [
            {"type": "text", "text": note},
            {"type": "image", "data": base64.b64encode(data).decode(), "mimeType": mime},
        ]
    }


def glance(args: dict) -> dict:
    # JPEG keeps polling cheap; precision happens in look_at (lossless PNG).
    detail = args.get("detail", "normal")
    sys_name = "low" if detail == "low" else "medium"
    w, h = SYS_DIMS[sys_name]
    img = _capture(["-resize", f"{w}x{h}!", "-quality", "60"], "jpeg")
    if not img:
        return _err("screenshot failed")
    note = f"glance {detail} — {w}x{h}, coordinate system '{sys_name}'."
    if args.get("cursor"):
        nx, ny, _ = _pointer()
        img = _overlay_cursor(img, "jpeg", round(nx * w / NATIVE_W), round(ny * h / NATIVE_H))
        note += " Cursor marked (red crosshair)."
    return _image(img, "image/jpeg", note)


LOOK_MIN, LOOK_MAX = 128, 1024


def look_at(args: dict) -> dict:
    cx, cy = _coord(args["center"])
    rw, rh = int(args.get("w", 256)), int(args.get("h", 256))
    w = max(LOOK_MIN, min(LOOK_MAX, rw))
    h = max(LOOK_MIN, min(LOOK_MAX, rh))
    x0, y0 = cx - w // 2, cy - h // 2
    # Clip to the screen, note if we had to.
    cx0, cy0 = max(0, x0), max(0, y0)
    cx1, cy1 = min(NATIVE_W, x0 + w), min(NATIVE_H, y0 + h)
    cw, ch = cx1 - cx0, cy1 - cy0
    if cw <= 0 or ch <= 0:
        return _err("look_at region is fully off-screen")
    png = _capture(["-crop", f"{cw}x{ch}+{cx0}+{cy0}", "+repage"], "png")
    if not png:
        return _err("screenshot failed")
    note = (
        f"look_at — full_res region origin=({cx0},{cy0}) size={cw}x{ch}. "
        f"Pixel (px,py) in this crop is full coord ({cx0}+px, {cy0}+py)."
    )
    warns = []
    if (w, h) != (rw, rh):
        warns.append(f"size clamped to {w}x{h} (allowed {LOOK_MIN}..{LOOK_MAX})")
    if (cx0, cy0, cw, ch) != (x0, y0, w, h):
        warns.append("clipped to screen bounds")
    if warns:
        note = "WARNING: " + "; ".join(warns) + ". " + note
    if args.get("cursor"):
        nx, ny, _ = _pointer()
        if cx0 <= nx < cx0 + cw and cy0 <= ny < cy0 + ch:
            png = _overlay_cursor(png, "png", nx - cx0, ny - cy0)
            note += " Cursor marked (red crosshair)."
        else:
            note += " (cursor is outside this region)"
    return _image(png, "image/png", note)


# --- mouse -----------------------------------------------------------------
def _move_curve(nx: int, ny: int, duration: float | None) -> None:
    sx, sy, _ = _pointer()
    dist = math.hypot(nx - sx, ny - sy)
    if dist < 1:
        _warp(nx, ny)
        return
    dur = duration if duration is not None else min(1.2, max(0.12, dist / 2200))
    steps = max(2, int(dur * 300))  # cap at 300fps
    # Quadratic bezier with a perpendicular bow for human-like motion.
    mx, my = (sx + nx) / 2, (sy + ny) / 2
    bow = min(dist * 0.18, 120)
    px, py = -(ny - sy) / dist, (nx - sx) / dist
    side = 1 if (int(nx) + int(ny)) % 2 else -1
    cxp, cyp = mx + px * bow * side, my + py * bow * side
    for i in range(1, steps + 1):
        # Smootherstep ease-in-out on the path parameter → the cursor
        # accelerates out of the start and decelerates into the target.
        u = i / steps
        t = u * u * u * (u * (u * 6 - 15) + 10)
        x = (1 - t) ** 2 * sx + 2 * (1 - t) * t * cxp + t * t * nx
        y = (1 - t) ** 2 * sy + 2 * (1 - t) * t * cyp + t * t * ny
        _warp(round(x), round(y))
        time.sleep(dur / steps)
    _warp(nx, ny)


def _bounds_warn(nx: int, ny: int) -> str:
    if 0 <= nx < NATIVE_W and 0 <= ny < NATIVE_H:
        return ""
    return (
        f" WARNING: target ({nx},{ny}) is off-screen "
        f"[0..{NATIVE_W - 1}]x[0..{NATIVE_H - 1}] — clamped by X."
    )


def move_to(args: dict) -> dict:
    nx, ny = _coord(args["pos"])
    _move_curve(nx, ny, args.get("duration"))
    return _text(f"moved to full ({nx},{ny})." + _bounds_warn(nx, ny))


def move_rel(args: dict) -> dict:
    sx, sy, _ = _pointer()
    dnx, dny = _to_native(args["dx"], args["dy"], args.get("sys", "full"))
    # _to_native scales as if from origin — that's exactly the delta scale.
    tx, ty = sx + dnx, sy + dny
    _move_curve(tx, ty, args.get("duration"))
    return _text(f"moved by full ({dnx},{dny}) to ({tx},{ty})." + _bounds_warn(tx, ty))


def get_pos(_args: dict) -> dict:
    nx, ny, _ = _pointer()
    return _text(json.dumps({s: _from_native(nx, ny, s) for s in SYS_DIMS}))


def click(args: dict) -> dict:
    btn = BUTTONS[args.get("button", "left")]
    n = int(args.get("num_clicks", 1))
    interval = float(args.get("interval", 0.15))
    for i in range(n):
        xtest.fake_input(d, X.ButtonPress, btn)
        xtest.fake_input(d, X.ButtonRelease, btn)
        d.sync()
        if i < n - 1:
            time.sleep(interval)
    return _text(f"{args.get('button', 'left')} x{n}")


def mouse_down(args: dict) -> dict:
    xtest.fake_input(d, X.ButtonPress, BUTTONS[args.get("button", "left")])
    d.sync()
    return _text(f"{args.get('button', 'left')} down")


def mouse_up(args: dict) -> dict:
    xtest.fake_input(d, X.ButtonRelease, BUTTONS[args.get("button", "left")])
    d.sync()
    return _text(f"{args.get('button', 'left')} up")


def get_buttons(_args: dict) -> dict:
    _, _, mask = _pointer()
    held = [name for name, m in BUTTON_MASKS.items() if mask & m]
    return _text(json.dumps(held))


# --- keyboard --------------------------------------------------------------
def keydown(args: dict) -> dict:
    xtest.fake_input(d, X.KeyPress, _keycode(args["key"]))
    d.sync()
    return _text(f"keydown {args['key']}")


def keyup(args: dict) -> dict:
    xtest.fake_input(d, X.KeyRelease, _keycode(args["key"]))
    d.sync()
    return _text(f"keyup {args['key']}")


def press(args: dict) -> dict:
    kc = _keycode(args["key"])
    xtest.fake_input(d, X.KeyPress, kc)
    xtest.fake_input(d, X.KeyRelease, kc)
    d.sync()
    return _text(f"press {args['key']}")


def hotkey(args: dict) -> dict:
    keys = args["keys"]
    codes = [_keycode(k) for k in keys]
    for c in codes:
        xtest.fake_input(d, X.KeyPress, c)
    for c in reversed(codes):
        xtest.fake_input(d, X.KeyRelease, c)
    d.sync()
    return _text("hotkey " + "+".join(keys))


def type_text(args: dict) -> dict:
    cpm = float(args.get("cpm", 150))
    delay_ms = max(0, round(60000 / cpm)) if cpm > 0 else 0
    subprocess.run(
        ["xdotool", "type", "--clearmodifiers", "--delay", str(delay_ms), "--", str(args["text"])]
    )
    return _text("typed")


def _pressed_keycodes() -> list[int]:
    bits = d.query_keymap()
    out = []
    for byte_i, byte in enumerate(bits):
        for bit in range(8):
            if byte & (1 << bit):
                out.append(byte_i * 8 + bit)
    return out


def _keycode_name(kc: int) -> str | None:
    sym = d.keycode_to_keysym(kc, 0)
    return XK.keysym_to_string(sym) if sym else None


def pressed_keys(_args: dict) -> dict:
    names = [n for kc in _pressed_keycodes() if (n := _keycode_name(kc))]
    return _text(json.dumps(names))


def is_key_pressed(args: dict) -> dict:
    target = _keycode(args["key"])
    return _text(json.dumps(target in _pressed_keycodes()))


def list_keys(_args: dict) -> dict:
    return _text(json.dumps(LISTED_KEYS))


# --- registry --------------------------------------------------------------
def _text(s: str) -> dict:
    return {"content": [{"type": "text", "text": s or "ok"}]}


def _err(s: str) -> dict:
    return {"content": [{"type": "text", "text": s}], "isError": True}


COORD = {
    "type": "object",
    "properties": {
        "x": {"type": "number"},
        "y": {"type": "number"},
        "sys": {"type": "string", "enum": ["low", "medium", "full"]},
    },
    "required": ["x", "y", "sys"],
}
BTN = {"type": "string", "enum": ["left", "middle", "right"]}

# (name, description, inputSchema-properties, required, handler)
TOOLS = [
    ("glance", "Screenshot for polling/coarse tasks. detail 'low' (720x480, system 'low') or 'normal' (1280x720, system 'medium'). Set cursor:true to mark the pointer (useful before move_rel).",
     {"detail": {"type": "string", "enum": ["low", "normal"]}, "cursor": {"type": "boolean"}}, [], glance),
    ("look_at", "Native-resolution crop centered on a point, for precision (dragging/resizing). Returns the crop + its full_res origin. Uses the 'full' coordinate system. w/h default 256, clamped to 128..1024. cursor:true marks the pointer.",
     {"center": COORD, "w": {"type": "integer"}, "h": {"type": "integer"}, "cursor": {"type": "boolean"}}, ["center"], look_at),
    ("move_to", "Move the cursor to a point along a smooth curve.",
     {"pos": COORD, "duration": {"type": "number"}}, ["pos"], move_to),
    ("move_rel", "Move the cursor by (dx, dy) in a coordinate system, along a smooth curve.",
     {"dx": {"type": "number"}, "dy": {"type": "number"}, "sys": {"type": "string", "enum": ["low", "medium", "full"]}, "duration": {"type": "number"}},
     ["dx", "dy"], move_rel),
    ("get_pos", "Current cursor position in all coordinate systems.", {}, [], get_pos),
    ("click", "Click at the current position. button (default left), num_clicks (default 1), interval seconds between clicks (default 0.15).",
     {"button": BTN, "num_clicks": {"type": "integer"}, "interval": {"type": "number"}}, [], click),
    ("mouse_down", "Press and hold a mouse button.", {"button": BTN}, [], mouse_down),
    ("mouse_up", "Release a mouse button.", {"button": BTN}, [], mouse_up),
    ("get_buttons", "Which mouse buttons are currently held.", {}, [], get_buttons),
    ("keydown", "Press and hold a key.", {"key": {"type": "string"}}, ["key"], keydown),
    ("keyup", "Release a key.", {"key": {"type": "string"}}, ["key"], keyup),
    ("press", "Press and release a key.", {"key": {"type": "string"}}, ["key"], press),
    ("hotkey", "Press a key combo together (e.g. ['ctrl','c']).", {"keys": {"type": "array", "items": {"type": "string"}}}, ["keys"], hotkey),
    ("type", "Type text at cpm chars/minute (default 150).", {"text": {"type": "string"}, "cpm": {"type": "number"}}, ["text"], type_text),
    ("list_keys", "Valid key names for keydown/keyup/press/hotkey.", {}, [], list_keys),
    ("pressed_keys", "Which keys are currently held.", {}, [], pressed_keys),
    ("is_key_pressed", "Whether a specific key is currently held.", {"key": {"type": "string"}}, ["key"], is_key_pressed),
]
HANDLERS = {name: fn for name, _de, _p, _r, fn in TOOLS}


def _specs() -> list[dict]:
    return [
        {"name": n, "description": de, "inputSchema": {"type": "object", "properties": p, **({"required": r} if r else {})}}
        for n, de, p, r, _fn in TOOLS
    ]


def _send(obj: dict) -> None:
    line = json.dumps(obj)
    _log("OUT", line)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _handle(msg: dict) -> None:
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        ver = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL_VERSION
        _send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": ver, "capabilities": {"tools": {}},
            "serverInfo": {"name": "computer-use", "version": "0.1.0"},
            "instructions": INSTRUCTIONS}})
    elif method == "ping":
        _send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "tools/list":
        _send({"jsonrpc": "2.0", "id": mid, "result": {"tools": _specs()}})
    elif method == "tools/call":
        params = msg.get("params") or {}
        fn = HANDLERS.get(params.get("name"))
        if not fn:
            _send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"unknown tool {params.get('name')}"}})
            return
        try:
            _connect()  # ensure the X connection is up (idempotent)
            result = fn(params.get("arguments") or {})
        except Exception as e:  # noqa: BLE001 — surface failures to the model
            result = _err(f"{type(e).__name__}: {e}")
        _send({"jsonrpc": "2.0", "id": mid, "result": result})
    elif method and method.startswith("notifications/"):
        pass
    elif mid is not None:
        _send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}})


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        _log("IN", line)
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            _handle(msg)
        except Exception as e:  # noqa: BLE001 — never let one bad message kill the server
            _log("ERR", f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
