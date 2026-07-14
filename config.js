/**
 * config.js - Centralized Configuration for Dual-Engine CBT Extractor
 * Manages OpenAI GPT and Google Gemini settings, pricing, limits.
 */
require('dotenv').config();

const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 3000,

  // ─── OpenAI (GPT-4o-mini) ───
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
    maxTokens: 16384,       // Increased from 4096 — critical for dense pages with 30+ questions
    temperature: 0.05,      // Near-zero for maximum accuracy
  },

  // ─── Google Gemini (Free tier) ───
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: 'gemini-flash-latest',
    maxOutputTokens: 16384,
    temperature: 0.05,
  },

  // ─── Pricing ───
  pricing: {
    // GPT-4o-mini
    gpt: {
      inputPerMillion: 0.15,
      outputPerMillion: 0.60,
    },
    // Gemini 1.5 Flash (free tier — $0 for first 1500 req/day)
    gemini: {
      inputPerMillion: 0.0,   // Free tier
      outputPerMillion: 0.0,  // Free tier
    },
    usdToNgn: 1380,
  },

  // ─── Image Processing ───
  image: {
    maxWidthPx: 2048,
    maxHeightPx: 2048,
    cropPaddingPercent: 0.02,
    outputQuality: 90,
  },

  // ─── Retry Policy ───
  retry: {
    maxAttempts: 3,
    initialDelayMs: 1500,
    maxDelayMs: 20000,
    backoffMultiplier: 2,
    retryableStatusCodes: [429, 500, 502, 503, 504],
  },

  // ─── Bulk Processing ───
  bulk: {
    maxFiles: 500,
    concurrency: 2,           // Conservative for rate limits
    jobTtlMs: 2 * 60 * 60 * 1000, // 2 hours
  },

  // ─── Upload ───
  upload: {
    maxFileSizeMb: 25,
    allowedMimeTypes: [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp',
      'application/pdf',
    ],
  },
};

// Validate critical config
if (!config.openai.apiKey && !config.gemini.apiKey) {
  console.error('FATAL: At least one API key (OPENAI_API_KEY or GEMINI_API_KEY) must be set in .env');
  process.exit(1);
}

module.exports = config;
