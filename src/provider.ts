import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "local-vllm";
export const MODEL_ID = "Qwen/Qwen3-1.7B";
export const VLLM_BASE_URL = "http://127.0.0.1:8000/v1";
export const CONTEXT_WINDOW = 8192;

/**
 * Construct the only model provider used by this PoC.
 *
 * The runtime is deliberately backed by an in-memory credential store and no
 * models.json path. Registration therefore affects only this process-local
 * ModelRuntime; it cannot update or consult the user's Pi model registry.
 */
export async function createLocalVllmProvider(): Promise<{
  modelRuntime: ModelRuntime;
  model: Model<"openai-completions">;
}> {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  modelRuntime.registerProvider(PROVIDER_ID, {
    name: "Local vLLM",
    api: "openai-completions",
    baseUrl: VLLM_BASE_URL,
    // vLLM does not require authentication, but Pi requires an auth method
    // before a model is considered available. This literal is never a secret.
    apiKey: "local-vllm",
    authHeader: false,
    models: [
      {
        id: MODEL_ID,
        name: MODEL_ID,
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: CONTEXT_WINDOW,
        maxTokens: 4096,
        samplingParams: {
          // This is vLLM's supported Qwen3 switch; it is sent on every
          // OpenAI-compatible request and avoids /no_think prompt text.
          enable_thinking: false,
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
        },
      },
    ],
  });

  const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID) as
    | Model<"openai-completions">
    | undefined;
  if (!model || model.api !== "openai-completions") {
    throw new Error(`Pi did not register ${PROVIDER_ID}/${MODEL_ID}`);
  }

  return { modelRuntime, model };
}
