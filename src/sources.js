const SPOTIFY_URL = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:track|album|playlist|artist|episode|show)\//i;
const SPOTIFY_URI = /^spotify:(?:track|album|playlist|artist|episode|show):/i;
const YOUTUBE_URL =
  /(?:youtube\.com\/(?:watch\?[^#]*\bv=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/|music\.youtube\.com\/watch\?[^#]*\bv=)([A-Za-z0-9_-]{11})/i;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function isSpotify(input) {
  return SPOTIFY_URL.test(input) || SPOTIFY_URI.test(input.trim());
}

export function isYouTube(input) {
  return YOUTUBE_URL.test(input) || YOUTUBE_ID.test(input.trim());
}

export function detectSourceType(input) {
  const value = String(input ?? '').trim();
  if (isSpotify(value)) return 'spotify';
  return 'youtube';
}

/**
 * True when the input is a free-text search rather than a Spotify/YouTube
 * URL or a bare YouTube video id. Those are resolved through the engine's
 * `POST /youtube/search` candidate endpoint so the user can pick the match.
 */
export function isSearchQuery(input) {
  const value = String(input ?? '').trim();
  return Boolean(value) && !isSpotify(value) && !isYouTube(value);
}

/**
 * Turns free-form user input into the single source field the engine expects.
 * Spotify URLs/URIs go to `spotify_url`; everything else is treated as a
 * YouTube URL, bare video id, or free-text YouTube search query.
 */
export function buildLookupPayload(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('No track reference provided.');
  if (isSpotify(value)) return { spotify_url: value };
  return { youtube_url: value };
}
