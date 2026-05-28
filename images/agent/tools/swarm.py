#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Swarm agent-communication MCP server.

Lets an agent talk to the other agents in the same swarm. Sending posts to the
gateway, which injects the message into the target agent's terminal as
`[swarm://<sender>] <text>` — the target replies with its own swarm_send.

A minimal Model Context Protocol stdio server (JSON-RPC 2.0 over stdin/stdout,
newline-delimited), stdlib only — no SDK, no deps. Register with:
  uv run /opt/agent-tools/swarm.py   (env SWARM_GATEWAY, SWARM_IDENTITY)
"""

import json
import os
import sys
import urllib.error
import urllib.request

PROTOCOL_VERSION = "2024-11-05"
GATEWAY = os.environ.get("SWARM_GATEWAY", "http://dashboard:8080").rstrip("/")
IDENTITY_FILE = os.environ.get(
    "SWARM_IDENTITY", os.path.expanduser("~/.swarm/identity.json")
)


def _identity() -> dict:
    try:
        with open(IDENTITY_FILE) as f:
            d = json.load(f)
        return {"id": d.get("id"), "name": d.get("name") or d.get("id")}
    except Exception:
        return {"id": None, "name": None}


def _http(method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        GATEWAY + path,
        data=data,
        method=method,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read().decode()
    return json.loads(raw) if raw else None


def _ok(data) -> dict:
    text = data if isinstance(data, str) else json.dumps(data, indent=2)
    return {"content": [{"type": "text", "text": text}]}


def _err(msg: str) -> dict:
    return {"content": [{"type": "text", "text": f"Error: {msg}"}], "isError": True}


def whoami(_args: dict) -> dict:
    return _ok(_identity())


def list_agents(_args: dict) -> dict:
    me = _identity()["id"]
    try:
        agents = _http("GET", "/api/agents") or []
    except Exception as e:  # noqa: BLE001
        return _err(f"could not reach the swarm: {e}")
    out = [
        {"id": a.get("id"), "name": a.get("username") or a.get("id"), "status": a.get("status")}
        for a in agents
        if a.get("id") != me
    ]
    return _ok(out)


def send(args: dict) -> dict:
    to = str(args.get("to") or "").strip()
    text = str(args.get("text") or "").strip()
    if not to or not text:
        return _err("'to' (agent id or name) and 'text' are required")
    me = _identity()
    try:
        _http(
            "POST",
            "/api/swarm/send",
            {"from": me["name"] or me["id"] or "agent", "to": to, "text": text},
        )
    except urllib.error.HTTPError as e:
        return _err(f"HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as e:  # noqa: BLE001
        return _err(str(e))
    return _ok(f"sent to {to}")


TOOLS = [
    ("swarm_whoami", "Your own identity (id + name) within the swarm.", {}, [], whoami),
    (
        "swarm_list_agents",
        "List the other agents in the swarm (id, name, status) you can message.",
        {},
        [],
        list_agents,
    ),
    (
        "swarm_send",
        "Send a message to another agent in the swarm. It arrives in their terminal "
        "as [swarm://you]; they reply with their own swarm_send. Target by agent id or name.",
        {
            "to": {"type": "string", "description": "Target agent id or display name"},
            "text": {"type": "string", "description": "The message to send"},
        },
        ["to", "text"],
        send,
    ),
]
HANDLERS = {name: fn for name, _d, _p, _r, fn in TOOLS}


def _specs() -> list[dict]:
    return [
        {
            "name": n,
            "description": de,
            "inputSchema": {"type": "object", "properties": p, **({"required": r} if r else {})},
        }
        for n, de, p, r, _fn in TOOLS
    ]


def _send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _handle(msg: dict) -> None:
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        ver = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL_VERSION
        _send(
            {
                "jsonrpc": "2.0",
                "id": mid,
                "result": {
                    "protocolVersion": ver,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "swarm", "version": "0.1.0"},
                },
            }
        )
    elif method == "ping":
        _send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "tools/list":
        _send({"jsonrpc": "2.0", "id": mid, "result": {"tools": _specs()}})
    elif method == "tools/call":
        params = msg.get("params") or {}
        fn = HANDLERS.get(params.get("name"))
        if not fn:
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "error": {"code": -32602, "message": f"unknown tool {params.get('name')}"},
                }
            )
            return
        try:
            result = fn(params.get("arguments") or {})
        except Exception as e:  # noqa: BLE001
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
        try:
            _handle(json.loads(line))
        except json.JSONDecodeError:
            continue
        except Exception:  # noqa: BLE001 — never let one bad message kill the server
            pass


if __name__ == "__main__":
    main()
