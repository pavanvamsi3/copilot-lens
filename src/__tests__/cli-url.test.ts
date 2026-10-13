import { describe, it, expect } from "vitest";
import { getDashboardUrl } from "../cli-url";

describe("dashboard URL", () => {
  it.each([
    ["::1", "http://[::1]:3000"],
    ["::", "http://[::]:3000"],
    ["2001:db8::1", "http://[2001:db8::1]:3000"],
    ["::ffff:127.0.0.1", "http://[::ffff:127.0.0.1]:3000"],
    ["[::1]", "http://[::1]:3000"],
    ["localhost", "http://localhost:3000"],
    ["127.0.0.1", "http://127.0.0.1:3000"],
    ["dashboard.example", "http://dashboard.example:3000"],
  ])("formats %s as a valid browser URL", (host, expected) => {
    const url = getDashboardUrl(host, 3000);
    expect(url).toBe(expected);
    expect(new URL(url).protocol).toBe("http:");
    expect(new URL(url).port).toBe("3000");
  });

  it("preserves a custom port", () => {
    expect(getDashboardUrl("::1", 8080)).toBe("http://[::1]:8080");
  });
});
