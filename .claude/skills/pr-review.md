---
description: Review a pull request against project guidelines and post inline comments. Run `/pr-review <PR#>` to review a specific PR, or `/pr-review` to review the open PR for the current branch.
---

You are reviewing a pull request for the **copilot-lens** project — a local-first Node + Express + TypeScript dashboard for visualising AI coding-assistant session history. The frontend is vanilla JS/HTML/CSS (no bundler), the TUI uses Ink + React, and tests run under Vitest.

## Steps

1. Determine the PR to review:
   - If a PR number was passed as an argument, use it directly.
   - Otherwise run `gh pr view --json number` to get the current branch's open PR number.
   - If no open PR is found, tell the user and stop.

2. Fetch the PR metadata and diff:
   ```
   gh pr view <number> --json title,body,author,baseRefName,headRefName,files
   gh pr diff <number>
   ```

3. Review the diff against **all** of the following criteria. For each finding record:
   - `file` — relative file path
   - `line` — line number in the new file (use the diff to determine it)
   - `severity` — `error` | `warning` | `suggestion`
   - `body` — a clear, actionable comment

   **Correctness & safety**
   - Unguarded `JSON.parse`, `readFileSync`, or third-party `parse` calls over user-provided files must be wrapped in `try`/`catch` — a single bad file must not crash a listing.
   - Express route handlers that can throw must have a `try`/`catch` returning a JSON error with an appropriate status code (follow the pattern in `src/server.ts`).
   - Async functions must `await` their async calls and assertions.
   - No unhandled promise rejections.

   **TypeScript**
   - The project uses `strict` mode. Flag new `any` types that could be given a precise type.
   - Exported functions, types, and React components must have JSDoc describing parameters and return values.
   - File paths must work cross-platform (macOS, Windows, Linux); flag hard-coded separators or OS-specific paths.

   **Privacy / local-first**
   - Flag any code that sends session data, telemetry, or analytics to a remote service.
   - Flag code that logs raw session/event payloads or writes them outside the user's existing data directories.
   - Safeguards like stripping pasted images or skipping files >200 MB must not be removed or weakened.

   **Frontend**
   - The `public/` frontend is plain JS — no framework or build step. Flag any attempt to introduce one unless the PR explicitly intends it.

   **Tests**
   - New backend behaviour (parsers, source adapters, API routes) should come with Vitest coverage under `src/__tests__/`.
   - Flag tests with no assertions.
   - Flag `console.log`, `console.debug`, or `debugger` in non-test source files outside intentional CLI/server logging.

   **Docs**
   - If the PR touches UI or visual behaviour, flag a missing screenshot in the PR description.

4. Post inline comments for every finding:
   ```
   gh pr review <number> --comment --body "..."
   ```
   For findings tied to a specific line use:
   ```
   gh api repos/{owner}/{repo}/pulls/<number>/comments \
     -f body="<comment>" \
     -f commit_id="<head_sha>" \
     -f path="<file>" \
     -F line=<line>
   ```

5. Post a top-level summary comment with:
   - Total counts by severity
   - Overall verdict: **Approve** (no errors), **Request changes** (one or more errors), or **Comment** (warnings/suggestions only)
   - A brief summary of what the PR does and the main concerns

6. Submit the formal review:
   - `gh pr review <number> --approve` if verdict is Approve
   - `gh pr review <number> --request-changes --body "<summary>"` if verdict is Request changes
   - `gh pr review <number> --comment --body "<summary>"` otherwise
