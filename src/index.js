import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config, validateConfig } from './config.js';
import { LooneyEngine } from './engine.js';
import { ContextStore } from './store.js';
import { JsonStore } from './db.js';
import { RequestLogger } from './audit.js';
import { CheckApi } from './api.js';
import { handleButton, handleSlash, registerCommands } from './commands.js';
import { handlePrefixMessage } from './prefix.js';
import { V2, buildError } from './render.js';

const problems = validateConfig();
if (problems.length) {
  console.error('Configuration problems:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const engine = new LooneyEngine(config.engine);
const store = new ContextStore(config.contextTtlMs);
const db = new JsonStore(config.db.path, { retentionDays: config.db.retentionDays });
const audit = new RequestLogger(config.audit.path);
const api = config.api.enabled
  ? new CheckApi({
      audit,
      host: config.api.host,
      port: config.api.port,
      rateLimitPerMinute: config.api.rateLimitPerMinute,
      trustProxy: config.api.trustProxy,
    })
  : null;
const deps = { engine, store, db, audit, config };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function safeErrorReply(interaction, error) {
  const payload = { flags: V2, components: [buildError(error)] };
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else if (interaction.isRepliable()) await interaction.reply({ ...payload, flags: V2 | MessageFlags.Ephemeral });
  } catch {
    /* interaction already acknowledged; nothing else to do */
  }
}

const readyEvent = Events.ClientReady ?? 'ready';

client.once(readyEvent, async () => {
  console.log(`Logged in as ${client.user.tag}.`);
  engine
    .ensureReady()
    .then(() => console.log('Copyright engine is warm and ready.'))
    .catch((error) => console.error(`Engine failed to start: ${error.message}`));
  if (api) {
    api
      .start()
      .then((address) => console.log(`Checks API listening on http://${address.address}:${address.port}`))
      .catch((error) => console.error(`Checks API failed to start: ${error.message}`));
  }
  try {
    await registerCommands(config);
  } catch (error) {
    console.error(`Slash command registration failed: ${error.message}`);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleSlash(interaction, deps);
    else if (interaction.isButton()) await handleButton(interaction, deps);
  } catch (error) {
    console.error('Interaction error:', error);
    await safeErrorReply(interaction, error);
  }
});

client.on('messageCreate', (message) => {
  handlePrefixMessage(message, deps).catch((error) => console.error('Prefix command error:', error));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down...`);
  await engine.stop();
  await api?.close();
  db.close();
  audit.close();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.token).catch((error) => {
  console.error(`Login failed: ${error.message}`);
  process.exit(1);
});
