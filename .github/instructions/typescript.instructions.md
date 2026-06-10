---
applyTo: "src/**/*.{ts,tsx}"
---

# TypeScript source guidelines

- The project compiles with `strict` mode; flag new `any` types that could reasonably be given a precise type.
- Exported functions, types, and React components should have JSDoc describing parameters and return values.
- Filesystem reads over user-provided files should be guarded with existence checks and `try`/`catch`; errors should be surfaced or the file skipped, not swallowed silently.
- Keep file-path handling cross-platform (macOS, Windows, Linux); avoid hard-coded separators or OS-specific paths.
- Express route handlers should wrap their logic in `try`/`catch` and return a JSON error with an appropriate status code.
- Flag new `console.log` / `console.debug` / `debugger` statements outside intentional CLI and server startup/error logging.
