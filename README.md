# Minimal two-agent Pi + vLLM-Metal PoC

## Architecture

Two independent Pi SDK agent instances share one vLLM-Metal inference server at
`http://127.0.0.1:8000/v1`. The controller creates both agents in Deno and
starts their prompts concurrently; the model is loaded once by the separately
running vLLM server. Agents use a 32,768-token context window and high
reasoning. The default model is `Qwen/Qwen3-1.7B`; set
`LOCAL_VLLM_MODEL_ID` to benchmark another model without changing the harness.

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

High-thinking mode is selected through Pi's `thinkingLevel: "high"` and the
model-specific compatibility profile; no reasoning directive is embedded in
user prompts. Qwen models use vLLM's `enable_thinking` request parameter.

The tested model profiles are model-specific: Qwen3.5 uses its Qwen thinking
format and calibrated sampling, while GLM-4.7-Flash uses its chat-template
thinking flags, preserved thinking history, `temperature=0.7`, `top_p=1.0`, and
a 16,384-token output limit for coding work. The GLM profile uses vLLM's
`glm47` tool parser and `glm45` reasoning parser.

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

For the tested alternatives, start vLLM with the matching parser configuration:

```bash
# Qwen3.5-9B, including the OptiQ checkpoint
vllm serve mlx-community/Qwen3.5-9B-4bit \
  --host 127.0.0.1 --port 8000 --max-model-len 32768 \
  --language-model-only --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder --reasoning-parser qwen3

# GLM-4.7-Flash (30B-A3B sparse MoE)
vllm serve mlx-community/GLM-4.7-Flash-4bit \
  --host 127.0.0.1 --port 8000 --max-model-len 32768 \
  --language-model-only --enable-auto-tool-choice \
  --tool-call-parser glm47 --reasoning-parser glm45
```

Then select the model in the controller, for example:

```bash
LOCAL_VLLM_MODEL_ID=mlx-community/GLM-4.7-Flash-4bit \
  deno task benchmark --levels=1,2,3 --timeout-seconds=300 --keep
```

## Current observed ceiling

On the Apple M1 Max with 64 GB RAM, using vLLM-Metal, a 32,768-token context,
high thinking, the full Pi system/tool prompt, and a 300-second per-session
deadline, the independent interval-merging programming workload produced:

| Model | c1 | c2 | c3 | Reliable coding ceiling |
| --- | ---: | ---: | ---: | ---: |
| `mlx-community/Qwen3.5-9B-4bit` | Pass, 127s | Pass, 231s | Fail, 300s | **2** |
| `mlx-community/Qwen3.5-9B-OptiQ-4bit` | Pass, 173s | Pass, 286s | Fail, 300s | **2** |
| `mlx-community/GLM-4.7-Flash-4bit` | Fail, 300s | not run | not run | **0** |

The current practical ceiling is therefore **2 simultaneous full coding
sessions** with the two Qwen3.5-9B checkpoints. OptiQ is a calibrated
mixed-precision variant of the same base model; it did not improve the
concurrency ceiling in this workload. GLM-4.7-Flash is a 30B-A3B sparse MoE:
vLLM-metal loaded it successfully and parsed tool calls, but the high-thinking
coding agent did not complete one reliable session within the deadline.

As a serving-capacity control, GLM passed the deterministic `READY` workload at
1, 2, 4, 8, 12, 16, 18, and 20 concurrent Pi sessions. These are short
requests and do not reserve a full 32,768-token KV sequence per session, so they
must not be interpreted as 20 full coding workers. vLLM reported 608,176 KV
tokens for GLM, or a theoretical **18.56** full-length requests. The
corresponding figures were 1,286,888 tokens / **39.27** requests for stock
Qwen3.5-9B and 1,228,303 / **37.48** for OptiQ. The gap between these cache
figures and the coding ceiling is model/tool-turn quality and decode
throughput, not a RAM OOM.

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
inference server, not loading additional copies of the selected model. With a
32k context target, vLLM's KV cache and decode throughput—not the number of
Deno actor objects—are the expected first capacity constraints. Sparse MoE
reduces active compute, but the full model weights and model-specific backend
support still matter; GLM fit in memory here without translating that into a
reliable coding-worker gain.
