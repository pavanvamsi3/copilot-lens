---
applyTo: "**/__tests__/**/*.{ts,tsx}"
---

# Test file guidelines

- Each test should have a clear, behavior-describing name (avoid generic names like "works" or "test1").
- Prefer `expect(...).toBe(...)` / `toEqual(...)` over loose truthiness checks unless truthiness is what's being asserted.
- Flag tests with no assertions as a review concern.
- Recommend that async tests `await` their async calls and return / await the assertion.
