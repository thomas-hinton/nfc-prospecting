# Manual verification handoff

What to do when automated implementation and its test suite are done, but one or more acceptance criteria can't be verified by the agent itself. This is not a replacement for `/implement` or `/triage` — it's the missing link between them: the step `/implement` takes instead of closing an issue outright when the remaining work needs a human.

Uses the label vocabulary from [triage-labels.md](triage-labels.md) and the `gh` conventions from [issue-tracker.md](issue-tracker.md). Does not modify the downloaded `/implement` or `/triage` skills — this is an additive step run after `/implement`, not a change to either skill's own files.

## When this applies

Only when **all** of the following hold:

- Implementation is finished and the automated test suite passes.
- At least one acceptance criterion genuinely cannot be verified with the tools and access the agent has — it requires human access to credentials, an external dashboard or admin console, physical hardware, a billing-enabled service, or interactive browser confirmation (OAuth flows, visual layout, etc.).

Do not invent manual checks for criteria the agent can verify itself. **If every acceptance criterion can be checked with the tools and access the agent already has — a script, a unit test, a read-only API call — this workflow does not apply at all:** do not add `ready-for-human`, do not create a `## Manual verification required` section, and do not touch `ready-for-agent` on that basis. Report the work as fully verified and let the normal completion path (`/implement`'s test run, `/code-review`, commit) stand on its own. This workflow exists only for the residue left over after automation has done everything it can.

## What to do

1. **Keep the issue open.** This is not a `wontfix`-style close.
2. **Swap the state label:** remove `ready-for-agent`, add `ready-for-human`. Leave every other label untouched — category (`bug`/`enhancement`), and anything unrelated to this workflow, are preserved as-is.
   ```
   gh issue edit <n> --remove-label "ready-for-agent" --add-label "ready-for-human"
   ```
3. **Write or update the `## Manual verification required` section in the issue body — idempotently.** Fetch the current body, check whether a `## Manual verification required` heading already exists:
   - If it doesn't: append the section (template below) to the end of the body.
   - If it does: replace everything from that heading to the next `##` heading (or end of body) with the refreshed section. Never append a second copy — repeated runs of this workflow must converge on one section, not accumulate duplicates.
   ```
   gh issue view <n> --json body --jq .body   # read
   gh issue edit <n> --body-file -            # write back the merged body, via heredoc/stdin
   ```
4. **Post a concise handoff comment** — separate from the body edit — summarizing what was implemented and what the automated suite already confirmed, and naming what's left for the human. Point at the section in the body rather than repeating it.
5. **Never include credentials.** No tokens, passwords, service-role keys, API keys, or private environment-variable values in the issue body, comments, or logs — not even partially, not even to say what they look like. If a step requires the human to *use* a credential, describe the UI path to it ("open the key's settings in Google Cloud Console"); never ask them to paste the value back into the issue.

## The `## Manual verification required` section

```markdown
## Manual verification required

Automated implementation and the test suite (`<test command>`) are complete and
passing. The items below can only be verified against <the live services /
hardware / dashboards involved>, so this issue stays open and labeled
`ready-for-human` until someone runs through this procedure and reports the
results. No credentials or key values should be pasted into this issue at any
point.

### Prerequisites

- Access needed (e.g. "Google Cloud Console access to the project", "the
  physical NFC reader"), stated as *what's needed*, not the credential itself.

### <Numbered check group, e.g. "1. <Service>: <what's being checked>">

- [ ] **Check:** what to do.
  **Expected:** what should happen.
- [ ] **Check:** ...
  **Expected:** ...

### Rollback / cleanup

- Only needed for checks that leave temporary state behind (a test row, a
  temporarily-lowered limit, a feature flag). State exactly what to revert
  and to what value. Mark anything required, not optional, as such.
```

Guidance for filling it in:

- Prefer **safe, read-only checks** (viewing a dashboard, running a `select`, opening a URL) over anything that mutates state. When a check must change something, say so explicitly and pair it with the exact rollback step.
- Steps should survive the codebase changing under them the same way an agent brief does (see [AGENT-BRIEF.md](../../.agents/skills/triage/AGENT-BRIEF.md)'s "durability over precision"): name services, settings, and expected outcomes, not file paths or line numbers.
- Split **Check** from **Expected** on every line so a human can tick a box only once the expected result is actually confirmed, not just once the action is taken.

## After the human responds

Only an explicit message from the human stating that the required manual checks passed counts as confirmation. Completed implementation, passing automated tests, a successful deployment, and the mere presence of the checklist are exactly the things this workflow hands off *past* — none of them count as verification, and none may be treated as if they did. Never infer confirmation from context or from technical evidence; wait for the human to say so.

**No confirmation yet:** take no closing action. Preserve `ready-for-human` and leave the issue open — this is the default, steady state while the checklist is outstanding.

**Human confirms the checks passed:** remove `ready-for-human` and post a comment confirming the result. Confirmation that the checks passed and authorization to close are two separate things — do not treat one as implying the other. Close the issue only if the human's message *also* explicitly asks for or authorizes the close (in the same message or a later one). If confirmation arrives without a closing instruction, ask whether to close rather than closing automatically.
```
gh issue edit <n> --remove-label "ready-for-human"
gh issue comment <n> --body "..."
gh issue close <n> --comment "..."   # only once closing is explicitly authorized
```

**Human reports the checks failed:** document the reproducible failure in a comment — what was checked, what happened instead of the expected result — with no secrets included. Remove `ready-for-human`, restore `ready-for-agent`, and leave the issue open for another implementation pass.
```
gh issue edit <n> --remove-label "ready-for-human" --add-label "ready-for-agent"
gh issue comment <n> --body "..."
```

## Example

Issue [#4](https://github.com/thomas-hinton/nfc-prospecting/issues/4), "Text search & add + Google Maps/NFC link workflow," is a concrete case: the search/add/marker/dedup logic and its unit tests (against an in-memory fake) were finished and automated, but the criteria around Google Cloud API enablement and key restriction, the Netlify build-time environment variable, and the live Supabase rows can only be confirmed against real external services. The issue carries `ready-for-human`, stays open, and its body ends with a `## Manual verification required` section broken into prerequisite-free numbered groups (Google Cloud, Netlify, browser flow, Supabase read-only `select`s, and a reversible quota-limit test with an explicit, marked-required rollback step) — no credential values appear anywhere in it.
