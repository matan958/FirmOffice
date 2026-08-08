import { pdfjs } from 'react-pdf';

/**
 * Self-hosted pdf.js worker.
 *
 * react-pdf defaults to fetching the worker from a CDN, which would mean client
 * financial documents are parsed by a script loaded from a third party — and would
 * break entirely behind a firewall or a strict CSP. `new URL(..., import.meta.url)`
 * makes Vite bundle the worker as a local asset and rewrite this to the hashed path.
 *
 * The version MUST match the pdfjs-dist that react-pdf depends on; a mismatch fails
 * at render time with an opaque worker error, so it is resolved from the installed
 * package rather than pinned by hand.
 */
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export { pdfjs };
