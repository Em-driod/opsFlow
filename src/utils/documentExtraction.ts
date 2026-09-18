import path from 'path';
import { fileURLToPath } from 'url';
import Tesseract from 'tesseract.js';
import { PDFParse } from 'pdf-parse';
import { AppError } from './AppError.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// eng.traineddata ships uncompressed at the project root (two levels up
// from src/utils/) — Tesseract needs langPath pointed at its directory.
const TRAINED_DATA_DIR = path.resolve(__dirname, '../../');

const extractFromPdf = async (buffer: Buffer): Promise<string> => {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = (result.text || '').trim();
    if (!text) {
      throw new AppError(
        'This PDF has no selectable text — it looks like a scanned or photographed document rather than one generated from software. Please upload it as an image (JPG/PNG) instead.',
        422,
      );
    }
    return text;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Could not read this PDF — it may be corrupted or password-protected.', 422);
  } finally {
    await parser.destroy();
  }
};

const extractFromImage = async (buffer: Buffer): Promise<string> => {
  try {
    const { data } = await Tesseract.recognize(buffer, 'eng', {
      langPath: TRAINED_DATA_DIR,
      gzip: false,
    });
    const text = (data.text || '').trim();
    if (!text) {
      throw new AppError('Could not read any text from this image. Please try a clearer, well-lit photo.', 422);
    }
    return text;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Could not read this image. Please try a clearer photo.', 422);
  }
};

/**
 * Extracts raw text from an uploaded receipt/invoice — OCR for images, the
 * embedded text layer for PDFs. No AI: a hardcoded pipeline so scanning
 * doesn't silently break whenever a hosted model gets deprecated out from
 * under it (as gemini-2.0-flash did). Scanned/photographed PDFs (no text
 * layer) are explicitly rejected rather than silently returning nothing.
 */
export const extractDocumentText = async (buffer: Buffer, mimetype: string): Promise<string> => {
  if (mimetype === 'application/pdf') return extractFromPdf(buffer);
  if (mimetype.startsWith('image/')) return extractFromImage(buffer);
  throw new AppError('Unsupported file type. Please upload an image (JPG/PNG) or a PDF.', 400);
};
