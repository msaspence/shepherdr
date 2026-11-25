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


class Callback(BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        ok = q.get("state") == [state] and "code" in q
        if ok:
            result["code"] = q["code"][0]
        elif "error" in q:
            result["error"] = q["error"][0]
        self.send_response(200 if ok else 400)
        self.end_headers()
        self.wfile.write(b"Notion connected. You can close this tab and go back to Herdr." if ok else b"Login failed, go back to Herdr.")

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
