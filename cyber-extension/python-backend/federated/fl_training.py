"""
Federated Learning training orchestrator.

Design
------
* Uses a **manual simulation loop** (no Ray) so it runs reliably on Windows.
* Each FL round:
    1. Every virtual client calls client.fit(global_params)  →  local update
    2. Server aggregates via FedAvg (weighted average by sample count)
    3. Global parameters are updated
* After all rounds the final LoRA weights are **merged** into the base model
  (merge_and_unload) and saved back to the model directory so that the next
  /predict or /batch_predict call immediately uses the improved model.

Thread safety
-------------
The public `_fl_status` dict is written only by `run_federated_training`, which
is always called from a single background thread per model, so no lock is needed
for the basic status reads done by Flask.
"""

import base64
import copy
import gc
import io
import json
import os
import shutil
import tempfile
import time
import zipfile

import numpy as np
import torch

# ---------------------------------------------------------------------------
# Path helpers (resolved relative to this file, not the working directory)
# ---------------------------------------------------------------------------

_FEDERATED_DIR = os.path.dirname(os.path.abspath(__file__))
_BACKEND_DIR   = os.path.dirname(_FEDERATED_DIR)
_EXTENSION_DIR = os.path.dirname(_BACKEND_DIR)

MODEL_PATHS = {
    "distilbert": os.path.join(_EXTENSION_DIR, "model", "Distil BERT"),
    "mobilebert": os.path.join(_EXTENSION_DIR, "model", "Mobile BERT"),
}

REPORTED_DATA_PATH = os.path.join(_BACKEND_DIR, "reported_data.json")

MIN_REPORTS = 2   # minimum reports needed to start a training run

# ---------------------------------------------------------------------------
# Shared status dict  (read by Flask /fl_status endpoint)
# ---------------------------------------------------------------------------

_fl_status: dict = {"state": "idle", "message": ""}


def get_status() -> dict:
    return _fl_status.copy()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load_base_model(model_name: str):
    """Load and return (tokenizer, model) for the given architecture."""
    from transformers import (
        DistilBertForSequenceClassification,
        DistilBertTokenizer,
        MobileBertForSequenceClassification,
        MobileBertTokenizer,
    )

    load_dir = MODEL_PATHS[model_name]
    if not os.path.isdir(load_dir) or not os.listdir(load_dir):
        raise FileNotFoundError(
            f'Model directory "{load_dir}" is empty or does not exist. '
            f"Please add the {model_name} model files first."
        )

    if model_name == "mobilebert":
        tokenizer = MobileBertTokenizer.from_pretrained(load_dir)
        model = MobileBertForSequenceClassification.from_pretrained(
            load_dir, num_labels=2
        )
    else:
        tokenizer = DistilBertTokenizer.from_pretrained(load_dir)
        model = DistilBertForSequenceClassification.from_pretrained(
            load_dir, num_labels=2
        )

    return tokenizer, model


def _fedavg(params_list: list[list], sizes: list[int]) -> list:
    """Weighted average of parameter arrays (FedAvg aggregation)."""
    total = sum(sizes)
    return [
        sum(p[i] * (s / total) for p, s in zip(params_list, sizes))
        for i in range(len(params_list[0]))
    ]


# ---------------------------------------------------------------------------
# Public training entry point
# ---------------------------------------------------------------------------

def run_federated_training(
    model_name: str,
    num_rounds: int = 3,
    num_virtual_clients: int = 2,
) -> dict:
    """
    Load reported data, create virtual FL clients, run the simulation loop,
    merge LoRA weights and save the updated model.

    Always updates `_fl_status` so the Flask /fl_status endpoint can be polled.

    Returns a result dict  { 'status': 'success'|'error', ... }.
    """
    global _fl_status

    _fl_status = {"state": "running", "message": f"Initialising {model_name} FL training…"}

    try:
        from .fl_client import PhishingClient   # local import avoids circular deps

        # ── 1. Load reported data ──────────────────────────────────────────
        if not os.path.isfile(REPORTED_DATA_PATH):
            msg = "No reported data found. Submit at least 2 reports first."
            _fl_status = {"state": "idle", "message": msg}
            return {"status": "error", "message": msg}

        with open(REPORTED_DATA_PATH, "r", encoding="utf-8") as fh:
            all_data = json.load(fh)

        model_data = [d for d in all_data if d.get("model") == model_name]
        if len(model_data) < MIN_REPORTS:
            msg = (
                f"Need at least {MIN_REPORTS} reports for {model_name}. "
                f"Currently have {len(model_data)}."
            )
            _fl_status = {"state": "idle", "message": msg}
            return {"status": "error", "message": msg}

        # ── 2. Load base model ─────────────────────────────────────────────
        _fl_status["message"] = f"Loading {model_name} base model…"
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        tokenizer, base_model = _load_base_model(model_name)

        # ── 3. Partition data into virtual clients ─────────────────────────
        n_clients = min(num_virtual_clients, len(model_data))
        chunk = max(1, len(model_data) // n_clients)
        partitions = [
            model_data[i * chunk : (i + 1) * chunk] for i in range(n_clients)
        ]
        # Append remainder to the last partition
        remainder = model_data[n_clients * chunk :]
        if remainder:
            partitions[-1].extend(remainder)

        # ── 4. Instantiate clients (each gets a deep-copy of the base model) ─
        clients = [
            PhishingClient(
                model_name=model_name,
                base_model=copy.deepcopy(base_model),
                tokenizer=tokenizer,
                data_partition=partitions[i],
                device=device,
            )
            for i in range(n_clients)
        ]

        # ── 5. Initialise global parameters from client 0 ─────────────────
        global_params = clients[0].get_parameters(config={})

        # ── 6. FL rounds ───────────────────────────────────────────────────
        for rnd in range(1, num_rounds + 1):
            _fl_status["message"] = (
                f"[{model_name}] Round {rnd}/{num_rounds} — local training…"
            )
            print(f"\n[FL] === Round {rnd}/{num_rounds} ===")

            local_updates: list[list] = []
            sample_counts: list[int] = []

            for client in clients:
                updated_params, n_samples, metrics = client.fit(global_params, config={})
                local_updates.append(updated_params)
                sample_counts.append(n_samples)

            # FedAvg aggregation
            global_params = _fedavg(local_updates, sample_counts)
            print(f"[FL] Round {rnd} aggregated over {sum(sample_counts)} samples.")

        # ── 7. Apply final global params to client 0, merge LoRA & save ───
        _fl_status["message"] = f"Merging LoRA weights and saving {model_name} model…"
        print(f"\n[FL] Merging LoRA weights into base model…")

        clients[0].set_parameters(global_params)
        merged_model = clients[0].model.merge_and_unload()

        # Free all references that hold Windows memory-mapped file handles
        # before writing back to the same model directory (OS error 1224).
        del clients
        del base_model
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        save_dir = MODEL_PATHS[model_name]

        # Save to a temp dir first, then copy over to avoid overwriting
        # memory-mapped files while they are still locked by Windows.
        with tempfile.TemporaryDirectory() as tmpdir:
            merged_model.save_pretrained(tmpdir, safe_serialization=False)
            tokenizer.save_pretrained(tmpdir)
            del merged_model
            gc.collect()
            # Remove ALL old weight files so from_pretrained() doesn't pick
            # up a stale model.safetensors instead of the new pytorch_model.bin
            for old in ['model.safetensors', 'pytorch_model.bin',
                        'pytorch_model.bin.index.json']:
                p = os.path.join(save_dir, old)
                if os.path.exists(p):
                    os.remove(p)
            for fname in os.listdir(tmpdir):
                shutil.copy2(os.path.join(tmpdir, fname),
                             os.path.join(save_dir, fname))

        print(f"[FL] Saved updated {model_name} model to: {save_dir}")

        # Clear used reports for this model from reported_data.json
        try:
            if os.path.isfile(REPORTED_DATA_PATH):
                with open(REPORTED_DATA_PATH, "r", encoding="utf-8") as fh:
                    all_reports = json.load(fh)
                remaining = [r for r in all_reports if r.get("model") != model_name]
                with open(REPORTED_DATA_PATH, "w", encoding="utf-8") as fh:
                    json.dump(remaining, fh, indent=2)
                print(f"[FL] Cleared {len(model_data)} {model_name} reports. {len(remaining)} reports remaining for other models.")
        except Exception as e:
            print(f"[FL] Warning: Failed to clear reports: {e}")

        result_msg = (
            f"Done — {num_rounds} rounds, {n_clients} clients, "
            f"{len(model_data)} reports used. Reports cleared."
        )
        _fl_status = {"state": "idle", "message": result_msg}
        return {
            "status": "success",
            "model": model_name,
            "rounds": num_rounds,
            "clients": n_clients,
            "samples_used": len(model_data),
            "message": result_msg,
        }

    except Exception as exc:
        import traceback
        traceback.print_exc()
        msg = f"Training failed: {exc}"
        _fl_status = {"state": "idle", "message": msg}
        return {"status": "error", "message": msg}


# ---------------------------------------------------------------------------
# Cloud training (delegates to Google Colab via ngrok)
# ---------------------------------------------------------------------------

def run_cloud_federated_training(
    cloud_url: str,
    model_name: str,
    num_rounds: int = 3,
) -> dict:
    """
    Sends reported data to a Colab FL server, polls for the adapter weights,
    then applies and saves them locally.

    Parameters
    ----------
    cloud_url   : ngrok public URL printed by the Colab notebook
                  e.g. "https://abcd-12-34-56-78.ngrok-free.app"
    model_name  : 'distilbert' | 'mobilebert'
    num_rounds  : number of FL rounds to run on Colab
    """
    import requests     # stdlib-like; already pulled in by flask's deps

    global _fl_status
    _fl_status = {"state": "running", "message": "Connecting to Colab server…"}

    try:
        # ── 1. Health check ────────────────────────────────────────────────
        cloud_url = cloud_url.rstrip("/")
        try:
            hc = requests.get(f"{cloud_url}/health", timeout=10)
            hc.raise_for_status()
            device_info = hc.json().get("device", "unknown")
            print(f"[Cloud FL] Colab server reachable. Device: {device_info}")
        except Exception as e:
            msg = f"Cannot reach Colab server at {cloud_url}: {e}"
            _fl_status = {"state": "idle", "message": msg}
            return {"status": "error", "message": msg}

        # ── 2. Load reported data ──────────────────────────────────────────
        if not os.path.isfile(REPORTED_DATA_PATH):
            msg = "No reported data found locally."
            _fl_status = {"state": "idle", "message": msg}
            return {"status": "error", "message": msg}

        with open(REPORTED_DATA_PATH, "r", encoding="utf-8") as fh:
            all_data = json.load(fh)

        model_data = [d for d in all_data if d.get("model") == model_name]
        if len(model_data) < MIN_REPORTS:
            msg = (f"Need ≥ {MIN_REPORTS} reports for {model_name}. "
                   f"Have {len(model_data)}.")
            _fl_status = {"state": "idle", "message": msg}
            return {"status": "error", "message": msg}

        # ── 3. Send training request to Colab ─────────────────────────────
        _fl_status["message"] = (
            f"Sending {len(model_data)} reports to Colab for {model_name}…"
        )
        print(f"[Cloud FL] Sending {len(model_data)} samples to Colab…")

        resp = requests.post(
            f"{cloud_url}/fl_train_cloud",
            json={"reported_data": model_data,
                  "model": model_name,
                  "rounds": num_rounds},
            timeout=30,
        )
        resp.raise_for_status()
        start_data = resp.json()
        if start_data.get("status") not in ("started", "ok"):
            msg = start_data.get("message", "Colab rejected the training request.")
            _fl_status = {"state": "idle", "message": msg}
            return {"status": "error", "message": msg}

        print("[Cloud FL] Training started on Colab. Polling for result…")

        # ── 4. Poll /fl_result until done ─────────────────────────────────
        max_wait_secs = 1800   # 30-minute timeout
        poll_interval = 10
        elapsed = 0

        while elapsed < max_wait_secs:
            time.sleep(poll_interval)
            elapsed += poll_interval

            try:
                pr = requests.get(f"{cloud_url}/fl_result", timeout=15)
                pr.raise_for_status()
                result = pr.json()
            except Exception as e:
                print(f"[Cloud FL] Poll failed ({e}), retrying…")
                continue

            state = result.get("state")
            _fl_status["message"] = (
                f"[Colab] {result.get('message', '')}  ({elapsed}s elapsed)"
            )
            print(f"[Cloud FL] state={state}  {result.get('message','')}")

            if state == "error":
                msg = result.get("message", "Colab training error.")
                _fl_status = {"state": "idle", "message": msg}
                return {"status": "error", "message": msg}

            if state == "done" and "adapter_weights" in result:
                # ── 5. Receive adapter weights, apply locally ──────────────
                _fl_status["message"] = "Received adapter weights. Applying to local model…"
                print("[Cloud FL] Adapter weights received. Applying locally…")

                adapter_bytes = base64.b64decode(result["adapter_weights"])

                with tempfile.TemporaryDirectory() as tmpdir:
                    # Unzip adapter files
                    with zipfile.ZipFile(io.BytesIO(adapter_bytes)) as zf:
                        zf.extractall(tmpdir)
                    print(f"[Cloud FL] Adapter files: {os.listdir(tmpdir)}")

                    # Load base model + apply adapter
                    from peft import PeftModel
                    tokenizer, base_model = _load_base_model(model_name)
                    base_model.eval()
                    device = torch.device(
                        "cuda" if torch.cuda.is_available() else "cpu"
                    )
                    base_model.to(device)

                    peft_model = PeftModel.from_pretrained(base_model, tmpdir)
                    merged = peft_model.merge_and_unload()

                # Save merged model — use temp+copy to avoid Windows memory-map lock
                save_dir = MODEL_PATHS[model_name]
                with tempfile.TemporaryDirectory() as save_tmp:
                    merged.save_pretrained(save_tmp, safe_serialization=False)
                    tokenizer.save_pretrained(save_tmp)
                    del merged
                    gc.collect()
                    for old in ['model.safetensors', 'pytorch_model.bin',
                                'pytorch_model.bin.index.json']:
                        p = os.path.join(save_dir, old)
                        if os.path.exists(p):
                            os.remove(p)
                    for fname in os.listdir(save_tmp):
                        shutil.copy2(os.path.join(save_tmp, fname),
                                     os.path.join(save_dir, fname))
                print(f"[Cloud FL] Saved updated {model_name} to {save_dir}")

                # Clear used reports for this model
                try:
                    if os.path.isfile(REPORTED_DATA_PATH):
                        with open(REPORTED_DATA_PATH, "r", encoding="utf-8") as fh:
                            all_reports = json.load(fh)
                        remaining = [r for r in all_reports if r.get("model") != model_name]
                        with open(REPORTED_DATA_PATH, "w", encoding="utf-8") as fh:
                            json.dump(remaining, fh, indent=2)
                        print(f"[Cloud FL] Cleared {len(model_data)} {model_name} reports.")
                except Exception as e:
                    print(f"[Cloud FL] Warning: Failed to clear reports: {e}")

                result_msg = (
                    f"Cloud FL done — {num_rounds} rounds on Colab, "
                    f"{len(model_data)} samples. Model updated locally. Reports cleared."
                )
                _fl_status = {"state": "idle", "message": result_msg}
                return {
                    "status":       "success",
                    "model":        model_name,
                    "rounds":       num_rounds,
                    "samples_used": len(model_data),
                    "message":      result_msg,
                }

        msg = f"Timed out after {max_wait_secs}s waiting for Colab."
        _fl_status = {"state": "idle", "message": msg}
        return {"status": "error", "message": msg}

    except Exception as exc:
        import traceback
        traceback.print_exc()
        msg = f"Cloud FL failed: {exc}"
        _fl_status = {"state": "idle", "message": msg}
        return {"status": "error", "message": msg}


# ---------------------------------------------------------------------------
# GCP Cloud Run training
# ---------------------------------------------------------------------------

def run_gcp_federated_training(
    gcp_server_url: str,
    model_name: str,
    num_rounds: int = 1,
    api_key: str = "",
) -> dict:
    """
    Local FL client that communicates with the GCP Cloud Run FL server.

    Flow
    ----
    1. Train a LoRA adapter locally on the reported data (local_rounds passes)
    2. Upload the adapter ZIP to GCP  →  /submit_update
    3. If the server reaches MIN_CLIENTS, it auto-aggregates (FedAvg)
    4. Poll  /adapter_version  until the version number increments
    5. Download the aggregated adapter  →  /download_adapter
    6. Apply adapter to local base model  →  merge_and_unload  →  save

    Parameters
    ----------
    gcp_server_url : Cloud Run service URL, e.g. https://fl-server-xxxx.run.app
    model_name     : 'distilbert' | 'mobilebert'
    num_rounds     : local training rounds before sending to server
    api_key        : value for X-API-Key header (set in Cloud Run env vars)
    """
    import requests as _req
    import uuid

    global _fl_status
    _fl_status = {"state": "running", "message": "Connecting to GCP FL server…"}

    try:
        from .fl_client import PhishingClient

        gcp_server_url = gcp_server_url.rstrip("/")
        headers = {"X-API-Key": api_key} if api_key else {}

        # ── 1. Health check ────────────────────────────────────────────────
        try:
            hc = _req.get(f"{gcp_server_url}/health", headers=headers, timeout=15)
            hc.raise_for_status()
            print(f"[GCP FL] Server reachable: {hc.json()}")
        except Exception as e:
            msg = f"Cannot reach GCP server at '{gcp_server_url}': {e}"
            _fl_status = {"state": "idle", "message": msg}
            return {"status": "error", "message": msg}

        # ── 2. Load reported data ──────────────────────────────────────────
        if not os.path.isfile(REPORTED_DATA_PATH):
            msg = "No reported data found. Submit at least 1 report first."
            _fl_status = {"state": "idle", "message": msg}
            return {"status": "error", "message": msg}

        with open(REPORTED_DATA_PATH, "r", encoding="utf-8") as fh:
            all_data = json.load(fh)

        model_data = [d for d in all_data if d.get("model") == model_name]
        if len(model_data) < MIN_REPORTS:
            msg = f"Need ≥ {MIN_REPORTS} reports for {model_name}. Have {len(model_data)}."
            _fl_status = {"state": "idle", "message": msg}
            return {"status": "error", "message": msg}

        # ── 3. Record version before training so we can detect a new one ──
        try:
            vr = _req.get(
                f"{gcp_server_url}/adapter_version?model={model_name}",
                headers=headers,
                timeout=10,
            )
            ver_before = vr.json().get("version", 0) if vr.ok else 0
        except Exception:
            ver_before = 0

        print(f"[GCP FL] Current global adapter version: {ver_before}")

        # ── 4. Train LoRA adapter locally ─────────────────────────────────
        _fl_status["message"] = f"Training local LoRA adapter ({num_rounds} rounds)…"
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        tokenizer, base_model = _load_base_model(model_name)

        client = PhishingClient(
            model_name=model_name,
            base_model=copy.deepcopy(base_model),
            tokenizer=tokenizer,
            data_partition=model_data,
            device=device,
        )

        global_params = client.get_parameters(config={})
        for rnd in range(1, num_rounds + 1):
            _fl_status["message"] = f"Local training round {rnd}/{num_rounds}…"
            updated_params, n_samples, metrics = client.fit(global_params, config={})
            global_params = updated_params
            print(f"[GCP FL] Local round {rnd}/{num_rounds} — "
                  f"loss={metrics.get('loss', '?'):.4f}  samples={n_samples}")

        client.set_parameters(global_params)

        # ── 5. Save adapter (NOT merged) and zip ──────────────────────────
        _fl_status["message"] = "Preparing adapter for upload…"
        with tempfile.TemporaryDirectory() as tmpdir:
            client.model.save_pretrained(tmpdir)   # adapter files only
            adapter_files = os.listdir(tmpdir)
            print(f"[GCP FL] Adapter files: {adapter_files}")

            zip_buf = io.BytesIO()
            with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for fname in adapter_files:
                    zf.write(os.path.join(tmpdir, fname), fname)

        adapter_b64   = base64.b64encode(zip_buf.getvalue()).decode("utf-8")
        adapter_kb    = len(zip_buf.getvalue()) / 1024
        client_id     = str(uuid.uuid4())[:8]
        print(f"[GCP FL] Adapter size: {adapter_kb:.1f} KB  client_id={client_id}")

        # ── 6. Upload adapter to GCP server ───────────────────────────────
        _fl_status["message"] = f"Uploading adapter ({adapter_kb:.0f} KB) to GCP…"
        resp = _req.post(
            f"{gcp_server_url}/submit_update",
            json={
                "model":           model_name,
                "adapter_weights": adapter_b64,
                "sample_count":    len(model_data),
                "client_id":       client_id,
            },
            headers=headers,
            timeout=120,
        )
        resp.raise_for_status()
        submit = resp.json()
        print(f"[GCP FL] Server response: {submit}")

        pending   = submit.get("pending_count", 1)
        min_need  = submit.get("min_clients", 1)
        will_agg  = submit.get("will_aggregate", False)

        # ── 7. If not enough clients yet, return "waiting" status ─────────
        if not will_agg:
            result_msg = (
                f"Update uploaded! Waiting for more clients to contribute. "
                f"{pending}/{min_need} updates on server. "
                f"Model will update once {min_need} clients have submitted."
            )
            _fl_status = {"state": "idle", "message": result_msg}
            return {"status": "waiting", "message": result_msg,
                    "pending": pending, "needed": min_need}

        # ── 8. Aggregation triggered — poll for new version ───────────────
        _fl_status["message"] = "GCP is aggregating updates… polling for result."
        print("[GCP FL] Aggregation triggered. Polling for new version…")

        max_wait_secs = 600   # 10 minutes
        poll_interval = 5
        elapsed       = 0

        while elapsed < max_wait_secs:
            time.sleep(poll_interval)
            elapsed += poll_interval

            try:
                vr = _req.get(
                    f"{gcp_server_url}/adapter_version?model={model_name}",
                    headers=headers,
                    timeout=10,
                )
                ver_now = vr.json().get("version", 0) if vr.ok else ver_before
            except Exception as e:
                print(f"[GCP FL] Poll error ({e}), retrying…")
                continue

            _fl_status["message"] = (
                f"Waiting for GCP aggregation… v{ver_before}→v{ver_now} ({elapsed}s)"
            )
            print(f"[GCP FL] version={ver_now}  elapsed={elapsed}s")

            if ver_now > ver_before:
                break
        else:
            msg = f"Timed out after {max_wait_secs}s waiting for GCP aggregation."
            _fl_status = {"state": "idle", "message": msg}
            return {"status": "error", "message": msg}

        # ── 9. Download aggregated adapter ────────────────────────────────
        _fl_status["message"] = "Downloading aggregated adapter from GCP…"
        print("[GCP FL] Downloading aggregated adapter…")

        dl = _req.get(
            f"{gcp_server_url}/download_adapter?model={model_name}",
            headers=headers,
            timeout=120,
            stream=True,
        )
        dl.raise_for_status()
        adapter_bytes = dl.content
        print(f"[GCP FL] Downloaded {len(adapter_bytes) / 1024:.1f} KB")

        # ── 10. Apply aggregated adapter → merge → save ───────────────────
        _fl_status["message"] = "Applying aggregated adapter to local model…"
        from peft import PeftModel

        with tempfile.TemporaryDirectory() as tmpdir:
            with zipfile.ZipFile(io.BytesIO(adapter_bytes)) as zf:
                zf.extractall(tmpdir)
            print(f"[GCP FL] Adapter files received: {os.listdir(tmpdir)}")

            _, fresh_base = _load_base_model(model_name)
            fresh_base.eval()
            fresh_base.to(device)
            peft_model = PeftModel.from_pretrained(fresh_base, tmpdir)
            merged     = peft_model.merge_and_unload()

        save_dir = MODEL_PATHS[model_name]
        with tempfile.TemporaryDirectory() as save_tmp:
            merged.save_pretrained(save_tmp, safe_serialization=False)
            tokenizer.save_pretrained(save_tmp)
            del merged
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            for old in ['model.safetensors', 'pytorch_model.bin',
                        'pytorch_model.bin.index.json']:
                p = os.path.join(save_dir, old)
                if os.path.exists(p):
                    os.remove(p)
            for fname in os.listdir(save_tmp):
                shutil.copy2(os.path.join(save_tmp, fname),
                             os.path.join(save_dir, fname))
        print(f"[GCP FL] Saved updated model to {save_dir}")

        # Clear used reports for this model
        try:
            if os.path.isfile(REPORTED_DATA_PATH):
                with open(REPORTED_DATA_PATH, "r", encoding="utf-8") as fh:
                    all_reports = json.load(fh)
                remaining = [r for r in all_reports if r.get("model") != model_name]
                with open(REPORTED_DATA_PATH, "w", encoding="utf-8") as fh:
                    json.dump(remaining, fh, indent=2)
                print(f"[GCP FL] Cleared {len(model_data)} {model_name} reports.")
        except Exception as e:
            print(f"[GCP FL] Warning: Failed to clear reports: {e}")

        result_msg = (
            f"GCP FL complete. {len(model_data)} samples contributed. "
            f"Global model updated to version {ver_now}. Reports cleared."
        )
        _fl_status = {"state": "idle", "message": result_msg}
        return {
            "status":         "success",
            "model":          model_name,
            "samples":        len(model_data),
            "global_version": ver_now,
            "message":        result_msg,
        }

    except Exception as exc:
        import traceback
        traceback.print_exc()
        msg = f"GCP FL failed: {exc}"
        _fl_status = {"state": "idle", "message": msg}
        return {"status": "error", "message": msg}
