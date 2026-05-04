// ===== FULL FIX (Node 18 + selfbot stable) =====

// File fix
if (typeof File === 'undefined') {
  global.File = class File {};
}

// toWellFormed fix
if (!String.prototype.toWellFormed) {
  String.prototype.toWellFormed = function () {
    return this;
  };
}

// 🔥 fetch / Request fix (สำคัญมาก)
const undici = require('undici');

global.fetch = undici.fetch;
global.Headers = undici.Headers;
global.Request = undici.Request;
global.Response = undici.Response;

globalThis.fetch = undici.fetch;
globalThis.Headers = undici.Headers;
globalThis.Request = undici.Request;
globalThis.Response = undici.Response;

// (fallback เผื่อบาง env)
try {
  const { Blob } = require('buffer');
  global.Blob = Blob;
  globalThis.Blob = Blob;
} catch {}

// ===== IMPORTS =====
require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const express = require("express");

// ===== GLOBAL ERROR =====
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

// ===== EXPRESS =====
const app = express();
const port = process.env.PORT || 3500;

app.get('/', (_, res) => res.send('Bot is running'));
app.listen(port, () => console.log(`🌐 Express server on ${port}`));

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
  } catch (e) {
    console.error("Destroy error:", e);
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
    console.error("Voice error:", err);
  } finally {
    isConnecting = false;
  }
}

function scheduleReconnect(delay = 3000) {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!currentVoiceChannelId) {
      console.log("🔄 reconnecting...");
      await connectToVoiceChannel();
    }
  }, delay);
}

// ===== EVENTS =====
client.on('ready', async () => {
  console.log(`✅ ${client.user.username} online`);
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
      scheduleReconnect();
    } else if (newState.channelId !== oldState.channelId) {
      currentVoiceChannelId = newState.channelId;
    }

  } catch (err) {
    console.error("voiceState error:", err);
  }
});

// ===== AUTO REPLY =====
client.on('messageCreate', async (message) => {
  try {
    if (!client.user) return;
    if (message.author.id === client.user.id) return;
    if (!message.guild) return;

    if (!message.mentions.users.has(client.user.id)) return;

    const now = Date.now();
    const last = cooldown.get(message.channel.id) || 0;
    if (now - last < 3000) return;
    cooldown.set(message.channel.id, now);

    await message.channel.send("yes");

    console.log(`💬 yes -> #${message.channel.name}`);

  } catch (err) {
    console.error("Reply error:", err);
  }
});

// ===== LOGIN =====
client.login(process.env.token);
