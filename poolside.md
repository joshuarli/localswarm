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

The experimental speculative-decoding path is intentionally outside this
baseline. It has different batching behavior, so mixing it into the first
concurrency result would make the comparison ambiguous.
