import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPdfTextLayer } from '../src/ocr/pdfText.js';

/**
 * The digital-native PDF path is the one that saves real money: most invoices a firm
 * receives are printed from software and already carry their text, so reading it is
 * instant and free against roughly $1.50 per 1000 pages for Vision.
 *
 * The consequential decision is the fallback threshold. Too eager and a scan with a
 * stray watermark is treated as "already extracted", leaving the real content
 * unsearchable with nobody the wiser. Too shy and the firm pays Vision for text it
 * already had. Both directions are pinned here.
 */

async function makePdf(pagesText: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pagesText) {
    const page = pdf.addPage([600, 800]);
    // Wrap crudely so long fixtures stay on the page.
    const lines = text.match(/.{1,80}/g) ?? [''];
    lines.forEach((line, i) => {
      page.drawText(line, { x: 40, y: 750 - i * 14, size: 11, font });
    });
  }
  return pdf.save();
}

/** Padding that comfortably clears the 100-chars-per-page threshold. */
const DENSE = (marker: string) =>
  `${marker} ${'Invoice line item description and amount. '.repeat(6)}`;

describe('extractPdfTextLayer — digital-native PDFs', () => {
  it('extracts text without calling Vision', async () => {
    const bytes = await makePdf([DENSE('ACME-2026-001')]);
    const probe = await extractPdfTextLayer(bytes);

    expect(probe.pageCount).toBe(1);
    expect(probe.extraction).not.toBeNull();
    expect(probe.extraction?.method).toBe('pdfTextLayer');
    expect(probe.extraction?.engine).toBe('pdf-parse');
    expect(probe.extraction?.fullText).toContain('ACME-2026-001');
  });

  it('reports one page entry per page, numbered from 1', async () => {
    const bytes = await makePdf([DENSE('PAGEONE'), DENSE('PAGETWO'), DENSE('PAGETHREE')]);
    const probe = await extractPdfTextLayer(bytes);

    expect(probe.pageCount).toBe(3);
    expect(probe.extraction?.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(probe.extraction?.pages[0]?.text).toContain('PAGEONE');
    expect(probe.extraction?.pages[2]?.text).toContain('PAGETHREE');
  });

  it('reports no confidence — a text layer is extracted, not recognised', async () => {
    // Inventing 1.0 here would make a native PDF indistinguishable from a perfect scan.
    const probe = await extractPdfTextLayer(await makePdf([DENSE('X')]));
    expect(probe.extraction?.avgConfidence).toBeNull();
    expect(probe.extraction?.pages[0]?.confidence).toBeNull();
  });
});

describe('extractPdfTextLayer — input types', () => {
  it('accepts a Node Buffer, which is what Storage downloads actually return', async () => {
    // Regression: pdfjs rejects a Buffer outright despite Buffer extending Uint8Array.
    // Every test fixture here is a plain Uint8Array from pdf-lib, so the suite passed
    // while production — where bucket().download() yields a Buffer — failed on every
    // single PDF. Tests must exercise the type the caller really supplies.
    const bytes = await makePdf([DENSE('BUFFERCASE')]);
    const probe = await extractPdfTextLayer(Buffer.from(bytes));

    expect(probe.pageCount).toBe(1);
    expect(probe.extraction?.fullText).toContain('BUFFERCASE');
  });

  it('still accepts a plain Uint8Array', async () => {
    const probe = await extractPdfTextLayer(await makePdf([DENSE('ARRAYCASE')]));
    expect(probe.extraction?.fullText).toContain('ARRAYCASE');
  });
});

describe('extractPdfTextLayer — falling through to OCR', () => {
  it('returns no extraction for a page with no text at all', async () => {
    // A scan: pdfjs finds nothing, so this must go to Vision.
    const pdf = await PDFDocument.create();
    pdf.addPage([600, 800]);
    const probe = await extractPdfTextLayer(await pdf.save());

    expect(probe.pageCount).toBe(1);
    expect(probe.extraction).toBeNull();
  });

  it('returns no extraction for a stray watermark on an otherwise image-only page', async () => {
    // The case the threshold exists for. Treating this as success would leave the
    // actual document unsearchable and silently unprocessed.
    const probe = await extractPdfTextLayer(await makePdf(['Scanned by CamScanner']));
    expect(probe.extraction).toBeNull();
  });

  it('still reports the page count when it falls through', async () => {
    // The caller needs this to choose the sync vs async Vision path.
    const pdf = await PDFDocument.create();
    pdf.addPage([600, 800]);
    pdf.addPage([600, 800]);
    const probe = await extractPdfTextLayer(await pdf.save());

    expect(probe.pageCount).toBe(2);
    expect(probe.extraction).toBeNull();
  });

  it('judges by average across pages, not by any single one', async () => {
    // One dense page plus one near-empty page still averages above the threshold.
    const probe = await extractPdfTextLayer(await makePdf([DENSE('DENSE'), 'x']));
    expect(probe.extraction).not.toBeNull();
  });
});
