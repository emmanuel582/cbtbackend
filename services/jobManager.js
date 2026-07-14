/**
 * services/jobManager.js - Bulk Processing Job Manager (Dual Engine)
 * Manages bulk image extraction jobs with SSE progress tracking.
 * Supports engine selection (gpt/gemini) per job.
 */
const crypto = require('crypto');
const config = require('../config');
const CostTracker = require('../utils/costTracker');
const { extractFromImage } = require('./extractor');

const jobs = new Map();
const sseClients = new Map();

const JobStatus = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PARTIAL: 'partial',
};

/**
 * Create a new extraction job.
 * @param {Array<{buffer: Buffer, originalName: string}>} images
 * @param {string} engine - 'gpt' or 'gemini'
 * @returns {string} jobId
 */
function createJob(images, engine = 'gpt') {
  const jobId = crypto.randomUUID();

  const job = {
    id: jobId,
    engine,
    status: JobStatus.QUEUED,
    createdAt: Date.now(),
    totalImages: images.length,
    processedImages: 0,
    failedImages: 0,
    skippedImages: 0,       // Images flagged as unclear
    questions: [],
    errors: [],
    warnings: [],           // Guard check warnings
    costTracker: new CostTracker(engine),
    images,
  };

  jobs.set(jobId, job);

  setTimeout(() => {
    jobs.delete(jobId);
    sseClients.delete(jobId);
  }, config.bulk.jobTtlMs);

  return jobId;
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;

  return {
    id: job.id,
    engine: job.engine,
    status: job.status,
    createdAt: job.createdAt,
    totalImages: job.totalImages,
    processedImages: job.processedImages,
    failedImages: job.failedImages,
    skippedImages: job.skippedImages,
    questions: job.questions,
    errors: job.errors,
    warnings: job.warnings,
    cost: job.costTracker.getSummary(),
  };
}

function registerSSEClient(jobId, res) {
  if (!sseClients.has(jobId)) {
    sseClients.set(jobId, []);
  }
  sseClients.get(jobId).push(res);

  res.on('close', () => {
    const clients = sseClients.get(jobId);
    if (clients) {
      const idx = clients.indexOf(res);
      if (idx !== -1) clients.splice(idx, 1);
    }
  });
}

function emitSSE(jobId, event, data) {
  const clients = sseClients.get(jobId);
  if (!clients) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (_) {}
  }
}

/**
 * Process a bulk extraction job in the background.
 */
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = JobStatus.PROCESSING;
  emitSSE(jobId, 'status', { status: job.status, processedImages: 0, totalImages: job.totalImages });

  const { images, engine } = job;
  const concurrency = config.bulk.concurrency;
  let globalQuestionNumber = 1;

  for (let i = 0; i < images.length; i += concurrency) {
    const batch = images.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      batch.map((img, batchIdx) => {
        const label = img.originalName || `Image ${i + batchIdx + 1}`;
        return extractFromImage(img.buffer, engine, label);
      })
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const label = batch[j].originalName || `Image ${i + j + 1}`;

      if (result.status === 'fulfilled') {
        const { questions, usage, isClear, reason } = result.value;

        if (!isClear) {
          // Guard check failed — image was unclear
          job.skippedImages++;
          job.warnings.push({
            image: label,
            reason: reason,
          });
          console.warn(`[JobManager] Skipped ${label}: ${reason}`);
        } else {
          for (const q of questions) {
            q.globalNumber = globalQuestionNumber++;
            q.sourceImage = label;
          }
          job.questions.push(...questions);
        }

        job.costTracker.record(usage, label);
      } else {
        job.failedImages++;
        job.errors.push({
          image: label,
          error: result.reason?.message || 'Unknown error',
        });
        console.error(`[JobManager] Failed ${label}:`, result.reason?.message);
      }

      job.processedImages++;

      emitSSE(jobId, 'progress', {
        processedImages: job.processedImages,
        totalImages: job.totalImages,
        failedImages: job.failedImages,
        skippedImages: job.skippedImages,
        lastProcessed: label,
        questionsExtracted: job.questions.length,
        cost: job.costTracker.getSummary().cost,
      });
    }
  }

  // Final status
  if (job.failedImages === 0 && job.skippedImages === 0) {
    job.status = JobStatus.COMPLETED;
  } else if (job.questions.length > 0) {
    job.status = JobStatus.PARTIAL;
  } else {
    job.status = JobStatus.FAILED;
  }

  // Free memory
  job.images = null;

  emitSSE(jobId, 'complete', {
    status: job.status,
    totalQuestions: job.questions.length,
    warnings: job.warnings,
    cost: job.costTracker.getSummary(),
  });

  console.log(`[JobManager] Job ${jobId} finished: ${job.status} | ${job.questions.length} questions | ₦${job.costTracker.getSummary().cost.totalNgn}`);
}

module.exports = {
  createJob,
  getJob,
  processJob,
  registerSSEClient,
  JobStatus,
};
