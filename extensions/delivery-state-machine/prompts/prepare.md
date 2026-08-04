Prepare this delivery request before starting the state machine:

{{task}}

Resolve any reference in the request (plan ID, ticket key, URL, or file path) with the applicable parent skill or tool. Read the authoritative source before acting, then check that the request is clear, ready, feasible, and targets this checkout.

- If the source is missing, unreadable, contradictory, unclear, or targets another repository/checkout, ask the user instead of starting delivery.
- If the request is clear and feasible, call `delivery_start` with a prepared brief that names the exact authoritative source path.
- A prepared brief is ordinary task text; do not duplicate the full source or invent a structured intent object.
- If there is no source file, pass the clarified request text as the brief.

Use this shape when a source exists:

```md
Deliver <request or reference>.

Authoritative source (read before acting):
<exact source path>

Target repository: <repository name> (matches current checkout)
Feasibility: clear
Clarifications: none
```

Do not call `delivery_start` with only the unresolved reference. `delivery_start` creates delivery state only after the brief is prepared.
