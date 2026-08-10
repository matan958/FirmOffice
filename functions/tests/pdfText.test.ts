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

/**
 * Uncompressed greyscale PNG of the given size. Real pixels, because the detector
 * reads the image's declared dimensions out of the PDF's operator list — a stubbed
 * one would not appear there at all.
 */
function png(width: number, height: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale

  // One filter byte + one sample per pixel per row, stored uncompressed via zlib.
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  const deflated = require('node:zlib').deflateSync(raw);

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflated),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

async function makePdfWithImage(text: string, w: number, h: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);
  page.drawText(text, { x: 40, y: 750, size: 11, font });
  const image = await pdf.embedPng(png(w, h));
  page.drawImage(image, { x: 40, y: 100, width: 400, height: 500 });
  return pdf.save();
}

/**
 * The bug a real receipt exposed.
 *
 * Israeli digital-receipt providers wrap a photographed receipt in a PDF carrying its
 * own small text layer — a legal notice, a page number, a support URL. That layer is
 * genuine text and cleared the 100-chars-per-page threshold at 148 characters, so the
 * pipeline declared the document digital-native, skipped Vision, and stored the
 * boilerplate as the entire content of the receipt. Nothing errored. The accountant
 * simply saw a receipt with no numbers on it.
 */
describe('extractPdfTextLayer — a scan wrapped in a text layer', () => {
  /**
   * The real wrapper was 148 characters of Hebrew: a legal notice under סעיף 18ב, a
   * page number, and the provider's support address.
   *
   * The fixture below is Latin of the same length, because pdf-lib's standard fonts
   * are WinAnsi-only and cannot encode Hebrew without an embedded font file. That
   * substitution is safe here and nowhere else: the detector never looks at the text,
   * only at its length against the size of the images on the page.
   */
  const WRAPPER_TEXT = 'Computerised document. '.repeat(6) + 'Page 1 of 1 www.example.com';

  it('sends a page-sized image to Vision even though its text layer passes the threshold', async () => {
    expect(WRAPPER_TEXT.length).toBeGreaterThan(100); // it really does clear the floor

    const probe = await extractPdfTextLayer(await makePdfWithImage(WRAPPER_TEXT, 945, 945));

    expect(probe.extraction).toBeNull();
    expect(probe.reason).toBe('scanned');
    expect(probe.pageCount).toBe(1);
  });

  it('does NOT send a digital invoice with a logo to Vision', async () => {
    // The other direction, and the reason the threshold is two orders of magnitude
    // above a logo rather than just above it. A real digital invoice measured 13,446
    // pixels for its largest image; a scan measured 893,580.
    const probe = await extractPdfTextLayer(await makePdfWithImage(DENSE('LOGO-CASE'), 130, 100));

    expect(probe.extraction).not.toBeNull();
    expect(probe.extraction?.fullText).toContain('LOGO-CASE');
  });

  it('reports why it fell through, so logs distinguish a scan from a blank page', async () => {
    const blank = await extractPdfTextLayer(await makePdf(['x']));
    expect(blank.reason).toBe('too-little-text');
  });
});
