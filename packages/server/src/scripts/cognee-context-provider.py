#!/usr/bin/env python3
"""Cognee context provider sidecar for Allen.

The script intentionally keeps Cognee behind Allen's provider boundary. It can
ingest/cognify repo memory and retrieve context items. If Cognee is not
installed, it exits with a clear error so Allen can record provider diagnostics.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import NAMESPACE_DNS, UUID, uuid4, uuid5

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from cognee_context_provider.runtime import (
    PROGRESS_PREFIX,
    configure_cognee_runtime,
    configure_environment,
    emit_progress,
)

COGNIFY_SETTLE_POLL_SECONDS = 5
DEFAULT_COGNIFY_NO_PROGRESS_SECONDS = 15 * 60


async def dataset_details(cognee: Any, dataset_name: str) -> Dict[str, Any]:
    try:
        datasets = await cognee.datasets.list_datasets()
    except Exception:
        return {"exists": None, "id": None, "ownerId": None}
    for dataset in datasets if isinstance(datasets, list) else []:
        if isinstance(dataset, dict):
            name = dataset.get("name") or dataset.get("dataset_name") or dataset.get("datasetName")
            dataset_id = dataset.get("id") or dataset.get("dataset_id") or dataset.get("datasetId")
            owner_id = dataset.get("owner_id") or dataset.get("ownerId")
        else:
            name = (
                getattr(dataset, "name", None)
                or getattr(dataset, "dataset_name", None)
                or getattr(dataset, "datasetName", None)
            )
            dataset_id = (
                getattr(dataset, "id", None)
                or getattr(dataset, "dataset_id", None)
                or getattr(dataset, "datasetId", None)
            )
            owner_id = getattr(dataset, "owner_id", None) or getattr(dataset, "ownerId", None)
        if str(name or "") == dataset_name:
            return {
                "exists": True,
                "id": str(dataset_id) if dataset_id else None,
                "ownerId": str(owner_id) if owner_id else None,
            }
    return {"exists": False, "id": None, "ownerId": None}


async def inspect_cognified_documents(dataset_id: Optional[str]) -> Dict[str, Any]:
    inspected = await inspect_dataset_documents(dataset_id)
    if inspected.get("count") is None:
        return {"count": None, "uncognifiedDocuments": []}
    return {
        "count": inspected.get("count"),
        "uncognifiedDocuments": inspected.get("uncognifiedDocuments") or [],
    }


async def inspect_dataset_documents(dataset_id: Optional[str]) -> Dict[str, Any]:
    if not dataset_id:
        return {"count": None, "documents": [], "uncognifiedDocuments": []}
    try:
        from sqlalchemy import select  # type: ignore
        from cognee.infrastructure.databases.relational import get_relational_engine  # type: ignore
        from cognee.modules.data.models import Data, DatasetData  # type: ignore
    except Exception:
        return {"count": None, "documents": [], "uncognifiedDocuments": []}

    try:
        dataset_uuid = UUID(str(dataset_id))
    except Exception:
        return {"count": None, "documents": [], "uncognifiedDocuments": []}

    try:
        db_engine = get_relational_engine()
        async with db_engine.get_async_session() as session:
            rows = (
                await session.execute(
                    select(Data.id, Data.external_metadata, Data.pipeline_status)
                    .join(DatasetData, DatasetData.data_id == Data.id)
                    .where(DatasetData.dataset_id == dataset_uuid)
                )
            ).all()
    except Exception:
        return {"count": None, "documents": [], "uncognifiedDocuments": []}

    completed = 0
    documents: List[Dict[str, Any]] = []
    uncognified: List[Dict[str, Any]] = []
    for data_id, external_metadata, pipeline_status in rows:
        status_value = cognify_status_value(pipeline_status, dataset_id)
        metadata = external_metadata if isinstance(external_metadata, dict) else {}
        record = {
            "path": metadata.get("path"),
            "title": metadata.get("title"),
            "fileHash": metadata.get("fileHash") or metadata.get("file_hash"),
            "dataId": metadata.get("dataId") or metadata.get("data_id"),
            "cogneeDataId": str(data_id),
            "status": str(status_value) if status_value is not None else None,
        }
        documents.append(record)
        if is_cognify_completed(status_value):
            completed += 1
            continue
        uncognified.append(record)
    return {"count": completed, "documents": documents, "uncognifiedDocuments": uncognified}


def cognify_status_value(pipeline_status: Any, dataset_id: str) -> Any:
    if not isinstance(pipeline_status, dict):
        return None
    status_for_dataset = pipeline_status.get("cognify_pipeline")
    if isinstance(status_for_dataset, dict):
        return status_for_dataset.get(str(dataset_id))
    return None


def is_cognify_completed(status_value: Any) -> bool:
    return str(status_value).endswith("DATA_ITEM_PROCESSING_COMPLETED")


async def count_cognified_documents(dataset_id: Optional[str]) -> Optional[int]:
    inspected = await inspect_cognified_documents(dataset_id)
    count = inspected.get("count")
    return count if isinstance(count, int) else None


async def emit_cognify_progress_until_complete(
    cognee: Any,
    dataset_name: str,
    dataset_id: Optional[str],
    total_documents: int,
    storage: Dict[str, Any],
    dataset_existing: Optional[bool],
    ingested_documents: int,
    chunk_size: Optional[int],
) -> None:
    cognify_kwargs: Dict[str, Any] = {"datasets": [dataset_name]}
    if chunk_size:
        cognify_kwargs["chunk_size"] = chunk_size
    task = asyncio.create_task(cognee.cognify(**cognify_kwargs))
    last_emitted: Optional[int] = None
    last_emit_at = 0.0
    last_progress_count: Optional[int] = None
    last_progress_at = time.time()
    no_progress_timeout = cognify_no_progress_timeout_seconds()

    while not task.done():
        cognified = await count_cognified_documents(dataset_id)
        now = time.time()
        if cognified is not None and cognified != last_progress_count:
            last_progress_count = cognified
            last_progress_at = now
        if cognified is not None and (cognified != last_emitted or now - last_emit_at >= 10):
            emit_progress(
                stage="cognifying",
                message=f"Cognified: {cognified}/{total_documents}",
                processedDocumentCount=cognified,
                ingestedDocumentCount=ingested_documents,
                cognifiedDocumentCount=cognified,
                documentCount=total_documents,
                **storage_progress(storage, dataset_existing),
            )
            last_emitted = cognified
            last_emit_at = now
        if no_progress_timeout is not None and now - last_progress_at >= no_progress_timeout:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            raise RuntimeError(
                f"Cognee cognify stalled with no progress for {no_progress_timeout} seconds "
                f"({cognified if cognified is not None else 'unknown'}/{total_documents} cognified)."
            )
        await asyncio.sleep(COGNIFY_SETTLE_POLL_SECONDS)

    await task
    settle_timeout = cognify_settle_timeout_seconds()
    deadline = time.time() + settle_timeout if settle_timeout is not None else None
    last_progress_count = None
    last_progress_at = time.time()
    while True:
        cognified = await count_cognified_documents(dataset_id)
        now = time.time()
        if cognified is not None and cognified != last_progress_count:
            last_progress_count = cognified
            last_progress_at = now
        emit_progress(
            stage="cognifying",
            message=f"Cognified: {cognified if cognified is not None else total_documents}/{total_documents}",
            processedDocumentCount=cognified if cognified is not None else total_documents,
            ingestedDocumentCount=ingested_documents,
            cognifiedDocumentCount=cognified if cognified is not None else total_documents,
            documentCount=total_documents,
            **storage_progress(storage, dataset_existing),
        )
        if cognified is None or cognified >= total_documents or (deadline is not None and time.time() >= deadline):
            return
        if no_progress_timeout is not None and now - last_progress_at >= no_progress_timeout:
            raise RuntimeError(
                f"Cognee cognify stalled with no progress for {no_progress_timeout} seconds "
                f"({cognified}/{total_documents} cognified)."
            )
        await asyncio.sleep(COGNIFY_SETTLE_POLL_SECONDS)


def storage_progress(storage: Dict[str, Any], dataset_existing: Optional[bool] = None) -> Dict[str, Any]:
    payload = {
        "storageRoot": storage["storageRoot"],
        "systemRoot": storage["systemRoot"],
        "databasePath": storage["databasePath"],
        "storageExisting": storage["storageExisting"],
    }
    if dataset_existing is not None:
        payload["datasetExisting"] = dataset_existing
    return payload


def cognify_settle_timeout_seconds() -> Optional[int]:
    raw = os.environ.get("ALLEN_COGNEE_COGNIFY_SETTLE_TIMEOUT_MS")
    if not raw:
        return None
    try:
        parsed = int(raw)
    except Exception:
        return None
    if parsed <= 0:
        return None
    return parsed // 1000


def cognify_no_progress_timeout_seconds() -> Optional[int]:
    raw = os.environ.get("ALLEN_COGNEE_COGNIFY_NO_PROGRESS_MS")
    if not raw:
        return DEFAULT_COGNIFY_NO_PROGRESS_SECONDS
    try:
        parsed = int(raw)
    except Exception:
        return DEFAULT_COGNIFY_NO_PROGRESS_SECONDS
    if parsed <= 0:
        return None
    return max(1, parsed // 1000)


def storage_diagnostic(storage: Dict[str, Any], dataset_existing: Optional[bool] = None) -> Dict[str, Any]:
    diagnostic = {
        "code": "cognee_storage_configured",
        "severity": "info",
        **storage_progress(storage, dataset_existing),
    }
    return diagnostic


async def run_ingest(payload: Dict[str, Any]) -> Dict[str, Any]:
    storage = configure_environment(payload)
    try:
        import cognee  # type: ignore
    except Exception as exc:  # pragma: no cover - exercised through sidecar failure path in TS tests
        raise RuntimeError(f"Cognee is not installed or failed to import: {exc}") from exc
    data_item_import_error: Optional[str] = None
    try:
        from cognee.tasks.ingestion.data_item import DataItem  # type: ignore
    except Exception as exc:  # pragma: no cover - lets lightweight fake cognee modules exercise env setup
        DataItem = None  # type: ignore
        data_item_import_error = str(exc)

    configure_cognee_runtime(cognee, storage)
    dataset_name = str(payload.get("datasetName") or "allen-repo")
    dataset = await dataset_details(cognee, dataset_name)
    existing_dataset = dataset.get("exists")
    payload_documents = payload.get("documents") if isinstance(payload.get("documents"), list) else []
    documents = [
        document
        for document in payload_documents
        if isinstance(document, dict) and str(document.get("content") or "").strip()
    ]
    chunk_size = positive_int(payload.get("chunkSize"))
    total_document_count = positive_int(payload.get("totalDocumentCount"))
    started = time.time()
    added = 0
    changed = 0
    deleted = 0
    total_documents = total_document_count if total_document_count is not None else len(documents)
    existing_inspection = await inspect_dataset_documents(dataset.get("id"))
    existing_documents = (
        existing_inspection.get("documents")
        if isinstance(existing_inspection.get("documents"), list)
        else []
    )
    diff = cognee_database_diff(documents, existing_documents)
    documents_to_add = diff["documents"]
    documents_to_delete = diff["deletedDocuments"]
    uncognified_retry_count = int(diff["uncognifiedRetryCount"])
    total_documents_to_add = len(documents_to_add)
    emit_progress(
        stage="ingesting",
        message=f"Checked Cognee database: {diff['unchangedDocumentCount']} unchanged, {total_documents_to_add} to ingest",
        processedDocumentCount=added,
        ingestedDocumentCount=added,
        cognifiedDocumentCount=0,
        documentCount=total_documents,
        documentsToIngestCount=total_documents_to_add,
        addedDocumentCount=diff["addedDocumentCount"],
        changedDocumentCount=diff["changedDocumentCount"],
        deletedDocumentCount=diff["deletedDocumentCount"],
        unchangedDocumentCount=diff["unchangedDocumentCount"],
        uncognifiedRetryCount=uncognified_retry_count,
        **storage_progress(storage, existing_dataset),
    )
    for document in documents_to_delete:
        await forget_document(cognee, dataset_name, document)
        deleted += 1
    if deleted:
        emit_progress(
            stage="ingesting",
            message=f"Deleted stale Cognee documents: {deleted}/{len(documents_to_delete)}",
            processedDocumentCount=0,
            ingestedDocumentCount=0,
            cognifiedDocumentCount=0,
            documentCount=total_documents,
            documentsToIngestCount=total_documents_to_add,
            addedDocumentCount=diff["addedDocumentCount"],
            changedDocumentCount=diff["changedDocumentCount"],
            deletedDocumentCount=deleted,
            unchangedDocumentCount=diff["unchangedDocumentCount"],
            uncognifiedRetryCount=uncognified_retry_count,
            **storage_progress(storage, existing_dataset),
        )
    for document in documents_to_add:
        text = str(document.get("content") or "")
        if str(document.get("changeType") or "") == "changed":
            existing = document.get("existingCogneeDocument")
            await forget_document(cognee, dataset_name, existing if isinstance(existing, dict) else document)
            changed += 1
        label = document_label(document, added + 1)
        metadata = document_metadata(document, payload)
        data_item = (
            DataItem(
                data=text,
                label=label,
                external_metadata=metadata,
                data_id=document_data_id(document, payload),
            )
            if DataItem
            else text
        )
        await cognee.add(
            data_item,
            dataset_name=dataset_name,
        )
        added += 1
        emit_progress(
            stage="ingesting",
            message=f"Ingested: {added}/{total_documents_to_add}",
            processedDocumentCount=added,
            ingestedDocumentCount=added,
            cognifiedDocumentCount=0,
            documentCount=total_documents,
            documentsToIngestCount=total_documents_to_add,
            addedDocumentCount=diff["addedDocumentCount"],
            changedDocumentCount=diff["changedDocumentCount"],
            deletedDocumentCount=deleted,
            unchangedDocumentCount=diff["unchangedDocumentCount"],
            uncognifiedRetryCount=uncognified_retry_count,
            **storage_progress(storage, existing_dataset),
        )
    dataset = await dataset_details(cognee, dataset_name)
    dataset_id = dataset.get("id")
    should_cognify = total_documents_to_add > 0 or uncognified_retry_count > 0
    if should_cognify:
        cognified = await count_cognified_documents(dataset_id)
        emit_progress(
            stage="cognifying",
            message=f"Cognified: {cognified if cognified is not None else 0}/{total_documents}",
            processedDocumentCount=cognified if cognified is not None else 0,
            ingestedDocumentCount=total_documents,
            cognifiedDocumentCount=cognified if cognified is not None else 0,
            documentCount=total_documents,
            **storage_progress(storage, existing_dataset),
        )
        await emit_cognify_progress_until_complete(
            cognee,
            dataset_name,
            dataset_id,
            total_documents,
            storage,
            existing_dataset,
            total_documents,
            chunk_size,
        )
    final_dataset_inspection = await inspect_dataset_documents(dataset_id)
    final_inspection = {
        "count": final_dataset_inspection.get("count"),
        "uncognifiedDocuments": final_dataset_inspection.get("uncognifiedDocuments") or [],
    }
    final_cognified = final_inspection.get("count")
    uncognified_documents = (
        final_inspection.get("uncognifiedDocuments")
        if isinstance(final_inspection.get("uncognifiedDocuments"), list)
        else []
    )
    diagnostics = [storage_diagnostic(storage, existing_dataset)]
    if isinstance(final_cognified, int) and final_cognified < total_documents:
        diagnostics.append({
            "code": "cognee_cognify_partial",
            "severity": "warn",
            "message": f"Cognee cognified {final_cognified}/{total_documents} ingested context documents.",
            "ingestedDocumentCount": total_documents,
            "cognifiedDocumentCount": final_cognified,
            "uncognifiedDocuments": uncognified_documents,
        })
    diagnostics.append({
        "code": "cognee_db_diff",
        "severity": "info",
        "addedDocumentCount": diff["addedDocumentCount"],
        "changedDocumentCount": diff["changedDocumentCount"],
        "deletedDocumentCount": deleted,
        "unchangedDocumentCount": diff["unchangedDocumentCount"],
        "uncognifiedRetryCount": uncognified_retry_count,
    })
    if DataItem is None:
        diagnostics.append({
            "code": "cognee_data_item_unavailable",
            "severity": "warn",
            "message": "Cognee DataItem could not be imported; external metadata was not attached to ingested documents.",
            "error": data_item_import_error,
        })
    return {
        "status": "completed",
        "datasetName": dataset_name,
        "documentCount": total_documents,
        "addedDocumentCount": added,
        "changedDocumentCount": changed,
        "deletedDocumentCount": deleted,
        "unchangedDocumentCount": diff["unchangedDocumentCount"],
        "documentsToIngestCount": total_documents_to_add,
        "uncognifiedRetryCount": uncognified_retry_count,
        "ingestedDocumentCount": total_documents,
        "cognifiedDocumentCount": final_cognified if final_cognified is not None else total_documents,
        "documents": final_dataset_inspection.get("documents") if isinstance(final_dataset_inspection.get("documents"), list) else [],
        "uncognifiedDocuments": uncognified_documents,
        "durationMs": int((time.time() - started) * 1000),
        **storage_progress(storage, existing_dataset),
        "diagnostics": diagnostics,
    }


async def release_cognify_lock(payload: Dict[str, Any]) -> Dict[str, Any]:
    storage = configure_environment(payload)
    dataset_name = str(payload.get("datasetName") or "")
    reason = str(payload.get("reason") or "Released by Allen")
    if not dataset_name:
        return {
            "status": "skipped",
            "released": False,
            "reason": "datasetName is required",
            **storage_progress(storage),
        }

    try:
        import cognee  # type: ignore
        from sqlalchemy import desc, select  # type: ignore
        from cognee.infrastructure.databases.relational import get_relational_engine  # type: ignore
        from cognee.modules.pipelines.models import PipelineRun, PipelineRunStatus  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"Cognee is not installed or failed to import: {exc}") from exc

    configure_cognee_runtime(cognee, storage)
    dataset = await dataset_details(cognee, dataset_name)
    dataset_id = dataset.get("id")
    if not dataset_id:
        return {
            "status": "skipped",
            "released": False,
            "datasetName": dataset_name,
            "reason": "dataset not found",
            **storage_progress(storage, dataset.get("exists")),
        }

    dataset_uuid = UUID(str(dataset_id))
    db_engine = get_relational_engine()
    async with db_engine.get_async_session() as session:
        latest = (
            await session.execute(
                select(PipelineRun)
                .where(PipelineRun.dataset_id == dataset_uuid)
                .where(PipelineRun.pipeline_name == "cognify_pipeline")
                .order_by(desc(PipelineRun.created_at))
                .limit(1)
            )
        ).scalars().first()
        latest_status = getattr(latest, "status", None)
        if str(latest_status).split(".")[-1] != "DATASET_PROCESSING_STARTED":
            return {
                "status": "skipped",
                "released": False,
                "datasetName": dataset_name,
                "datasetId": str(dataset_uuid),
                "latestStatus": str(latest_status) if latest_status is not None else None,
                **storage_progress(storage, dataset.get("exists")),
            }
        pipeline_run = PipelineRun(
            pipeline_run_id=getattr(latest, "pipeline_run_id", None) or uuid4(),
            pipeline_id=getattr(latest, "pipeline_id", None) or uuid4(),
            pipeline_name="cognify_pipeline",
            status=PipelineRunStatus.DATASET_PROCESSING_ERRORED,
            dataset_id=dataset_uuid,
            run_info={
                "error": reason,
                "releasedBy": "allen",
                "previousPipelineRunId": str(getattr(latest, "pipeline_run_id", "")),
                "previousRowId": str(getattr(latest, "id", "")),
            },
        )
        session.add(pipeline_run)
        await session.commit()

    return {
        "status": "completed",
        "released": True,
        "datasetName": dataset_name,
        "datasetId": str(dataset_uuid),
        "latestStatus": str(latest_status),
        "releaseStatus": "DATASET_PROCESSING_ERRORED",
        **storage_progress(storage, dataset.get("exists")),
    }


async def forget_document(cognee: Any, dataset_name: str, document: Dict[str, Any]) -> None:
    forget = getattr(cognee, "forget", None)
    if not forget:
        raise RuntimeError("Cognee forget API is unavailable; cannot refresh or delete changed documents")
    await forget(data_id=document_data_id(document, {}), dataset=dataset_name)


def cognee_database_diff(
    current_documents: List[Dict[str, Any]],
    existing_documents: List[Dict[str, Any]],
) -> Dict[str, Any]:
    existing_by_path: Dict[str, Dict[str, Any]] = {}
    for document in existing_documents:
        key = document_identity(document)
        if key:
            existing_by_path[key] = document

    current_paths = set()
    documents_to_add: List[Dict[str, Any]] = []
    unchanged_count = 0
    added_count = 0
    changed_count = 0
    uncognified_retry_count = 0

    for document in current_documents:
        key = document_identity(document)
        if not key:
            added_count += 1
            documents_to_add.append({**document, "changeType": "added"})
            continue
        current_paths.add(key)
        existing = existing_by_path.get(key)
        current_hash = str(document.get("hash") or "")
        existing_hash = str(existing.get("fileHash") or "") if existing else ""
        if existing and current_hash and existing_hash == current_hash:
            unchanged_count += 1
            if not is_cognify_completed(existing.get("status")):
                uncognified_retry_count += 1
            continue
        change_type = "changed" if existing else "added"
        if existing:
            changed_count += 1
        else:
            added_count += 1
        documents_to_add.append({
            **document,
            "changeType": change_type,
            **({"existingCogneeDocument": existing} if existing else {}),
        })

    deleted_documents = [
        document
        for document in existing_documents
        if document_identity(document) and document_identity(document) not in current_paths
    ]

    return {
        "documents": documents_to_add,
        "deletedDocuments": deleted_documents,
        "addedDocumentCount": added_count,
        "changedDocumentCount": changed_count,
        "deletedDocumentCount": len(deleted_documents),
        "unchangedDocumentCount": unchanged_count,
        "uncognifiedRetryCount": uncognified_retry_count,
    }


def document_identity(document: Dict[str, Any]) -> str:
    metadata = document.get("externalMetadata") if isinstance(document.get("externalMetadata"), dict) else {}
    return str(
        document.get("path")
        or metadata.get("path")
        or document.get("entryId")
        or document.get("entry_id")
        or metadata.get("entryId")
        or metadata.get("entry_id")
        or document.get("label")
        or metadata.get("label")
        or document.get("dataId")
        or document.get("data_id")
        or metadata.get("dataId")
        or metadata.get("data_id")
        or document.get("title")
        or ""
    ).strip()


def document_label(document: Dict[str, Any], ordinal: int) -> str:
    explicit = first_present(document.get("label"), document.get("dataLabel"), document.get("data_label"))
    if explicit:
        return str(explicit)
    source = str(document.get("source") or "")
    entry_id = first_present(document.get("entryId"), document.get("entry_id"))
    if source == "allen_curated_context_entry" and entry_id:
        return curated_entry_label(str(entry_id))
    return str(document.get("path") or document.get("title") or f"document-{ordinal}")


def curated_entry_label(entry_id: str) -> str:
    return f"allen-curated-entry:{entry_id}"


def curated_entry_id_from_label(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    prefix = "allen-curated-entry:"
    text = value.strip()
    return text[len(prefix):].strip() if text.startswith(prefix) and text[len(prefix):].strip() else None


def document_metadata(document: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    repo = payload.get("repo") if isinstance(payload.get("repo"), dict) else {}
    external = document.get("externalMetadata") if isinstance(document.get("externalMetadata"), dict) else {}
    metadata = {
        "repoId": repo.get("repoId"),
        "repoName": repo.get("repoName"),
        "branch": repo.get("branch"),
        "headSha": repo.get("headSha"),
        "path": document.get("path"),
        "title": document.get("title") or document.get("path"),
        "kind": document.get("kind") or "doc",
        "fileHash": document.get("hash"),
        "dataId": str(document.get("dataId") or document.get("data_id") or ""),
        "label": document_label(document, 1),
        "source": document.get("source") or "allen_curated_context_entry",
        "ingestFormat": payload.get("ingestFormat") or "curated_context_entry_v1",
    }
    return {**metadata, **external}


def document_data_id(document: Dict[str, Any], payload: Dict[str, Any]) -> UUID:
    candidate = (
        document.get("dataId")
        or document.get("data_id")
        or document.get("cogneeDataId")
        or document.get("cognee_data_id")
        or document.get("id")
    )
    if candidate:
        try:
            return UUID(str(candidate))
        except Exception:
            pass
    repo = payload.get("repo") if isinstance(payload.get("repo"), dict) else {}
    name = f"{repo.get('repoId') or 'repo'}:{document.get('path') or document.get('title') or document.get('hash')}"
    return uuid5(NAMESPACE_DNS, name)


async def run_search(payload: Dict[str, Any]) -> Dict[str, Any]:
    storage = configure_environment(payload)
    try:
        import cognee  # type: ignore
        from cognee import SearchType  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"Cognee is not installed or failed to import: {exc}") from exc

    configure_cognee_runtime(cognee, storage)
    dataset_name = str(payload.get("datasetName") or "allen-repo")
    query = str(payload.get("query") or "")
    max_results = int((payload.get("limits") or {}).get("maxResults") or 12) if isinstance(payload.get("limits"), dict) else 12
    started = time.time()
    search_mode = str(payload.get("searchMode") or "CHUNKS").upper()
    query_type = getattr(SearchType, search_mode, SearchType.CHUNKS)
    search_kwargs = {
        "query_text": query,
        "query_type": query_type,
        "datasets": [dataset_name],
        "top_k": max_results,
    }
    try:
        raw_results = await cognee.search(**search_kwargs)
    except TypeError:
        search_kwargs.pop("top_k", None)
        raw_results = await cognee.search(**search_kwargs)
    normalized = await normalize_results(raw_results, dataset_name, max_results, search_mode)
    return {
        "status": "completed",
        "datasetName": dataset_name,
        "results": normalized["results"],
        **storage_progress(storage),
        "diagnostics": [
            storage_diagnostic(storage),
            {
                "code": "cognee_search_request_built",
                "severity": "info",
                "datasetName": dataset_name,
                "searchMode": search_mode,
                "topK": max_results,
                "queryLength": len(query),
                "queryHash": hashlib.sha256(query.encode("utf-8")).hexdigest(),
                "searchKwargs": {
                    "query_type": search_mode,
                    "datasets": [dataset_name],
                    "top_k": max_results,
                },
                "message": "Allen built the Cognee search request from the retrieval envelope.",
            },
            *normalized["diagnostics"],
        ],
        "durationMs": int((time.time() - started) * 1000),
    }


async def normalize_results(raw_results: Any, dataset_name: str, max_results: int, search_mode: str = "CHUNKS") -> Dict[str, Any]:
    rows = flatten_search_rows(raw_results)
    out: List[Dict[str, Any]] = []
    diagnostics: List[Dict[str, Any]] = []
    chunk_count = 0
    resolved_metadata_count = 0
    unresolved_metadata_count = 0
    for index, row in enumerate(rows[:max_results]):
        if isinstance(row, dict):
            raw_text = first_present(row.get("text"), row.get("content"), row.get("page_content"), row.get("body"))
            envelope = find_json_envelope(row) or {}
            metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
            text = str(first_present(envelope.get("content"), raw_text, row))
            score = first_present(row.get("score"), row.get("confidence"), row.get("distance"))
            label = first_present(row.get("label"), metadata.get("label"), envelope.get("label"))
            source_id = first_present(row.get("sourceId"), row.get("source_id"), metadata.get("sourceId"), metadata.get("source_id"))
            chunk_id = first_present(row.get("chunkId"), row.get("chunk_id"), metadata.get("chunkId"), metadata.get("chunk_id"), row.get("id"), row.get("uuid"))
            ref_id = first_present(row.get("refId"), row.get("id"), row.get("uuid"), metadata.get("refId"), metadata.get("id"), chunk_id, source_id)
            row_source_metadata = extract_source_metadata(row)
            envelope_source_metadata = {} if row_source_metadata else extract_source_metadata(envelope)
            source_metadata = row_source_metadata or envelope_source_metadata
            label_entry_id = curated_entry_id_from_label(label)
            if label_entry_id and not source_metadata.get("entryId") and not source_metadata.get("entry_id"):
                source_metadata = {**source_metadata, "entryId": label_entry_id}
            resolution_trace: Dict[str, Any] = {
                "rowIndex": index,
                "datasetName": dataset_name,
                "searchMode": search_mode,
                "chunkId": str(chunk_id) if chunk_id else None,
                "resultKeys": sorted([str(key) for key in row.keys()]),
                "metadataKeys": sorted([str(key) for key in metadata.keys()]),
                "envelopeKeys": sorted([str(key) for key in envelope.keys()]),
                "sourceMetadataFoundInRow": bool(row_source_metadata),
                "sourceMetadataFoundInEnvelope": bool(envelope_source_metadata),
                "sourceMetadataFoundInLabel": bool(label_entry_id),
                "sourceMetadataKeys": sorted([str(key) for key in source_metadata.keys()]) if source_metadata else [],
                "graphLookupAttempted": False,
                "graphLookupResult": "not_needed" if source_metadata else "not_attempted",
                "resolutionStatus": "resolved_from_row" if row_source_metadata else "resolved_from_envelope" if envelope_source_metadata else "resolved_from_label" if label_entry_id else "unresolved",
            }
            if not source_metadata and chunk_id:
                source_metadata, graph_trace = await resolve_chunk_source_metadata_with_trace(str(chunk_id))
                resolution_trace.update(graph_trace)
                resolution_trace["sourceMetadataKeys"] = sorted([str(key) for key in source_metadata.keys()]) if source_metadata else []
                resolution_trace["resolutionStatus"] = graph_trace.get("resolutionStatus") or ("resolved_from_graph" if source_metadata else "unresolved")
            if chunk_id:
                chunk_count += 1
                if source_metadata:
                    resolved_metadata_count += 1
            if chunk_id and not source_metadata:
                unresolved_metadata_count += 1
                diagnostics.append({
                    "code": "cognee_chunk_source_metadata_unresolved",
                    "severity": "warn",
                    "chunkId": str(chunk_id),
                    "datasetName": dataset_name,
                    "searchMode": search_mode,
                    "resolution": resolution_trace,
                    "message": "Cognee returned a chunk id, but Allen could not resolve source document metadata for it.",
                })
            elif chunk_id:
                diagnostics.append({
                    "code": "cognee_chunk_source_metadata_resolved",
                    "severity": "info",
                    "chunkId": str(chunk_id),
                    "datasetName": dataset_name,
                    "searchMode": search_mode,
                    "resolution": resolution_trace,
                    "message": "Allen resolved Cognee chunk source metadata.",
                })
            path = first_portable_path(
                source_metadata.get("path"),
                envelope.get("path"),
                metadata.get("path"),
                None if curated_entry_id_from_label(label) else label,
                row.get("path"),
            )
            title = first_present(envelope.get("title"), row.get("title"), metadata.get("title"), source_metadata.get("title"), path, f"Cognee result {index + 1}")
            kind = first_present(envelope.get("kind"), metadata.get("kind"), row.get("kind"), source_metadata.get("kind"), "historical_learning")
            chunk_index = first_present(row.get("chunkIndex"), row.get("chunk_index"), metadata.get("chunkIndex"), metadata.get("chunk_index"))
            chunk_size = first_present(row.get("chunkSize"), row.get("chunk_size"), metadata.get("chunkSize"), metadata.get("chunk_size"))
            cut_type = first_present(row.get("cutType"), row.get("cut_type"), metadata.get("cutType"), metadata.get("cut_type"))
        else:
            envelope = find_json_envelope(str(row)) or parse_json_object(str(row))
            text = str(first_present(envelope.get("content"), row))
            path = first_portable_path(envelope.get("path"))
            score = None
            label = first_present(envelope.get("label"))
            title = first_present(envelope.get("title"), f"Cognee result {index + 1}")
            kind = first_present(envelope.get("kind"), "historical_learning")
            metadata = {}
            source_metadata = {}
            source_id = None
            chunk_id = None
            ref_id = None
            chunk_index = None
            chunk_size = None
            cut_type = None
        out.append({
            "refId": ref_id or f"cognee:{dataset_name}:{index}",
            "title": title,
            "kind": kind,
            "path": path,
            "content": text,
            "summary": text[:500],
            "source": "cognee_recall",
            "reason": "Cognee recalled this context from repo memory for the current task intent.",
            "score": score,
            "datasetName": dataset_name,
            "label": label,
            "sourceId": source_id,
            "chunkId": chunk_id,
            "chunkIndex": chunk_index,
            "chunkSize": chunk_size,
            "cutType": cut_type,
            "sourceMetadata": source_metadata,
            "externalMetadata": source_metadata,
            "entityIds": metadata.get("entityIds") or metadata.get("entity_ids"),
            "searchMode": search_mode,
        })
    if chunk_count > 0:
        diagnostics.append({
            "code": "cognee_chunk_source_metadata_resolution",
            "severity": "info" if unresolved_metadata_count == 0 else "warn",
            "datasetName": dataset_name,
            "searchMode": search_mode,
            "chunkCount": chunk_count,
            "resolvedChunkMetadataCount": resolved_metadata_count,
            "unresolvedChunkMetadataCount": unresolved_metadata_count,
            "message": f"Resolved source metadata for {resolved_metadata_count}/{chunk_count} Cognee chunks.",
        })
    return {"results": out, "diagnostics": diagnostics}


def flatten_search_rows(value: Any, inherited: Optional[Dict[str, Any]] = None) -> List[Any]:
    inherited = inherited or {}
    if isinstance(value, list):
        rows: List[Any] = []
        for item in value:
            rows.extend(flatten_search_rows(item, inherited))
        return rows
    if isinstance(value, dict):
        nested = value.get("search_result")
        if isinstance(nested, list):
            next_inherited = {
                **inherited,
                **{
                    key: value.get(key)
                    for key in ("dataset_id", "datasetId", "dataset_name", "datasetName")
                    if value.get(key) is not None
                },
            }
            rows = []
            for item in nested:
                rows.extend(flatten_search_rows(item, next_inherited))
            return rows
        if inherited:
            return [{**inherited, **value}]
    return [value]


async def resolve_chunk_source_metadata(chunk_id: str) -> Dict[str, Any]:
    metadata, _trace = await resolve_chunk_source_metadata_with_trace(chunk_id)
    return metadata


async def resolve_chunk_source_metadata_with_trace(chunk_id: str) -> tuple[Dict[str, Any], Dict[str, Any]]:
    metadata, trace = await resolve_chunk_source_metadata_from_graph_with_trace(chunk_id)
    if metadata:
        trace["resolutionStatus"] = "resolved_from_graph"
        return metadata, trace

    relational_metadata, relational_trace = await resolve_chunk_source_metadata_from_relational_with_trace(chunk_id)
    trace.update(relational_trace)
    if relational_metadata:
        trace["resolutionStatus"] = "resolved_from_relational"
        return relational_metadata, trace
    return {}, trace


async def resolve_chunk_source_metadata_from_graph(chunk_id: str) -> Dict[str, Any]:
    metadata, _trace = await resolve_chunk_source_metadata_from_graph_with_trace(chunk_id)
    return metadata


async def resolve_chunk_source_metadata_from_graph_with_trace(chunk_id: str) -> tuple[Dict[str, Any], Dict[str, Any]]:
    trace: Dict[str, Any] = {
        "graphLookupAttempted": True,
        "graphLookupResult": "not_attempted",
        "candidateChunkIds": candidate_chunk_ids(chunk_id),
        "graphGetNodeAttempts": [],
        "graphQueryAttempts": [],
    }
    try:
        from cognee.infrastructure.databases.graph import get_graph_engine  # type: ignore
    except Exception as exc:
        trace["graphLookupResult"] = "graph_engine_import_failed"
        trace["graphLookupError"] = str(exc)
        return {}, trace

    try:
        graph_engine = await get_graph_engine()
    except Exception as exc:
        trace["graphLookupResult"] = "graph_engine_unavailable"
        trace["graphLookupError"] = str(exc)
        return {}, trace

    for node_id in trace["candidateChunkIds"]:
        try:
            node = await graph_engine.get_node(str(node_id))
            trace["graphGetNodeAttempts"].append({
                "nodeId": str(node_id),
                "found": node is not None,
                "metadataFound": bool(extract_source_metadata(node)),
            })
        except Exception as exc:
            node = None
            trace["graphGetNodeAttempts"].append({
                "nodeId": str(node_id),
                "found": False,
                "error": str(exc),
            })
        metadata = extract_source_metadata(node)
        if metadata:
            trace["graphLookupResult"] = "metadata_found_on_chunk_node"
            return metadata, trace

        for query_index, query in enumerate(chunk_parent_queries()):
            try:
                rows = await graph_engine.query(query, {"chunk_id": str(node_id)})
                row_count = len(rows) if isinstance(rows, list) else None
                found = extract_source_metadata(rows)
                trace["graphQueryAttempts"].append({
                    "nodeId": str(node_id),
                    "queryIndex": query_index,
                    "rowCount": row_count,
                    "metadataFound": bool(found),
                })
                if found:
                    trace["graphLookupResult"] = "metadata_found_via_parent_query"
                    return found, trace
            except Exception as exc:
                trace["graphQueryAttempts"].append({
                    "nodeId": str(node_id),
                    "queryIndex": query_index,
                    "error": str(exc),
                })
                continue
    trace["graphLookupResult"] = "metadata_not_found"
    return {}, trace


def candidate_chunk_ids(chunk_id: str) -> List[str]:
    ids = [chunk_id]
    try:
        parsed = UUID(str(chunk_id))
        ids.append(str(parsed))
        ids.append(parsed.hex)
    except Exception:
        pass
    ids.append(chunk_id.replace("-", ""))
    return list(dict.fromkeys(ids))


async def resolve_chunk_source_metadata_from_relational_with_trace(chunk_id: str) -> tuple[Dict[str, Any], Dict[str, Any]]:
    trace: Dict[str, Any] = {
        "relationalLookupAttempted": True,
        "relationalLookupResult": "not_attempted",
        "relationalQueryAttempts": [],
    }
    try:
        from sqlalchemy import text  # type: ignore
        from cognee.infrastructure.databases.relational import get_relational_engine  # type: ignore
    except Exception as exc:
        trace["relationalLookupResult"] = "relational_engine_import_failed"
        trace["relationalLookupError"] = str(exc)
        return {}, trace

    try:
        db_engine = get_relational_engine()
    except Exception as exc:
        trace["relationalLookupResult"] = "relational_engine_unavailable"
        trace["relationalLookupError"] = str(exc)
        return {}, trace

    candidates = candidate_chunk_ids(chunk_id)
    params = {f"candidate_{index}": candidate for index, candidate in enumerate(candidates)}
    placeholders = ", ".join(f":candidate_{index}" for index in range(len(candidates)))
    queries = [
        """
        SELECT d.external_metadata AS external_metadata,
               n.attributes AS node_attributes,
               n.id AS node_id,
               n.slug AS node_slug,
               n.label AS node_label
        FROM nodes n
        JOIN data d ON d.id = n.data_id
        WHERE n.id IN ({placeholders})
           OR n.slug IN ({placeholders})
           OR n.label IN ({placeholders})
        LIMIT 5
        """,
        """
        SELECT d.external_metadata AS external_metadata
        FROM data d
        WHERE d.id IN (
            SELECT n.data_id
            FROM nodes n
            WHERE n.id IN ({placeholders})
               OR n.slug IN ({placeholders})
               OR n.label IN ({placeholders})
        )
        LIMIT 5
        """,
    ]
    try:
        async with db_engine.get_async_session() as session:
            for query_index, query_template in enumerate(queries):
                attempt: Dict[str, Any] = {"queryIndex": query_index}
                try:
                    result = await session.execute(text(query_template.format(placeholders=placeholders)), params)
                    rows = result.fetchall() if hasattr(result, "fetchall") else []
                    attempt["rowCount"] = len(rows)
                    metadata = extract_source_metadata(rows)
                    attempt["metadataFound"] = bool(metadata)
                    trace["relationalQueryAttempts"].append(attempt)
                    if metadata:
                        trace["relationalLookupResult"] = "metadata_found"
                        return metadata, trace
                except Exception as exc:
                    attempt["error"] = str(exc)
                    trace["relationalQueryAttempts"].append(attempt)
                    continue
    except Exception as exc:
        trace["relationalLookupResult"] = "relational_session_failed"
        trace["relationalLookupError"] = str(exc)
        return {}, trace

    trace["relationalLookupResult"] = "metadata_not_found"
    return {}, trace


def chunk_parent_queries() -> List[str]:
    return [
        "MATCH (chunk)-[:is_part_of]->(doc) WHERE chunk.id = $chunk_id RETURN doc LIMIT 1",
        "MATCH (chunk {id: $chunk_id})-[:is_part_of]->(doc) RETURN doc LIMIT 1",
        "MATCH (doc)<-[:is_part_of]-(chunk) WHERE chunk.id = $chunk_id RETURN doc LIMIT 1",
    ]


def extract_source_metadata(value: Any, depth: int = 0) -> Dict[str, Any]:
    if depth > 6 or value is None:
        return {}
    if isinstance(value, str):
        parsed = parse_json_object(value)
        return extract_source_metadata(parsed, depth + 1) if parsed else {}
    if isinstance(value, list) or isinstance(value, tuple):
        for item in value:
            found = extract_source_metadata(item, depth + 1)
            if found:
                return found
        return {}
    if not isinstance(value, dict):
        value_dict = getattr(value, "model_dump", lambda: None)()
        if isinstance(value_dict, dict):
            return extract_source_metadata(value_dict, depth + 1)
        return {}

    for key in ("externalMetadata", "external_metadata", "sourceMetadata", "source_metadata"):
        found = metadata_dict(value.get(key))
        if found:
            return found

    if looks_like_allen_metadata(value):
        return value

    for key in (
        "is_part_of",
        "isPartOf",
        "document",
        "doc",
        "node",
        "payload",
        "properties",
        "metadata",
        "data",
        "result",
    ):
        found = extract_source_metadata(value.get(key), depth + 1)
        if found:
            return found

    for item in value.values():
        found = extract_source_metadata(item, depth + 1)
        if found:
            return found
    return {}


def metadata_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        parsed = parse_json_object(value)
        return parsed if parsed else {}
    return {}


def looks_like_allen_metadata(value: Dict[str, Any]) -> bool:
    return bool(value.get("path") and (value.get("repoId") or value.get("repo_id") or value.get("ingestFormat")))


def parse_json_object(value: str) -> Dict[str, Any]:
    text = value.strip()
    if not text or not text.startswith("{"):
        return {}
    try:
        parsed = json.loads(text)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def find_json_envelope(value: Any, depth: int = 0) -> Dict[str, Any]:
    if depth > 4:
        return {}
    if isinstance(value, str):
        parsed = parse_json_object(value)
        return normalize_envelope(parsed, depth + 1) if parsed else {}
    if isinstance(value, dict):
        normalized = normalize_envelope(value, depth + 1)
        if normalized:
            return normalized
        for key in ("text", "content", "page_content", "body", "document", "data", "value", "payload"):
            if key in value:
                found = find_json_envelope(value.get(key), depth + 1)
                if found:
                    return found
        metadata = value.get("metadata")
        if isinstance(metadata, dict):
            found = find_json_envelope(metadata, depth + 1)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = find_json_envelope(item, depth + 1)
            if found:
                return found
    return {}


def normalize_envelope(value: Dict[str, Any], depth: int) -> Dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    has_envelope_shape = any(key in value for key in ("title", "path", "kind", "repoId", "repo_id")) and "content" in value
    if not has_envelope_shape:
        return {}
    envelope = dict(value)
    nested = find_json_envelope(envelope.get("content"), depth + 1)
    if nested:
        envelope = {**envelope, **{key: val for key, val in nested.items() if val is not None}}
    return envelope


def first_present(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        return value
    return None


def first_portable_path(*values: Any) -> Optional[str]:
    for value in values:
        if not isinstance(value, str):
            continue
        normalized = value.strip().replace("\\", "/")
        if not normalized or normalized == ".":
            continue
        if normalized.startswith("/") or normalized.startswith("..") or "/../" in normalized:
            continue
        if len(normalized) > 2 and normalized[1] == ":" and normalized[2] == "/":
            continue
        if "://" in normalized:
            continue
        return normalized
    return None


def positive_int(value: Any) -> Optional[int]:
    try:
        parsed = int(value)
    except Exception:
        return None
    return parsed if parsed > 0 else None


async def run_graph(payload: Dict[str, Any]) -> Dict[str, Any]:
    return await run_graph_via_cognee_api(payload)


async def run_graph_via_cognee_api(payload: Dict[str, Any]) -> Dict[str, Any]:
    storage = configure_environment(payload)
    dataset_name = str(payload.get("datasetName") or "")
    max_nodes = positive_int(payload.get("maxNodes")) or 1000
    max_edges = positive_int(payload.get("maxEdges")) or 2000
    query = str(payload.get("query") or "").strip().lower()
    node_type = str(payload.get("nodeType") or "").strip()
    relationship = str(payload.get("relationship") or "").strip()
    expand_node_id = str(payload.get("expandNodeId") or "").strip()
    empty = {
        "source": "cognee_graph_api",
        "provider": "cognee",
        "accessMode": "cognee_graph_api",
        "datasetName": dataset_name,
        "nodeCount": 0,
        "edgeCount": 0,
        "nodes": [],
        "edges": [],
        "nodeTypeCounts": [],
        "relationshipCounts": [],
        "previewNodeCount": 0,
        "previewEdgeCount": 0,
        "limited": False,
    }
    if not dataset_name:
        return empty

    import cognee  # type: ignore
    from cognee.context_global_variables import set_database_global_context_variables  # type: ignore
    from cognee.infrastructure.databases.graph import get_graph_engine  # type: ignore

    configure_cognee_runtime(cognee, storage)
    dataset = await dataset_details(cognee, dataset_name)
    dataset_id = dataset.get("id")
    owner_id = dataset.get("ownerId")
    if not dataset_id or not owner_id:
        return {**empty, "source": "cognee_dataset_missing"}

    async with set_database_global_context_variables(UUID(str(dataset_id)), UUID(str(owner_id))):
        graph_client = await get_graph_engine()
        raw_nodes, raw_edges = await graph_client.get_graph_data()

    nodes = unique_graph_nodes(cognee_api_graph_node(node) for node in raw_nodes)
    alias_to_id = graph_node_alias_map(nodes)
    edges = [
        normalize_graph_edge_endpoints(cognee_api_graph_edge(edge, index), alias_to_id)
        for index, edge in enumerate(raw_edges)
    ]
    filtered_nodes, filtered_edges, selection = select_context_graph_preview(
        nodes,
        edges,
        max_nodes=max_nodes,
        max_edges=max_edges,
        query=query,
        node_type=node_type,
        relationship=relationship,
        expand_node_id=expand_node_id,
    )
    return {
        "source": "cognee_graph_api",
        "provider": "cognee",
        "accessMode": "cognee_graph_api",
        "datasetName": dataset_name,
        "datasetId": str(dataset_id),
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
        "nodes": filtered_nodes,
        "edges": filtered_edges,
        "nodeTypeCounts": count_graph_values(nodes, "type", "type"),
        "relationshipCounts": count_graph_values(edges, "relationship", "relationship"),
        "previewNodeCount": len(filtered_nodes),
        "previewEdgeCount": len(filtered_edges),
        "limited": len(nodes) > len(filtered_nodes) or len(edges) > len(filtered_edges),
        "filters": {
            "query": query or None,
            "nodeType": node_type or None,
            "relationship": relationship or None,
            "expandNodeId": expand_node_id or None,
        },
        "selection": selection,
    }


def cognee_api_graph_node(raw: Any) -> Dict[str, Any]:
    node_id = ""
    properties: Dict[str, Any] = {}
    if isinstance(raw, (list, tuple)) and len(raw) >= 2:
        node_id = str(raw[0])
        properties = raw[1] if isinstance(raw[1], dict) else {}
    elif isinstance(raw, dict):
        node_id = str(raw.get("id") or raw.get("node_id") or raw.get("slug") or "")
        properties = raw
    attributes = metadata_dict(properties.get("attributes")) if "attributes" in properties else properties
    node_type = str(properties.get("type") or attributes.get("type") or "unknown")
    name = bounded_text(attributes.get("name"), 240)
    text = attributes.get("text")
    text_preview = bounded_text(text, 1200)
    description = bounded_text(attributes.get("description"), 700)
    source_metadata = extract_source_metadata(attributes)
    source_path = first_portable_path(
        source_metadata.get("path"),
        source_metadata.get("sourcePath"),
        source_metadata.get("source_path"),
        source_metadata.get("filePath"),
        source_metadata.get("file_path"),
    )
    label = properties.get("label") or name or text_preview or node_id
    return {
        "id": node_id,
        "slug": str(properties.get("slug")) if properties.get("slug") else None,
        "dbId": node_id,
        "type": node_type,
        "label": bounded_text(label, 180) or node_id,
        "name": name,
        "description": description,
        "textPreview": text_preview,
        "textLength": len(text) if isinstance(text, str) else None,
        "sourcePath": source_path,
        "sourceMetadata": source_metadata or None,
    }


def cognee_api_graph_edge(raw: Any, index: int) -> Dict[str, Any]:
    source = ""
    target = ""
    relationship = "related_to"
    properties: Dict[str, Any] = {}
    if isinstance(raw, (list, tuple)) and len(raw) >= 3:
        source = str(raw[0])
        target = str(raw[1])
        relationship = str(raw[2] or "related_to")
        properties = raw[3] if len(raw) >= 4 and isinstance(raw[3], dict) else {}
    elif isinstance(raw, dict):
        source = str(raw.get("source") or raw.get("source_node_id") or "")
        target = str(raw.get("target") or raw.get("destination_node_id") or "")
        relationship = str(raw.get("label") or raw.get("relationship") or raw.get("relationship_name") or "related_to")
        properties = raw
    parsed = parse_edge_metadata(relationship)
    display_relationship = parsed.get("relationship_name") or relationship
    return {
        "id": str(properties.get("id") or f"{source}->{target}:{index}"),
        "source": source,
        "target": target,
        "label": display_relationship,
        "relationship": display_relationship,
        "rawRelationship": relationship,
        "entityName": parsed.get("entity_name"),
        "entityDescription": parsed.get("entity_description"),
    }


def unique_graph_nodes(nodes: Any) -> List[Dict[str, Any]]:
    unique: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for node in nodes:
        key = str(node.get("id") or "")
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        unique.append(node)
    return unique


def graph_node_alias_map(nodes: List[Dict[str, Any]]) -> Dict[str, str]:
    aliases: Dict[str, str] = {}
    for node in nodes:
        canonical = str(node.get("id") or "")
        if not canonical:
            continue
        for value in (node.get("id"), node.get("slug"), node.get("dbId")):
            for alias in graph_identifier_aliases(value):
                aliases.setdefault(alias, canonical)
    return aliases


def graph_identifier_aliases(value: Any) -> List[str]:
    text = str(value or "").strip()
    if not text:
        return []
    aliases = [text]
    no_dash = text.replace("-", "")
    if no_dash != text:
        aliases.append(no_dash)
    return aliases


def canonical_graph_id(value: Any, alias_to_id: Dict[str, str]) -> str:
    for alias in graph_identifier_aliases(value):
        if alias in alias_to_id:
            return alias_to_id[alias]
    return str(value or "")


def normalize_graph_edge_endpoints(edge: Dict[str, Any], alias_to_id: Dict[str, str]) -> Dict[str, Any]:
    source = canonical_graph_id(edge.get("source"), alias_to_id)
    target = canonical_graph_id(edge.get("target"), alias_to_id)
    return {
        **edge,
        "rawSource": edge.get("source"),
        "rawTarget": edge.get("target"),
        "source": source,
        "target": target,
    }


def select_context_graph_preview(
    nodes: List[Dict[str, Any]],
    edges: List[Dict[str, Any]],
    *,
    max_nodes: int,
    max_edges: int,
    query: str,
    node_type: str,
    relationship: str,
    expand_node_id: str,
) -> Any:
    node_by_id = {str(node.get("id")): node for node in nodes if node.get("id")}
    filtered_edges = [
        edge for edge in edges
        if (not relationship or graph_relationship_matches(edge, relationship))
    ]
    if expand_node_id:
        expanded_id = canonical_graph_id(expand_node_id, graph_node_alias_map(nodes))
        selected_ids = {expanded_id}
        for edge in filtered_edges:
            if str(edge.get("source")) == expanded_id:
                selected_ids.add(str(edge.get("target")))
            if str(edge.get("target")) == expanded_id:
                selected_ids.add(str(edge.get("source")))
        return materialize_graph_selection(node_by_id, filtered_edges, selected_ids, max_nodes, max_edges, {
            "mode": "expanded_neighborhood",
            "seedNodeIds": [expanded_id],
        })

    filtered_nodes = [
        node for node in nodes
        if (not node_type or str(node.get("type") or "") == node_type)
        and (not query or graph_node_matches_query(node, query))
    ]
    if query or node_type or relationship:
        node_filtered = bool(query or node_type)
        selected_ids = {str(node.get("id")) for node in filtered_nodes if node.get("id")}
        if relationship and not node_filtered:
            selected_ids.update(str(edge.get("source")) for edge in filtered_edges)
            selected_ids.update(str(edge.get("target")) for edge in filtered_edges)
        return materialize_graph_selection(node_by_id, filtered_edges, selected_ids, max_nodes, max_edges, {
            "mode": "filtered",
            "seedNodeIds": list(selected_ids)[:12],
        })

    degree: Dict[str, int] = {}
    neighbors: Dict[str, set[str]] = {}
    for edge in filtered_edges:
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        if not source or not target:
            continue
        degree[source] = degree.get(source, 0) + 1
        degree[target] = degree.get(target, 0) + 1
        neighbors.setdefault(source, set()).add(target)
        neighbors.setdefault(target, set()).add(source)
    seeds = sorted(
        degree.keys(),
        key=lambda node_id: (degree.get(node_id, 0), meaningful_node_weight(node_by_id.get(node_id))),
        reverse=True,
    )
    selected_ids: set[str] = set()
    for seed in seeds[: max(1, min(24, max_nodes))]:
        if len(selected_ids) >= max_nodes:
            break
        selected_ids.add(seed)
        for neighbor in sorted(neighbors.get(seed, set()), key=lambda item: degree.get(item, 0), reverse=True):
            if len(selected_ids) >= max_nodes:
                break
            selected_ids.add(neighbor)
    if not selected_ids:
        selected_ids = {str(node.get("id")) for node in nodes[:max_nodes] if node.get("id")}
    return materialize_graph_selection(node_by_id, filtered_edges, selected_ids, max_nodes, max_edges, {
        "mode": "densest_overview",
        "seedNodeIds": seeds[:12],
    })


def graph_relationship_matches(edge: Dict[str, Any], relationship: str) -> bool:
    wanted = relationship.strip().lower()
    if not wanted:
        return True
    values = [
        edge.get("relationship"),
        edge.get("label"),
        edge.get("rawRelationship"),
    ]
    return any(str(value or "").strip().lower() == wanted for value in values)


def graph_node_matches_query(node: Dict[str, Any], query: str) -> bool:
    wanted = query.strip().lower()
    if not wanted:
        return True
    searchable = [
        node.get("id"),
        node.get("slug"),
        node.get("dbId"),
        node.get("type"),
        node.get("label"),
        node.get("name"),
        node.get("description"),
        node.get("textPreview"),
        node.get("sourcePath"),
        node.get("sourceMetadata"),
    ]
    return wanted in json.dumps(searchable, ensure_ascii=False).lower()


def materialize_graph_selection(
    node_by_id: Dict[str, Dict[str, Any]],
    edges: List[Dict[str, Any]],
    selected_ids: set[str],
    max_nodes: int,
    max_edges: int,
    selection: Dict[str, Any],
) -> Any:
    ordered_ids = [node_id for node_id in selected_ids if node_id in node_by_id][:max_nodes]
    bounded_ids = set(ordered_ids)
    selected_edges = [
        edge for edge in edges
        if str(edge.get("source")) in bounded_ids and str(edge.get("target")) in bounded_ids
    ][:max_edges]
    return [node_by_id[node_id] for node_id in ordered_ids], selected_edges, selection


def meaningful_node_weight(node: Optional[Dict[str, Any]]) -> int:
    if not node:
        return 0
    node_type = str(node.get("type") or "")
    if node_type in ("Entity", "DocumentChunk", "TextSummary"):
        return 3
    if node_type == "TextDocument":
        return 2
    if node_type == "EntityType":
        return 1
    return 0


def count_graph_values(items: List[Dict[str, Any]], field: str, output_field: str) -> List[Dict[str, Any]]:
    counts: Dict[str, int] = {}
    for item in items:
        value = str(item.get(field) or "unknown")
        counts[value] = counts.get(value, 0) + 1
    return [
        {output_field: value, "count": count}
        for value, count in sorted(counts.items(), key=lambda pair: pair[1], reverse=True)[:50]
    ]


async def run_chunk_source_mappings(payload: Dict[str, Any]) -> Dict[str, Any]:
    storage = configure_environment(payload)
    dataset_name = str(payload.get("datasetName") or "")
    empty = {
        "source": "cognee_graph_api",
        "provider": "cognee",
        "accessMode": "cognee_graph_api",
        "datasetName": dataset_name,
        "datasetId": None,
        "rows": [],
        "chunkCount": 0,
        "resolvedCount": 0,
        "unresolvedCount": 0,
        "diagnostics": [storage_diagnostic(storage)],
    }
    if not dataset_name:
        return empty

    import cognee  # type: ignore
    from cognee.context_global_variables import set_database_global_context_variables  # type: ignore
    from cognee.infrastructure.databases.graph import get_graph_engine  # type: ignore

    configure_cognee_runtime(cognee, storage)
    dataset = await dataset_details(cognee, dataset_name)
    dataset_id = dataset.get("id")
    owner_id = dataset.get("ownerId")
    if not dataset_id or not owner_id:
        return {**empty, "source": "cognee_dataset_missing"}

    diagnostics = [storage_diagnostic(storage, dataset.get("exists"))]
    async with set_database_global_context_variables(UUID(str(dataset_id)), UUID(str(owner_id))):
        graph_client = await get_graph_engine()
        rows = await chunk_source_rows_from_graph_data(graph_client)
        diagnostics.append({
            "code": "cognee_chunk_source_mapping_graph_scan",
            "severity": "info",
            "rowCount": len(rows),
            "message": "Allen scanned Cognee graph data to derive chunk source mappings.",
        })

    resolved_count = sum(1 for row in rows if row.get("entryId") or row.get("path"))
    return {
        "source": "cognee_graph_api",
        "provider": "cognee",
        "accessMode": "cognee_graph_api",
        "datasetName": dataset_name,
        "datasetId": str(dataset_id),
        "rows": rows,
        "chunkCount": len(rows),
        "resolvedCount": resolved_count,
        "unresolvedCount": len(rows) - resolved_count,
        "diagnostics": diagnostics,
    }


async def chunk_source_rows_from_graph_data(graph_client: Any) -> List[Dict[str, Any]]:
    try:
        raw_nodes, raw_edges = await graph_client.get_graph_data()
    except Exception:
        return []
    nodes = unique_graph_nodes(cognee_api_graph_node(node) for node in raw_nodes)
    alias_to_id = graph_node_alias_map(nodes)
    node_by_id = {str(node.get("id") or ""): node for node in nodes if node.get("id")}
    edges = [
        normalize_graph_edge_endpoints(cognee_api_graph_edge(edge, index), alias_to_id)
        for index, edge in enumerate(raw_edges)
    ]
    rows: List[Dict[str, Any]] = []
    for edge in edges:
        source = node_by_id.get(str(edge.get("source") or ""))
        target = node_by_id.get(str(edge.get("target") or ""))
        if source and target and is_chunk_source_pair(source, target):
            rows.append(chunk_source_mapping_row(source, target))
        elif source and target and is_chunk_source_pair(target, source):
            rows.append(chunk_source_mapping_row(target, source))
    return dedupe_chunk_source_rows([row for row in rows if row.get("chunkId")])


def is_chunk_source_pair(chunk: Dict[str, Any], doc: Dict[str, Any]) -> bool:
    chunk_type = str(chunk.get("type") or "")
    doc_type = str(doc.get("type") or "")
    if chunk_type in {"DocumentChunk", "TextSummary"} and doc_type == "TextDocument":
        return True
    return False


def chunk_source_mapping_row(chunk_raw: Any, doc_raw: Any) -> Dict[str, Any]:
    chunk = cognee_api_graph_node(chunk_raw) if chunk_raw is not None else {}
    doc = cognee_api_graph_node(doc_raw) if doc_raw is not None else {}
    source_metadata = (
        extract_source_metadata(doc_raw)
        or extract_source_metadata(doc)
        or extract_source_metadata(chunk_raw)
        or extract_source_metadata(chunk)
    )
    label = first_present(
        source_metadata.get("label"),
        doc.get("label"),
        chunk.get("label"),
    )
    entry_id = first_present(
        source_metadata.get("entryId"),
        source_metadata.get("entry_id"),
        curated_entry_id_from_label(label),
    )
    path = first_portable_path(
        source_metadata.get("path"),
        source_metadata.get("filePath"),
        source_metadata.get("file_path"),
        doc.get("sourcePath"),
        chunk.get("sourcePath"),
    )
    chunk_id = first_present(
        chunk.get("id"),
        chunk.get("dbId"),
        chunk.get("slug"),
    )
    return {
        "chunkId": str(chunk_id) if chunk_id else None,
        "entryId": str(entry_id) if entry_id else None,
        "path": path,
        "label": str(label) if label else None,
        "title": first_present(source_metadata.get("title"), doc.get("name"), doc.get("label"), path),
        "kind": first_present(source_metadata.get("kind"), "doc"),
        "fileHash": first_present(source_metadata.get("fileHash"), source_metadata.get("file_hash")),
        "sourceNodeId": doc.get("id"),
        "chunkNodeId": chunk.get("id"),
        "sourceMetadataKeys": sorted([str(key) for key in source_metadata.keys()]) if source_metadata else [],
    }


def dedupe_chunk_source_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    deduped: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        chunk_id = str(row.get("chunkId") or "")
        if not chunk_id:
            continue
        current = deduped.get(chunk_id)
        if not current or chunk_source_row_score(row) > chunk_source_row_score(current):
            deduped[chunk_id] = row
    return list(deduped.values())


def chunk_source_row_score(row: Dict[str, Any]) -> int:
    return sum([
        4 if row.get("entryId") else 0,
        2 if row.get("path") else 0,
        1 if row.get("fileHash") else 0,
    ])


async def run_graph_node_detail(payload: Dict[str, Any]) -> Dict[str, Any]:
    storage = configure_environment(payload)
    dataset_name = str(payload.get("datasetName") or "")
    node_id = str(payload.get("nodeId") or "").strip()
    max_related_nodes = positive_int(payload.get("maxRelatedNodes")) or 500
    max_related_edges = positive_int(payload.get("maxRelatedEdges")) or 1000
    include_documents = payload.get("includeDocuments") is not False
    empty = {
        "source": "cognee_graph_api",
        "provider": "cognee",
        "accessMode": "cognee_graph_api",
        "datasetName": dataset_name,
        "node": None,
        "relatedNodes": [],
        "relatedEdges": [],
        "relatedNodeCount": 0,
        "relatedEdgeCount": 0,
        "limited": False,
        "limits": {
            "maxRelatedNodes": max_related_nodes,
            "maxRelatedEdges": max_related_edges,
        },
        "documentPreview": None,
        "documentChunks": [],
    }
    if not dataset_name or not node_id:
        return empty

    import cognee  # type: ignore
    from cognee.context_global_variables import set_database_global_context_variables  # type: ignore
    from cognee.infrastructure.databases.graph import get_graph_engine  # type: ignore

    configure_cognee_runtime(cognee, storage)
    dataset = await dataset_details(cognee, dataset_name)
    dataset_id = dataset.get("id")
    owner_id = dataset.get("ownerId")
    if not dataset_id or not owner_id:
        return {**empty, "source": "cognee_dataset_missing"}

    async with set_database_global_context_variables(UUID(str(dataset_id)), UUID(str(owner_id))):
        graph_client = await get_graph_engine()
        node = None
        resolved_node_id = node_id
        for candidate in candidate_chunk_ids(node_id):
            try:
                node = await graph_client.get_node(str(candidate))
            except Exception:
                node = None
            if node:
                resolved_node_id = str(candidate)
                break
        if not node:
            return {**empty, "source": "cognee_node_missing", "datasetId": str(dataset_id)}
        try:
            raw_nodes, raw_edges = await graph_client.get_graph_data()
        except Exception:
            raw_nodes = []
            raw_edges = []

    normalized_node = cognee_api_graph_node((resolved_node_id, node))
    graph_nodes = unique_graph_nodes(cognee_api_graph_node(raw_node) for raw_node in raw_nodes)
    if not any(str(item.get("id") or "") == str(normalized_node.get("id") or "") for item in graph_nodes):
        graph_nodes.append(normalized_node)
    alias_to_id = graph_node_alias_map(graph_nodes)
    resolved_node_id = canonical_graph_id(resolved_node_id, alias_to_id)
    related_edges_all = [
        normalize_graph_edge_endpoints(cognee_api_graph_edge(edge, index), alias_to_id)
        for index, edge in enumerate(raw_edges)
    ]
    incident_edges = [
        edge for edge in related_edges_all
        if str(edge.get("source") or "") == resolved_node_id or str(edge.get("target") or "") == resolved_node_id
    ]
    graph_node_by_id = {str(item.get("id") or ""): item for item in graph_nodes if item.get("id")}
    related_edges_all = collapse_relationship_node_edges(resolved_node_id, incident_edges, related_edges_all, graph_node_by_id)
    related_node_ids = []
    for edge in related_edges_all:
        for endpoint in (edge.get("source"), edge.get("target")):
            endpoint_id = str(endpoint or "")
            if endpoint_id and endpoint_id != resolved_node_id and endpoint_id not in related_node_ids:
                related_node_ids.append(endpoint_id)
    related_nodes = [
        graph_node_by_id[related_id]
        for related_id in related_node_ids[:max_related_nodes]
        if related_id in graph_node_by_id
    ]
    related_edges = related_edges_all[:max_related_edges]
    document_preview = normalized_node.get("textPreview") if normalized_node.get("type") in ("DocumentChunk", "TextSummary", "TextDocument") else None
    document_chunks = [
        related_node for related_node in related_nodes
        if include_documents and related_node.get("type") in ("DocumentChunk", "TextSummary", "TextDocument")
    ]
    limited = len(related_node_ids) > len(related_nodes) or len(related_edges_all) > len(related_edges)
    return {
        "source": "cognee_graph_api",
        "provider": "cognee",
        "accessMode": "cognee_graph_api",
        "datasetName": dataset_name,
        "datasetId": str(dataset_id),
        "node": normalized_node,
        "relatedNodes": related_nodes,
        "relatedEdges": related_edges,
        "relatedNodeCount": len(related_node_ids),
        "relatedEdgeCount": len(related_edges_all),
        "limited": limited,
        "limits": {
            "maxRelatedNodes": max_related_nodes,
            "maxRelatedEdges": max_related_edges,
        },
        "documentPreview": document_preview,
        "documentChunks": document_chunks,
    }


def collapse_relationship_node_edges(
    root_node_id: str,
    incident_edges: List[Dict[str, Any]],
    all_edges: List[Dict[str, Any]],
    node_by_id: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    collapsed: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for edge in incident_edges:
        other_id = edge_other_endpoint(edge, root_node_id)
        other_node = node_by_id.get(other_id)
        if other_id and other_node and is_relationship_graph_node(other_node):
            expanded = False
            for second_edge in all_edges:
                if not edge_touches_node(second_edge, other_id):
                    continue
                connected_id = edge_other_endpoint(second_edge, other_id)
                if not connected_id or connected_id == root_node_id or connected_id not in node_by_id:
                    continue
                relationship = relationship_node_label(other_node, edge)
                collapsed_edge = {
                    **edge,
                    "id": f"{root_node_id}->{connected_id}:{other_id}",
                    "source": root_node_id,
                    "target": connected_id,
                    "label": relationship,
                    "relationship": relationship,
                    "rawRelationship": edge.get("rawRelationship") or relationship,
                    "viaRelationshipNodeId": other_id,
                }
                append_unique_edge(collapsed, seen, collapsed_edge)
                expanded = True
            if expanded:
                continue
        append_unique_edge(collapsed, seen, edge)
    return collapsed


def append_unique_edge(edges: List[Dict[str, Any]], seen: set[str], edge: Dict[str, Any]) -> None:
    key = str(edge.get("id") or f"{edge.get('source')}->{edge.get('target')}:{edge.get('relationship') or edge.get('label')}")
    if key in seen:
        return
    seen.add(key)
    edges.append(edge)


def edge_touches_node(edge: Dict[str, Any], node_id: str) -> bool:
    return str(edge.get("source") or "") == node_id or str(edge.get("target") or "") == node_id


def edge_other_endpoint(edge: Dict[str, Any], node_id: str) -> str:
    source = str(edge.get("source") or "")
    target = str(edge.get("target") or "")
    if source == node_id:
        return target
    if target == node_id:
        return source
    return ""


def is_relationship_graph_node(node: Dict[str, Any]) -> bool:
    node_type = str(node.get("type") or "").strip().lower()
    if node_type in {"relationship", "relation", "edge"}:
        return True
    for value in (node.get("label"), node.get("name"), node.get("description"), node.get("textPreview")):
        if parse_edge_metadata(str(value or "")):
            return True
    return False


def relationship_node_label(node: Dict[str, Any], fallback_edge: Dict[str, Any]) -> str:
    for value in (node.get("label"), node.get("name"), node.get("description"), node.get("textPreview")):
        parsed = parse_edge_metadata(str(value or ""))
        if parsed.get("relationship_name"):
            return parsed["relationship_name"]
    return str(fallback_edge.get("relationship") or fallback_edge.get("label") or "related_to")


def bounded_text(value: Any, limit: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if len(text) <= limit:
        return text
    return f"{text[: max(0, limit - 3)]}..."


def parse_edge_metadata(value: str) -> Dict[str, str]:
    if ":" not in value or ";" not in value:
        return {}
    parsed: Dict[str, str] = {}
    for part in value.split(";"):
        key, separator, raw = part.partition(":")
        if not separator:
            continue
        key = key.strip()
        text = raw.strip()
        if key and text:
            parsed[key] = text
    return parsed


async def main() -> None:
    payload = json.load(sys.stdin)
    action = str(payload.get("action") or "search")
    if action == "ingest":
        result = await run_ingest(payload)
    elif action == "search":
        result = await run_search(payload)
    elif action == "graph":
        result = await run_graph(payload)
    elif action == "graph_node_detail":
        result = await run_graph_node_detail(payload)
    elif action == "chunk_source_mappings":
        result = await run_chunk_source_mappings(payload)
    elif action == "release_cognify_lock":
        result = await release_cognify_lock(payload)
    else:
        raise RuntimeError(f"Unsupported Cognee action: {action}")
    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
