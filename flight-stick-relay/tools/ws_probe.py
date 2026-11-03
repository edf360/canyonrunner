#!/usr/bin/env python3
"""Minimal WebSocket client (stdlib only) to smoke-test the relay server.

Connects to ws://127.0.0.1:8765/ws, reads a few text frames (hello/cfg/state),
sends a ping and an ff message, then exits. Prints PASS/FAIL.
"""
import base64
import json
import os
import socket
import struct
import sys

# bytes read from the socket that follow the HTTP handshake headers and belong
# to the first WS frame(s); consumed by recv_text before doing a new recv().
_leftover = [b""]


def ws_connect(host, port, path="/ws"):
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    s = socket.create_connection((host, port), timeout=5)
    s.sendall(req.encode())
    # read handshake response headers
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            raise RuntimeError("connection closed during handshake")
        buf += chunk
    status_line = buf.split(b"\r\n", 1)[0].decode(errors="replace")
    if "101" not in status_line:
        raise RuntimeError(f"bad handshake: {status_line}")
    # keep any frame bytes that arrived together with the handshake response
    _leftover[0] = buf.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in buf else b""
    return s


def send_text(s, text):
    data = text.encode()
    header = bytearray([0x81])  # FIN + text
    mask = os.urandom(4)
    n = len(data)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header += struct.pack(">H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", n)
    header += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    s.sendall(bytes(header) + masked)


def recv_text(s, timeout=2.0):
    s.settimeout(timeout)
    def rd(n):
        global _leftover
        while len(_leftover[0]) < n:
            c = s.recv(4096)
            if not c:
                raise RuntimeError("closed")
            _leftover[0] += c
        out = _leftover[0][:n]
        _leftover[0] = _leftover[0][n:]
        return out
    b0, b1 = rd(2)
    op = b0 & 0x0F
    ln = b1 & 0x7F
    if ln == 126:
        ln = struct.unpack(">H", rd(2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", rd(8))[0]
    masked = b1 & 0x80
    if masked:
        mask = rd(4)
    data = rd(ln)
    if masked:
        data = bytes(d ^ mask[i % 4] for i, d in enumerate(data))
    return op, data


def main():
    host = "127.0.0.1"
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"[*] connecting ws://{host}:{port}/ws")
    s = ws_connect(host, port)
    print("[+] handshake 101 OK")

    seen = set()
    try:
        for _ in range(8):
            op, data = recv_text(s, timeout=2.0)
            if op != 0x1:
                continue
            try:
                msg = json.loads(data.decode())
            except Exception as pe:
                print(f"[!] JSON parse fail ({pe}) raw[:800]=\n{data[:800]!r}")
                continue
            seen.add(msg.get("t"))
            if msg.get("t") == "hello":
                print("[+] hello:", json.dumps(msg.get("caps", {})))
            elif msg.get("t") == "state":
                print("[+] state:", msg["axes"], "buttons=", msg["buttons"])
                # send ping + ff once we have a state frame
                send_text(s, json.dumps({"t": "ping"}))
                send_text(s, json.dumps(
                    {"t": "ff", "effect": "impact", "intensity": 0.8,
                     "duration_ms": 200}))
                print("[>] sent ping + ff(impact)")
            else:
                print("[<]", msg.get("t"))
            if {"hello", "cfg", "state"}.issubset(seen):
                break
    except Exception as e:
        print(f"[!] recv ended: {e}")

    print(f"[*] seen message types: {sorted(seen)}")
    ok = {"hello", "cfg", "state"}.issubset(seen)
    print("PASS" if ok else "FAIL (missing some message types)")
    s.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
