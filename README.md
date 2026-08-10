# Minimal Pi concurrency harness for oMLX Laguna

Historical alternate-server setup, profiles, and results are in
[`VLLM.md`](VLLM.md). This README stays focused on the Laguna/oMLX path.

## Architecture

Two independent Pi SDK agent instances share one OpenAI-compatible inference
server at `http://127.0.0.1:8000/v1`. The controller creates both agents in
Deno and starts their prompts concurrently; the model is loaded once by the
separately running server. Laguna uses a 32,768-token context window and high
reasoning. Set `LOCAL_VLLM_MODEL_ID` to select the served model without
changing the harness.

Pi host configuration is intentionally not loaded. Every agent receives a
project-defined sterile configuration: an in-memory `ModelRuntime` credential
store with `modelsPath: null`, an in-memory `SettingsManager`, a no-discovery
`ResourceLoader`, an explicit workspace, and a separate session directory under
`.runtime/<actor>/sessions`. No `DefaultResourceLoader` or default Pi directory
is instantiated.

The agents receive workspace-bound filesystem operations and a wrapper that
runs one `python3` test inside that workspace. The wrappers reject paths that
escape the workspace, including symlink escapes. Host-loaded skills,
extensions, prompt templates, and sessions are absent; Pi's built-in system
prompt and selected-tool snippets are still present. The sterile loader also
appends a small coding completion policy: use workspace-relative paths, follow
the requested tool order, and stop immediately after a required test returns
exit code 0. This preserves Pi's built-in prompt while preventing a verified
task from turning into an unnecessary reread/retry loop.

## Running

Assuming oMLX is already serving the required model:

```bash
deno task poc
```

The controller does not start oMLX or create another model instance.

To measure the session concurrency this server can sustain:

```bash
deno task benchmark
```

The benchmark uses one shared model replica and a fresh isolated workspace per
session. By default each session implements and tests an interval-merging
utility, exercising high reasoning, the required filesystem/test tools, test
execution, and multiple sequential Pi turns. The programming workload exposes
only `write_interval_files` and `run_python_test` so every session carries the
smallest tool surface needed by its fixed task. It sweeps 1, 2, 4, 6, and 8
concurrent sessions, stopping at the first failed level. Use `--workload=ready`
for a deterministic session-overhead control, `--repeats=2` for repeated runs,
`--stagger-ms=1000` to spread prompt admission across a wave, or
`--levels=10,12,14,16` to probe beyond the reliable coding boundary. Coding
waves default to `--admission-concurrency=auto`: the harness admits up to 16
sessions while keeping at least 20% system memory free, and falls back to eight
when the macOS memory probe is unavailable. Use an explicit numeric value to
test a fixed active-KV bound, or `--admission-concurrency=0` for an unbounded
wave. READY controls remain unbounded by default so they can measure the
server's own request ceiling. The benchmark reports both logical concurrency
and active peak; the reported maximum is an empirical session-workload result,
not a general server capacity guarantee.

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
Laguna provider keeps the 32,768-token context and high thinking, and allows
up to 4,096 generated tokens so high-thinking tool calls are not truncated. The
server's 16-request cap is an upper ceiling; coding waves use the harness's
memory-aware admission policy underneath it.
Select Laguna in the Pi harness as follows:

```bash
LOCAL_VLLM_MODEL_ID=Laguna-XS-2.1-5bit \
  deno task benchmark --workload=ready --levels=4,8,16 --timeout-seconds=120 --keep
```

The checkpoint is [Laguna-XS-2.1-5bit](https://huggingface.co/mlx-community/Laguna-XS-2.1-5bit),
and the server is [oMLX](https://github.com/jundot/omlx).

## Current observed Laguna behavior

Laguna initially timed out at c1 after 300 seconds, despite completing the
implementation and tests. The trace showed 17 valid tool-call turns followed
by repeated reads and verification attempts. After adding the completion policy
described above, c1 passed twice at 94.2s and 134.1s. This retained the 32K
context and high-thinking configuration; it was a prompt/agent-loop fix, not a
lower reasoning setting. A direct tool smoke returned a structured `write_file`
call, and oMLX reported a 21.5--22.5 GB loaded model with the standard
`BatchedEngine`.

At full coding c16 with the original five-tool session surface, all 16 sessions
hit the 300-second deadline. oMLX reached about 45 GB during the wave against a
51.8 GB Metal ceiling, then recovered; the failure was admission/decode
throughput under batching, not model-load failure. The current benchmark
narrows that fixed programming workload to `write_interval_files` and
`run_python_test`, with one multi-file write, to reduce each session's prompt
and tool-choice footprint. The memory-aware policy now lets the server reach
active peak 16 because host free memory stayed well above its 20% floor. In
high-thinking coding runs, c12 passed all 12 sessions in 284.0s with active
peak 12; c14 failed 2/14 at the 300s deadline; and c16 failed 5/16. Host free
memory stayed roughly 56--60% during these waves, so ordinary host RAM was not
the binding signal. c12 is the current reliable sweet spot for this fixed
32K-context coding workload; c14 and c16 remain throughput/KV-bound even though
the machine reports substantial free memory.

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
meaningful reliability measure: high-thinking c12 is reliable, while c14 and
c16 are not.

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
32k context target, the server's KV working set and decode throughput—not the
number of Deno actor objects—are the expected first capacity constraints.
