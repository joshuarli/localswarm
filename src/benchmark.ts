import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Actor,
  type ActorToolName,
  createActor,
} from "./actor.ts";
import {
  createLocalVllmProvider,
  MODEL_ID,
  VLLM_BASE_URL,
} from "./provider.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const decoder = new TextDecoder();
const activeSessions = new Set<Actor["session"]>();
let observedActiveSessions = 0;
let maxObservedActiveSessions = 0;

type Workload = "programming" | "ready";

const readyTask =
  "Reply with exactly READY and no additional text. Do not call any tools.";

// The programming task's contract requires one multi-file write and the test runner.
// Keeping discovery/edit tools out of this session is intentional: their
// schemas become prompt tokens and invite extra turns without adding a needed
// capability to this fixed workload.
const programmingToolNames = [
  "write_interval_files",
  "run_python_test",
] as const satisfies
  readonly ActorToolName[];

const programmingTask =
  `Work only inside this actor workspace. Implement and test an inclusive integer interval merger in Python using only the standard library.

Write intervals.py with merge_intervals(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]. It must return a new list sorted by start, merge overlapping intervals and adjacent integer intervals ([1,2] with [3,4]), leave a one-integer gap unmerged ([1,2] with [4,5]), preserve the input, and raise ValueError when start > end.

Write test_intervals.py importing with "from intervals import merge_intervals". Test exactly: unsorted chained [(5,7),(1,2),(3,4)] -> [(1,7)]; overlapping [(1,10),(2,6),(8,12)] -> [(1,12)]; adjacent [(1,2),(3,4)] -> [(1,4)]; gap [(1,2),(4,5)] unchanged; negative [(-10,-8),(-5,-1)] unchanged; empty input; input immutability; and [(2,1)] raises ValueError. Use no third-party packages.

Keep both source strings concise: no docstrings, comments, explanatory prose, or extra tests. Do not preamble, inspect, reread, or add extra verification. Call write_interval_files once with the complete implementation and test source strings and wait for its successful result. Then call run_python_test with path "test_intervals.py". Stop immediately after exit code 0; only fix a failure if the test reports one.`;

const controllerVerification = `
from intervals import merge_intervals


def check(actual, expected):
    assert actual == expected, f"expected {expected!r}, got {actual!r}"


original = [(5, 7), (1, 2), (3, 4), (10, 12), (11, 15)]
snapshot = list(original)
check(merge_intervals(original), [(1, 7), (10, 15)])
assert original == snapshot, "merge_intervals mutated its input"
check(merge_intervals([(-10, -8), (-5, -1)]), [(-10, -8), (-5, -1)])
check(merge_intervals([(1, 2), (3, 4)]), [(1, 4)])
check(merge_intervals([(1, 2), (4, 5)]), [(1, 2), (4, 5)])
check(merge_intervals([]), [])

try:
    merge_intervals([(2, 1)])
except ValueError:
    pass
else:
    raise AssertionError("invalid intervals must raise ValueError")
`;

interface TokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface SessionOutcome {
  id: string;
  status: "success" | "failure";
  elapsedMs: number;
  tokens: TokenStats;
  error?: string;
}

interface WaveResult {
  concurrency: number;
  repeat: number;
  wallElapsedMs: number;
  outcomes: SessionOutcome[];
  completed: number;
  maxObservedActiveSessions: number;
}

interface BenchmarkOptions {
  workload: Workload;
  levels: number[];
  repeats: number;
  timeoutMs: number;
  keepArtifacts: boolean;
  staggerMs: number;
  admissionConcurrency: number;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptions(args: string[]): BenchmarkOptions {
  const getValue = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  };

  const levels = (getValue("levels") ?? "1,2,4,6,8")
    .split(",")
    .map((value) => parsePositiveInteger(value, "levels"));
  const uniqueLevels = [...new Set(levels)].sort((a, b) => a - b);
  const workload = getValue("workload") ?? "programming";
  if (workload !== "programming" && workload !== "ready") {
    throw new Error(`--workload must be programming or ready`);
  }
  const repeats = parsePositiveInteger(getValue("repeats") ?? "1", "repeats");
  const timeoutSeconds = parsePositiveInteger(
    getValue("timeout-seconds") ?? "300",
    "timeout-seconds",
  );
  const staggerMs = parseNonNegativeInteger(
    getValue("stagger-ms") ?? "0",
    "stagger-ms",
  );
  const admissionConcurrency = parseNonNegativeInteger(
    getValue("admission-concurrency") ?? "0",
    "admission-concurrency",
  );

  return {
    workload,
    levels: uniqueLevels,
    repeats,
    timeoutMs: timeoutSeconds * 1_000,
    keepArtifacts: args.includes("--keep"),
    staggerMs,
    admissionConcurrency,
  };
}

function taskFor(workload: Workload): string {
  return workload === "programming" ? programmingTask : readyTask;
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

async function runPythonTest(
  workspace: string,
  testFile: string,
): Promise<string | undefined> {
  const child = new Deno.Command("python3", {
    args: [testFile],
    cwd: workspace,
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

async function runControllerVerification(
  workspace: string,
): Promise<string | undefined> {
  const child = new Deno.Command("python3", {
    args: ["-c", controllerVerification],
    cwd: workspace,
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

async function verifyProgrammingWorkspace(
  workspace: string,
): Promise<string | undefined> {
  for (const file of ["intervals.py", "test_intervals.py"]) {
    try {
      if (!(await Deno.stat(join(workspace, file))).isFile) {
        return `${file} is not a file`;
      }
    } catch (error) {
      return formatError(error);
    }
  }
  const modelTests = await runPythonTest(workspace, "test_intervals.py");
  if (modelTests) return `model tests: ${modelTests}`;
  const controllerTests = await runControllerVerification(workspace);
  return controllerTests ? `controller tests: ${controllerTests}` : undefined;
}

async function runSession(
  actor: Actor,
  task: string,
  timeoutMs: number,
  stopAfterSuccessfulTest: boolean,
): Promise<SessionOutcome> {
  const startedAt = performance.now();
  let status: SessionOutcome["status"] = "success";
  let error: string | undefined;
  activeSessions.add(actor.session);
  observedActiveSessions += 1;
  maxObservedActiveSessions = Math.max(
    maxObservedActiveSessions,
    observedActiveSessions,
  );

  const timeout = setTimeout(() => {
    void actor.session.abort();
  }, timeoutMs);
  try {
    await actor.session.prompt(task, {
      expandPromptTemplates: false,
    });
    const lastAssistant = [...actor.session.messages]
      .reverse()
      .find((message) => message.role === "assistant") as
        | { stopReason?: string; errorMessage?: string }
        | undefined;
    const successfulTest = stopAfterSuccessfulTest &&
      actor.hasSuccessfulTest();
    if (
      (!successfulTest && lastAssistant?.stopReason === "error") ||
      (!successfulTest && lastAssistant?.stopReason === "aborted")
    ) {
      status = "failure";
      error = lastAssistant.errorMessage ??
        `assistant stopped with ${lastAssistant.stopReason}`;
    }
  } catch (caught) {
    if (!(stopAfterSuccessfulTest && actor.hasSuccessfulTest())) {
      status = "failure";
      error = formatError(caught);
    }
  } finally {
    clearTimeout(timeout);
    activeSessions.delete(actor.session);
    observedActiveSessions -= 1;
  }

  const stats = actor.session.getSessionStats();
  actor.session.dispose();
  return {
    id: actor.config.id,
    status,
    elapsedMs: performance.now() - startedAt,
    tokens: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
    },
    ...(error ? { error } : {}),
  };
}

function createAdmissionLimiter(limit: number): {
  acquire: () => Promise<() => void>;
} {
  let available = limit;
  const waiters: Array<() => void> = [];
  return {
    acquire: async () => {
      if (available > 0) {
        available -= 1;
      } else {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = waiters.shift();
        if (next) next();
        else available += 1;
      };
    },
  };
}

async function createWaveActors(
  root: string,
  concurrency: number,
  modelRuntime: Parameters<typeof createActor>[0]["modelRuntime"],
  model: Parameters<typeof createActor>[0]["model"],
  toolNames: readonly ActorToolName[] | undefined,
): Promise<Actor[]> {
  return await Promise.all(
    Array.from({ length: concurrency }, (_, index) => {
      const id = `actor-${index + 1}`;
      return createActor({
        id,
        workspace: join(root, "workspaces", id),
        runtimeRoot: join(root, "runtime", id),
        modelRuntime,
        model,
        ...(toolNames
          ? { toolNames, stopAfterSuccessfulTest: true }
          : {}),
      });
    }),
  );
}

async function runWave(
  root: string,
  concurrency: number,
  repeat: number,
  modelRuntime: Parameters<typeof createActor>[0]["modelRuntime"],
  model: Parameters<typeof createActor>[0]["model"],
  workload: Workload,
  timeoutMs: number,
  staggerMs: number,
  admissionConcurrency: number,
): Promise<WaveResult> {
  observedActiveSessions = 0;
  maxObservedActiveSessions = 0;
  const actors = await createWaveActors(
    root,
    concurrency,
    modelRuntime,
    model,
    workload === "programming" ? programmingToolNames : undefined,
  );
  const admission = createAdmissionLimiter(
    admissionConcurrency > 0
      ? Math.min(admissionConcurrency, concurrency)
      : concurrency,
  );
  const startedAt = performance.now();
  const outcomes = await Promise.all(
    actors.map(async (actor, index) => {
      if (index > 0 && staggerMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, index * staggerMs)
        );
      }
      const release = await admission.acquire();
      try {
        return await runSession(
          actor,
          taskFor(workload),
          timeoutMs,
          workload === "programming",
        );
      } finally {
        release();
      }
    }),
  );
  if (workload === "programming") {
    for (const actor of actors) {
      const outcome = outcomes.find((candidate) =>
        candidate.id === actor.config.id
      );
      if (!outcome || outcome.status === "failure") continue;
      const failure = await verifyProgrammingWorkspace(actor.config.workspace);
      if (failure) {
        outcome.status = "failure";
        outcome.error = `verification: ${failure}`;
      }
    }
  }
  return {
    concurrency,
    repeat,
    wallElapsedMs: performance.now() - startedAt,
    outcomes,
    completed: outcomes.filter((outcome) => outcome.status === "success")
      .length,
    maxObservedActiveSessions,
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function printWave(result: WaveResult): void {
  const successful =
    result.outcomes.filter((outcome) => outcome.status === "success").length;
  const durations = result.outcomes.map((outcome) => outcome.elapsedMs);
  const outputTokens = result.outcomes.reduce(
    (sum, outcome) => sum + outcome.tokens.output,
    0,
  );
  const status = successful === result.concurrency &&
      result.completed === result.concurrency
    ? "PASS"
    : "FAIL";
  console.log(
    `${status} concurrency=${result.concurrency} repeat=${result.repeat}` +
      ` wall=${(result.wallElapsedMs / 1_000).toFixed(1)}s` +
      ` session_p50=${(percentile(durations, 0.50) / 1_000).toFixed(1)}s` +
      ` session_p95=${(percentile(durations, 0.95) / 1_000).toFixed(1)}s` +
      ` sessions_per_s=${
        (successful / (result.wallElapsedMs / 1_000)).toFixed(2)
      }` +
      ` output_tokens=${outputTokens}` +
      ` active_peak=${result.maxObservedActiveSessions}`,
  );
  for (
    const outcome of result.outcomes.filter((candidate) =>
      candidate.status === "failure"
    )
  ) {
    console.log(`  ${outcome.id}: ${outcome.error ?? "unknown failure"}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(Deno.args);
  Deno.addSignalListener("SIGINT", () => {
    for (const session of activeSessions) void session.abort();
  });

  await verifyServer();
  const { modelRuntime, model } = await createLocalVllmProvider();
  const runRoot = join(
    repoRoot,
    ".runtime",
    "concurrency-benchmark",
    `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
  );
  await Deno.mkdir(runRoot, { recursive: true });

  console.log("=== CONCURRENCY BENCHMARK ===");
  console.log(`model: ${MODEL_ID}`);
  console.log(`endpoint: ${VLLM_BASE_URL}`);
  console.log(`workload: ${options.workload}`);
  console.log(`levels: ${options.levels.join(", ")}`);
  console.log(`repeats: ${options.repeats}`);
  console.log(`prompt stagger: ${options.staggerMs}ms`);
  console.log(
    `session admission: ${options.admissionConcurrency > 0
      ? options.admissionConcurrency
      : "unbounded"}`,
  );
  console.log(
    options.workload === "programming"
      ? "each session: interval merger, one interval-file write, and one test"
      : "each session: isolated Pi state and one deterministic response",
  );

  const results: WaveResult[] = [];
  let stoppedAfterFailure = false;
  try {
    for (const concurrency of options.levels) {
      for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
        const waveRoot = join(runRoot, `c${concurrency}-r${repeat}`);
        const result = await runWave(
          waveRoot,
          concurrency,
          repeat,
          modelRuntime,
          model,
          options.workload,
          options.timeoutMs,
          options.staggerMs,
          options.admissionConcurrency,
        );
        results.push(result);
        printWave(result);
        if (result.outcomes.some((outcome) => outcome.status === "failure")) {
          console.log("Stopping after the first failed concurrency level.");
          stoppedAfterFailure = true;
          break;
        }
      }
      if (stoppedAfterFailure) break;
    }
  } finally {
    if (!options.keepArtifacts) {
      await Deno.remove(runRoot, { recursive: true });
    } else {
      console.log(`artifacts: ${relative(repoRoot, runRoot)}`);
    }
  }

  const stable = results.filter((result) =>
    result.outcomes.every((outcome) => outcome.status === "success") &&
    result.completed === result.concurrency
  );
  const maxStable = stable.reduce(
    (maximum, result) => Math.max(maximum, result.concurrency),
    0,
  );
  console.log("\n=== SUMMARY ===");
  console.log(`max stable observed concurrency: ${maxStable}`);
  console.log(
    "This is the number of simultaneous Pi sessions sharing one model replica; " +
      "repeat with a higher --levels value to probe beyond the default sweep.",
  );
}

try {
  await main();
} catch (error) {
  console.error(`Benchmark failed: ${formatError(error)}`);
  Deno.exitCode = 1;
}
