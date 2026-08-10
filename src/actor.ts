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
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type {
  EditOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
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
}

export interface Actor {
  config: ActorConfig;
  session: AgentSession;
  toolNames: readonly string[];
}

const TOOL_NAMES = ["ls", "read", "write", "edit", "run_python_test"] as const;

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
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
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
        const canonicalBase = await Deno.realPath(current);
        const candidate = join(canonicalBase, ...missingComponents.reverse());
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
): ToolDefinition<any, any, any>[] {
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
      const safePath = await policy.existing(join(workspaceRoot, params.path));
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

  return [
    createLsToolDefinition(workspace, { operations: lsOperations }),
    createReadToolDefinition(workspace, { operations: readOperations }),
    createWriteToolDefinition(workspace, { operations: writeOperations }),
    createEditToolDefinition(workspace, { operations: editOperations }),
    runPythonTest,
  ];
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
  const sessionManager = SessionManager.create(workspaceRoot, sessionRoot);
  const settingsManager = SettingsManager.inMemory({
    defaultThinkingLevel: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = createSterileResourceLoader();
  const customTools = createWorkspaceToolDefinitions(
    config.workspace,
    workspaceRoot,
  );

  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    agentDir: configRoot,
    modelRuntime: config.modelRuntime,
    model: config.model,
    thinkingLevel: "off",
    tools: [...TOOL_NAMES],
    customTools,
    resourceLoader,
    settingsManager,
    sessionManager,
  });

  return { config, session, toolNames: TOOL_NAMES };
}
