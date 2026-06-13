# Plan Quality Checklist

Use this lightweight checklist when writing or reviewing a delivery plan. It is not a template; include only the sections that materially reduce ambiguity for the task.

## 1. Scope boundaries

- What must change?
- What must not change?
- What compatibility or legacy behavior must be preserved?
- What is explicitly follow-up or out of scope?
- For cleanup, revert, or existing-MR work, what is the intended review base or net diff target?
- Are there protected files or surfaces that must stay zero-diff versus that base?

## 2. Local prerequisites

- Required profiles, feature flags, or runtime modes
- Required environment variables or local secrets/dummies
- Required generated assets or dependency install steps
- Known local boot blockers or setup quirks
- If docs/config/devstack advertise an endpoint, port, profile, or run command, how will the plan prove that runtime mode actually starts the advertised behavior?

## 3. Acceptance and verification path

- What observable behavior proves the change works?
- What real consumer/user path should be exercised, not just internal state?
- What focused tests or commands should run?
- When is source-only or mock-only evidence sufficient, if ever?
- For cleanup or preservation work, which surfaces need behavioral checks versus zero-diff preservation checks?

## 4. Test data, state, and isolation

Use when the change involves scoped state, tenancy, sessions, caches, request context, feature flags, test IDs, or shared stores.

- Which distinct scopes or identities should be tested?
- Is an interleaved check needed to prove isolation?
- Should missing/default/no-context behavior be verified?
- What data must not leak across scopes?

## 5. Validation and error expectations

Use when the change adds or modifies input validation, endpoint status codes, parsing, auth, or failure behavior.

- Which invalid inputs must be tested?
- Expected status code, error shape, or message when important
- If any non-2xx failure is acceptable, say that explicitly
- Which validation polish is follow-up rather than required now?

## 6. Candidate completeness expectations

- Expected source/config/script/doc files to change or be added
- Expected tests to change or be added
- Generated/local files that should not be committed
- Any files that are intentionally untracked and why

## After retro

When a delivery retro finds a plan gap, convert it into one of:

- a new checklist item here, if broadly reusable
- a task-specific note in the next plan, if repo-specific
- a repo/product follow-up, if it is not a planning-process issue
