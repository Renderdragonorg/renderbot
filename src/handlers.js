import { EngineError } from './engine.js';
import { buildLookupPayload } from './sources.js';

export const SUPPORTED_EXTENSIONS = [
  '.mp3', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.wav', '.wma',
];

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function extensionOf(name) {
  const match = /(\.[a-z0-9]+)$/i.exec(String(name ?? ''));
  return match ? match[1].toLowerCase() : '';
}

export async function downloadAttachment(attachment) {
  if (attachment.size && attachment.size > MAX_UPLOAD_BYTES) {
    throw new EngineError('That file is larger than the engine\'s 100 MB upload limit.');
  }
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new EngineError(`Could not download the attachment (HTTP ${response.status}).`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  const filename = attachment.name || 'audio';
  const extension = extensionOf(filename);
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new EngineError(
      `Unsupported audio type "${extension || 'unknown'}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
    );
  }
  return { data, filename, contentType: attachment.contentType || undefined };
}

const SPOTIFY_OEMBED_URL = 'https://open.spotify.com/oembed';
const ARTWORK_TIMEOUT_MS = 5_000;

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/**
 * Fills in Spotify cover art via the public oEmbed endpoint. The engine only
 * populates `track.thumbnail_url` for YouTube sources, so Spotify results would
 * otherwise render without artwork. Best-effort: a failure just means no image.
 */
async function resolveSpotifyArtwork(track) {
  if (!track || isHttpUrl(track.thumbnail_url) || !isHttpUrl(track.spotify_url)) return track;
  try {
    const url = `${SPOTIFY_OEMBED_URL}?url=${encodeURIComponent(track.spotify_url)}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(ARTWORK_TIMEOUT_MS),
    });
    if (!response.ok) return track;
    const body = await response.json().catch(() => null);
    if (isHttpUrl(body?.thumbnail_url)) track.thumbnail_url = body.thumbnail_url;
  } catch (error) {
    console.error('[artwork]', error?.message ?? error);
  }
  return track;
}

export async function performUrl(engine, input, { refresh = false, onProgress } = {}) {
  const result = await engine.check(buildLookupPayload(input), { refresh, onProgress });
  await resolveSpotifyArtwork(result?.request?.track);
  return result;
}

export function performFile(engine, file, { refresh = false, onProgress } = {}) {
  return engine.checkFile(file, { refresh, onProgress });
}

/** Fetch pickable YouTube search candidates for a free-text query. */
export function searchCandidates(engine, query, { limit = 5 } = {}) {
  return engine.searchYouTube(query, { limit });
}

export function rememberUrl(store, input) {
  return store.put({ kind: 'url', input, payload: buildLookupPayload(input) });
}

/** Remember a search so a pick button can run the chosen candidate. */
export function rememberSearch(store, { query, candidates }) {
  return store.put({ kind: 'search', query, candidates });
}
