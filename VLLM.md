# vLLM-Metal and Qwen3

This document contains the vLLM-specific setup and observations for the
harness. The Laguna/oMLX workflow and its current reliability results are in
the [README](README.md).

## vLLM architecture

Two independent Pi SDK agent instances share one vLLM-Metal inference server at
`http://127.0.0.1:8000/v1`. The controller creates the agents in Deno and
starts their prompts concurrently; the model is loaded once by the separately
running vLLM server. Agents use a 32,768-token context window and high
reasoning. The default model is `Qwen/Qwen3-1.7B`; set
`LOCAL_VLLM_MODEL_ID` to benchmark another model without changing the harness.

High-thinking mode is selected through Pi's `thinkingLevel: "high"` and the
model-specific compatibility profile. Qwen models use vLLM's
`enable_thinking` request parameter. Profiles are kept in `src/provider.ts`.

## Running vLLM

Start the base Qwen3 model with vLLM's Hermes parser. Qwen3-1.7B emits the
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

The controller does not start vLLM or create another model instance. Once the
server is ready, run the harness from the README with `deno task poc` or
`deno task benchmark`.

For the tested alternatives, use the matching parser configuration:

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

Select an alternative in the controller, for example:

```bash
LOCAL_VLLM_MODEL_ID=mlx-community/GLM-4.7-Flash-4bit \
  deno task benchmark --levels=1,2,3 --timeout-seconds=300 --keep
```

These results predate the current Laguna/oMLX fixed-task tool surface. The
benchmark uses one shared model replica and a fresh isolated workspace per
session. By default the current benchmark runs the interval-merging programming
workload and sweeps 1, 2, 4, 6, and 8 concurrent sessions. Use
`--workload=ready` for a deterministic session-overhead control,
`--repeats=2` for repeated runs, `--stagger-ms=1000` to spread prompt
admission across a wave, or `--levels=10,12,14,16` to probe a boundary.

## Observed vLLM ceiling

On the Apple M1 Max with 64 GB RAM, using vLLM-Metal, a 32,768-token context,
high thinking, the full Pi system/tool prompt, and a 300-second per-session
deadline, the independent interval-merging programming workload produced:

| Model | c1 | c2 | c3 | Reliable coding ceiling |
| --- | ---: | ---: | ---: | ---: |
| `mlx-community/Qwen3.5-9B-4bit` | Pass, 127s | Pass, 231s | Fail, 300s | **2** |
| `mlx-community/Qwen3.5-9B-OptiQ-4bit` | Pass, 173s | Pass, 286s | Fail, 300s | **2** |
| `mlx-community/GLM-4.7-Flash-4bit` | Fail, 300s | not run | not run | **0** |

The practical ceiling was **2 simultaneous full coding sessions** with the two
Qwen3.5-9B checkpoints. OptiQ is a calibrated mixed-precision variant of the
same base model; it did not improve the concurrency ceiling in this workload.
GLM-4.7-Flash is a 30B-A3B sparse MoE: vLLM-Metal loaded it successfully and
parsed tool calls, but the high-thinking coding agent did not complete one
reliable session within the deadline.

As a serving-capacity control, GLM passed the deterministic `READY` workload at
1, 2, 4, 8, 12, 16, 18, and 20 concurrent Pi sessions. These are short
requests and do not reserve a full 32,768-token KV sequence per session, so they
must not be interpreted as 20 full coding workers. vLLM reported 608,176 KV
tokens for GLM, or a theoretical **18.56** full-length requests. The
corresponding figures were 1,286,888 tokens / **39.27** requests for stock
Qwen3.5-9B and 1,228,303 / **37.48** for OptiQ. The gap between these cache
figures and the coding ceiling is model/tool-turn quality and decode
throughput, not a RAM OOM.

An apples-to-apples vLLM timing for Laguna was not available. vLLM 0.26.0
recognized `LagunaForCausalLM`, but its vLLM-Metal MLX loader did not include
`mlx_lm.models.laguna`, so the local MLX checkpoint failed during engine
startup before inference. A native compatible Laguna checkpoint or a Laguna
patch integrated into the vLLM-Metal environment would be required for a
comparison.
