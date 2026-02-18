import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AptConfigSchema } from "@apt/lib/schema";
import { $ } from "bun";
import { parse as parseYaml } from "yaml";

const CLI = "src/cli/index.ts";
const PROJECT_ROOT = "/home/oneup/ai-process-tester-apt";

let tmpDir: string;
let mockServer: ReturnType<typeof Bun.serve>;
let mockServerUrl: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "apt-cli-test-"));

  // Start a mock server for introspect tests
  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (req.method === "HEAD") {
        return new Response(null, { status: 200 });
      }

      if (url.pathname === "/models") {
        return Response.json({ data: [{ id: "test-model" }] });
      }

      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { Allow: "GET, POST, OPTIONS" },
        });
      }

      if (req.method === "POST") {
        return Response.json({ content: "test response" });
      }

      return Response.json({ content: "default" });
    },
  });
  mockServerUrl = `http://localhost:${mockServer.port}`;
});

afterAll(async () => {
  mockServer.stop(true);
  await rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  // Clean up any generated config in project root
  try {
    const f = Bun.file(join(PROJECT_ROOT, "apt.config.yaml"));
    if (await f.exists()) {
      await Bun.write(join(PROJECT_ROOT, "apt.config.yaml"), "");
      await $`rm -f ${join(PROJECT_ROOT, "apt.config.yaml")}`.nothrow().quiet();
    }
  } catch {
    // ignore
  }
});

describe("CLI init command", () => {
  // 1. apt init --target generates apt.config.yaml
  test("init --target generates apt.config.yaml", async () => {
    const _outputPath = join(tmpDir, "apt.config.yaml");

    // Run init from tmpDir so the config is written there
    const _result =
      await $`cd ${tmpDir} && bun run ${join(PROJECT_ROOT, CLI)} init --target http://example.com`
        .nothrow()
        .quiet();

    // Check the config file was created in the cwd (tmpDir)
    const configFile = Bun.file(join(tmpDir, "apt.config.yaml"));
    const exists = await configFile.exists();
    expect(exists).toBe(true);

    const content = await configFile.text();
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("http://example.com");
  });

  // 2. Generated config passes AptConfigSchema validation
  test("generated config passes Zod validation", async () => {
    await $`cd ${tmpDir} && bun run ${join(PROJECT_ROOT, CLI)} init --target http://example.com`
      .nothrow()
      .quiet();

    const content = await Bun.file(join(tmpDir, "apt.config.yaml")).text();
    const parsed = parseYaml(content);
    const result = AptConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});

describe("CLI introspect command", () => {
  // 3. apt introspect --target <mock-server-url> runs without crash
  test("introspect --target runs against mock server", async () => {
    const outputFile = join(tmpDir, "profile.json");

    const result =
      await $`bun run ${join(PROJECT_ROOT, CLI)} introspect --target ${mockServerUrl} --output ${outputFile}`
        .nothrow()
        .quiet();

    // Exit code 0 = PASS
    expect(result.exitCode).toBe(0);

    // Check profile was saved
    const profileFile = Bun.file(outputFile);
    const exists = await profileFile.exists();
    expect(exists).toBe(true);

    const profile = JSON.parse(await profileFile.text());
    expect(profile.id).toBeDefined();
    expect(profile.system_type).toBeDefined();
    expect(profile.detection_methods).toBeArray();
  });

  // 4. Introspect without OpenAI-compatible shows low confidence warning
  test("introspect against non-OpenAI server shows low confidence", async () => {
    // Start a plain server that does NOT have /models
    const plainServer = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method === "HEAD") {
          return new Response(null, { status: 200 });
        }
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204 });
        }
        return new Response("plain text", { status: 404 });
      },
    });
    const plainUrl = `http://localhost:${plainServer.port}`;
    const outputFile = join(tmpDir, "profile-plain.json");

    const result =
      await $`bun run ${join(PROJECT_ROOT, CLI)} introspect --target ${plainUrl} --output ${outputFile}`
        .nothrow()
        .quiet();

    // Check stderr/stdout for low confidence warning
    const stderr = result.stderr.toString();
    const stdout = result.stdout.toString();
    const output = stderr + stdout;
    expect(output).toContain("Low detection confidence");

    plainServer.stop(true);
  });
});

describe("CLI help and stubs", () => {
  // 5. CLI has all expected subcommands registered
  test("CLI module registers all expected subcommands", async () => {
    // Import the CLI module and verify all subcommands are defined
    const initCmd = await import("@apt/cli/commands/init");
    const runCmd = await import("@apt/cli/commands/run");
    const reportCmd = await import("@apt/cli/commands/report");
    const introspectCmd = await import("@apt/cli/commands/introspect");
    const exportCmd = await import("@apt/cli/commands/export");

    // Each module should export a default command
    expect(initCmd.default).toBeDefined();
    expect(runCmd.default).toBeDefined();
    expect(reportCmd.default).toBeDefined();
    expect(introspectCmd.default).toBeDefined();
    expect(exportCmd.default).toBeDefined();
  });

  // 6. apt run exits with code 2 (not implemented)
  test("run command exits with code 2", async () => {
    const result = await $`bun run ${join(PROJECT_ROOT, CLI)} run`.nothrow().quiet();
    expect(result.exitCode).toBe(2);
  });

});

describe("CLI performance", () => {
  // 8. CLI startup < 500ms
  test("CLI startup completes under 500ms", async () => {
    const start = performance.now();
    await $`bun run ${join(PROJECT_ROOT, CLI)} --help`.nothrow().quiet();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});
