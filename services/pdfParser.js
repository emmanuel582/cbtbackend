/**
 * services/pdfParser.js - PDF to Image Conversion
 * Converts each page of a PDF into a high-resolution image buffer
 * using pdfjs-dist + canvas (pure JS, no Ghostscript needed).
 */
const { createCanvas } = require('canvas');

/**
 * Convert a PDF buffer into an array of PNG image buffers (one per page).
 * @param {Buffer} pdfBuffer - The raw PDF file buffer.
 * @param {number} scale - Render scale (2.0 = 2x resolution, good for OCR).
 * @returns {Promise<Buffer[]>} - Array of PNG image buffers.
 */
async function pdfToImages(pdfBuffer, scale = 2.5) {
  // Dynamic import because pdfjs-dist uses ES modules in newer versions
  let pdfjsLib;
  try {
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  } catch (_) {
    pdfjsLib = require('pdfjs-dist');
  }

  // Disable worker to avoid issues in Node.js
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableFontFace: true,
    useSystemFonts: false,
  });

  const pdfDocument = await loadingTask.promise;
  const totalPages = pdfDocument.numPages;
  const images = [];

  console.log(`[PDFParser] Converting ${totalPages} pages to images (scale: ${scale}x)...`);

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      const page = await pdfDocument.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');

      // White background (PDFs can have transparent backgrounds)
      context.fillStyle = '#FFFFFF';
      context.fillRect(0, 0, viewport.width, viewport.height);

      await page.render({
        canvasContext: context,
        viewport: viewport,
      }).promise;

      const pngBuffer = canvas.toBuffer('image/png');
      images.push(pngBuffer);

      console.log(`[PDFParser] Page ${pageNum}/${totalPages} converted (${(pngBuffer.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.error(`[PDFParser] Failed to convert page ${pageNum}:`, err.message);
      // Push null so we can track which pages failed
      images.push(null);
    }
  }

  // Filter out failed pages
  const successfulImages = images.filter(img => img !== null);
  console.log(`[PDFParser] Done. ${successfulImages.length}/${totalPages} pages converted successfully.`);

  return successfulImages;
}

module.exports = { pdfToImages };
