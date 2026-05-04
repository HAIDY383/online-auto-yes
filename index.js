// ===== FIX: undici File error (ต้องอยู่บนสุด) =====
if (typeof File === 'undefined') {
  global.File = class File {};
}

// ===== IMPORTS =====
require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const {
  joinVoiceChannel,
  getVoiceConnection
} = require('@discordjs/voice');
const express = require("express");

// ===== GLOBAL ERROR HANDLER =====
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

// ===== EXPRESS SERVER =====
const app = express();
const port = process.env.PORT || 3500;

app.get('/', (_, res) => res.send('Bot is running'));

app.listen(port, () => {
  console.log(`🌐 Express server listening on port ${port}`);
});

// ===== DISCORD CLIENT =====
const client = new Client();

// ===== CONFIG =====
const serverId = process.env.server;
const voiceChannelId = process.env.id;

// ===== STATE CONTROL =====
let currentVoiceChannelId = null;
let isConnecting = false;
let reconnectTimer = null;
let connection = null;

// ===== MEMORY MONITOR (optional แต่แนะนำ) =====
setInterval(() => {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`🧠 RAM: ${Math.round(used)} MB`);
}, 15000);

// ===== CLEAN CONNECTION =====
function destroyConnection(guildId) {
  try {
    const old = getVoiceConnection(guildId);
    if (old) {
      old.destroy();
      console.log("🧹 Old connection destroyed");
    }
    connection = null;
  } catch (err) {
    console.error("Destroy error:", err);
  }
}

// ===== SAFE CONNECT =====
async function connectToVoiceChannel() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const guild = client.guilds.cache.get(serverId);
    if (!guild) {
      console.error("❌ Guild not found");
      return;
    }

    const channel = guild.channels.cache.get(voiceChannelId);

    if (!channel || (channel.type !== 'GUILD_VOICE' && channel.type !== 2)) {
      console.error("❌ Voice channel not valid");
      return;
    }

    // ป้องกัน join ซ้ำ
    if (currentVoiceChannelId === channel.id && connection) {
      return;
    }

    // 🧹 เคลียร์ของเก่า
    destroyConnection(guild.id);

    // 🔗 JOIN ใหม่
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfMute: true,
      selfDeaf: true
    });

    currentVoiceChannelId = channel.id;

    console.log(`📢 Joined: ${channel.name}`);
  } catch (error) {
    console.error("Voice connect error:", error);
  } finally {
    isConnecting = false;
  }
}

// ===== SMART RECONNECT =====
function scheduleReconnect(delay = 3000) {
  if (reconnectTimer) return; // กัน spam

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;

    if (!currentVoiceChannelId) {
      console.log("🔄 Reconnecting...");
      await connectToVoiceChannel();
    }
  }, delay);
}

// ===== EVENTS =====
client.on('ready', async () => {
  console.log(`✅ ${client.user.username} is online`);

  try {
    await client.user.setPresence({ status: 'online' });
  } catch (e) {
    console.error("Presence error:", e);
  }

  await connectToVoiceChannel();
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (!client.user) return;
    if (newState.member.id !== client.user.id) return;
    if (newState.guild.id !== serverId) return;

    // 🚪 ออกจากห้อง
    if (!newState.channelId && oldState.channelId) {
      console.log(`📤 Left: ${oldState.channel?.name}`);

      currentVoiceChannelId = null;

      // 🧹 เคลียร์ connection
      destroyConnection(serverId);

      // 🔄 reconnect แบบ safe
      scheduleReconnect(3000);
    }

    // 🔀 ย้ายห้อง
    else if (newState.channelId !== oldState.channelId) {
      currentVoiceChannelId = newState.channelId;
      console.log(`📥 Moved: ${newState.channel?.name}`);
    }

  } catch (err) {
    console.error("voiceStateUpdate error:", err);
  }
});

// ===== AUTO REPLY WHEN MENTIONED =====
client.on('messageCreate', async (message) => {
  try {
    // กันตอบตัวเอง
    if (message.author.id === client.user.id) return;

    // เช็คว่าโดนแท็ก
    if (message.mentions.has(client.user.id)) {
      await message.channel.send("yes");
      console.log(`💬 Replied 'yes' in #${message.channel.name}`);
    }

  } catch (err) {
    console.error("Mention reply error:", err);
  }
});

// ===== LOGIN =====
client.login(process.env.token);
