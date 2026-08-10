Yes — I found the exact claim, and there’s an important distinction: **the 160+ tok/s result was not vLLM-Metal. It was Apple-native MLX via oMLX.** The demo used Laguna XS 2.1, a 33.4B-total / 3B-active MoE, on an M5 Max with 128 GB unified memory at 5-bit quantization. ([daily.dev][1])

More specifically, the 5-bit checkpoint is an MLX conversion (`mlx-community/Laguna-XS-2.1-5bit`), and oMLX is an inference server built around MLX/`mlx-lm`. Its normal batched engine uses `mlx-lm`'s `BatchGenerator` for continuous batching; it is not a vLLM port. ([GitHub][2])

The biggest caveat: **I cannot find evidence that the advertised 160+ tok/s number is aggregate multi-session throughput. Everything I can find points to it being a single-generation decode number from the Pi coding-agent demo.** The article summarizing that demo simply reports “160+ tokens/sec at 5-bit” while running Pi through oMLX; it does not report a batch size or concurrency sweep. ([daily.dev][1])

That means you should not currently interpret it as:

```text
8 users × 20 tok/s = 160 aggregate tok/s
```

It appears much closer to:

```text
one active generation
≈ 160+ tok/s decode
```

which, frankly, is already a remarkable number for a 33B-total MoE on a Mac.

There is another wrinkle that makes current numbers especially interesting. oMLX now has **two materially different execution paths** for Laguna:

1. **BatchedEngine** — normal autoregressive MLX inference, with continuous batching, paged cache, concurrent requests, etc. ([GitHub][2])
2. **DFlashEngine** — speculative/block-diffusion decoding using Poolside's dedicated Laguna DFlash drafter. This can substantially accelerate a *single request*, but **it explicitly does not support continuous batching**; concurrent requests serialize. ([GitHub][3])

So when comparing huge tok/s claims, we need to know whether the benchmark was:

```text
plain MLX BatchedEngine
        vs
DFlash speculative decode
```

The 160-tok/s demo predates or at least is separate from the late-July oMLX DFlash integration documentation I found, so I would **not assume that 160 figure came from DFlash**. The available description identifies the runtime as oMLX and the 5-bit model, but doesn't document a DFlash draft model. ([daily.dev][1])

### The concurrency question is actually more interesting

oMLX *does* support exactly what we've been talking about:

```text
Pi A ─┐
Pi B ─┤
Pi C ─┼──► oMLX BatchedEngine
Pi D ─┤          │
...   ─┘          ▼
             one Laguna XS
```

Its README explicitly says it handles concurrent requests through `mlx-lm`'s `BatchGenerator`, with configurable maximum concurrency. ([GitHub][2])

But I haven't found a published **Laguna XS 2.1 / M5 Max concurrency scaling table** of the sort we'd really want:

| Concurrent decode streams | Per-stream tok/s | Aggregate tok/s |
| ------------------------: | ---------------: | --------------: |
|                         1 |            ~160? |           ~160? |
|                         2 |                ? |               ? |
|                         4 |                ? |               ? |
|                         8 |                ? |               ? |
|                        16 |                ? |               ? |

And that's the benchmark that matters enormously for your application.

Also, oMLX batching isn't necessarily as mature/predictable as CUDA vLLM yet. There are recent reports of odd concurrency-dependent behavior—for example, one current issue reports a severe prefill slowdown specifically at concurrency=2 that recovers at 4 and 8 on multiple MoE architectures. So I'd regard Apple-side continuous batching as **real and usable, but still actively being optimized**, rather than assuming vLLM-level scheduler maturity. ([GitHub][4])

The really exciting experiment on a **128 GB M5 Max** would therefore be:

```text
Laguna XS 2.1 5-bit
~33.4B total / 3B active
        │
        ▼
       oMLX
   BatchedEngine
        │
        ├── concurrency 1
        ├── concurrency 2
        ├── concurrency 4
        ├── concurrency 8
        ├── concurrency 16
        └── concurrency 32
```

while fixing something representative like **8K/16K existing context + 512 generated tokens per agent** and measuring aggregate decode throughput, per-agent tok/s, TTFT, memory footprint, and KV-cache pressure.

If that ~160 single-stream result holds and batching gets even moderately good weight reuse, **aggregate throughput could be substantially above 160 tok/s**. I would not predict 300 or 500 tok/s without measuring—it depends heavily on whether the 160 figure is already saturating the M5 Max's compute/bandwidth—but this is exactly the place where your “one large MoE, many agents” architecture could become absurdly attractive.

And Laguna XS is almost tailor-made for it: **33.4B resident intelligence, only 3B active/token**, rather than 20 independent 1.7B models. ([arXiv][5])

[1]: https://daily.dev/posts/laguna-xs-2-1-160-tok-s-on-apple-m5-max-33b-moe-with-pi-coding-agent-tested--6ikdjaymu?utm_source=chatgpt.com "Laguna XS 2.1: 160+ Tok/s on Apple M5 Max (33B MoE ..."
[2]: https://github.com/jundot/omlx?utm_source=chatgpt.com "jundot/omlx: LLM inference server with continuous ..."
[3]: https://github.com/jundot/omlx/blob/main/docs/experimental/dflash_mlx_integration.md?utm_source=chatgpt.com "omlx/docs/experimental/dflash_mlx_integration.md at main"
[4]: https://github.com/jundot/omlx/issues/1783?utm_source=chatgpt.com "Continuous batching: prefill throughput collapses at exactly 2 ..."
[5]: https://arxiv.org/abs/2605.27605?utm_source=chatgpt.com "Laguna M.1/XS.2 Technical Report"
