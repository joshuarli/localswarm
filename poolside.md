# oMLX / Laguna notes

Laguna XS 2.1 is a large-total-parameter, small-active-parameter MoE model
distributed as the mlx-community/Laguna-XS-2.1-5bit checkpoint. The local
experiment uses oMLX's normal continuous-batching engine and one loaded model
for all actors.

The useful measurement is not a headline single-stream decode number. Sweep
concurrent coding sessions while recording:

- time to first model response;
- per-session and aggregate generated tokens per second;
- prompt and completion token usage;
- peak memory pressure;
- the highest wave where every workspace passes verification.

The harness keeps that boundary explicit. localswarm owns one local provider
instance and starts each actor on a separate Rust thread. oMLX owns batching
and model residency. The benchmark's ready workload is a lightweight control;
the programming workload is the meaningful filesystem/tool workload.

## Current baseline

This is the first measured baseline after the Rust/local-provider migration,
recorded 2026-08-14 with `make run`:

| Component | Baseline |
| --- | --- |
| Model | `Laguna-XS-2.1-5bit` |
| Server | oMLX 0.5.7, OpenAI-compatible `127.0.0.1:8000/v1` |
| Server configuration | One loaded model, `--max-concurrent-requests 16`, `--memory-guard aggressive` |
| Provider | `local`, non-streaming OpenAI-compatible transport |
| Agent configuration | Two Rust threads, separate workspaces, Pi default coding profile and standard tools |
| Context metadata | 32,768 tokens |
| Output cap | 4,096 tokens |
| Result | Both actors completed and verification passed |
| Wall time | 133.1 seconds |

Per-actor results:

| Actor | Elapsed | Lifecycle events | Input tokens | Output tokens | Cached tokens | Verification |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| actor-a | 113.1 s | 57 | 13,156 | 1,131 | 10,240 | passed |
| actor-b | 132.9 s | 80 | 22,886 | 1,411 | 16,384 | passed |

The run used oMLX's aggressive guarded tier because the checkpoint is large:
oMLX reported an estimated model footprint of 22.49 GB and an Apple Metal
working-set cap of about 25.0 GB, with `iogpu.wired_limit_mb` unset. Prefill
was adaptively throttled, but the run completed. This makes the result a
repeatable starting point for this host and workload, not a claim that every
larger concurrency wave will fit. A future benchmark should report its exact
wave, cache state, and memory telemetry alongside throughput.

The experimental speculative-decoding path is intentionally outside this
baseline. It has different batching behavior, so mixing it into the first
concurrency result would make the comparison ambiguous.
