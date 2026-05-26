import test from "node:test";
import assert from "node:assert/strict";
import {
  FREE_PINNED_OPENROUTER_MODELS,
  FREE_ROUTER_MODEL,
  isZeroCostTextModel,
  resetOpenRouterCaches,
  selectOpenRouterModels,
  type OpenRouterModel,
} from "./openrouter.js";

test.afterEach(() => resetOpenRouterCaches());

test("OpenRouter zero-cost filter rejects paid and non-text models", () => {
  const freeText: OpenRouterModel = {
    id: "free/text",
    architecture: { output_modalities: ["text"] },
    pricing: { prompt: "0", completion: "0", request: "0", internal_reasoning: "0" },
  };
  const paidText: OpenRouterModel = {
    id: "paid/text",
    architecture: { output_modalities: ["text"] },
    pricing: { prompt: "0.1", completion: "0", request: "0", internal_reasoning: "0" },
  };
  const freeImage: OpenRouterModel = {
    id: "free/image",
    architecture: { output_modalities: ["image"] },
    pricing: { prompt: "0", completion: "0", request: "0", internal_reasoning: "0" },
  };

  assert.equal(isZeroCostTextModel(freeText), true);
  assert.equal(isZeroCostTextModel(paidText), false);
  assert.equal(isZeroCostTextModel(freeImage), false);
});

test("OpenRouter selection uses pinned zero-cost models and free router only when free", () => {
  const models: OpenRouterModel[] = [
    {
      id: FREE_PINNED_OPENROUTER_MODELS[1],
      architecture: { output_modalities: ["text"] },
      pricing: { prompt: "0", completion: "0", request: "0", internal_reasoning: "0" },
      supported_parameters: ["response_format"],
    },
    {
      id: FREE_PINNED_OPENROUTER_MODELS[2],
      architecture: { output_modalities: ["text"] },
      pricing: { prompt: "0.02", completion: "0", request: "0", internal_reasoning: "0" },
      supported_parameters: ["response_format"],
    },
    {
      id: FREE_ROUTER_MODEL,
      architecture: { output_modalities: ["text"] },
      pricing: { prompt: "0", completion: "0", request: "0", internal_reasoning: "0" },
      supported_parameters: ["response_format"],
    },
  ];

  assert.deepEqual(selectOpenRouterModels(models, "free-pinned"), [
    FREE_PINNED_OPENROUTER_MODELS[1],
  ]);
  assert.deepEqual(selectOpenRouterModels(models, "free-router"), [
    FREE_ROUTER_MODEL,
  ]);
});
