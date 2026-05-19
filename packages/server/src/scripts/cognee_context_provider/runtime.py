from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

PROGRESS_PREFIX = "__ALLEN_COGNEE_PROGRESS__"


def emit_progress(**payload: Any) -> None:
    print(f"{PROGRESS_PREFIX}{json.dumps(payload)}", file=sys.stderr, flush=True)


def resolve_storage(payload: Dict[str, Any]) -> Dict[str, Any]:
    data_dir = os.path.expanduser(os.path.expandvars(str(payload.get("dataDir") or "")))
    storage_root = Path(data_dir or "~/.allen/cognee").expanduser().resolve()
    data_root = storage_root
    system_root = storage_root / "system"
    database_path = system_root / "databases"
    storage_existing = database_path.exists() and any(database_path.iterdir())
    data_root.mkdir(parents=True, exist_ok=True)
    system_root.mkdir(parents=True, exist_ok=True)
    return {
        "storageRoot": str(storage_root),
        "dataRoot": str(data_root),
        "systemRoot": str(system_root),
        "databasePath": str(database_path),
        "storageExisting": storage_existing,
    }


def configure_environment(payload: Dict[str, Any]) -> Dict[str, Any]:
    storage = resolve_storage(payload)
    data_root = str(storage["dataRoot"])
    system_root = str(storage["systemRoot"])
    cache_root = str(Path(storage["storageRoot"]) / "cache")
    logs_root = str(Path(storage["storageRoot"]) / "logs")

    # Cognee 1.x uses pydantic field names for these roots. Keep the COGNEE_*
    # aliases for diagnostics/backward compatibility, but the unprefixed names
    # are the values Cognee actually reads on import.
    os.environ["DATA_ROOT_DIRECTORY"] = data_root
    os.environ["SYSTEM_ROOT_DIRECTORY"] = system_root
    os.environ["CACHE_ROOT_DIRECTORY"] = cache_root
    os.environ["COGNEE_DATA_ROOT_DIRECTORY"] = data_root
    os.environ["COGNEE_SYSTEM_ROOT_DIRECTORY"] = system_root
    os.environ.setdefault("COGNEE_LOGS_DIR", logs_root)
    if str(payload.get("embeddingProvider") or "local") == "local":
        model = str(payload.get("embeddingModel") or "BAAI/bge-small-en-v1.5")
        os.environ["EMBEDDING_PROVIDER"] = "fastembed"
        os.environ["EMBEDDING_MODEL"] = model
    if str(payload.get("llmProvider") or "") in {"codex", "allen_codex"}:
        # Cognee routes LLM calls through LiteLLM/custom providers. Allen
        # exposes an OpenAI-style signed endpoint separately; when Cognee
        # supports the configured custom provider shape, these env vars keep
        # credentials and model routing inside Allen. Direct Cognee-native API
        # providers can override them through environment variables.
        os.environ["LLM_PROVIDER"] = "custom"
        os.environ["LLM_MODEL"] = str(payload.get("llmModel") or "gpt-5.5")
        os.environ["LLM_ENDPOINT"] = str(payload.get("llmUrl") or "")
        os.environ["LLM_API_KEY"] = str(payload.get("llmSecret") or "allen-local")
    return storage


def configure_cognee_runtime(cognee: Any, storage: Dict[str, Any]) -> None:
    # Force runtime config after Cognee import. Cognee's __init__ loads .env with
    # override=True, so environment-only setup can be overwritten by the repo env.
    cognee.config.data_root_directory(str(storage["dataRoot"]))
    cognee.config.system_root_directory(str(storage["systemRoot"]))

