#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = ["python-xlib"]
# ///
"""Computer-use MCP server for an agent's X desktop.

A minimal Model Context Protocol stdio server — JSON-RPC 2.0 over
stdin/stdout, newline-delimited, hand-rolled (no MCP SDK). Vision via
ImageMagick `import`; typing via `xdotool`; everything else (smooth
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
import socket
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
from Xlib.ext import xfixes, xtest

PROTOCOL_VERSION = "2025-06-18"

INSTRUCTIONS = (
    "Control this Linux desktop. Coordinates are objects {x, y, sys} where sys is "
    "'low' (720x480), 'medium' (1280x720), or 'full' (native res). **sys is REQUIRED** "
    "on every coordinate (and on move_rel/get_window/get_focused_window) — there is no "
    "default; always state the system your numbers are in, matching the screenshot you "
    "read them from. You may mix systems freely and the tool converts. WORKFLOW: 1) `glance` (low/normal) to "
    "see the screen cheaply and locate UI; 2) `look_at` for pixel-precise work "
    "(dragging, resizing, small targets) — it returns a native crop plus its "
    "full_res origin so a crop pixel (px,py) maps to full coord (origin_x+px, "
    "origin_y+py); 3) act (move/click/type/key); 4) glance/look_at again to verify, "
    "since the screen changes after actions. list_windows gives an overview of "
    "open windows; get_window(id|filter, sys) gives one window's detailed bounds "
    "(in any coordinate system), frame, and state; get_focused_window gives the "
    "same for whatever has keyboard focus (check it before typing); "
    "focus_window/close_window raise or close one. Before a relative move (move_rel), "
    "glance/look_at with cursor:true so you can see where the pointer currently "
    "is; cursor_shape shows the pointer ICON, so you can tell if a hover landed "
    "on a link (hand) or text field (I-beam). Use list_keys for valid key names "
    "(keydown/keyup/press/hotkey). Mouse moves are straight and smoothly eased. "
    "whoami returns your own identity (name/id) within the swarm."
)

# X connection is opened lazily (by _connect, before the first tool call) so the
# server starts cleanly even if the X display isn't up yet at launch.
d = None
_root = None
NATIVE_W = NATIVE_H = 0
SYS_DIMS: dict = {}


class DesktopOffError(RuntimeError):
    """Raised when a display-bound tool is invoked while the agent's desktop
    (tigervnc + GNOME) is off. The dispatcher renders the message verbatim so
    the model gets a clear next step (toggle on, or ask the operator)."""

    pass


def _check_desktop_enabled() -> None:
    """If `~/.swarm/desktop-disabled` exists the systemd condition blocks
    tigervnc + novnc at boot, so there's no X display to connect to. Raise
    a helpful error instead of letting `display.Display()` produce a cryptic
    `DisplayConnectionError: Can't connect to display ":1"`.

    Mentions self-enabling when the agent's role grants `toggle_desktop`;
    falls back to "ask the operator" otherwise."""
    marker = os.path.expanduser("~/.swarm/desktop-disabled")
    if not os.path.exists(marker):
        return
    can_toggle = False
    try:
        with open(os.path.expanduser("~/.swarm/identity.json")) as f:
            ident = json.load(f)
        can_toggle = "toggle_desktop" in (ident.get("permissions") or [])
    except Exception:  # noqa: BLE001
        pass
    if can_toggle:
        raise DesktopOffError(
            "this agent's desktop is OFF — call swarm_toggle_desktop with "
            "enabled=true to start it, then retry the screenshot/click/etc."
        )
    raise DesktopOffError(
        "this agent's desktop is OFF and your role doesn't include the "
        "'toggle own desktop' capability — ask the dashboard operator to "
        "either enable the desktop or grant you toggle_desktop."
    )


def _connect() -> None:
    global d, _root, NATIVE_W, NATIVE_H, SYS_DIMS
    if d is not None:
        return
    _check_desktop_enabled()
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
    # Strict on purpose: no default coordinate system. The agent must say which
    # system its numbers are in (low|medium|full), so a coord read off a `low`
    # glance can't be silently mis-scaled as native. Erroring teaches the shape.
    if not isinstance(c, dict):
        raise ValueError("coordinate must be an object {x, y, sys}")
    for k in ("x", "y", "sys"):
        if k not in c:
            raise ValueError(
                f"coordinate is missing required field {k!r} — pass {{x, y, sys}} "
                "with sys one of low|medium|full (no default; state the system your numbers are in)"
            )
    x, y = c["x"], c["y"]
    if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        raise ValueError("coordinate x and y must be numbers")
    return _to_native(x, y, c["sys"])


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


# --- screenshot scratch dir (shown in the dashboard chat) ------------------
# Captures from glance/look_at (and user `show_image`) are saved here as JPEGs;
# the dashboard chat displays them. Self-managing: capped at 50 MB, cleanup
# kicks in at 90% — recompress oldest hardest, then delete oldest if still over.
SHOTS_DIR = "/tmp/swarm-shots"
SHOT_CAP = 50 * 1024 * 1024
SHOT_THRESH = int(SHOT_CAP * 0.9)


def _enforce_shot_budget() -> None:
    try:
        files = [os.path.join(SHOTS_DIR, f) for f in os.listdir(SHOTS_DIR) if f.endswith(".jpg")]
    except OSError:
        return
    files.sort(key=lambda f: os.path.getmtime(f))  # oldest first
    total = sum(os.path.getsize(f) for f in files)
    if total <= SHOT_THRESH:
        return
    n = max(1, len(files))
    # Re-compress by age tier (oldest crushed hardest); skip user shots (kept
    # near full quality) — they're only removed by deletion below if needed.
    for i, f in enumerate(files):
        if os.path.basename(f).startswith("user_"):
            continue
        frac = i / n
        q = 20 if frac < 0.33 else 40 if frac < 0.66 else 60
        subprocess.run(["convert", f, "-quality", str(q), f], check=False)
    total = sum(os.path.getsize(f) for f in files if os.path.exists(f))
    # Still over → delete oldest until under threshold.
    for f in files:
        if total <= SHOT_THRESH:
            break
        try:
            total -= os.path.getsize(f)
            os.remove(f)
        except OSError:
            pass


def _save_shot(jpeg: bytes, tool: str, user: bool = False) -> str:
    """Write a JPEG to the shots dir, enforce the budget, return its filename."""
    os.makedirs(SHOTS_DIR, exist_ok=True)
    name = f"{'user_' if user else ''}{int(time.time() * 1000)}_{tool}.jpg"
    with open(os.path.join(SHOTS_DIR, name), "wb") as f:
        f.write(jpeg)
    _enforce_shot_budget()
    return name


def _shot_marker(name: str) -> str:
    # The dashboard's transcript parser reads this out of the tool result to
    # render the saved screenshot inline. Harmless text to the model.
    return f" [shot:{name}]"


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
    # Save a full-resolution low-quality JPEG for the dashboard chat.
    shot = _capture(["-quality", "35"], "jpeg")
    if shot:
        note += _shot_marker(_save_shot(shot, "glance"))
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
    # Save the crop as a low-quality JPEG for the dashboard chat.
    jpg = subprocess.run(
        ["convert", "png:-", "-quality", "35", "jpeg:-"], input=png, capture_output=True
    )
    if jpg.returncode == 0 and jpg.stdout:
        note += _shot_marker(_save_shot(jpg.stdout, "look_at"))
    return _image(png, "image/png", note)


def show_image(args: dict) -> dict:
    # Display an image in the dashboard chat at near-full quality. With no path,
    # captures the CURRENT screen full-resolution; with a path, shows that file.
    # Doesn't render in the Claude TUI, but the GUI shows it.
    path = str(args.get("path") or "").strip()
    if path:
        p = os.path.expanduser(path)
        if not os.path.isfile(p):
            return _err(f"no such file: {p}")
        r = subprocess.run(["convert", p, "-quality", "90", "jpeg:-"], capture_output=True)
        if r.returncode != 0 or not r.stdout:
            return _err("could not read image: " + r.stderr.decode("utf-8", "replace")[:200])
        jpeg, label = r.stdout, os.path.basename(p)
    else:
        jpeg = _capture(["-quality", "90"], "jpeg")  # native full-res, near full quality
        if not jpeg:
            return _err("screenshot failed")
        label = "current screen"
    name = _save_shot(jpeg, "image", user=True)
    return _image(jpeg, "image/jpeg", f"Shown in chat: {label}." + _shot_marker(name))


_xfixes_ready = False


def cursor_shape(_args: dict) -> dict:
    # The hardware cursor isn't in screenshots, so read its actual icon via the
    # XFixes extension. `serial` changes whenever the shape changes — compare it
    # across calls to tell if e.g. an arrow became a hand (link) or I-beam (text).
    global _xfixes_ready
    if not _xfixes_ready:
        d.xfixes_query_version()
        _xfixes_ready = True
    ci = d.xfixes_get_cursor_image(_root)
    w, h = int(ci.width), int(ci.height)
    buf = bytearray(w * h * 4)
    for i, p in enumerate(ci.cursor_image):
        a = (p >> 24) & 0xFF
        r, g, b = (p >> 16) & 0xFF, (p >> 8) & 0xFF, p & 0xFF
        if 0 < a < 255:  # XFixes pixels are premultiplied — undo for true colors
            r, g, b = min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a)
        j = i * 4
        buf[j], buf[j + 1], buf[j + 2], buf[j + 3] = r, g, b, a
    scale = max(1, round(160 / max(w, h)))  # upscale so a ~24px cursor is legible
    out = subprocess.run(
        ["convert", "-size", f"{w * scale}x{h * scale}", "xc:#808080",
         "(", "-size", f"{w}x{h}", "-depth", "8", "rgba:-",
         "-filter", "point", "-resize", f"{scale * 100}%", ")",
         "-compose", "over", "-composite", "png:-"],
        input=bytes(buf), capture_output=True,
    )
    if out.returncode != 0 or not out.stdout:
        return _err("cursor render failed: " + out.stderr.decode("utf-8", "replace")[:200])
    note = (
        f"cursor icon — {w}x{h}, hotspot ({ci.xhot},{ci.yhot}), serial {ci.cursor_serial} "
        f"(shown {scale}x on gray). The serial changes whenever the cursor shape changes."
    )
    return _image(out.stdout, "image/png", note)


# --- mouse -----------------------------------------------------------------
def _move_curve(nx: int, ny: int, duration: float | None) -> None:
    sx, sy, _ = _pointer()
    dist = math.hypot(nx - sx, ny - sy)
    if dist < 1:
        _warp(nx, ny)
        return
    dur = duration if duration is not None else min(1.2, max(0.12, dist / 2200))
    steps = max(2, int(dur * 300))  # cap at 300fps
    # Straight point-to-point, but smooth: smootherstep ease-in-out on the path
    # parameter → accelerate out of the start, decelerate into the target.
    for i in range(1, steps + 1):
        u = i / steps
        t = u * u * u * (u * (u * 6 - 15) + 10)
        x = sx + (nx - sx) * t
        y = sy + (ny - sy) * t
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
    if "sys" not in args:
        raise ValueError("move_rel requires 'sys' (low|medium|full) — the system your dx/dy are measured in")
    dnx, dny = _to_native(args["dx"], args["dy"], args["sys"])
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


# --- windows ---------------------------------------------------------------
def list_windows(args: dict) -> dict:
    # EWMH _NET_CLIENT_LIST → each managed top-level window with its title, app
    # class, full_res bounds, and whether it's active. Lets the model target a
    # window precisely (click inside it, look_at its title bar to drag, etc.).
    flt = str(args.get("filter") or "").lower()
    a_clients = d.intern_atom("_NET_CLIENT_LIST")
    a_name = d.intern_atom("_NET_WM_NAME")
    a_active = d.intern_atom("_NET_ACTIVE_WINDOW")
    clients = _root.get_full_property(a_clients, X.AnyPropertyType)
    ids = list(clients.value) if clients else []
    act = _root.get_full_property(a_active, X.AnyPropertyType)
    active_id = int(act.value[0]) if act and len(act.value) else 0
    out = []
    for wid in ids:
        try:
            win = d.create_resource_object("window", wid)
            np = win.get_full_property(a_name, 0)
            title = (
                np.value.decode("utf-8", "replace")
                if np and np.value
                else (win.get_wm_name() or "")
            )
            cls = win.get_wm_class()
            app = cls[1] if cls and len(cls) > 1 else ""
            g = win.get_geometry()
            # python-xlib translate_coords: self is the DESTINATION — root's
            # coords of the window's (0,0) = its absolute screen position.
            t = _root.translate_coords(win, 0, 0)
        except Exception:  # noqa: BLE001 — skip windows that vanish mid-iteration
            continue
        if flt and flt not in f"{title} {app}".lower():
            continue
        out.append({
            "id": str(int(wid)), "title": title, "app": app,
            "x": t.x, "y": t.y, "w": g.width, "h": g.height,
            "active": int(wid) == active_id,
        })
    return _text(json.dumps({"sys": "full", "windows": out}))


def _client_ids() -> tuple[list[int], int]:
    clients = _root.get_full_property(d.intern_atom("_NET_CLIENT_LIST"), X.AnyPropertyType)
    ids = [int(i) for i in clients.value] if clients else []
    act = _root.get_full_property(d.intern_atom("_NET_ACTIVE_WINDOW"), X.AnyPropertyType)
    return ids, (int(act.value[0]) if act and len(act.value) else 0)


def _title_app(win) -> tuple[str, str]:
    np = win.get_full_property(d.intern_atom("_NET_WM_NAME"), 0)
    title = np.value.decode("utf-8", "replace") if np and np.value else (win.get_wm_name() or "")
    cls = win.get_wm_class()
    return title, (cls[1] if cls and len(cls) > 1 else "")


def _window_detail(target: int, active_id: int, sys_name: str) -> dict:
    win = d.create_resource_object("window", target)
    title, app = _title_app(win)
    g = win.get_geometry()
    t = _root.translate_coords(win, 0, 0)
    nx, ny, w, h = t.x, t.y, g.width, g.height
    sw, sh = SYS_DIMS[sys_name]

    st = win.get_full_property(d.intern_atom("_NET_WM_STATE"), X.AnyPropertyType)
    states = set()
    if st:
        for atom in st.value:
            try:
                states.add(d.get_atom_name(atom))
            except Exception:  # noqa: BLE001
                pass
    fr = win.get_full_property(d.intern_atom("_NET_FRAME_EXTENTS"), X.AnyPropertyType)
    frame = list(fr.value) if fr and len(fr.value) >= 4 else [0, 0, 0, 0]
    pidp = win.get_full_property(d.intern_atom("_NET_WM_PID"), X.AnyPropertyType)
    pid = int(pidp.value[0]) if pidp and len(pidp.value) else None

    return _text(json.dumps({
        "id": str(target),
        "title": title,
        "app": app,
        "active": target == active_id,
        "sys": sys_name,
        "bounds": {
            "x": round(nx * sw / NATIVE_W), "y": round(ny * sh / NATIVE_H),
            "w": round(w * sw / NATIVE_W), "h": round(h * sh / NATIVE_H), "sys": sys_name,
        },
        "full_bounds": {"x": nx, "y": ny, "w": w, "h": h},
        "frame": {"left": frame[0], "right": frame[1], "top": frame[2], "bottom": frame[3]},
        "minimized": "_NET_WM_STATE_HIDDEN" in states,
        "maximized": "_NET_WM_STATE_MAXIMIZED_VERT" in states
        and "_NET_WM_STATE_MAXIMIZED_HORZ" in states,
        "fullscreen": "_NET_WM_STATE_FULLSCREEN" in states,
        "pid": pid,
    }))


def get_window(args: dict) -> dict:
    # Detailed info for one window, with bounds in the requested coordinate
    # system. Target it by id (from list_windows), by `filter` (first title/app
    # match), or — if neither is given — the currently active window.
    if "sys" not in args:
        raise ValueError("get_window requires 'sys' (low|medium|full) — the system to report bounds in")
    sys_name = args["sys"]
    if sys_name not in SYS_DIMS:
        raise ValueError(f"unknown coordinate system {sys_name!r} (low|medium|full)")
    ids, active_id = _client_ids()

    target = None
    if args.get("id"):
        wid = int(args["id"])
        target = wid if wid in ids else None
    elif args.get("filter"):
        flt = str(args["filter"]).lower()
        for wid in ids:
            try:
                title, app = _title_app(d.create_resource_object("window", wid))
            except Exception:  # noqa: BLE001
                continue
            if flt in f"{title} {app}".lower():
                target = wid
                break
    else:
        target = active_id if active_id in ids else None
    if not target:
        return _err("no matching window (try list_windows)")
    return _window_detail(target, active_id, sys_name)


def get_focused_window(args: dict) -> dict:
    # The window with keyboard input focus right now (where typing goes), with
    # bounds in the requested sys. Uses the X input focus walked up to its
    # managed top-level window, falling back to the WM's active window.
    if "sys" not in args:
        raise ValueError("get_focused_window requires 'sys' (low|medium|full) — the system to report bounds in")
    sys_name = args["sys"]
    if sys_name not in SYS_DIMS:
        raise ValueError(f"unknown coordinate system {sys_name!r} (low|medium|full)")
    ids, active_id = _client_ids()
    target = 0
    try:
        w = d.get_input_focus().focus
        for _ in range(12):  # walk up the parent chain to a managed client
            if not isinstance(w, int) and int(w.id) in ids:
                target = int(w.id)
                break
            parent = (w.query_tree().parent if not isinstance(w, int) else None)
            if not parent or parent == _root:
                break
            w = parent
    except Exception:  # noqa: BLE001 — fall back to the WM's active window
        pass
    if not target:
        target = active_id if active_id in ids else 0
    if not target:
        return _err("no focused window (try list_windows)")
    return _window_detail(target, active_id, sys_name)


def focus_window(args: dict) -> dict:
    subprocess.run(["xdotool", "windowactivate", "--sync", str(args["id"])])
    return _text(f"focused window {args['id']}")


def close_window(args: dict) -> dict:
    subprocess.run(["xdotool", "windowclose", str(args["id"])])
    return _text(f"closed window {args['id']}")


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


# --- identity --------------------------------------------------------------
def whoami(_args: dict) -> dict:
    # This agent's own identity within the swarm, written to its disk by the
    # gateway at creation (name is editable later from the dashboard).
    info: dict = {}
    try:
        with open(os.path.expanduser("~/.swarm/identity.json")) as f:
            info = json.load(f)
    except Exception:  # noqa: BLE001 — fall back to the hostname
        pass
    info.setdefault("hostname", socket.gethostname())
    info.setdefault("id", info["hostname"])
    info.setdefault("name", info["id"])
    return _text(json.dumps(info))


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
    ("show_image", "Show an image in the dashboard chat at near-full quality — with no args, captures the CURRENT screen full-resolution; with `path`, shows that image file. Use it to share a clear view with the user.",
     {"path": {"type": "string"}}, [], show_image),
    ("move_to", "Move the cursor to a point in a straight line, smoothly (eased).",
     {"pos": COORD, "duration": {"type": "number"}}, ["pos"], move_to),
    ("move_rel", "Move the cursor by (dx, dy) in a coordinate system, straight and smooth (eased).",
     {"dx": {"type": "number"}, "dy": {"type": "number"}, "sys": {"type": "string", "enum": ["low", "medium", "full"]}, "duration": {"type": "number"}},
     ["dx", "dy", "sys"], move_rel),
    ("get_pos", "Current cursor position in all coordinate systems.", {}, [], get_pos),
    ("cursor_shape", "Image of the current mouse-cursor icon (arrow vs hand over a link, I-beam over text, watch while loading). Returns a `serial` that changes whenever the shape changes — useful to confirm a hover landed on a clickable/text target.",
     {}, [], cursor_shape),
    ("click", "Click at the current position. button (default left), num_clicks (default 1), interval seconds between clicks (default 0.15).",
     {"button": BTN, "num_clicks": {"type": "integer"}, "interval": {"type": "number"}}, [], click),
    ("mouse_down", "Press and hold a mouse button.", {"button": BTN}, [], mouse_down),
    ("mouse_up", "Release a mouse button.", {"button": BTN}, [], mouse_up),
    ("get_buttons", "Which mouse buttons are currently held.", {}, [], get_buttons),
    ("list_windows", "List open app windows: each has id, title, app class, full_res bounds {x,y,w,h}, and active flag. Optional case-insensitive `filter` matches title/app. Use get_window for one window's details.",
     {"filter": {"type": "string"}}, [], list_windows),
    ("get_window", "Detailed info for ONE window, with bounds in the requested coordinate system (sys: low|medium|full, required): id, title, app, bounds {x,y,w,h}, full_bounds (native), frame extents (decoration sizes), active/minimized/maximized/fullscreen, pid. Target by id OR filter (first title/app match) OR neither (the active window).",
     {"id": {"type": "string"}, "filter": {"type": "string"}, "sys": {"type": "string", "enum": ["low", "medium", "full"]}}, ["sys"], get_window),
    ("get_focused_window", "Same detail as get_window, but for the window that currently has keyboard focus (where typing goes). Useful to confirm which app/field is focused before typing or sending hotkeys. sys (low|medium|full) is required.",
     {"sys": {"type": "string", "enum": ["low", "medium", "full"]}}, ["sys"], get_focused_window),
    ("focus_window", "Raise and focus a window (by id from list_windows).",
     {"id": {"type": "string"}}, ["id"], focus_window),
    ("close_window", "Close a window (by id from list_windows).",
     {"id": {"type": "string"}}, ["id"], close_window),
    ("keydown", "Press and hold a key.", {"key": {"type": "string"}}, ["key"], keydown),
    ("keyup", "Release a key.", {"key": {"type": "string"}}, ["key"], keyup),
    ("press", "Press and release a key.", {"key": {"type": "string"}}, ["key"], press),
    ("hotkey", "Press a key combo together (e.g. ['ctrl','c']).", {"keys": {"type": "array", "items": {"type": "string"}}}, ["keys"], hotkey),
    ("type", "Type text at cpm chars/minute (default 150).", {"text": {"type": "string"}, "cpm": {"type": "number"}}, ["text"], type_text),
    ("list_keys", "Valid key names for keydown/keyup/press/hotkey.", {}, [], list_keys),
    ("whoami", "This agent's own identity within the swarm: {id, name, hostname, project, timezone}. The name is the human-set display name (editable from the dashboard).",
     {}, [], whoami),
    ("pressed_keys", "Which keys are currently held.", {}, [], pressed_keys),
    ("is_key_pressed", "Whether a specific key is currently held.", {"key": {"type": "string"}}, ["key"], is_key_pressed),
]
HANDLERS = {name: fn for name, _de, _p, _r, fn in TOOLS}
# Tools that don't touch the X display — safe to run even when the agent's
# desktop service is off. Everything else routes through _connect() first.
NO_DISPLAY_TOOLS = {"whoami", "list_keys", "coord_translate"}


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
        name = params.get("name")
        fn = HANDLERS.get(name)
        if not fn:
            _send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"unknown tool {name}"}})
            return
        try:
            # Skip the X handshake for tools that don't touch the display, so
            # introspection (whoami / list_keys / coord_translate) still works
            # when the desktop is off.
            if name not in NO_DISPLAY_TOOLS:
                _connect()  # ensure the X connection is up (idempotent)
            result = fn(params.get("arguments") or {})
        except DesktopOffError as e:
            # No class-name prefix — the message is the whole point.
            result = _err(str(e))
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
