# Remove packaged `dsm.*` delivery agents

## Change

- **Scope:** Retire the five package-owned agents (`dsm.implementer`, `dsm.verifier`, `dsm.reviewer`, `dsm.closer`, and `dsm.retrospective`) from runtime discovery and the bundled delivery configuration. Remove the `dsm-candidate` profile and the DSM-only prompt assembly path, then clean the directly affected tests, smoke checks, commands, and current documentation.
- **Implementation surfaces:** `agents/dsm/`, the root `package.json` package-agent registration, `phase-launches.json`, `phase-config.ts`, `index.ts`, and the five `phases/*.md` files.
- **Operational/documentation surfaces:** update `README.md`, `docs/prompt-construction.md`, `scripts/isolated-host-smoke.sh`, `scripts/fault-injection/README.md`, and the current-status portions of `IMPROVEMENT_PLAN.md`. Remove or retire direct `eval:dsm-agents:*` entry points and mark the DSM comparison material as historical.
- **Not changing:** the default route (`worker`, `fresh-verifier`, `reviewer`, `delegate`), generic user-defined launch profiles, delivery tool names and schemas, persisted state/report contracts, artifact contracts, phase order, `fresh-verifier`, or unrelated `DSM_*` state-machine/smoke identifiers.
- **Done when:**
  - Package discovery finds no package-owned DSM agents, and the bundled launch config contains only the default profile with its existing generic agents.
  - Every phase uses the normal child-prompt path; common workflow, authoritative-source, artifact, and instruction-authority safeguards remain present.
  - No active runtime/config/documented command can select a packaged DSM agent. Exact DSM names may remain only in explicitly labeled historical/frozen evaluation records.
  - The frozen Stage 7 evaluation inputs required by `benchmarks/model-quality` remain byte-identical and continue to validate.
  - Focused tests, model-quality model-free validation, and `npm run verify` pass; the final diff contains no unrelated changes.

## Notes

- This is one cohesive, sequential removal: runtime registration/configuration, prompt simplification, test/doc cleanup, and the final validation gate share the same compatibility decision and files.
- This intentionally removes the optional `dsm-candidate` profile and the `## DSM child prompt` override surface. Users must use the generic profile agents and `## Child prompt` overrides instead. Existing deliveries pinned to a DSM agent must be completed, reset, or explicitly migrated before removal; no persisted-state schema migration is included.
- Before implementation, check the active delivery and user-space config. The current saved profile is `default`, but `~/.pi/agent/extensions/delivery-state-machine/phase-launches.json` still defines `dsm-candidate`; remove that stale profile or switch it to generic agents as a local, non-committed migration.
- Do not delete the shared/frozen `benchmarks/agent-quality` runtime/schema/scenario assets consumed by `benchmarks/model-quality`, and do not alter files protected by `benchmarks/model-quality/bootstrap/stage7-sentinels.json`. Retain the Stage 7 report and completed planning records as historical evidence, while retiring direct DSM evaluation commands and correcting current documentation so it does not advertise an unavailable agent.
- Implement from a dedicated worktree created from the latest fetched `main`; do not modify the primary checkout during implementation or delivery.
- Validation commands: `npm run eval:models:validate`, `npm run eval:models:fake-full`, `npm run eval:models:audit`, the focused delivery-state-machine test, and `npm run verify`. Do not run model-backed canaries unless explicitly requested.

## Execution checklist

- [ ] Remove the packaged DSM runtime/profile/prompt paths, update the affected tests/scripts/current docs and historical-status guidance, migrate stale user configuration as needed, and pass all preservation and verification gates above.
