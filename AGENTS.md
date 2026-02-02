<INSTRUCTIONS>
## Workflow: commits & pull requests

This repository is expected to grow quickly. To keep changes reviewable and auditable:

### Branching
- Always work on a branch prefixed with `codex/` (never commit directly to `main`).
- Use short, descriptive branch names, e.g. `codex/frontend-dashboard`.

### Commits (frequent + explicit)
- Commit early and often: one logical change per commit.
- Commit messages must be explicit and scoped:
  - `feat(frontend): dashboard + auth`
  - `fix(backend): safe file download endpoint`
  - `chore: update docs`
- Do not mix unrelated changes in the same commit.
- Before committing: run the smallest relevant checks (tests/lint/build) and ensure `git status` is clean.

### Pull requests
- Prefer PRs for every non-trivial change (anything beyond a tiny fix).
- PR description must include:
  - What changed (1–3 bullets)
  - How to test (exact commands)
  - Any follow-ups / known limitations
- Keep PRs small; split large work into multiple PRs if needed.

### Hygiene
- Do not commit secrets (`.env` files, API keys, passwords).
- Prefer updating/adding tests for business logic changes.
</INSTRUCTIONS>

