import json
from pathlib import Path

PHASE_ORDER = ("IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO")
PASS_VERDICTS = {"PASS", "PASS_WITH_NON_BLOCKING_NOTES"}


def assert_effective_model(evidence: dict, expected_model: str) -> None:
    provider = evidence.get("provider") or ""
    model_id = evidence.get("modelId") or ""
    actual_models = {model_id, f"{provider}/{model_id}" if provider else model_id}
    if expected_model not in actual_models:
        raise ValueError(
            f"actual child model did not match DSM_SMOKE_MODEL={expected_model}: {evidence}"
        )


def _reported_phase(report: dict) -> str | None:
    candidates = [
        report.get("phase"),
        report.get("status"),
        report.get("state", {}).get("phase") if isinstance(report.get("state"), dict) else None,
        report.get("delivery", {}).get("phase") if isinstance(report.get("delivery"), dict) else None,
        report.get("delivery", {}).get("status") if isinstance(report.get("delivery"), dict) else None,
    ]
    phases = {value for value in candidates if isinstance(value, str)}
    if len(phases) != 1:
        raise ValueError(f"delivery report has no unambiguous authoritative phase/status: {sorted(phases)}")
    return phases.pop()


def _load_single_report(delivery_root: Path) -> tuple[Path, dict]:
    reports = sorted(delivery_root.rglob("delivery-report.json"))
    if len(reports) != 1:
        raise ValueError(f"expected exactly one authoritative delivery-report.json, found {len(reports)}")
    try:
        report = json.loads(reports[0].read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read authoritative delivery report {reports[0]}: {error}") from error
    if not isinstance(report, dict):
        raise ValueError(f"authoritative delivery report {reports[0]} is not an object")
    return reports[0], report


def assert_delivery_done(delivery_root: Path) -> dict:
    report_path, report = _load_single_report(delivery_root)
    phase = _reported_phase(report)
    if phase != "DONE":
        raise ValueError(f"authoritative delivery report is not DONE (phase/status={phase})")
    return {"report": str(report_path), "phase": phase}


def assert_delivery_failed_at(delivery_root: Path, fail_phase: str) -> dict:
    """Fault-injection expectation: the delivery stopped on a non-pass verdict.

    Confirms the recorded phase history shows the expected gate rejecting the
    deliberately broken candidate and no later phase ran. The failing phase
    artifact must exist and carry a ``RESULT: FAIL`` first line so the gate
    outcome comes from the independent child, not only the orchestrator.
    """
    if fail_phase not in PHASE_ORDER:
        raise ValueError(f"fail phase must be one of {PHASE_ORDER}: {fail_phase}")
    report_path, report = _load_single_report(delivery_root)
    phase = _reported_phase(report)
    if phase == "DONE":
        raise ValueError(f"delivery unexpectedly completed; expected a FAIL at {fail_phase}")
    history = report.get("history")
    if not isinstance(history, list):
        raise ValueError(f"delivery report {report_path} has no history list")
    phase_reports = [entry for entry in history if isinstance(entry, dict) and entry.get("event") == "report"]
    fail_entries = [entry for entry in phase_reports if entry.get("phase") == fail_phase]
    if not fail_entries:
        raise ValueError(f"no {fail_phase} report recorded in {report_path}")
    verdict = fail_entries[-1].get("verdict")
    if not isinstance(verdict, str) or verdict in PASS_VERDICTS:
        raise ValueError(f"{fail_phase} did not record a failing verdict: {verdict}")
    later_phases = PHASE_ORDER[PHASE_ORDER.index(fail_phase) + 1 :]
    later = [entry.get("phase") for entry in phase_reports if entry.get("phase") in later_phases]
    if later:
        raise ValueError(f"delivery advanced past {fail_phase}: later reports for {later}")
    artifact = fail_entries[-1].get("artifact")
    if not isinstance(artifact, str) or not artifact:
        raise ValueError(f"{fail_phase} report has no artifact path")
    try:
        first_line = Path(artifact).read_text().splitlines()[0].strip()
    except (OSError, IndexError) as error:
        raise ValueError(f"could not read {fail_phase} artifact {artifact}: {error}") from error
    if first_line != "RESULT: FAIL":
        raise ValueError(f"{fail_phase} artifact first line is not 'RESULT: FAIL': {first_line!r}")
    pending = report.get("pendingIssue")
    if isinstance(pending, dict) and pending.get("source") != fail_phase.lower():
        raise ValueError(f"pending issue source does not match {fail_phase}: {pending}")
    return {
        "report": str(report_path),
        "phase": phase,
        "failPhase": fail_phase,
        "failVerdict": verdict,
        "failArtifact": artifact,
    }
