import os
# Replace 'D:/AI_Models' with a folder on a drive that has 15GB+ free space
os.environ['HF_HOME'] = 'X:/AI_Models'
os.environ['TRANSFORMERS_CACHE'] = 'X:/AI_Models'

from langchain_community.document_loaders import DirectoryLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.embeddings import HuggingFaceEmbeddings

#Import Vector Database (LanceDB)
import lancedb
from lancedb.embeddings import get_registry
from lancedb.pydantic import LanceModel, Vector

import pyarrow as pa
import json
import uuid


import torch
print(f"Checking GPU... CUDA Available: {torch.cuda.is_available()}")
from langchain_community.vectorstores import LanceDB
from langchain_huggingface import HuggingFaceEmbeddings, HuggingFacePipeline
from langchain_text_splitters import RecursiveCharacterTextSplitter, Language
from langchain_community.document_loaders import DirectoryLoader

# NEW MODERN IMPORTS (No dot-chains)
from langchain_classic.chains import create_history_aware_retriever
from langchain_classic.chains.retrieval import create_retrieval_chain
from langchain_classic.chains.combine_documents import create_stuff_documents_chain
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from transformers import AutoModelForCausalLM, AutoTokenizer, pipeline
from langchain_core.messages import HumanMessage, AIMessage

# 1. Load your code files or documents
loader = DirectoryLoader('./notebook/MyCodeBase', glob="**/*.py")
docs = loader.load()

# 2. Split text into manageable chunks
text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
chunks = text_splitter.split_documents(docs)

# 3. Create embeddings and store in ChromaDB
embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")



# 1. Connect to a local folder
db = lancedb.connect("./notebook/RAGData")

# 2. Select your embedding model (LanceDB handles the download/setup)
func = get_registry().get("sentence-transformers").create(
    name="all-MiniLM-L6-v2", # Or use a code-specific model here
    device="cpu" 
)

# 3. Define your table schema
class CodeDocs(LanceModel):
    text: str = func.SourceField()       # The raw code/text
    vector: Vector(func.ndims()) = func.VectorField() # The numbers
    filename: str                        # Metadata

# 4. Create the table
table = db.create_table("code_repo", schema=CodeDocs, mode="overwrite")

# 5. Ingest data (LanceDB embeds 'text' automatically!)
'''
data = [
    {"text": "def hello(): print('world')", "filename": "test.py"},
    {"text": "class Database: pass", "filename": "db.py"}
]
table.add(data)
'''

# 6. Search
#results = table.search("How do I print something?").limit(2).to_list()
#print(results[0]["text"])


# ONLY keep this if you specifically need the old 'RetrievalQA' class
# from langchain_classic.chains import RetrievalQA

# --- 1. SETUP EMBEDDINGS ---
# Using a code-specific embedding model for better results with StarCoder2
embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")

# --- 2. LOAD AND CHUNK DATA ---
loader = DirectoryLoader('./notebook/MyCodeBase', glob="**/*.py")
docs = loader.load()

# Split using Python-specific logic so functions aren't cut in half
python_splitter = RecursiveCharacterTextSplitter.from_language(
    language=Language.PYTHON, 
    chunk_size=1000, 
    chunk_overlap=100
)
chunks = python_splitter.split_documents(docs)

# FIX: Clean the metadata but keep it as a DICTIONARY
for chunk in chunks:
    # Get the source path
    source_path = str(chunk.metadata.get('source', 'Unknown'))
    # Re-assign as a clean dictionary
    chunk.metadata = {"source": source_path}

print("Final Metadata Format:", chunks[0].metadata) 
# Should print: {'source': 'notebook\\MyCodeBase\\data.py'}

# --- 3. SETUP LANCEDB ---
db = lancedb.connect("./notebook/RAGData")
table_name = "code_repo"

# 1. COMPLETELY remove the old table if it exists
if table_name in db.list_tables():
    db.drop_table(table_name)
    print(f"Dropped old table '{table_name}' to reset schema.")

# 2. Let LangChain build the table its own way
# This will automatically handle the schema (text, vector, metadata)
vector_store = LanceDB.from_documents(
    chunks, 
    embeddings, 
    connection=db, 
    table_name=table_name
)
print("Created new table with LangChain-compatible schema!")

# Create table with correct schema
schema = pa.schema([
    pa.field("id", pa.string()),
    pa.field("text", pa.string()),
    pa.field("metadata", pa.string()),
    pa.field("vector", pa.list_(pa.float32(), 384)),  # dim for all-MiniLM-L6-v2
])

table = db.create_table(table_name, schema=schema, mode="overwrite")

# Embed the chunks
vectors = embeddings.embed_documents([chunk.page_content for chunk in chunks])

# Prepare data
data = []
for i, chunk in enumerate(chunks):
    data.append({
        "id": str(uuid.uuid4()),
        "text": chunk.page_content,
        "metadata": chunk.metadata,
        "vector": vectors[i]
    })


# Create LangChain vector store wrapper
vector_store = LanceDB(connection=db, table_name=table_name, embedding=embeddings)

# --- 4. SETUP STARCODER2 ---
print("Starting model setup...")
try:
    from transformers import BitsAndBytesConfig
    model_id = "bigcode/starcoder2-3b"

    tokenizer = AutoTokenizer.from_pretrained(model_id)
    print("Tokenizer loaded.")

    # Load the 3B model
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        dtype=torch.float16,
        device_map="auto",
        low_cpu_mem_usage=True
    )
    print("Model loaded.")

    pipe = pipeline(
        "text-generation",
        model=model,
        tokenizer=tokenizer,
        max_new_tokens=512,
        device_map="auto"
    )
    llm = HuggingFacePipeline(pipeline=pipe)
    print("LLM setup complete.")
except Exception as e:
    print(f"Error during model setup: {e}")
    exit(1)

# --- 5. THE RAG CHAIN ---
# 5.1 Define a prompt
system_prompt = (
    "You are an expert software engineer and Cybersecurity Expert. Below is the source code context "
    "retrieved from the repository. Use it to answer the user's question accurately. "
    "Include code snippets in your answer if they are relevant.\n\n"
    "CODE CONTEXT:\n"
    "----------------------\n"
    "{context}\n"
    "----------------------"
)

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


# 5.2 Define the Answer Prompt
system_prompt = (
    "You are a helpful coding assistant. Use the following pieces of retrieved "
    "code context to answer the question. Always mention the filename in your answer."
    "\n\n"
    "CODE CONTEXT:\n"
    "{context}"
)
qa_prompt = ChatPromptTemplate.from_messages([
    ("system", system_prompt),
    MessagesPlaceholder("chat_history"),
    ("human", "{input}"),
])


# 5.3 Link the history-aware retriever
# This step "rewrites" the user query to include context from the chat history
history_aware_retriever = create_history_aware_retriever(
    llm, vector_store.as_retriever(), contextualize_q_prompt
)

# 5.4 Create the Final RAG Chain
combine_docs_chain = create_stuff_documents_chain(llm, qa_prompt)
rag_chain = create_retrieval_chain(history_aware_retriever, combine_docs_chain)

# --- 6. RUNNING WITH MEMORY & CITATIONS ---

chat_history = []  # This will store your conversation
def ask_bot(query):
    global chat_history
    
    # Generate Response
    result = rag_chain.invoke({"input": query, "chat_history": chat_history})
    
    # Update History
    chat_history.extend([
        HumanMessage(content=query),
        AIMessage(content=result["answer"]),
    ])
    
    # Print Answer
    print(f"\n[BOT]: {result['answer']}")
    
    # Print Citations
    print("\n[SOURCES]:")
    unique_sources = set(doc.metadata.get('source', 'Unknown') for doc in result["context"])
    for source in unique_sources:
        print(f"- {source}")

def clear_memory():
    global chat_history
    chat_history = []
    print("\n[SYSTEM]: Chat history has been cleared. The bot has 'forgotten' the previous context.")
    
# Example Usage (commented out to start directly with interactive mode)
# ask_bot("How do I initialize the database?")
# Now ask a follow-up question!
# ask_bot("Can you show me the code for that?")

if __name__ == "__main__":
    print("Code Assistant Ready! (Type 'quit' to exit or 'clear' to reset memory)")
    while True:
        user_input = input("\nYou: ")
        if user_input.lower() == 'quit':
            break
        elif user_input.lower() == 'clear':
            clear_memory()
            continue
        
        ask_bot(user_input)

