Build a minimal, reproducible macOS Apple Silicon proof-of-concept that runs **two independent Pi coding-agent actors concurrently against one shared local Qwen3-1.7B inference server using vLLM-Metal**.

The goal is NOT to build a swarm framework yet. The goal is to establish a clean, reliable substrate that proves:

1. Qwen3-1.7B runs correctly through vLLM-Metal on this Mac.
2. vLLM exposes a working OpenAI-compatible local endpoint.
3. Pi can use that endpoint as a custom provider.
4. Two Pi actors can run concurrently with independent conversation state.
5. Both actors share the same loaded model instance; do NOT start two copies of Qwen3-1.7B.
6. The setup is easy to reproduce, inspect, benchmark, and later scale from 2 → 20+ logical actors.

## Constraints

Target only:

* macOS
* Apple Silicon / arm64
* native Metal acceleration
* Qwen/Qwen3-1.7B
* vLLM-Metal
* Pi coding agent
* two concurrent Pi actors

Do not add:

* Docker
* Kubernetes
* Ray
* SGLang
* llama.cpp
* external databases
* Redis
* message queues
* web UI
* generic orchestration frameworks
* distributed/multi-Mac serving
* LoRA
* RL infrastructure

Keep the implementation aggressively minimal.

Before making assumptions about CLI flags or config schemas, consult the CURRENT official documentation for:

* vLLM-Metal
* upstream vLLM serving
* Pi custom models/providers
* Pi RPC mode
* Qwen3-1.7B

Do not cargo-cult commands from old blog posts.

## Architecture

Implement exactly this topology:

```text
                     macOS Apple Silicon
                            │
                     vLLM-Metal
                            │
                     Qwen3-1.7B
                    loaded exactly once
                            │
                OpenAI-compatible HTTP
                     localhost:8000
                       /v1/...
                            │
                 ┌──────────┴──────────┐
                 │                     │
              Pi actor A            Pi actor B
               RPC mode              RPC mode
                 │                     │
                 └──────────┬──────────┘
                            │
                    tiny PoC controller
```

The controller should prove concurrent operation, not implement sophisticated scheduling.

## Phase 1: preflight

Detect and print:

* macOS version
* Apple Silicon model/chip if readily available
* total unified memory
* `uname -m`
* Python version and architecture
* Node version
* npm version
* whether `pi` is already installed
* whether port 8000 is available

Fail clearly if the machine is not arm64 Apple Silicon.

vLLM-Metal currently requires native arm64 Python 3.12. Do not use Rosetta Python.

Avoid modifying unrelated global Python environments.

## Phase 2: install vLLM-Metal

Use the current official vLLM-Metal installation method.

Prefer its standard isolated environment rather than inventing a custom dependency layout unless there is a concrete reason not to.

Verify installation with:

```text
vllm --version
```

and a minimal Python import check.

Capture exact installed versions in a machine-readable or plain-text environment report.

Do not silently upgrade unrelated system packages.

## Phase 3: run Qwen3-1.7B

Use:

```text
Qwen/Qwen3-1.7B
```

as the canonical model.

Start ONE server, initially equivalent in spirit to:

```bash
vllm serve Qwen/Qwen3-1.7B \
  --host 127.0.0.1 \
  --port 8000 \
  --max-model-len 8192
```

But verify current supported flags against the installed version before finalizing the command.

Prefer an 8192-token maximum context for the PoC. We are testing concurrent actors, not giant context windows.

If vLLM-Metal exposes a documented unified-memory allocation knob that is useful here, use a conservative value only if necessary. Do not prematurely tune it.

Do not quantize initially unless BF16 fails for a concrete capacity reason.

Do not launch data-parallel replicas.

Do not load the model twice.

## Phase 4: raw inference smoke tests

Before involving Pi, prove the inference server works directly.

Implement a small smoke-test script that:

1. waits for the server to become healthy;
2. queries the OpenAI-compatible models endpoint if available;
3. makes one chat-completion request;
4. validates that meaningful text is returned;
5. launches TWO chat requests concurrently;
6. reports:

   * wall-clock duration;
   * individual request latency;
   * output token count if exposed;
   * model identifier;
   * any server-side usage statistics available.

Use two deliberately distinct prompts so responses cannot be confused.

For example:

Actor A task:

```text
Write a Python function that computes Fibonacci numbers iteratively.
Return only code.
```

Actor B task:

```text
Write a Python function that checks whether an integer is prime.
Return only code.
```

The important acceptance criterion is that the two requests overlap in time and are serviced by the same inference server.

## Phase 5: configure Pi

Install Pi only if it is not already installed.

Use the current official package/instructions.

Configure a custom provider for the local vLLM endpoint using Pi's supported OpenAI-compatible provider mechanism.

Prefer project-local configuration if Pi supports that cleanly; otherwise document exactly which user-level file was modified.

The effective configuration should conceptually resemble:

```json
{
  "providers": {
    "vllm-local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [
        {
          "id": "Qwen/Qwen3-1.7B",
          "name": "Qwen3 1.7B Local",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 8192,
          "maxTokens": 2048,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

Do not blindly copy this schema if current Pi documentation differs. Adapt it to the installed version.

If vLLM does not support Pi's default `developer` role or `reasoning_effort` behavior correctly, configure Pi's documented compatibility flags rather than hacking prompts.

## Qwen3 thinking behavior

For this PoC, prefer Qwen3 in **non-thinking mode**.

The purpose is to test actor concurrency and plumbing, not burn tokens on hidden/extended reasoning.

Use the cleanest currently supported mechanism to disable thinking through either:

* the model/server chat-template configuration; or
* Pi/provider request compatibility;

whichever is actually supported end-to-end.

Do not rely on fragile prompt text like `/no_think` unless there is no cleaner supported mechanism.

Document exactly how thinking was disabled.

## Phase 6: two Pi RPC actors

Run two completely independent Pi instances using RPC/headless mode.

Conceptually:

```bash
pi \
  --mode rpc \
  --no-session \
  --provider vllm-local \
  --model Qwen/Qwen3-1.7B \
  --name actor-a
```

and separately:

```bash
pi \
  --mode rpc \
  --no-session \
  --provider vllm-local \
  --model Qwen/Qwen3-1.7B \
  --name actor-b
```

Again, verify current CLI syntax before finalizing.

Each process must have:

* independent stdin/stdout RPC channel;
* independent conversational state;
* distinct actor name;
* no shared Pi session file;
* the same vLLM endpoint;
* the same underlying Qwen3 model weights.

## Phase 7: tiny controller

Write the smallest reasonable controller to spawn and drive both Pi RPC processes.

Prefer TypeScript/Node if that matches Pi's native SDK/runtime cleanly. Python is acceptable if subprocess handling is materially simpler.

Do NOT introduce a framework.

Responsibilities:

1. spawn actor A;
2. spawn actor B;
3. wait until both are ready;
4. send one coding task to each nearly simultaneously;
5. consume their JSONL event streams correctly;
6. distinguish events by actor;
7. wait until both agents settle;
8. print final responses separately;
9. terminate cleanly;
10. report elapsed wall time.

Respect Pi RPC's strict JSONL framing. Do not use a line parser that violates Pi's documented RPC semantics.

Structure output approximately like:

```text
[vllm] ready
[actor-a] spawned
[actor-b] spawned

[actor-a] prompt submitted
[actor-b] prompt submitted

[actor-a] ...
[actor-b] ...

=== actor-a final ===
...

=== actor-b final ===
...

elapsed: 4.21s
```

Color is unnecessary.

## Actor prompts

Give each Pi instance a narrow coding task that allows actual tool use but cannot interfere with the other actor.

Create:

```text
workspaces/
  actor-a/
  actor-b/
```

Actor A works only inside `workspaces/actor-a`.

Actor B works only inside `workspaces/actor-b`.

Task A:

```text
Create fib.py containing a clean iterative Fibonacci implementation.
Add a tiny self-contained test using Python's standard library.
Run the test and stop when it passes.
```

Task B:

```text
Create prime.py containing a clean primality-test implementation.
Add a tiny self-contained test using Python's standard library.
Run the test and stop when it passes.
```

The controller must verify afterward that:

```text
workspaces/actor-a/fib.py
workspaces/actor-b/prime.py
```

exist and that their tests pass.

This proves more than plain inference: two independent Pi coding loops can concurrently call the same weak local LLM and manipulate isolated working directories.

## Process management

Provide scripts or equivalent commands for:

```text
setup
start-server
smoke-test
run-poc
stop-server
```

Keep these as simple shell scripts or a small Makefile justifying whichever is cleaner.

Server lifecycle must be understandable.

Store PID/log information under a local project directory such as:

```text
.run/
```

Do not daemonize through launchd.

Capture vLLM stdout/stderr to:

```text
.run/vllm.log
```

On failure, print where the log is.

Handle Ctrl-C and child-process cleanup correctly.

## Observability

The PoC should expose enough information to answer:

* Was there one model process or accidentally two?
* Were both actors active concurrently?
* How long did each actor take?
* How long did the complete two-actor run take?
* Did either request fail/retry?
* How much unified memory did the server consume approximately?
* What exact model/provider/version handled the requests?

Do not build Prometheus/OpenTelemetry.

Plain structured logs are sufficient.

If easy, sample memory using native macOS tooling before and during the concurrent run.

## Repository layout

Aim for something roughly this small:

```text
.
├── README.md
├── Makefile                 # optional
├── scripts/
│   ├── setup.sh
│   ├── start-server.sh
│   ├── stop-server.sh
│   └── smoke-test.py
├── controller/
│   └── ...
├── workspaces/
│   ├── actor-a/
│   └── actor-b/
├── .run/
│   └── .gitkeep
└── .gitignore
```

Avoid scaffolding unless necessary.

## README

Write a concise README covering:

### Architecture

Explicitly state:

> There are two logical Pi actors but only one loaded Qwen3-1.7B model instance.

Explain why.

### Setup

From a fresh Apple Silicon Mac, give exact commands.

### Running

Ideally:

```bash
./scripts/setup.sh
./scripts/start-server.sh
./scripts/smoke-test.py
<one command to run both actors>
```

### Expected result

Show representative successful output.

### Troubleshooting

Include only failures actually encountered or highly likely ones:

* x86/Rosetta Python;
* wrong Python version;
* model download/auth problems;
* port already occupied;
* vLLM-Metal import/startup problem;
* Pi provider not visible;
* unsupported OpenAI role/request field;
* Qwen thinking unexpectedly enabled;
* memory pressure.

### Scaling note

End with a short architectural note explaining that scaling:

```text
2 → 5 → 20 actors
```

should initially mean increasing the number of **Pi client sessions**, not increasing the number of vLLM model replicas.

The next benchmark after this PoC should therefore be identical infrastructure with configurable:

```text
--actors N
```

rather than adding Ray or another serving layer.

## Acceptance criteria

Do not consider the task complete until all of these pass:

* [ ] Machine confirmed native Apple Silicon arm64.
* [ ] vLLM-Metal installed and importable.
* [ ] Qwen/Qwen3-1.7B loads successfully.
* [ ] Exactly one inference server/model instance is running.
* [ ] OpenAI-compatible single-request smoke test passes.
* [ ] Raw two-request concurrent smoke test passes.
* [ ] Pi recognizes the local model/provider.
* [ ] Pi actor A works independently.
* [ ] Pi actor B works independently.
* [ ] Actor A and actor B run concurrently.
* [ ] Both are backed by the same vLLM server.
* [ ] Actor A creates and tests `fib.py`.
* [ ] Actor B creates and tests `prime.py`.
* [ ] Their files/workspaces do not interfere.
* [ ] Child processes shut down cleanly.
* [ ] README reproduces the successful procedure.
* [ ] Exact installed component versions are recorded.

## Engineering philosophy

This is infrastructure for later experiments in artificial societies / multi-agent coordination.

Therefore:

* keep inference boring;
* keep actors disposable;
* keep actor state isolated;
* make concurrency explicit;
* retain inspectability;
* avoid premature abstractions;
* prefer deterministic machinery around nondeterministic models;
* do not build the future swarm control plane yet.

The PoC is successful if two independent weak coding agents can operate simultaneously and reliably through one shared local inference substrate.

Once this works, stop.

Do not continue into scheduling, provenance graphs, inter-agent messaging, memory, actor genomes, institutional structures, or RL. Those are the next layer and should be designed only after this substrate is proven.
