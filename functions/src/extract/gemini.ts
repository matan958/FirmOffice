import { GoogleAuth } from 'google-auth-library';
import { logger } from 'firebase-functions';
import { buildPrompt, responseSchema } from './schema.js';
import { VERTEX_LOCATION, VERTEX_MODEL } from '../shared.js';

/**
 * Structured extraction via Gemini on Vertex AI.
 *
 * ── Why Vertex and not an external API ──
 * Cloud Vision already reads every one of these documents, so Google is already
 * inside the trust boundary. Calling Gemini through Vertex in the SAME project adds
 * no new company to the list of people who can see clients' financial records, which
 * for a CPA firm is a confidentiality question before it is a technical one. Any
 * other provider would be a new answer to "who processes your clients' data".
 *
 * It also means no API key to store or rotate: the function's own service account
 * authenticates, and it already holds the necessary role.
 */

/** How much OCR text to send. Beyond this the tail is almost always line items. */
const MAX_INPUT_CHARS = 12_000;

let auth: GoogleAuth | undefined;

function client(): GoogleAuth {
  auth ??= new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  return auth;
}

export interface GeminiResult {
  raw: Record<string, unknown>;
  model: string;
}

export async function extractWithGemini(ocrText: string): Promise<GeminiResult> {
  const projectId = process.env['GCLOUD_PROJECT'] ?? (await client().getProjectId());

  const url =
    `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}` +
    `/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_MODEL}:generateContent`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(ocrText.slice(0, MAX_INPUT_CHARS)) }] }],
    generationConfig: {
      // Extraction is transcription, not composition. Any creativity here is a
      // fabricated invoice number.
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: responseSchema(),
      maxOutputTokens: 1024,
      // Measured against the real endpoint: leaving thinking on spent 681 reasoning
      // tokens to reach an identical answer, more than doubling cost and latency.
      // Those tokens also count against maxOutputTokens, so a long deliberation can
      // truncate the JSON and fail the parse.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const res = await client().request<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    usageMetadata?: { totalTokenCount?: number };
  }>({ url, method: 'POST', data: body });

  const candidate = res.data.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;

  if (!text) {
    // MAX_TOKENS or SAFETY, both of which return a candidate with no text at all.
    throw new Error(
      `Gemini returned no content (finishReason: ${candidate?.finishReason ?? 'unknown'}).`,
    );
  }

  logger.debug('gemini extraction', {
    model: VERTEX_MODEL,
    tokens: res.data.usageMetadata?.totalTokenCount,
  });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Should be impossible with responseMimeType set, but a parse failure that
    // silently produced empty fields would look exactly like a document with nothing
    // on it, so it is worth naming.
    throw new Error(`Gemini returned unparseable JSON: ${text.slice(0, 200)}`);
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Gemini returned a non-object.');
  }

  return { raw: raw as Record<string, unknown>, model: VERTEX_MODEL };
}
