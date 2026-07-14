/**
 * server.js - CBT Question Extractor Pro API Server (V2 - Dual Engine + PDF)
 *
 * Endpoints:
 *   POST /api/extract         - Single image/PDF extraction
 *   POST /api/extract/bulk    - Bulk upload (multiple images/PDFs)
 *   GET  /api/jobs/:id        - Get job status & results
 *   GET  /api/jobs/:id/stream - SSE stream for real-time progress
 */
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const CostTracker = require('./utils/costTracker');
const { extractFromImage } = require('./services/extractor');
const { pdfToImages } = require('./services/pdfParser');
const { createJob, getJob, processJob, registerSSEClient } = require('./services/jobManager');

const app = express();

// ──────────────────────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.upload.maxFileSizeMb * 1024 * 1024,
    files: config.bulk.maxFiles,
  },
  fileFilter: (_req, file, cb) => {
    if (config.upload.allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${config.upload.allowedMimeTypes.join(', ')}`));
    }
  },
});

// ──────────────────────────────────────────────────────────────
// Helper: Convert PDF buffer to image buffers
// ──────────────────────────────────────────────────────────────
async function expandFiles(files) {
  const expanded = [];

  for (const file of files) {
    if (file.mimetype === 'application/pdf') {
      console.log(`[Server] Converting PDF "${file.originalname}" to images...`);
      try {
        const pageImages = await pdfToImages(file.buffer);
        pageImages.forEach((imgBuffer, idx) => {
          expanded.push({
            buffer: imgBuffer,
            originalName: `${file.originalname} (Page ${idx + 1})`,
          });
        });
        console.log(`[Server] PDF "${file.originalname}" expanded to ${pageImages.length} page images.`);
      } catch (err) {
        console.error(`[Server] Failed to convert PDF "${file.originalname}":`, err.message);
        // Still add it as a failed entry so the user sees the error
        expanded.push({
          buffer: file.buffer,
          originalName: file.originalname,
          _pdfError: err.message,
        });
      }
    } else {
      expanded.push({
        buffer: file.buffer,
        originalName: file.originalname,
      });
    }
  }

  return expanded;
}

// ──────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────

/**
 * POST /api/extract
 * Single file extraction. Supports images and PDFs.
 * Query params: ?engine=gpt|gemini (default: gpt)
 */
app.post('/api/extract', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided. Use field name "image".' });
    }

    const engine = req.query.engine || req.body.engine || 'gpt';
    const validEngines = ['gpt', 'gemini'];
    if (!validEngines.includes(engine)) {
      return res.status(400).json({ success: false, error: `Invalid engine. Use: ${validEngines.join(', ')}` });
    }

    console.log(`[API] Single extraction: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB) | Engine: ${engine}`);

    // Handle PDF: convert to images and process each page
    if (req.file.mimetype === 'application/pdf') {
      const pageImages = await pdfToImages(req.file.buffer);

      if (pageImages.length === 0) {
        return res.status(400).json({ success: false, error: 'Failed to extract any pages from PDF.' });
      }

      const tracker = new CostTracker(engine);
      const allQuestions = [];
      const warnings = [];
      let globalNum = 1;

      for (let i = 0; i < pageImages.length; i++) {
        const label = `${req.file.originalname} (Page ${i + 1})`;
        try {
          const { questions, usage, isClear, reason } = await extractFromImage(pageImages[i], engine, label);
          tracker.record(usage, label);

          if (!isClear) {
            warnings.push({ page: i + 1, reason });
          } else {
            for (const q of questions) {
              q.globalNumber = globalNum++;
              q.sourceImage = label;
            }
            allQuestions.push(...questions);
          }
        } catch (err) {
          console.error(`[API] Failed page ${i + 1}:`, err.message);
          warnings.push({ page: i + 1, reason: err.message });
        }
      }

      const cost = tracker.getSummary();
      console.log(`[API] PDF extracted: ${allQuestions.length} questions from ${pageImages.length} pages | ₦${cost.cost.totalNgn}`);

      return res.json({
        success: true,
        data: allQuestions,
        totalQuestions: allQuestions.length,
        warnings,
        cost,
      });
    }

    // Handle single image
    const tracker = new CostTracker(engine);
    const { questions, usage, isClear, reason } = await extractFromImage(req.file.buffer, engine, req.file.originalname);
    tracker.record(usage, req.file.originalname);

    const cost = tracker.getSummary();

    if (!isClear) {
      console.log(`[API] Guard check failed: ${reason}`);
      return res.json({
        success: true,
        data: [],
        totalQuestions: 0,
        isClear: false,
        reason,
        cost,
      });
    }

    console.log(`[API] Extracted ${questions.length} questions | Engine: ${engine} | ₦${cost.cost.totalNgn}`);

    res.json({
      success: true,
      data: questions,
      totalQuestions: questions.length,
      isClear: true,
      cost,
    });
  } catch (err) {
    console.error('[API] Extraction failed:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      hint: 'Check your API key, image format, or try again.',
    });
  }
});

/**
 * POST /api/extract/bulk
 * Bulk file upload. Supports mix of images and PDFs.
 * Query params: ?engine=gpt|gemini
 */
app.post('/api/extract/bulk', upload.array('images', config.bulk.maxFiles), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files provided. Use field name "images".' });
    }

    const engine = req.query.engine || req.body.engine || 'gpt';
    console.log(`[API] Bulk extraction: ${req.files.length} files | Engine: ${engine}`);

    // Expand PDFs into individual page images
    const images = await expandFiles(req.files);
    console.log(`[API] Expanded to ${images.length} total images (after PDF conversion)`);

    const jobId = createJob(images, engine);

    // Process in background
    processJob(jobId).catch(err => {
      console.error(`[API] Background job ${jobId} crashed:`, err.message);
    });

    res.json({
      success: true,
      jobId,
      totalImages: images.length,
      engine,
      message: `Job created. Track at GET /api/jobs/${jobId} or stream at GET /api/jobs/${jobId}/stream`,
    });
  } catch (err) {
    console.error('[API] Bulk upload failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/jobs/:id
 */
app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or expired.' });
  }
  res.json({ success: true, ...job });
});

/**
 * GET /api/jobs/:id/stream
 */
app.get('/api/jobs/:id/stream', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or expired.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  res.write(`event: status\ndata: ${JSON.stringify({ status: job.status, processedImages: job.processedImages, totalImages: job.totalImages })}\n\n`);

  registerSSEClient(req.params.id, res);

  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (_) { clearInterval(keepAlive); }
  }, 15000);

  req.on('close', () => clearInterval(keepAlive));
});

// ──────────────────────────────────────────────────────────────
// Global Error Handler
// ──────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      error: err.code === 'LIMIT_FILE_SIZE'
        ? `File too large. Max: ${config.upload.maxFileSizeMb}MB`
        : err.message,
    });
  }

  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({ success: false, error: err.message });
});

// ──────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`\n╔════════════════════════════════════════════════════╗`);
  console.log(`║   CBT Extractor Pro v2 — Dual Engine Server        ║`);
  console.log(`║   http://localhost:${config.port}                          ║`);
  console.log(`║   GPT Engine:    ${config.openai.apiKey ? '✓ Ready' : '✗ No key'}                         ║`);
  console.log(`║   Gemini Engine: ${config.gemini.apiKey ? '✓ Ready' : '✗ No key'}                         ║`);
  console.log(`║   PDF Support:   ✓ Enabled                         ║`);
  console.log(`║   Guard Check:   ✓ Enabled                         ║`);
  console.log(`╚════════════════════════════════════════════════════╝\n`);
});
