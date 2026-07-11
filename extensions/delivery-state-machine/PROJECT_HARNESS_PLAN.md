# Project Harness Compliance Plan

## Problem

Delivery phases currently rely on broad prompt wording such as "inspect repository instructions." In multi-agent delivery, this is too weak: a child can pass implementation, verification, review, or close while missing project-specific guidance from files such as `AGENTS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, linked docs, package scripts, or CI configuration.

The extension should make project harness discovery and compliance explicit without hardcoding paths from any one project and without assuming every project has a documentation index.

## Goals

- Make delivery phases follow each project's own instruction harness by default.
- Keep project rules in the project docs; do not duplicate them into delivery prompts.
- Avoid hardcoded repo-specific docs such as `docs/git-operations.md`.
- Avoid assuming `docs/index.md` or any other documentation map exists.
- Make harness discovery and compliance visible in delivery artifacts.
- Let verification and review fail when applicable project instructions were skipped.

## Non-goals

- Create a new project-level markdown instruction file that competes with `AGENTS.md` or `CLAUDE.md`.
- Encode specific coding, MR, release, or test rules in this extension.
- Require every repository to adopt the same docs layout.
- Block delivery when a project has no harness files; record the absence and continue when no applicable rules are discoverable.

## Terminology

**Project harness** means the discoverable set of project-local instructions and operational contracts that govern a delivery. It can include:

- agent instruction files, for example `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or equivalents;
- common contributor entrypoints, for example `README.md`, `CONTRIBUTING.md`, or package-local READMEs;
- mandatory or phase-relevant docs explicitly referenced by those files;
- package scripts, build files, and CI configuration needed to identify validation commands;
- templates or workflow files relevant to close/review/release behavior.

## Phase 1 — Default harness discovery and artifact evidence

### Principle

Project-harness discovery is mandatory for every runnable phase, but the existence of project-local instruction files is not.

A phase may continue when no applicable harness is discoverable. It must not report success when known applicable instructions were skipped, contradicted, or cannot be evaluated safely.

> **Mandatory discovery, conditional compliance, optional existence.**

### Discovery behavior

Add a shared delivery prompt block injected into every runnable phase after built-in and user-space prompt resolution. This preserves user-space prompt overrides while retaining the delivery workflow's harness requirements.

The block should instruct child agents to:

1. Start discovery from the resolved repository or worktree root.
2. Check common project instruction and contributor entrypoints that actually exist, such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `README.md`, and `CONTRIBUTING.md`.
3. Check directory-scoped instruction files applicable to files being changed, verified, or reviewed.
4. Follow mandatory references and phase-relevant links from discovered entrypoints.
5. Inspect package scripts, build files, CI configuration, templates, or workflow files only when needed to determine applicable commands or expectations.
6. Respect documented directory scope and precedence. Report conflicts when precedence cannot be resolved.
7. Apply only rules relevant to the current phase.
8. Avoid recursively reading unrelated project documentation.
9. Record one of these outcomes:
   - `applied`: applicable instructions were found and followed;
   - `none discovered`: a reasonable discovery attempt found no applicable instructions;
   - `blocked`: required instructions were missing, unreadable, conflicting, or could not be followed safely.

A missing common entrypoint is not itself a gap or failure. A missing file is a reportable gap only when it was explicitly referenced, configured as a hint, or otherwise expected by existing project instructions.

### Phase relevance

- `IMPLEMENT`: coding, architecture, generated files, test placement, formatting, style, and local validation expectations.
- `VERIFY`: validation commands, behavioral proof, test data, environment, isolation, and acceptance expectations.
- `REVIEW`: quality, security, maintainability, architecture, testing, and review conventions.
- `CLOSE`: commit, branch, PR/MR, release, publish, labeling, assignment, and final validation rules.
- `RETRO`: evaluate whether earlier phases discovered and followed applicable instructions; identify harness gaps or unclear guidance that affected the delivery.

### Artifact contract

Every phase artifact must include this standard section:

```md
## Project harness discovery and compliance
- Discovery scope checked:
- Entry points discovered:
- Mandatory references followed:
- Phase-relevant rules applied:
- Conflicts, gaps, or unreadable instructions:
- Outcome: applied | none discovered | blocked
```

Use `none` where appropriate. `none discovered` is valid evidence and does not fail the phase.

For parallel `REVIEW`, every child artifact and the aggregate review artifact must include the section.

Later artifact consumers and summaries should remain backward compatible with artifacts produced before this section existed.

### Enforcement

Phase 1 should enforce the presence of the section for newly generated successful artifacts rather than relying only on prompt wording.

- A successful phase report is not accepted if its artifact lacks the required section or a valid outcome.
- Existing historical artifacts remain readable and do not require migration.
- `IMPLEMENT` and `CLOSE` must not report success when the outcome is `blocked`.
- `VERIFY` returns:
  - `FAIL` when applicable instructions were demonstrably skipped or violated;
  - `INCONCLUSIVE` when required instructions cannot be read or conflicts prevent determining compliance.
- `REVIEW` treats skipped or violated applicable instructions as must-fix findings. Unresolvable uncertainty about mandatory instructions also blocks approval.
- `RETRO` reports weaknesses but is not failed because earlier phases had no harness.
- The parent/orchestrator must not accept a phase verdict that contradicts its harness outcome.

If structural artifact validation is intentionally deferred, the implementation and documentation must explicitly describe Phase 1 as prompt-level enforcement and must not claim that artifact inclusion is guaranteed.

### Compatibility with user-space overrides

Existing user-space phase prompt overrides remain supported.

The shared harness block is added after built-in and user-space child-prompt resolution so replacing a phase prompt does not silently remove the invariant discovery and evidence requirements.

User overrides may add project-specific instructions, but cannot remove the discovery attempt or evidence requirement.

### Tests

Add focused tests covering:

- every runnable child prompt includes the shared discovery block;
- the block survives a full user-space child-prompt override;
- discovery starts from the resolved repository or worktree root;
- prompts do not hardcode repository-specific documentation;
- prompts do not require `docs/index.md` or any other documentation map;
- prompts avoid recursive reading of unrelated documentation;
- no discovered harness is represented as `none discovered`, not failure;
- missing common entrypoints are not treated as errors;
- missing explicitly referenced or hinted files are recorded as gaps;
- nested or directory-scoped instruction files are considered;
- conflicting or unreadable mandatory instructions produce blocking guidance;
- every phase artifact contract includes the standard section;
- parallel `REVIEW` child and aggregate artifacts require the section;
- successful new phase reports lacking the section or valid outcome are rejected;
- `VERIFY` and `REVIEW` treat skipped or violated applicable instructions as blockers;
- historical artifacts without the section remain readable;
- existing user-space phase prompt and launch overrides continue to work.

### README updates

Document:

- mandatory discovery does not mean a harness must exist;
- `none discovered` is a valid successful outcome;
- when missing, unreadable, conflicting, skipped, or violated instructions become blockers;
- how directory-scoped instructions are handled;
- how the shared block interacts with user-space prompt overrides.

## Phase 2 — Optional project discovery hints

### Design

Extend project-local delivery config with optional discovery hints. These hints guide discovery; they are not a new rules source and must not duplicate the actual project standards.

Candidate shape:

```json
{
  "projectHarness": {
    "entrypoints": [
      "AGENTS.md",
      "CLAUDE.md",
      "CONTRIBUTING.md"
    ],
    "phaseHints": {
      "IMPLEMENT": ["coding", "architecture", "testing"],
      "VERIFY": ["test", "validate", "behavior"],
      "REVIEW": ["review", "quality", "security"],
      "CLOSE": ["commit", "branch", "pull request", "merge request", "release"]
    }
  }
}
```

Rules:

- Hints only tell delivery where to look or what topics to search for.
- The actual rules remain in project docs and config.
- If hints are absent, default discovery still works.
- If a hinted file is missing, record it as a gap; do not fail automatically unless the project marks it mandatory in existing instructions.

### Config path

Prefer extending the existing project-local delivery config:

```text
.pi/delivery-state-machine.json
```

This keeps delivery-specific discovery metadata close to other delivery settings without creating a competing markdown instruction file.

### Tests

Add config parsing and prompt rendering tests for:

- default behavior with no hints;
- extra entrypoints included in prompts when configured;
- phase hints included for the matching phase;
- missing hinted files described as gaps, not automatic hard failures.

## Phase 3 — Dedicated PREPARE/HARNESS phase

### Design

Add an optional or default initial phase:

```text
PREPARE -> IMPLEMENT -> VERIFY -> REVIEW -> CLOSE -> RETRO
```

`PREPARE` creates a run-level artifact:

```text
00-project-harness.md
```

Suggested artifact contract:

```md
RESULT: DONE|FAIL|INCONCLUSIVE

## Entry points discovered
## Mandatory references
## Phase-specific rules
## Conflicts or gaps
## Recommended phase instructions
```

Every later phase receives the harness artifact path and must use it as the run-level instruction map. Later phases may still read additional project docs if the task touches a newly relevant area.

### Benefits

- One source of truth for the delivery run.
- Less repeated discovery work in each child.
- Easier verification and review of instruction compliance.
- Better retrospective signal when the harness is incomplete or confusing.

### Risks and mitigations

- **More workflow overhead:** make the phase concise and artifact-focused.
- **State-machine/report migration:** introduce schema/report changes deliberately and keep backward compatibility.
- **Stale harness artifact if docs change mid-run:** later phases can record when they re-read or update the discovered harness context.
- **False confidence from incomplete discovery:** artifact must list gaps and assumptions explicitly.

## Recommended implementation sequence

1. Implement Phase 1 first: shared prompt block, artifact evidence, verifier/reviewer blocker language, tests, and README updates.
2. Implement Phase 2 only after observing projects where default discovery is insufficient.
3. Implement Phase 3 when the extra state-machine complexity is justified by repeated missed harness issues or duplicated phase discovery.

## Acceptance criteria for Phase 1

- Every runnable phase provides evidence of an applicable project-harness discovery attempt.
- Finding a project harness is not required.
- A reasonable discovery attempt that finds no applicable instructions records `none discovered` and may succeed.
- Delivery prompts contain no hardcoded repository-specific documentation paths.
- Delivery prompts do not assume `docs/index.md` or another documentation map exists.
- Discovery is bounded and does not require recursively reading unrelated documentation.
- Applicable directory-scoped instructions and explicit mandatory references are followed.
- Every newly generated phase artifact includes the standard discovery and compliance section.
- Successful reports with missing or contradictory harness evidence are rejected.
- `VERIFY` and `REVIEW` block skipped or violated applicable instructions.
- Parallel review artifacts and their aggregate carry harness evidence.
- Existing historical artifacts remain readable.
- Existing user-space phase prompt and launch overrides remain supported.
- Fast repo verification passes with focused tests for prompt rendering, artifact validation, override compatibility, and backward compatibility.
