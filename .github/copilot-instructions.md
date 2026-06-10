# Copilot custom instructions

These instructions guide GitHub Copilot Code Review on this repository.

## General guidelines

- Always insist that exported public functions and React components include JSDoc comments describing their parameters and return value.
- Prefer descriptive variable names over single-letter names except for loop indices and well-known math conventions.
- Flag any new `console.log`, `console.debug`, or `debugger` statements in non-test source files as a review concern.
- When new code paths read from the filesystem, recommend that errors are surfaced to the user rather than swallowed.
