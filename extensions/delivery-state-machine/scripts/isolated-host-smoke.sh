#!/usr/bin/env bash
set -euo pipefail

# Opt-in, model-backed Stage 6 smoke. It intentionally is not part of npm run verify.
#
# Env knobs:
#   PI_DELIVERY_PROFILE         profile under test (default: default)
#   DSM_SMOKE_PROFILE_CONFIG    launch-config JSON path, `package`, or `host`; absent
#                               uses host config when PI_DELIVERY_PROFILE is set,
#                               otherwise the smoke package's phase-launches.json
#   DSM_SMOKE_AGENT_SOURCE_DIR  optional user-agent directory to stage in the
#                               isolated host for non-packaged profiles
#   DSM_SMOKE_MODEL             orchestrator model (default openai-codex/gpt-5.6-luna)
#   DSM_SMOKE_CHILD_MODEL       fallback model for profile launches without an explicit
#                               model (default: DSM_SMOKE_MODEL)
#   DSM_SMOKE_EXTRA_PACKAGES    space-separated extra package paths for the isolated
#                               host settings (e.g. a provider plugin the model needs)
#   DSM_SMOKE_PROMPT_FILE       orchestrator prompt override (default: embedded happy path)
#   DSM_SMOKE_EXPOSE_CHILD_PROMPTS 1 (default) exposes canonical prompts for hash evidence; 0 measures pointer-only production responses
#   DSM_SMOKE_EXPECT             DONE (default) or STOPPED (fault-injection run)
#   DSM_SMOKE_EXPECT_FAIL_PHASE  VERIFY or REVIEW; required when EXPECT=STOPPED
REPO_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PI_BIN=${PI_BIN:-pi}
PROFILE_ENV_SET=${PI_DELIVERY_PROFILE+x}
PROFILE=${PI_DELIVERY_PROFILE:-default}
PROFILE_CONFIG_REQUEST=${DSM_SMOKE_PROFILE_CONFIG:-}
AGENT_SOURCE_DIR=${DSM_SMOKE_AGENT_SOURCE_DIR:-}
MODEL=${DSM_SMOKE_MODEL:-openai-codex/gpt-5.6-luna}
CHILD_MODEL=${DSM_SMOKE_CHILD_MODEL:-$MODEL}
EXTRA_PACKAGES=${DSM_SMOKE_EXTRA_PACKAGES:-}
PROMPT_FILE=${DSM_SMOKE_PROMPT_FILE:-}
EXPECT=${DSM_SMOKE_EXPECT:-DONE}
EXPOSE_CHILD_PROMPTS=${DSM_SMOKE_EXPOSE_CHILD_PROMPTS:-1}
EXPECT_FAIL_PHASE=${DSM_SMOKE_EXPECT_FAIL_PHASE:-}
SUBAGENTS_ROOT=${PI_SUBAGENTS_ROOT:-${HOME}/.pi/agent/npm/node_modules/pi-subagents}
EVIDENCE_DIR=${DSM_SMOKE_EVIDENCE_DIR:-$(mktemp -d "/tmp/dsm-isolated-host-smoke.XXXXXX")}
TIMEOUT_SECONDS=${DSM_SMOKE_TIMEOUT_SECONDS:-720}
TEMP_AGENT_ROOT=$(mktemp -d "/tmp/dsm-isolated-host-agent.XXXXXX")
AGENT_DIR="$TEMP_AGENT_ROOT/agent"
PROJECT_DIR="$EVIDENCE_DIR/project"
RESULTS_DIR="$EVIDENCE_DIR/results"
PACKAGE_DIR="$EVIDENCE_DIR/package"
DELIVERY_ROOT="$RESULTS_DIR/delivery-artifacts"

case "$EXPOSE_CHILD_PROMPTS" in
	0 | 1) ;;
	*)
		echo "DSM_SMOKE_EXPOSE_CHILD_PROMPTS must be 0 or 1" >&2
		exit 2
		;;
esac
case "$EXPECT" in
	DONE) ;;
	STOPPED)
		case "$EXPECT_FAIL_PHASE" in
			VERIFY | REVIEW) ;;
			*)
				echo "DSM_SMOKE_EXPECT_FAIL_PHASE must be VERIFY or REVIEW when DSM_SMOKE_EXPECT=STOPPED" >&2
				exit 2
				;;
		esac
		;;
	*)
		echo "DSM_SMOKE_EXPECT must be DONE or STOPPED" >&2
		exit 2
		;;
esac
# Phases the delivery is expected to reach; a fault-injection run stops on the
# injected failure, so later phases must not launch or produce artifacts.
if [[ "$EXPECT" == "DONE" ]]; then
	EXPECTED_PHASES="IMPLEMENT VERIFY REVIEW CLOSE RETRO"
	EXPECTED_STEMS=(implementation verification review close retrospective)
elif [[ "$EXPECT_FAIL_PHASE" == "VERIFY" ]]; then
	EXPECTED_PHASES="IMPLEMENT VERIFY"
	EXPECTED_STEMS=(implementation verification)
else
	EXPECTED_PHASES="IMPLEMENT VERIFY REVIEW"
	EXPECTED_STEMS=(implementation verification review)
fi

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
# Keep the isolated host's agent namespace scoped to the selected profile. The
# package also ships dsm.* compatibility agents; leaving those alongside the
# generic default reviewer/worker makes pi-subagents reject an unqualified
# default launch as ambiguous (for example reviewer vs dsm.reviewer).
if [[ "$PROFILE" != "dsm-candidate" ]]; then
	rm -f "$PACKAGE_DIR/extensions/delivery-state-machine/agents/dsm/"*.md
fi
mkdir "$PACKAGE_DIR/.git"
if [[ -f "${HOME}/.pi/agent/auth.json" ]]; then
	cp "${HOME}/.pi/agent/auth.json" "$AGENT_DIR/auth.json"
fi

# The isolated host uses the candidate package launch config by default so
# smoke results are reproducible. A caller can explicitly provide a host/custom
# launch config when evaluating a user-owned profile.
# `package` selects the package config explicitly; `host` selects the user's
# phase-launches.json.
BUNDLED_PHASE_CONFIG="$PACKAGE_DIR/extensions/delivery-state-machine/phase-launches.json"
HOST_PHASE_CONFIG="$HOME/.pi/agent/extensions/delivery-state-machine/phase-launches.json"
if [[ "$PROFILE_CONFIG_REQUEST" == "package" ]]; then
	PROFILE_CONFIG_SOURCE="$BUNDLED_PHASE_CONFIG"
elif [[ "$PROFILE_CONFIG_REQUEST" == "host" || ( -z "$PROFILE_CONFIG_REQUEST" && -n "$PROFILE_ENV_SET" ) ]]; then
	PROFILE_CONFIG_SOURCE="$HOST_PHASE_CONFIG"
elif [[ -z "$PROFILE_CONFIG_REQUEST" ]]; then
	PROFILE_CONFIG_SOURCE="$BUNDLED_PHASE_CONFIG"
else
	PROFILE_CONFIG_SOURCE="$PROFILE_CONFIG_REQUEST"
fi
if [[ ! -f "$PROFILE_CONFIG_SOURCE" ]]; then
	echo "profile launch config not found: $PROFILE_CONFIG_SOURCE" >&2
	exit 2
fi
mkdir -p "$AGENT_DIR/extensions/delivery-state-machine"
cp "$PROFILE_CONFIG_SOURCE" "$AGENT_DIR/extensions/delivery-state-machine/phase-launches.json"
cp "$PROFILE_CONFIG_SOURCE" "$RESULTS_DIR/selected-phase-launches.json"

# Resolve the selected profile once so settings, discovery, and post-run
# evidence all use the same expected launch set and model allowlist.
PROFILE_MODELS_JSON=$(python3 -B - "$PROFILE_CONFIG_SOURCE" "$PROFILE" "$EXPECTED_PHASES" \
	"$RESULTS_DIR/profile-expectations.json" "$RESULTS_DIR/profile-agents.txt" \
	"$MODEL" "$CHILD_MODEL" <<'PY'
import json
import sys
from pathlib import Path

config_path, profile, expected_phase_text, expectations_path, agents_path, outer_model, child_model = sys.argv[1:]
config = json.loads(Path(config_path).read_text())
profiles = config.get("profiles")
if not isinstance(profiles, dict) or profile not in profiles:
    raise SystemExit(f"profile {profile!r} is not present in {config_path}")
expected_phases = set(expected_phase_text.split())
expected = []
agent_names = []
models = []
for phase in ("IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO"):
    if phase not in expected_phases:
        continue
    raw = profiles[profile].get(phase)
    if raw is None:
        raise SystemExit(f"profile {profile!r} has no {phase} launch")
    entries = raw if isinstance(raw, list) else [raw]
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("agent"), str):
            raise SystemExit(f"profile {profile!r} has invalid {phase} launch: {entry!r}")
        launch = {"phase": phase, **entry}
        expected.append(launch)
        agent_names.append(entry["agent"])
        if isinstance(entry.get("model"), str) and entry["model"] not in models:
            models.append(entry["model"])
for model in (outer_model, child_model):
    if model and model not in models:
        models.append(model)
Path(expectations_path).write_text(json.dumps({
    "profile": profile,
    "config": config_path,
    "expected": expected,
    "agents": agent_names,
    "models": models,
}, indent=2) + "\n")
Path(agents_path).write_text("\n".join(dict.fromkeys(agent_names)) + "\n")
print(json.dumps(models))
PY
)

# Stage only the selected profile's user agent definitions. Builtins and
# packaged dsm.* agents remain discovered from their normal scopes; the staged
# files make default/private-project smoke runs match the real user stack.
mkdir -p "$AGENT_DIR/agents"
: > "$RESULTS_DIR/profile-agent-sources.txt"
if [[ -n "$AGENT_SOURCE_DIR" ]]; then
	AGENT_SOURCE_DIRS=("$AGENT_SOURCE_DIR")
else
	AGENT_SOURCE_DIRS=("$HOME/.pi/agent/agents" "$HOME/.agents")
fi
BUILTIN_AGENT_NAMES=" advisor context-builder delegate oracle planner researcher reviewer scout worker "
while IFS= read -r agent; do
	[[ -z "$agent" ]] && continue
	case "$agent" in
		dsm.*)
			printf '%s\tpackage\n' "$agent" >> "$RESULTS_DIR/profile-agent-sources.txt"
			continue
			;;
	esac
	copied=
	for source_dir in "${AGENT_SOURCE_DIRS[@]}"; do
		candidate="$source_dir/$agent.md"
		if [[ -f "$candidate" ]]; then
			cp "$candidate" "$AGENT_DIR/agents/$agent.md"
			# The isolated host intentionally has no web-provider extension. Keep
			# the selected profile launch unchanged, but make the bundled verifier
			# executable in this bounded smoke by restricting its optional tools to
			# the host-native read/bash pair.
			if [[ "$agent" == "fresh-verifier" ]]; then
				sed -i.bak -E 's/^tools:.*/tools: read, bash/' "$AGENT_DIR/agents/$agent.md"
				rm -f "$AGENT_DIR/agents/$agent.md.bak"
			fi
			printf '%s\t%s\n' "$agent" "$candidate" >> "$RESULTS_DIR/profile-agent-sources.txt"
			copied=1
			break
		fi
	done
	if [[ -z "$copied" && "$agent" == "fresh-verifier" && -f "$PACKAGE_DIR/extensions/delivery-state-machine/agents/fresh-verifier.md" ]]; then
		cp "$PACKAGE_DIR/extensions/delivery-state-machine/agents/fresh-verifier.md" "$AGENT_DIR/agents/fresh-verifier.md"
		printf '%s\t%s\n' "$agent" "$PACKAGE_DIR/extensions/delivery-state-machine/agents/fresh-verifier.md" >> "$RESULTS_DIR/profile-agent-sources.txt"
		copied=1
	fi
	if [[ -z "$copied" && "$BUILTIN_AGENT_NAMES" != *" $agent "* ]]; then
		echo "selected profile requires agent $agent, but no staged definition was found" >&2
		exit 2
	fi
	if [[ -z "$copied" ]]; then
		printf '%s\tbuiltin\n' "$agent" >> "$RESULTS_DIR/profile-agent-sources.txt"
	fi
done < "$RESULTS_DIR/profile-agents.txt"

# Extra packages are absolute paths (e.g. a provider plugin such as
# pi-clinepass-provider) that the isolated host cannot resolve via npm: names.
PACKAGES_JSON=$(python3 -c 'import json, sys; print(json.dumps([p for p in sys.argv[1:] if p]))' \
	"$SUBAGENTS_ROOT" "$PACKAGE_DIR" $EXTRA_PACKAGES)
cat > "$AGENT_DIR/settings.json" <<JSON
{
  "defaultModel": "$MODEL",
  "enabledModels": $PROFILE_MODELS_JSON,
  "subagents": {
    "defaultModel": "$CHILD_MODEL"
  },
  "packages": $PACKAGES_JSON
}
JSON

# The fixture project remains clean; profile agent definitions are intentional
# isolated-host inputs, not project-local agent injection.
git -C "$PROJECT_DIR" init -q -b main
printf '# Isolated DSM host smoke\n' > "$PROJECT_DIR/README.md"
printf '.pi-subagents/\n' > "$PROJECT_DIR/.gitignore"
git -C "$PROJECT_DIR" add README.md .gitignore
git -C "$PROJECT_DIR" -c user.name=Smoke -c user.email=smoke@example.invalid commit -qm init
git -C "$PROJECT_DIR" config user.name Smoke
git -C "$PROJECT_DIR" config user.email smoke@example.invalid
if find "$PROJECT_DIR" -type f \( -path '*/agents/*.md' -o -path '*/.agents/*.md' \) | grep -q .; then
	echo "unexpected project agent definition in isolated smoke fixture" >&2
	exit 1
fi

PI_CODING_AGENT_DIR="$AGENT_DIR" NODE_PATH=${NODE_PATH:-${HOME}/.pi/agent/npm/node_modules} bun --eval '
import { pathToFileURL } from "node:url";
const modulePath = process.argv[1];
const cwd = process.argv[2];
const output = process.argv[3];
const expectations = JSON.parse(await Bun.file(process.argv[4]).text());
const { discoverAgentsAll } = await import(pathToFileURL(modulePath).href);
const discovered = discoverAgentsAll(cwd);
const all = [...discovered.builtin, ...discovered.package, ...discovered.user, ...discovered.project];
const selected = all
  .filter((agent) => expectations.agents.includes(agent.name))
  .map((agent) => ({ name: agent.name, source: agent.source, packageName: agent.packageName }))
  .sort((a, b) => `${a.name}:${a.source}`.localeCompare(`${b.name}:${b.source}`));
await Bun.write(output, JSON.stringify({ profile: expectations.profile, expectedAgents: expectations.agents, selected }, null, 2) + "\n");
for (const name of new Set(expectations.agents)) {
  if (!selected.some((agent) => agent.name === name)) process.exit(1);
  if (name.startsWith("dsm.") && !selected.some((agent) => agent.name === name && agent.source === "package" && agent.packageName === "dsm")) process.exit(1);
}
' "$SUBAGENTS_ROOT/src/agents/agents.ts" "$PACKAGE_DIR" "$RESULTS_DIR/discovery.json" "$RESULTS_DIR/profile-expectations.json"

if [[ -n "$PROMPT_FILE" ]]; then
	cp "$PROMPT_FILE" "$RESULTS_DIR/orchestrator-prompt.txt"
else
	cat > "$RESULTS_DIR/orchestrator-prompt.txt" <<PROMPT
Run one complete representative delivery using the delivery-state-machine tools and the configured ${PROFILE} profile. The task is: "Verify the committed README accurately identifies this as an isolated DSM host smoke; no source change is expected."

Use this exact bounded loop:
1. Call delivery_start once with every maxRounds value set to 1.
2. Call delivery_next once for the current phase.
3. Call the subagent tool synchronously. For a single launch, pass the exact details.next.launchRef as the task field; for parallel launches, pass each exact details.next.parallel[].launchRef as the corresponding task field. Do not copy or reconstruct the long childPrompt; DSM resolves the canonical prompt and all launch settings before execution. Keep the launch references one-to-one and in the planned phase/attempt. Do not add or substitute model fields, collapse parallel launches, investigate alternatives, or retry a launch.
4. Read every resulting artifact, then call delivery_report with its phase and aggregate verdict.
5. Repeat steps 2-4 through IMPLEMENT, VERIFY, REVIEW, CLOSE, and RETRO. If a phase does not pass, report the real result and stop rather than attempting repair.
6. Call delivery_status. End with exactly DSM_DELIVERY_SMOKE_DONE only when status is DONE.

Never create a worktree or replace a requested child with your own work. Do not inspect pi-subagents implementation or skills, skip/simulate a child launch, push, create a branch, create an MR, or make source changes. This clean fixture needs only the phase-specific checks requested by each child prompt. The outer harness owns the overall timeout.
PROMPT
fi

# Run the quota-backed workflow under an internal deadline shorter than the
# external verification window. progress.log is updated while Pi is running so
# a failure identifies the last produced artifact/session instead of appearing
# as an uninstrumented hang. Python is used for portable process-group cleanup
# because macOS does not ship the GNU timeout command.
export PI_CODING_AGENT_DIR="$AGENT_DIR"
export PI_DELIVERY_PROFILE="$PROFILE"
export PI_DELIVERY_ARTIFACT_ROOT="$DELIVERY_ROOT"
export DSM_SMOKE_PI_BIN="$PI_BIN"
export DSM_SMOKE_PROJECT_DIR="$PROJECT_DIR"
export DSM_SMOKE_RESULTS_DIR="$RESULTS_DIR"
export DSM_SMOKE_DELIVERY_ROOT="$DELIVERY_ROOT"
export DSM_SMOKE_ORCHESTRATOR_PROMPT="$(cat "$RESULTS_DIR/orchestrator-prompt.txt")"
export DSM_SMOKE_ORCHESTRATOR_MODEL="$MODEL"
export DSM_SMOKE_TIMEOUT_SECONDS="$TIMEOUT_SECONDS"
export DSM_SMOKE_ENV_HELPER_DIR="$REPO_ROOT/extensions/delivery-state-machine/scripts"
# The smoke evidence parser can hash canonical prompts in opt-in mode; pointer-only
# mode validates that the launch hook restores them without exposing them upstream.
export DSM_SMOKE_EXPOSE_CHILD_PROMPTS="$EXPOSE_CHILD_PROMPTS"
export DSM_SMOKE_EXPECT="$EXPECT"
export DSM_SMOKE_EXPECT_FAIL_PHASE="$EXPECT_FAIL_PHASE"
export DSM_SMOKE_EXPECTED_PHASES="$EXPECTED_PHASES"
export DSM_SMOKE_PROFILE="$PROFILE"
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

# Opt-in: retain orchestrator + child session transcripts in the evidence dir so
# scripts/measure-delivery-tokens.py can measure delivery tool-response bytes.
# Transcripts carry no credential files; the temporary agent home (with
# auth.json) is still removed by the EXIT trap.
if [[ "${DSM_SMOKE_KEEP_SESSIONS:-0}" == "1" ]]; then
	cp -R "$AGENT_DIR/sessions" "$RESULTS_DIR/sessions"
fi

# Extract requested tool arguments and the corresponding child-session headers.
# This keeps both sides of launch evidence when an inherited model or configured
# thinking level, context mode, output path, or parallel entry fails on a future host.
export DSM_SMOKE_BUNDLED_LAUNCHES="$RESULTS_DIR/selected-phase-launches.json"
export DSM_SMOKE_EXPECTATIONS="$RESULTS_DIR/profile-expectations.json"
export DSM_SMOKE_EXPECTED_MODEL="$CHILD_MODEL"
export DSM_SMOKE_SESSIONS_DIR="$AGENT_DIR/sessions"
export DSM_SMOKE_SUBAGENT_METADATA_DIR="$PROJECT_DIR/.pi-subagents/artifacts"
python3 -B <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.environ["DSM_SMOKE_ENV_HELPER_DIR"])
from isolated_host_launch_evidence import resolve_child_session
from isolated_host_smoke_evidence import (
    assert_delivery_done,
    assert_delivery_failed_at,
    assert_effective_model,
)

sessions_root = Path(os.environ["DSM_SMOKE_SESSIONS_DIR"])
metadata_root = Path(os.environ["DSM_SMOKE_SUBAGENT_METADATA_DIR"])
results = Path(os.environ["DSM_SMOKE_RESULTS_DIR"])
expected_outcome = os.environ.get("DSM_SMOKE_EXPECT", "DONE")
if expected_outcome == "STOPPED":
    completion = assert_delivery_failed_at(
        Path(os.environ["DSM_SMOKE_DELIVERY_ROOT"]), os.environ["DSM_SMOKE_EXPECT_FAIL_PHASE"]
    )
else:
    completion = assert_delivery_done(Path(os.environ["DSM_SMOKE_DELIVERY_ROOT"]))
(results / "completion-state.json").write_text(json.dumps(completion, indent=2) + "\n")
with open(os.environ["DSM_SMOKE_EXPECTATIONS"]) as handle:
    expectations = json.load(handle)
expected = expectations["expected"]
expected_agents = set(expectations["agents"])

requested = []
transcripts = []
for transcript in sessions_root.rglob("*.jsonl"):
    records = []
    try:
        records = [json.loads(line) for line in transcript.read_text().splitlines() if line.strip()]
    except (OSError, json.JSONDecodeError):
        continue
    transcripts.append((transcript, records))
    # Rejected/blocked tool calls never spawned a child, so they must not count
    # as launches. Collect their ids before joining the ordered plans below.
    rejected_call_ids = set()
    for record in records:
        message = record.get("message", {})
        if message.get("role") != "toolResult":
            continue
        text = "".join(item.get("text", "") for item in message.get("content", []) if isinstance(item, dict))
        if text.startswith(("Rejected:", "Delivery launch blocked:")):
            call_id = message.get("toolCallId")
            if call_id:
                rejected_call_ids.add(call_id)

    planned = []
    for record in records:
        message = record.get("message", {})
        if message.get("role") == "toolResult":
            if message.get("toolName") in {"delivery_start", "delivery_next"}:
                details = message.get("details")
                next_action = details.get("next") if isinstance(details, dict) else None
                if isinstance(next_action, dict):
                    planned = next_action.get("parallel") if isinstance(next_action.get("parallel"), list) else [next_action]
            continue
        if message.get("role") != "assistant":
            continue
        for item in message.get("content", []):
            if item.get("type") != "toolCall" or item.get("name") != "subagent":
                continue
            if item.get("id") in rejected_call_ids:
                continue
            args = item.get("arguments", {})
            # Parallel subagent calls carry launches under tasks[] with shared
            # context/concurrency fields on the outer arguments object.
            entries = args.get("tasks") if isinstance(args.get("tasks"), list) else [args]
            for entry in entries:
                launch = {**{key: args[key] for key in ("model", "thinking", "context", "cwd") if key in args}, **entry}
                if str(launch.get("agent", "")) not in expected_agents:
                    continue
                output = launch.get("output")
                task = launch.get("task")
                launch_ref = task if isinstance(task, str) and task.startswith("DSM_LAUNCH_REF:") else None
                plan = next((candidate for candidate in planned if launch_ref and candidate.get("launchRef") == launch_ref), None)
                if plan is None:
                    plan = next((candidate for candidate in planned if output and candidate.get("output") == output), None)
                if plan is None and len(planned) == 1 and launch.get("agent") == planned[0].get("agent"):
                    plan = planned[0]
                if plan is None:
                    raise SystemExit(f"profile launch has no matching delivery_next plan: {launch}")
                child_prompt = plan.get("childPrompt")
                if launch_ref:
                    if plan.get("launchRef") != launch_ref:
                        raise SystemExit(f"launch reference did not match delivery_next for {launch.get('agent')}: {launch_ref}")
                    # The DSM tool_call hook resolves this short reference to the
                    # canonical launch before execution. Record the resolved fields
                    # rather than requiring the LLM to duplicate the long prompt.
                    for key in ("agent", "model", "thinking", "context", "output"):
                        if key in plan:
                            launch[key] = plan[key]
                    launch["cwd"] = os.environ["DSM_SMOKE_PROJECT_DIR"]
                    launch["_launchRef"] = launch_ref
                elif not isinstance(task, str) or task != child_prompt:
                    raise SystemExit(
                        f"child prompt was not forwarded verbatim for {launch.get('agent')}: "
                        f"taskSha256={hashlib.sha256(task.encode()).hexdigest() if isinstance(task, str) else 'missing'} "
                        f"plannedSha256={hashlib.sha256(child_prompt.encode()).hexdigest() if isinstance(child_prompt, str) else 'missing'}"
                    )
                if plan.get("output") and launch.get("output") != plan["output"]:
                    raise SystemExit(f"child output path did not match delivery_next for {launch.get('agent')}: {launch.get('output')}")
                if launch_ref:
                    if isinstance(child_prompt, str):
                        launch["_resolvedPromptSha256"] = hashlib.sha256(child_prompt.encode()).hexdigest()
                else:
                    if isinstance(task, str):
                        launch["_taskSha256"] = hashlib.sha256(task.encode()).hexdigest()
                    if isinstance(child_prompt, str):
                        launch["_plannedPromptSha256"] = hashlib.sha256(child_prompt.encode()).hexdigest()
                launch["_promptForwarded"] = True
                requested.append({key: launch[key] for key in ("agent", "model", "thinking", "context", "cwd", "output", "_launchRef", "_taskSha256", "_plannedPromptSha256", "_resolvedPromptSha256", "_promptForwarded") if key in launch})

if len(requested) != len(expected):
    raise SystemExit(f"expected {len(expected)} {expectations['profile']} launches, found {len(requested)}")
remaining = requested.copy()
for launch in expected:
    match = next((item for item in remaining if all(item.get(key) == value for key, value in launch.items() if key != "phase")), None)
    if match is None:
        raise SystemExit(f"selected-profile launch was not requested unchanged: {launch}")
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
    expected_model = launch.get("model") or os.environ["DSM_SMOKE_EXPECTED_MODEL"]
    try:
        assert_effective_model(evidence, expected_model)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    expected_thinking = launch.get("thinking") or agent_thinking_defaults.get(launch["agent"])
    if expected_thinking and evidence.get("thinking") != expected_thinking:
        raise SystemExit(f"actual thinking did not match configured profile override or agent default: {evidence}")
    actual.append(evidence)
(results / "actual-launches.json").write_text(json.dumps(actual, indent=2) + "\n")
PY

# Preserve machine-checkable evidence that the workflow, rather than standalone
# role probes, launched every expected profile agent and produced every expected
# phase artifact. Fault-injection runs expect only the phases up to the failure.
while IFS= read -r agent; do
	[[ -z "$agent" ]] && continue
	safe_agent=$(printf '%s' "$agent" | tr '/.' '__')
	identity_file="$RESULTS_DIR/${safe_agent}.identity-files.txt"
	grep -RFl --include='*.jsonl' "$agent" "$AGENT_DIR/sessions" > "$identity_file" || true
	# One parent transcript records the planned launch and a separate child
	# transcript records execution, so each agent must occur in at least two files.
	[[ "$(wc -l < "$identity_file")" -ge 2 ]]
done < "$RESULTS_DIR/profile-agents.txt"
for stem in "${EXPECTED_STEMS[@]}"; do
	find "$DELIVERY_ROOT" -type f -name "*${stem}*.md" -print > "$RESULTS_DIR/${stem}-artifacts.txt"
	[[ -s "$RESULTS_DIR/${stem}-artifacts.txt" ]]
done
find "$DELIVERY_ROOT" -type f -print | sort > "$RESULTS_DIR/artifact-manifest.txt"
git -C "$PROJECT_DIR" status --short > "$RESULTS_DIR/project-status.txt"
# Fault-injection tasks intentionally change the fixture, so only the happy
# path asserts the project stayed clean.
if [[ "$EXPECT" == "DONE" ]]; then
	[[ ! -s "$RESULTS_DIR/project-status.txt" ]]
fi
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
printf 'PASS\nevidence=%s\norchestrator_model=%s\nprofile=%s\nprofile_config=%s\nfallback_child_model=%s\nexpect=%s\nrequested_launches=%s\nactual_launches=%s\n' \
	"$EVIDENCE_DIR" "$MODEL" "$PROFILE" "$PROFILE_CONFIG_SOURCE" "$CHILD_MODEL" "$EXPECT" "$RESULTS_DIR/requested-launches.json" "$RESULTS_DIR/actual-launches.json" | tee "$RESULTS_DIR/summary.txt"
