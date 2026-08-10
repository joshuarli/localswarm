import { Buffer } from "node:buffer";
import {
  type AgentSession,
  createAgentSession,
  createEditToolDefinition,
  createExtensionRuntime,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type EditOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export interface ActorConfig {
  id: string;
  workspace: string;
  runtimeRoot: string;
  modelRuntime: ModelRuntime;
  model: Model<"openai-completions">;
  /**
   * Explicit tool allowlist for this workload. Omitting it keeps the full
   * sterile coding surface used by the two-actor PoC.
   */
  toolNames?: readonly ActorToolName[];
  /** Stop the model turn immediately after the required Python test passes. */
  stopAfterSuccessfulTest?: boolean;
}

export type ActorToolName =
  | "ls"
  | "read"
  | "write"
  | "edit"
  | "write_interval_files"
  | "run_python_test";

export interface Actor {
  config: ActorConfig;
  session: AgentSession;
  toolNames: readonly ActorToolName[];
  hasSuccessfulTest: () => boolean;
}

const ALL_TOOL_NAMES = [
  "ls",
  "read",
  "write",
  "edit",
  "run_python_test",
] as const satisfies readonly ActorToolName[];

const CODING_COMPLETION_GUIDANCE = `Coding-task completion discipline:
- Use paths relative to the actor workspace when calling workspace tools; do not pass absolute host paths.
- Start with the first requested write; do not inspect or list the workspace when the task already specifies the files.
- Follow the requested tool order, keep reasoning and tool arguments concise, and make the smallest necessary number of tool calls.
- When the required test returns exit code 0, the task is complete. Stop using tools immediately and give a brief final response.
- Do not reread files, repeat a passing test, or perform extra verification after that successful result.`;

/**
 * A ResourceLoader with no discovery code at all. In particular, this is not
 * DefaultResourceLoader: no cwd ancestor, agent directory, or host home path
 * is inspected for Pi resources.
 */
function createSterileResourceLoader(): ResourceLoader {
  const extensions = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };

  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    // `undefined` tells Pi to build its built-in system prompt, including the
    // selected tools and their prompt snippets. Only host-loaded custom
    // prompt resources are suppressed here.
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    // This is a small harness-level completion policy, not a replacement for
    // Pi's built-in system prompt. It prevents coding agents from turning a
    // verified result into an unbounded read/retry loop.
    getAppendSystemPrompt: () => [CODING_COMPLETION_GUIDANCE],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

class WorkspacePathPolicy {
  constructor(private readonly root: string) {}

  private assertInside(candidate: string): string {
    const path = resolve(candidate);
    const pathFromRoot = relative(this.root, path);
    if (
      pathFromRoot === "" ||
      (pathFromRoot !== ".." &&
        !pathFromRoot.startsWith(`..${sep}`) &&
        !isAbsolute(pathFromRoot))
    ) {
      return path;
    }
    throw new Error(`Path is outside the actor workspace: ${candidate}`);
  }

  private async canonicalExisting(path: string): Promise<string> {
    const resolved = this.assertInside(path);
    const canonical = await Deno.realPath(resolved);
    return this.assertInside(canonical);
  }

  /** Resolve a path whose final component may not exist yet. */
  private async canonicalForCreation(path: string): Promise<string> {
    let current = this.assertInside(path);
    const missingComponents: string[] = [];

    while (true) {
      try {
        // Walk upward one directory at a time so symlink checks cover every
        // existing ancestor before reconstructing the creatable path.
        // oxlint-disable-next-line no-await-in-loop
        const canonicalBase = await Deno.realPath(current);
        const candidate = join(canonicalBase, ...missingComponents.toReversed());
        return this.assertInside(candidate);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
        const parent = dirname(current);
        if (parent === current) {
          throw error;
        }
        missingComponents.push(basename(current));
        current = parent;
      }
    }
  }

  async existing(path: string): Promise<string> {
    return await this.canonicalExisting(path);
  }

  async creatable(path: string): Promise<string> {
    return await this.canonicalForCreation(path);
  }
}

function textResult(text: string, details: unknown = {}): {
  content: [{ type: "text"; text: string }];
  details: unknown;
} {
  return { content: [{ type: "text", text }], details };
}

function createWorkspaceToolDefinitions(
  workspace: string,
  workspaceRoot: string,
  selectedToolNames: readonly ActorToolName[],
  onSuccessfulTest: () => void,
): ToolDefinition[] {
  const policy = new WorkspacePathPolicy(workspaceRoot);

  const readOperations: ReadOperations = {
    readFile: async (path) =>
      Buffer.from(await Deno.readFile(await policy.existing(path))),
    access: async (path) => {
      await Deno.stat(await policy.existing(path));
    },
  };

  const writeOperations: WriteOperations = {
    writeFile: async (path, content) => {
      const safePath = await policy.creatable(path);
      await Deno.writeTextFile(safePath, content);
    },
    mkdir: async (path) => {
      await Deno.mkdir(await policy.creatable(path), { recursive: true });
    },
  };

  const editOperations: EditOperations = {
    readFile: async (path) =>
      Buffer.from(await Deno.readFile(await policy.existing(path))),
    writeFile: async (path, content) => {
      await Deno.writeTextFile(await policy.creatable(path), content);
    },
    access: async (path) => {
      await Deno.stat(await policy.existing(path));
    },
  };

  const lsOperations: LsOperations = {
    exists: async (path) => {
      try {
        await policy.existing(path);
        return true;
      } catch {
        return false;
      }
    },
    stat: async (path) => {
      const info = await Deno.stat(await policy.existing(path));
      return { isDirectory: () => info.isDirectory };
    },
    readdir: async (path) => {
      const safePath = await policy.existing(path);
      const entries: string[] = [];
      for await (const entry of Deno.readDir(safePath)) {
        entries.push(entry.name);
      }
      return entries;
    },
  };

  const runPythonTest = defineTool({
    name: "run_python_test",
    label: "Run Python test",
    description:
      "Run one Python test file inside this actor workspace with python3 and the standard library only.",
    promptSnippet: "Run a Python test in the actor workspace",
    parameters: Type.Object({
      path: Type.String({
        description: "Relative path to the test Python file",
      }),
    }),
    execute: async (_toolCallId, params, signal) => {
      // Pi may execute a model-emitted batch of write and test calls
      // concurrently. Allow a test call to observe a sibling write that is
      // already in flight instead of turning that valid batch into a race.
      let safePath: string | undefined;
      let lastError: unknown;
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        try {
          // The write and test calls may be concurrent; each retry must observe
          // the previous filesystem state before checking again.
          // oxlint-disable-next-line no-await-in-loop
          safePath = await policy.existing(join(workspaceRoot, params.path));
          break;
        } catch (error) {
          lastError = error;
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          // oxlint-disable-next-line no-await-in-loop
          await new Promise((wake) => setTimeout(wake, 50));
        }
      }
      if (!safePath) {
        throw lastError ?? new Error(`Test file not found: ${params.path}`);
      }
      if (!safePath.endsWith(".py")) {
        throw new Error("run_python_test only accepts .py files");
      }

      const relativePath = relative(workspaceRoot, safePath);
      const child = new Deno.Command("python3", {
        args: [relativePath],
        cwd: workspaceRoot,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const stopChild = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have exited between abort and kill.
        }
      };
      signal?.addEventListener("abort", stopChild, { once: true });
      const timeout = setTimeout(stopChild, 30_000);
      try {
        const output = await child.output();
        const stdout = new TextDecoder().decode(output.stdout);
        const stderr = new TextDecoder().decode(output.stderr);
        const text = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
        if (output.code === 0) onSuccessfulTest();
        return textResult(
          `${text || "(no output)"}\nexit code: ${output.code}`,
          { exitCode: output.code },
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", stopChild);
      }
    },
  });

  const writeIntervalFiles = defineTool({
    name: "write_interval_files",
    label: "Write interval files",
    description:
      "Write the two files required by the interval-merger task in one coding step. The implementation becomes intervals.py and the tests become test_intervals.py.",
    promptSnippet: "Write intervals.py and test_intervals.py",
    parameters: Type.Object({
      implementation: Type.String({
        description: "Complete contents for intervals.py",
      }),
      tests: Type.String({
        description: "Complete contents for test_intervals.py",
      }),
    }),
    execute: async (_toolCallId, params) => {
      await Deno.writeTextFile(
        await policy.creatable(join(workspaceRoot, "intervals.py")),
        params.implementation,
      );
      await Deno.writeTextFile(
        await policy.creatable(join(workspaceRoot, "test_intervals.py")),
        params.tests,
      );
      return textResult("Successfully wrote intervals.py and test_intervals.py", {
        paths: ["intervals.py", "test_intervals.py"],
      });
    },
  });

  const allTools = [
    createLsToolDefinition(workspace, { operations: lsOperations }),
    createReadToolDefinition(workspace, { operations: readOperations }),
    createWriteToolDefinition(workspace, { operations: writeOperations }),
    createEditToolDefinition(workspace, { operations: editOperations }),
    writeIntervalFiles,
    runPythonTest,
  ];
  // Pi's customTools API erases each schema to a heterogeneous ToolDefinition
  // array. Every member here is constructed by Pi's own tool factories or the
  // typed definitions above, so this cast is limited to that API boundary.
  return allTools.filter(({ name }) =>
    selectedToolNames.includes(name as ActorToolName)
  ) as unknown as ToolDefinition[];
}

export async function createActor(config: ActorConfig): Promise<Actor> {
  const configRoot = join(config.runtimeRoot, "config");
  const stateRoot = join(config.runtimeRoot, "state");
  const sessionRoot = join(config.runtimeRoot, "sessions");
  await Promise.all([
    Deno.mkdir(config.workspace, { recursive: true }),
    Deno.mkdir(configRoot, { recursive: true }),
    Deno.mkdir(stateRoot, { recursive: true }),
    Deno.mkdir(sessionRoot, { recursive: true }),
  ]);

  const workspaceRoot = await Deno.realPath(config.workspace);
  const toolNames = [...(config.toolNames ?? ALL_TOOL_NAMES)];
  let successfulTest = false;
  let stopSession: (() => void) | undefined;
  const sessionManager = SessionManager.create(workspaceRoot, sessionRoot);
  const settingsManager = SettingsManager.inMemory({
    defaultThinkingLevel: "high",
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = createSterileResourceLoader();
  const customTools = createWorkspaceToolDefinitions(
    config.workspace,
    workspaceRoot,
    toolNames,
    () => {
      successfulTest = true;
      if (config.stopAfterSuccessfulTest) {
        // Let Pi finish recording the tool result before stopping the next
        // model turn. The benchmark treats this controlled abort as success.
        setTimeout(() => stopSession?.(), 50);
      }
    },
  );

  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    agentDir: configRoot,
    modelRuntime: config.modelRuntime,
    model: config.model,
    thinkingLevel: "high",
    tools: [...toolNames],
    customTools,
    resourceLoader,
    settingsManager,
    sessionManager,
  });

  stopSession = () => void session.abort();
  return {
    config,
    session,
    toolNames,
    hasSuccessfulTest: () => successfulTest,
  };
}
