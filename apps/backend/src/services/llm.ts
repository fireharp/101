import OpenAI from "openai";
import { config } from "../config.js";

let _client: OpenAI | null = null;

export function openai(): OpenAI {
  if (!_client) {
    if (!config.openaiApiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set — cannot use OpenAI features",
      );
    }
    _client = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return _client;
}

export function hasOpenAI(): boolean {
  return Boolean(config.openaiApiKey);
}
