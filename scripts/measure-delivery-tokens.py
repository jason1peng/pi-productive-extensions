#!/usr/bin/env python3
"""Measure delivery state-machine token efficiency from a parent session JSONL.

Parses a Pi parent session JSONL (real run or simulator-produced) and reports,
for every delivery_* tool response:

  - total tool-response bytes (content text + serialized details)
  - content text bytes vs details bytes
  - details.state bytes (the ever-growing state attachment)
  - childPrompt copy count and duplicate-copy bytes (copies beyond the one
    canonical details.next.childPrompt the orchestrator actually uses)
  - details.next.prompt dead-mirror bytes

It also reports launched child-prompt bytes (subagent toolCall `task`
arguments) for the child-side gate, and per-phase childPrompt sizes.

Usage:
  scripts/measure-delivery-tokens.py SESSION.jsonl [SESSION2.jsonl ...]
  scripts/measure-delivery-tokens.py --json SESSION.jsonl
  scripts/measure-delivery-tokens.py --sessions-dir DIR   # auto-pick the parent session

Token figures are estimates at ~4 bytes/token; byte figures are exact UTF-8.
This is a reporting tool; it always exits 0 unless arguments are invalid.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

DELIVERY_TOOL_PREFIX = "delivery_"
SUBAGENT_TOOL_NAMES = {"subagent"}
BYTES_PER_TOKEN_ESTIMATE = 4


def utf8(value: str) -> int:
    return len(value.encode("utf-8"))


def compact_json(value) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def json_fragment(value: str) -> str:
    """The string as it appears inside serialized JSON (without outer quotes)."""
    return json.dumps(value, ensure_ascii=False)[1:-1]


def iter_records(path: Path):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def content_text(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
            parts.append(item["text"])
    return "\n".join(parts)


def next_child_prompts(details: dict) -> list[str]:
    """Canonical childPrompt strings carried by a details.next package."""
    prompts: list[str] = []
    nxt = details.get("next")
    if not isinstance(nxt, dict):
        return prompts
    parallel = nxt.get("parallel")
    if isinstance(parallel, list) and parallel:
        for launch in parallel:
            if isinstance(launch, dict) and isinstance(launch.get("childPrompt"), str):
                prompts.append(launch["childPrompt"])
    elif isinstance(nxt.get("childPrompt"), str):
        prompts.append(nxt["childPrompt"])
    return prompts


def analyze_session(path: Path) -> dict:
    calls: list[dict] = []
    child_launches: list[dict] = []
    for record in iter_records(path):
        message = record.get("message") or {}
        role = message.get("role")
        if role == "toolResult":
            tool = message.get("toolName") or ""
            if not tool.startswith(DELIVERY_TOOL_PREFIX):
                continue
            text = content_text(message.get("content"))
            details = message.get("details") or {}
            details_json = compact_json(details)
            state = details.get("state")
            state_json = compact_json(state) if state is not None else ""
            nxt = details.get("next") if isinstance(details.get("next"), dict) else {}
            prompts = next_child_prompts(details)
            copies = 0
            duplicate_bytes = 0
            for prompt in prompts:
                occurrences = text.count(prompt) + details_json.count(json_fragment(prompt))
                copies += occurrences
                if occurrences > 1:
                    duplicate_bytes += (occurrences - 1) * utf8(prompt)
            mirror = nxt.get("prompt") if isinstance(nxt, dict) else None
            mirror_bytes = utf8(mirror) if isinstance(mirror, str) else 0
            text_includes_prompt = any(prompt and prompt in text for prompt in prompts)
            calls.append(
                {
                    "tool": tool,
                    "totalBytes": utf8(text) + utf8(details_json),
                    "textBytes": utf8(text),
                    "detailsBytes": utf8(details_json),
                    "stateBytes": utf8(state_json),
                    "hasNext": bool(nxt),
                    "childPromptCopies": copies,
                    "duplicateChildPromptBytes": duplicate_bytes,
                    "promptMirrorBytes": mirror_bytes,
                    "textIncludesChildPrompt": text_includes_prompt,
                    "childPromptBytes": sum(utf8(prompt) for prompt in prompts),
                }
            )
        elif role == "assistant":
            for item in message.get("content") or []:
                if not isinstance(item, dict) or item.get("type") != "toolCall":
                    continue
                if item.get("name") not in SUBAGENT_TOOL_NAMES:
                    continue
                args = item.get("arguments") or {}
                if not isinstance(args, dict):
                    continue
                tasks = args.get("tasks")
                entries = tasks if isinstance(tasks, list) else [args]
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    task = entry.get("task")
                    if isinstance(task, str) and task:
                        child_launches.append(
                            {
                                "agent": entry.get("agent") or args.get("agent"),
                                "taskBytes": utf8(task),
                            }
                        )
    totals = {
        "session": str(path),
        "deliveryCalls": len(calls),
        "totalToolResponseBytes": sum(call["totalBytes"] for call in calls),
        "textBytes": sum(call["textBytes"] for call in calls),
        "detailsBytes": sum(call["detailsBytes"] for call in calls),
        "stateBytes": sum(call["stateBytes"] for call in calls),
        "stateBytesMax": max((call["stateBytes"] for call in calls), default=0),
        "stateBytesLast": calls[-1]["stateBytes"] if calls else 0,
        "duplicateChildPromptBytes": sum(call["duplicateChildPromptBytes"] for call in calls),
        "childPromptExtraCopies": sum(max(call["childPromptCopies"] - (1 if call["childPromptCopies"] else 0), 0) for call in calls),
        "promptMirrorBytes": sum(call["promptMirrorBytes"] for call in calls),
        "reportCallsReturningNext": sum(1 for call in calls if call["tool"] == "delivery_report" and call["hasNext"]),
        "childLaunches": len(child_launches),
        "childLaunchPromptBytes": sum(launch["taskBytes"] for launch in child_launches),
        "calls": calls,
        "launches": child_launches,
    }
    totals["estimatedToolResponseTokens"] = round(totals["totalToolResponseBytes"] / BYTES_PER_TOKEN_ESTIMATE)
    totals["estimatedChildLaunchTokens"] = round(totals["childLaunchPromptBytes"] / BYTES_PER_TOKEN_ESTIMATE)
    return totals


def format_report(report: dict) -> str:
    lines = [
        f"session: {report['session']}",
        (
            f"delivery tool responses: {report['deliveryCalls']} calls, "
            f"{report['totalToolResponseBytes']:,} bytes (~{report['estimatedToolResponseTokens']:,} tokens @4B/tok)"
        ),
        f"  content text: {report['textBytes']:,} | details: {report['detailsBytes']:,}",
        (
            f"  details.state total: {report['stateBytes']:,} "
            f"(max per call {report['stateBytesMax']:,}, last call {report['stateBytesLast']:,})"
        ),
        (
            f"  duplicate childPrompt copies: {report['childPromptExtraCopies']} extra copies, "
            f"{report['duplicateChildPromptBytes']:,} bytes"
        ),
        f"  details.next.prompt dead-mirror bytes: {report['promptMirrorBytes']:,}",
        f"  delivery_report responses still returning details.next: {report['reportCallsReturningNext']}",
        (
            f"child prompts launched: {report['childLaunches']} launches, "
            f"{report['childLaunchPromptBytes']:,} bytes (~{report['estimatedChildLaunchTokens']:,} tokens)"
        ),
    ]
    if report["calls"]:
        lines.append("")
        lines.append(f"{'#':>2}  {'tool':<17}{'total':>8}{'text':>8}{'details':>9}{'state':>8}{'copies':>7}{'dupBytes':>9}")
        for index, call in enumerate(report["calls"], start=1):
            lines.append(
                f"{index:>2}  {call['tool']:<17}{call['totalBytes']:>8,}{call['textBytes']:>8,}"
                f"{call['detailsBytes']:>9,}{call['stateBytes']:>8,}{call['childPromptCopies']:>7}{call['duplicateChildPromptBytes']:>9,}"
            )
    return "\n".join(lines)


def find_parent_session(sessions_dir: Path) -> Path:
    candidates = []
    for jsonl in sorted(sessions_dir.rglob("*.jsonl"), key=os.path.getmtime):
        try:
            for record in iter_records(jsonl):
                message = record.get("message") or {}
                if message.get("role") == "toolResult" and str(message.get("toolName", "")).startswith(DELIVERY_TOOL_PREFIX):
                    candidates.append(jsonl)
                    break
        except OSError:
            continue
    if not candidates:
        raise SystemExit(f"no session with {DELIVERY_TOOL_PREFIX}* tool results under {sessions_dir}")
    if len(candidates) > 1:
        print(f"warning: multiple parent-session candidates; using newest: {candidates[-1]}", file=sys.stderr)
    return candidates[-1]


def main(argv: list[str]) -> int:
    args = list(argv)
    as_json = "--json" in args
    if as_json:
        args.remove("--json")
    sessions_dir = None
    if "--sessions-dir" in args:
        index = args.index("--sessions-dir")
        sessions_dir = Path(args[index + 1])
        del args[index : index + 2]
    if sessions_dir is not None:
        args.append(str(find_parent_session(sessions_dir)))
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    reports = [analyze_session(Path(arg)) for arg in args]
    if as_json:
        print(json.dumps(reports if len(reports) > 1 else reports[0], indent=2))
    else:
        print("\n\n".join(format_report(report) for report in reports))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
