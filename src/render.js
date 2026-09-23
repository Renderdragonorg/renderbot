import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import { formatResetIn } from './quota.js';

export const V2 = MessageFlags.IsComponentsV2;

const COLOR = {
  stop: 0xed4245,
  caution: 0xe67e22,
  warn: 0xfee75c,
  ok: 0x57f287,
  good: 0x3ba55d,
  info: 0x5865f2,
  neutral: 0x95a5a6,
};

// Ordered by severity: a higher rank is more restrictive, so the accent and
// badge show the worst of the three usage verdicts. `unknown` is the lowest so
// a known verdict (including the positive ones) always wins over an unclear
// dimension; `unknown` only shows when every dimension is unknown.
const VERDICTS = {
  likely_not_permitted_without_permission: {
    label: 'Likely not permitted without permission',
    emoji: '\u{1F534}',
    rank: 5,
    color: COLOR.stop,
  },
  clearance_required: {
    label: 'Clearance required',
    emoji: '\u{1F7E0}',
    rank: 4,
    color: COLOR.caution,
  },
  potentially_usable_with_platform_license: {
    label: 'Potentially usable with a platform license',
    emoji: '\u{1F7E1}',
    rank: 3,
    color: COLOR.warn,
  },
  permitted_with_conditions: {
    label: 'Permitted with conditions',
    emoji: '\u2705',
    rank: 2,
    color: COLOR.good,
  },
  free_to_use: { label: 'Free to use', emoji: '\u{1F7E2}', rank: 1, color: COLOR.ok },
  unknown: { label: 'Unknown', emoji: '\u26AA', rank: 0, color: COLOR.neutral },
};

const TOTAL_TEXT_BUDGET = 3_900;

class Budget {
  constructor(total = TOTAL_TEXT_BUDGET) {
    this.remaining = total;
  }

  fit(value, max = Infinity) {
    const limit = Math.max(0, Math.min(max, this.remaining));
    const text = truncate(value, limit);
    this.remaining -= text.length;
    return text;
  }
}

function truncate(value, max) {
  const text = String(value ?? '');
  if (limitIsInfinite(max) || text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1).replace(/\s+$/, '')}\u2026`;
}

function limitIsInfinite(max) {
  return max === Infinity || max === Number.MAX_SAFE_INTEGER;
}

function mdEscape(value) {
  return String(value ?? '').replace(/([*_`~|\\])/g, '\\$1');
}

function titleCase(value) {
  return String(value ?? 'unknown')
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatDuration(ms) {
  const total = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(total) || total <= 0) return null;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function verdictOf(value) {
  return VERDICTS[value] ?? VERDICTS.unknown;
}

function highestVerdict(usage, status) {
  if (status === 'not_found') return VERDICTS.unknown;
  const ranks = [usage?.video_verdict, usage?.social_media_verdict, usage?.reality_tv_verdict].map(
    (verdict) => verdictOf(verdict).rank,
  );
  const highest = Math.max(...ranks);
  return Object.values(VERDICTS).find((entry) => entry.rank === highest) ?? VERDICTS.unknown;
}

function accentFor(usage, status) {
  return highestVerdict(usage, status).color ?? COLOR.info;
}

function separator(container) {
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
}

function text(container, budget, value, max) {
  const content = budget.fit(value, max);
  if (!content.trim()) return;
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

/**
 * Adds whole lines only. A line that does not fully fit is dropped rather than
 * truncated, so markdown links and URLs are never cut in half.
 */
function addLines(container, budget, lines) {
  const kept = [];
  for (const line of lines) {
    const cost = line.length + (kept.length ? 1 : 0);
    if (cost > budget.remaining) break;
    budget.remaining -= cost;
    kept.push(line);
  }
  if (kept.length) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(kept.join('\n')));
  }
}

export function buildProgress({ title = 'Copyright check', note, stage } = {}) {
  const lines = [`## ${title}`, 'Researching rights and licensing. This can take a few minutes.'];
  if (note) lines.push(truncate(note, 300));
  if (stage) lines.push(`-# ${truncate(stage, 200)}`);
  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
}

export function buildQueueStatus({ position, total, note } = {}) {
  const lines = [
    '## In queue',
    `You are **#${position ?? '?'} of ${total ?? '?'}** in the queue.`,
    '-# Your check starts automatically when a slot frees up.',
  ];
  if (note) lines.push(note);
  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
}

export function buildError(error, { retryContextId } = {}) {
  const message = typeof error === 'string' ? error : error?.message ?? 'Unknown error';
  const detail = typeof error === 'object' ? error?.detail : null;
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Check failed\n${truncate(message, 1_500)}`));
  if (detail) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`\`\`\`\n${truncate(String(detail), 800)}\n\`\`\``),
    );
  }
  if (retryContextId) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`looney:refresh:${retryContextId}`)
          .setLabel('Retry')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return container;
}

export function buildHelp() {
  return new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          '## Music copyright checker',
          'Runs a track through the looney-checks licensing engine and reports who owns it and what clearance it needs.',
          '',
          '**Slash commands**',
          '`/check query:<Spotify or YouTube URL, video id, or search>`',
          '`/file audio:<attachment>`',
          '',
          'Results are research assistance, not legal advice.',
        ].join('\n'),
      ),
    );
}

export function buildSearchResults({ query, candidates, contextId }) {
  const container = new ContainerBuilder();
  const count = candidates.length;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## Pick a video\n${count} match${count === 1 ? '' : 'es'} for \`${truncate(mdEscape(query), 120)}\`. Choose one to check.`,
    ),
  );

  candidates.forEach((candidate, index) => {
    const label = [`**${index + 1}.** ${mdEscape(candidate.title ?? candidate.video_id)}`];
    if (candidate.channel) label.push(mdEscape(candidate.channel));
    const content = label.join('\n');
    const thumb =
      typeof candidate.thumbnail_url === 'string' && /^https?:\/\//i.test(candidate.thumbnail_url)
        ? candidate.thumbnail_url
        : null;
    if (thumb) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(content))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb).setDescription('Video thumbnail')),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
    }
  });

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      ...candidates.map((candidate, index) =>
        new ButtonBuilder()
          .setCustomId(`looney:pick:${contextId}:${index}`)
          .setLabel(String(index + 1))
          .setStyle(ButtonStyle.Secondary),
      ),
    ),
  );
  return container;
}

export function buildSearchEmpty(query) {
  return new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## No videos found\nNothing matched \`${truncate(mdEscape(query), 120)}\`. Try a different search.`,
      ),
    );
}

export function buildResult(result, { sourceInput, refreshContextId, quota } = {}) {
  const request = result?.request ?? {};
  const track = request.track ?? {};
  const research = result?.research ?? {};
  const ai = result?.ai_meta ?? {};
  const usage = research.usage_assessment ?? {};
  const budget = new Budget(3_500);
  const footerBudget = new Budget(400);

  const container = new ContainerBuilder().setAccentColor(accentFor(usage, research.status));

  const sourceLabel = titleCase(request.source ?? 'unknown');
  const verdict = highestVerdict(usage, research.status);
  text(
    container,
    budget,
    `${verdict.emoji} **${verdict.label}**\n## Copyright check\nSource: \`${sourceLabel}\`${sourceInput ? ` \u00b7 ${truncate(sourceInput, 120)}` : ''}`,
    320,
  );

  const trackLines = [];
  if (track.name) trackLines.push(`**${mdEscape(track.name)}**`);
  if (Array.isArray(track.artists) && track.artists.length) {
    trackLines.push(track.artists.map(mdEscape).join(', '));
  }
  const meta = [];
  if (track.album) meta.push(mdEscape(track.album));
  if (track.label) meta.push(mdEscape(track.label));
  if (track.isrc) meta.push(`ISRC ${track.isrc}`);
  if (track.youtube_id) meta.push(`YouTube ${track.youtube_id}`);
  if (meta.length) trackLines.push(meta.join(' \u00b7 '));
  if (track.duration_ms) trackLines.push(`Duration ${formatDuration(track.duration_ms)}`);

  const trackContent = budget.fit(trackLines.join('\n') || 'No track metadata returned.', 340);
  const artwork =
    typeof track.thumbnail_url === 'string' && /^https?:\/\//i.test(track.thumbnail_url)
      ? track.thumbnail_url
      : null;
  if (artwork) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(trackContent))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(artwork).setDescription('Track artwork')),
    );
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(trackContent));
  }

  separator(container);
  const summary = research.summary ? truncate(research.summary, 1_000) : 'No summary returned.';
  text(
    container,
    budget,
    `**Summary** (${titleCase(research.status)})\n${summary}`,
    1_250,
  );

  separator(container);
  const usageLines = [
    '**Usage assessment**',
    `Online video: ${verdictOf(usage.video_verdict).label}`,
    `Social media: ${verdictOf(usage.social_media_verdict).label}`,
    `Reality TV: ${verdictOf(usage.reality_tv_verdict).label}`,
  ];
  if (usage.creator_declared_license) {
    usageLines.push(`Creator-declared: ${truncate(mdEscape(usage.creator_declared_license), 240)}`);
  }
  const licenseFlags = [];
  if (typeof usage.sync_license_required === 'boolean') {
    licenseFlags.push(`Sync license ${usage.sync_license_required ? 'required' : 'not required'}`);
  }
  if (typeof usage.master_license_required === 'boolean') {
    licenseFlags.push(`Master license ${usage.master_license_required ? 'required' : 'not required'}`);
  }
  if (licenseFlags.length) usageLines.push(licenseFlags.join(' \u00b7 '));
  if (usage.platform_exception) usageLines.push(`> ${truncate(usage.platform_exception, 260)}`);
  text(container, budget, usageLines.join('\n'), 700);

  const matches = Array.isArray(research.matches) ? research.matches : [];
  if (matches.length) {
    separator(container);
    const lines = [`**Matches (${matches.length})**`];
    for (const [index, match] of matches.slice(0, 6).entries()) {
      lines.push(`**${index + 1}. ${titleCase(match.confidence)}** \u00b7 ${mdEscape(match.rights_holder ?? 'unknown rights holder')}`);
      const details = [match.publisher, match.label, match.license_type].filter(Boolean).map(mdEscape);
      if (details.length) lines.push(details.join(' \u00b7 '));
      const link = match.source_url
        ? `[${mdEscape(match.source_name ?? 'source')}](<${match.source_url}>)`
        : mdEscape(match.source_name ?? 'source');
      lines.push(truncate(`${link}${match.notes ? ` \u2014 ${mdEscape(match.notes)}` : ''}`, 220));
    }
    if (matches.length > 6) lines.push(`-# +${matches.length - 6} more`);
    addLines(container, budget, lines);
  }

  const sources = Array.isArray(research.sources) ? research.sources : [];
  if (sources.length) {
    separator(container);
    const lines = ['**Sources**'];
    for (const source of sources.slice(0, 6)) {
      const name = truncate(mdEscape(source.name ?? 'source'), 90);
      const link = source.url ? `[${name}](<${source.url}>)` : name;
      lines.push(`- ${link}${source.supports ? ` \u2014 ${truncate(source.supports, 100)}` : ''}`);
    }
    addLines(container, budget, lines);
  }

  const warnings = [...(research.warnings ?? []), ...(usage.caveats ?? [])].filter(Boolean);
  if (warnings.length) {
    separator(container);
    const lines = ['**Warnings**'];
    for (const warning of warnings.slice(0, 5)) lines.push(`- ${truncate(warning, 200)}`);
    if (warnings.length > 5) lines.push(`-# +${warnings.length - 5} more`);
    addLines(container, budget, lines);
  }

  const contacts = Array.isArray(research.official_licensing_contacts)
    ? research.official_licensing_contacts.filter(Boolean)
    : [];
  separator(container);
  const footer = [];
  if (contacts.length) {
    footer.push(`Licensing contacts: ${contacts.slice(0, 3).map((url) => `<${url}>`).join(' ')}`);
  }
  footer.push('-# Research assistance, not legal advice.');
  if (ai.cache_hit) footer.push('-# Cached research result.');
  if (quota && !quota.bypass) {
    footer.push(`-# Checks left today: ${quota.remaining} of ${quota.limit}`);
  }
  addLines(container, footerBudget, footer);

  if (refreshContextId) {
    container.addActionRowComponents(refreshRow(refreshContextId));
  }

  return container;
}

function refreshRow(contextId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`looney:refresh:${contextId}`)
      .setLabel('Refresh research')
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildNotice(title, body) {
  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${title}**\n${body}`));
}

export function buildQuotaExceeded({ used, limit, resetAt }) {
  const resetIn = resetAt ? formatResetIn(resetAt.getTime() - Date.now()) : '00:00 UTC';
  return new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          '## Daily limit reached',
          `You have used **${used} of ${limit}** copyright checks today.`,
          `Your limit resets in **${resetIn}** (00:00 UTC).`,
        ].join('\n'),
      ),
    );
}

/**
 * Expands shapeshift / discord.js validation errors (which only expose
 * "Received one or more errors" at the top level) into a readable detail list.
 */
export function describeError(error) {
  if (!error) return String(error);
  const lines = [`${error.name ?? 'Error'}: ${error.message ?? String(error)}`];
  try {
    let entries = [];
    const raw = error.errors;
    if (Array.isArray(raw)) entries = raw;
    else if (raw instanceof Map) entries = [...raw.entries()];
    else if (raw && typeof raw === 'object') entries = Object.entries(raw);
    for (const entry of entries) {
      const [key, value] = Array.isArray(entry) ? entry : [entry, ''];
      lines.push(`  - ${String(key)}: ${value?.message ?? String(value)}`);
    }
  } catch (inner) {
    lines.push(`  (could not expand errors: ${inner?.message ?? inner})`);
  }
  if (error.rawError) {
    try {
      lines.push(`  raw: ${JSON.stringify(error.rawError)}`);
    } catch {
      /* ignore */
    }
  }
  return lines.join('\n');
}
