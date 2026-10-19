import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server";

function startTestServer(port = 0, host = "127.0.0.1"): Promise<Server> {
  const app = createApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}

function closeTestServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

afterEach(() => vi.unstubAllEnvs());

const expectedVersion = (require("../../package.json") as { version: string })
  .version;
const semverPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

describe("GET /api/health", () => {
  it.each(["99.99.99-parent-package", ""])(
    "returns this application version when parent npm version is %s",
    async (parentVersion) => {
      vi.stubEnv("npm_package_version", parentVersion);
      const server = await startTestServer();
      const address = server.address();

      if (!address || typeof address === "string") {
        throw new Error("Test server did not start correctly");
      }

      try {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/api/health`
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          status: string;
          version: string;
        };
        expect(body.version).toMatch(semverPattern);
        expect(body).toEqual({
          status: "ok",
          version: expectedVersion,
        });
      } finally {
        await closeTestServer(server);
      }
    }
  );
});
