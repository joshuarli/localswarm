import {
  InMemoryCredentialStore,
  type ChatTemplateKwargValue,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "local-vllm";
export const DEFAULT_MODEL_ID = "Qwen/Qwen3-1.7B";
export const MODEL_ID = Deno.env.get("LOCAL_VLLM_MODEL_ID") ??
  DEFAULT_MODEL_ID;
export const VLLM_BASE_URL = "http://127.0.0.1:8000/v1";
export const CONTEXT_WINDOW = 32768;

interface ModelProfile {
  samplingParams?: Record<string, unknown>;
  maxTokens: number;
  thinkingFormat: "qwen" | "chat-template";
  chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
  supportsThinkingTokenBudget: boolean;
}

function modelProfile(modelId: string): ModelProfile {
  if (modelId.toLowerCase().includes("glm-4.7")) {
    return {
      thinkingFormat: "chat-template",
      samplingParams: {
        temperature: 0.7,
        top_p: 1.0,
      },
      chatTemplateKwargs: {
        enable_thinking: { $var: "thinking.enabled" },
        clear_thinking: false,
      },
      maxTokens: 16_384,
      supportsThinkingTokenBudget: false,
    };
  }

  if (modelId.toLowerCase().includes("qwen3.5")) {
    return {
      thinkingFormat: "qwen",
      samplingParams: {
        enable_thinking: true,
        temperature: 0.6,
        top_p: 0.95,
        top_k: 20,
        presence_penalty: 0,
        repetition_penalty: 1,
      },
      maxTokens: 8_192,
      supportsThinkingTokenBudget: true,
    };
  }

  return {
    thinkingFormat: "qwen",
    samplingParams: { enable_thinking: true },
    maxTokens: 8_192,
    supportsThinkingTokenBudget: true,
  };
}

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
  const profile = modelProfile(MODEL_ID);
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
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: CONTEXT_WINDOW,
        maxTokens: profile.maxTokens,
        samplingParams: profile.samplingParams,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsThinkingTokenBudget: profile.supportsThinkingTokenBudget,
          thinkingFormat: profile.thinkingFormat,
          chatTemplateKwargs: profile.chatTemplateKwargs,
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
