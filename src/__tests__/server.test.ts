import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createApp } from "../server";

function startTestServer(): Promise<Server> {
  const app = createApp();

  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
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

describe("GET /api/health", () => {
  it("returns an OK status and version", async () => {
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
      await expect(response.json()).resolves.toEqual({
        status: "ok",
        version: expect.any(String),
      });
    } finally {
      await closeTestServer(server);
    }
  });
});