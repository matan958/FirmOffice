import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { ref, uploadBytesResumable } from 'firebase/storage';
import { db, storage } from '@/lib/firebase';
import {
  COLLECTIONS,
  MAX_FILE_BYTES,
  NEEDS_CONVERSION_MIME,
  OCR_SUPPORTED_MIME,
  STORE_ONLY_MIME,
  incomingPath,
  safeObjectName,
} from '@shared';

/**
 * Client Portal upload.
 *
 * Order matters: the Firestore record is written BEFORE the bytes start moving. That
 * gives the client an immediate row with real progress instead of a spinner over
 * nothing, and it means a browser that dies mid-upload leaves a visible document stuck
 * in `uploading` rather than an orphaned object nobody knows about. The M6 janitor
 * sweeps those; a silent orphan would have nothing to sweep.
 *
 * The docId is minted client-side so the Firestore path and the Storage path agree
 * without a server round-trip.
 */

export const ACCEPTED_MIME: readonly string[] = [
  ...OCR_SUPPORTED_MIME,
  ...STORE_ONLY_MIME,
  ...NEEDS_CONVERSION_MIME,
];

export type UploadState =
  | { status: 'pending' }
  | { status: 'uploading'; progress: number }
  | { status: 'done' }
  | { status: 'error'; message: string };

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  state: UploadState;
}

export function rejectReason(file: File): string | null {
  if (file.size === 0) return 'File is empty.';
  if (file.size > MAX_FILE_BYTES) {
    return `Too large — the limit is ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB.`;
  }
  // A cheap first filter only. The browser's type comes from the file extension and is
  // trivially wrong or forged, so the server re-sniffs the magic bytes regardless.
  if (file.type && !ACCEPTED_MIME.includes(file.type)) {
    return `${file.type} is not an accepted file type.`;
  }
  return null;
}

export interface UploadContext {
  clientId: string;
  clientName: string | null;
  uid: string;
}

/**
 * Creates the document record, then streams the bytes up. `onProgress` reports 0–1.
 * Resolves when the upload completes; rejects with a human-readable message.
 */
export async function uploadFile(
  file: File,
  ctx: UploadContext,
  onProgress: (fraction: number) => void,
): Promise<string> {
  const docId = doc(collection(db, COLLECTIONS.documents)).id;
  const objectName = safeObjectName(file.name);
  const storagePath = incomingPath(ctx.clientId, docId, objectName);
  const contentType = file.type || 'application/octet-stream';

  // Exactly the fields the security rules allowlist on create — anything else is
  // server-owned and the write would be rejected wholesale.
  await setDoc(doc(db, COLLECTIONS.documents, docId), {
    clientId: ctx.clientId,
    clientNameCache: ctx.clientName,
    channel: 'web',
    source: { userAgent: navigator.userAgent },
    file: {
      originalName: file.name,
      storagePath,
      contentType,
      sizeBytes: file.size,
      sha256: '',
    },
    pipelineStatus: 'uploading',
    workflowStatus: 'pending',
    uploadedByUid: ctx.uid,
    receivedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    deletedAt: null,
  });

  await new Promise<void>((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, storagePath), file, { contentType });
    task.on(
      'state_changed',
      (snap) => {
        onProgress(snap.totalBytes ? snap.bytesTransferred / snap.totalBytes : 0);
      },
      (err) => reject(err),
      () => resolve(),
    );
  });

  return docId;
}
