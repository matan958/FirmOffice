import type { OcrMethod } from '../shared.js';

/**
 * The shape every OCR strategy returns, so the writer does not care which one ran.
 *
 * Keeping this separate from the stored OcrResult matters: the strategies produce
 * text, the writer decides where it lives (inline vs spilled to Storage) and derives
 * search tokens. Mixing those concerns is how the 1 MiB document limit gets forgotten.
 */

export interface OcrPage {
  pageNumber: number;
  text: string;
  confidence: number | null;
  width: number | null;
  height: number | null;
}

export interface OcrExtraction {
  engine: 'vision-v1' | 'pdf-parse';
  method: OcrMethod;
  pages: OcrPage[];
  fullText: string;
  /** Null when the engine does not report confidence — a text layer is not "unsure". */
  avgConfidence: number | null;
  languageCodes: string[];
}

export function joinPages(pages: OcrPage[]): string {
  return pages
    .map((p) => p.text)
    .join('\n\n')
    .trim();
}
