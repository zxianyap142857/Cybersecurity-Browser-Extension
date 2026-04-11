"""
GCP Federated Learning Server  —  deploy to Cloud Run
======================================================

Responsibilities
----------------
* Receive LoRA adapter updates from local extension clients
* Perform FedAvg aggregation using NumPy (no GPU / PyTorch needed on server)
* Store everything in a Cloud Storage bucket
* Serve the latest aggregated adapter to clients on request

Environment variables (set via Cloud Run)
-----------------------------------------
BUCKET_NAME   : GCS bucket that stores adapters and models  (required)
MIN_CLIENTS   : number of client updates before aggregation triggers  (default 1)
API_KEY       : shared secret sent in X-API-Key header         (optional)
PORT          : HTTP port (Cloud Run sets this automatically)
"""

import base64
import io
import json
import logging
import os
import tempfile
import threading
import uuid
import zipfile
from datetime import datetime, timezone

import numpy as np
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from google.cloud import storage
from safetensors.numpy import load_file as _load_st, save_file as _save_st

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

BUCKET_NAME  = os.environ.get("BUCKET_NAME", "")
MIN_CLIENTS  = int(os.environ.get("MIN_CLIENTS", "1"))
API_KEY      = os.environ.get("API_KEY", "")

_agg_lock = threading.Lock()   # one aggregation at a time per process


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------

def _auth_ok() -> bool:
    if not API_KEY:
        return True
    return request.headers.get("X-API-Key") == API_KEY


# ---------------------------------------------------------------------------
# Cloud Storage helpers
# ---------------------------------------------------------------------------

def _bucket():
    return storage.Client().bucket(BUCKET_NAME)


def _list_pending(model_name: str) -> list:
    return list(_bucket().list_blobs(prefix=f"pending_adapters/{model_name}/"))


def _current_version(model_name: str) -> int:
    blob = _bucket().blob(f"global_adapter/{model_name}/version.json")
    if not blob.exists():
        return 0
    return json.loads(blob.download_as_text()).get("version", 0)


# ---------------------------------------------------------------------------
# Adapter serialisation helpers
# ---------------------------------------------------------------------------

def _unzip_adapter(zip_bytes: bytes) -> tuple[dict, str | None]:
    """Return (state_dict_numpy, adapter_config_json_str)."""
    with tempfile.TemporaryDirectory() as d:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            zf.extractall(d)

        st_path  = os.path.join(d, "adapter_model.safetensors")
        bin_path = os.path.join(d, "adapter_model.bin")
        cfg_path = os.path.join(d, "adapter_config.json")

        if os.path.isfile(st_path):
            state_dict = _load_st(st_path)
        elif os.path.isfile(bin_path):
            # Fallback: bin format — convert to numpy
            import torch
            td = torch.load(bin_path, map_location="cpu")
            state_dict = {k: v.numpy() for k, v in td.items()}
        else:
            raise ValueError("No adapter_model.safetensors or .bin found in ZIP.")

        config = open(cfg_path).read() if os.path.isfile(cfg_path) else None
    return state_dict, config


def _zip_state_dict(state_dict: dict, adapter_config_json: str | None) -> bytes:
    """Pack a numpy state dict back into an adapter ZIP."""
    with tempfile.TemporaryDirectory() as d:
        st_path  = os.path.join(d, "adapter_model.safetensors")
        _save_st(state_dict, st_path)
        if adapter_config_json:
            with open(os.path.join(d, "adapter_config.json"), "w") as f:
                f.write(adapter_config_json)

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for fname in os.listdir(d):
                zf.write(os.path.join(d, fname), fname)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# FedAvg
# ---------------------------------------------------------------------------

def _fedavg(state_dicts: list[dict], sample_counts: list[int]) -> dict:
    """Weighted average of numpy adapter state dicts."""
    total = sum(sample_counts)
    weights = [s / total for s in sample_counts]
    result = {}
    for key in state_dicts[0]:
        result[key] = sum(
            sd[key].astype(np.float32) * w
            for sd, w in zip(state_dicts, weights)
        )
    return result


# ---------------------------------------------------------------------------
# Aggregation  (runs in background thread)
# ---------------------------------------------------------------------------

def _aggregate(model_name: str) -> None:
    with _agg_lock:
        pending = _list_pending(model_name)
        if len(pending) < MIN_CLIENTS:
            log.info("[AGG] %s: %d/%d — skipping.", model_name, len(pending), MIN_CLIENTS)
            return

        log.info("[AGG] %s: aggregating %d updates…", model_name, len(pending))
        bkt = _bucket()

        state_dicts: list[dict] = []
        sample_counts: list[int] = []
        adapter_config_json = None

        for blob in pending:
            meta         = blob.metadata or {}
            sample_count = int(meta.get("sample_count", 1))
            zip_bytes    = blob.download_as_bytes()
            sd, cfg      = _unzip_adapter(zip_bytes)
            state_dicts.append(sd)
            sample_counts.append(sample_count)
            if adapter_config_json is None:
                adapter_config_json = cfg

        avg_sd = _fedavg(state_dicts, sample_counts)

        # Upload aggregated adapter
        agg_zip = _zip_state_dict(avg_sd, adapter_config_json)
        bkt.blob(f"global_adapter/{model_name}/adapter_model.safetensors").upload_from_string(
            # save raw safetensors bytes extracted from the ZIP
            _extract_safetensors_bytes(agg_zip),
            content_type="application/octet-stream",
        )
        if adapter_config_json:
            bkt.blob(f"global_adapter/{model_name}/adapter_config.json").upload_from_string(
                adapter_config_json, content_type="application/json"
            )

        new_version = _current_version(model_name) + 1
        version_meta = {
            "version":    new_version,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "clients":    len(state_dicts),
            "samples":    sum(sample_counts),
        }
        bkt.blob(f"global_adapter/{model_name}/version.json").upload_from_string(
            json.dumps(version_meta), content_type="application/json"
        )

        # Remove processed pending files
        for blob in pending:
            blob.delete()

        log.info("[AGG] %s: done — v%d (%d clients, %d samples).",
                 model_name, new_version, len(state_dicts), sum(sample_counts))


def _extract_safetensors_bytes(zip_bytes: bytes) -> bytes:
    """Pull adapter_model.safetensors bytes out of a ZIP."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        return zf.read("adapter_model.safetensors")


# ---------------------------------------------------------------------------
# Flask endpoints
# ---------------------------------------------------------------------------

@app.route("/health")
def health():
    return jsonify({"status": "ok", "bucket": BUCKET_NAME, "min_clients": MIN_CLIENTS})


@app.route("/submit_update", methods=["POST"])
def submit_update():
    """
    Called by local extension backend after local LoRA training.

    Body JSON:
      model          : 'distilbert' | 'mobilebert'
      adapter_weights: base64-encoded ZIP of LoRA adapter files
      sample_count   : number of training samples used
      client_id      : arbitrary string identifying this client
    """
    if not _auth_ok():
        return jsonify({"error": "Unauthorized"}), 401

    data        = request.get_json(force=True)
    model_name  = data.get("model", "distilbert")
    adapter_b64 = data.get("adapter_weights", "")
    sample_count = int(data.get("sample_count", 1))
    client_id   = data.get("client_id", str(uuid.uuid4())[:8])

    if not adapter_b64:
        return jsonify({"error": "adapter_weights is required"}), 400

    # Store adapter in GCS
    ts        = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
    blob_name = f"pending_adapters/{model_name}/{client_id}_{ts}.zip"
    bkt       = _bucket()
    blob      = bkt.blob(blob_name)
    blob.metadata = {"sample_count": str(sample_count)}
    blob.upload_from_string(base64.b64decode(adapter_b64), content_type="application/zip")
    blob.patch()   # commit metadata

    pending_count = len(_list_pending(model_name))
    will_aggregate = pending_count >= MIN_CLIENTS

    log.info("[SUBMIT] %s: %s  pending=%d  will_agg=%s",
             model_name, client_id, pending_count, will_aggregate)

    if will_aggregate:
        threading.Thread(target=_aggregate, args=(model_name,), daemon=True).start()

    return jsonify({
        "status":         "received",
        "pending_count":  pending_count,
        "min_clients":    MIN_CLIENTS,
        "will_aggregate": will_aggregate,
    })


@app.route("/adapter_version")
def adapter_version():
    """Return current aggregated adapter version info (no auth needed for polling)."""
    model_name = request.args.get("model", "distilbert")
    blob = _bucket().blob(f"global_adapter/{model_name}/version.json")
    if not blob.exists():
        return jsonify({"version": 0, "updated_at": None, "clients": 0})
    return jsonify(json.loads(blob.download_as_text()))


@app.route("/download_adapter")
def download_adapter():
    """
    Download the latest aggregated LoRA adapter as a ZIP.
    Clients apply this to their local base model.
    """
    if not _auth_ok():
        return jsonify({"error": "Unauthorized"}), 401

    model_name = request.args.get("model", "distilbert")
    bkt        = _bucket()

    # Collect adapter files (everything except version.json)
    blobs = [
        b for b in bkt.list_blobs(prefix=f"global_adapter/{model_name}/")
        if not b.name.endswith("version.json")
    ]

    if not blobs:
        return jsonify({"error": f"No aggregated adapter for '{model_name}' yet. "
                                  "Submit updates first."}), 404

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for blob in blobs:
            zf.writestr(os.path.basename(blob.name), blob.download_as_bytes())
    buf.seek(0)

    return send_file(
        buf,
        mimetype="application/zip",
        download_name=f"{model_name}_adapter.zip",
        as_attachment=True,
    )


@app.route("/trigger_aggregate", methods=["POST"])
def trigger_aggregate():
    """Manually trigger aggregation (admin / testing)."""
    if not _auth_ok():
        return jsonify({"error": "Unauthorized"}), 401
    model_name = (request.get_json(force=True) or {}).get("model", "distilbert")
    threading.Thread(target=_aggregate, args=(model_name,), daemon=True).start()
    return jsonify({"status": "triggered", "model": model_name})


@app.route("/pending_count")
def pending_count():
    """How many adapter updates are waiting to be aggregated."""
    model_name = request.args.get("model", "distilbert")
    return jsonify({"count": len(_list_pending(model_name)), "min_clients": MIN_CLIENTS})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
