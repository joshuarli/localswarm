# localswarm

localswarm is a Rust concurrency harness for two or more isolated Pi coding
agents sharing one oMLX server running Laguna XS 2.1.

The application is deliberately small at the boundary:

- pi-agent-core-rs owns the agent state machine, pinned Pi coding profile,
  standard tools, and provider-neutral model loop.
- this crate owns workspaces, process execution policy, deadlines, verification,
  and the explicit local provider configuration.
- oMLX serves Laguna-XS-2.1-5bit through its OpenAI-compatible
  POST /v1/chat/completions endpoint.
- every actor gets a separate workspace and runs on its own Rust thread, so one
  loaded model can serve concurrent requests.

There is no TypeScript, Deno, alternate model provider, credential lookup, or
model selection from the environment. The repository-level
rust-toolchain.toml pins the nightly compiler used by this application and
the adjacent pi-agent-core-rs checkout.

## Build and run

Install oMLX and then let Make download the checkpoint and manage the local
server. The first run uses uvx and resumes safely if the model download was
interrupted:

    make run

make run is idempotent. It reuses a healthy matching server, starts one when
needed, waits for the model endpoint, and then launches the two-agent PoC. It
leaves oMLX running for subsequent commands. Stop only the server started by
this repository with:

    make stop

The defaults can be overridden without changing the source:

    make run OMLX_MODEL_DIR=/Volumes/models OMLX_PORT=8100

`make run` starts oMLX with the `aggressive` memory guard so the large Laguna
model has more room for request KV cache. Override it with
`OMLX_MEMORY_GUARD=balanced` when the host needs a larger safety reserve. If
oMLX reports that the Metal wired-memory cap is binding, raise that host-level
cap separately; the application will leave the server log and failed
workspace available for diagnosis.

The PoC creates workspaces/actor-a and workspaces/actor-b, asks the agents to
implement and test Fibonacci and primality utilities, then independently
reruns the generated tests. It does not create another model instance.

Use the Rust benchmark mode for a concurrency sweep:

    cargo run --release -- \
      --mode benchmark \
      --workload programming \
      --levels 1,2,4,6,8 \
      --timeout-seconds 300

--workload ready measures short request overhead without filesystem work.
--stagger-ms N spaces thread admission, --repeats N repeats the sweep, and
--keep retains benchmark workspaces. The benchmark stops at the first failed
wave; its active peak is the requested wave size, not a server capacity claim.

## Local provider contract

The provider-local feature in
[pi-agent-core-rs](../pi-agent-core-rs/crates/pi-agent-core/Cargo.toml)
adds a keyless OpenAI-compatible adapter. Its LocalConfig::laguna_xs_2_1
constructor fixes the model identifier and Laguna defaults:

- endpoint root: http://127.0.0.1:8000/v1
- model: Laguna-XS-2.1-5bit
- context metadata: 32,768 tokens
- output cap: 4,096 tokens
- temperature: 1.0, top_p: 1.0, min_p: 0.0
- chat_template_kwargs.enable_thinking: true

The adapter sends finite non-streaming requests with OpenAI function-tool
objects, parses oMLX tool calls and usage, and watches the core cancellation
token while its direct transport child is running. It never reads credentials,
home-directory configuration, or a model catalog.

The application installs
pi_agent_core::provider::openai::OpenAiContextHook so the retained core
transcript becomes the OpenAI message array expected by oMLX. Reasoning text
is not copied into the visible assistant transcript because the current core
stream contract has no separate reasoning-content event.

## Quality gates

    cargo fmt --all -- --check
    cargo check
    cargo test --manifest-path ../pi-agent-core-rs/Cargo.toml \
      -p pi-agent-core --features provider-local

The local provider is tested without a live server: payload construction,
Laguna defaults, tool-call decoding, usage accounting, registry selection, and
configuration boundaries are covered in pi-agent-core-rs.
