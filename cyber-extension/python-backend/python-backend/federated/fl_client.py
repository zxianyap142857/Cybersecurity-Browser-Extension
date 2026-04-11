"""
Flower NumPy client with PEFT LoRA adapters for phishing detection fine-tuning.

Supports both DistilBERT and MobileBERT architectures.
LoRA target modules:
  - DistilBERT : q_lin, v_lin  (MultiHeadSelfAttention projections)
  - MobileBERT : query, value  (MobileBertSelfAttention projections)
"""

import torch
import numpy as np
from torch.utils.data import DataLoader, Dataset
from torch.optim import AdamW

import flwr as fl
from peft import get_peft_model, LoraConfig, TaskType


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

class PhishingDataset(Dataset):
    """Minimal dataset that wraps tokenizer output (list-of-lists) and labels."""

    def __init__(self, encodings: dict, labels: list):
        self.input_ids = encodings["input_ids"]
        self.attention_mask = encodings["attention_mask"]
        self.labels = labels

    def __len__(self):
        return len(self.labels)

    def __getitem__(self, idx):
        return {
            "input_ids": torch.tensor(self.input_ids[idx], dtype=torch.long),
            "attention_mask": torch.tensor(self.attention_mask[idx], dtype=torch.long),
            "labels": torch.tensor(self.labels[idx], dtype=torch.long),
        }


# ---------------------------------------------------------------------------
# LoRA configuration
# ---------------------------------------------------------------------------

def make_lora_config(model_name: str) -> LoraConfig:
    """Return a LoraConfig appropriate for the given model architecture."""
    if model_name == "mobilebert":
        target_modules = ["query", "value"]
        # Also save the classifier head so it is part of the trainable state
        modules_to_save = ["classifier"]
    else:  # distilbert
        target_modules = ["q_lin", "v_lin"]
        modules_to_save = ["pre_classifier", "classifier"]

    return LoraConfig(
        task_type=TaskType.SEQ_CLS,
        r=8,
        lora_alpha=16,
        lora_dropout=0.1,
        target_modules=target_modules,
        modules_to_save=modules_to_save,
        bias="none",
    )


# ---------------------------------------------------------------------------
# Flower client
# ---------------------------------------------------------------------------

class PhishingClient(fl.client.NumPyClient):
    """
    A Flower NumPyClient that fine-tunes a phishing-detection classifier with
    PEFT LoRA on a local data partition.

    Parameters
    ----------
    model_name      : 'distilbert' | 'mobilebert'
    base_model      : Pre-loaded HuggingFace classification model (deepcopy per client)
    tokenizer       : Matching HuggingFace tokenizer
    data_partition  : List of dicts {'url': str, 'label': int}
    device          : torch.device
    """

    def __init__(self, model_name, base_model, tokenizer, data_partition, device):
        self.model_name = model_name
        self.tokenizer = tokenizer
        self.data_partition = data_partition
        self.device = device

        self.model = get_peft_model(base_model, make_lora_config(model_name))
        self.model.to(device)

    # ------------------------------------------------------------------
    # Flower protocol helpers
    # ------------------------------------------------------------------

    def get_parameters(self, config):
        """Return only the trainable (LoRA + saved) parameters as numpy arrays."""
        return [
            val.cpu().detach().numpy()
            for val in self.model.parameters()
            if val.requires_grad
        ]

    def set_parameters(self, parameters):
        """Overwrite trainable parameters from a list of numpy arrays."""
        trainable = [p for p in self.model.parameters() if p.requires_grad]
        for param, new_val in zip(trainable, parameters):
            param.data = torch.tensor(new_val, dtype=param.dtype).to(self.device)

    # ------------------------------------------------------------------
    # Flower protocol methods
    # ------------------------------------------------------------------

    def fit(self, parameters, config):
        self.set_parameters(parameters)
        self.model.train()

        urls = [d["url"] for d in self.data_partition]
        labels = [int(d["label"]) for d in self.data_partition]
        max_len = 64 if self.model_name == "distilbert" else 128

        enc = self.tokenizer(
            urls,
            max_length=max_len,
            padding="max_length",
            truncation=True,
        )
        dataset = PhishingDataset(enc, labels)
        batch_size = min(4, len(dataset))
        loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

        optimizer = AdamW(
            [p for p in self.model.parameters() if p.requires_grad],
            lr=2e-4,
        )

        total_loss = 0.0
        for batch in loader:
            optimizer.zero_grad()
            out = self.model(
                input_ids=batch["input_ids"].to(self.device),
                attention_mask=batch["attention_mask"].to(self.device),
                labels=batch["labels"].to(self.device),
            )
            out.loss.backward()
            torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
            optimizer.step()
            total_loss += out.loss.item()

        avg_loss = total_loss / max(len(loader), 1)
        print(f"    [FL Client | {self.model_name}] loss={avg_loss:.4f}  samples={len(dataset)}")
        return self.get_parameters(config={}), len(dataset), {"loss": avg_loss}

    def evaluate(self, parameters, config):
        # No held-out eval set from user reports; skip evaluation round.
        return 0.0, len(self.data_partition), {}
