# Repository workflow

- For an explicit implementation request, make the requested code changes, run relevant checks when appropriate, then commit the task-scoped changes and push the current branch to its configured upstream (`origin`).
- Do not commit or push for explanation, diagnosis, review, or planning requests unless the user explicitly asks for a change.
- Before staging, inspect `git status` and stage only files changed for the current task. Preserve unrelated staged and unstaged user changes; ask before proceeding if they would be mixed into the commit.
- Check that local secrets, credentials, generated state, and user data are excluded before committing. Never print secret values.
- If relevant checks fail, the remote is non-fast-forward, or authentication/approval prevents a push, stop before forcing anything and report the exact blocker.
- To undo a pushed task, prefer a new `git revert` commit so the remote history remains auditable. Never use force-push or destructive history rewrites unless the user explicitly requests them.
