# Task: Minimal 2-Agent Pi + vLLM-Metal PoC on macOS

Build a minimal proof-of-concept that runs **two completely isolated Pi coding agents concurrently through the Pi SDK under Deno**, both backed by **one shared local `Qwen/Qwen3-1.7B` instance served by vLLM-Metal**.

This is infrastructure validation only.

Do not build a swarm framework yet.

## Goal

Prove this topology:

```text
                         macOS / Apple Silicon

                         vLLM-Metal
                              │
                       Qwen3-1.7B
                     loaded exactly once
                              │
                   OpenAI-compatible API
                    http://127.0.0.1:8000
                              │
                ┌─────────────┴─────────────┐
                │                           │
          isolated Pi agent A        isolated Pi agent B
             Pi SDK / Deno              Pi SDK / Deno
                │                           │
        workspace/actor-a           workspace/actor-b
                └─────────────┬─────────────┘
                              │
                      tiny Deno controller
```

There are **two logical agents, not two model replicas**.

Both agents must independently maintain their own Pi conversation/session state while sharing the same vLLM inference endpoint and underlying model weights.

---

# Hard constraints

Use:

* macOS Apple Silicon
* Deno
* Pi SDK
* vLLM-Metal
* `Qwen/Qwen3-1.7B`
* one vLLM server
* two concurrent Pi agents

Do not use:

* Pi RPC subprocesses
* Node.js as the application runtime
* Docker
* Kubernetes
* Ray
* SGLang
* llama.cpp
* Redis
* Postgres
* message brokers
* web frameworks
* generic agent orchestration frameworks
* distributed serving
* multiple model replicas
* LoRA
* RL infrastructure

Keep the implementation extremely small.

Dependency installation and machine preflight are out of scope. Assume:

* Deno works;
* Pi and/or its SDK dependencies can be resolved;
* vLLM-Metal works;
* Qwen3-1.7B can be served locally.

If an API detail is uncertain, consult the current official Pi SDK documentation before implementing it.

Do not reproduce setup tutorials for dependencies.

---

# Most important invariant: hermetic Pi agents

Each Pi agent must run with an **explicit, minimal configuration assembled by this project**.

It must NOT implicitly discover, inherit, merge, or load configuration from the host user's normal Pi environment.

In particular, neither actor may read or inherit:

* `~/.pi/...`
* existing Pi settings
* existing Pi model/provider definitions
* existing Pi sessions
* existing Pi prompts
* existing Pi extensions
* existing Pi skills
* existing Pi tools/configuration
* project-level Pi configuration outside this PoC
* user-level agent instructions
* unrelated environment-driven Pi configuration

Do not instantiate the SDK with defaults that cause Pi to walk the filesystem looking for ambient configuration.

Prefer explicit SDK construction where every relevant piece of configuration is supplied programmatically.

If the Pi SDK itself requires filesystem-backed config/state, give **each actor its own synthetic isolated config root** under this repository, for example:

```text
.runtime/
├── actor-a/
│   ├── config/
│   ├── state/
│   └── sessions/
└── actor-b/
    ├── config/
    ├── state/
    └── sessions/
```

Never point either actor at the real host home directory.

If necessary, construct a sterile environment/config abstraction per actor or explicitly override any SDK resource loaders so host configuration cannot be discovered.

The resulting architecture should make this statement true:

> Deleting or radically changing `~/.pi` has zero effect on this PoC.

That property is an acceptance criterion.

---

# Minimal agent phenotype

Both agents should begin essentially identical.

Do not preload personalities, role prompts, skills, elaborate system instructions, or other behavior.

Each actor should have only:

```text
model
working directory
minimal coding tools
task
```

The purpose is to establish a clean baseline from which actor specialization can later be experimentally introduced.

Do not give actors access to unnecessary tools.

For this PoC, expose only the minimum capabilities required to:

1. inspect their own workspace;
2. write/edit files inside their own workspace;
3. execute the tiny test they create.

Prefer the smallest Pi-native tool set that provides those capabilities.

Do not enable:

* web search
* browser access
* external network tools
* arbitrary MCP servers
* skills
* extensions
* memory systems
* subagents
* planning frameworks
* host filesystem exploration

If Pi's stock coding tools expose broader filesystem access than desired, constrain them through working-directory boundaries or a minimal custom tool wrapper.

The actor should conceptually see:

```text
actor-a
  cwd = ./workspaces/actor-a
```

and not care that the rest of the repository exists.

Likewise for actor B.

---

# Inference server

Assume one server is already available at:

```text
http://127.0.0.1:8000/v1
```

serving:

```text
Qwen/Qwen3-1.7B
```

Do not start a second model instance.

Provide a small optional convenience script for starting the server if useful, but server installation/setup is not the focus.

A representative launch is:

```bash
vllm serve Qwen/Qwen3-1.7B \
  --host 127.0.0.1 \
  --port 8000 \
  --max-model-len 8192
```

Verify flags against the installed vLLM version rather than assuming this exact invocation.

Use:

```text
context window: 8192
```

for the PoC.

Do not optimize memory aggressively yet.

Do not quantize unless required for a concrete reason.

---

# Qwen3 mode

Run Qwen3-1.7B in **non-thinking mode**.

We are measuring the behavior of cheap narrow agents and exercising concurrency, not spending tokens on extended reasoning.

Use the cleanest supported mechanism available through the Pi SDK / OpenAI-compatible provider / vLLM chat template.

Do not rely on `/no_think` prompt text unless there is genuinely no cleaner mechanism.

Document the mechanism in one sentence in the README.

---

# Pi provider construction

Construct the local provider explicitly in code.

Do not register it globally.

Do not modify `~/.pi/agent/models.json`.

Do not require the user's existing Pi configuration to know about the model.

The provider definition should be local to this PoC and conceptually contain only:

```text
provider id: local-vllm
API: OpenAI-compatible completions/chat
base URL: http://127.0.0.1:8000/v1
model: Qwen/Qwen3-1.7B
context: 8192
reasoning: false
cost: zero
```

Use Pi's documented SDK abstractions rather than shelling out to the Pi CLI.

The Deno program should import/use the Pi SDK directly.

If Pi's published SDK package is distributed through npm, use Deno's native `npm:` package support rather than introducing npm/node project scaffolding.

Do not add `package.json` unless absolutely required.

Prefer:

```text
deno.json
```

and normal Deno imports.

---

# Actor construction

Create a very small helper along the lines of:

```text
createActor({
    id,
    workspace,
    runtimeRoot,
    model,
    tools,
})
```

This helper must produce an isolated Pi agent instance.

The two invocations should differ only in identity and filesystem paths:

```text
actor A
    id: actor-a
    workspace: workspaces/actor-a
    runtime: .runtime/actor-a

actor B
    id: actor-b
    workspace: workspaces/actor-b
    runtime: .runtime/actor-b
```

Do not introduce an inheritance hierarchy, actor framework, dependency injection system, or generic plugin architecture.

A plain TypeScript function is sufficient.

---

# Tasks

Actor A receives:

```text
Create fib.py containing a clean iterative Fibonacci implementation.

Create a tiny self-contained test using only Python's standard library.

Run the test.

Stop when it passes.
```

Actor B receives:

```text
Create prime.py containing a clean primality-test implementation.

Create a tiny self-contained test using only Python's standard library.

Run the test.

Stop when it passes.
```

The tasks should begin concurrently.

Use:

```ts
await Promise.all([
  runActor(actorA, taskA),
  runActor(actorB, taskB),
]);
```

or the appropriate equivalent for the Pi SDK.

Do not serially await one actor before starting the other.

---

# Workspace isolation

Repository structure:

```text
.
├── README.md
├── deno.json
├── src/
│   ├── main.ts
│   ├── actor.ts
│   └── provider.ts
├── workspaces/
│   ├── actor-a/
│   └── actor-b/
├── .runtime/
│   ├── actor-a/
│   └── actor-b/
└── .gitignore
```

Collapse files further if doing so improves clarity.

`.runtime/` should be ignored.

Each actor may modify only its own workspace.

Actor A must never write into actor B's workspace.

Actor B must never write into actor A's workspace.

After execution, the controller verifies:

```text
workspaces/actor-a/fib.py
workspaces/actor-b/prime.py
```

exist.

It should then independently execute the resulting tests or otherwise verify that both actor-created test suites pass.

Do not rely solely on the agent claiming that tests passed.

---

# Controller behavior

The Deno controller should do only the following:

```text
construct local model/provider
        ↓
construct isolated actor A
construct isolated actor B
        ↓
start both concurrently
        ↓
stream useful events
        ↓
wait for completion
        ↓
verify resulting artifacts/tests
        ↓
print summary
```

No queue.

No scheduler.

No agent-to-agent communication.

No durable knowledge system.

No control-plane abstraction yet.

---

# Event logging

Use Pi SDK events directly where available.

Prefix emitted events by actor:

```text
[actor-a] ...
[actor-b] ...
```

Do not dump enormous raw model payloads by default.

Show useful lifecycle information such as:

```text
[actor-a] started
[actor-b] started

[actor-a] tool: write fib.py
[actor-b] tool: write prime.py

[actor-a] tool: python ...
[actor-b] tool: python ...

[actor-a] complete
[actor-b] complete
```

At the end print something like:

```text
=== RESULT ===

actor-a
  status: success
  elapsed: 8.4s
  file: workspaces/actor-a/fib.py
  verification: passed

actor-b
  status: success
  elapsed: 9.7s
  file: workspaces/actor-b/prime.py
  verification: passed

wall time: 9.8s
model: Qwen/Qwen3-1.7B
endpoint: http://127.0.0.1:8000/v1
logical actors: 2
model replicas: 1
```

If Pi exposes token/usage statistics easily, record:

```text
input tokens
output tokens
cached tokens
```

per actor.

Do not add a telemetry stack.

---

# Isolation audit

Add a simple explicit audit step to the PoC.

At startup, print the effective resources/configuration that each actor is receiving:

```text
actor-a:
  provider: local-vllm
  model: Qwen/Qwen3-1.7B
  workspace: ...
  runtime root: ...
  tools: [...]
  skills: none
  extensions: none
  inherited host config: none

actor-b:
  ...
```

Do not print secrets.

More importantly, inspect the Pi SDK implementation/documentation enough to ensure these claims are actually true.

If some SDK default implicitly loads host resources, explicitly disable or replace it.

Do not merely assume isolation because custom configuration was supplied.

---

# Failure handling

If one actor fails, let the other finish if practical.

Report both outcomes independently.

Ensure resources held by the Pi SDK are disposed/closed cleanly.

Ctrl-C should terminate the PoC without leaving background agent processes because there should not be agent subprocesses in the first place.

The vLLM server can remain independently running.

---

# README

Keep the README short.

Include:

## Architecture

Explicitly state:

> Two independent Pi SDK agent instances share one Qwen3-1.7B vLLM-Metal inference server.

And:

> Pi host configuration is intentionally not loaded. Every agent receives a project-defined sterile configuration.

## Running

Assuming vLLM is already serving Qwen3:

```bash
deno task poc
```

That should ideally be the only application command required.

## Expected result

Both independent coding tasks succeed concurrently.

## Isolation

Document precisely how host Pi configuration loading was prevented.

This section matters more than installation instructions.

## Scaling

State:

> Scaling 2 → 20 actors initially means constructing additional isolated Pi SDK agents against the same inference server, not loading additional copies of Qwen3-1.7B.

No discussion of Kubernetes/Ray/etc. beyond that.

---

# Acceptance criteria

Do not stop until all are true:

* [ ] Application runtime is Deno.
* [ ] Pi is used through its SDK, not RPC or CLI subprocesses.
* [ ] One vLLM-Metal endpoint serves `Qwen/Qwen3-1.7B`.
* [ ] Exactly one model replica is required.
* [ ] Provider/model configuration is constructed locally by the application.
* [ ] No changes are made to the user's normal Pi configuration.
* [ ] Neither actor reads normal host Pi configuration.
* [ ] Neither actor loads host Pi skills/extensions/prompts/sessions.
* [ ] Actor A and actor B have separate Pi state/config roots.
* [ ] Actor A and actor B have separate workspaces.
* [ ] Only minimal filesystem/edit/execute tools are available.
* [ ] No unnecessary tools or extensions are loaded.
* [ ] Both actors begin execution concurrently.
* [ ] Actor A creates a correct `fib.py`.
* [ ] Actor B creates a correct `prime.py`.
* [ ] Tests are independently verified by the controller.
* [ ] Logs clearly distinguish both actors.
* [ ] Effective model/provider/tool configuration is inspectable.
* [ ] README explains the hermetic configuration mechanism.
* [ ] `deno task poc` reproduces the experiment.

---

# Engineering philosophy

Treat each Pi actor as a **disposable, hermetic cognitive process**.

The actor should possess essentially no durable intelligence beyond the context explicitly supplied to it.

The eventual society/control plane—not the individual Pi process—will own:

```text
identity
memory
provenance
knowledge
specialization
coordination
resource budgets
institutional state
```

Therefore this PoC should deliberately prevent Pi's existing host-level configuration and persistence machinery from becoming hidden state.

The desired abstraction boundary is:

```text
            future society/control plane
                       │
               explicit context
                       │
           ┌───────────┴───────────┐
           │                       │
      sterile Pi actor        sterile Pi actor
           │                       │
           └───────────┬───────────┘
                       │
                  shared vLLM
                       │
                  Qwen3-1.7B
```

The important experiment is not "can Pi run twice?"

It is:

> Can we cheaply instantiate multiple **hermetic, independently stateful cognitive workers** over a single shared inference substrate, with their entire effective phenotype controlled explicitly by our own program?

Once that invariant is established for two actors, stop.

Do not implement actor communication, provenance, scheduling, institutional memory, specialization, genomes, or RL yet.
