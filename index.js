// ===== NODE VERSION CHECK & SAFE POLYFILL =====
const nodeVersion = parseInt(process.versions.node.split('.')[0]);
console.log(`🔍 Running on Node.js v${process.versions.node}`);

if (nodeVersion < 18) {
  console.log('📦 Node < 18 detected, loading polyfills...');
  try {
    const nodeFetch = require('node-fetch');
    if (!global.fetch) {
      global.fetch = nodeFetch;
      global.Headers = nodeFetch.Headers;
      global.Request = nodeFetch.Request;
      global.Response = nodeFetch.Response;
    }
  } catch (e) {
    console.error('❌ Failed to load node-fetch polyfill:', e.message);
    console.log('💡 Please run: npm install node-fetch@2');
  }
}

if (typeof File === 'undefined') {
  global.File = class File {
    constructor(bits, name, options = {}) {
      this.name = name || 'file';
      this.size = bits ? bits.length : 0;
      this.type = options.type || '';
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

if (typeof Blob === 'undefined') {
  try {
    const { Blob: BufferBlob } = require('buffer');
    global.Blob = BufferBlob;
    globalThis.Blob = BufferBlob;
  } catch (e) {
    console.error('⚠️ Blob not available:', e.message);
  }
}

if (!String.prototype.toWellFormed) {
  String.prototype.toWellFormed = function () {
    return this.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '\uFFFD'
    );
  };
}

// ===== IMPORTS =====
require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const express = require('express');

// ===== GLOBAL ERROR HANDLING =====
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

// ===== CONFIG =====
const serverId    = process.env.server;
const voiceChannelId = process.env.id;
const token       = process.env.token;

if (!serverId || !voiceChannelId || !token) {
  console.error('❌ Missing environment variables! Required: server, id, token');
  process.exit(1);
}

// ===== STATE =====
let currentVoiceChannelId = null;
let isConnecting          = false;
let reconnectAttempts     = 0;
let reconnectTimer        = null;       // FIX: ใช้จริง ไว้ cancel ได้
let memoryInterval        = null;       // FIX: เก็บ ref เพื่อ clearInterval ตอน shutdown
let isShuttingDown        = false;

const MAX_RECONNECT_ATTEMPTS = 10;
const COOLDOWN_MS            = 3000;
const COOLDOWN_TTL_MS        = 10000;  // FIX: TTL สำหรับ evict cooldown entries

// FIX: cooldown Map พร้อม TTL eviction ป้องกัน memory leak
const cooldown = new Map();

function setCooldown(channelId) {
  // ลบ timer เก่าถ้ามี
  const old = cooldown.get(channelId);
  if (old?.timer) clearTimeout(old.timer);

  const timer = setTimeout(() => cooldown.delete(channelId), COOLDOWN_TTL_MS);
  cooldown.set(channelId, { ts: Date.now(), timer });
}

function isOnCooldown(channelId) {
  const entry = cooldown.get(channelId);
  if (!entry) return false;
  return Date.now() - entry.ts < COOLDOWN_MS;
}

// ===== EXPRESS SERVER =====
const app  = express();
const port = process.env.PORT || 3500;

app.get('/', (_req, res) => res.json({
  status:       'online',
  uptime:       process.uptime(),
  nodeVersion:  process.versions.node,
}));

app.get('/health', (_req, res) => res.json({
  status:        'healthy',
  voiceConnected: !!currentVoiceChannelId,
  reconnectAttempts,
  cooldownSize:  cooldown.size,
  memory:        Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
}));

const server = app.listen(port, () => {
  console.log(`🌐 Express server running on port ${port}`);
});

// ===== DISCORD CLIENT =====
const client = new Client({ checkUpdate: false, intents: [] });

// ===== MEMORY MONITORING (ต้องเก็บ ref ไว้ clear ได้) =====
memoryInterval = setInterval(() => {
  const used = process.memoryUsage();
  console.log(
    `🧠 Heap: ${Math.round(used.heapUsed / 1024 / 1024)}MB` +
    ` / ${Math.round(used.heapTotal / 1024 / 1024)}MB` +
    ` | Cooldown entries: ${cooldown.size}`
  );
}, 30000);

// ===== VOICE =====
function destroyConnection(guildId) {
  try {
    const conn = getVoiceConnection(guildId);
    if (conn) {
      conn.destroy();
      console.log('🔌 Voice connection destroyed');
    }
  } catch (e) {
    console.error('❌ Error destroying connection:', e.message);
  }
}

// FIX: schedule reconnect ผ่านฟังก์ชันเดียว ป้องกัน timer ซ้อน
function scheduleReconnect() {
  if (isShuttingDown) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('❌ Max reconnection attempts reached — giving up');
    return;
  }

  // FIX: cancel pending timer ก่อนจะ schedule ใหม่เสมอ
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  console.log(`🔄 Reconnect scheduled in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToVoiceChannel();
  }, delay);
}

async function connectToVoiceChannel() {
  if (isShuttingDown) return;
  if (isConnecting) {
    console.log('⏳ Already attempting to connect...');
    return;
  }

  isConnecting = true;

  try {
    const guild = client.guilds.cache.get(serverId);
    if (!guild) { console.error('❌ Server not found!'); return; }

    const channel = guild.channels.cache.get(voiceChannelId);
    if (!channel) { console.error('❌ Voice channel not found!'); return; }

    if (channel.type !== 'GUILD_VOICE' && channel.type !== 2) {
      console.error('❌ Channel is not a voice channel!');
      return;
    }

    // ถ้า connection ยังดีอยู่ ไม่ต้อง reconnect
    if (currentVoiceChannelId === channel.id) {
      const existing = getVoiceConnection(guild.id);
      if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
        console.log('✅ Already connected to target channel');
        return;
      }
    }

    destroyConnection(guild.id);

    const connection = joinVoiceChannel({
      channelId:      channel.id,
      guildId:        guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfMute:       true,
      selfDeaf:       true,
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`📢 Connected to: ${channel.name}`);
      currentVoiceChannelId = channel.id;
      reconnectAttempts     = 0;     // FIX: reset เมื่อ ready จริงๆ
      // cancel pending reconnect timer ถ้ายังค้างอยู่
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log('🔌 Disconnected from voice channel');
      currentVoiceChannelId = null;
      try { await connection.destroy(); } catch (_) {}
      scheduleReconnect();           // FIX: ไปผ่าน scheduleReconnect เสมอ
    });

    connection.on('error', (error) => {
      console.error('❌ Voice connection error:', error.message);
    });

  } catch (err) {
    console.error('❌ Error connecting to voice:', err.message);
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}

// ===== CLIENT EVENTS =====
client.on('ready', async () => {
  console.log(`✅ Logged in as: ${client.user.tag} (${client.user.id})`);
  await connectToVoiceChannel();
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (!client.user) return;
    if (newState?.member?.id !== client.user.id) return;

    // FIX: ใช้ guild.id จาก state โดยตรง ไม่ใช้ serverId string
    const guildId = newState?.guild?.id ?? oldState?.guild?.id;
    if (guildId !== serverId) return;

    // Left voice
    if (!newState.channelId && oldState.channelId) {
      console.log('👋 Left voice channel');
      currentVoiceChannelId = null;
      destroyConnection(guildId);

      // FIX: ผ่าน scheduleReconnect ไม่ใช้ setTimeout ตรงๆ
      scheduleReconnect();
    }
    // Moved channels
    else if (newState.channelId && newState.channelId !== oldState.channelId) {
      console.log(`🔀 Moved to channel: ${newState.channelId}`);
      if (newState.channelId === voiceChannelId) {
        currentVoiceChannelId = newState.channelId;
      } else {
        await connectToVoiceChannel();
      }
    }
  } catch (err) {
    console.error('❌ voiceStateUpdate error:', err.message);
  }
});

// ===== AUTO REPLY =====
client.on('messageCreate', async (message) => {
  try {
    if (!client.user) return;
    if (message.author.id === client.user.id) return;
    if (!message.guild) return;
    if (message.guild.id !== serverId) return;
    if (!message.mentions.users.has(client.user.id)) return;

    // FIX: ใช้ cooldown ที่มี TTL
    if (isOnCooldown(message.channel.id)) {
      console.log(`⏰ Cooldown active for #${message.channel.name}`);
      return;
    }
    setCooldown(message.channel.id);

    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] ⏳ Mention from ${message.author.tag}, waiting 10s...`);

    await new Promise(resolve => setTimeout(resolve, 10000));

    // FIX: เช็ค bot ยังทำงานอยู่หลัง await
    if (isShuttingDown || !client.user) return;

    const diff = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] ⏱️ Waited ${diff}s, replying...`);

    await message.channel.send('yes').catch(e => {
      console.error(`❌ Failed to send in #${message.channel.name}:`, e.message);
    });

    console.log(`💬 Replied to ${message.author.tag} in #${message.channel.name}`);

  } catch (err) {
    console.error('❌ Reply error:', err.message);
  }
});

client.on('error', (error) => console.error('❌ Client error:', error.message));
client.on('warn',  (warning) => console.warn('⚠️ Warning:', warning));

// ===== GRACEFUL SHUTDOWN =====
function shutdown(signal) {
  console.log(`\n🛑 ${signal} received — shutting down...`);
  isShuttingDown = true;

  // FIX: clear interval + timer ป้องกัน timer leak
  if (memoryInterval) { clearInterval(memoryInterval); memoryInterval = null; }
  if (reconnectTimer)  { clearTimeout(reconnectTimer);  reconnectTimer  = null; }

  // clear cooldown timers
  for (const [, entry] of cooldown) {
    if (entry?.timer) clearTimeout(entry.timer);
  }
  cooldown.clear();

  destroyConnection(serverId);
  client.destroy();
  server.close(() => {
    console.log('🌐 HTTP server closed');
    process.exit(0);
  });

  // force exit ถ้า close ไม่เสร็จใน 5s
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ===== START =====
console.log('🚀 Starting bot...');
client.login(token).catch(err => {
  console.error('❌ Failed to login:', err.message);
  process.exit(1);
});
