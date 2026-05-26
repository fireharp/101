import { config } from "../config.js";

export type OpenRouterModelPolicy = "free-pinned" | "free-router";

export const FREE_PINNED_OPENROUTER_MODELS = [
  "openrouter/owl-alpha",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
] as const;

export const FREE_ROUTER_MODEL = "openrouter/free";

export interface OpenRouterModel {
  id: string;
  name?: string;
  architecture?: { output_modalities?: string[] };
  pricing?: Record<string, string | number | null | undefined>;
  supported_parameters?: string[];
}

export interface OpenRouterChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class OpenRouterError extends Error {
  status: number | null;
  retryable: boolean;
  body: unknown;

  constructor(opts: {
    message: string;
    status?: number | null;
    retryable?: boolean;
    body?: unknown;
  }) {
    super(opts.message);
    this.name = "OpenRouterError";
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? false;
    this.body = opts.body ?? null;
  }
}

type FetchImpl = typeof fetch;

let cachedModels: { expiresAt: number; models: OpenRouterModel[] } | null = null;
const cooldownUntilByModel = new Map<string, number>();

export function hasOpenRouter(): boolean {
  return Boolean(config.openRouterApiKey);
}

export function resetOpenRouterCaches(): void {
  cachedModels = null;
  cooldownUntilByModel.clear();
}

export function isZeroCostTextModel(model: OpenRouterModel): boolean {
  const outputs = model.architecture?.output_modalities ?? [];
  if (!outputs.includes("text")) return false;
  const pricing = model.pricing ?? {};
  const keys = ["prompt", "completion", "request", "internal_reasoning"];
  return keys.every((key) => Number(pricing[key] ?? 0) === 0);
}

export function modelSupportsJson(model: OpenRouterModel): boolean {
  const params = new Set(model.supported_parameters ?? []);
  return params.has("response_format") || params.has("structured_outputs");
}

export function selectOpenRouterModels(
  models: OpenRouterModel[],
  policy: OpenRouterModelPolicy,
): string[] {
  const free = models.filter(isZeroCostTextModel);
  const freeIds = new Set(free.map((m) => m.id));
  if (policy === "free-router") {
    return freeIds.has(FREE_ROUTER_MODEL) ? [FREE_ROUTER_MODEL] : [];
  }
  const jsonCapable = new Set(
    free.filter(modelSupportsJson).map((m) => m.id),
  );
  return FREE_PINNED_OPENROUTER_MODELS.filter((id) => freeIds.has(id)).sort(
    (a, b) => Number(!jsonCapable.has(a)) - Number(!jsonCapable.has(b)),
  );
}

export function isOpenRouterModelOnCooldown(
  model: string,
  now = Date.now(),
): boolean {
  return (cooldownUntilByModel.get(model) ?? 0) > now;
}

export function markOpenRouterModelUnavailable(
  model: string,
  now = Date.now(),
): void {
  cooldownUntilByModel.set(model, now + config.openRouterCooldownMs);
}

export async function fetchOpenRouterModels(
  fetchImpl: FetchImpl = fetch,
): Promise<OpenRouterModel[]> {
  const now = Date.now();
  if (cachedModels && cachedModels.expiresAt > now) {
    return cachedModels.models;
  }
  const url = new URL(`${config.openRouterBaseUrl.replace(/\/$/, "")}/models`);
  url.searchParams.set("output_modalities", "text");
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new OpenRouterError({
      message: `OpenRouter model list failed: ${res.status} ${res.statusText}`,
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
      body: await safeJson(res),
    });
  }
  const json = (await res.json()) as { data?: OpenRouterModel[] };
  cachedModels = {
    expiresAt: now + config.openRouterModelTtlMs,
    models: json.data ?? [],
  };
  return cachedModels.models;
}

export async function chatCompletionJson(opts: {
  model: string;
  messages: OpenRouterChatMessage[];
  fetchImpl?: FetchImpl;
}): Promise<{
  content: string;
  raw: Record<string, unknown>;
  latency_ms: number;
  model: string;
}> {
  if (!config.openRouterApiKey) {
    throw new OpenRouterError({
      message: "OPENROUTER_API_KEY not configured on backend",
      status: null,
      retryable: false,
    });
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.openRouterTimeoutMs,
  );
  try {
    const res = await fetchImpl(
      `${config.openRouterBaseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.openRouterApiKey}`,
          "content-type": "application/json",
          "http-referer": config.frontendOrigin,
          "x-title": "Drill Coach",
        },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          temperature: 0.1,
          max_tokens: 900,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      },
    );
    const raw = await safeJson(res);
    if (!res.ok) {
      throw new OpenRouterError({
        message: `OpenRouter chat failed for ${opts.model}: ${res.status} ${res.statusText}`,
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        body: raw,
      });
    }
    const record = raw as {
      model?: string;
      choices?: { message?: { content?: string } }[];
    };
    const content = record.choices?.[0]?.message?.content;
    if (!content) {
      throw new OpenRouterError({
        message: `OpenRouter chat returned no content for ${opts.model}`,
        status: null,
        retryable: true,
        body: raw,
      });
    }
    return {
      content,
      raw: raw as Record<string, unknown>,
      latency_ms: Date.now() - started,
      model: record.model ?? opts.model,
    };
  } catch (err) {
    if (err instanceof OpenRouterError) throw err;
    throw new OpenRouterError({
      message:
        err instanceof Error && err.name === "AbortError"
          ? `OpenRouter chat timed out for ${opts.model}`
          : (err as Error).message,
      status: null,
      retryable: true,
      body: null,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}
