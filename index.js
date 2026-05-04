// ===== QUICK HACK FIX =====
if (typeof File === 'undefined') {
  global.File = class File {};
}

if (!String.prototype.toWellFormed) {
  String.prototype.toWellFormed = function () {
    return this;
  };
}

// ===== IMPORTS =====
require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const express = require("express");

// ===== GLOBAL ERROR HANDLER =====
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

// ===== EXPRESS =====
const app = express();
const port = process.env.PORT || 3500;

app.get('/', (_, res) => res.send('Bot is running'));
app.listen(port, () => console.log(`🌐 Express server listening on port ${port}`));

// ===== CLIENT =====
const client = new Client();

// ===== CONFIG =====
const serverId = process.env.server;
const voiceChannelId = process.env.id;

// ===== STATE =====
let currentVoiceChannelId = null;
let isConnecting = false;
let reconnectTimer = null;
let connection = null;

// ===== COOLDOWN =====
const cooldown = new Map();

// ===== MEMORY =====
setInterval(() => {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`🧠 RAM: ${Math.round(used)} MB`);
}, 15000);

// ===== CONNECTION =====
function destroyConnection(guildId) {
  try {
    const old = getVoiceConnection(guildId);
    if (old) old.destroy();
    connection = null;
  } catch (err) {
    console.error("Destroy error:", err);
  }
}

async function connectToVoiceChannel() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const guild = client.guilds.cache.get(serverId);
    if (!guild) return;

    const channel = guild.channels.cache.get(voiceChannelId);
    if (!channel || (channel.type !== 'GUILD_VOICE' && channel.type !== 2)) return;

    if (currentVoiceChannelId === channel.id && connection) return;

    destroyConnection(guild.id);

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfMute: true,
      selfDeaf: true
    });

    currentVoiceChannelId = channel.id;
    console.log(`📢 Joined: ${channel.name}`);

  } catch (err) {
    console.error(err);
  } finally {
    isConnecting = false;
  }
}

function scheduleReconnect(delay = 3000) {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!currentVoiceChannelId) await connectToVoiceChannel();
  }, delay);
}

// ===== EVENTS =====
client.on('ready', async () => {
  console.log(`✅ ${client.user.username} is online`);
  await connectToVoiceChannel();
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (!client.user) return;
    if (newState.member.id !== client.user.id) return;
    if (newState.guild.id !== serverId) return;

    if (!newState.channelId && oldState.channelId) {
      currentVoiceChannelId = null;
      destroyConnection(serverId);
      scheduleReconnect(3000);
    } else if (newState.channelId !== oldState.channelId) {
      currentVoiceChannelId = newState.channelId;
    }

  } catch (err) {
    console.error(err);
  }
});

// ===== AUTO REPLY =====
client.on('messageCreate', async (message) => {
  try {
    if (!client.user) return;
    if (message.author.id === client.user.id) return;
    if (!message.guild) return;

    // ✅ FIX mention check
    if (!message.mentions.users.has(client.user.id)) return;

    // ✅ cooldown 3s / channel
    const now = Date.now();
    const last = cooldown.get(message.channel.id) || 0;
    if (now - last < 3000) return;
    cooldown.set(message.channel.id, now);

    await message.channel.send("yes");
    console.log(`💬 yes -> #${message.channel.name}`);

  } catch (err) {
    console.error("Mention reply error:", err);
  }
});

// ===== LOGIN =====
client.login(process.env.token);
