import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import ts from "typescript";

describe("CLI version flags", () => {
  let packageDir: string;
  let cliPath: string;
  let workingDir: string;
  const version = "9.8.7";

  beforeAll(() => {
    // Model an installed package without dashboard dependencies or session data.
    packageDir = mkdtempSync(path.join(tmpdir(), "copilot-lens-version-"));
    mkdirSync(path.join(packageDir, "dist"));
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ version })
    );
    cliPath = path.join(packageDir, "dist", "cli.js");
    const { outputText } = ts.transpileModule(
      readFileSync(path.join(__dirname, "..", "cli.ts"), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      }
    );
    writeFileSync(cliPath, outputText);

    const { outputText: urlOutput } = ts.transpileModule(
      readFileSync(path.join(__dirname, "..", "cli-url.ts"), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      }
    );
    writeFileSync(path.join(packageDir, "dist", "cli-url.js"), urlOutput);

    // A different working directory must not determine the installed version.
    workingDir = path.join(packageDir, "unrelated-project");
    mkdirSync(workingDir);
    writeFileSync(
      path.join(workingDir, "package.json"),
      JSON.stringify({ version: "0.0.0" })
    );
  });

  afterAll(() => {
    if (
      packageDir &&
      path.dirname(path.resolve(packageDir)) === path.resolve(tmpdir())
    ) {
      rmSync(packageDir, { recursive: true, force: true });
    }
  });

  it.each(["--version", "-v"])(
    "%s prints the package version and exits successfully",
    (flag) => {
      const result = spawnSync(process.execPath, [cliPath, flag], {
        cwd: workingDir,
        env: { ...process.env, VITEST: "false" },
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${version}\n`);
      expect(result.stderr).toBe("");
    }
  );
});
