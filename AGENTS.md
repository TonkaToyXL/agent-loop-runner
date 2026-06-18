# PR Babysit — agent instructions

Loop a Cursor agent on open pull requests until CI and review are clean.

## Cursor Cloud specific instructions

Use this section when running as a **Cloud Agent** on `TonkaToyXL/agent-loop-runner`.

### Boot check (run before finishing)

```bash
node --version   # expect 20+
npm ci
npm run typecheck
```

If typecheck fails, fix TypeScript errors before opening or updating a PR.

### Scope rules

- Fix only issues in the current task or PR scope.
- Do not modify CI workflows or checks just to make failures pass.
- Do not add dependencies unless the task requires them.
- Prefer small, reviewable commits on a feature branch.

### PR babysit tasks

When the prompt involves babysitting a PR:

1. Inspect CI status and unresolved review threads with `gh`.
2. Apply scoped fixes, push to the PR branch.
3. Re-run `npm run typecheck` after code changes.
4. Stop with a short verdict: merge-ready, blocked (conflicts), or needs human review.

Cloud agents need the `CURSOR_API_KEY` secret only when invoking `@cursor/sdk` locally inside the VM (for example `npm run babysit-pr`). Routine code-fix cloud runs do not need it unless the task explicitly runs the babysit loop.

### Secrets (dashboard)

Add in [Cloud Agents → Secrets](https://cursor.com/dashboard/cloud-agents):

| Secret | When needed |
|--------|-------------|
| `CURSOR_API_KEY` | Running `babysit-pr` or SDK scripts inside the VM |

GitHub access for clone/push/PR comes from the connected GitHub account — no extra token required for normal cloud agent runs.
