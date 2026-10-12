require('dotenv').config();

// --- MUSIC LOGIC IS SEPARATED INTO music.js ---
const { Client, GatewayIntentBits } = require("discord.js");
const play = require("play-dl");
const { handleCommand } = require("./commands");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Store per-guild player, connection, and queue
const queues = new Map();

function shutdownBot() {
  for (const playerObj of queues.values()) {
    if (playerObj.connection && !playerObj.connection.destroyed) {
      playerObj.connection.destroy();
    }
    if (playerObj.player) {
      playerObj.player.stop();
    }
  }
  queues.clear();
  client.destroy();
  process.exit(0);
}

client.on("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  await handleCommand(message, queues, play);
});

process.on("SIGINT", shutdownBot);
process.on("SIGTERM", shutdownBot);

// 🔑 Use token from .env
client.login(process.env.DISCORD_TOKEN);