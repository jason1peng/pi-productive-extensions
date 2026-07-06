# Change Principles

These principles apply to all changes in this repository.

## Validate with real evidence

Every meaningful change should be validated with evidence that matches the surface changed.

- Extension behavior: run the relevant Bun tests and, when needed, exercise the Pi command/tool path.
- Report viewer behavior: test the API/UI route or helper that a user relies on, not only internal state.
- Documentation/config changes: verify links, advertised commands, paths, and examples against the repo.
- If the right validation tool is missing, add a small focused test or document the manual check instead of guessing.

## Test behavior, not noise

Tests should prevent regressions without making simple changes hard.

- Add tests for user-visible, API-visible, artifact-format, or workflow-critical behavior.
- Prefer readable integration-style tests when they cover the real consumer path better than isolated units.
- Do not add busywork tests for passive constants or trivial wiring unless they protect a stable contract.
- Keep test fixtures small and explicit.

## Keep code concise, modular, and readable

Optimize for future maintainers being able to understand the code quickly.

- Prefer clear names, simple control flow, and dependency-light helpers.
- Extract duplicated parsing, validation, or formatting only when the shared behavior is clear and testable.
- Keep shared modules focused; avoid hiding product-specific behavior in generic abstractions.
- Do not add frameworks, build layers, or broad rewrites for simple maintenance tasks.
- Document stable contracts once and link to them instead of duplicating long specs.
