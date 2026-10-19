"""dexterm bring-your-own-agent — Python SDK (task-1345, tier 2).

A dependency-free client for the dexterm loopback agent bus. Uses only the Python standard library
(socket + hashlib + base64 + json + threading) so a user's Python agent needs nothing installed. It
connects to a running dexterm over 127.0.0.1, authenticates with a registered name + token, lists the
tools its tier allows, calls read/navigation tools, subscribes to live topics, and creates proposals the
user confirms. It can never arm, sign, send or raise a cap — those tools do not exist and the server
refuses the shape.

Auth: pass the token in, read from an env var yourself (DEXTERM_AGENT_TOKEN). NEVER hard-code it and never
put it on a command line. Discovery: the port is read from <home>/agent-bus.json if you do not pass one.

Example:
    import os, json
    from dexterm_agent import connect
    agent = connect(name="scanbot", token=os.environ["DEXTERM_AGENT_TOKEN"])
    print(agent.list_tools())
    rows = agent.call("screener_query", {"preset": "new", "limit": 8})
    agent.subscribe(["new_pairs"], lambda ev: print("event", ev["data"]))
    agent.propose("propose_alert", {"mint": mint, "when": "mcap crosses 1M",
                                    "idempotency_key": "k-" + str(int(time.time()))})
    agent.close()
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


def _discover_port(home: Optional[str]) -> Optional[int]:
    base = home or os.environ.get("DEXTERM_HOME") or str(Path.home() / ".dexterm")
    try:
        data = json.loads((Path(base) / "agent-bus.json").read_text())
        port = data.get("port")
        return int(port) if isinstance(port, int) and port > 0 else None
    except Exception:
        return None


class DextermAgent:
    """A connected bring-your-own-agent session. Not thread-safe for concurrent calls from many threads."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._lock = threading.Lock()
        self._id = 0
        self._recv_buf = b""
        self._listeners: Dict[str, List[Callable[[Dict[str, Any]], None]]] = {}
        self.hello: Dict[str, Any] = {}
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._pending: Dict[int, Any] = {}
        self._events: "list[Dict[str, Any]]" = []
        self._cv = threading.Condition()
        self._closed = False
        self._reader.start()

    # ---- framing (RFC 6455, client side: frames MUST be masked) ----
    def _send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        header = bytearray([0x81])  # FIN + text
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        with self._lock:
            self._sock.sendall(bytes(header) + masked)

    def _read_loop(self) -> None:
        try:
            while True:
                frame = self._read_frame()
                if frame is None:
                    break
                opcode, data = frame
                if opcode == 0x8:  # close
                    break
                if opcode == 0x1:  # text
                    self._on_message(data.decode("utf-8", "replace"))
        except Exception:
            pass
        finally:
            with self._cv:
                self._closed = True
                self._cv.notify_all()

    def _recv_exact(self, n: int) -> bytes:
        while len(self._recv_buf) < n:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise ConnectionError("socket closed")
            self._recv_buf += chunk
        out, self._recv_buf = self._recv_buf[:n], self._recv_buf[n:]
        return out

    def _read_frame(self):
        try:
            b0, b1 = self._recv_exact(2)
        except ConnectionError:
            return None
        opcode = b0 & 0x0F
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8))[0]
        # server frames are not masked
        data = self._recv_exact(length) if length else b""
        return opcode, data

    # ---- JSON-RPC ----
    def _on_message(self, text: str) -> None:
        try:
            msg = json.loads(text)
        except Exception:
            return
        if msg.get("method") == "event":
            ev = msg.get("params") or {}
            for cb in self._listeners.get(ev.get("topic"), []):
                try:
                    cb(ev)
                except Exception:
                    pass
            return
        mid = msg.get("id")
        if isinstance(mid, int):
            with self._cv:
                self._pending[mid] = msg
                self._cv.notify_all()

    def _request(self, method: str, params: Dict[str, Any], timeout: float = 10.0) -> Dict[str, Any]:
        self._id += 1
        mid = self._id
        self._send_text(json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}))
        with self._cv:
            end = threading.TIMEOUT_MAX
            deadline = None
            import time as _t
            deadline = _t.time() + timeout
            while mid not in self._pending and not self._closed:
                remaining = deadline - _t.time()
                if remaining <= 0:
                    raise TimeoutError(f"timed out waiting for {method}")
                self._cv.wait(remaining)
            if mid not in self._pending:
                raise ConnectionError("connection closed")
            msg = self._pending.pop(mid)
        if "error" in msg:
            err = msg["error"]
            raise RuntimeError(err.get("message", "bus error") + (f" [{err.get('data', {}).get('code')}]" if isinstance(err.get("data"), dict) else ""))
        return msg.get("result", {})

    def list_tools(self) -> List[Dict[str, Any]]:
        return self._request("tools/list", {}).get("tools", [])

    def call(self, name: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._request("tools/call", {"name": name, "arguments": args or {}})

    def propose(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        return self.call(name, args)

    def whoami(self) -> Dict[str, Any]:
        return self.call("agent_whoami")

    def on(self, topic: str, cb: Callable[[Dict[str, Any]], None]) -> None:
        self._listeners.setdefault(topic, []).append(cb)

    def subscribe(self, topics: List[str], cb: Optional[Callable[[Dict[str, Any]], None]] = None) -> List[str]:
        if cb:
            for t in topics:
                self.on(t, cb)
        return self.call("subscribe", {"topics": topics}).get("subscribed", [])

    def unsubscribe(self, topics: Optional[List[str]] = None) -> List[str]:
        return self.call("unsubscribe", {"topics": topics} if topics else {}).get("subscribed", [])

    def ping(self) -> bool:
        return self._request("ping", {}).get("pong") is True

    def close(self) -> None:
        try:
            self._sock.close()
        except Exception:
            pass


def connect(name: str, token: str, port: Optional[int] = None, host: str = "127.0.0.1",
            tier: Optional[str] = None, client: str = "python-sdk", home: Optional[str] = None,
            timeout: float = 5.0) -> DextermAgent:
    if port is None:
        port = _discover_port(home)
        if port is None:
            raise RuntimeError("no port given and no agent-bus.json discovery file: is dexterm running with the bus?")
    sock = socket.create_connection((host, port), timeout=timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET / HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(req.encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("server closed during handshake")
        resp += chunk
    if b"101" not in resp.split(b"\r\n", 1)[0]:
        raise ConnectionError("websocket upgrade refused: " + resp.split(b"\r\n", 1)[0].decode("latin1"))
    accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
    if accept.encode() not in resp:
        raise ConnectionError("bad Sec-WebSocket-Accept")
    sock.settimeout(None)
    agent = DextermAgent(sock)
    agent.hello = agent._request("hello", {"name": name, "token": token, "tier": tier, "client": client})
    return agent
