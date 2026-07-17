#!/usr/bin/env bash
set -euo pipefail

# Opt-in, model-backed Stage 6 smoke. It intentionally is not part of npm run verify.
REPO_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PI_BIN=${PI_BIN:-pi}
MODEL=${DSM_SMOKE_MODEL:-openai-codex/gpt-5.6-sol}
SUBAGENTS_ROOT=${PI_SUBAGENTS_ROOT:-${HOME}/.pi/agent/npm/node_modules/pi-subagents}
EVIDENCE_DIR=${DSM_SMOKE_EVIDENCE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/dsm-isolated-host-smoke.XXXXXX")}
TIMEOUT_SECONDS=${DSM_SMOKE_TIMEOUT_SECONDS:-720}
TEMP_AGENT_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/dsm-isolated-host-agent.XXXXXX")
AGENT_DIR="$TEMP_AGENT_ROOT/agent"
PROJECT_DIR="$EVIDENCE_DIR/project"
RESULTS_DIR="$EVIDENCE_DIR/results"
PACKAGE_DIR="$EVIDENCE_DIR/package"
DELIVERY_ROOT="$RESULTS_DIR/delivery-artifacts"

SMOKE_HOST_PID=
cleanup_agent_home() {
	rm -rf -- "$TEMP_AGENT_ROOT"
}
forward_host_signal() {
	local signal_name=$1
	local exit_code=$2
	trap - HUP INT TERM
	if [[ -n "$SMOKE_HOST_PID" ]] && kill -0 "$SMOKE_HOST_PID" 2>/dev/null; then
		kill -s "$signal_name" "$SMOKE_HOST_PID" 2>/dev/null || true
		wait "$SMOKE_HOST_PID" 2>/dev/null || true
	fi
	exit "$exit_code"
}
trap cleanup_agent_home EXIT
trap 'forward_host_signal HUP 129' HUP
trap 'forward_host_signal INT 130' INT
trap 'forward_host_signal TERM 143' TERM

mkdir -p "$AGENT_DIR" "$PROJECT_DIR" "$RESULTS_DIR" "$PACKAGE_DIR"
# Record the complete source-worktree state so the smoke cannot silently leave
# bytecode or any other mutation behind in the candidate checkout.
git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all > "$RESULTS_DIR/source-status-before.txt"
cp "$REPO_ROOT/package.json" "$PACKAGE_DIR/package.json"
cp -R "$REPO_ROOT/extensions" "$REPO_ROOT/shared" "$PACKAGE_DIR/"
mkdir "$PACKAGE_DIR/.git"
if [[ -f "${HOME}/.pi/agent/auth.json" ]]; then
	cp "${HOME}/.pi/agent/auth.json" "$AGENT_DIR/auth.json"
fi
cat > "$AGENT_DIR/settings.json" <<JSON
{
  "defaultModel": "$MODEL",
  "subagents": {
    "defaultModel": "$MODEL"
  },
  "packages": [
    "$SUBAGENTS_ROOT",
    "$PACKAGE_DIR"
  ]
}
JSON
# Preserve the exact bundled launch configuration used by this run. Do not
# install a profile override: the smoke must exercise the provider-neutral
# package candidate, including its contexts and parallel REVIEW shape.
cp "$PACKAGE_DIR/extensions/delivery-state-machine/phase-launches.json" "$RESULTS_DIR/bundled-phase-launches.json"

# A clean project and clean Pi agent-definition scopes prove the roles do not
# come from user or project agent markdown.
git -C "$PROJECT_DIR" init -q -b main
printf '# Isolated DSM host smoke\n' > "$PROJECT_DIR/README.md"
# pi-subagents writes execution evidence here; ignore it so the candidate's
# no-source-change task can still prove the isolated fixture is clean.
printf '.pi-subagents/\n' > "$PROJECT_DIR/.gitignore"
git -C "$PROJECT_DIR" add README.md .gitignore
git -C "$PROJECT_DIR" -c user.name=Smoke -c user.email=smoke@example.invalid commit -qm init
if find "$AGENT_DIR" "$PROJECT_DIR" -type f \( -path '*/agents/*.md' -o -path '*/.agents/*.md' \) | grep -q .; then
	echo "unexpected user/project agent definition in isolated roots" >&2
	exit 1
fi

PI_CODING_AGENT_DIR="$AGENT_DIR" NODE_PATH=${NODE_PATH:-${HOME}/.pi/agent/npm/node_modules} bun --eval '
import { pathToFileURL } from "node:url";
const modulePath = process.argv[1];
const cwd = process.argv[2];
const output = process.argv[3];
const { discoverAgentsAll } = await import(pathToFileURL(modulePath).href);
const found = discoverAgentsAll(cwd).package
  .filter((agent) => agent.name.startsWith("dsm."))
  .map((agent) => ({ name: agent.name, source: agent.source, packageName: agent.packageName }))
  .sort((a, b) => a.name.localeCompare(b.name));
await Bun.write(output, JSON.stringify(found, null, 2) + "\n");
if (found.length !== 5 || found.some((agent) => agent.source !== "package" || agent.packageName !== "dsm")) process.exit(1);
' "$SUBAGENTS_ROOT/src/agents/agents.ts" "$PACKAGE_DIR" "$RESULTS_DIR/discovery.json"

cat > "$RESULTS_DIR/orchestrator-prompt.txt" <<'PROMPT'
Run one complete representative delivery using the delivery-state-machine tools and the configured dsm-candidate profile. The task is: "Verify the committed README accurately identifies this as an isolated DSM host smoke; no source change is expected."

Use this exact bounded loop:
1. Call delivery_start once with every maxRounds value set to 1.
2. Call delivery_next once for the current phase.
3. Call the subagent tool synchronously with the exact agent, thinking, context, cwd, childPrompt, and output path returned by delivery_next, plus model only when delivery_next supplies one. When delivery_next returns parallel launches, launch every parallel entry with its own exact settings and output path. Do not add or substitute model fields, collapse parallel launches, investigate alternatives, or retry a launch.
4. Read every resulting artifact, then call delivery_report with its phase and aggregate verdict.
5. Repeat steps 2-4 through IMPLEMENT, VERIFY, REVIEW, CLOSE, and RETRO. If a phase does not pass, report the real result and stop rather than attempting repair.
6. Call delivery_status. End with exactly DSM_DELIVERY_SMOKE_DONE only when status is DONE.

Never create a worktree or replace a requested child with your own work. Do not inspect pi-subagents implementation or skills, skip/simulate a child launch, push, create a branch, create an MR, or make source changes. This clean fixture needs only the phase-specific checks requested by each child prompt. The outer harness owns the overall timeout.
PROMPT

# Run the quota-backed workflow under an internal deadline shorter than the
# external verification window. progress.log is updated while Pi is running so
# a failure identifies the last produced artifact/session instead of appearing
# as an uninstrumented hang. Python is used for portable process-group cleanup
# because macOS does not ship the GNU timeout command.
export PI_CODING_AGENT_DIR="$AGENT_DIR"
export PI_DELIVERY_PROFILE=dsm-candidate
export PI_DELIVERY_ARTIFACT_ROOT="$DELIVERY_ROOT"
export DSM_SMOKE_PI_BIN="$PI_BIN"
export DSM_SMOKE_PROJECT_DIR="$PROJECT_DIR"
export DSM_SMOKE_RESULTS_DIR="$RESULTS_DIR"
export DSM_SMOKE_DELIVERY_ROOT="$DELIVERY_ROOT"
export DSM_SMOKE_ORCHESTRATOR_PROMPT="$(cat "$RESULTS_DIR/orchestrator-prompt.txt")"
export DSM_SMOKE_ORCHESTRATOR_MODEL="$MODEL"
export DSM_SMOKE_SUBAGENTS_EXTENSION="$SUBAGENTS_ROOT/src/extension/index.ts"
export DSM_SMOKE_TIMEOUT_SECONDS="$TIMEOUT_SECONDS"
export DSM_SMOKE_ENV_HELPER_DIR="$REPO_ROOT/extensions/delivery-state-machine/scripts"
# The helper is imported from the source worktree; forbid Python from creating
# scripts/__pycache__ there, even if interpreter flags are changed later.
export PYTHONDONTWRITEBYTECODE=1
python3 -B <<'PY' &
import datetime
import glob
import os
import subprocess
import sys
import time

sys.path.insert(0, os.environ["DSM_SMOKE_ENV_HELPER_DIR"])
from isolated_host_environment import isolated_host_environment
from isolated_host_process import process_group_guard

results = os.environ["DSM_SMOKE_RESULTS_DIR"]
delivery_root = os.environ["DSM_SMOKE_DELIVERY_ROOT"]
progress_path = os.path.join(results, "progress.log")
timeout = int(os.environ["DSM_SMOKE_TIMEOUT_SECONDS"])
if timeout < 60:
    raise SystemExit("DSM_SMOKE_TIMEOUT_SECONDS must be at least 60")
command = [
    os.environ["DSM_SMOKE_PI_BIN"], "--approve", "--print",
    "--extension", os.environ["DSM_SMOKE_SUBAGENTS_EXTENSION"],
    "--model", os.environ["DSM_SMOKE_ORCHESTRATOR_MODEL"],
    os.environ["DSM_SMOKE_ORCHESTRATOR_PROMPT"],
]
# Verification often invokes this script from another Pi session. Do not let
# inherited nested-agent/intercom markers make the isolated host suppress its
# own extension tools or attach to the caller's communication server.
child_env = isolated_host_environment(os.environ)

started = time.monotonic()
with open(os.path.join(results, "orchestrator.txt"), "w") as stdout, \
     open(os.path.join(results, "orchestrator.stderr.txt"), "w") as stderr, \
     open(progress_path, "w", buffering=1) as progress:
    process = subprocess.Popen(
        command,
        cwd=os.environ["DSM_SMOKE_PROJECT_DIR"],
        stdout=stdout,
        stderr=stderr,
        env=child_env,
        start_new_session=True,
    )
    def record_cleanup(pid):
        progress.write(f"CLEANUP terminating process group {pid}\n")

    with process_group_guard(process, on_cleanup=record_cleanup):
        while process.poll() is None:
            elapsed = int(time.monotonic() - started)
            artifacts = sorted(os.path.basename(path) for path in glob.glob(
                os.path.join(delivery_root, "**", "*.md"), recursive=True
            ))
            sessions = len(glob.glob(os.path.join(
                os.environ["PI_CODING_AGENT_DIR"], "sessions", "**", "*.jsonl"
            ), recursive=True))
            progress.write(
                f"{datetime.datetime.now(datetime.timezone.utc).isoformat()} "
                f"elapsed={elapsed}s sessions={sessions} artifacts={','.join(artifacts) or 'none'}\n"
            )
            if elapsed >= timeout:
                progress.write(f"TIMEOUT after {elapsed}s\n")
                raise SystemExit(124)
            time.sleep(5)
        if process.returncode:
            progress.write(f"EXIT code={process.returncode}\n")
            raise SystemExit(process.returncode)
        progress.write(f"PASS elapsed={int(time.monotonic() - started)}s\n")
PY
SMOKE_HOST_PID=$!
wait "$SMOKE_HOST_PID"
SMOKE_HOST_PID=
grep -Fq "DSM_DELIVERY_SMOKE_DONE" "$RESULTS_DIR/orchestrator.txt"

# Extract requested tool arguments and the corresponding child-session headers.
# This keeps both sides of launch evidence when an inherited model or configured
# thinking level, context mode, output path, or parallel entry fails on a future host.
export DSM_SMOKE_BUNDLED_LAUNCHES="$RESULTS_DIR/bundled-phase-launches.json"
export DSM_SMOKE_SESSIONS_DIR="$AGENT_DIR/sessions"
export DSM_SMOKE_SUBAGENT_METADATA_DIR="$PROJECT_DIR/.pi-subagents/artifacts"
python3 -B <<'PY'
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.environ["DSM_SMOKE_ENV_HELPER_DIR"])
from isolated_host_launch_evidence import resolve_child_session

sessions_root = Path(os.environ["DSM_SMOKE_SESSIONS_DIR"])
metadata_root = Path(os.environ["DSM_SMOKE_SUBAGENT_METADATA_DIR"])
results = Path(os.environ["DSM_SMOKE_RESULTS_DIR"])
with open(os.environ["DSM_SMOKE_BUNDLED_LAUNCHES"]) as handle:
    candidate = json.load(handle)["profiles"]["dsm-candidate"]
expected = []
for phase in ("IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO"):
    entries = candidate[phase] if isinstance(candidate[phase], list) else [candidate[phase]]
    expected.extend({"phase": phase, **entry} for entry in entries)

requested = []
transcripts = []
for transcript in sessions_root.rglob("*.jsonl"):
    records = []
    try:
        records = [json.loads(line) for line in transcript.read_text().splitlines() if line.strip()]
    except (OSError, json.JSONDecodeError):
        continue
    transcripts.append((transcript, records))
    for record in records:
        message = record.get("message", {})
        if message.get("role") != "assistant":
            continue
        for item in message.get("content", []):
            if item.get("type") != "toolCall" or item.get("name") != "subagent":
                continue
            args = item.get("arguments", {})
            # Parallel subagent calls carry launches under tasks[] with shared
            # context/concurrency fields on the outer arguments object.
            entries = args.get("tasks") if isinstance(args.get("tasks"), list) else [args]
            for entry in entries:
                launch = {**{key: args[key] for key in ("model", "thinking", "context", "cwd") if key in args}, **entry}
                if str(launch.get("agent", "")).startswith("dsm."):
                    requested.append({key: launch[key] for key in ("agent", "model", "thinking", "context", "cwd", "output") if key in launch})

if len(requested) != len(expected):
    raise SystemExit(f"expected {len(expected)} DSM launches, found {len(requested)}")
remaining = requested.copy()
for launch in expected:
    match = next((item for item in remaining if all(item.get(key) == value for key, value in launch.items() if key != "phase")), None)
    if match is None:
        raise SystemExit(f"bundled launch was not requested unchanged: {launch}")
    match["phase"] = launch["phase"]
    remaining.remove(match)
(results / "requested-launches.json").write_text(json.dumps(requested, indent=2) + "\n")

# Stable bundled thinking policy is agent-owned rather than relayed through the
# parent tool call. Confirm the child session applied each relevant default.
agent_thinking_defaults = {
    "dsm.verifier": "low",
    "dsm.closer": "low",
    "dsm.retrospective": "high",
}
actual = []
for launch in requested:
    output = launch.get("output")
    if not output:
        raise SystemExit(f"DSM launch has no output path: {launch}")
    try:
        transcript, records = resolve_child_session(metadata_root, sessions_root, launch["agent"], output)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    model = next((record for record in records if record.get("type") == "model_change"), {})
    thinking = next((record for record in records if record.get("type") == "thinking_level_change"), {})
    session = next((record for record in records if record.get("type") == "session"), {})
    evidence = {
        "phase": launch["phase"], "agent": launch["agent"], "context": "fresh",
        "output": output, "sessionFile": str(transcript), "cwd": session.get("cwd"),
        "provider": model.get("provider"), "modelId": model.get("modelId"),
        "thinking": thinking.get("thinkingLevel"),
    }
    actual_models = {evidence.get("modelId"), "/".join((evidence.get("provider") or "", evidence.get("modelId") or ""))}
    if launch.get("model") and launch["model"] not in actual_models:
        raise SystemExit(f"actual model did not match requested launch: {evidence}")
    expected_thinking = launch.get("thinking") or agent_thinking_defaults.get(launch["agent"])
    if expected_thinking and evidence.get("thinking") != expected_thinking:
        raise SystemExit(f"actual thinking did not match configured profile override or agent default: {evidence}")
    actual.append(evidence)
(results / "actual-launches.json").write_text(json.dumps(actual, indent=2) + "\n")
PY

# Preserve machine-checkable evidence that the workflow, rather than standalone
# role probes, launched every package role and produced every phase artifact.
roles=(implementer verifier reviewer closer retrospective)
for role in "${roles[@]}"; do
	grep -RFl --include='*.jsonl' "dsm.${role}" "$AGENT_DIR/sessions" > "$RESULTS_DIR/dsm.${role}.identity-files.txt"
	# One parent transcript records the planned launch and a separate child
	# transcript records execution, so each role must occur in at least two files.
	[[ "$(wc -l < "$RESULTS_DIR/dsm.${role}.identity-files.txt")" -ge 2 ]]
done
for stem in implementation verification review close retrospective; do
	find "$DELIVERY_ROOT" -type f -name "*${stem}*.md" -print > "$RESULTS_DIR/${stem}-artifacts.txt"
	[[ -s "$RESULTS_DIR/${stem}-artifacts.txt" ]]
done
find "$DELIVERY_ROOT" -type f -print | sort > "$RESULTS_DIR/artifact-manifest.txt"
git -C "$PROJECT_DIR" status --short > "$RESULTS_DIR/project-status.txt"
[[ ! -s "$RESULTS_DIR/project-status.txt" ]]
git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all > "$RESULTS_DIR/source-status-after.txt"
if ! cmp -s "$RESULTS_DIR/source-status-before.txt" "$RESULTS_DIR/source-status-after.txt"; then
	diff -u "$RESULTS_DIR/source-status-before.txt" "$RESULTS_DIR/source-status-after.txt" > "$RESULTS_DIR/source-status-diff.txt" || true
	echo "isolated host smoke mutated the source worktree; see $RESULTS_DIR/source-status-diff.txt" >&2
	exit 1
fi
# The evidence directory is intentionally retained for review, so credentials
# must live only in the temporary agent home removed by the EXIT/signal traps.
if find "$EVIDENCE_DIR" -type f \( -name 'auth.json' -o -name 'credentials.json' -o -name 'oauth.json' \) -print -quit | grep -q .; then
	echo "isolated host smoke found credential files in retained evidence" >&2
	exit 1
fi
printf 'PASS\nevidence=%s\norchestrator_model=%s\nprofile=dsm-candidate\nrequested_launches=%s\nactual_launches=%s\n' \
	"$EVIDENCE_DIR" "$MODEL" "$RESULTS_DIR/requested-launches.json" "$RESULTS_DIR/actual-launches.json" | tee "$RESULTS_DIR/summary.txt"
