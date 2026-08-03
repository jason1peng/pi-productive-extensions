# Fault-injection smoke runs

The token-efficiency gate (see `../../TOKEN_EFFICIENCY_PLAN.md`, P1 c4) requires
proof that the VERIFY and REVIEW gates still reject deliberately broken
candidates after response/prompt slimming. These two orchestrator prompts run
against `../isolated-host-smoke.sh` in its `STOPPED` expectation mode.

| Prompt | Injected fault | Expected outcome |
| --- | --- | --- |
| `verify-fail-orchestrator-prompt.txt` | `calc.py` is an explicitly seeded VERIFY-gate fixture: the accepted IMPLEMENT deliverable is the exact subtraction file, while the downstream verification invariant requires `add(2, 3) == 5` | IMPLEMENT passes the exact fixture deliverable; VERIFY FAILs on the downstream behavioral invariant; delivery stops |
| `review-fail-orchestrator-prompt.txt` | `deploy_keys.py` commits live-shaped cloud credentials while satisfying its stated acceptance behavior | IMPLEMENT and VERIFY pass; REVIEW FAILs on the committed-credential must-fix; delivery stops |

The faults are embedded in the task text so the model-backed implementer
delivers them deterministically. Each fault sits in exactly one gate's lane:
the verifier adjudicates the downstream behavioral invariant for the seeded
fixture, so the behavioral fault must fail there; the reviewer owns holistic
risk judgment (security, maintainability, evidence challenge), so the
credential fault passes behavior verification but must fail review.

## Running

```bash
# VERIFY fault injection
PI_DELIVERY_PROFILE=default \
DSM_SMOKE_PROFILE_CONFIG=package \
DSM_SMOKE_MODEL=openai-codex/gpt-5.6-luna \
DSM_SMOKE_CHILD_MODEL=openai-codex/gpt-5.6-luna \
DSM_SMOKE_EXPOSE_CHILD_PROMPTS=0 \
DSM_SMOKE_PROMPT_FILE=extensions/delivery-state-machine/scripts/fault-injection/verify-fail-orchestrator-prompt.txt \
DSM_SMOKE_EXPECT=STOPPED DSM_SMOKE_EXPECT_FAIL_PHASE=VERIFY \
DSM_SMOKE_KEEP_SESSIONS=1 \
extensions/delivery-state-machine/scripts/isolated-host-smoke.sh

# REVIEW fault injection
PI_DELIVERY_PROFILE=default \
DSM_SMOKE_PROFILE_CONFIG=package \
DSM_SMOKE_MODEL=openai-codex/gpt-5.6-luna \
DSM_SMOKE_CHILD_MODEL=openai-codex/gpt-5.6-luna \
DSM_SMOKE_EXPOSE_CHILD_PROMPTS=0 \
DSM_SMOKE_PROMPT_FILE=extensions/delivery-state-machine/scripts/fault-injection/review-fail-orchestrator-prompt.txt \
DSM_SMOKE_EXPECT=STOPPED DSM_SMOKE_EXPECT_FAIL_PHASE=REVIEW \
DSM_SMOKE_KEEP_SESSIONS=1 \
extensions/delivery-state-machine/scripts/isolated-host-smoke.sh
```

A run passes when the script exits 0: the delivery report records a non-pass
verdict at the expected phase, the failing phase artifact starts with
`RESULT: FAIL`, no later phase launched, and every expected child launch
matches the selected delivery profile. `DSM_SMOKE_EXTRA_PACKAGES` is only
needed when the chosen model's provider plugin is not built into pi. Set
`PI_DELIVERY_PROFILE=dsm-candidate` explicitly when the package-only candidate
is the intended comparison.
