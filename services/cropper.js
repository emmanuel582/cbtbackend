/**
 * services/cropper.js - Diagram Cropping Service
 * Precisely crops diagrams from question images using bounding box coordinates.
 * Handles edge cases: out-of-bounds coordinates, tiny crops, padding.
 */
const sharp = require('sharp');
const config = require('../config');

/**
 * Pre-process an uploaded image: normalize orientation, resize if too large,
 * and return metadata needed for downstream work.
 * @param {Buffer} imageBuffer - Raw image buffer.
 * @returns {Promise<{buffer: Buffer, width: number, height: number}>}
 */
async function preprocessImage(imageBuffer) {
  let pipeline = sharp(imageBuffer).rotate(); // Auto-rotate based on EXIF

  const metadata = await sharp(imageBuffer).metadata();
  let { width, height } = metadata;

  // Resize if either dimension exceeds the max to save API tokens
  if (width > config.image.maxWidthPx || height > config.image.maxHeightPx) {
    pipeline = pipeline.resize({
      width: config.image.maxWidthPx,
      height: config.image.maxHeightPx,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const processedBuffer = await pipeline.toBuffer();
  const processedMeta = await sharp(processedBuffer).metadata();

  return {
    buffer: processedBuffer,
    width: processedMeta.width,
    height: processedMeta.height,
  };
}

/**
 * Crop a diagram from the source image using normalized bounding box coordinates.
 * @param {Buffer} imageBuffer - The source image buffer.
 * @param {number} imgWidth - Width of the source image in pixels.
 * @param {number} imgHeight - Height of the source image in pixels.
 * @param {number[]} bbox - Bounding box [ymin, xmin, ymax, xmax] in 0.0-1.0 range.
 * @returns {Promise<string|null>} - Base64 data URI of the cropped diagram, or null on failure.
 */
async function cropDiagram(imageBuffer, imgWidth, imgHeight, bbox) {
  if (!bbox || bbox.length !== 4) return null;

  let [ymin, xmin, ymax, xmax] = bbox;

  // Validate: all values must be numbers between 0 and 1
  if ([ymin, xmin, ymax, xmax].some(v => typeof v !== 'number' || isNaN(v))) {
    console.warn('[Cropper] Invalid bounding box values (non-numeric):', bbox);
    return null;
  }

  // Clamp to valid range
  ymin = Math.max(0, Math.min(1, ymin));
  xmin = Math.max(0, Math.min(1, xmin));
  ymax = Math.max(0, Math.min(1, ymax));
  xmax = Math.max(0, Math.min(1, xmax));

  // Ensure min < max
  if (ymin >= ymax || xmin >= xmax) {
    console.warn('[Cropper] Invalid bounding box (min >= max):', bbox);
    return null;
  }

  // Apply padding
  const pad = config.image.cropPaddingPercent;
  ymin = Math.max(0, ymin - pad);
  xmin = Math.max(0, xmin - pad);
  ymax = Math.min(1, ymax + pad);
  xmax = Math.min(1, xmax + pad);

  // Convert to pixel coordinates
  const left = Math.floor(xmin * imgWidth);
  const top = Math.floor(ymin * imgHeight);
  let cropWidth = Math.ceil((xmax - xmin) * imgWidth);
  let cropHeight = Math.ceil((ymax - ymin) * imgHeight);

  // Ensure we don't exceed image bounds
  cropWidth = Math.min(cropWidth, imgWidth - left);
  cropHeight = Math.min(cropHeight, imgHeight - top);

  // Minimum crop size check (skip if too tiny — probably a false positive)
  if (cropWidth < 20 || cropHeight < 20) {
    console.warn('[Cropper] Crop too small, likely false positive:', { left, top, cropWidth, cropHeight });
    return null;
  }

  try {
    const croppedBuffer = await sharp(imageBuffer)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .png({ quality: config.image.outputQuality })
      .toBuffer();

    return `data:image/png;base64,${croppedBuffer.toString('base64')}`;
  } catch (err) {
    console.error('[Cropper] Failed to crop diagram:', err.message);
    return null;
  }
}

module.exports = { preprocessImage, cropDiagram };
