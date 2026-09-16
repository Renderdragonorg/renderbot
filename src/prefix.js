import {
  V2,
  buildError,
  buildHelp,
  buildNotice,
  buildProgress,
  buildQuotaExceeded,
  buildResult,
  buildSearchEmpty,
  buildSearchResults,
  describeError,
} from './render.js';
import {
  downloadAttachment,
  performFile,
  performUrl,
  rememberSearch,
  rememberUrl,
  searchCandidates,
} from './handlers.js';
import { refundQuota, reserveQuota } from './quota.js';
import { isSearchQuery } from './sources.js';
import { actorFrom } from './audit.js';

async function firstAttachment(message) {
  const direct = message.attachments.first();
  if (direct) return direct;
  if (message.reference?.messageId) {
    try {
      const referenced = await message.fetchReference();
      return referenced.attachments.first() ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function reserve(message, db, config) {
  return reserveQuota(db, {
    userId: message.author.id,
    username: message.author.username,
    limit: config.quota.dailyLimit,
    bypassUserIds: config.quota.bypassUserIds,
  });
}

function makeProgress(progressMessage, base) {
  let last = null;
  return async (update) => {
    const stage = update?.message;
    if (!stage || stage === last) return;
    last = stage;
    try {
      await progressMessage.edit({
        flags: V2,
        components: [buildProgress({ ...base, stage })],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error('[progress]', describeError(error));
    }
  };
}

function recordCheck(audit, entity, { command, source, request, result, error, startedAt }) {
  audit?.record({
    actor: actorFrom(entity),
    command,
    source,
    request,
    result,
    error,
    durationMs: startedAt ? Date.now() - startedAt : null,
  });
}

export async function handlePrefixMessage(message, { engine, store, db, audit, config }) {
  if (message.author.bot || !message.content) return;
  if (!message.content.startsWith(config.prefix)) return;

  const body = message.content.slice(config.prefix.length).trim();
  if (!body) return;
  const [rawCommand, ...rest] = body.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const input = rest.join(' ').trim();

  if (command === 'help') {
    await message.reply({ flags: V2, components: [buildHelp(config.prefix)], allowedMentions: { parse: [] } });
    return;
  }

  if (command === 'check') {
    if (input) {
      await runUrlCheck(message, input, { engine, store, db, audit, config });
    } else {
      const attachment = await firstAttachment(message);
      if (attachment) await runFileCheck(message, attachment, { engine, db, audit, config });
      else await replyUsage(message, config, 'Provide a Spotify/YouTube URL or search query, or attach an audio file.');
    }
    return;
  }

  if (command === 'file') {
    const attachment = await firstAttachment(message);
    if (attachment) await runFileCheck(message, attachment, { engine, db, audit, config });
    else await replyUsage(message, config, 'Attach an audio file (or reply to one) to check it.');
  }
}

async function replyUsage(message, config, hint) {
  await message.reply({
    flags: V2,
    components: [
      buildNotice(
        'Music copyright checker',
        `${hint}\nTry \`${config.prefix}check <Spotify or YouTube URL>\` or \`${config.prefix}help\`.`,
      ),
    ],
    allowedMentions: { parse: [] },
  });
}

async function replyQuota(message, quota) {
  await message.reply({ flags: V2, components: [buildQuotaExceeded(quota)], allowedMentions: { parse: [] } });
}

async function runUrlCheck(message, input, { engine, store, db, audit, config }) {
  // Free-text queries get a search-then-pick step (engine v0.3.2+).
  if (isSearchQuery(input)) {
    let candidates = null;
    try {
      candidates = await searchCandidates(engine, input);
    } catch (error) {
      if (error?.status !== 404) {
        console.error('[prefix:search]', describeError(error));
        await message.reply({
          flags: V2,
          components: [buildError(error)],
          allowedMentions: { parse: [] },
        });
        return;
      }
      // Engine predates `/youtube/search`; fall through to the direct check.
    }
    if (candidates) {
      if (!candidates.length) {
        await message.reply({
          flags: V2,
          components: [buildSearchEmpty(input)],
          allowedMentions: { parse: [] },
        });
        return;
      }
      const contextId = rememberSearch(store, { query: input, candidates });
      await message.reply({
        flags: V2,
        components: [buildSearchResults({ query: input, candidates, contextId })],
        allowedMentions: { parse: [] },
      });
      return;
    }
  }

  const quota = reserve(message, db, config);
  if (!quota.allowed) {
    await replyQuota(message, quota);
    return;
  }
  const progress = await message.reply({
    flags: V2,
    components: [buildProgress({ note: `\`${input}\`` })],
    allowedMentions: { parse: [] },
  });
  let delivered = false;
  const startedAt = Date.now();
  const contextId = rememberUrl(store, input);
  const onProgress = makeProgress(progress, { note: `\`${input}\`` });
  try {
    const result = await performUrl(engine, input, { onProgress });
    await progress.edit({
      flags: V2,
      components: [buildResult(result, { sourceInput: input, refreshContextId: contextId, quota })],
      allowedMentions: { parse: [] },
    });
    delivered = true;
    recordCheck(audit, message, { command: 'check', source: 'url', request: input, result, startedAt });
  } catch (error) {
    console.error('[prefix:check]', describeError(error));
    if (!delivered) refundQuota(db, { userId: message.author.id, usageDate: quota.usageDate });
    recordCheck(audit, message, { command: 'check', source: 'url', request: input, error, startedAt });
    await progress.edit({ flags: V2, components: [buildError(error, { retryContextId: contextId })] });
  }
}

async function runFileCheck(message, attachment, { engine, db, audit, config }) {
  const quota = reserve(message, db, config);
  if (!quota.allowed) {
    await replyQuota(message, quota);
    return;
  }
  const progress = await message.reply({
    flags: V2,
    components: [buildProgress({ title: 'File copyright check', note: `\`${attachment.name}\`` })],
    allowedMentions: { parse: [] },
  });
  let delivered = false;
  const startedAt = Date.now();
  const onProgress = makeProgress(progress, { title: 'File copyright check', note: `\`${attachment.name}\`` });
  try {
    const file = await downloadAttachment(attachment);
    const result = await performFile(engine, file, { onProgress });
    await progress.edit({
      flags: V2,
      components: [buildResult(result, { sourceInput: attachment.name, quota })],
      allowedMentions: { parse: [] },
    });
    delivered = true;
    recordCheck(audit, message, { command: 'file', source: 'file', request: attachment.name, result, startedAt });
  } catch (error) {
    console.error('[prefix:file]', describeError(error));
    if (!delivered) refundQuota(db, { userId: message.author.id, usageDate: quota.usageDate });
    recordCheck(audit, message, { command: 'file', source: 'file', request: attachment.name, error, startedAt });
    await progress.edit({ flags: V2, components: [buildError(error)] });
  }
}
