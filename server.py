"""Serveur local de NFC Prospection avec sauvegarde permanente des données."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import urllib.request
import urllib.parse
from datetime import datetime

APP_DIR = Path(__file__).resolve().parent
DATA_FILE = Path(r"C:\Users\Dell\Documents\Projet Google Add\NFC prospection\prospection.json")
LOG_FILE = DATA_FILE.with_name("backlog.json")


def read_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else fallback
    except (OSError, json.JSONDecodeError):
        return fallback


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def event(action, place, details="", **extra):
    return {
        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "action": action,
        "placeId": place.get("placeId", ""),
        "placeName": place.get("name", "Établissement"),
        "address": place.get("address", ""),
        "details": details,
        **extra,
    }


def status_label(status):
    return {"to_visit": "À visiter", "scheduled": "Programmé pour visite", "sold": "Vendu", "refused": "Refusé", "non_compliant": "Non conforme"}.get(status, status or "Inconnu")


def activity_events(previous, current):
    old_places = {place.get("placeId"): place for place in previous.get("places", []) if place.get("placeId")}
    entries = []
    for place in current.get("places", []):
        place_id = place.get("placeId")
        old = old_places.get(place_id)
        if not old:
            entries.append(event("Fiche ajoutée", place, f"Statut initial : {status_label(place.get('status'))}.", status=place.get("status")))
            continue
        new_history = (place.get("visitHistory") or [])[len(old.get("visitHistory") or []):]
        latest = new_history[-1] if new_history else {}
        if old.get("status") != place.get("status"):
            details = f"Statut : {status_label(old.get('status'))} → {status_label(place.get('status'))}."
            if place.get("status") == "sold":
                details += f" Vente : {float(place.get('saleAmount') or 0):.2f} €."
            if latest.get("comment"):
                details += f" Commentaire : {latest['comment']}"
            entries.append(event("Statut modifié", place, details, status=place.get("status"), saleAmount=place.get("saleAmount"), comment=latest.get("comment", "")))
        elif old.get("saleAmount") != place.get("saleAmount"):
            entries.append(event("Montant de vente modifié", place, f"Nouveau montant : {float(place.get('saleAmount') or 0):.2f} €.", saleAmount=place.get("saleAmount")))
        if old.get("status") == place.get("status"):
            for history in new_history:
                if history.get("comment"):
                    entries.append(event("Commentaire ajouté", place, history["comment"], status=history.get("status"), comment=history["comment"]))
    old_quota, new_quota = previous.get("quota") or {}, current.get("quota") or {}
    last_event = new_quota.get("lastEvent") or {}
    for field, api_name in (("places", "Places API"), ("maps", "Maps JavaScript API")):
        difference = int(new_quota.get(field) or 0) - int(old_quota.get(field) or 0)
        if difference > 0:
            activity = last_event.get("activity") if last_event.get("api") == api_name else f"Requête {api_name}"
            entries.append({
                "at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "action": f"Requête Google - {api_name}",
                "placeId": "",
                "placeName": "Google Maps Platform",
                "address": "",
                "details": f"{activity} · {difference} requête{'s' if difference > 1 else ''}.",
                "api": api_name,
                "count": difference,
            })
    return entries


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/state":
            if DATA_FILE.exists():
                try:
                    self.send_json(200, {"state": json.loads(DATA_FILE.read_text(encoding="utf-8"))})
                except (OSError, json.JSONDecodeError):
                    self.send_json(500, {"error": "Le fichier de données est illisible."})
            else:
                self.send_json(200, {"state": None})
            return
        if path == "/api/logs":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                page = max(1, int(query.get("page", ["1"])[0]))
                page_size = min(200, max(10, int(query.get("pageSize", ["50"])[0])))
            except ValueError:
                page, page_size = 1, 50
            logs = list(reversed(read_json(LOG_FILE, [])))
            start = (page - 1) * page_size
            self.send_json(200, {"logs": logs[start:start + page_size], "total": len(logs), "page": page, "pageSize": page_size})
            return
        super().do_GET()

    def do_POST(self):
        if self.path.split("?", 1)[0] == "/api/resolve-link":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                requested_url = json.loads(self.rfile.read(length).decode("utf-8")).get("url", "")
                parsed = urllib.parse.urlparse(requested_url)
                allowed_hosts = ("google.com", "share.google", "maps.app.goo.gl")
                if parsed.scheme not in ("http", "https") or not parsed.hostname or not any(parsed.hostname == host or parsed.hostname.endswith("." + host) for host in allowed_hosts):
                    raise ValueError("Lien Google invalide")
                request = urllib.request.Request(requested_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(request, timeout=12) as response:
                    self.send_json(200, {"url": response.geturl()})
            except (OSError, ValueError, json.JSONDecodeError):
                self.send_json(400, {"error": "Impossible de vérifier ce lien Google."})
            return
        if self.path.split("?", 1)[0] != "/api/state":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload.get("places"), list) or not isinstance(payload.get("quota"), dict):
                raise ValueError("Format invalide")
            previous = read_json(DATA_FILE, {})
            entries = activity_events(previous, payload)
            write_json(DATA_FILE, payload)
            if entries:
                logs = read_json(LOG_FILE, [])
                logs.extend(entries)
                write_json(LOG_FILE, logs)
            self.send_json(200, {"saved": True})
        except (OSError, ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Sauvegarde impossible."})


if __name__ == "__main__":
    print("NFC Prospection est disponible sur http://127.0.0.1:4173/")
    ThreadingHTTPServer(("127.0.0.1", 4173), Handler).serve_forever()
