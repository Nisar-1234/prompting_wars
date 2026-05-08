import os
import json
import re
import requests
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__, static_folder="static")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1"
GEMINI_MODEL = "gemini-1.5-flash"
GEMINI_URL = f"{GEMINI_BASE}/models/{GEMINI_MODEL}:generateContent"

SYSTEM_PROMPT = """You are VOYAGER, an expert AI travel planner. Always return ONLY valid JSON, no markdown, no explanation.

When planning a trip, return this exact JSON structure:
{
  "trip_title": "string",
  "destination": "string",
  "summary": "string (2-3 sentences about the trip)",
  "highlights": ["string", "string", "string"],
  "estimated_budget": {
    "accommodation": number,
    "food": number,
    "activities": number,
    "transport": number,
    "total": number
  },
  "days": [
    {
      "day": 1,
      "theme": "string",
      "activities": [
        {
          "time": "09:00",
          "name": "Place Name",
          "description": "string",
          "duration": "2 hours",
          "cost": number,
          "type": "attraction|food|transport|accommodation",
          "tips": "string"
        }
      ],
      "day_total_cost": number
    }
  ],
  "packing_tips": ["string"],
  "best_time_to_visit": "string",
  "local_transport": "string"
}"""


def extract_json_from_text(text: str) -> dict:
    """Robustly extract JSON from Gemini response which may contain markdown."""
    # Strip markdown code fences
    text = re.sub(r'```json\s*', '', text)
    text = re.sub(r'```\s*', '', text)
    text = text.strip()
    # Find outermost JSON object
    start = text.find('{')
    end = text.rfind('}') + 1
    if start != -1 and end > start:
        text = text[start:end]
    return json.loads(text)


def call_gemini(prompt: str, api_key: str) -> dict:
    key = api_key or GEMINI_API_KEY
    if not key:
        return {"error": "No Gemini API key provided"}

    # Models confirmed available for this API key (via ListModels)
    models_to_try = [
        "gemini-2.0-flash",
        "gemini-2.5-flash",
        "gemini-2.0-flash-lite",
        "gemini-flash-latest",
    ]

    payload = {
        "contents": [{"parts": [{"text": SYSTEM_PROMPT + "\n\nUSER REQUEST:\n" + prompt}]}],
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 8192}
    }

    last_error = ""
    for model in models_to_try:
        for api_version in ["v1beta", "v1"]:
            url = f"https://generativelanguage.googleapis.com/{api_version}/models/{model}:generateContent?key={key}"
            try:
                resp = requests.post(url, json=payload, timeout=60)
                if resp.status_code == 200:
                    data = resp.json()
                    raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
                    return extract_json_from_text(raw_text)
                last_error = f"{model} ({api_version}): {resp.status_code} - {resp.text[:200]}"
            except json.JSONDecodeError as e:
                last_error = f"JSON parse error with {model}: {str(e)}"
                continue
            except Exception as e:
                last_error = f"{model} ({api_version}): {str(e)}"
                continue

    return {"error": f"All models failed. Last error: {last_error}"}


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/static/<path:path>")
def serve_static(path):
    return send_from_directory("static", path)


@app.route("/api/plan", methods=["POST"])
def plan_trip():
    data = request.json or {}
    destination = data.get("destination", "")
    days = data.get("days", 5)
    travelers = data.get("travelers", 2)
    budget = data.get("budget", 2000)
    preferences = data.get("preferences", [])
    api_key = data.get("api_key", "")

    if not destination:
        return jsonify({"error": "Destination is required"}), 400

    prompt = f"""Plan a {days}-day trip to {destination} for {travelers} traveler(s) with a total budget of ${budget} USD.
Travel preferences: {', '.join(preferences) if preferences else 'balanced mix of culture, food, and sightseeing'}.
Include real place names, realistic costs, and practical tips."""

    try:
        result = call_gemini(prompt, api_key)
        return jsonify(result)
    except json.JSONDecodeError as e:
        return jsonify({"error": f"Failed to parse AI response: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/modify", methods=["POST"])
def modify_trip():
    data = request.json or {}
    current = data.get("current_itinerary", {})
    modification = data.get("modification", "")
    api_key = data.get("api_key", "")

    if not modification:
        return jsonify({"error": "Modification request is required"}), 400

    prompt = f"""CURRENT ITINERARY:
{json.dumps(current, indent=2)}

USER MODIFICATION REQUEST: {modification}

Update the itinerary based on the user's request. Keep the same JSON structure.
Only change what is necessary. Preserve the overall trip if the modification is minor."""

    try:
        result = call_gemini(prompt, api_key)
        return jsonify(result)
    except json.JSONDecodeError as e:
        return jsonify({"error": f"Failed to parse AI response: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "service": "VOYAGER AI", "gemini_configured": bool(GEMINI_API_KEY)})


@app.route("/api/test-key", methods=["POST"])
def test_key():
    key = (request.json or {}).get("api_key", "") or GEMINI_API_KEY
    if not key:
        return jsonify({"error": "No key provided"}), 400

    results = []
    for model in ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-1.0-pro", "gemini-pro"]:
        for version in ["v1", "v1beta"]:
            url = f"https://generativelanguage.googleapis.com/{version}/models/{model}:generateContent?key={key}"
            try:
                r = requests.post(url, json={"contents": [{"parts": [{"text": "Say hello in one word"}]}]}, timeout=10)
                results.append({"model": model, "version": version, "status": r.status_code, "ok": r.status_code == 200})
                if r.status_code == 200:
                    return jsonify({"working_model": model, "version": version, "all_results": results})
            except Exception as e:
                results.append({"model": model, "version": version, "error": str(e)})

    return jsonify({"error": "No working model found", "all_results": results})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
