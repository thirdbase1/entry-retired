#!/usr/bin/env python3
"""One-shot CDP screenshot: launch chromium, load URL, run optional JS, capture PNG.

Used for the Entry product shot: the browser-harness daemon cannot capture
screenshots reliably in this environment, so this drives Chrome's DevTools
Protocol directly over a WebSocket.
"""
import asyncio
import base64
import json
import subprocess
import sys
import time
import urllib.request

import websockets

CHROME = "/home/agentuser/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
PORT = 9333


async def main(url: str, out_path: str, width: int, height: int, setup_js: str, settle: float):
    proc = subprocess.Popen(
        [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--hide-scrollbars",
            f"--user-data-dir=/tmp/cdp-shot-profile-{PORT}",
            f"--window-size={width},{height}",
            f"--remote-debugging-port={PORT}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # Wait for the debugger endpoint.
        target = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=1) as r:
                    targets = json.load(r)
                page = next((t for t in targets if t.get("type") == "page"), None)
                if page:
                    target = page
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if target is None:
            raise RuntimeError("no CDP page target")

        async with websockets.connect(target["webSocketDebuggerUrl"], max_size=64 << 20) as ws:
            counter = 0

            async def cmd(method, **params):
                nonlocal counter
                counter += 1
                msg_id = counter
                await ws.send(json.dumps({"id": msg_id, "method": method, "params": params}))
                while True:
                    raw = json.loads(await ws.recv())
                    if raw.get("id") == msg_id:
                        if "error" in raw:
                            raise RuntimeError(f"{method}: {raw['error']}")
                        return raw.get("result", {})

            await cmd("Page.enable")
            await cmd("Emulation.setDeviceMetricsOverride",
                      width=width, height=height, deviceScaleFactor=2, mobile=False)
            await cmd("Page.navigate", url=url)
            await asyncio.sleep(settle)
            if setup_js:
                await cmd("Runtime.evaluate", expression=setup_js, awaitPromise=False)
                await asyncio.sleep(1.0)
            shot = await cmd("Page.captureScreenshot", format="png", captureBeyondViewport=False)
            with open(out_path, "wb") as f:
                f.write(base64.b64decode(shot["data"]))
            print(f"wrote {out_path}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    url = sys.argv[1]
    out = sys.argv[2]
    w = int(sys.argv[3]) if len(sys.argv) > 3 else 1440
    h = int(sys.argv[4]) if len(sys.argv) > 4 else 900
    setup = sys.argv[5] if len(sys.argv) > 5 else ""
    settle = float(sys.argv[6]) if len(sys.argv) > 6 else 3.0
    asyncio.run(main(url, out, w, h, setup, settle))
