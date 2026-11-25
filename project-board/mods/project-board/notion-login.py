#!/usr/bin/env python3
"""One-time Notion OAuth login for the project-board mod.

Reads the public integration's client_id/client_secret from ~/.config/notion-board/client.json,
opens Notion's consent page, catches the redirect on localhost, exchanges the code and writes
the access token to ~/.config/notion-board/token (where the mod reads it).
"""
import base64, json, os, secrets, sys, urllib.parse, urllib.request, webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8765
REDIRECT = f"http://localhost:{PORT}/callback"
DIR = os.path.expanduser("~/.config/notion-board")

client = json.load(open(os.path.join(DIR, "client.json")))
state = secrets.token_urlsafe(16)
result = {}


class Callback(BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        ok = q.get("state") == [state] and "code" in q
        if ok:
            result["code"] = q["code"][0]
        self.send_response(200 if ok else 400)
        self.end_headers()
        self.wfile.write(b"Notion board connected. You can close this tab." if ok else b"Login failed, see terminal.")

    def log_message(self, *_):
        pass


auth = "https://api.notion.com/v1/oauth/authorize?" + urllib.parse.urlencode(
    {"client_id": client["client_id"], "response_type": "code", "owner": "user", "redirect_uri": REDIRECT, "state": state}
)
print(f"Opening Notion. Pick the Tech Tasks database when asked.\nIf no browser opens, visit:\n{auth}")
webbrowser.open(auth)
server = HTTPServer(("localhost", PORT), Callback)
while "code" not in result:
    server.handle_request()

basic = base64.b64encode(f"{client['client_id']}:{client['client_secret']}".encode()).decode()
req = urllib.request.Request(
    "https://api.notion.com/v1/oauth/token",
    data=json.dumps({"grant_type": "authorization_code", "code": result["code"], "redirect_uri": REDIRECT}).encode(),
    headers={"Authorization": f"Basic {basic}", "Content-Type": "application/json"},
)
token = json.load(urllib.request.urlopen(req))["access_token"]
path = os.path.join(DIR, "token")
with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
    f.write(token)
print(f"Saved token to {path}. The board picks it up within a minute.")
sys.exit(0)
