#!/usr/bin/env python3
"""Notion OAuth login for the project-board mod (its setup dialog runs this; it also runs by hand).

Reads the public integration's client_id/client_secret from ~/.config/notion-board/client.json,
opens Notion's consent page, catches the redirect on localhost, exchanges the code and writes the
access token (mode 600) to the path given as the first argument (default ~/.config/notion-board/token).
Prints {"owner": <Notion user id>, "workspace": <name>} as the last line of stdout. Gives up after 5 minutes.
"""
import base64, json, os, secrets, sys, time, urllib.parse, urllib.request, webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8765
REDIRECT = f"http://localhost:{PORT}/callback"
DIR = os.path.expanduser("~/.config/notion-board")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DIR, "token")
DEADLINE = time.time() + 300

try:
    client = json.load(open(os.path.join(DIR, "client.json")))
except OSError:
    sys.exit(f"No Notion integration: put its client_id and client_secret in {DIR}/client.json")
state = secrets.token_urlsafe(16)
result = {}

PAGE = """<!doctype html><meta charset="utf-8"><title>{title}</title>
<meta name="color-scheme" content="light dark">
<style>
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: light-dark(#f6f6f4, #191919); color: light-dark(#37352f, #e6e6e4); }}
  main {{ text-align: center; padding: 40px 48px; border-radius: 14px; max-width: 360px;
         background: light-dark(#fff, #242424); box-shadow: 0 1px 3px #0000001a, 0 8px 24px #0000000f; }}
  .icon {{ width: 52px; height: 52px; margin: 0 auto 16px; border-radius: 50%; display: grid;
          place-items: center; font-size: 26px; color: #fff; background: {color}; }}
  h1 {{ font-size: 19px; margin: 0 0 6px; }}
  p {{ margin: 0; opacity: .65; }}
</style>
<main><div class="icon">{icon}</div><h1>{title}</h1><p>{body}</p></main>
"""


class Callback(BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        ok = q.get("state") == [state] and "code" in q
        if ok:
            result["code"] = q["code"][0]
        elif "error" in q:
            result["error"] = q["error"][0]
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        page = (
            PAGE.format(title="Notion connected", body="You can close this tab and go back to Herdr.", icon="&#10003;", color="#2e9e5b")
            if ok
            else PAGE.format(title="Login failed", body="Go back to Herdr and try again.", icon="&#10005;", color="#d44c47")
        )
        self.wfile.write(page.encode())

    def log_message(self, *_):
        pass


auth = "https://api.notion.com/v1/oauth/authorize?" + urllib.parse.urlencode(
    {"client_id": client["client_id"], "response_type": "code", "owner": "user", "redirect_uri": REDIRECT, "state": state}
)
server = HTTPServer(("localhost", PORT), Callback)
server.timeout = 5
print(f"Opening Notion. If no browser opens, visit:\n{auth}", file=sys.stderr)
webbrowser.open(auth)
while "code" not in result and "error" not in result:
    if time.time() > DEADLINE:
        sys.exit("Timed out waiting for Notion")
    server.handle_request()
if "error" in result:
    sys.exit(f"Notion said: {result['error']}")

basic = base64.b64encode(f"{client['client_id']}:{client['client_secret']}".encode()).decode()
req = urllib.request.Request(
    "https://api.notion.com/v1/oauth/token",
    data=json.dumps({"grant_type": "authorization_code", "code": result["code"], "redirect_uri": REDIRECT}).encode(),
    headers={"Authorization": f"Basic {basic}", "Content-Type": "application/json"},
)
grant = json.load(urllib.request.urlopen(req))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
    f.write(grant["access_token"])
print(f"Saved token to {OUT}.", file=sys.stderr)
print(json.dumps({"owner": (grant.get("owner") or {}).get("user", {}).get("id"), "workspace": grant.get("workspace_name")}))
