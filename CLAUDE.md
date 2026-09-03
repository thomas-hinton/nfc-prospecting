## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for thomas-hinton/nfc-prospecting, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Manual verification handoff

When `/implement` finishes an issue but one or more acceptance criteria require human access (credentials, external dashboards, hardware, billing-enabled services, interactive browser checks), don't close the issue: hand it off per `docs/agents/manual-verification.md`.
