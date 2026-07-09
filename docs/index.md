# Documentation Index

Start here when planning or implementing changes in this repository.

## Read this first

1. Read `docs/principles.md` for repo-wide change standards.
2. Read the README for the extension/app you are changing.
3. Read any relevant stable contract document listed below.
4. Keep this index current when root documentation changes.

## Root documentation

- `docs/principles.md` — concise engineering standards for validation, tests, readability, and modularity.
- `docs/delivery-report-schema-v2.md` — stable JSON report and project metadata contract shared by the delivery extension and report viewer.

## Component documentation

- `extensions/delivery-state-machine/README.md` — commands, state machine behavior, artifact layout, phase/profile config, and report summary behavior.
- `extensions/delivery-state-machine/docs/index.md` — extension-specific guides, including user-space overrides.
- `extensions/session-usage/README.md` — session/subagent usage data source, fields, token policy, and limitations.
- `extensions/git-cleanup/README.md` — `/cleanup` post-merge worktree housekeeping command.
- `apps/report-viewer/README.md` — running/configuring the viewer, routes, behavior, and safety gates.

## Directory map

- `extensions/delivery-state-machine/` — Pi delivery orchestration extension, phase prompts, profile config, docs, and tests.
- `extensions/session-usage/` — Pi session/subagent usage reporting extension and tests.
- `extensions/git-cleanup/` — Pi command for post-merge git worktree cleanup.
- `apps/report-viewer/` — local delivery report dashboard, migration helper, and route/API tests.
- `shared/` — dependency-light TypeScript helpers shared by extensions/apps.

## How to add or update docs

- Put stable cross-component contracts in `docs/`.
- Put extension/app-specific guides next to that component, usually under its README or `docs/` subdirectory.
- Remove completed implementation plans after their durable behavior is captured in README/guide/contract docs.
- Keep broad standards in `docs/principles.md`; avoid copying them into every README.
