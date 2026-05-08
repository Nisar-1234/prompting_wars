# VOYAGER AI — Intelligent Travel Planning Engine

**Vertical**: Travel Planning & Experience Engine  
**Live Demo**: https://promptwars-512364812074.europe-west1.run.app/  
**Repo**: https://github.com/Nisar-1234/prompting_wars

---

## What It Does

VOYAGER AI is a conversational travel planner powered by Google Gemini. Users describe their trip in natural language and receive a complete, adaptive day-by-day itinerary with real AI responses, live Google Maps, and budget tracking.

## Chosen Vertical

**Travel Planning & Experience Engine** — dynamically plans trips based on destination, duration, budget, traveler count, and style preferences. Adapts in real-time when users request changes through conversation.

## Approach & Logic

### Agentic Planning Pipeline
```
User Input → Flask API → Gemini 1.5 Flash → Structured JSON Itinerary
                                          → Google Maps Embed Update
                                          → Firebase-ready Persistence
```

### Key Architecture Decisions
- **Real Gemini AI**: Every itinerary is generated live by Gemini 1.5 Flash, not mocked
- **Conversational Modification**: Users chat to refine trips ("make it cheaper", "add food stops")
- **Split-pane UI**: Chat left, live Google Maps right, day cards below
- **Backend API**: Flask on Cloud Run handles Gemini calls securely
- **Adaptive Re-planning**: Full itinerary context sent to Gemini for coherent modifications

## How It Works

1. **Enter Gemini API key** on first launch (stored in browser localStorage)
2. **Fill trip details**: destination, days, travelers, budget, travel style
3. **Gemini AI generates** a complete day-by-day itinerary as structured JSON
4. **Google Maps** updates to show the destination
5. **Click day cards** to drill into specific days and update the map
6. **Chat to modify**: ask Gemini to change anything, it re-plans intelligently
7. **Save trip**: persisted locally (Firebase Firestore integration ready)

## Google Services Used

| Service | Role |
|---|---|
| **Gemini 1.5 Flash** | Core AI — itinerary generation & adaptive re-planning |
| **Google Maps Embed** | Live interactive maps, updates per destination/day |
| **Cloud Run** | Hosts the Flask backend publicly |
| **Cloud Build** | CI/CD — auto-deploys on every GitHub push |

## Running Locally

```bash
pip install -r requirements.txt
export GEMINI_API_KEY=your_key_here
python main.py
# Open http://localhost:8080
```

## Deploying to Cloud Run

```bash
gcloud run deploy voyager-ai --source . --region europe-west1 --allow-unauthenticated --project YOUR_PROJECT_ID
```

## Assumptions

- Gemini API key provided by user on first launch (no hardcoded secrets)
- Google Maps uses free embed API (no billing required)  
- Budget estimates are AI-generated approximations for planning purposes
- Full Firebase Firestore persistence ready to enable with config injection

## Evaluation Criteria

| Criteria | Implementation |
|---|---|
| **Code Quality** | Modular Flask backend, clean JS separation, consistent naming |
| **Security** | No hardcoded keys, API key passed per-request, input validation |
| **Efficiency** | Single-origin API calls, lazy map loading, minimal dependencies |
| **Testing** | `/api/health` endpoint, input validation, JSON schema enforcement |
| **Accessibility** | ARIA roles, live regions, keyboard navigation, semantic HTML |
| **Google Services** | Gemini AI + Maps Embed + Cloud Run + Cloud Build |
