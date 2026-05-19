#!/usr/bin/env python3
"""Cognee context provider sidecar for Allen.

The script intentionally keeps Cognee behind Allen's provider boundary. It can
ingest/cognify repo memory and retrieve context items. If Cognee is not
installed, it exits with a clear error so Allen can record provider diagnostics.
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import NAMESPACE_DNS, UUID, uuid5

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from cognee_context_provider.runtime import (
    PROGRESS_PREFIX,
    configure_cognee_runtime,
    configure_environment,
    emit_progress,
)


async def dataset_details(cognee: Any, dataset_name: str) -> Dict[str, Any]:
    try:
        datasets = await cognee.datasets.list_datasets()
    except Exception:
        return {"exists": None, "id": None}
    for dataset in datasets if isinstance(datasets, list) else []:
        if isinstance(dataset, dict):
            name = dataset.get("name") or dataset.get("dataset_name") or dataset.get("datasetName")
            dataset_id = dataset.get("id") or dataset.get("dataset_id") or dataset.get("datasetId")
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
        if str(name or "") == dataset_name:
            return {"exists": True, "id": str(dataset_id) if dataset_id else None}
    return {"exists": False, "id": None}


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

    while not task.done():
        cognified = await count_cognified_documents(dataset_id)
        now = time.time()
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
        await asyncio.sleep(5)

    await task
    cognified = await count_cognified_documents(dataset_id)
    emit_progress(
        stage="cognifying",
        message=f"Cognified: {cognified if cognified is not None else total_documents}/{total_documents}",
        processedDocumentCount=cognified if cognified is not None else total_documents,
        ingestedDocumentCount=ingested_documents,
        cognifiedDocumentCount=cognified if cognified is not None else total_documents,
        documentCount=total_documents,
        **storage_progress(storage, dataset_existing),
    )


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
        path = str(document.get("path") or document.get("title") or f"document-{added + 1}")
        metadata = document_metadata(document, payload)
        data_item = (
            DataItem(
                data=text,
                label=path,
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
    final_inspection = await inspect_cognified_documents(dataset_id)
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
            "message": f"Cognee cognified {final_cognified}/{total_documents} ingested Markdown files.",
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
        "uncognifiedDocuments": uncognified_documents,
        "durationMs": int((time.time() - started) * 1000),
        **storage_progress(storage, existing_dataset),
        "diagnostics": diagnostics,
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
    return str(document.get("path") or document.get("title") or "").strip()


def document_metadata(document: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    repo = payload.get("repo") if isinstance(payload.get("repo"), dict) else {}
    return {
        "repoId": repo.get("repoId"),
        "repoName": repo.get("repoName"),
        "branch": repo.get("branch"),
        "headSha": repo.get("headSha"),
        "path": document.get("path"),
        "title": document.get("title") or document.get("path"),
        "kind": document.get("kind") or "doc",
        "fileHash": document.get("hash"),
        "dataId": str(document.get("dataId") or document.get("data_id") or ""),
        "source": "allen_markdown_file_filter",
        "ingestFormat": payload.get("ingestFormat") or "markdown_file_docmeta_v1",
    }


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
    search_kwargs = {
        "query_text": query,
        "query_type": SearchType.CHUNKS,
        "datasets": [dataset_name],
        "top_k": max_results,
    }
    try:
        raw_results = await cognee.search(**search_kwargs)
    except TypeError:
        search_kwargs.pop("top_k", None)
        raw_results = await cognee.search(**search_kwargs)
    normalized = await normalize_results(raw_results, dataset_name, max_results)
    return {
        "status": "completed",
        "datasetName": dataset_name,
        "results": normalized["results"],
        **storage_progress(storage),
        "diagnostics": [storage_diagnostic(storage), *normalized["diagnostics"]],
        "durationMs": int((time.time() - started) * 1000),
    }


async def normalize_results(raw_results: Any, dataset_name: str, max_results: int) -> Dict[str, Any]:
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
            source_id = first_present(row.get("sourceId"), row.get("source_id"), metadata.get("sourceId"), metadata.get("source_id"))
            chunk_id = first_present(row.get("chunkId"), row.get("chunk_id"), metadata.get("chunkId"), metadata.get("chunk_id"), row.get("id"), row.get("uuid"))
            ref_id = first_present(row.get("refId"), row.get("id"), row.get("uuid"), metadata.get("refId"), metadata.get("id"), chunk_id, source_id)
            source_metadata = extract_source_metadata(row) or extract_source_metadata(envelope)
            if not source_metadata and chunk_id:
                source_metadata = await resolve_chunk_source_metadata(str(chunk_id))
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
                    "searchMode": "CHUNKS",
                    "message": "Cognee returned a chunk id, but Allen could not resolve source document metadata for it.",
                })
            path = first_portable_path(
                source_metadata.get("path"),
                envelope.get("path"),
                metadata.get("path"),
                row.get("label"),
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
            "sourceId": source_id,
            "chunkId": chunk_id,
            "chunkIndex": chunk_index,
            "chunkSize": chunk_size,
            "cutType": cut_type,
            "sourceMetadata": source_metadata,
            "externalMetadata": source_metadata,
            "entityIds": metadata.get("entityIds") or metadata.get("entity_ids"),
            "searchMode": "CHUNKS",
        })
    if chunk_count > 0:
        diagnostics.append({
            "code": "cognee_chunk_source_metadata_resolution",
            "severity": "info" if unresolved_metadata_count == 0 else "warn",
            "datasetName": dataset_name,
            "searchMode": "CHUNKS",
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
    graph_metadata = await resolve_chunk_source_metadata_from_graph(chunk_id)
    if graph_metadata:
        return graph_metadata
    return resolve_chunk_source_metadata_from_sqlite(chunk_id)


async def resolve_chunk_source_metadata_from_graph(chunk_id: str) -> Dict[str, Any]:
    try:
        from cognee.infrastructure.databases.graph import get_graph_engine  # type: ignore
    except Exception:
        return {}

    try:
        graph_engine = await get_graph_engine()
    except Exception:
        return {}

    for node_id in candidate_chunk_ids(chunk_id):
        try:
            node = await graph_engine.get_node(str(node_id))
        except Exception:
            node = None
        metadata = extract_source_metadata(node)
        if metadata:
            return metadata

        for query in chunk_parent_queries():
            try:
                rows = await graph_engine.query(query, {"chunk_id": str(node_id)})
            except Exception:
                continue
            metadata = extract_source_metadata(rows)
            if metadata:
                return metadata
    return {}


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


def resolve_chunk_source_metadata_from_sqlite(chunk_id: str) -> Dict[str, Any]:
    database_file = Path(os.environ.get("SYSTEM_ROOT_DIRECTORY", "~/.allen/cognee/system")).expanduser() / "databases" / "cognee_db"
    if not database_file.exists():
        return {}
    ids = candidate_chunk_ids(chunk_id)
    placeholders = ",".join("?" for _ in ids)
    base_query = f"""
        SELECT data.external_metadata
        FROM nodes
        JOIN data ON data.id = nodes.data_id
        WHERE nodes.label IN ({placeholders})
           OR nodes.id IN ({placeholders})
           OR nodes.slug IN ({placeholders})
        LIMIT 1
    """
    try:
        with sqlite3.connect(str(database_file)) as connection:
            row = connection.execute(base_query, [*ids, *ids, *ids]).fetchone()
            if row:
                return metadata_dict(row[0])
            try:
                json_query = f"""
                    SELECT data.external_metadata
                    FROM nodes
                    JOIN data ON data.id = nodes.data_id
                    WHERE json_extract(nodes.attributes, '$.id') IN ({placeholders})
                    LIMIT 1
                """
                row = connection.execute(json_query, ids).fetchone()
            except Exception:
                row = None
            return metadata_dict(row[0]) if row else {}
    except Exception:
        return {}


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


async def main() -> None:
    payload = json.load(sys.stdin)
    action = str(payload.get("action") or "search")
    if action == "ingest":
        result = await run_ingest(payload)
    elif action == "search":
        result = await run_search(payload)
    else:
        raise RuntimeError(f"Unsupported Cognee action: {action}")
    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
