import os
import torch
# Set cache before any imports
os.environ['HF_HOME'] = 'X:/AI_Models'
os.environ['TRANSFORMERS_CACHE'] = 'X:/AI_Models'

from langchain_community.document_loaders import DirectoryLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter, Language
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import LanceDB
from langchain_huggingface import HuggingFacePipeline
from langchain_classic.chains import create_history_aware_retriever
from langchain_classic.chains.retrieval import create_retrieval_chain
from langchain_classic.chains.combine_documents import create_stuff_documents_chain
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import HumanMessage, AIMessage
from transformers import AutoModelForCausalLM, AutoTokenizer, pipeline, BitsAndBytesConfig
import lancedb

# --- 1. DATA PREPARATION ---
loader = DirectoryLoader('./notebook/MyCodeBase', glob="**/*.py")
docs = loader.load()

python_splitter = RecursiveCharacterTextSplitter.from_language(
    language=Language.PYTHON, 
    chunk_size=1000, 
    chunk_overlap=100
)
chunks = python_splitter.split_documents(docs)

# FIX: Keep metadata as a dictionary but clean the values for LanceDB
for chunk in chunks:
    source_path = str(chunk.metadata.get('source', 'Unknown'))
    chunk.metadata = {"source": source_path}

# --- 2. VECTOR DATABASE (LanceDB) ---
embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
db = lancedb.connect("./notebook/RAGData")
table_name = "code_repo"

# Full reset to avoid schema mismatch errors
if table_name in db.list_tables():
    db.drop_table(table_name)
    print(f"Dropped old table '{table_name}' for a clean start.")

# This ONE command creates the table and adds all 'chunks'
vector_store = LanceDB.from_documents(
    chunks, 
    embeddings, 
    connection=db, 
    table_name=table_name
)
print("Vector database ready!")

# --- 3. MODEL SETUP (StarCoder2-3B) ---
model_id = "bigcode/starcoder2-3b"
quantization_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_compute_dtype=torch.float16,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_use_double_quant=True,
)

print("Loading StarCoder2-3B...")
tokenizer = AutoTokenizer.from_pretrained(model_id)
model = AutoModelForCausalLM.from_pretrained(
    model_id,
    quantization_config=quantization_config,
    device_map="auto"
)

from transformers import StoppingCriteria, StoppingCriteriaList

# Create a custom stopping rule
class StopOnTokens(StoppingCriteria):
    def __call__(self, input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs) -> bool:
        stop_ids = [tokenizer.encode(s, add_special_tokens=False)[0] for s in ["Question:", "Human:"]]
        return input_ids[0][-1] in stop_ids

pipe = pipeline(
    "text-generation",
    model=model,
    tokenizer=tokenizer,
    max_new_tokens=256,
    return_full_text=False, # This hides the prompt, only shows the answer
    stopping_criteria=StoppingCriteriaList([StopOnTokens()]) # Stops the bot from typing extra questions
)
llm = HuggingFacePipeline(pipeline=pipe)
print("Model setup complete!")

# --- 4. THE RAG CHAIN ---
stop_list = ["Human:", "User:", "System:", "Context:", "\n\n"] # Added "Context:" to stop list

pipe = pipeline(
    "text-generation",
    model=model,
    tokenizer=tokenizer,
    max_new_tokens=256,
    device_map="auto",
    eos_token_id=tokenizer.eos_token_id,
    pad_token_id=tokenizer.eos_token_id,
    return_full_text=False # This fixed the "weird" repetition!
)
llm = HuggingFacePipeline(pipeline=pipe)

contextualize_q_prompt = ChatPromptTemplate.from_messages([
    ("system", "Formulate a standalone question based on chat history."),
    MessagesPlaceholder("chat_history"),
    ("human", "{input}"),
])

#Context is only provided once to the model
qa_prompt = ChatPromptTemplate.from_messages([
    ("system", (
        "You are a professional coding assistant. "
        "Rules:\n"
        "1. Use the provided context FIRST to answer.\n"
        "2. If the answer is NOT in the context, answer using your general knowledge but start with 'Note: I am using my general knowledge for this answer.'\n"
        "3. Always format code inside Markdown code blocks.\n"
        "4. Stop writing immediately after finishing the answer."
    )),
    MessagesPlaceholder("chat_history"),
    ("human", (
        "Example 1:\n"
        "Context: def login(): pass\n"
        "Question: How to login?\n"
        "Answer: Use the `login()` function. \n\n"
        
        "Example 2:\n"
        "Context: No information about radio buttons.\n"
        "Question: How to make a radio button?\n"
        "Answer: Note: I am using my general knowledge for this answer. To create a radio button in HTML, use `<input type='radio'>`.\n\n"
        
        "Actual Task:\n"
        "Context: {context}\n"
        "Question: {input}\n"
        "Answer:"
    )),
])

history_aware_retriever = create_history_aware_retriever(
    llm, vector_store.as_retriever(), contextualize_q_prompt
)

combine_docs_chain = create_stuff_documents_chain(llm, qa_prompt)
rag_chain = create_retrieval_chain(history_aware_retriever, combine_docs_chain)

# --- 5. INTERACTIVE CHAT ---
chat_history = []

def ask_bot(query):
    global chat_history
    result = rag_chain.invoke({"input": query, "chat_history": chat_history})
    chat_history.extend([HumanMessage(content=query), AIMessage(content=result["answer"])])
    
    print(f"\n[BOT]: {result['answer']}")
    print("\n[SOURCES]:")
    for doc in result["context"]:
        print(f"- {doc.metadata.get('source')}")

if __name__ == "__main__":
    print("\nAssistant Ready! Type 'quit' to exit.")
    while True:
        user_input = input("\nYou: ")
        if user_input.lower() == 'quit': break
        ask_bot(user_input)