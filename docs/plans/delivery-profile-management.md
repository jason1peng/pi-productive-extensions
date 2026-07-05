# Delivery Profile Management Plan

## Goal

Add named delivery launch profiles and a report-viewer profile selector so users can switch model setup without editing JSON by hand. Profile selection and profile definitions are **global-only** for this implementation. Project metadata and project-grouped report folders are still introduced for report organization and future features, but not for project-level model/profile configuration.

## Implementation status

Status: **Complete** as of PR #13, with one small follow-up PR #14 opened for profile setup display polish.

| Area | Status | PR | Notes |
|---|---|---|---|
| Checkpoint 1: Global profile resolver | Done | #11 | Global/built-in profile-only launch config, active profile/env override, and delivery-start profile pinning. |
| Checkpoint 2: Project report layout, schema v2, viewer scan | Done | #12 | Project-scoped report layout, `project.json`, schemaVersion 2 report metadata, nested viewer scan/routing. |
| Legacy flat report migration helper | Done | #12 | Implemented in Checkpoint 2 after verification required an upgrade path before removing flat-layout scanning. Existing local reports were copied into project layout on 2026-07-05. |
| Checkpoint 3: Viewer global profile selector | Done | #13 | Global profile API/UI, CSRF-protected active-profile writes, env override display, built-in/global profile handling. |
| Profile setup display polish | Open | #14 | Shows selected profile per-phase agent/model/thinking/context in the report viewer. |

## Current context

- Delivery launch settings previously came from `phase-launches.json` layered as built-in, user/global, then project-local; this plan intentionally removes project-local launch/profile overrides to make global model setup the single source of truth.
- Delivery artifacts are stored globally under `~/.pi/delivery-run` by default.
- The report viewer scans global report roots and already reads structured `delivery-report.json` with legacy Markdown fallback.
- The viewer does not currently know all projects except through report data.

## Design principles

- Keep the delivery state machine as the source of truth for effective launch resolution.
- Make global delivery profile config the single source of truth for model setup.
- Keep the report viewer as a UI for declarative global config, not a hidden runtime orchestrator.
- Use profile-based global `phase-launches.json` only. Remove legacy non-profile launch config support and project-local `phase-launches.json` override support for launch/model setup.
- Do not keep long-term dual support for the old flat delivery report folder layout; prefer a one-time migration path into the project-aware layout.
- Do not add quota-aware behavior in this pass.

## Proposed config model

### Global profile definitions

Global profile definitions live under the resolved pi agent dir, defaulting to:

```text
~/.pi/agent/extensions/delivery-state-machine/phase-launches.json
```

If `PI_CODING_AGENT_DIR` is set, resolve the file under that agent dir instead of hardcoding `~/.pi/agent`.

Use only the profile-aware shape:

```json
{
  "defaultProfile": "premium",
  "profiles": {
    "premium": {
      "IMPLEMENT": { "agent": "worker", "model": "anthropic/claude-sonnet-4" },
      "VERIFY": { "agent": "fresh-verifier", "model": "openai/gpt-5.5", "context": "fresh" },
      "REVIEW": { "agent": "reviewer", "model": "anthropic/claude-sonnet-4" },
      "CLOSE": { "agent": "worker" },
      "RETRO": { "agent": "worker" }
    },
    "quota-saving": {
      "IMPLEMENT": { "agent": "worker", "model": "openai/gpt-5-mini" },
      "VERIFY": { "agent": "fresh-verifier", "model": "openai/gpt-5-mini", "context": "fresh" },
      "REVIEW": { "agent": "reviewer", "model": "openai/gpt-5-mini" },
      "CLOSE": { "agent": "worker", "model": "openai/gpt-5-mini" },
      "RETRO": { "agent": "worker", "model": "openai/gpt-5-mini" }
    }
  }
}
```

A profile value uses the same phase launch schema as the current `phase-launches.json`, including arrays for parallel phase launches.

Each profile must define every runnable phase: `IMPLEMENT`, `VERIFY`, `REVIEW`, `CLOSE`, and `RETRO`. This avoids per-phase merge semantics between profiles and keeps model setup easy to reason about. Missing phases are config errors.

### Active profile file

Viewer-editable global selection:

```text
~/.pi/agent/extensions/delivery-state-machine/active-profile.json
```

```json
{
  "activeProfile": "quota-saving"
}
```

No project-level active profile file is introduced in this plan.

## Effective profile precedence

For profile selection:

```text
PI_DELIVERY_PROFILE
> ~/.pi/agent/extensions/delivery-state-machine/active-profile.json
> defaultProfile from global or built-in profile config
> first profile name in global or built-in profile config
```

Rules:

- `PI_DELIVERY_PROFILE` is an override for the current process. The viewer may still write the global active profile file, but the UI must display that the env var currently overrides it.
- If the selected profile name is not present in the effective global/built-in definitions, fail with a clear configuration error. Do not silently fall back to another model setup.
- A profile-aware config must define all runnable phases. Do not deep-merge phases across profiles or sources.
- The built-in `phase-launches.json` should also use the profile-aware shape and remains the fallback when no global config exists.
- If no custom/global profile config exists, the viewer should list the built-in profiles and allow selecting among them by writing only `active-profile.json`; it should not need to create a full user profile config.
- Existing project-local delivery config can continue to control non-launch settings such as artifact root/max rounds via `.pi/delivery-state-machine.json`. Project-local `phase-launches.json` and project-local `phases/*.md` prompt overrides are not read, warned on, or errored on by the normal resolver; they are simply outside the supported config surface.

## Global report store project registry

Introduce a project-aware report layout as the only report layout the viewer needs to support after migration. This is for report organization and project discovery only; it does not imply project-level profile configuration.

Proposed layout:

```text
~/.pi/delivery-run/
  projects/
    <project-id>/
      project.json
      runs/
        <run-id>/
          delivery-report.json
          00-delivery-summary.md
          01-implementation.md
          ...
```

Example `project.json`:

```json
{
  "schemaVersion": 1,
  "projectId": "pi-productive-extensions-a1b2c3d4",
  "name": "pi-productive-extensions",
  "root": "/Users/jason/ai/pi-productive-extensions",
  "gitRoot": "/Users/jason/ai/pi-productive-extensions",
  "gitRemote": "git@github.com:jason1peng/pi-productive-extensions.git",
  "createdAt": "2026-07-05T12:00:00.000Z",
  "lastSeenAt": "2026-07-05T12:00:00.000Z"
}
```

Project id should be stable and filesystem-safe. Recommended algorithm:

1. Derive the visible slug from the project folder name, e.g. `pi-productive-extensions`.
2. Append an 8-12 character hash of the normalized git root/cwd to avoid collisions, e.g. `pi-productive-extensions-a1b2c3d4`.
3. Replace unsupported filename characters with `-` and cap the slug length.
4. Store git remote in `project.json` metadata for display/search, but do not put it in the folder name.

The viewer may support multiple report roots. Project routes and viewer ids must include root identity, such as `rootIndex`, so identical project ids in different roots are not ambiguous.

## Delivery report metadata

Add profile/project metadata to `delivery-report.json` for new runs and bump the structured report schema to `schemaVersion: 2`. The viewer should continue to handle older v1 reports only through migration/import logic, not by keeping permanent flat-layout scanning.

```json
{
  "schemaVersion": 2,
  "project": {
    "projectId": "pi-productive-extensions-a1b2c3d4",
    "name": "pi-productive-extensions",
    "root": "/Users/jason/ai/pi-productive-extensions",
    "gitRoot": "/Users/jason/ai/pi-productive-extensions",
    "gitRemote": "git@github.com:jason1peng/pi-productive-extensions.git"
  },
  "launchProfile": {
    "selectedProfile": "quota-saving",
    "source": "global-active-profile",
    "definitionSource": "global-phase-launches",
    "envOverride": false
  }
}
```

Avoid storing absolute active-profile config paths in shared report JSON unless needed for local debugging. The profile source enum is usually enough for auditability.

## Migration from old flat report layout

The old flat layout under `~/.pi/delivery-run/<run-id>/` does not need to remain a first-class viewer scan path. Instead, provide a best-effort migration command/script before or alongside the project-layout change.

Migration input:

```text
~/.pi/delivery-run/
  <legacy-run-id>/
    delivery-report.json
    00-delivery-summary.md
    .report-viewer/
    ...
```

Migration output:

```text
~/.pi/delivery-run/
  projects/
    <project-id>/
      project.json
      runs/
        <legacy-run-id>/
          delivery-report.json
          00-delivery-summary.md
          .report-viewer/
          ...
```

Suggested migration helper location:

```text
apps/report-viewer/scripts/migrate-delivery-reports.ts
```

Suggested migration behavior:

- dry-run by default;
- scan immediate children of the configured artifact root;
- skip `projects/`;
- identify report dirs by `delivery-report.json` or `00-delivery-summary.md`;
- preserve all run files, including `.report-viewer/improvements.json`, run logs, and other app-owned metadata;
- infer project metadata from `delivery-report.json.cwd`, `gitRoot`, and `gitBranch` when available;
- if project metadata is missing or the project root no longer exists, place the run under a reserved project such as `unknown-project-<hash>` and record the uncertainty in `project.json`;
- copy by default for safety, with an explicit `--move` option after a successful dry run;
- never overwrite an existing migrated run unless `--force` is passed;
- write migrated `delivery-report.json` files as schemaVersion 2 when source JSON is available, preserving existing v1 fields and adding project/profile metadata when it can be inferred;
- write a migration manifest JSON with source path, destination path, project id, action, and warnings.

If migration is too much for the first implementation, an acceptable fallback is a documented one-shot helper that only prints proposed moves and leaves manual migration to the user. The new viewer does not need to keep permanent legacy flat-layout scanning.

## Report viewer behavior

### Global profile panel

Always available. If no custom/global profile config exists, it should read and display the built-in profile definitions.

Capabilities:

- show active global profile;
- list effective global or built-in profile definitions;
- show whether `PI_DELIVERY_PROFILE` currently overrides the saved selection;
- switch global active profile by writing `active-profile.json` under the resolved pi agent dir;
- create the parent directory if missing;
- write atomically through a temp file plus rename;
- validate that the selected profile exists in the effective global/built-in profile definitions;
- show permission errors clearly.

The viewer must not edit project files for profile/model setup. Editing full profile definitions in the viewer is out of scope for this plan; users who need custom model profiles can edit the global `phase-launches.json` by hand.

### Project/report organization views

Project pages or project filters may use `projects/*/project.json` and run metadata to organize reports.

Capabilities:

- list known projects per report root;
- list runs under a project;
- show project metadata such as name, root, git root, and remote;
- show the global profile used by each run when report metadata includes it.

Project views are read-only with respect to profile/model setup in this plan.

## API sketch

```text
GET  /api/delivery-profiles/global
POST /api/delivery-profiles/global/active
GET  /api/projects
GET  /api/projects/:viewerProjectId
```

Suggested ids:

- `viewerProjectId = base64url("<rootIndex>:<projectId>")`
- `viewerReportId = base64url("<rootIndex>:projects/<projectId>/runs/<runId>")`

These ids are stable for a given report-viewer root ordering. If root order changes, ids may change; that is acceptable for this local viewer.

All mutating routes must require the existing report-viewer CSRF token header.

POST body:

```json
{
  "activeProfile": "quota-saving"
}
```

Validation:

- profile name must be present in effective global or built-in profile definitions;
- profile definitions must include all runnable phases;
- global config directory creation/write failures must be surfaced clearly;
- project ids must include report-root identity to avoid ambiguity across multiple roots;
- project metadata is read-only for profile management, so the viewer does not write to arbitrary project roots.

## Security notes

- The viewer remains a local tool and should continue defaulting to `127.0.0.1`.
- Project metadata includes local-sensitive absolute paths and git remotes. Escape all displayed metadata and document the risk when binding the viewer to a non-localhost address.
- Profile API writes must use the resolved pi agent dir only; request bodies must not contain file paths.
- Resolve/normalize the active-profile destination, create only the expected parent directory, and write atomically via temp file plus rename.
- Project layout artifact serving must keep the existing path traversal/symlink escape protections after nested `projects/<project-id>/runs/<run-id>` routing changes.

## State pinning design

Profile changes apply to future delivery runs only. At `delivery_start`, resolve the effective phase launches and profile metadata once, then store them in `DeliveryState`, for example:

```ts
interface DeliveryState {
  phaseLaunches: Record<RunnablePhase, LaunchConfig[]>;
  launchProfile: ProfileResolution;
}
```

`delivery_next`, `delivery_report`, summaries, and schemaVersion 2 report output must use the pinned state instead of re-reading global config mid-run. If the active profile file changes during a run, remaining phases of that run continue using the pinned profile.

## Implementation phases and PR checkpoints

Implement this plan as independent delivery checkpoints so each PR can clearly report how far the work has progressed.

### PR 1 / Checkpoint 1: Global profile resolver

Status: **Done in PR #11**.

Goal: make delivery launch/model setup global-profile-only and pin the resolved launches for each run.

Scope:

- profile-only built-in/global `phase-launches.json` parsing;
- built-in profile fallback when no custom global profile config exists;
- global `active-profile.json` support;
- `PI_DELIVERY_PROFILE` support;
- stop reading project-local `phase-launches.json` and project-local phase prompt overrides;
- pin resolved profile/launches in `DeliveryState` at `delivery_start`;
- resolver tests and delivery-state-machine tests.

Exit criteria:

- Built-in and global profile launch config tests pass.
- Legacy non-profile global config produces a clear config-shape error.
- Project-local phase launch/prompt files have no effect.
- `PI_DELIVERY_PROFILE` overrides saved global selection.
- A run started with profile A continues using profile A even if `active-profile.json` changes to profile B before later phases.

### PR 2 / Checkpoint 2: Project report layout, schema v2, and viewer scan

Status: **Done in PR #12**.

Goal: organize reports by project without making reports disappear from the viewer.

Scope:

- project id calculation using project folder name plus short hash;
- write/update `project.json` under `<artifactRoot>/projects/<project-id>/`;
- write new reports under `<artifactRoot>/projects/<project-id>/runs/<run-id>/` for all artifact root sources;
- add schemaVersion 2 `project` and `launchProfile` report metadata;
- update report-viewer scanning/routing/artifact path resolution for nested project layout in the same PR;
- project layout, multiple-root, and path traversal tests.

Exit criteria:

- New delivery reports appear in the viewer from the project layout.
- Custom `artifactRoot` and `PI_DELIVERY_ARTIFACT_ROOT` use the same project layout.
- Two repos with the same folder name do not collide.
- Duplicate project ids across multiple report roots remain distinguishable.
- Existing artifact path traversal protections still pass under nested layout.

### PR 3 / Checkpoint 3: Viewer global profile selector

Status: **Done in PR #13**.

Goal: let the report viewer switch the global active delivery profile safely.

Scope:

- global profile API;
- CSRF-protected active-profile write endpoint;
- atomic `active-profile.json` writes under the resolved pi agent dir;
- UI panel for active profile, available profiles, and env override state;
- built-in profile listing when no custom global config exists;
- permission/malformed input tests.

Exit criteria:

- Viewer lists effective global or built-in profiles.
- Viewer can switch the saved global active profile.
- Viewer clearly shows when `PI_DELIVERY_PROFILE` overrides the saved selection.
- Invalid profile names, malformed bodies, missing CSRF, and unwritable config dirs fail clearly.
- Viewer never writes project files for profile/model setup.

### Optional PR 4 / Checkpoint 4: Legacy flat report migration helper

Status: **Done in PR #12 instead of a separate PR**. The verifier required migration support before accepting the removal of normal flat-layout scanning.

Goal: help users move old flat reports into the project layout without requiring permanent flat-layout scanning.

Scope:

- dry-run migration helper, preferably `apps/report-viewer/scripts/migrate-delivery-reports.ts`;
- copy/move support with dry-run default;
- preserve `.report-viewer` metadata and all run files;
- write migration manifest JSON;
- optional v1-to-v2 report metadata enrichment where source metadata is available.

Exit criteria:

- Dry-run prints proposed moves and warnings without changing files.
- Copy mode preserves all run files and app metadata.
- Unknown/stale project roots go to an explicit unknown-project bucket with warnings.
- Existing destinations are skipped unless `--force` is passed.

This checkpoint was originally optional, but landed in PR #12 because removing flat-layout scanning without a migration path would strand existing reports.

### Detailed phase notes

#### Phase 1: Global profile parsing and resolution in delivery state machine

- Extend `phase-config.ts` to parse only built-in and global `phase-launches.json`; stop reading `<repo>/.pi/delivery-state-machine/phase-launches.json`.
- Parse profile-aware global `phase-launches.json` only.
- Add active profile readers for env and global active profile file, using the resolved pi agent dir and honoring `PI_CODING_AGENT_DIR`.
- Validate that every profile defines all runnable phases.
- Return a config bundle such as `{ phases, profileResolution }` so `delivery_start` can pin it in `DeliveryState` and reports can record it.
- Capture the resolved profile at `delivery_start` and pin it for that delivery run unless we deliberately design mid-run profile switching later.

Acceptance:

- Built-in and global profile launch config tests pass.
- Legacy non-profile global launch config tests are intentionally removed or changed to expect a clear config-shape error.
- Tests that previously expected project-local `phase-launches.json` or project-local phase prompt overrides are intentionally updated or removed with documentation that launch/model/prompt setup is now global/built-in only for phase configuration.
- Profile configs resolve the selected profile.
- Missing/invalid selected profile produces a clear error.
- Missing phase in a profile produces a clear error.
- Parallel launch arrays still work.
- `PI_DELIVERY_PROFILE` overrides saved global selection and is recorded as the active source.
- A run started with profile A continues using profile A for later phases even if `active-profile.json` changes to profile B mid-run.

### Phase 2: Project metadata and project-aware artifact layout

- Add project id calculation.
- Write/update `project.json` under the resolved artifact root for new runs.
- Store new run artifacts under `<artifactRoot>/projects/<project-id>/runs/<run-id>/` for every artifact root source, including default, config-file, and `PI_DELIVERY_ARTIFACT_ROOT` roots.
- Update viewer scanning/routing for the project layout in the same implementation phase so newly written reports remain visible.
- Remove the old flat report layout from the normal write path.
- Add or document a one-time migration helper for existing flat report directories.
- Add project/profile metadata to `delivery-report.json` schemaVersion 2.

Acceptance:

- New reports appear under the project layout.
- Existing flat reports are either migrated into the project layout or explicitly reported by the migration helper as needing manual handling.
- Two repos with the same basename do not collide.
- Multiple report roots with the same project id remain distinguishable in the viewer.
- Configured custom `artifactRoot` still works.

### Phase 3: Global profile selector and project registry UI

- Add helpers to read effective built-in/global profile definitions and active selection.
- Add global profile API and UI panel.
- Add project discovery from `projects/*/project.json` and `projects/*/runs/*/delivery-report.json`.
- Refine report scanning/routing for the project layout as needed, including viewer ids that encode root/project/run.

Acceptance:

- Viewer can switch global active profile.
- Viewer displays when `PI_DELIVERY_PROFILE` overrides saved config.
- Viewer lists known projects from the report root.
- Viewer lists runs under the project layout.
- Missing global config and permission errors are shown clearly.

### Phase 4: Migration helper and cleanup

- Implement or document the migration helper.
- Preserve `.report-viewer` metadata during copy/move.
- Generate migration manifest JSON.
- Remove any temporary normal-path legacy flat scanner if one was used during development.

Acceptance:

- Dry-run migration reports proposed moves without changing files.
- Copy migration preserves all run files and app metadata.
- Unknown/stale project roots are placed under an explicit unknown project bucket with warnings.
- Viewer does not require permanent flat-layout scanning.

### Phase 5: Docs and tests

Update:

```text
extensions/delivery-state-machine/README.md
apps/report-viewer/README.md
docs/plans/report-viewer-and-structured-reports.md, if needed
```

Add tests for:

- profile-only global launch config validation;
- legacy non-profile global `phase-launches.json` produces a clear config-shape error;
- project-local `phase-launches.json` and project-local `phases/*.md` have no effect on resolved launches/prompts;
- global profile launch config selection;
- global active profile precedence and `PI_DELIVERY_PROFILE` override;
- missing selected profile and missing phase errors;
- project id collision avoidance using project folder name plus short hash;
- project-layout report scanning and routing;
- migration dry-run/copy behavior, including `.report-viewer` metadata preservation;
- multiple report roots with duplicate project ids;
- report-viewer global profile API CSRF protection, atomic write behavior, malformed input handling, and unwritable config directory errors;
- permission/error handling for unwritable global config directory where practical.

Verification commands should include the repository’s existing test scripts, especially delivery-state-machine and report-viewer tests.

## Out of scope for first implementation

- Quota-aware switching.
- Project-level `phase-launches.json` overrides, project-level phase prompt overrides, project-level profile definitions, or project-level active profile selection.
- Editing full profile definitions in the viewer.
- Per-phase ad hoc model overrides from viewer.
- Mutating the launch settings of an already-running delivery outside the profile pinned at `delivery_start`.
- Remote sync of project registry across machines.
- Permanent legacy flat report scanning in the viewer.

## Resolved decisions

1. Global launch config is profile-only, and every profile must define all runnable phases. No legacy non-profile global config and no per-phase merge logic between profiles is introduced.
2. Profile/model setup is global-only. Project-local `phase-launches.json` overrides are removed from the supported resolver. Project folders and metadata are kept for report organization and future features, not for project-level profile setup.
3. Project ids use the project folder name plus a short hash, while git remote stays in metadata.
4. Structured report JSON should move to schemaVersion 2 for project/profile metadata.
5. The project-aware artifact layout should become the default for new runs. Old flat reports should be migrated or manually moved with helper guidance, not supported forever by the viewer.
6. If `PI_DELIVERY_PROFILE` is set, the viewer may still save the global active profile but must display that the environment override is currently effective.
7. Profile changes apply to future delivery runs. A delivery run pins its resolved profile at `delivery_start` unless a separate explicit mid-run switching feature is designed later.
