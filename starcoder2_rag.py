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
from transformers import AutoModelForCausalLM, AutoTokenizer, pipeline, StoppingCriteria, StoppingCriteriaList
from langchain_core.messages import HumanMessage, AIMessage
import pandas as pd
from langchain_core.documents import Document

# 1. Load Q&A data from a CSV file instead of source code files.
# This answers the user's request to use a CSV with 'question' and 'output' columns.
# It requires the 'pandas' library to be installed (`pip install pandas`).
csv_path = 'C:/Users/Yap Zheng Xian/Documents/Programming/Extension/notebook/notebook/Dataset.csv'  # Make sure this path points to your CSV file

try:
    # Load the CSV file using pandas
    df = pd.read_csv(csv_path,encoding='utf-8')
    if 'question' not in df.columns or 'output' not in df.columns:
        raise ValueError("The CSV file must contain 'question' and 'output' columns.")

    # Create a LangChain Document for each row in the CSV.
    # The page_content is formatted to include both the question and the output (answer),
    # which provides complete context for the embedding model and the final LLM.
    docs = [
        Document(
            page_content=f"Archived Question: {row['question']}\n\nArchived Answer:\n{row['output']}",
            metadata={"source": f"CSV Row {index}", "original_question": row['question']}
        )
        for index, row in df.iterrows()
    ]
    print(f"Successfully loaded {len(docs)} Q&A documents from {csv_path}")

except FileNotFoundError:
    print(f"Error: The CSV file was not found at '{csv_path}'. Please check the path and run the script again.")
    exit(1)
except Exception as e:
    print(f"An error occurred while processing the CSV file: {e}")
    exit(1)

# 2. Document Preparation
# Since each row from the CSV is a self-contained Q&A pair, we don't need to split the text into smaller chunks.
# Each document is treated as a single, atomic piece of information.
chunks = docs


embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")


# --- 3. SETUP LANCEDB (Corrected) ---

db = lancedb.connect("./notebook/RAGData")

table_name = "code_repo"

# Drop the table if it exists to ensure a clean start

if table_name in db.table_names():

    db.drop_table(table_name)

    print(f"Dropped old table '{table_name}' to reset schema.")



# Use the recommended LangChain method to create and populate the table.

# This handles schema creation, embedding, and ingestion in one step.

vector_store = LanceDB.from_documents(

    chunks, 

    embeddings, 

    connection=db, 

    table_name=table_name

)

print("Created new table with LangChain-compatible schema!")



# --- 4. SETUP STARCODER2 ---
print("Starting model setup...")
try:
    from transformers import BitsAndBytesConfig
    model_id = "bigcode/starcoder2-3b"

    tokenizer = AutoTokenizer.from_pretrained(model_id)
    print("Tokenizer loaded.")

    # Define stopping criteria to prevent the model from rambling or looping
    class StopOnTokens(StoppingCriteria):
        def __call__(self, input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs) -> bool:
            stop_ids = [tokenizer.encode(s, add_special_tokens=False)[0] for s in ["Question:", "Human:", "User:", "\n\nHuman:"]]
            return input_ids[0][-1] in stop_ids

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
        do_sample=True,       # Adds variety
        temperature=0.5,      # Lower temperature for more focused answers (0.7 -> 0.5)
        top_p=0.95,
        return_full_text=False, # Prevents the prompt from being included in the answer
        stopping_criteria=StoppingCriteriaList([StopOnTokens()]), # Stops generation early
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
    "You are a helpful technical assistant. Use the retrieved context below to answer the user's question.\n"
    "If the context contains the answer, use it. If not, state that you don't know.\n"
    "Keep your answer concise and stop writing after the answer.\n\n"
    "CONTEXT:\n"
    "----------------------\n"
    "{context}\n"
    "----------------------"
)
qa_prompt = ChatPromptTemplate.from_messages([
    ("system", system_prompt),
    MessagesPlaceholder("chat_history"),
    ("human", "Question: {input}\nAnswer:"),
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
        print("enter quit to exit and clear to clear the history")
        if user_input.lower() == 'quit':
            break
        elif user_input.lower() == 'clear':
            clear_memory()
            continue
        
        ask_bot(user_input)