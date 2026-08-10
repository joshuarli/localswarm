# Minimal two-agent Pi + vLLM-Metal PoC

## Architecture

Two independent Pi SDK agent instances share one `Qwen/Qwen3-1.7B` vLLM-Metal inference server at `http://127.0.0.1:8000/v1`. The controller creates both agents in Deno and starts their prompts concurrently; the model is loaded once by the separately running vLLM server.

Pi host configuration is intentionally not loaded. Every agent receives a project-defined sterile configuration: an in-memory `ModelRuntime` credential store with `modelsPath: null`, an in-memory `SettingsManager`, a no-discovery `ResourceLoader`, an explicit workspace, and a separate session directory under `.runtime/<actor>/sessions`. No `DefaultResourceLoader` or default Pi directory is instantiated.

The agents receive only Pi's `ls`, `read`, `write`, and `edit` tools with workspace-bound filesystem operations, plus a wrapper that runs one `python3` test inside that workspace. The wrappers reject paths that escape the workspace, including symlink escapes. Skills, extensions, prompts, and host sessions are absent.

Qwen3 non-thinking mode is enforced by Pi's OpenAI-compatible `samplingParams: { enable_thinking: false }`, which vLLM accepts directly; no `/no_think` prompt text is used.

## Running

Assuming vLLM-Metal is already serving the required model:

```bash
deno task poc
```

The controller does not start vLLM or create another model instance.

## Expected result

Actor A creates and tests `workspaces/actor-a/fib.py`; actor B creates and tests `workspaces/actor-b/prime.py`. The controller runs each discovered test independently after both Pi sessions finish and prints per-actor lifecycle, usage, and verification results.

## Isolation

Isolation is explicit rather than inferred from the process working directory:

- `ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })` prevents auth and model-file loading. The local provider is registered only on that runtime.
- Each session gets `SettingsManager.inMemory()`, `SessionManager.create(workspace, .runtime/<actor>/sessions)`, and its own runtime/config/state directories.
- Each session gets a sterile resource loader whose getters return empty resources and whose `reload()` is a no-op. It never walks the workspace, repository, `~/.pi`, or any other host path.
- Each native filesystem tool is supplied with operations that canonicalize and check every path against the actor workspace. The test wrapper runs only `python3 <relative-python-file>` with that workspace as its cwd.

Deleting or radically changing `~/.pi` therefore has zero effect on this PoC.

## Scaling

Scaling 2 → 20 actors initially means constructing additional isolated Pi SDK agents against the same inference server, not loading additional copies of `Qwen/Qwen3-1.7B`.
