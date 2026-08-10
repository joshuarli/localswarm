# Minimal two-agent Pi + vLLM-Metal PoC

## Architecture

Two independent Pi SDK agent instances share one `Qwen/Qwen3-1.7B` vLLM-Metal
inference server at `http://127.0.0.1:8000/v1`. The controller creates both
agents in Deno and starts their prompts concurrently; the model is loaded once
by the separately running vLLM server. Agents use a 32,768-token context window
and high reasoning.

Pi host configuration is intentionally not loaded. Every agent receives a
project-defined sterile configuration: an in-memory `ModelRuntime` credential
store with `modelsPath: null`, an in-memory `SettingsManager`, a no-discovery
`ResourceLoader`, an explicit workspace, and a separate session directory under
`.runtime/<actor>/sessions`. No `DefaultResourceLoader` or default Pi directory
is instantiated.

The agents receive only Pi's `ls`, `read`, `write`, and `edit` tools with
workspace-bound filesystem operations, plus a wrapper that runs one `python3`
test inside that workspace. The wrappers reject paths that escape the workspace,
including symlink escapes. Host-loaded skills, extensions, prompt templates, and
sessions are absent; Pi's built-in system prompt and selected-tool snippets are
still present.

Qwen3 high-thinking mode is selected through Pi's `thinkingLevel: "high"`, the
Qwen compatibility mode, and vLLM's `enable_thinking` request parameter; no
reasoning directive is embedded in user prompts.

For the base Qwen3 model, use vLLM's Hermes parser. Qwen3-1.7B emits the
Hermes-style JSON tool-call envelope; `qwen3_xml` is intended for Qwen3-Coder
models and does not parse this model's calls:

```bash
vllm serve Qwen/Qwen3-1.7B \
  --host 127.0.0.1 \
  --port 8000 \
  --max-model-len 32768 \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --reasoning-parser qwen3
```

## Running

Assuming vLLM-Metal is already serving the required model:

```bash
deno task poc
```

The controller does not start vLLM or create another model instance.

To measure the session concurrency this server can sustain:

```bash
deno task benchmark
```

The benchmark uses one shared model replica and a fresh isolated workspace per
session. By default each session implements and tests an interval-merging
utility, exercising high reasoning, filesystem tools, test execution, and
multiple sequential Pi turns. It sweeps 1, 2, 4, 6, 8, 10, 12, 14, and 16
concurrent sessions, stopping at the first failed level. Use `--workload=ready`
for a deterministic session-overhead control, `--repeats=2` for repeated runs,
or `--levels=12,14,16` to probe the boundary. The reported maximum is an
empirical session-workload result, not a vLLM capacity guarantee.

## Expected result

Actor A creates and tests `workspaces/actor-a/fib.py`; actor B creates and tests
`workspaces/actor-b/prime.py`. The controller runs each discovered test
independently after both Pi sessions finish and prints per-actor lifecycle,
usage, and verification results.

## Isolation

Isolation is explicit rather than inferred from the process working directory:

- `ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })`
  prevents auth and model-file loading. The local provider is registered only on
  that runtime.
- Each session gets `SettingsManager.inMemory()`,
  `SessionManager.create(workspace, .runtime/<actor>/sessions)`, and its own
  runtime/config/state directories.
- Each session gets a sterile resource loader whose getters return empty
  resources and whose `reload()` is a no-op. It never walks the workspace,
  repository, `~/.pi`, or any other host path.
- Each native filesystem tool is supplied with operations that canonicalize and
  check every path against the actor workspace. The test wrapper runs only
  `python3 <relative-python-file>` with that workspace as its cwd.

Deleting or radically changing `~/.pi` therefore has zero effect on this PoC.

## Scaling

Scaling means constructing additional isolated Pi SDK agents against the same
inference server, not loading additional copies of `Qwen/Qwen3-1.7B`. With a 32k
context target, vLLM's KV cache—not the number of Deno actor objects—is the
expected first capacity constraint.
