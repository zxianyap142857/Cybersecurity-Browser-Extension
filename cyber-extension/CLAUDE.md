# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Chrome Manifest V3 extension for cybersecurity threat detection. The extension popup communicates with a local Flask backend (port 5000) that hosts fine-tuned BERT models for phishing URL classification, a RAG chatbot, cookie analysis via Selenium, and federated learning for model improvement.

## Running the Backend

```bash
# Set up virtual environment (first time)
bash setup_env.sh

# Run Flask server (must be run from cyber-extension/ directory)
cd cyber-extension/python-backend
python app.py
# Listens on http://127.0.0.1:5000
```

The backend must be running before the extension can perform any analysis. Model paths in `app.py` are resolved relative to `app.py`'s own location using `os.path.abspath(__file__)`.

## Loading the Extension

In Chrome: go to `chrome://extensions` → Enable Developer mode → Load unpacked → select `cyber-extension/`.

## Flask API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/predict` | POST | Single URL phishing classification |
| `/batch_predict` | POST | Batch URL classification (used by background.js) |
| `/chat` | POST | RAG chatbot (StarCoder2-3B + LanceDB) |
| `/analyze-cookies` | POST | Scrapes cookie metadata via Selenium |
| `/report` | POST | Save user-reported misclassification for FL |
| `/report_count` | GET | Count reports per model (`?model=distilbert`) |
| `/fl_train` | POST | Start background federated learning run |
| `/fl_status` | GET | Poll FL training progress |
| `/api/history` | GET | Returns analysis history for Streamlit dashboard |
| `/scan_page` | POST | Fetch a page, extract all links from HTML elements, batch predict |
| `/kb/rows` | GET | Return all Knowledge Base Q&A rows |
| `/kb/add` | POST | Append Q&A row, rebuild LanceDB, archive to GCS |
| `/kb/delete` | POST | Delete row by index, rebuild LanceDB, archive to GCS |
| `/kb/rebuild` | POST | Manually rebuild LanceDB from current CSV |
| `/kb/archive` | POST | Manually upload KB CSV to GCS |
| `/kb/restore` | POST | Download KB CSV from GCS, overwrite local, rebuild LanceDB |

All prediction endpoints accept a `model` field: `"distilbert"` (default) or `"mobilebert"`.

## Architecture

### Communication Flow

```
Chrome Tab
  └─► background.js (service worker)
        ├─► chrome.scripting.executeScript  →  DOM manipulation (inject/highlight/remove links)
        ├─► chrome.storage.local            →  persist settings and scan history
        └─► fetch http://127.0.0.1:5000     →  Flask backend

index.html (popup)
  └─► scripts/popup.js
        ├─► chrome.runtime.sendMessage({ action: "analyzeTab" })  →  background.js
        ├─► chrome.storage.local  →  read/write all UI state
        └─► fetch http://127.0.0.1:5000     →  Flask backend (cookies, chat, report, FL)
```

### chrome.storage.local Keys

| Key | Type | Purpose |
|-----|------|---------|
| `protectionEnabled` | bool | Remove phishing links from DOM |
| `warningEnabled` | bool | Highlight phishing links (mutually exclusive with protection) |
| `urlScanningEnabled` | bool | Scan-only mode (no DOM changes) |
| `selectedModel` | string | `'distilbert'` or `'mobilebert'` |
| `analysisResult` | object | `{ status, confidence }` — current tab result |
| `scanHistory` | array | All scan records (batch and single) |
| `dashboardStats` | object | Aggregate counters for dashboard |
| `blockingPopupEnabled` | bool | Redirect to warning.html on phishing navigation |
| `latestBatchScan` | object | `{ results[], timestamp }` — last batch scan for table display |
| `allowedBlockedUrls` | array | (session storage) URLs user chose to proceed through |

### Protection Mode Logic

The toggles in `background.js` act on `batch_predict` results:
- `warningEnabled` → highlight phishing elements pink/red + badge on parent containers (`<tr>`, `<li>`, `<h1-6>`, `<article>`, `<section>`) + show inline warning popup
- `protectionEnabled` → remove phishing elements and their parent containers from DOM
- `urlScanningEnabled` alone → badge update only (no DOM changes)
- `blockingPopupEnabled` → intercepts navigation via `webNavigation.onCommitted`, calls `/predict`, redirects to `warning.html` if phishing (≥85% = phishing level, 50-84% = suspicious level)

Link extraction covers: `<a href>`, `<img src/data-src>`, `<li/tr/div/h1-h6>` with `href/data-href/data-url`, `<iframe/embed/source src>`.

Tabs with `file://`, `127.0.0.1`, `localhost`, `192.168.*`, `10.*`, `172.16.*` URLs are skipped entirely.

### Blocking Popup (warning.html)

`warning.html` + `scripts/warning.js` — a full-page warning shown when `blockingPopupEnabled` intercepts a phishing URL. MV3 requires all JS to be in external files (no inline `<script>`). Uses `chrome.storage.session` for the allowed-URLs list (survives service worker restarts). "Proceed Anyway" stores the URL via `allowBlockedUrl` message to background, then navigates with `chrome.tabs.update()`.

### Model Architecture

Both models live in `cyber-extension/model/{Distil BERT|Mobile BERT}/`. Labels: `0 = legitimate`, `1 = phishing`. `load_phishing_model()` in `app.py` loads the correct tokenizer and classification model on every request (no model caching between requests).

- **DistilBERT**: `max_length=64`, 6-layer, trained 5 epochs @ lr=2e-5
- **MobileBERT**: `max_length=128`, 24-layer, trained 20 epochs @ lr=1e-5

### Federated Learning (PEFT LoRA)

Located in `python-backend/federated/`. User reports are stored in `python-backend/reported_data.json`.

`fl_train` POST → daemon thread → `fl_training.run_federated_training()`:
1. Splits `reported_data.json` into `n` virtual client partitions
2. Runs manual FedAvg simulation (no Ray — Windows-compatible)
3. Each client uses PEFT LoRA (`r=8, lora_alpha=16`):
   - DistilBERT → `target_modules=["q_lin", "v_lin"]`
   - MobileBERT → `target_modules=["query", "value"]`
4. After all rounds: `merge_and_unload()` saves weights back to the model directory
5. The updated model is used immediately on the next `/predict` call

Minimum 2 reports required. `/fl_status` is polled every 3 seconds from `popup.js`.

### RAG Chatbot

`app.py` initialises StarCoder2-3B at startup (4-bit quantized via BitsAndBytes). Loads Q&A from `Knowledge Base.csv` into LanceDB (`./Knowledge Base/RAGData_Backend`). Uses `StopOnTokens` stopping criteria to halt generation at "Human:", "User:", "Question:" tokens (both single- and multi-token sequences). `clean_response()` strips any remaining stop words (with or without colon) from the output.

### Knowledge Base & GCS Archiving

KB CSV at `Knowledge Base/Knowledge Base.csv`. After every `/kb/add` or `/kb/delete`, the CSV is auto-uploaded to `gs://cyber-fl-models/knowledge-base/Knowledge Base.csv` via `_archive_kb_to_gcs()` (non-fatal on failure). `/kb/restore` downloads from GCS and rebuilds LanceDB. Requires `google-cloud-storage` and valid GCP credentials.

### Streamlit Dashboard

`dashboard.py` is a separate process consuming `/api/history` from the Flask server. Run independently from `python-backend/`.

## Important Paths

- `HF_HOME` / `TRANSFORMERS_CACHE` are set to `X:/AI_Models` in `app.py` — change if that drive doesn't exist.
- Model directories referenced by absolute path from `__file__` in both `app.py` and `federated/fl_training.py` — no working-directory dependency.
- `reported_data.json` is created at `python-backend/reported_data.json` on first report submission.

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `flwr` | Federated learning client/server protocol |
| `peft` | LoRA adapters for efficient fine-tuning |
| `transformers` | DistilBERT / MobileBERT / StarCoder2 |
| `lancedb` | Vector store for RAG chatbot |
| `selenium` + `webdriver-manager` | Cookie metadata scraping |
| `flask-cors` | Allow extension origin to call Flask |
| `google-cloud-storage` | Knowledge Base archiving to GCS |

## Common Gotchas

- **MV3 CSP**: Extension HTML pages cannot use inline `<script>`. All JS must be in separate `.js` files referenced via `<script src="...">`.
- **Meta tensor error**: StarCoder2's `device_map="auto"` (transformers 4.57+) can contaminate subsequent `from_pretrained` calls. Phishing model loading uses explicit `device_map=None, low_cpu_mem_usage=False` to prevent this.
- **Service worker lifecycle**: In-memory state (e.g., `Set()`) is lost when the SW restarts. Use `chrome.storage.session` for data that must survive restarts (e.g., allowed blocked URLs).
- **`onInstalled` resets**: Toggle defaults are only set if the key is `undefined`, preserving user choices across extension reloads.
- **venv location**: The project venv is at `Extension/venv/` (parent of `cyber-extension/`). Install packages with the venv's pip, not the system Python.

## Federated Learning Properties
GCP FL Server: Set via `gcp_url` parameter in `/fl_train` POST request
Bucket:        gs://cyber-fl-models
Region:        asia-southeast1
MIN_CLIENTS:   2
