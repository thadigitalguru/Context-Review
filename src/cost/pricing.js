const MODEL_PRICING = {
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30, contextWindow: 200000 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30, contextWindow: 200000 },
  'claude-3-5-sonnet-20240620': { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30, contextWindow: 200000 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, cacheWrite: 1.00, cacheRead: 0.08, contextWindow: 200000 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50, contextWindow: 200000 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25, cacheWrite: 0.30, cacheRead: 0.03, contextWindow: 200000 },
  'claude-opus-4-20250514': { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50, contextWindow: 200000 },
  'gpt-4o': { input: 2.50, output: 10.00, contextWindow: 128000 },
  'gpt-4o-mini': { input: 0.15, output: 0.60, contextWindow: 128000 },
  'gpt-4-turbo': { input: 10.00, output: 30.00, contextWindow: 128000 },
  'gpt-4': { input: 30.00, output: 60.00, contextWindow: 8192 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50, contextWindow: 16385 },
  'o1': { input: 15.00, output: 60.00, contextWindow: 200000 },
  'o1-mini': { input: 3.00, output: 12.00, contextWindow: 128000 },
  'o1-pro': { input: 150.00, output: 600.00, contextWindow: 200000 },
  'o3': { input: 10.00, output: 40.00, contextWindow: 200000 },
  'o3-mini': { input: 1.10, output: 4.40, contextWindow: 200000 },
  'o4-mini': { input: 1.10, output: 4.40, contextWindow: 200000 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00, contextWindow: 1048576 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60, contextWindow: 1048576 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40, contextWindow: 1048576 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00, contextWindow: 2097152 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30, contextWindow: 1048576 },
};

function findPricing(model) {
  if (!model) return getDefaultPricing();

  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.includes(key) || key.includes(model)) return pricing;
  }

  if (model.includes('claude')) {
    if (model.includes('haiku')) return MODEL_PRICING['claude-3-5-haiku-20241022'];
    if (model.includes('opus')) return MODEL_PRICING['claude-3-opus-20240229'];
    return MODEL_PRICING['claude-sonnet-4-20250514'];
  }
  if (model.includes('gpt-4o')) return MODEL_PRICING['gpt-4o'];
  if (model.includes('gpt-4')) return MODEL_PRICING['gpt-4-turbo'];
  if (model.includes('gpt-3')) return MODEL_PRICING['gpt-3.5-turbo'];
  if (model.includes('gemini')) return MODEL_PRICING['gemini-2.5-flash'];

  return getDefaultPricing();
}

function getDefaultPricing() {
  return { input: 3.00, output: 15.00, contextWindow: 200000 };
}

function calculateCost(inputTokens, outputTokens, model, cacheTokens) {
  const pricing = findPricing(model);
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  let cacheSavings = 0;
  if (cacheTokens && pricing.cacheRead) {
    const cacheReadTokens = cacheTokens.read || 0;
    const fullPriceCost = (cacheReadTokens / 1_000_000) * pricing.input;
    const discountedCost = (cacheReadTokens / 1_000_000) * pricing.cacheRead;
    cacheSavings = fullPriceCost - discountedCost;
  }

  return {
    inputCost: Math.round(inputCost * 1_000_000) / 1_000_000,
    outputCost: Math.round(outputCost * 1_000_000) / 1_000_000,
    totalCost: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
    cacheSavings: Math.round(cacheSavings * 1_000_000) / 1_000_000,
    pricing,
    model,
  };
}

function getContextWindow(model) {
  const pricing = findPricing(model);
  return pricing.contextWindow;
}

module.exports = { calculateCost, findPricing, getContextWindow, MODEL_PRICING };
