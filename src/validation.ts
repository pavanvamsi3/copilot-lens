// Validation helpers for untrusted input that reaches the filesystem.

// Session IDs are UUID-like tokens (CLI directory names, VS Code session ids,
// Claude Code filename stems) that get interpolated into filesystem paths. An
// attacker-controlled id such as "../../etc/passwd" would otherwise allow
// directory traversal, so we restrict ids to a conservative character set with
// no path separators and reject any ".." traversal sequence.
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

export function isValidSessionId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 256 &&
    !id.includes("..") &&
    SESSION_ID_RE.test(id)
  );
}
