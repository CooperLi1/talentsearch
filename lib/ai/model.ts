import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

const DEFAULT_TEXT_MODEL = "openai/gpt-4o-mini";

export function resolveTextModel(
  requested = process.env.AI_MODEL || DEFAULT_TEXT_MODEL,
): LanguageModel | string | null {
  if (process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY) {
    return requested.includes("/") ? requested : `openai/${requested}`;
  }
  if (process.env.OPENAI_API_KEY) {
    const directModel = requested.startsWith("openai/")
      ? requested.slice("openai/".length)
      : requested.includes("/")
        ? "gpt-4o-mini"
        : requested;
    return openai(directModel);
  }
  return null;
}
