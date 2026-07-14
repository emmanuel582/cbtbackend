/**
 * utils/retry.js - Exponential Backoff Retry with Jitter
 * Production-grade retry handler for API calls.
 */
const config = require('../config');

/**
 * Executes an async function with exponential backoff retry.
 * @param {Function} fn - Async function to execute.
 * @param {Object} opts - Override default retry options.
 * @param {string} label - Human-readable label for logging.
 * @returns {Promise<*>} - Result of the function.
 */
async function withRetry(fn, opts = {}, label = 'operation') {
  const {
    maxAttempts = config.retry.maxAttempts,
    initialDelayMs = config.retry.initialDelayMs,
    maxDelayMs = config.retry.maxDelayMs,
    backoffMultiplier = config.retry.backoffMultiplier,
    retryableStatusCodes = config.retry.retryableStatusCodes,
  } = opts;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const statusCode = error?.status || error?.response?.status;
      const isRetryable = retryableStatusCodes.includes(statusCode) ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.message?.includes('rate_limit');

      if (!isRetryable || attempt === maxAttempts) {
        console.error(`[Retry] ${label} failed permanently after ${attempt} attempt(s):`, error.message);
        throw error;
      }

      // Calculate delay with jitter to avoid thundering herd
      const baseDelay = Math.min(initialDelayMs * Math.pow(backoffMultiplier, attempt - 1), maxDelayMs);
      const jitter = baseDelay * 0.2 * Math.random(); // 0-20% jitter
      const delay = Math.floor(baseDelay + jitter);

      // If rate limited, respect the Retry-After header
      const retryAfter = error?.response?.headers?.['retry-after'];
      const actualDelay = retryAfter ? Math.max(delay, parseInt(retryAfter, 10) * 1000) : delay;

      console.warn(`[Retry] ${label} attempt ${attempt}/${maxAttempts} failed (status: ${statusCode || 'N/A'}). Retrying in ${actualDelay}ms...`);
      await sleep(actualDelay);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { withRetry, sleep };
