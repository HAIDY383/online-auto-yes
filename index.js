// ===== NODE VERSION CHECK & SAFE POLYFILL =====
const nodeVersion = parseInt(process.versions.node.split('.')[0]);

console.log(`🔍 Running on Node.js v${process.versions.node}`);

// เฉพาะ Node < 18 ค่อยลง polyfill
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

// Fix for File API (Node.js ไม่มี built-in)
if (typeof File === 'undefined') {
  global.File = class File {
    constructor(bits, name, options = {}) {
      this.name = name || 'file';
      this.size = bits ? bits.length : 0;
      this.type = options.type || '';
      this.lastModified = options.lastModified || Date.now();
    }
  };
  console.log('📝 File API polyfill loaded');
}

// Fix for Blob (Node 15+ มีใน buffer)
if (typeof Blob === 'undefined') {
  try {
    const { Blob: BufferBlob } = require('buffer');
    global.Blob = BufferBlob;
    globalThis.Blob = BufferBlob;
    console.log('📝 Blob from buffer loaded');
  } catch (e) {
    console.error('⚠️ Blob not available:', e.message);
  }
}

// String.prototype.toWellFormed polyfill
if (!String.prototype.toWellFormed) {
  String.prototype.toWellFormed = function() {
    return this.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  };
  console.log('📝 String.toWellFormed polyfill loaded');
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

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// ===== EXPRESS SERVER =====
const app = express();
const port = process.env.PORT || 3500;

app.get('/', (req, res) => res.json({ 
  status: 'online', 
  uptime: process.uptime(),
  nodeVersion: process.versions.node 
}));

app.get('/health', (req, res) => res.json({ 
  status: 'healthy',
  voiceConnected: !!currentVoiceChannelId,
  memory: process.memoryUsage().heapUsed / 1024 / 1024
}));

app.listen(port, () => {
  console.log(`🌐 Express server running on port ${port}`);
});

// ===== DISCORD CLIENT =====
const client = new Client({
  checkUpdate: false,
  intents: []
});

// ===== CONFIG =====
const serverId = process.env.server;
const voiceChannelId = process.env.id;
const token = process.env.token;

// Validate config
if (!serverId || !voiceChannelId || !token) {
  console.error('❌ Missing environment variables!');
  console.log('Required: server, id, token');
  process.exit(1);
}

// ===== STATE MANAGEMENT =====
let currentVoiceChannelId = null;
let isConnecting = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const cooldown = new Map();

// ===== MEMORY MONITORING =====
setInterval(() => {
  const used = process.memoryUsage();
  console.log(`🧠 Memory Usage: ${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB`);
}, 30000);

// ===== VOICE CONNECTION MANAGEMENT =====
function destroyConnection(guildId) {
  try {
    const old = getVoiceConnection(guildId);
    if (old) {
      old.destroy();
      console.log('🔌 Voice connection destroyed');
    }
  } catch (e) {
    console.error('❌ Error destroying connection:', e.message);
  }
}

async function connectToVoiceChannel() {
  if (isConnecting) {
    console.log('⏳ Already attempting to connect...');
    return;
  }
  
  isConnecting = true;
  
  try {
    const guild = client.guilds.cache.get(serverId);
    if (!guild) {
      console.error('❌ Server not found!');
      return;
    }

    const channel = guild.channels.cache.get(voiceChannelId);
    if (!channel) {
      console.error('❌ Voice channel not found!');
      return;
    }

    if (channel.type !== 'GUILD_VOICE' && channel.type !== 2) {
      console.error('❌ Channel is not a voice channel!');
      return;
    }

    // Check if already connected to this channel
    if (currentVoiceChannelId === channel.id) {
      const existingConn = getVoiceConnection(guild.id);
      if (existingConn && existingConn.state.status !== VoiceConnectionStatus.Destroyed) {
        console.log('✅ Already connected to target channel');
        return;
      }
    }

    // Destroy old connection if exists
    destroyConnection(guild.id);

    // Create new connection
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfMute: true,
      selfDeaf: true
    });

    // Monitor connection state
    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`📢 Successfully connected to: ${channel.name}`);
      currentVoiceChannelId = channel.id;
      reconnectAttempts = 0;
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log('🔌 Disconnected from voice channel');
      currentVoiceChannelId = null;
      
      // Try to reconnect
      try {
        await connection.destroy();
      } catch (e) {}

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        console.log(`🔄 Reconnecting in ${delay/1000}s... (Attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
        reconnectAttempts++;
        setTimeout(() => connectToVoiceChannel(), delay);
      } else {
        console.error('❌ Max reconnection attempts reached');
      }
    });

    connection.on('error', (error) => {
      console.error('❌ Voice connection error:', error.message);
    });

  } catch (err) {
    console.error('❌ Error connecting to voice:', err.message);
  } finally {
    isConnecting = false;
  }
}

// ===== CLIENT EVENTS =====
client.on('ready', async () => {
  console.log(`✅ Logged in as: ${client.user.tag} (${client.user.id})`);
  console.log(`📊 Bot ready at: ${new Date().toLocaleString()}`);
  
  await connectToVoiceChannel();
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    // Ignore updates from other users or servers
    if (!client.user) return;
    if (newState?.member?.id !== client.user.id) return;
    if (newState?.guild?.id !== serverId) return;

    // Disconnected from voice
    if (!newState.channelId && oldState.channelId) {
      console.log('👋 Left voice channel');
      currentVoiceChannelId = null;
      destroyConnection(serverId);
      
      // Schedule reconnect
      setTimeout(() => {
        if (!currentVoiceChannelId) {
          console.log('🔄 Reconnecting to voice...');
          connectToVoiceChannel();
        }
      }, 3000);
    } 
    // Moved to different channel
    else if (newState.channelId !== oldState.channelId) {
      console.log(`🔀 Moved to different voice channel: ${newState.channelId}`);
      if (newState.channelId === voiceChannelId) {
        currentVoiceChannelId = newState.channelId;
      } else if (newState.channelId) {
        // Moved to wrong channel, move back
        await connectToVoiceChannel();
      }
    }
  } catch (err) {
    console.error('❌ voiceStateUpdate error:', err.message);
  }
});

// ===== AUTO REPLY SYSTEM =====
client.on('messageCreate', async (message) => {
  try {
    if (!client.user) return;
    if (message.author.id === client.user.id) return;
    if (!message.guild) return;
    if (message.guild.id !== serverId) return;
    
    if (!message.mentions.users.has(client.user.id)) return;

    const now = Date.now();
    const lastReply = cooldown.get(message.channel.id) || 0;
    if (now - lastReply < 3000) {
      console.log(`⏰ Cooldown active for #${message.channel.name}`);
      return;
    }
    
    cooldown.set(message.channel.id, now);

    // ✅ เพิ่ม timestamp เริ่มต้น
    const startTime = new Date();
    console.log(`[${startTime.toISOString()}] ⏳ Received mention from ${message.author.tag}, waiting 10s...`);

    // รอ 10 วิ ก่อนตอบ
    await new Promise(resolve => setTimeout(resolve, 10000));

    // ✅ เพิ่ม timestamp สิ้นสุด
    const endTime = new Date();
    const diff = (endTime - startTime) / 1000;
    console.log(`[${endTime.toISOString()}] ⏱️ Waited ${diff.toFixed(1)}s, now replying...`);

    // Send reply
    await message.channel.send("yes").catch(e => {
      console.error(`❌ Failed to send message in #${message.channel.name}:`, e.message);
    });

    console.log(`💬 Replied "yes" to ${message.author.tag} in #${message.channel.name}`);

  } catch (err) {
    console.error('❌ Reply error:', err.message);
  }
});

// ===== ERROR LOGGING =====
client.on('error', (error) => {
  console.error('❌ Client error:', error.message);
});

client.on('warn', (warning) => {
  console.warn('⚠️ Warning:', warning);
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  destroyConnection(serverId);
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down gracefully...');
  destroyConnection(serverId);
  client.destroy();
  process.exit(0);
});

// ===== START BOT =====
console.log('🚀 Starting bot...');
client.login(token).catch(err => {
  console.error('❌ Failed to login:', err.message);
  process.exit(1);
});
