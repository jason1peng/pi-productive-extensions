import json
from pathlib import Path


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


def assert_delivery_done(delivery_root: Path) -> dict:
    reports = sorted(delivery_root.rglob("delivery-report.json"))
    if len(reports) != 1:
        raise ValueError(f"expected exactly one authoritative delivery-report.json, found {len(reports)}")
    try:
        report = json.loads(reports[0].read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read authoritative delivery report {reports[0]}: {error}") from error
    if not isinstance(report, dict):
        raise ValueError(f"authoritative delivery report {reports[0]} is not an object")
    phase = _reported_phase(report)
    if phase != "DONE":
        raise ValueError(f"authoritative delivery report is not DONE (phase/status={phase})")
    return {"report": str(reports[0]), "phase": phase}
