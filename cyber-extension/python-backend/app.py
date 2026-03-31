from flask import Flask, request, jsonify
from flask_cors import CORS
from urllib.parse import urlparse, urljoin
import re
import json
import threading
import requests as http_req
import pandas as pd
import os
import torch
from transformers import (
    DistilBertForSequenceClassification,
    DistilBertTokenizer,
    MobileBertForSequenceClassification,
    MobileBertTokenizer,
    AutoModelForCausalLM,
    AutoTokenizer,
    pipeline,
    StoppingCriteria,
    StoppingCriteriaList,
    BitsAndBytesConfig
)
from langchain_community.vectorstores import LanceDB
from langchain_huggingface import HuggingFaceEmbeddings, HuggingFacePipeline
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import HumanMessage, AIMessage
from langchain_core.documents import Document
from langchain_classic.chains import create_history_aware_retriever
from langchain_classic.chains.retrieval import create_retrieval_chain
from langchain_classic.chains.combine_documents import create_stuff_documents_chain
import lancedb
import time
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
from bs4 import BeautifulSoup
from google.cloud import storage as gcs

# --- RAG Chatbot Setup ---
# Set environment variables for model caching.
# Replace 'X:/AI_Models' with a folder on a drive that has 15GB+ free space.
os.environ['HF_HOME'] = 'X:/AI_Models'
os.environ['TRANSFORMERS_CACHE'] = 'X:/AI_Models'

app = Flask(__name__)
CORS(app)

# --- Path constants (resolved from app.py location, not working directory) ---
_BACKEND_DIR   = os.path.dirname(os.path.abspath(__file__))
_EXTENSION_DIR = os.path.dirname(_BACKEND_DIR)

MODEL_PATHS = {
    'distilbert': os.path.join(_EXTENSION_DIR, 'model', 'Distil BERT'),
    'mobilebert': os.path.join(_EXTENSION_DIR, 'model', 'Mobile BERT'),
}

REPORTED_DATA_PATH = os.path.join(_BACKEND_DIR, 'reported_data.json')
KB_CSV_PATH = os.path.join(_EXTENSION_DIR, 'Knowledge Base', 'Knowledge Base.csv')

# --- Google Cloud Storage archiving for Knowledge Base ---
GCS_BUCKET_NAME = 'cyber-fl-models'
GCS_KB_BLOB     = 'knowledge-base/Knowledge Base.csv'

def _archive_kb_to_gcs():
    """Upload the local KB CSV to Google Cloud Storage for backup/archiving."""
    try:
        client = gcs.Client()
        bucket = client.bucket(GCS_BUCKET_NAME)
        blob = bucket.blob(GCS_KB_BLOB)
        blob.upload_from_filename(KB_CSV_PATH)
        print(f"[KB] Archived to gs://{GCS_BUCKET_NAME}/{GCS_KB_BLOB}")
    except Exception as e:
        print(f"[KB] GCS archive failed (non-fatal): {e}")

# --- Federated learning module ---
from federated.fl_training import (
    run_federated_training,
    run_cloud_federated_training,
    run_gcp_federated_training,
    get_status as get_fl_status,
)

# Global variable to store analysis history for dashboard purpose
analysis_history = []

# --- Model Loading Helper ---
def load_phishing_model(model_name='distilbert'):
    """Loads the tokenizer and model for the specified architecture."""
    load_dir = MODEL_PATHS.get(model_name, MODEL_PATHS['distilbert'])
    if model_name == 'mobilebert':
        tokenizer = MobileBertTokenizer.from_pretrained(load_dir)
        model = MobileBertForSequenceClassification.from_pretrained(
            load_dir, device_map=None, low_cpu_mem_usage=False
        )
    else:
        tokenizer = DistilBertTokenizer.from_pretrained(load_dir)
        model = DistilBertForSequenceClassification.from_pretrained(
            load_dir, device_map=None, low_cpu_mem_usage=False
        )
    model.eval()
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model.to(device)
    return tokenizer, model, device

# --- Phishing Detection Feature Functions ---
def extract_url_features(url):
    """Extracts features from a URL for phishing detection."""
    try:
        parsed_url = urlparse(url)
        hostname = parsed_url.hostname if parsed_url.hostname else ''
    except Exception:
        # For invalid URLs, return a dictionary of features with default values
        return {
            'url_length': 0, 'hostname_length': 0, 'path_length': 0,
            'num_subdomains': 0, 'has_https': 0, 'has_ip_address': 1,
            'num_special_chars': 0
        }

    features = {
        'url_length': len(url),
        'hostname_length': len(hostname),
        'path_length': len(parsed_url.path),
        'num_subdomains': len(hostname.split('.')),
        'has_https': 1 if parsed_url.scheme == 'https' else 0,
        'has_ip_address': 1 if re.match(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$", hostname) else 0,
        'num_special_chars': len(re.findall(r'[@?&=/]', url))
    }
    return features

def clean_and_extract_url(text):
    """
    Extracts the first URL found in a given text string.
    This is useful if the input is a full HTML anchor tag.
    """
    if not text:
        return ""
    # Regex to find a URL within an href attribute or just a standalone URL
    match = re.search(r'href="([^"]+)"|https?://[^\s<>"]+|www\.[^\s<>"]+', text)
    print("URL: ",match)
    if match:
        # If href is found, it's group 1. Otherwise, it's the full match.
        return match.group(1) if match.group(1) else match.group(0)
    return text # Return original text if no URL is found


def clean_response(response_text):
    """
    Removes common conversational turn indicators (like "Human:", "Question:", "User:", "Answer:")
    and separator lines (e.g., "----------------------") from the generated response.
    """
    # Remove the separator line if present
    cleaned_text = re.sub(r'-{5,}\s*', '', response_text, flags=re.IGNORECASE).strip()
    # Remove patterns from the start, end, or after newlines
    cleaned_text = re.sub(r'^(Human:|Question:|User:|Answer:)\s*', '', cleaned_text, flags=re.IGNORECASE).strip()
    cleaned_text = re.sub(r'(Human:|Question:|User:|Answer:)\s*$', '', cleaned_text, flags=re.IGNORECASE).strip()
    cleaned_text = re.sub(r'\n\s*(Human:|Question:|User:|Answer:)\s*', '\n', cleaned_text, flags=re.IGNORECASE).strip()
    return cleaned_text

# --- RAG Chatbot Initialization ---
print("Initializing RAG Chatbot...")

# 1. Load Q&A data from CSV
csv_path = 'C:/Users/Yap Zheng Xian/Documents/Programming/Extension/cyber-extension/Knowledge Base/Knowledge Base.csv'
try:
    df = pd.read_csv(csv_path, encoding='utf-8')
    if 'question' not in df.columns or 'output' not in df.columns:
        raise ValueError("The CSV file must contain 'question' and 'output' columns.")
    docs = [
        Document(
            page_content=f"Archived Question: {row['question']}\n\nArchived Answer:\n{row['output']}",
            metadata={"source": f"CSV Row {index}", "original_question": row['question']}
        )
        for index, row in df.iterrows()
    ]
    print(f"Successfully loaded {len(docs)} Q&A documents from {csv_path}")
    chunks = docs
except FileNotFoundError:
    print(f"Error: The CSV file was not found at '{csv_path}'. The chatbot will rely on its general knowledge.")
    chunks = []
except Exception as e:
    print(f"An error occurred while processing the CSV file: {e}")
    chunks = []

# 2. Setup Embeddings and Vector Store (LanceDB)
embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
db = lancedb.connect("./Knowledge Base/RAGData_Backend") # Store DB in backend folder
table_name = "code_repo_backend"
if table_name in db.table_names():
    db.drop_table(table_name)
    print(f"Dropped old table '{table_name}'.")

if chunks:
    vector_store = LanceDB.from_documents(chunks, embeddings, connection=db, table_name=table_name)
    print("Created new LanceDB table with Q&A data!")
else:
    # Create an empty table if CSV loading failed
    vector_store = LanceDB.from_documents([], embeddings, connection=db, table_name=table_name)
    print("Created an empty LanceDB table.")

# 3. Setup StarCoder2 LLM
print("Starting model setup...")
try:
    model_id = "bigcode/starcoder2-3b"
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    print("Tokenizer loaded.")

    class StopOnTokens(StoppingCriteria):
        def __call__(self, input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs) -> bool:
            stop_strings = ["Question:", "Human:", "User:"]
            stop_ids = [tokenizer.encode(s, add_special_tokens=False)[0] for s in stop_strings]
            return input_ids[0][-1] in stop_ids

    quantization_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
    )

    model_llm = AutoModelForCausalLM.from_pretrained(
        model_id,
        quantization_config=quantization_config,
        device_map="auto"
    )
    print("StarCoder2 model loaded.")

    pipe = pipeline(
        "text-generation",
        model=model_llm,
        tokenizer=tokenizer,
        max_new_tokens=512,
        do_sample=True,
        temperature=0.5,
        top_p=0.95,
        return_full_text=False,
        stopping_criteria=StoppingCriteriaList([StopOnTokens()]),
        pad_token_id=tokenizer.eos_token_id,
        device_map="auto"
    )
    llm = HuggingFacePipeline(pipeline=pipe)
    print("LLM setup complete.")

    # 4. The RAG Chain
    contextualize_q_system_prompt = (
        "Given a chat history and the latest user question "
        "which might reference context in the chat history, "
        "formulate a standalone question which can be understood "
        "without the chat history."
    )
    contextualize_q_prompt = ChatPromptTemplate.from_messages([
        ("system", contextualize_q_system_prompt),
        MessagesPlaceholder("chat_history"),
        ("human", "{input}"),
    ])

    system_prompt = (
        "You are a professional coding assistant. Your main goal is to help users with their coding questions.\n"
        "Follow these rules:\n"
        "1. First, use the provided 'Archived Q&A' context to see if a similar question has been answered before. The context contains past questions and their answers.\n"
        "2. If the context provides a relevant answer, use it to form your response. Always format code examples inside Markdown code blocks for clarity.\n"
        "3. If the context is not relevant or doesn't help, use your own general knowledge to answer the question.'\n"
        "4. Keep your answers clear and to the point. Stop writing once the answer is complete.\n"
        "CONTEXT (Archived Q&A):\n"
        "----------------------\n"
        "{context}\n"
        "----------------------"
    )
    qa_prompt = ChatPromptTemplate.from_messages([
        ("system", system_prompt),
        MessagesPlaceholder("chat_history"),
        ("human", "Question: {input}\nAnswer:"),
    ])

    history_aware_retriever = create_history_aware_retriever(
        llm, vector_store.as_retriever(), contextualize_q_prompt
    )
    combine_docs_chain = create_stuff_documents_chain(llm, qa_prompt)
    rag_chain = create_retrieval_chain(history_aware_retriever, combine_docs_chain)
    print("RAG chain created successfully.")

except Exception as e:
    print(f"FATAL: Error during RAG chatbot setup: {e}")
    rag_chain = None

# --- Flask API Endpoints ---

@app.route('/chat', methods=['POST'])
def chat():
    if not rag_chain:
        return jsonify({'error': 'Chatbot is not available due to an initialization error.'}), 503

    data = request.get_json()
    query = data.get('query')
    history_json = data.get('history', [])
    audit_only = data.get('audit_only', False)

    if not query:
        return jsonify({'error': 'Query is required'}), 400

    # When audit-only mode is on, prepend an instruction to the query
    if audit_only:
        query = (
            "[SYSTEM RULE: You ONLY answer questions related to website auditing and web security "
            "(phishing, malicious URLs, cookies, SSL/TLS, CSP, HTTP headers, XSS, CSRF, SQL injection, "
            "suspicious scripts, domain reputation, etc.). If the question is unrelated, politely decline "
            "and say you are specialised for website auditing only.]\n\n" + query
        )

    # Reconstruct chat history for LangChain
    chat_history = []
    for msg in history_json:
        if msg.get('role') == 'user':
            chat_history.append(HumanMessage(content=msg.get('content')))
        elif msg.get('role') == 'assistant':
            chat_history.append(AIMessage(content=msg.get('content')))

    # Invoke the RAG chain
    result = rag_chain.invoke({"input": query, "chat_history": chat_history})
    raw_answer = result.get('answer', 'Sorry, I could not generate a response.')
    
    # Clean the generated answer
    cleaned_answer = clean_response(raw_answer)
    return jsonify({'answer': cleaned_answer})

@app.route('/predict', methods=['POST'])
def predict():
    data = request.get_json()
    raw_url_data = data.get('url', '')
    model_name = data.get('model', 'distilbert')
    url = clean_and_extract_url(raw_url_data)
    print(url)

    try:
        tokenizer, model, device = load_phishing_model(model_name)
    except Exception as e:
        return jsonify({'error': f'Failed to load model "{model_name}": {str(e)}'}), 500

    encoding = tokenizer.encode_plus(
        url,
        max_length=128,
        padding='max_length',
        truncation=True,
        return_attention_mask=True,
        return_tensors='pt'
    )

    input_ids = encoding['input_ids'].to(device)
    attention_mask = encoding['attention_mask'].to(device)

    with torch.no_grad():
        output = model(input_ids, attention_mask=attention_mask)
        logits = output.logits
        probabilities = torch.softmax(logits, dim=1)
        predicted_class_id = torch.argmax(probabilities).item()
        confidence = probabilities[0, predicted_class_id].item() * 100

    result = "PHISHING / MALICIOUS" if predicted_class_id == 1 else "LEGITIMATE / SAFE"

    analysis_history.append({
        'url': url,
        'prediction': result,
        'confidence': confidence,
        'model': model_name,
        'timestamp': time.time()
    })

    return jsonify({'url': url, 'prediction': result, 'confidence': f"{confidence:.2f}%", 'model': model_name})

@app.route('/batch_predict', methods=['POST'])
def batch_predict():
    data = request.get_json()
    urls = data.get('urls', [])
    model_name = data.get('model', 'distilbert')
    phishing_links = []

    try:
        tokenizer, model, device = load_phishing_model(model_name)
    except Exception as e:
        return jsonify({'error': f'Failed to load model "{model_name}": {str(e)}'}), 500

    for raw_url in urls:
        url = clean_and_extract_url(raw_url)
        if not url:
            continue

        encoding = tokenizer.encode_plus(
            url, max_length=128, padding='max_length', truncation=True,
            return_attention_mask=True, return_tensors='pt'
        )
        input_ids = encoding['input_ids'].to(device)
        attention_mask = encoding['attention_mask'].to(device)

        with torch.no_grad():
            output = model(input_ids, attention_mask=attention_mask)
            logits = output.logits
            probabilities = torch.softmax(logits, dim=1)
            predicted_class_id = torch.argmax(probabilities).item()

            if predicted_class_id == 1:  # Phishing
                confidence = probabilities[0, predicted_class_id].item()
                phishing_links.append({'url': url, 'confidence': confidence})

    analysis_history.append({
        'type': 'batch',
        'phishing_links': phishing_links,
        'total_scanned': len(urls),
        'model': model_name,
        'timestamp': time.time()
    })

    return jsonify({'phishing_links': phishing_links})
    
@app.route('/analyze-cookies', methods=['POST'])
def analyze_cookies():
    data = request.get_json()
    domain = data.get('domain')
    if not domain:
        return jsonify({'error': 'Domain is required'}), 400
    
    try:
        scraped_data = scrape_cookie_data(domain)
        return jsonify({'cookies': scraped_data})
    except Exception as e:
        app.logger.error(f"Unhandled error in /analyze-cookies endpoint for {domain}: {e}", exc_info=True)
        return jsonify({'error': 'Failed to scrape cookie data.'}), 500
    
def get_detailed_report(html):
    soup = BeautifulSoup(html, 'html.parser')
    
    # Find the element with the specific ID
    report_section = soup.find(id="detailed-report")
    
    if report_section:
        # Return the HTML string of the section
        return report_section.prettify()
    else:
        return "Detailed report section not found."

def clean_output(html):
    soup = BeautifulSoup(html, 'html.parser')
    
    # Locate the table body and rows
    report_section = soup.find(id="detailed-report")
    rows = soup.select('.report-tbody .report-trow')

    
    extracted_data = []
    
    for row in rows:
        # Find all columns within the row
        cols = row.find_all(class_='report-tcol')
        
        if len(cols) == 5:
            # Extract text and strip whitespace
            cookie_name = cols[0].get_text(strip=True)
            domain = cols[1].get_text(strip=True)
            description = cols[2].get_text(strip=True)
            duration = cols[3].get_text(strip=True)
            cookie_type = cols[4].get_text(strip=True)
            
            #the order: cookies, domain, description, type, duration
            # Note: In the HTML, Duration is index 3 and Type is index 4.
            extracted_data.append([cookie_name, domain, description, cookie_type, duration])

    return extracted_data
  

def rows_have_text(d):
  rows = d.find_elements(By.CSS_SELECTOR, ".report-tbody .report-trow")
  return any(row.text.strip() for row in rows)

def scrape_cookie_data(search_term):
    # Setup Chrome options (headless mode is optional but recommended for scraping)
    chrome_options = Options()
    chrome_options.add_argument("--headless")  # Uncomment to run without opening a window
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")

    # Initialize the driver
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=chrome_options)

    try:
        # 1. Navigate to the Cookie Serve website to search
        url = "https://www.cookieserve.com/"
        app.logger.info(f"Navigating to {url} for cookie scraping.")
        driver.get(url)

        # 2. Find the search input and search
        wait = WebDriverWait(driver, 10)
        
        app.logger.info(f"Searching for: {search_term}")
        search_box = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "input[type='text'], input[type='search']")))
        search_box.clear()
        search_box.send_keys(search_term)
        search_box.send_keys(Keys.RETURN)

        # 3. Wait for results to load.
        # Scrolling down can help trigger lazy-loaded content.
        driver.execute_script("window.scrollBy(0, 1000);")
        # We rely on an explicit wait for the content to appear, which is more reliable than fixed time.sleep() calls.
        WebDriverWait(driver, 25).until(rows_have_text)
        
        html= driver.page_source
        output=get_detailed_report(html)
        cleaned_data=clean_output(output)
        app.logger.info(f"Successfully scraped {len(cleaned_data)} cookies for {search_term}.")
        return cleaned_data
        
    except Exception as e:
        app.logger.error(f"An error occurred during selenium scraping for {search_term}: {e}", exc_info=True)
        return []

    finally:
        app.logger.info("Closing selenium driver...")
        driver.quit()

# --- Dashboard Data Endpoint ---
@app.route('/api/history', methods=['GET'])
def get_history():
    """Returns the analysis history for the Streamlit dashboard."""
    return jsonify(analysis_history)


# --- Federated Learning Endpoints ---

@app.route('/report', methods=['POST'])
def report():
    """Store a user-submitted model-error report for federated fine-tuning."""
    data = request.get_json()
    url        = (data.get('url') or '').strip()
    model_name = data.get('model', 'distilbert')
    label      = int(data.get('label', 0))   # 0 = legitimate, 1 = phishing

    if not url:
        return jsonify({'error': 'URL is required'}), 400
    if model_name not in MODEL_PATHS:
        return jsonify({'error': f'Unknown model: {model_name}'}), 400

    entry = {
        'url':       url,
        'model':     model_name,
        'label':     label,
        'timestamp': time.time(),
    }

    # Load → append → save
    if os.path.isfile(REPORTED_DATA_PATH):
        with open(REPORTED_DATA_PATH, 'r', encoding='utf-8') as fh:
            reports = json.load(fh)
    else:
        reports = []

    reports.append(entry)
    with open(REPORTED_DATA_PATH, 'w', encoding='utf-8') as fh:
        json.dump(reports, fh, indent=2)

    model_count = sum(1 for r in reports if r.get('model') == model_name)
    return jsonify({
        'status':        'saved',
        'total_reports': len(reports),
        'model_reports': model_count,
    })


@app.route('/report_count', methods=['GET'])
def report_count():
    """Return how many reports exist for a given model."""
    model_name = request.args.get('model', 'distilbert')
    if not os.path.isfile(REPORTED_DATA_PATH):
        return jsonify({'count': 0})
    with open(REPORTED_DATA_PATH, 'r', encoding='utf-8') as fh:
        reports = json.load(fh)
    count = sum(1 for r in reports if r.get('model') == model_name)
    return jsonify({'count': count})


@app.route('/fl_train', methods=['POST'])
def fl_train():
    """
    Start a federated learning training run in the background.

    JSON body fields:
      model      : 'distilbert' | 'mobilebert'   (default: distilbert)
      rounds     : int                             (default: 3)
      mode       : 'local' | 'cloud'              (default: local)
      cloud_url  : ngrok URL from Colab            (required when mode=cloud)
    """
    status = get_fl_status()
    if status.get('state') == 'running':
        return jsonify({
            'status':  'already_running',
            'message': 'FL training is already in progress.',
        }), 409

    data       = request.get_json()
    model_name = data.get('model', 'distilbert')
    num_rounds = int(data.get('rounds', 3))
    mode       = data.get('mode', 'local')
    cloud_url  = (data.get('cloud_url') or '').strip()

    if model_name not in MODEL_PATHS:
        return jsonify({'error': f'Unknown model: {model_name}'}), 400

    if mode == 'cloud':
        if not cloud_url:
            return jsonify({'error': 'cloud_url is required when mode=cloud'}), 400
        t = threading.Thread(
            target=run_cloud_federated_training,
            args=(cloud_url, model_name, num_rounds),
            daemon=True,
        )
        t.start()
        return jsonify({
            'status':    'started',
            'mode':      'cloud',
            'model':     model_name,
            'rounds':    num_rounds,
            'cloud_url': cloud_url,
        })

    if mode == 'gcp':
        gcp_url = (data.get('gcp_url') or '').strip()
        api_key = (data.get('api_key') or '').strip()
        if not gcp_url:
            return jsonify({'error': 'gcp_url is required when mode=gcp'}), 400
        t = threading.Thread(
            target=run_gcp_federated_training,
            args=(gcp_url, model_name, num_rounds, api_key),
            daemon=True,
        )
        t.start()
        return jsonify({
            'status':  'started',
            'mode':    'gcp',
            'model':   model_name,
            'rounds':  num_rounds,
            'gcp_url': gcp_url,
        })

    # Default: local simulation
    t = threading.Thread(
        target=run_federated_training,
        args=(model_name, num_rounds),
        daemon=True,
    )
    t.start()
    return jsonify({
        'status': 'started',
        'mode':   'local',
        'model':  model_name,
        'rounds': num_rounds,
    })


@app.route('/fl_status', methods=['GET'])
def fl_status():
    """Return the current FL training status."""
    return jsonify(get_fl_status())


@app.route('/scan_page', methods=['POST'])
def scan_page():
    """Fetch a page URL, extract all HTTP links, run batch prediction, return per-URL results."""
    data = request.get_json()
    page_url = (data.get('url') or '').strip()
    model_name = data.get('model', 'distilbert')

    if not page_url:
        return jsonify({'error': 'url is required'}), 400
    if model_name not in MODEL_PATHS:
        return jsonify({'error': f'Unknown model: {model_name}'}), 400

    # 1. Fetch the page HTML
    try:
        resp = http_req.get(
            page_url, timeout=10,
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0'}
        )
        resp.raise_for_status()
        html = resp.text
    except Exception as e:
        return jsonify({'error': f'Failed to fetch page: {str(e)}'}), 502

    # 2. Extract unique HTTP/HTTPS links from all relevant HTML elements
    soup = BeautifulSoup(html, 'html.parser')
    seen = set()
    http_links = []

    def _collect(resolved_url):
        """Add a resolved URL to the list if it's HTTP/HTTPS and not seen before."""
        if resolved_url.startswith(('http://', 'https://')) and resolved_url not in seen:
            seen.add(resolved_url)
            http_links.append(resolved_url)

    # <a href="...">
    for tag in soup.find_all('a', href=True):
        _collect(urljoin(page_url, tag['href'].strip()))

    # <img src="...">, <img data-src="..."> (lazy-loaded images)
    for tag in soup.find_all('img'):
        if tag.get('src'):
            _collect(urljoin(page_url, tag['src'].strip()))
        if tag.get('data-src'):
            _collect(urljoin(page_url, tag['data-src'].strip()))

    # <li>, <tr>, <div>, <h1>-<h6>, <section>, <article> — extract any nested href/src
    # Also scan data-href and data-url attributes used by JS-driven pages
    for tag in soup.find_all(['li', 'tr', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                               'section', 'article', 'blockquote']):
        for attr in ['href', 'data-href', 'data-url']:
            val = tag.get(attr)
            if val:
                _collect(urljoin(page_url, val.strip()))

    # <iframe src="...">, <embed src="...">, <source src="...">
    for tag in soup.find_all(['iframe', 'embed', 'source'], src=True):
        _collect(urljoin(page_url, tag['src'].strip()))

    if not http_links:
        return jsonify({'results': [], 'total_scanned': 0, 'timestamp': time.time()})

    # 3. Load model and predict each link
    try:
        tokenizer, model, device = load_phishing_model(model_name)
    except Exception as e:
        return jsonify({'error': f'Failed to load model: {str(e)}'}), 500

    results = []
    for url in http_links:
        encoding = tokenizer.encode_plus(
            url, max_length=128, padding='max_length',
            truncation=True, return_attention_mask=True, return_tensors='pt'
        )
        input_ids      = encoding['input_ids'].to(device)
        attention_mask = encoding['attention_mask'].to(device)

        with torch.no_grad():
            output = model(input_ids, attention_mask=attention_mask)
            probs  = torch.softmax(output.logits, dim=1)
            pred   = torch.argmax(probs).item()
            conf   = probs[0, pred].item()

        results.append({
            'url':        url,
            'label':      'PHISHING' if pred == 1 else 'LEGITIMATE',
            'confidence': round(conf * 100, 2),
        })

    return jsonify({
        'results':       results,
        'total_scanned': len(results),
        'timestamp':     time.time(),
    })


# --- Knowledge Base Management Endpoints ---

def _rebuild_lancedb():
    """Re-read KB_CSV_PATH and rebuild the LanceDB vector store + RAG chain."""
    global vector_store, rag_chain
    try:
        df = pd.read_csv(KB_CSV_PATH, encoding='utf-8')
        docs = [
            Document(
                page_content=f"Archived Question: {row['question']}\n\nArchived Answer:\n{row['output']}",
                metadata={"source": f"CSV Row {i}", "original_question": row['question']}
            )
            for i, row in df.iterrows()
        ]
        if table_name in db.table_names():
            db.drop_table(table_name)
        vector_store = LanceDB.from_documents(docs, embeddings, connection=db, table_name=table_name)
        # Rebuild RAG chain if LLM is initialised
        try:
            new_har = create_history_aware_retriever(llm, vector_store.as_retriever(), contextualize_q_prompt)
            new_cdc = create_stuff_documents_chain(llm, qa_prompt)
            rag_chain = create_retrieval_chain(new_har, new_cdc)
            print(f"[KB] LanceDB rebuilt with {len(docs)} entries and RAG chain updated.")
        except NameError:
            print(f"[KB] LanceDB rebuilt with {len(docs)} entries (LLM not available).")
        return len(docs)
    except Exception as e:
        print(f"[KB] Rebuild failed: {e}")
        raise


@app.route('/kb/rows', methods=['GET'])
def kb_rows():
    """Return all rows in the Knowledge Base CSV."""
    try:
        df = pd.read_csv(KB_CSV_PATH, encoding='utf-8')
        return jsonify({'rows': df[['question', 'output']].to_dict('records'), 'total': len(df)})
    except FileNotFoundError:
        return jsonify({'rows': [], 'total': 0})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/kb/add', methods=['POST'])
def kb_add():
    """Append a new Q&A row to the CSV and rebuild LanceDB."""
    data = request.get_json()
    question = (data.get('question') or '').strip()
    output   = (data.get('output')   or '').strip()
    if not question or not output:
        return jsonify({'error': 'Both question and output are required.'}), 400
    try:
        try:
            df = pd.read_csv(KB_CSV_PATH, encoding='utf-8')
        except FileNotFoundError:
            df = pd.DataFrame(columns=['question', 'output'])
        new_row = pd.DataFrame([{'question': question, 'output': output}])
        df = pd.concat([df, new_row], ignore_index=True)
        df.to_csv(KB_CSV_PATH, index=False, encoding='utf-8')
        total = _rebuild_lancedb()
        _archive_kb_to_gcs()
        return jsonify({'status': 'added', 'total': total})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/kb/delete', methods=['POST'])
def kb_delete():
    """Delete a row by 0-based index, save CSV and rebuild LanceDB."""
    data = request.get_json()
    try:
        idx = int(data.get('index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'index must be an integer'}), 400
    try:
        df = pd.read_csv(KB_CSV_PATH, encoding='utf-8')
        if idx < 0 or idx >= len(df):
            return jsonify({'error': f'Index {idx} out of range (0–{len(df)-1})'}), 400
        df = df.drop(index=idx).reset_index(drop=True)
        df.to_csv(KB_CSV_PATH, index=False, encoding='utf-8')
        total = _rebuild_lancedb()
        _archive_kb_to_gcs()
        return jsonify({'status': 'deleted', 'total': total})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/kb/rebuild', methods=['POST'])
def kb_rebuild():
    """Manually trigger a LanceDB rebuild from the current CSV."""
    try:
        total = _rebuild_lancedb()
        return jsonify({'status': 'rebuilt', 'total': total})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/kb/archive', methods=['POST'])
def kb_archive():
    """Manually upload the current KB CSV to GCS."""
    try:
        _archive_kb_to_gcs()
        return jsonify({'status': 'archived', 'bucket': GCS_BUCKET_NAME, 'blob': GCS_KB_BLOB})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/kb/restore', methods=['POST'])
def kb_restore():
    """Download KB CSV from GCS, overwrite local copy, and rebuild LanceDB."""
    try:
        client = gcs.Client()
        bucket = client.bucket(GCS_BUCKET_NAME)
        blob = bucket.blob(GCS_KB_BLOB)
        blob.download_to_filename(KB_CSV_PATH)
        total = _rebuild_lancedb()
        return jsonify({'status': 'restored', 'total': total})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
  app.run(debug=True, port=5000, use_reloader=False)