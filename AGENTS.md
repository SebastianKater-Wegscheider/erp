<INSTRUCTIONS>
## Workflow: commits

This repository is expected to grow quickly. To keep changes reviewable and auditable:

### Branching
- commit directly to `master`
- only commit your changes. other changed files can remain uncommited.

### Commits (frequent + explicit)
- Commit early and often: one logical change per commit.
- Commit messages must be explicit and scoped:
  - `feat(frontend): dashboard + auth`
  - `fix(backend): safe file download endpoint`
  - `chore: update docs`
- Do not mix unrelated changes in the same commit.
- Before committing: run the smallest relevant checks (tests/lint/build) and ensure `git status` is clean.

### Hygiene
- Do not commit secrets (`.env` files, API keys, passwords).
- Prefer updating/adding tests for business logic changes.
</INSTRUCTIONS>

