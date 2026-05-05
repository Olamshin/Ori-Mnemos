import { execSync } from "node:child_process";

/* ------------------------------------------------------------------ */
/*  Chat interface (generic LLM calls for explore recursion)           */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
}

/* ------------------------------------------------------------------ */
/*  Enhancement types (note promotion)                                 */
/* ------------------------------------------------------------------ */

export type VaultContext = {
  existingTitles: string[];
  recentNotes: Array<{ title: string; type: string; description: string }>;
  projectTags: string[];
};

export type EnhancementSuggestions = {
  type?: string;
  description?: string;
  project?: string[];
  reasoning?: string;
};

export type LlmConfig = {
  provider: string | null;
  model: string | null;
  api_key_env: string | null;
  api_key_cmd: string | null;
  base_url: string | null;
};

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: null,
  model: null,
  api_key_env: null,
  api_key_cmd: null,
  base_url: null,
};

export interface LlmProvider {
  enhance(
    note: {
      title: string;
      body: string;
      frontmatter: Record<string, unknown>;
    },
    context: VaultContext
  ): Promise<EnhancementSuggestions>;

  /** Generic chat completion for explore recursion and other internal reasoning. */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

/**
 * Null provider: returns empty suggestions (pure deterministic path).
 */
export class NullProvider implements LlmProvider {
  async enhance(): Promise<EnhancementSuggestions> {
    return {};
  }
  async chat(): Promise<string> {
    return "";
  }
}

function resolveApiKey(config: LlmConfig): string | undefined {
  if (config.api_key_cmd) {
    try {
      const key = execSync(config.api_key_cmd, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (key) {
        return key;
      }
    } catch (err) {
      console.error(`api_key_cmd failed: ${(err as Error).message}`);
    }
  }

  if (config.api_key_env) {
    return process.env[config.api_key_env];
  }

  return undefined;
}

/**
 * Create provider from config. Returns NullProvider when provider is null.
 */
export async function createProvider(config: LlmConfig): Promise<LlmProvider> {
  if (!config.provider) {
    return new NullProvider();
  }

  const apiKey = resolveApiKey(config);

  if (!apiKey) {
    return new NullProvider();
  }

  switch (config.provider) {
    case "anthropic": {
      const { AnthropicProvider } = await import("../providers/anthropic.js");
      return new AnthropicProvider(
        apiKey,
        config.model ?? "claude-sonnet-4-20250514"
      );
    }
    case "openai": {
      const { OpenAICompatProvider } = await import("../providers/openai-compat.js");
      return new OpenAICompatProvider(
        apiKey,
        config.model ?? "gpt-4o",
        config.base_url
      );
    }
    default:
      return new NullProvider();
  }
}
