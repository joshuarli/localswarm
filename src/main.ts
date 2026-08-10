import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Actor, createActor } from "./actor.ts";
import {
  CONTEXT_WINDOW,
  createLocalVllmProvider,
  MODEL_ID,
  PROVIDER_ID,
  VLLM_BASE_URL,
} from "./provider.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const activeSessions = new Set<Actor["session"]>();
const decoder = new TextDecoder();

const taskA =
  `Create fib.py containing a clean iterative Fibonacci implementation.

Create a tiny self-contained test using only Python's standard library.

Run the test.

Stop when it passes.`;

const taskB = `Create prime.py containing a clean primality-test implementation.

Create a tiny self-contained test using only Python's standard library.

Run the test.

Stop when it passes.`;

interface ActorOutcome {
  id: string;
  status: "success" | "failure";
  elapsedMs: number;
  sessionFile?: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  error?: string;
}

interface Verification {
  status: "passed" | "failed";
  tests: string[];
  detail?: string;
}

function displayPath(path: string): string {
  return relative(repoRoot, path) || ".";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(actorId: string, message: string): void {
  console.log(`[${actorId}] ${message}`);
}

function toolDetail(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const values = args as Record<string, unknown>;
  if (typeof values.path === "string") return ` ${values.path}`;
  if (typeof values.command === "string") return ` ${values.command}`;
  return "";
}

function subscribeLifecycle(actor: Actor): () => void {
  return actor.session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      log(actor.config.id, `tool: ${event.toolName}${toolDetail(event.args)}`);
    }
  });
}

async function runActor(actor: Actor, task: string): Promise<ActorOutcome> {
  const startedAt = performance.now();
  const unsubscribe = subscribeLifecycle(actor);
  activeSessions.add(actor.session);
  log(actor.config.id, "started");

  let status: ActorOutcome["status"] = "success";
  let error: string | undefined;
  try {
    await actor.session.prompt(task, { expandPromptTemplates: false });
    const lastAssistant = [...actor.session.messages]
      .reverse()
      .find((message) => message.role === "assistant") as
        | { stopReason?: string; errorMessage?: string }
        | undefined;
    if (
      lastAssistant?.stopReason === "error" ||
      lastAssistant?.stopReason === "aborted"
    ) {
      status = "failure";
      error = lastAssistant.errorMessage ??
        `assistant stopped with ${lastAssistant.stopReason}`;
    }
  } catch (caught) {
    status = "failure";
    error = formatError(caught);
  } finally {
    activeSessions.delete(actor.session);
    unsubscribe();
  }

  const stats = actor.session.getSessionStats();
  actor.session.dispose();
  const outcome: ActorOutcome = {
    id: actor.config.id,
    status,
    elapsedMs: performance.now() - startedAt,
    sessionFile: actor.session.sessionFile,
    tokens: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
    },
    ...(error ? { error } : {}),
  };

  log(actor.config.id, status === "success" ? "complete" : `failed: ${error}`);
  return outcome;
}

async function findTestFiles(
  root: string,
  artifact: string,
): Promise<string[]> {
  const testFiles: string[] = [];
  const artifactPath = resolve(root, artifact);
  async function visit(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory) {
        await visit(path);
      } else if (
        entry.isFile && entry.name.endsWith(".py") && path !== artifactPath
      ) {
        testFiles.push(path);
      }
    }
  }
  await visit(root);
  return testFiles.sort();
}

async function verifyPythonTest(
  root: string,
  path: string,
): Promise<string | undefined> {
  const relativePath = relative(root, path);
  const child = new Deno.Command("python3", {
    args: [relativePath],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may have exited already.
    }
  }, 30_000);
  try {
    const output = await child.output();
    if (output.code === 0) return undefined;
    const stdout = decoder.decode(output.stdout);
    const stderr = decoder.decode(output.stderr);
    return `${stdout}${stderr ? `\n${stderr}` : ""}`.trim() ||
      `exit code ${output.code}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyActor(
  actor: Actor,
  expectedFile: string,
): Promise<Verification> {
  const root = await Deno.realPath(actor.config.workspace);
  const artifact = join(root, expectedFile);
  try {
    if (!(await Deno.stat(artifact)).isFile) {
      return {
        status: "failed",
        tests: [],
        detail: `${expectedFile} is not a file`,
      };
    }
  } catch (error) {
    return {
      status: "failed",
      tests: [],
      detail: `${expectedFile}: ${formatError(error)}`,
    };
  }

  const testFiles = await findTestFiles(root, expectedFile);
  if (testFiles.length === 0) {
    return {
      status: "failed",
      tests: [],
      detail: "no additional Python test file found",
    };
  }

  for (const testFile of testFiles) {
    const failure = await verifyPythonTest(root, testFile);
    if (failure) {
      return {
        status: "failed",
        tests: testFiles.map((path) => displayPath(path)),
        detail: `${displayPath(testFile)} failed: ${failure}`,
      };
    }
  }
  return {
    status: "passed",
    tests: testFiles.map((path) => displayPath(path)),
  };
}

function printAudit(actor: Actor): void {
  const configRoot = join(actor.config.runtimeRoot, "config");
  console.log(`${actor.config.id}:`);
  console.log(`  provider: ${PROVIDER_ID}`);
  console.log(`  model: ${MODEL_ID}`);
  console.log(`  workspace: ${displayPath(actor.config.workspace)}`);
  console.log(`  runtime root: ${displayPath(actor.config.runtimeRoot)}`);
  console.log(`  config root: ${displayPath(configRoot)}`);
  console.log(`  tools: ${JSON.stringify(actor.session.getActiveToolNames())}`);
  console.log("  skills: none");
  console.log("  extensions: none");
  console.log("  inherited host config: none");
}

function printResult(
  outcomes: ActorOutcome[],
  verifications: Map<string, Verification>,
  wallElapsedMs: number,
): void {
  console.log("\n=== RESULT ===\n");
  for (const outcome of outcomes) {
    const verification = verifications.get(outcome.id);
    const expectedFile = outcome.id === "actor-a" ? "fib.py" : "prime.py";
    console.log(outcome.id);
    console.log(`  status: ${outcome.status}`);
    console.log(`  elapsed: ${(outcome.elapsedMs / 1000).toFixed(1)}s`);
    console.log(
      `  file: ${
        displayPath(join(repoRoot, "workspaces", outcome.id, expectedFile))
      }`,
    );
    console.log(`  verification: ${verification?.status ?? "not run"}`);
    console.log(`  input tokens: ${outcome.tokens.input}`);
    console.log(`  output tokens: ${outcome.tokens.output}`);
    console.log(`  cached tokens: ${outcome.tokens.cacheRead}`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    if (verification?.detail) {
      console.log(`  verification detail: ${verification.detail}`);
    }
    console.log();
  }
  console.log(`wall time: ${(wallElapsedMs / 1000).toFixed(1)}s`);
  console.log(`model: ${MODEL_ID}`);
  console.log(`endpoint: ${VLLM_BASE_URL}`);
  console.log("logical actors: 2");
  console.log("model replicas: 1");
}

async function verifyServer(): Promise<void> {
  const response = await fetch(`${VLLM_BASE_URL}/models`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`vLLM preflight failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  const ids =
    body.data?.map((entry) => entry.id).filter((id): id is string =>
      Boolean(id)
    ) ?? [];
  if (ids.length > 0 && !ids.includes(MODEL_ID)) {
    throw new Error(`vLLM serves ${ids.join(", ")}, not ${MODEL_ID}`);
  }
}

async function main(): Promise<void> {
  Deno.addSignalListener("SIGINT", () => {
    for (const session of activeSessions) {
      void session.abort();
    }
  });

  await verifyServer();
  const { modelRuntime, model } = await createLocalVllmProvider();
  const actorA = await createActor({
    id: "actor-a",
    workspace: join(repoRoot, "workspaces", "actor-a"),
    runtimeRoot: join(repoRoot, ".runtime", "actor-a"),
    modelRuntime,
    model,
  });
  const actorB = await createActor({
    id: "actor-b",
    workspace: join(repoRoot, "workspaces", "actor-b"),
    runtimeRoot: join(repoRoot, ".runtime", "actor-b"),
    modelRuntime,
    model,
  });

  console.log("=== ISOLATION AUDIT ===");
  printAudit(actorA);
  printAudit(actorB);
  console.log(`  context window: ${CONTEXT_WINDOW}`);

  const wallStartedAt = performance.now();
  const outcomes = await Promise.all([
    runActor(actorA, taskA),
    runActor(actorB, taskB),
  ]);
  const verifications = new Map<string, Verification>([
    ["actor-a", await verifyActor(actorA, "fib.py")],
    ["actor-b", await verifyActor(actorB, "prime.py")],
  ]);
  printResult(outcomes, verifications, performance.now() - wallStartedAt);

  const allSuccessful =
    outcomes.every((outcome) => outcome.status === "success") &&
    [...verifications.values()].every((verification) =>
      verification.status === "passed"
    );
  if (!allSuccessful) Deno.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`PoC failed: ${formatError(error)}`);
  Deno.exitCode = 1;
}
