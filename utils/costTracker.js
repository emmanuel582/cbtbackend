/**
 * utils/costTracker.js - Token Usage & Cost Calculator (Dual Engine)
 * Tracks cumulative token usage across a job and calculates cost in USD and NGN.
 * Supports different pricing for GPT vs Gemini.
 */
const config = require('../config');

class CostTracker {
  constructor(engine = 'gpt') {
    this.engine = engine;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.totalTokens = 0;
    this.requestCount = 0;
    this.perImageBreakdown = [];
  }

  /**
   * Record token usage from a single API call.
   * @param {Object} usage - { prompt_tokens, completion_tokens, total_tokens }
   * @param {string} imageLabel
   */
  record(usage, imageLabel = '') {
    if (!usage) return;

    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || (promptTokens + completionTokens);

    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.totalTokens += totalTokens;
    this.requestCount++;

    const pricing = this.engine === 'gemini' ? config.pricing.gemini : config.pricing.gpt;
    const inputCost = (promptTokens / 1_000_000) * pricing.inputPerMillion;
    const outputCost = (completionTokens / 1_000_000) * pricing.outputPerMillion;

    this.perImageBreakdown.push({
      label: imageLabel,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd: inputCost + outputCost,
    });
  }

  /**
   * Get the full cost summary.
   */
  getSummary() {
    const pricing = this.engine === 'gemini' ? config.pricing.gemini : config.pricing.gpt;
    const inputCostUsd = (this.totalPromptTokens / 1_000_000) * pricing.inputPerMillion;
    const outputCostUsd = (this.totalCompletionTokens / 1_000_000) * pricing.outputPerMillion;
    const totalCostUsd = inputCostUsd + outputCostUsd;
    const totalCostNgn = totalCostUsd * config.pricing.usdToNgn;

    return {
      engine: this.engine,
      tokens: {
        prompt: this.totalPromptTokens,
        completion: this.totalCompletionTokens,
        total: this.totalTokens,
      },
      cost: {
        inputUsd: parseFloat(inputCostUsd.toFixed(6)),
        outputUsd: parseFloat(outputCostUsd.toFixed(6)),
        totalUsd: parseFloat(totalCostUsd.toFixed(6)),
        totalNgn: parseFloat(totalCostNgn.toFixed(2)),
      },
      requestCount: this.requestCount,
      perImage: this.perImageBreakdown,
    };
  }
}

module.exports = CostTracker;
