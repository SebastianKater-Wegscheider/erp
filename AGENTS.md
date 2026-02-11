<INSTRUCTIONS>
## Workflow: commits

This repository is expected to grow quickly. To keep changes reviewable and auditable:

# Branching
- commit directly to `master`
- only commit your changes. other changed files can remain uncommited.

# Commits (frequent + explicit)
- Commit early and often: one logical change per commit.
- Commit messages must be explicit and scoped:
  - `feat(frontend): dashboard + auth`
  - `fix(backend): safe file download endpoint`
  - `chore: update docs`
- Do not mix unrelated changes in the same commit.
- Before committing: run the smallest relevant checks (tests/lint/build) and ensure `git status` is clean.

# Hygiene
- Do not commit secrets (`.env` files, API keys, passwords).
- Prefer updating/adding tests for business logic changes.

# History
- write all relevant thoughts, decisions and reasoning in a centralized file called `docs/history.md`
- keep your notes pragmatic and concise, but include both business perspective and technical reasoning
- before implementing new features, think about the implications and document them in `docs/history.md`
- before making significant changes to the codebase, think about the implications and document them in `docs/history.md`

# Deployment (production)
- production SSH user/host: `seb@192.168.178.72`
- production repo path: `/home/seb/kater-wegscheider-company`
- publish flow: `git pull --ff-only origin master` and then `docker compose up -d --build`
</INSTRUCTIONS>
