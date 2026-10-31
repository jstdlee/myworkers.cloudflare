#!/usr/bin/env python3
"""LAN monitor agent for the Worker Board.

Pulls the agent-side monitor list from the board, checks each target from
this host (http / tcp / ping), and pushes one heartbeat with all results.
Config: ~/.config/monitor-agent/env with BOARD_URL and MONITOR_SECRET.
"""
import json, os, socket, ssl, subprocess, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"')
    return env

CFG = load_env(os.environ.get("MONITOR_AGENT_ENV", os.path.expanduser("~/.config/monitor-agent/env")))
BOARD = CFG["BOARD_URL"].rstrip("/")
SECRET = CFG["MONITOR_SECRET"]
AGENT = CFG.get("AGENT_NAME", socket.gethostname())
UA = "monitor-agent/1.0"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None

def board(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BOARD + path, data=data, method=method, headers={
        "X-Monitor-Secret": SECRET, "Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def accepted(code, accept):
    for a in accept or ["200-399"]:
        lo, _, hi = str(a).partition("-")
        if int(lo) <= code <= int(hi or lo):
            return True
    return False

def check_http(m):
    ctx = ssl.create_default_context()
    if m.get("insecureTls"):  # e.g. a LAN router with a self-signed certificate
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ctx))
    data = b"" if m.get("method", "GET") in ("POST", "PUT") else None
    req = urllib.request.Request(m["target"], data=data, method=m.get("method", "GET"), headers={"User-Agent": UA})
    try:
        with opener.open(req, timeout=10) as r:
            code = r.status
            body = r.read(65536) if m.get("keyword") else b""
    except urllib.error.HTTPError as e:
        code, body = e.code, b""
    ok = accepted(code, m.get("accept"))
    err = "" if ok else "HTTP %d" % code
    if ok and m.get("keyword") and m["keyword"].encode() not in body:
        ok, err = False, "keyword missing"
    return ok, code, err

def check_tcp(m):
    host, port = m["target"].rsplit(":", 1)
    with socket.create_connection((host, int(port)), timeout=5):
        pass
    return True, None, ""

def check_ping(m):
    r = subprocess.run(["ping", "-c", "2", "-W", "2", m["target"]], capture_output=True, text=True)
    return r.returncode == 0, None, "" if r.returncode == 0 else "no reply"

def run(m):
    t0 = time.monotonic()
    try:
        fn = {"http": check_http, "tcp": check_tcp, "ping": check_ping}[m["type"]]
        ok, code, err = fn(m)
    except Exception as e:
        ok, code, err = False, None, (type(e).__name__ + ": " + str(e))[:200]
    return {"id": m["id"], "ok": ok, "code": code, "ms": round((time.monotonic() - t0) * 1000), "error": err}

def main():
    cfg = board("GET", "/api/monitors/agent/config")
    mons = cfg.get("monitors", [])
    with ThreadPoolExecutor(max_workers=12) as ex:
        results = list(ex.map(run, mons))
    res = board("POST", "/api/monitors/agent/heartbeat", {"agent": AGENT, "results": results})
    up = sum(1 for r in results if r["ok"])
    print("checked %d, up %d, down %d, stored %s" % (len(results), up, len(results) - up, res.get("stored")))
    if "-v" in sys.argv:
        for r in results:
            print(r)

if __name__ == "__main__":
    main()
