import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
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

// Guild-scoped commands never appear in DMs; only global commands with the
// BotDM context do. So the global copy opts into DMs while the per-guild copy
// (below) stays instant in the allowed servers.
const globalCommandDefinitions = commandDefinitions.map((command) => ({
  ...command,
  integration_types: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
}));

export async function registerCommands(config) {
  const rest = new REST({ version: '10' }).setToken(config.token);

  try {
    await rest.put(Routes.applicationCommands(config.clientId), { body: globalCommandDefinitions });
    console.log(`Registered ${globalCommandDefinitions.length} global slash commands (guild + bot DM).`);
  } catch (error) {
    console.error(`Global slash command registration failed: ${error.message}`);
  }

  const guildTargets = config.allowedGuildIds.size
    ? [...config.allowedGuildIds]
    : config.guildId
      ? [config.guildId]
      : [];
  if (!guildTargets.length) return;
  let registered = 0;
  for (const guildId of guildTargets) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), {
        body: commandDefinitions,
      });
      registered += 1;
    } catch (error) {
      console.error(`Slash command registration failed for guild ${guildId}: ${error.message}`);
    }
  }
  console.log(`Registered ${commandDefinitions.length} slash commands in ${registered} guild(s).`);
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

export async function handleSlash(interaction, deps) {
  const { engine, store, db, audit, config, queue } = deps;
  const commandChannel = db.getCommandChannel(interaction.guildId);
  if (interaction.commandName !== 'help' && commandChannel && interaction.channelId !== commandChannel) {
    await interaction.reply({
      flags: V2 | MessageFlags.Ephemeral,
      components: [buildNotice('Wrong channel', `Use <#${commandChannel}> for bot commands.`)],
      allowedMentions: { parse: [] },
    });
    return;
  }
  switch (interaction.commandName) {
    case 'help':
      return handleHelp(interaction);
    case 'check':
      return handleCheck(interaction, { engine, store, db, audit, config, queue });
    case 'file':
      return handleFile(interaction, { engine, db, audit, config, queue });
    default:
      return undefined;
  }
}

async function handleHelp(interaction) {
  await interaction.reply({
    flags: V2 | MessageFlags.Ephemeral,
    components: [buildHelp()],
  });
}

async function handleCheck(interaction, { engine, store, db, audit, config, queue }) {
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
  await runUrlCheck(interaction, input, { engine, store, db, audit, quota, queue });
}

async function runUrlCheck(interaction, input, { engine, store, db, audit, quota, queue }) {
  let delivered = false;
  const startedAt = Date.now();
  const contextId = rememberUrl(store, input);
  const onProgress = makeProgress(interaction, { note: `\`${input}\`` });
  try {
    const result = await runQueuedCheck({
      queue,
      edit: (payload) => interaction.editReply(payload),
      queueBase: { note: `\`${input}\`` },
      progressBase: { note: `\`${input}\`` },
      task: () => performUrl(engine, input, { onProgress }),
    });
    const finalQuota = refundIfCached(db, { userId: interaction.user.id, quota, result });
    await interaction.editReply(
      componentsV2(buildResult(result, { sourceInput: input, refreshContextId: contextId, quota: finalQuota })),
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

async function handleFile(interaction, { engine, db, audit, config, queue }) {
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

  let delivered = false;
  const startedAt = Date.now();
  const onProgress = makeProgress(interaction, { title: 'File copyright check', note: `\`${attachment.name}\`` });
  try {
    const result = await runQueuedCheck({
      queue,
      edit: (payload) => interaction.editReply(payload),
      queueBase: { title: 'File copyright check', note: `\`${attachment.name}\`` },
      progressBase: { title: 'File copyright check', note: `\`${attachment.name}\`` },
      task: async () => {
        const file = await downloadAttachment(attachment);
        return performFile(engine, file, { onProgress });
      },
    });
    const finalQuota = refundIfCached(db, { userId: interaction.user.id, quota, result });
    await interaction.editReply(
      componentsV2(buildResult(result, { sourceInput: attachment.name, quota: finalQuota })),
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

export async function handleButton(interaction, deps) {
  const { engine, store, db, audit, config, queue } = deps;
  const [namespace, action, contextId, extra] = interaction.customId.split(':');
  if (namespace !== 'looney') return;
  if (action === 'pick') {
    return handlePick(interaction, { engine, store, db, audit, config, queue }, contextId, Number(extra));
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

  let delivered = false;
  const startedAt = Date.now();
  const onProgress = makeProgress(interaction, { note: `\`${context.input}\`` });
  try {
    const result = await runQueuedCheck({
      queue,
      edit: (payload) => interaction.editReply(payload),
      queueBase: { note: `\`${context.input}\`` },
      progressBase: { note: `\`${context.input}\`` },
      task: () => performUrl(engine, context.input, { refresh: true, onProgress }),
    });
    const finalQuota = refundIfCached(db, { userId: interaction.user.id, quota, result });
    await interaction.editReply(
      componentsV2(buildResult(result, { sourceInput: context.input, refreshContextId: contextId, quota: finalQuota })),
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

async function handlePick(interaction, { engine, store, db, audit, config, queue }, contextId, index) {
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

  let delivered = false;
  const startedAt = Date.now();
  const refreshContextId = rememberUrl(store, input);
  const onProgress = makeProgress(interaction, { note: `\`${input}\`` });
  try {
    const result = await runQueuedCheck({
      queue,
      edit: (payload) => interaction.editReply(payload),
      queueBase: { note: `\`${input}\`` },
      progressBase: { note: `\`${input}\`` },
      task: () => performUrl(engine, input, { onProgress }),
    });
    const finalQuota = refundIfCached(db, { userId: interaction.user.id, quota, result });
    await interaction.editReply(
      componentsV2(buildResult(result, { sourceInput: input, refreshContextId, quota: finalQuota })),
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
