# Documentation Index

Start here when planning or implementing changes in this repository.

## Read this first

1. Read `docs/principles.md` for repo-wide change standards.
2. Read the README for the extension/app you are changing.
3. Read any relevant plan or contract document listed below.
4. Keep this index current when docs are added, removed, renamed, or repurposed.

## Source of truth

- Change principles: `docs/principles.md`
- Structured delivery report contract: `docs/delivery-report-schema-v2.md`
- Delivery workflow extension docs: `extensions/delivery-state-machine/README.md`
- Session usage extension docs: `extensions/session-usage/README.md`
- Report viewer app docs: `apps/report-viewer/README.md`
- Design and implementation plans: `docs/plans/`

## Directory map

- `extensions/delivery-state-machine/` — Pi delivery orchestration extension, phase prompts, profile config, and tests.
- `extensions/session-usage/` — Pi session/subagent usage reporting extension and tests.
- `apps/report-viewer/` — local delivery report dashboard, migration helper, and route/API tests.
- `shared/` — dependency-light TypeScript helpers shared by extensions/apps.
- `docs/plans/` — scoped plans for completed or proposed feature work.

## File catalog

- `README.md` — project overview, install instructions, and development commands.
- `docs/principles.md` — concise engineering standards for validation, tests, readability, and modularity.
- `docs/delivery-report-schema-v2.md` — stable JSON report and project metadata contract shared by the delivery extension and report viewer.
- `docs/plans/delivery-profile-management.md` — delivery profile/model management plan.
- `docs/plans/report-viewer-and-structured-reports.md` — report viewer and structured report plan.
- `docs/plans/report-viewer-project-grouping.md` — project grouping behavior plan.
- `docs/plans/report-viewer-ui-improvements.md` — report viewer UI improvement plan.
- `extensions/delivery-state-machine/PLAN_QUALITY_CHECKLIST.md` — checklist embedded in the delivery workflow.
- `extensions/delivery-state-machine/README.md` — commands, state machine behavior, artifact layout, phase/profile config, and report summary behavior.
- `extensions/session-usage/README.md` — session/subagent usage data source, fields, token policy, and limitations.
- `apps/report-viewer/README.md` — running/configuring the viewer, routes, behavior, and safety gates.

## How to add or update docs

- Add feature plans under `docs/plans/` unless another location is clearly more specific.
- Put stable cross-component contracts in `docs/` and link from feature READMEs.
- Keep broad standards in `docs/principles.md`; avoid copying them into every README.
- Update this index whenever documentation structure changes.
