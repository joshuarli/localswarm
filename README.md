# Minimal Pi concurrency harness for vLLM-Metal and oMLX

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
still present. The sterile loader also appends a small coding completion policy:
use workspace-relative paths, follow the requested tool order, and stop
immediately after a required test returns exit code 0. This preserves Pi's
built-in prompt while preventing a verified task from turning into an
unnecessary reread/retry loop.

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
`--stagger-ms=1000` to spread prompt admission across a wave, or
`--levels=12,14,16` to probe the boundary. The reported maximum is an
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

### oMLX and Laguna XS 2.1

oMLX serves the MLX checkpoint natively through its continuous-batching
`BatchedEngine`. Install oMLX and download the 5-bit Laguna checkpoint with:

```bash
brew tap jundot/omlx https://github.com/jundot/omlx
brew install omlx
uvx --from huggingface-hub hf download \
  mlx-community/Laguna-XS-2.1-5bit \
  --local-dir ~/.omlx/models/Laguna-XS-2.1-5bit
```

Start the server with a request cap appropriate to the wave being measured:

```bash
omlx serve \
  --model-dir ~/.omlx/models \
  --host 127.0.0.1 --port 8000 \
  --max-concurrent-requests 16 \
  --memory-guard-gb 56 \
  --no-cache
```

`--no-cache` disables oMLX's paged SSD/prefix cache; it does not disable
MLX-LM continuous batching. Laguna's checkpoint metadata advertises a DFlash
speculative configuration, but oMLX's default setting is DFlash disabled. The
experiment log confirmed `BatchedEngine loaded`, with no DFlash engine. The
Laguna provider keeps the 32,768-token context and high thinking, but caps
per-request generation at 4,096 tokens because this coding task completes in a
few thousand output tokens and a smaller cap leaves more KV room for batching.
Select Laguna in the Pi harness as follows:

```bash
LOCAL_VLLM_MODEL_ID=Laguna-XS-2.1-5bit \
  deno task benchmark --workload=ready --levels=4,8,16 --timeout-seconds=120 --keep
```

The checkpoint is [Laguna-XS-2.1-5bit](https://huggingface.co/mlx-community/Laguna-XS-2.1-5bit),
and the server is [oMLX](https://github.com/jundot/omlx).

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

Laguna initially timed out at c1 after 300 seconds, despite completing the
implementation and tests. The trace showed 17 valid tool-call turns followed
by repeated reads and verification attempts. After adding the completion policy
described above, c1 passed twice at 94.2s and 134.1s. This retained the 32K
context and high-thinking configuration; it was a prompt/agent-loop fix, not a
lower reasoning setting. A direct tool smoke returned a structured `write_file`
call, and oMLX reported a 21.5--21.9 GB loaded model with the standard
`BatchedEngine`.

At full coding c16, all 16 sessions hit the 300-second deadline. oMLX reached
about 45 GB during the wave against a 51.8 GB Metal ceiling, then recovered;
the failure was decode throughput under batching, not model-load failure.

Attempts to make full coding work at c32 were stopped early after no actor had
received a first model response: the original 16,384-token output profile made
no progress for 181s, the 8,192-token profile made no progress for 128s, a
1-second prompt stagger still made no progress for 85s, and the 4,096-token
profile with a 500ms stagger made no progress for 118s. The staggered runs did
reach active peak 32. Longer timeouts would not have changed this admission /
prefill behavior, so c32 full coding is not currently a meaningful reliable
configuration. The short `READY` control can reach c32 because its responses
are tiny.

For the lighter `READY` control (one deterministic Pi response and no tools),
Laguna passed all tested levels:

| Model / server | c4 | c8 | c16 | c32 | c48 | Interpretation |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `Laguna-XS-2.1-5bit` via oMLX BatchedEngine | Pass, 21.5s | Pass, 45.4s | Pass, 74.0s | Pass, 158.1s | Fail, 180s | Reliable through 32 short Pi sessions |

These short controls do not represent 32 full 32K coding workers. They do show
that Pi session startup and oMLX batching are healthy well beyond the two-agent
coding ceiling. The c48 wave triggered hard-memory pressure/reclaim and did not
complete within the control deadline. The full coding workload remains the
meaningful reliability measure: tuned c1 is reliable, while c16 is not.

An apples-to-apples vLLM timing for Laguna was not available. vLLM 0.26.0
recognizes `LagunaForCausalLM`, but its vLLM-Metal MLX loader does not include
`mlx_lm.models.laguna`, so the local MLX checkpoint fails during engine startup
before any inference. A native compatible Laguna checkpoint or a Laguna patch
integrated into the vLLM-Metal environment would be required for comparison.

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
