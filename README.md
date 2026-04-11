# Cybersecurity Chrome Extension (Local Development)

A Chrome Manifest V3 extension for real-time phishing URL detection, cookie analysis, AI-powered website auditing, and federated learning model improvement.

## Features

- **Phishing URL Detection** - DistilBERT and MobileBERT classifiers for real-time URL analysis
- **Batch Page Scanning** - Scan all links on a page for phishing threats
- **Malicious Content Analyser** - Highlight or remove suspicious HTML elements
- **Cookie Analyzer** - Extract and analyze browser cookies with optional description lookup
- **AI Website Auditing** - Chat with StarCoder2 (local) or Claude API for security analysis
- **Security Reports** - Generate structured security reports via Claude API
- **Federated Learning** - Report misclassifications and improve models collaboratively
- **Knowledge Base** - Manage Q&A entries for the RAG chatbot
- **Blocking Popup** - Intercept and warn before navigating to phishing sites

## Prerequisites

- Python 3.10+
- Google Chrome, Microsoft Edge, or Opera browser
- ~15GB free disk space (for model caches)
- (Optional) NVIDIA GPU for faster StarCoder2 inference

## Quick Start

### 1. Set up the backend

```bash
cd python-backend

# Create virtual environment
python -m venv venv

# Activate it
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Download phishing models (first time)
# Place DistilBERT model files in: model/Distil BERT/
# Place MobileBERT model files in: model/Mobile BERT/
```

### 2. Download the phishing models

Download the pre-trained model files and place them in:
- `model/Distil BERT/` - DistilBERT phishing classifier
- `model/Mobile BERT/` - MobileBERT phishing classifier

Each folder should contain:
- `config.json`
- `model.safetensors` (or `pytorch_model.bin`)
- `tokenizer.json`
- `tokenizer_config.json`
- `special_tokens_map.json`
- `vocab.txt`

### 3. Run the backend

```bash
cd python-backend
python app.py
# Server starts at http://127.0.0.1:5000
```

### 4. Load the extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select this directory (the folder containing `manifest.json`)
5. The extension icon appears in your toolbar

## Project Structure

```
cyber-extension-local/
  config.js              # Backend URL configuration (local mode)
  manifest.json          # Chrome extension manifest (MV3)
  index.html             # Extension popup UI
  background.js          # Service worker (URL scanning, blocking)
  warning.html           # Phishing warning page
  scripts/
    popup.js             # Main popup logic
    warning.js           # Warning page logic
    chart.js             # Chart.js library
    resize.js            # UI resize handler
  images/                # UI icons and images
  model/                 # Phishing model weights (not included, download separately)
    Distil BERT/
    Mobile BERT/
  Knowledge Base/
    Knowledge Base.csv   # Q&A data for RAG chatbot
  python-backend/
    app.py               # Flask backend (all endpoints)
    requirements.txt     # Python dependencies
    dashboard.py         # Streamlit dashboard (optional)
    federated/           # Federated learning module
      fl_training.py
      fl_client.py
```

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/predict` | POST | Single URL phishing classification |
| `/batch_predict` | POST | Batch URL classification |
| `/chat` | POST | RAG chatbot (StarCoder2 + LanceDB) |
| `/analyze-cookies` | POST | Cookie description scraping |
| `/scan_page` | POST | Fetch page, extract links, batch predict |
| `/report` | POST | Submit misclassification report |
| `/fl_train` | POST | Start federated learning |
| `/kb/rows` | GET | List Knowledge Base entries |
| `/kb/add` | POST | Add Q&A entry |
| `/kb/delete` | POST | Delete Q&A entry |

## Configuration

- **Claude API**: Go to Website Auditing tab, select "Claude API", enter your API key
- **Model Selection**: Choose between DistilBERT and MobileBERT in the Analyse URL tab
- **Cookie Scraping Toggle**: Enable/disable web scraping for cookie descriptions

## Browser Compatibility

| Browser | Status |
|---------|--------|
| Google Chrome | Fully supported |
| Microsoft Edge | Supported (with localhost fallback) |
| Opera | Supported (with localhost fallback) |

## License

MIT
