import os
import json
import re
import hashlib
import requests
from functools import lru_cache
from flask import Flask, request, jsonify, send_from_directory
from cachetools import TTLCache
import threading

app = Flask(__name__, static_folder="static")

# ── CONFIG ────────────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL   = "gemini-2.0-flash"
GEMINI_URL     = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
REQUEST_TIMEOUT = 55  # seconds — just under Cloud Run's 60s limit

# ── CACHE ─────────────────────────────────────────────────────────────────────
# TTLCache: max 200 cached trips, each lives for 30 minutes
_cache      = TTLCache(maxsize=200, ttl=1800)
_cache_lock = threading.Lock()

# ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are VOYAGER, an expert AI travel planner. Return ONLY valid JSON, no markdown, no explanation.

Return this exact JSON structure (keep descriptions brief for speed):
{
  "trip_title": "string",
  "destination": "string",
  "summary": "string (1-2 sentences)",
  "highlights": ["string", "string", "string"],
  "estimated_budget": {"accommodation": N, "food": N, "activities": N, "transport": N, "total": N},
  "days": [
    {
      "day": 1,
      "theme": "string",
      "activities": [
        {"time": "09:00", "name": "Place Name", "description": "brief string", "duration": "2 hours", "cost": N, "type": "attraction|food|transport", "tips": "brief tip"}
      ],
      "day_total_cost": N
    }
  ],
  "best_time_to_visit": "string",
  "local_transport": "string"
}"""


# ── HELPERS ───────────────────────────────────────────────────────────────────
def extract_json_from_text(text: str) -> dict:
    """Robustly extract JSON from Gemini response which may contain markdown."""
    text = re.sub(r'```json\s*', '', text)
    text = re.sub(r'```\s*', '', text)
    text = text.strip()
    start = text.find('{')
    end   = text.rfind('}') + 1
    if start != -1 and end > start:
        text = text[start:end]
    return json.loads(text)


def make_cache_key(*args) -> str:
    """Create a deterministic cache key from any set of arguments."""
    raw = json.dumps(args, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()


def call_gemini(prompt: str, api_key: str) -> dict:
    """Call the Gemini API with a single locked model — no retry waterfall."""
    key = api_key or GEMINI_API_KEY
    if not key:
        return {"error": "No Gemini API key provided. Enter your key in Settings."}

    payload = {
        "contents": [{"parts": [{"text": SYSTEM_PROMPT + "\n\nUSER REQUEST:\n" + prompt}]}],
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 2048,   # reduced from 4096 for speed
            "topP": 0.9
        }
    }

    url = f"{GEMINI_URL}?key={key}"
    try:
        resp = requests.post(url, json=payload, timeout=REQUEST_TIMEOUT)
    except requests.Timeout:
        return {"error": "Gemini API timed out after 55 seconds. Please try again."}
    except requests.ConnectionError:
        return {"error": "Could not reach Gemini API. Check your network connection."}

    if resp.status_code != 200:
        err = resp.json().get("error", {})
        return {"error": f"Gemini API error {resp.status_code}: {err.get('message', resp.text[:200])}"}

    try:
        data     = resp.json()
        raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
        return extract_json_from_text(raw_text)
    except (KeyError, IndexError) as e:
        return {"error": f"Unexpected Gemini response structure: {str(e)}"}
    except json.JSONDecodeError as e:
        return {"error": f"Gemini returned invalid JSON: {str(e)}"}


# ── ROUTES ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/static/<path:path>")
def serve_static(path):
    return send_from_directory("static", path)


@app.route("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "service": "VOYAGER AI",
        "model": GEMINI_MODEL,
        "gemini_configured": bool(GEMINI_API_KEY),
        "cache_size": len(_cache),
        "cache_maxsize": _cache.maxsize
    })


@app.route("/api/plan", methods=["POST"])
def plan_trip():
    data        = request.json or {}
    destination = str(data.get("destination", "")).strip()[:100]   # max 100 chars
    days        = max(1, min(int(data.get("days", 5)), 14))        # clamp 1-14
    travelers   = max(1, min(int(data.get("travelers", 2)), 20))   # clamp 1-20
    budget      = max(100, min(int(data.get("budget", 2000)), 100000))
    preferences = [str(p)[:50] for p in (data.get("preferences") or [])[:5]]
    api_key     = str(data.get("api_key", "")).strip()

    if not destination:
        return jsonify({"error": "Destination is required"}), 400

    # ── Cache lookup ──────────────────────────────────────────────
    cache_key = make_cache_key(destination.lower(), days, travelers, budget, sorted(preferences))
    with _cache_lock:
        cached = _cache.get(cache_key)
    if cached:
        return jsonify({**cached, "_cached": True})

    # ── Call Gemini ───────────────────────────────────────────────
    prompt = (
        f"Plan a {days}-day trip to {destination} for {travelers} traveler(s) "
        f"with a total budget of ${budget} USD. "
        f"Travel preferences: {', '.join(preferences) if preferences else 'balanced mix of culture, food, and sightseeing'}. "
        "Include real place names, realistic costs, and practical tips."
    )

    result = call_gemini(prompt, api_key)

    if "error" not in result:
        with _cache_lock:
            _cache[cache_key] = result

    status = 500 if "error" in result else 200
    return jsonify(result), status


@app.route("/api/modify", methods=["POST"])
def modify_trip():
    data         = request.json or {}
    current      = data.get("current_itinerary", {})
    modification = str(data.get("modification", "")).strip()[:300]  # max 300 chars
    api_key      = str(data.get("api_key", "")).strip()

    if not modification:
        return jsonify({"error": "Modification request is required"}), 400
    if not current:
        return jsonify({"error": "No current itinerary to modify"}), 400

    # Send only destination + days summary (not full JSON) to save tokens
    compact = {
        "trip_title":       current.get("trip_title"),
        "destination":      current.get("destination"),
        "estimated_budget": current.get("estimated_budget"),
        "days": [
            {"day": d.get("day"), "theme": d.get("theme"), "activities": d.get("activities", [])[:4]}
            for d in (current.get("days") or [])
        ]
    }

    prompt = (
        f"CURRENT ITINERARY (compact):\n{json.dumps(compact)}\n\n"
        f"USER MODIFICATION REQUEST: {modification}\n\n"
        "Update the itinerary JSON based on the request. Keep the full JSON structure. "
        "Only change what is necessary."
    )

    result = call_gemini(prompt, api_key)
    status = 500 if "error" in result else 200
    return jsonify(result), status


@app.route("/api/cache/clear", methods=["POST"])
def clear_cache():
    """Admin endpoint to clear the response cache."""
    with _cache_lock:
        _cache.clear()
    return jsonify({"status": "cache cleared"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
