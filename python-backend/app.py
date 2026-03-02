from flask import Flask, request, jsonify
from flask_cors import CORS
from urllib.parse import urlparse
import re
import pandas as pd
import os
import torch
from transformers import (
    DistilBertForSequenceClassification, 
    DistilBertTokenizer, 
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

# --- RAG Chatbot Setup ---
# Set environment variables for model caching.
# Replace 'X:/AI_Models' with a folder on a drive that has 15GB+ free space.
os.environ['HF_HOME'] = 'X:/AI_Models'
os.environ['TRANSFORMERS_CACHE'] = 'X:/AI_Models'

app = Flask(__name__)
CORS(app)

# Global variable to store analysis history for dashboard purpose
analysis_history = []

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
csv_path = 'C:/Users/Yap Zheng Xian/Documents/Programming/Extension/notebook/notebook/Dataset.csv'
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
db = lancedb.connect("./RAGData_Backend") # Store DB in backend folder
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

    if not query:
        return jsonify({'error': 'Query is required'}), 400

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
    url = clean_and_extract_url(raw_url_data)
    print(url)

    # Use the same path used for saving!
    LOAD_DIRECTORY = "./cyber-extension/model" 

    # Load the tokenizer
    tokenizer = DistilBertTokenizer.from_pretrained(LOAD_DIRECTORY)

    # Load the fine-tuned model
    model = DistilBertForSequenceClassification.from_pretrained(LOAD_DIRECTORY)

    # Set the model to evaluation mode
    model.eval()

    # Move the model to the GPU if available
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

    # --- Continue with your inference steps ---
    encoding = tokenizer.encode_plus(

        url,
        max_length=128,          # Match your training max_length
        padding='max_length',
        truncation=True,
        return_attention_mask=True,
        return_tensors='pt'      
    )


    # 2. Make the Prediction
    input_ids = encoding['input_ids'].to(device)
    attention_mask = encoding['attention_mask'].to(device)

    with torch.no_grad():

        output = model(input_ids, attention_mask=attention_mask)

        logits = output.logits

        probabilities = torch.softmax(logits, dim=1)

        predicted_class_id = torch.argmax(probabilities).item()

        confidence = probabilities[0, predicted_class_id].item() * 100

    # 3. Interpret the Result

    result = "PHISHING / MALICIOUS" if predicted_class_id == 1 else "LEGITIMATE / SAFE"

    # Save to local variable for dashboard purpose
    analysis_history.append({
        'url': url,
        'prediction': result,
        'confidence': confidence,
        'timestamp': time.time()
    })

    return jsonify({'url': url, 'prediction': result, 'confidence': f"{confidence:.2f}%"})

@app.route('/batch_predict', methods=['POST'])
def batch_predict():
    data = request.get_json()
    urls = data.get('urls', [])
    phishing_links = []

    LOAD_DIRECTORY = "./cyber-extension/model"
    tokenizer = DistilBertTokenizer.from_pretrained(LOAD_DIRECTORY)
    model = DistilBertForSequenceClassification.from_pretrained(LOAD_DIRECTORY)
    model.eval()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

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

            if predicted_class_id == 1: # Phishing
                confidence = probabilities[0, predicted_class_id].item()
                phishing_links.append({'url': url, 'confidence': confidence})

    # Save to local variable for dashboard purpose
    analysis_history.append({
        'type': 'batch',
        'phishing_links': phishing_links,
        'total_scanned': len(urls),
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

if __name__ == '__main__':
  app.run(debug=True, port=5000)