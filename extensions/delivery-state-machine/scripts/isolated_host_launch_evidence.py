"""Resolve smoke launches to child sessions using pi-subagents metadata."""

import json
import re
from pathlib import Path

_AUTHORITATIVE_OUTPUT = re.compile(
    r"Write your findings to exactly this path:\s*([^\n]+)\n"
    r"This path is authoritative for this run\."
)
_METADATA_NAME = re.compile(r"^(?P<run_id>[^_]+)_.+_(?P<child_index>\d+)_meta\.json$")


def resolve_child_session(
    metadata_root: Path, sessions_root: Path, agent: str, output: str
) -> tuple[Path, list[dict]]:
    """Return the one session identified by child metadata for a launch."""
    metadata_matches: list[tuple[str, int]] = []
    for metadata_path in metadata_root.glob("*_meta.json"):
        try:
            metadata = json.loads(metadata_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        name_match = _METADATA_NAME.match(metadata_path.name)
        task_match = _AUTHORITATIVE_OUTPUT.search(str(metadata.get("task", "")))
        if (
            metadata.get("agent") == agent
            and name_match
            and task_match
            and task_match.group(1).strip() == output
        ):
            metadata_matches.append(
                (str(metadata.get("runId") or name_match.group("run_id")), int(name_match.group("child_index")))
            )
    if len(metadata_matches) != 1:
        raise ValueError(
            f"expected one child metadata record for {agent} output {output}, found {len(metadata_matches)}"
        )

    run_id, child_index = metadata_matches[0]
    session_matches = list(sessions_root.glob(f"**/{run_id}/run-{child_index}/session.jsonl"))
    if len(session_matches) != 1:
        raise ValueError(
            f"expected one child session for run {run_id} index {child_index}, found {len(session_matches)}"
        )
    session_path = session_matches[0]
    try:
        records = [json.loads(line) for line in session_path.read_text().splitlines() if line.strip()]
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read child session {session_path}: {error}") from error
    return session_path, records
