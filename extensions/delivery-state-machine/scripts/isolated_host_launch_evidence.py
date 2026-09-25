"""Resolve smoke launches to child sessions using pi-subagents metadata."""

import json
import re
from pathlib import Path

_AUTHORITATIVE_OUTPUT = re.compile(
    r"Write your findings to exactly this path:\s*([^\n]+)\n"
    r"This path is authoritative for this run\."
)
_METADATA_NAME = re.compile(
    r"^(?P<run_id>[^_]+)_.+?(?:_(?P<child_index>\d+))?_meta\.json$"
)


def _read_transcript(path: Path) -> list[dict]:
    records = []
    try:
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                records.append(record)
    except OSError:
        pass
    return records


def _record_text(record: dict) -> str:
    text = record.get("text")
    if isinstance(text, str):
        return text
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, list):
        return "\n".join(
            item["text"] for item in content
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        )
    return ""


def _session_info_name(session_path: Path) -> str | None:
    try:
        with session_path.open() as session_file:
            for _ in range(20):
                line = session_file.readline()
                if not line:
                    break
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("type") == "session_info" and isinstance(record.get("name"), str):
                    return record["name"]
    except OSError:
        return None
    return None


def resolve_child_session(
    metadata_root: Path, sessions_root: Path, agent: str, output: str
) -> tuple[Path, list[dict]]:
    """Return the one session identified by child metadata for a launch."""
    metadata_matches: list[tuple[str, int | None]] = []
    for metadata_path in metadata_root.rglob("*_meta.json"):
        try:
            metadata = json.loads(metadata_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(metadata, dict) or metadata.get("agent") != agent:
            continue

        name_match = _METADATA_NAME.match(metadata_path.name)
        run_id = metadata.get("runId") or (name_match.group("run_id") if name_match else None)
        if not isinstance(run_id, str):
            continue
        child_index = int(name_match.group("child_index")) if name_match and name_match.group("child_index") else None
        task_match = _AUTHORITATIVE_OUTPUT.search(str(metadata.get("task", "")))
        transcript_path_value = metadata.get("transcriptPath")
        if isinstance(transcript_path_value, str):
            transcript_path = Path(transcript_path_value)
        else:
            transcript_path = metadata_path.with_name(
                metadata_path.name.removesuffix("_meta.json") + "_transcript.jsonl"
            )
        for record in _read_transcript(transcript_path):
            if record.get("runId") != run_id or record.get("agent") != agent:
                continue
            transcript_index = record.get("childIndex")
            if child_index is None and isinstance(transcript_index, int):
                child_index = transcript_index
            if task_match is None:
                task_match = _AUTHORITATIVE_OUTPUT.search(_record_text(record))

        if task_match and task_match.group(1).strip() == output:
            metadata_matches.append((run_id, child_index))

    if len(metadata_matches) != 1:
        raise ValueError(
            f"expected one child metadata record for {agent} output {output}, found {len(metadata_matches)}"
        )

    run_id, child_index = metadata_matches[0]
    session_matches = []
    if child_index is not None:
        session_matches = list(sessions_root.glob(f"**/{run_id}/run-{child_index}/session.jsonl"))
    if not session_matches:
        expected_name_prefix = f"subagent-{agent}-{run_id}-"
        session_matches = [
            session_path
            for session_path in sessions_root.rglob("session.jsonl")
            if (_session_name := _session_info_name(session_path)) is not None
            and _session_name.startswith(expected_name_prefix)
        ]
    if len(session_matches) != 1:
        suffix = f" index {child_index}" if child_index is not None else ""
        raise ValueError(
            f"expected one child session for run {run_id}{suffix}, found {len(session_matches)}"
        )

    session_path = session_matches[0]
    try:
        records = [json.loads(line) for line in session_path.read_text().splitlines() if line.strip()]
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read child session {session_path}: {error}") from error
    return session_path, records
