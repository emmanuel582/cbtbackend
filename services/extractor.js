/**
 * services/extractor.js - Dual-Engine Question Extraction (GPT + Gemini)
 * 
 * Features:
 * - Dual engine support (gpt / gemini)
 * - Aggressive exhaustive prompt engineering
 * - Image clarity guard check
 * - Diagram bounding box detection + cropping
 * - Token usage tracking
 */
const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const { withRetry } = require('../utils/retry');
const { preprocessImage, cropDiagram } = require('./cropper');

// ─── SDK Clients ───
const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;
const genAI = config.gemini.apiKey ? new GoogleGenerativeAI(config.gemini.apiKey) : null;

// ─── The Prompt (shared between both engines) ───
// This is the most critical part of the entire system.
const SYSTEM_PROMPT = `You are the world's most accurate OCR engine, purpose-built for extracting Nigerian examination past questions (WAEC, JAMB, NECO, POST-UTME, etc.) from scanned images.

═══════════════════════════════════════════════
STEP 1: IMAGE QUALITY ASSESSMENT (MANDATORY)
═══════════════════════════════════════════════
Before extracting ANY questions, you MUST first evaluate the image:
- Is it a question paper or exam document?
- Is the text legible enough to read accurately?
- Can you identify numbered questions with lettered options?

If the image is NOT a question paper, is severely blurry, upside down, or the text is completely illegible, you MUST return:
{"isClear": false, "reason": "Brief explanation of the issue", "questions": []}

Only if the image IS a readable question paper, proceed to Step 2.

═══════════════════════════════════════════════
STEP 2: EXHAUSTIVE QUESTION EXTRACTION
═══════════════════════════════════════════════
CRITICAL DIRECTIVE: You MUST extract EVERY SINGLE question visible on the page. 
This page may contain anywhere from 1 to 60+ questions.
The questions may be arranged in MULTIPLE COLUMNS (2 or even 3 columns side by side).
You MUST scan the ENTIRE image — top to bottom, left column then right column.

DO NOT STOP EARLY. DO NOT SKIP QUESTIONS. Missing even ONE question is a CRITICAL FAILURE.

Scan methodology:
1. First, identify the page layout (single column or multi-column).
2. For multi-column layouts: process LEFT column completely (top to bottom), then RIGHT column completely (top to bottom).
3. For each question found, extract:
   - The question NUMBER exactly as printed
   - The COMPLETE question text, word for word, character perfect
   - ALL options (A, B, C, D, E...) with their EXACT text
   - Whether a diagram/figure/graph/table accompanies this question

ACCURACY RULES:
- Transcribe EXACTLY as written. Do NOT paraphrase, correct grammar, or summarize.
- Preserve all mathematical expressions, chemical formulas, subscripts, superscripts.
- If text is partially unclear, transcribe your best reading and append [unclear] to that word.
- Include year references like (1978/Q1) or (WAEC 2005) if shown.
- If a question says "Use the diagram below to answer questions X and Y", note this in the text.

═══════════════════════════════════════════════
STEP 3: DIAGRAM DETECTION
═══════════════════════════════════════════════
If a question has an accompanying diagram, figure, illustration, graph, chart, or table:
- Set "hasDiagram" to true
- Provide "diagramBbox" as [ymin, xmin, ymax, xmax] with values from 0.0 to 1.0
  representing the diagram's location relative to the full image dimensions.
- Be GENEROUS with the bounding box — include some margin around the diagram.
- Multiple questions may reference the SAME diagram. In that case, give each question the SAME bounding box.

═══════════════════════════════════════════════
OUTPUT FORMAT (strict JSON, no markdown, no backticks)
═══════════════════════════════════════════════
{
  "isClear": true,
  "totalQuestionsFound": 39,
  "questions": [
    {
      "number": 1,
      "text": "Which of the following is a characteristic of a eukaryotic cell?",
      "options": ["A. Presence of organelles", "B. Presence of a cell wall", "C. Presence of large vacuoles", "D. Presence of ribosomes"],
      "hasDiagram": false,
      "diagramBbox": null
    }
  ]
}

FINAL CHECK: After generating your response, verify that "totalQuestionsFound" matches the actual length of the "questions" array. If they don't match, you have missed questions — go back and find them.`;

/**
 * Extract questions from a single image using the specified engine.
 * @param {Buffer} rawImageBuffer - Raw image file buffer.
 * @param {string} engine - 'gpt' or 'gemini'
 * @param {string} imageLabel - Label for logging.
 * @returns {Promise<{questions: Array, usage: Object, isClear: boolean, reason: string|null}>}
 */
async function extractFromImage(rawImageBuffer, engine = 'gpt', imageLabel = 'image') {
  // Preprocess: auto-rotate, resize for token efficiency
  const { buffer, width, height } = await preprocessImage(rawImageBuffer);
  const base64 = buffer.toString('base64');

  let parsed, usage;

  if (engine === 'gemini') {
    ({ parsed, usage } = await extractWithGemini(base64, imageLabel));
  } else {
    ({ parsed, usage } = await extractWithGPT(base64, imageLabel));
  }

  // Guard check: if the image wasn't clear
  if (parsed.isClear === false) {
    return {
      questions: [],
      usage,
      isClear: false,
      reason: parsed.reason || 'Image quality insufficient for extraction.',
    };
  }

  const questions = parsed.questions || [];

  // Crop diagrams
  for (const q of questions) {
    if (q.hasDiagram && q.diagramBbox && q.diagramBbox.length === 4) {
      const croppedImage = await cropDiagram(buffer, width, height, q.diagramBbox);
      if (croppedImage) {
        q.diagramImage = croppedImage;
      } else {
        console.warn(`[Extractor] Could not crop diagram for Q${q.number} in ${imageLabel}`);
      }
    }
  }

  return {
    questions,
    usage,
    isClear: true,
    reason: null,
  };
}

// ─── GPT-4o-mini Engine ───
async function extractWithGPT(base64, imageLabel) {
  if (!openai) throw new Error('OpenAI API key not configured');

  const response = await withRetry(
    () => openai.chat.completions.create({
      model: config.openai.model,
      max_tokens: config.openai.maxTokens,
      temperature: config.openai.temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract ALL questions from this past question paper image. Scan every column, every row. Do not stop early.',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
    }),
    {},
    `GPT extraction for ${imageLabel}`
  );

  const rawContent = response.choices?.[0]?.message?.content;
  if (!rawContent) throw new Error(`Empty GPT response for ${imageLabel}`);

  const parsed = parseJSON(rawContent, imageLabel);
  const tokenUsage = response.usage || {};

  return {
    parsed,
    usage: {
      prompt_tokens: tokenUsage.prompt_tokens || 0,
      completion_tokens: tokenUsage.completion_tokens || 0,
      total_tokens: tokenUsage.total_tokens || 0,
    },
  };
}

// ─── Gemini Engine ───
async function extractWithGemini(base64, imageLabel) {
  if (!genAI) throw new Error('Gemini API key not configured');

  const model = genAI.getGenerativeModel({
    model: config.gemini.model,
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: config.gemini.maxOutputTokens,
      temperature: config.gemini.temperature,
    },
  });

  const imagePart = {
    inlineData: {
      data: base64,
      mimeType: 'image/png',
    },
  };

  const result = await withRetry(
    async () => {
      const res = await model.generateContent([
        SYSTEM_PROMPT + '\n\nExtract ALL questions from this past question paper image. Scan every column, every row. Do not stop early.',
        imagePart,
      ]);
      return res;
    },
    {},
    `Gemini extraction for ${imageLabel}`
  );

  const response = result.response;
  const rawContent = response.text();
  if (!rawContent) throw new Error(`Empty Gemini response for ${imageLabel}`);

  const parsed = parseJSON(rawContent, imageLabel);

  // Extract token usage from Gemini's usageMetadata
  const meta = response.usageMetadata || {};
  const usage = {
    prompt_tokens: meta.promptTokenCount || 0,
    completion_tokens: meta.candidatesTokenCount || 0,
    total_tokens: meta.totalTokenCount || 0,
  };

  return { parsed, usage };
}

// ─── JSON Parser with fallback ───
function parseJSON(rawContent, label) {
  try {
    return JSON.parse(rawContent);
  } catch (_) {
    // Try to extract from markdown fences
    const match = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch (e2) {
        throw new Error(`Failed to parse JSON from ${label}: ${rawContent.substring(0, 300)}`);
      }
    }
    throw new Error(`Failed to parse JSON from ${label}: ${rawContent.substring(0, 300)}`);
  }
}

module.exports = { extractFromImage };
