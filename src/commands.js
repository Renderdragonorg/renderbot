import {
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import {
  V2,
  buildError,
  buildHelp,
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

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Check a Spotify or YouTube track for copyright and licensing requirements.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Spotify URL, YouTube URL/video id, or a YouTube search query')
        .setRequired(true),
    )
    .addBooleanOption((option) =>
      option.setName('private').setDescription('Only show the result to you'),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('file')
    .setDescription('Check an uploaded audio file for copyright and licensing requirements.')
    .addAttachmentOption((option) =>
      option
        .setName('audio')
        .setDescription('Audio file (mp3, flac, m4a, wav, ogg, opus, aac, wma)')
        .setRequired(true),
    )
    .addBooleanOption((option) =>
      option.setName('private').setDescription('Only show the result to you'),
    )
    .toJSON(),
  new SlashCommandBuilder().setName('help').setDescription('Show what this bot can do.').toJSON(),
];

export async function registerCommands(config) {
  const rest = new REST({ version: '10' }).setToken(config.token);
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
      body: commandDefinitions,
    });
    console.log(`Registered ${commandDefinitions.length} slash commands in guild ${config.guildId}.`);
    return;
  }
  await rest.put(Routes.applicationCommands(config.clientId), { body: commandDefinitions });
  console.log(`Registered ${commandDefinitions.length} global slash commands.`);
}

function componentsV2(container) {
  return { flags: V2, components: [container], allowedMentions: { parse: [] } };
}

function reserve(interaction, db, config) {
  return reserveQuota(db, {
    userId: interaction.user.id,
    username: interaction.user.username,
    limit: config.quota.dailyLimit,
    bypassUserIds: config.quota.bypassUserIds,
  });
}

function makeProgress(interaction, base) {
  let last = null;
  return async (update) => {
    const stage = update?.message;
    if (!stage || stage === last) return;
    last = stage;
    try {
      await interaction.editReply({
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

export async function handleSlash(interaction, { engine, store, db, audit, config }) {
  switch (interaction.commandName) {
    case 'help':
      return handleHelp(interaction, config);
    case 'check':
      return handleCheck(interaction, { engine, store, db, audit, config });
    case 'file':
      return handleFile(interaction, { engine, db, audit, config });
    default:
      return undefined;
  }
}

async function handleHelp(interaction, config) {
  await interaction.reply({
    flags: V2 | MessageFlags.Ephemeral,
    components: [buildHelp(config.prefix)],
  });
}

async function handleCheck(interaction, { engine, store, db, audit, config }) {
  const input = interaction.options.getString('query', true).trim();
  const isPrivate = interaction.options.getBoolean('private') ?? false;

  // Free-text queries get a search-then-pick step (engine v0.3.2+).
  if (isSearchQuery(input)) {
    await interaction.deferReply(isPrivate ? { flags: MessageFlags.Ephemeral } : {});
    let candidates = null;
    try {
      candidates = await searchCandidates(engine, input);
    } catch (error) {
      if (error?.status !== 404) {
        console.error('[slash:search]', describeError(error));
        await interaction.editReply({ flags: V2, components: [buildError(error)] });
        return;
      }
      // Engine predates `/youtube/search`; fall through to the direct check.
    }
    if (candidates) {
      if (!candidates.length) {
        await interaction.editReply({ flags: V2, components: [buildSearchEmpty(input)] });
        return;
      }
      const contextId = rememberSearch(store, { query: input, candidates });
      await interaction.editReply({
        flags: V2,
        components: [buildSearchResults({ query: input, candidates, contextId })],
        allowedMentions: { parse: [] },
      });
      return;
    }
  }

  const quota = reserve(interaction, db, config);
  if (!quota.allowed) {
    const payload = { flags: V2, components: [buildQuotaExceeded(quota)] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: V2 | MessageFlags.Ephemeral });
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply(isPrivate ? { flags: MessageFlags.Ephemeral } : {});
  }
  await runUrlCheck(interaction, input, { engine, store, db, audit, quota });
}

async function runUrlCheck(interaction, input, { engine, store, db, audit, quota }) {
  await interaction.editReply({
    flags: V2,
    components: [buildProgress({ note: `\`${input}\`` })],
    allowedMentions: { parse: [] },
  });

  let delivered = false;
  const startedAt = Date.now();
  const contextId = rememberUrl(store, input);
  const onProgress = makeProgress(interaction, { note: `\`${input}\`` });
  try {
    const result = await performUrl(engine, input, { onProgress });
    await interaction.editReply(
      componentsV2(buildResult(result, { sourceInput: input, refreshContextId: contextId, quota })),
    );
    delivered = true;
    recordCheck(audit, interaction, { command: 'check', source: 'url', request: input, result, startedAt });
  } catch (error) {
    console.error('[slash:check]', describeError(error));
    if (!delivered) refundQuota(db, { userId: interaction.user.id, usageDate: quota.usageDate });
    recordCheck(audit, interaction, { command: 'check', source: 'url', request: input, error, startedAt });
    await interaction.editReply({ flags: V2, components: [buildError(error, { retryContextId: contextId })] });
  }
}

async function handleFile(interaction, { engine, db, audit, config }) {
  const attachment = interaction.options.getAttachment('audio', true);
  const isPrivate = interaction.options.getBoolean('private') ?? false;

  const quota = reserve(interaction, db, config);
  if (!quota.allowed) {
    await interaction.reply({
      flags: V2 | MessageFlags.Ephemeral,
      components: [buildQuotaExceeded(quota)],
    });
    return;
  }

  await interaction.deferReply(isPrivate ? { flags: MessageFlags.Ephemeral } : {});
  await interaction.editReply({
    flags: V2,
    components: [buildProgress({ title: 'File copyright check', note: `\`${attachment.name}\`` })],
    allowedMentions: { parse: [] },
  });

  let delivered = false;
  const startedAt = Date.now();
  const onProgress = makeProgress(interaction, { title: 'File copyright check', note: `\`${attachment.name}\`` });
  try {
    const file = await downloadAttachment(attachment);
    const result = await performFile(engine, file, { onProgress });
    await interaction.editReply(
      componentsV2(buildResult(result, { sourceInput: attachment.name, quota })),
    );
    delivered = true;
    recordCheck(audit, interaction, { command: 'file', source: 'file', request: attachment.name, result, startedAt });
  } catch (error) {
    console.error('[slash:file]', describeError(error));
    if (!delivered) refundQuota(db, { userId: interaction.user.id, usageDate: quota.usageDate });
    recordCheck(audit, interaction, { command: 'file', source: 'file', request: attachment.name, error, startedAt });
    await interaction.editReply({ flags: V2, components: [buildError(error)] });
  }
}

export async function handleButton(interaction, { engine, store, db, audit, config }) {
  const [namespace, action, contextId, extra] = interaction.customId.split(':');
  if (namespace !== 'looney') return;
  if (action === 'pick') {
    return handlePick(interaction, { engine, store, db, audit, config }, contextId, Number(extra));
  }
  if (action !== 'refresh') return;

  const context = store.get(contextId);
  if (!context) {
    await interaction.reply({
      flags: V2 | MessageFlags.Ephemeral,
      components: [buildError('This result has expired. Run the command again.')],
    });
    return;
  }

  const quota = reserve(interaction, db, config);
  if (!quota.allowed) {
    await interaction.reply({
      flags: V2 | MessageFlags.Ephemeral,
      components: [buildQuotaExceeded(quota)],
    });
    return;
  }

  await interaction.deferUpdate();
  await interaction.editReply({
    flags: V2,
    components: [buildProgress({ note: `\`${context.input}\`` })],
    allowedMentions: { parse: [] },
  });

  let delivered = false;
  const startedAt = Date.now();
  const onProgress = makeProgress(interaction, { note: `\`${context.input}\`` });
  try {
    const result = await performUrl(engine, context.input, { refresh: true, onProgress });
    await interaction.editReply(
      componentsV2(buildResult(result, { sourceInput: context.input, refreshContextId: contextId, quota })),
    );
    delivered = true;
    recordCheck(audit, interaction, {
      command: 'refresh',
      source: 'url',
      request: context.input,
      result,
      startedAt,
    });
  } catch (error) {
    console.error('[button:refresh]', describeError(error));
    if (!delivered) refundQuota(db, { userId: interaction.user.id, usageDate: quota.usageDate });
    recordCheck(audit, interaction, {
      command: 'refresh',
      source: 'url',
      request: context.input,
      error,
      startedAt,
    });
    await interaction.editReply({ flags: V2, components: [buildError(error, { retryContextId: contextId })] });
  }
}

async function handlePick(interaction, { engine, store, db, audit, config }, contextId, index) {
  const context = store.get(contextId);
  const candidate = context?.kind === 'search' ? context.candidates?.[index] : null;
  if (!candidate?.url) {
    await interaction.reply({
      flags: V2 | MessageFlags.Ephemeral,
      components: [buildError('This selection has expired. Run the search again.')],
    });
    return;
  }

  const quota = reserve(interaction, db, config);
  if (!quota.allowed) {
    await interaction.reply({
      flags: V2 | MessageFlags.Ephemeral,
      components: [buildQuotaExceeded(quota)],
    });
    return;
  }

  const input = candidate.url;
  await interaction.deferUpdate();
  await interaction.editReply({
    flags: V2,
    components: [buildProgress({ note: `\`${input}\`` })],
    allowedMentions: { parse: [] },
  });

  let delivered = false;
  const startedAt = Date.now();
  const refreshContextId = rememberUrl(store, input);
  const onProgress = makeProgress(interaction, { note: `\`${input}\`` });
  try {
    const result = await performUrl(engine, input, { onProgress });
    await interaction.editReply(
      componentsV2(buildResult(result, { sourceInput: input, refreshContextId, quota })),
    );
    delivered = true;
    recordCheck(audit, interaction, { command: 'check', source: 'url', request: input, result, startedAt });
  } catch (error) {
    console.error('[button:pick]', describeError(error));
    if (!delivered) refundQuota(db, { userId: interaction.user.id, usageDate: quota.usageDate });
    recordCheck(audit, interaction, { command: 'check', source: 'url', request: input, error, startedAt });
    await interaction.editReply({ flags: V2, components: [buildError(error, { retryContextId })] });
  }
}
