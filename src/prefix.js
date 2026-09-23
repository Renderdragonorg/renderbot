import { PermissionFlagsBits } from 'discord.js';
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
  runQueuedCheck,
  searchCandidates,
} from './handlers.js';
import { refundIfCached, refundQuota, reserveQuota } from './quota.js';
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

/**
 * The bot runs without the privileged members intent, so `message.member` is
 * often null. Fetch the member over REST when a permission decision is needed.
 */
async function resolveMember(message) {
  if (message.member) return message.member;
  if (!message.guild) return null;
  try {
    return await message.guild.members.fetch(message.author.id);
  } catch {
    return null;
  }
}

async function replyWrongChannel(message, channelId) {
  await message.reply({
    flags: V2,
    components: [buildNotice('Wrong channel', `Use <#${channelId}> for bot commands.`)],
    allowedMentions: { parse: [] },
  });
}

/** `!channel set|clear|show` — Manage Server only, works in any channel. */
async function handleChannelCommand(message, input, { db, config }) {
  if (!message.guild) {
    await message.reply({
      flags: V2,
      components: [buildNotice('Channel', 'This command only works in a server.')],
      allowedMentions: { parse: [] },
    });
    return;
  }
  const member = await resolveMember(message);
  if (!member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply({
      flags: V2,
      components: [buildNotice('Not authorised', 'Managing the command channel requires the **Manage Server** permission.')],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const [rawSub, ...args] = input.split(/\s+/).filter(Boolean);
  const action = (rawSub ?? 'show').toLowerCase();
  const current = db.getCommandChannel(message.guild.id);

  if (action === 'show' || action === 'list') {
    await message.reply({
      flags: V2,
      components: [
        buildNotice(
          'Command channel',
          current
            ? `Commands are only accepted in <#${current}>.`
            : 'Commands are accepted in any channel.',
        ),
      ],
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === 'set') {
    // `!channel set` with no target uses the channel it was sent in.
    const channelId =
      message.mentions.channels.first()?.id ??
      args.find((token) => /^\d{17,20}$/.test(token)) ??
      message.channelId;
    db.setCommandChannel(message.guild.id, channelId);
    await message.reply({
      flags: V2,
      components: [buildNotice('Command channel', `Commands are now only accepted in <#${channelId}>.`)],
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === 'clear' || action === 'reset' || action === 'off') {
    const cleared = db.clearCommandChannel(message.guild.id);
    await message.reply({
      flags: V2,
      components: [
        buildNotice(
          'Command channel',
          cleared ? 'Cleared — commands are accepted in any channel again.' : 'No command channel was set.',
        ),
      ],
      allowedMentions: { parse: [] },
    });
    return;
  }

  await replyChannelUsage(message, config);
}

async function replyChannelUsage(message, config) {
  await message.reply({
    flags: V2,
    components: [
      buildNotice(
        'Command channel',
        `Usage: \`${config.prefix}channel set #channel\`, \`${config.prefix}channel clear\`, or \`${config.prefix}channel show\`.`,
      ),
    ],
    allowedMentions: { parse: [] },
  });
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

export async function handlePrefixMessage(message, { engine, store, db, audit, config, queue }) {
  if (message.author.bot || !message.content) return;
  if (!message.content.startsWith(config.prefix)) return;

  const body = message.content.slice(config.prefix.length).trim();
  if (!body) return;
  const [rawCommand, ...rest] = body.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const input = rest.join(' ').trim();

  if (command === 'help') {
    await message.reply({ flags: V2, components: [buildHelp()], allowedMentions: { parse: [] } });
    return;
  }

  if (command === 'channel') {
    await handleChannelCommand(message, input, { db, config });
    return;
  }

  const commandChannel = db.getCommandChannel(message.guildId);
  if (commandChannel && message.channelId !== commandChannel) {
    await replyWrongChannel(message, commandChannel);
    return;
  }

  if (command === 'check') {
    if (input) {
      await runUrlCheck(message, input, { engine, store, db, audit, config, queue });
    } else {
      const attachment = await firstAttachment(message);
      if (attachment) await runFileCheck(message, attachment, { engine, db, audit, config, queue });
      else await replyUsage(message, config, 'Provide a Spotify/YouTube URL or search query, or attach an audio file.');
    }
    return;
  }

  if (command === 'file') {
    const attachment = await firstAttachment(message);
    if (attachment) await runFileCheck(message, attachment, { engine, db, audit, config, queue });
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

async function runUrlCheck(message, input, { engine, store, db, audit, config, queue }) {
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
    const result = await runQueuedCheck({
      queue,
      edit: (payload) => progress.edit(payload),
      queueBase: { note: `\`${input}\`` },
      progressBase: { note: `\`${input}\`` },
      task: () => performUrl(engine, input, { onProgress }),
    });
    const finalQuota = refundIfCached(db, { userId: message.author.id, quota, result });
    await progress.edit({
      flags: V2,
      components: [buildResult(result, { sourceInput: input, refreshContextId: contextId, quota: finalQuota })],
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

async function runFileCheck(message, attachment, { engine, db, audit, config, queue }) {
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
    const result = await runQueuedCheck({
      queue,
      edit: (payload) => progress.edit(payload),
      queueBase: { title: 'File copyright check', note: `\`${attachment.name}\`` },
      progressBase: { title: 'File copyright check', note: `\`${attachment.name}\`` },
      task: async () => {
        const file = await downloadAttachment(attachment);
        return performFile(engine, file, { onProgress });
      },
    });
    const finalQuota = refundIfCached(db, { userId: message.author.id, quota, result });
    await progress.edit({
      flags: V2,
      components: [buildResult(result, { sourceInput: attachment.name, quota: finalQuota })],
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
