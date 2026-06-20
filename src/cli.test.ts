import { describe, expect, it } from "vitest";
import { parseDashboardArgs } from "./cli-args";

describe("parseDashboardArgs", () => {
  it("accepts a normal port", () => {
    expect(parseDashboardArgs(["--port", "3000"])).toMatchObject({
      port: 3000,
      host: "localhost",
      shouldOpen: false,
    });
  });

  it("accepts the minimum and maximum valid ports", () => {
    expect(parseDashboardArgs(["--port", "1"]).port).toBe(1);
    expect(parseDashboardArgs(["--port", "65535"]).port).toBe(65535);
  });

  it("rejects a port below the valid range", () => {
    expect(() => parseDashboardArgs(["--port", "0"])).toThrow(
      'Error: --port must be a number between 1 and 65535. Got: "0"'
    );
  });

  it("rejects a port above the valid range", () => {
    expect(() => parseDashboardArgs(["--port", "99999"])).toThrow(
      'Error: --port must be a number between 1 and 65535. Got: "99999"'
    );
  });

  it("rejects a non-numeric port", () => {
    expect(() => parseDashboardArgs(["--port", "abc"])).toThrow(
      'Error: --port must be a number between 1 and 65535. Got: "abc"'
    );
  });
});
