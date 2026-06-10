# Copilot custom instructions

These instructions guide GitHub Copilot Code Review on this repository.

## About this project

Copilot Lens is a **local-first** dashboard that reads, searches, and visualizes
local AI coding-assistant session history (Copilot CLI, VS Code Copilot Chat, and
Claude Code). The stack is Node + Express + TypeScript on the backend, a vanilla
JS/HTML/CSS frontend in `public/`, an Ink + React TUI for the `tokens` command, and
Vitest for tests.

## General guidelines

- Always insist that exported public functions and React components include JSDoc comments describing their parameters and return value.
- Prefer descriptive variable names over single-letter names except for loop indices and well-known math conventions.
- Flag any new `console.log`, `console.debug`, or `debugger` statements in non-test source files as a review concern. Existing intentional CLI output (`src/cli.ts`) and server startup/error logging are the exception.

## Privacy and local-first

- This tool runs entirely on the user's machine. Flag any code that sends session
  data, telemetry, or analytics to a remote service, or that introduces a network
  call or sign-in requirement, as a serious concern.
- Session content can contain secrets and personal data. Flag code that logs raw
  session/event payloads or writes them outside the user's existing data directories.

## Filesystem and parsing

- The app reads many user files of unknown shape. When new code paths read from the
  filesystem, recommend guarding with existence checks and `try`/`catch`, and that
  errors are surfaced to the user (or skipped per-file) rather than swallowed silently.
- Keep parsing defensive: malformed JSON/YAML or a single unreadable file must not
  crash a whole listing. Flag unguarded `JSON.parse`, `readFileSync`, or `parse`
  calls over user-provided files.
- Preserve existing safeguards such as stripping pasted images and skipping very
  large files (200MB). Flag changes that remove or weaken these limits.

## TypeScript

- The project compiles with `strict` mode. Prefer precise types and avoid widening
  to `any`; flag new `any` usage that could reasonably be typed.
- Keep cross-platform behavior intact: file paths must work on macOS, Windows, and
  Linux. Flag hard-coded path separators or OS-specific paths that bypass the
  existing per-platform handling.

## API and frontend

- Express route handlers should wrap their work in `try`/`catch` and return a JSON
  error with an appropriate status code, matching the existing pattern in
  `src/server.ts`. Flag new routes that can throw an unhandled error.
- The frontend in `public/` is vanilla JS (no bundler/build step) with minimal browser
  dependencies (e.g., Chart.js via CDN). Flag introducing a framework or build step unless explicitly intended.

## Tests

- New backend behavior should come with Vitest coverage under `src/__tests__/`.
  Recommend tests for new parsers, source adapters, and API routes.
