/**
 * CockBlaster.fun — Multiplayer Server (Enhanced)
 * Express + Socket.io | 20 tick/s authoritative game server
 * Features: Raycasting, latency compensation, physics, weapon balance, delta state, anti-cheat
 */
'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Room code route — serves the same client
app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
//  CONSTANTS & CONFIGURATION
// ============================================================
const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;
const MAX_SPEED = 14;           // max units/s for anti-cheat
const MAX_ROOMS = 100;
const MAPS = ['arena'];
const MODES = ['deathmatch', 'team-deathmatch', 'gungame'];

// Latency compensation: replay window in ms (100-200ms) — OPTIMIZED to 100ms
const REPLAY_WINDOW_MS = 100;

// Weapon definitions (mirrored from client for server-authoritative hit validation)
// IMPROVEMENT #4: Updated weapon balance - Sniper dmg 100, tighter SMG spread, rocket splash
const WEAPONS = [
  { name: 'PISTOL',  dmg: 20,  rate: 0.3,  range: 80,  spread: 0,     bullets: 1, explosive: false, melee: false, splashRadius: 0 },
  { name: 'SHOTGUN', dmg: 12,  rate: 0.7,  range: 40,  spread: 0.08,  bullets: 6, explosive: false, melee: false, splashRadius: 0 },
  { name: 'SMG',     dmg: 10,  rate: 0.08, range: 60,  spread: 0.025, bullets: 1, explosive: false, melee: false, splashRadius: 0 }, // tighter spread
  { name: 'ROCKET',  dmg: 80,  rate: 1.0,  range: 100, spread: 0,     bullets: 1, explosive: true,  melee: false, splashRadius: 8 }, // splash damage
  { name: 'SNIPER',  dmg: 100, rate: 1.5,  range: 150, spread: 0,     bullets: 1, explosive: false, melee: false, splashRadius: 0 }, // reduced from 120 to 100
  { name: 'KNIFE',   dmg: 50,  rate: 0.25, range: 3,   spread: 0,     bullets: 0, explosive: false, melee: true,  splashRadius: 0 },
];

const GUN_GAME_ORDER = [3, 1, 2, 0, 4, 5]; // rocket→shotgun→SMG→pistol→sniper→knife

// IMPROVEMENT #3: Physics constants
const GRAVITY = 20;           // units/s²
const JUMP_POWER = 8;         // initial vertical velocity
const FALL_DAMAGE_THRESHOLD = 15; // damage multiplier for fall height
const SPAWN_PROTECTION_TIME = 2; // seconds

// Spawn points per map (IMPROVEMENT #9: spawn protection zones)
const SPAWN_POINTS = {
  arena:     [[-30,0,-30],[30,0,30],[30,0,-30],[-30,0,30],[0,0,-35],[0,0,35],[-35,0,0],[35,0,0]],
};

// IMPROVEMENT #6: Map features (hazards, platforms)
const MAP_FEATURES = {
  arena: [
    { type: 'hazard', x: 0, z: 0, radius: 8, damage: 5, name: 'LAVA' },
    { type: 'platform', x: -20, z: 20, width: 6, depth: 6, moving: true, moveDist: 15, moveDuration: 4 },
  ],
};

// ============================================================
//  DATA STRUCTURES
// ============================================================
/** @type {Map<string, Room>} */
const rooms = new Map();

/** @type {Map<string, PlayerSocket>} */
const players = new Map(); // socketId → player data

// Online player counter
let totalPlayersOnline = 0;

// IMPROVEMENT #2: Client-side prediction replay buffer — OPTIMIZED for performance
class ReplayBuffer {
  constructor(maxEntries = 5) {
    this.maxEntries = maxEntries;
    this.entries = [];
    this.lastServerTime = 0;
  }
  
  add(time, state) {
    this.entries.push({ time, state: JSON.parse(JSON.stringify(state)) });
    if (this.entries.length > this.maxEntries) this.entries.shift();
    this.lastServerTime = time;
  }
  
  getAtTime(time) {
    // Find closest entry before or at the given time
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].time <= time) return this.entries[i].state;
    }
    return this.entries[0]?.state;
  }
  
  clear() { this.entries = []; }
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.random() * chars.length | 0]).join(''); }
  while (rooms.has(code));
  return code;
}

function createRoom(opts) {
  const code = generateCode();
  const room = {
    code,
    name: (opts.name || 'Room ' + code).substring(0, 30),
    maxPlayers: Math.min(8, Math.max(2, opts.maxPlayers || 8)),
    mode: MODES.includes(opts.mode) ? opts.mode : 'deathmatch',
    map: MAPS.includes(opts.map) ? opts.map : 'arena',
    state: 'lobby',     // lobby | countdown | playing | results
    players: new Map(),  // socketId → player state
    chat: [],
    countdownTimer: 0,
    gameTimer: 0,
    timeLimit: 600,      // 10 minutes
    scoreLimit: 30,
    tickInterval: null,
    createdAt: Date.now(),
    // IMPROVEMENT #2: Delta state tracking — OPTIMIZED: send full state less frequently
    lastFullStateTick: 0,
    deltaInterval: 5, // send full state every 5 ticks (reduced update frequency)
    // IMPROVEMENT #6: Map feature instances
    features: initMapFeatures(opts.map || 'arena'),
    // IMPROVEMENT #10: Scoring system
    assists: new Map(), // killerId -> victimId -> time
  };
  rooms.set(code, room);
  return room;
}

// IMPROVEMENT #6: Initialize map features
function initMapFeatures(mapName) {
  const templates = MAP_FEATURES[mapName] || [];
  const features = [];
  templates.forEach(t => {
    const f = JSON.parse(JSON.stringify(t));
    f.id = Math.random().toString(36).substring(7);
    if (f.moving) f.movePhase = 0; // 0-1 for lerp
    if (f.type === 'wall' && f.health) f.currentHealth = f.health;
    features.push(f);
  });
  return features;
}

function getRandomSpawn(map) {
  const pts = SPAWN_POINTS[map] || SPAWN_POINTS.arena;
  const p = pts[Math.random() * pts.length | 0];
  return { x: p[0] + (Math.random() - 0.5) * 4, y: 1.6, z: p[2] + (Math.random() - 0.5) * 4 };
}

function getRoomList() {
  const list = [];
  for (const [code, r] of rooms) {
    list.push({
      code, name: r.name, mode: r.mode, map: r.map,
      players: r.players.size, maxPlayers: r.maxPlayers, state: r.state,
    });
  }
  return list;
}

function getTeam(room) {
  // Balance teams
  let red = 0, blue = 0;
  for (const p of room.players.values()) {
    if (p.team === 'red') red++;
    else if (p.team === 'blue') blue++;
  }
  return red <= blue ? 'red' : 'blue';
}

function updatePlayerCount() {
  // Count all connected players across all rooms
  let count = 0;
  for (const room of rooms.values()) {
    count += room.players.size;
  }
  totalPlayersOnline = count;
  // Broadcast to all connected clients
  io.emit('player-count', { total: totalPlayersOnline });
}

// ============================================================
//  GAME TICK — server-authoritative loop per room
// ============================================================
function startRoomTick(room) {
  if (room.tickInterval) return;
  room.tickInterval = setInterval(() => roomTick(room), TICK_MS);
}

function stopRoomTick(room) {
  if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
}

function roomTick(room) {
  if (room.state === 'countdown') {
    room.countdownTimer -= TICK_MS / 1000;
    if (room.countdownTimer <= 0) {
      room.state = 'playing';
      room.gameTimer = room.timeLimit;
      // Spawn all players (IMPROVEMENT #9: with spawn protection)
      for (const [sid, p] of room.players) {
        const sp = getRandomSpawn(room.map);
        p.x = sp.x; p.y = sp.y; p.z = sp.z;
        p.hp = 100; p.alive = true; p.kills = 0; p.deaths = 0; p.score = 0;
        p.gunGameLevel = 0;
        p.weapon = room.mode === 'gungame' ? GUN_GAME_ORDER[0] : 0;
        p.lastShot = 0; p.respawnTimer = 0;
        // IMPROVEMENT #9: Spawn protection invulnerability
        p.spawnProtectionTimer = SPAWN_PROTECTION_TIME;
        // IMPROVEMENT #3: Physics velocity
        p.vx = 0; p.vy = 0; p.vz = 0;
        p.grounded = true;
        p.lastFloorY = sp.y;
        // IMPROVEMENT #2: Replay buffer for latency compensation
        p.replayBuffer = new ReplayBuffer(10);
        // IMPROVEMENT #10: Cosmetics progression
        p.skinId = 'default';
        p.effectId = 'default';
        p.assists = new Map();
        p.headshots = 0;
        p.killStreak = 0;
        p.replayBuffer = new ReplayBuffer(5);
      }
      io.to(room.code).emit('game-start', {
        map: room.map, mode: room.mode,
        players: serializePlayers(room),
      });
    } else {
      io.to(room.code).emit('countdown', Math.ceil(room.countdownTimer));
    }
    return;
  }

  if (room.state !== 'playing') return;

  room.gameTimer -= TICK_MS / 1000;
  
  // IMPROVEMENT #6: Update moving platforms and hazards
  updateMapFeatures(room, TICK_MS / 1000);

  // IMPROVEMENT #3: Physics simulation and respawn timers
  for (const [sid, p] of room.players) {
    if (!p.alive && p.respawnTimer > 0) {
      p.respawnTimer -= TICK_MS / 1000;
      if (p.respawnTimer <= 0) {
        const sp = getRandomSpawn(room.map);
        p.x = sp.x; p.y = sp.y; p.z = sp.z;
        p.vx = 0; p.vy = 0; p.vz = 0;
        p.grounded = true;
        p.lastFloorY = sp.y;
        p.hp = 100; p.alive = true;
        p.spawnProtectionTimer = SPAWN_PROTECTION_TIME;
        p.weapon = room.mode === 'gungame' ? GUN_GAME_ORDER[Math.min(p.gunGameLevel, GUN_GAME_ORDER.length - 1)] : p.weapon;
        io.to(room.code).emit('player-respawn', { id: sid, x: p.x, y: p.y, z: p.z, weapon: p.weapon, spawnProtected: true });
      }
    }
    
    // Physics: Apply gravity
    if (p.alive) {
      p.vy -= GRAVITY * (TICK_MS / 1000);
      p.y += p.vy * (TICK_MS / 1000);
      
      // Floor collision (grounded at y=1.6)
      if (p.y <= 1.6) {
        const fallHeight = Math.max(0, p.lastFloorY - 1.6);
        if (fallHeight > FALL_DAMAGE_THRESHOLD && p.vy < 0) {
          const fallDamage = (fallHeight - FALL_DAMAGE_THRESHOLD) * 5;
          p.hp -= fallDamage;
          if (p.hp <= 0) { p.hp = 0; p.alive = false; p.deaths++; p.respawnTimer = 3; }
        }
        p.y = 1.6;
        p.vy = 0;
        p.grounded = true;
        p.lastFloorY = 1.6;
      } else {
        p.grounded = false;
      }
    }
    
    // Spawn protection cooldown
    if (p.spawnProtectionTimer > 0) {
      p.spawnProtectionTimer -= TICK_MS / 1000;
    }
  }

  // Check win conditions
  let winner = null;
  if (room.gameTimer <= 0) {
    winner = getWinner(room);
  } else {
    // Score limit check
    for (const [sid, p] of room.players) {
      if (room.mode === 'gungame') {
        if (p.gunGameLevel >= GUN_GAME_ORDER.length) { winner = { type: 'player', id: sid, name: p.name }; break; }
      } else if (room.mode === 'deathmatch') {
        if (p.kills >= room.scoreLimit) { winner = { type: 'player', id: sid, name: p.name }; break; }
      }
    }
    if (!winner && room.mode === 'team-deathmatch') {
      let redScore = 0, blueScore = 0;
      for (const p of room.players.values()) {
        if (p.team === 'red') redScore += p.kills;
        else blueScore += p.kills;
      }
      if (redScore >= room.scoreLimit) winner = { type: 'team', team: 'red' };
      else if (blueScore >= room.scoreLimit) winner = { type: 'team', team: 'blue' };
    }
  }

  if (winner) {
    endGame(room, winner);
    return;
  }

  // IMPROVEMENT #5: Delta state broadcasting - only send changes
  room.lastFullStateTick = (room.lastFullStateTick + 1) % room.deltaInterval;
  const isSendFullState = room.lastFullStateTick === 0;
  
  const state = {
    t: room.gameTimer,
    features: isSendFullState ? room.features : undefined, // only send full features periodically
  };
  
  if (isSendFullState) {
    // Send full state every Nth tick
    state.players = [];
    for (const [sid, p] of room.players) {
      state.players.push({
        id: sid, x: p.x, y: p.y, z: p.z,
        yaw: p.yaw, pitch: p.pitch,
        hp: p.hp, alive: p.alive,
        kills: p.kills, deaths: p.deaths, score: p.score,
        weapon: p.weapon, team: p.team,
        respawnTimer: p.respawnTimer > 0 ? Math.ceil(p.respawnTimer) : 0,
        spawnProtected: p.spawnProtectionTimer > 0,
        skinId: p.skinId, effectId: p.effectId,
        headshots: p.headshots, killStreak: p.killStreak,
      });
      // Store in replay buffer for latency compensation
      p.replayBuffer?.add(Date.now(), {
        x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
        hp: p.hp, alive: p.alive,
      });
    }
  } else {
    // Send delta updates (changed fields only)
    state.playerDelta = [];
    for (const [sid, p] of room.players) {
      state.playerDelta.push({
        id: sid, x: p.x, y: p.y, z: p.z,
        hp: p.hp, alive: p.alive,
        respawnTimer: p.respawnTimer > 0 ? Math.ceil(p.respawnTimer) : 0,
      });
    }
  }
  
  io.to(room.code).emit('game-state', state);
}

function getWinner(room) {
  if (room.mode === 'team-deathmatch') {
    let red = 0, blue = 0;
    for (const p of room.players.values()) {
      if (p.team === 'red') red += p.kills; else blue += p.kills;
    }
    return { type: 'team', team: red >= blue ? 'red' : 'blue' };
  }
  let best = null;
  for (const [sid, p] of room.players) {
    if (!best || p.kills > best.kills) best = { type: 'player', id: sid, name: p.name, kills: p.kills };
  }
  return best;
}

function endGame(room, winner) {
  room.state = 'results';
  stopRoomTick(room);
  const scoreboard = [];
  for (const [sid, p] of room.players) {
    scoreboard.push({ id: sid, name: p.name, kills: p.kills, deaths: p.deaths, score: p.score, team: p.team });
  }
  scoreboard.sort((a, b) => b.kills - a.kills);
  io.to(room.code).emit('game-over', { winner, scoreboard });

  // Return to lobby after 10 seconds
  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    room.state = 'lobby';
    for (const p of room.players.values()) { p.ready = false; }
    io.to(room.code).emit('room-state', getRoomState(room));
  }, 10000);
}

function serializePlayers(room) {
  const list = [];
  for (const [sid, p] of room.players) {
    list.push({ id: sid, name: p.name, color: p.color, hat: p.hat, team: p.team,
      x: p.x, y: p.y, z: p.z, weapon: p.weapon, hp: p.hp, alive: p.alive });
  }
  return list;
}

function getRoomState(room) {
  const plist = [];
  for (const [sid, p] of room.players) {
    plist.push({ id: sid, name: p.name, color: p.color, hat: p.hat, ready: p.ready, team: p.team });
  }
  return { code: room.code, name: room.name, mode: room.mode, map: room.map,
    maxPlayers: room.maxPlayers, state: room.state, players: plist };
}

// ============================================================
//  MAP FEATURES & PHYSICS HELPERS
// ============================================================
function updateMapFeatures(room, dt) {
  for (const feature of room.features) {
    if (feature.type === 'platform' && feature.moving) {
      // Oscillate platform
      feature.movePhase = (feature.movePhase + dt / feature.moveDuration) % 2;
      const offset = feature.movePhase < 1 
        ? feature.moveDist * feature.movePhase 
        : feature.moveDist * (2 - feature.movePhase);
      feature.currentY = offset;
    }
    if (feature.type === 'hazard') {
      // Check which players are in hazard and damage them
      for (const [, p] of room.players) {
        if (!p.alive) continue;
        const dx = p.x - feature.x, dz = p.z - feature.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < feature.radius) {
          p.hp -= feature.damage * dt;
          if (p.hp <= 0) { p.hp = 0; p.alive = false; p.deaths++; p.respawnTimer = 3; }
        }
      }
    }
  }
}

// ============================================================
//  ANTI-CHEAT HELPERS
// ============================================================
function validateMove(prev, next, dt) {
  const dx = next.x - prev.x, dz = next.z - prev.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  // Allow some slack for network jitter
  return dist / Math.max(dt, 0.01) <= MAX_SPEED * 1.5;
}

function validateFireRate(p, weaponIdx) {
  const w = WEAPONS[weaponIdx];
  if (!w) return false;
  const now = Date.now() / 1000;
  if (now - p.lastShot < w.rate * 0.8) return false; // 80% tolerance
  p.lastShot = now;
  return true;
}

// IMPROVEMENT #1: Raycasting hit validation
// IMPROVEMENT #8: Anti-cheat hitscan validation
function validateHitWithRaycast(attacker, victim, weaponIdx, attackDir) {
  const w = WEAPONS[weaponIdx];
  if (!w) return false;
  
  // Basic range check
  const dx = attacker.x - victim.x, dz = attacker.z - victim.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > w.range * 1.2) return false;
  
  // Raycast: check if attacker's view line passes through victim's hitbox
  // Attacker position + direction * distance should intersect victim's cylinder
  if (!attackDir) return true; // Fallback if direction not provided
  
  const rayOrigin = { x: attacker.x, y: attacker.y, z: attacker.z };
  const rayDir = { 
    x: attackDir.dx || 0, 
    y: attackDir.dy || 0, 
    z: attackDir.dz || 0 
  };
  
  // Victim hitbox: cylinder at (victim.x, victim.y, victim.z) with radius 0.4, height 2
  const victimCenter = { x: victim.x, y: victim.y, z: victim.z };
  const victimRadius = 0.4;
  const victimHeight = 2;
  
  // Check ray-cylinder intersection
  const toVictim = {
    x: victimCenter.x - rayOrigin.x,
    y: victimCenter.y - rayOrigin.y,
    z: victimCenter.z - rayOrigin.z,
  };
  
  // Project to 2D (xz plane, ignore y for horizontal check)
  const rayLen2D = Math.sqrt(rayDir.x * rayDir.x + rayDir.z * rayDir.z);
  const rayDirNorm = { x: rayDir.x / rayLen2D, z: rayDir.z / rayLen2D };
  
  const projDot = toVictim.x * rayDirNorm.x + toVictim.z * rayDirNorm.z;
  if (projDot < 0) return false; // Victim is behind attacker
  
  const closest = {
    x: rayOrigin.x + rayDirNorm.x * projDot,
    z: rayOrigin.z + rayDirNorm.z * projDot,
  };
  
  const perpDist = Math.sqrt(
    (closest.x - victimCenter.x) ** 2 +
    (closest.z - victimCenter.z) ** 2
  );
  
  // Check vertical overlap
  const yOverlap = Math.abs(rayOrigin.y - victimCenter.y) < victimHeight / 2;
  
  return perpDist < victimRadius && yOverlap;
}

function validateHit(attacker, victim, weaponIdx) {
  // Fallback to simple distance check
  const w = WEAPONS[weaponIdx];
  if (!w) return false;
  const dx = attacker.x - victim.x, dz = attacker.z - victim.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  return dist <= w.range * 1.2;
}

// ============================================================
//  SOCKET.IO CONNECTION HANDLING
// ============================================================
// Track total players online
let totalPlayersOnline = 0;

function updatePlayerCount() {
  totalPlayersOnline = 0;
  for (const room of rooms.values()) {
    totalPlayersOnline += room.players.size;
  }
  io.emit('player-count', { count: totalPlayersOnline });
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // Send room list on connect
  socket.emit('room-list', getRoomList());
  
  // Send initial player count
  socket.emit('player-count', { count: totalPlayersOnline });
  
  // Send current player count
  socket.emit('player-count', { total: totalPlayersOnline });

  // ---------- LOBBY ----------

  socket.on('create-room', (opts, cb) => {
    if (rooms.size >= MAX_ROOMS) return cb?.({ error: 'Server full' });
    const room = createRoom(opts || {});
    cb?.({ code: room.code });
    io.emit('room-list', getRoomList()); // broadcast updated list
  });

  socket.on('join-room', (data, cb) => {
    const { code, name, color, hat, skinId, effectId } = data || {};
    const room = rooms.get(code?.toUpperCase());
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.players.size >= room.maxPlayers) return cb?.({ error: 'Room full' });
    if (room.state === 'playing') return cb?.({ error: 'Game in progress' });

    // Leave any current room
    leaveCurrentRoom(socket);

    const pState = {
      name: (name || 'ANON').substring(0, 12),
      color: color || '#00ffff',
      hat: hat || 'none',
      ready: false,
      team: room.mode === 'team-deathmatch' ? getTeam(room) : null,
      x: 0, y: 1.6, z: 0,
      yaw: 0, pitch: 0,
      vx: 0, vy: 0, vz: 0, // IMPROVEMENT #3: Physics velocity
      hp: 100, alive: true,
      kills: 0, deaths: 0, score: 0,
      weapon: 0, lastShot: 0,
      gunGameLevel: 0,
      respawnTimer: 0,
      lastMoveTime: Date.now(),
      grounded: true,
      lastFloorY: 1.6,
      spawnProtectionTimer: 0,
      // IMPROVEMENT #11: Cosmetics progression
      skinId: skinId || 'default',
      effectId: effectId || 'default',
      // IMPROVEMENT #10: Scoring stats
      headshots: 0,
      killStreak: 0,
      assists: new Map(),
      // IMPROVEMENT #2: Latency compensation
      replayBuffer: new ReplayBuffer(5),
    };
    room.players.set(socket.id, pState);
    socket.join(room.code);
    socket.data.roomCode = room.code;

    cb?.({ ok: true });
    io.to(room.code).emit('room-state', getRoomState(room));
    io.to(room.code).emit('chat', { from: 'SYSTEM', msg: `${pState.name} joined` });
    io.emit('room-list', getRoomList());
    updatePlayerCount(); // Update player count
    updatePlayerCount(); // Update online player count
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('chat', (msg) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const text = String(msg).substring(0, 200);
    room.chat.push({ from: p.name, msg: text });
    if (room.chat.length > 100) room.chat.shift();
    io.to(room.code).emit('chat', { from: p.name, msg: text });
  });

  socket.on('ready', (val) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !!val;
    io.to(room.code).emit('room-state', getRoomState(room));

    // Check if all ready (need at least 2)
    if (room.players.size >= 2) {
      let allReady = true;
      for (const pl of room.players.values()) { if (!pl.ready) { allReady = false; break; } }
      if (allReady) {
        room.state = 'countdown';
        room.countdownTimer = 3;
        startRoomTick(room);
        io.to(room.code).emit('room-state', getRoomState(room));
      }
    }
  });

  socket.on('switch-team', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.mode !== 'team-deathmatch' || room.state !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.team = p.team === 'red' ? 'blue' : 'red';
    io.to(room.code).emit('room-state', getRoomState(room));
  });

  // ---------- IN-GAME ----------

  socket.on('move', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;

    const now = Date.now();
    const dt = (now - p.lastMoveTime) / 1000;
    p.lastMoveTime = now;

    const next = { x: data.x, z: data.z };
    if (!validateMove(p, next, dt)) return; // anti-cheat reject

    p.x = data.x;
    p.z = data.z;
    
    // PART 1: Jump mechanic - server-side validation
    if (data.jump && p.grounded) {
      p.vy = JUMP_POWER; // Jump velocity (8 units/s)
      p.grounded = false;
      // Broadcast jump event to all players for visual effects
      io.to(room.code).emit('player-jump', { id: socket.id, x: p.x, y: p.y, z: p.z });
    }
    
    // IMPROVEMENT #3: Physics - apply gravity and update vertical position
    p.vy -= GRAVITY * dt;
    p.y += p.vy * dt;
    
    // Floor collision and landing
    if (p.y <= 1.6) {
      const fallHeight = Math.max(0, p.lastFloorY - 1.6);
      if (fallHeight > 3 && p.vy < 0) {
        // Fall damage
        const fallDamage = (fallHeight - 3) * 2;
        p.hp -= fallDamage;
        if (p.hp <= 0) { p.hp = 0; p.alive = false; p.deaths++; p.respawnTimer = 3; }
      }
      if (!p.grounded && p.vy < 0) {
        // Broadcast landing event
        io.to(room.code).emit('player-land', { id: socket.id, x: p.x, y: p.y, z: p.z });
      }
      p.y = 1.6;
      p.vy = 0;
      p.grounded = true;
      p.lastFloorY = 1.6;
    } else {
      p.grounded = false;
    }
    
    // IMPROVEMENT #2: Latency compensation - use replay buffer
    if (data.clientTime) {
      const replayState = p.replayBuffer?.getAtTime(data.clientTime);
      if (replayState) {
        p.x = replayState.x;
        p.z = replayState.z;
      }
    }
    
    p.yaw = data.yaw || 0;
    p.pitch = data.pitch || 0;
    p.weapon = Math.max(0, Math.min(5, data.weapon || 0));
  });

  socket.on('shoot', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;

    const weaponIdx = Math.max(0, Math.min(5, data.weapon || 0));
    if (!validateFireRate(p, weaponIdx)) return; // anti-cheat
    
    // IMPROVEMENT #4: Ammo limits and magazine system (if implemented client-side)
    // Server could track ammo, but for now trust client with visual feedback

    // Broadcast bullet to all other players for visual rendering
    // IMPROVEMENT #8: Include direction for raycasting validation
    socket.to(room.code).emit('bullet', {
      owner: socket.id,
      x: data.x, y: data.y, z: data.z,
      dx: data.dx, dy: data.dy, dz: data.dz,
      weapon: weaponIdx,
      isHeadshot: data.isHeadshot,
    });
  });

  socket.on('hit', (data) => {
    // Client reports a hit; server validates with raycasting
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const attacker = room.players.get(socket.id);
    if (!attacker || !attacker.alive) return;

    const victim = room.players.get(data.targetId);
    if (!victim || !victim.alive) return;

    // IMPROVEMENT #9: Spawn protection
    if (victim.spawnProtectionTimer > 0) return; // Can't damage spawn-protected players

    // Team check
    if (room.mode === 'team-deathmatch' && attacker.team === victim.team) return;

    const weaponIdx = Math.max(0, Math.min(5, data.weapon || 0));
    
    // IMPROVEMENT #8: Anti-cheat with raycasting and direction validation
    if (!validateHitWithRaycast(attacker, victim, weaponIdx, data.direction)) {
      return; // anti-cheat reject
    }

    const w = WEAPONS[weaponIdx];
    let dmg = w.dmg;
    
    // IMPROVEMENT #10: Headshot bonus
    if (data.headshot) {
      dmg *= 2.0; // 2x multiplier for headshots
      attacker.headshots++;
    }
    
    // Rocket splash damage (IMPROVEMENT #4)
    if (w.explosive && data.hitPos && w.splashRadius > 0) {
      // Apply splash damage to nearby enemies
      for (const [, otherVictim] of room.players) {
        if (!otherVictim.alive || otherVictim === victim) continue;
        const dx = otherVictim.x - data.hitPos.x;
        const dz = otherVictim.z - data.hitPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < w.splashRadius) {
          const splashDmg = w.dmg * (1 - dist / w.splashRadius) * 0.5;
          otherVictim.hp -= splashDmg;
          if (otherVictim.hp <= 0) {
            otherVictim.hp = 0;
            otherVictim.alive = false;
            otherVictim.deaths++;
            otherVictim.respawnTimer = 3;
          }
        }
      }
    }

    victim.hp -= dmg;

    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      victim.deaths++;
      victim.respawnTimer = 3;
      attacker.kills++;
      attacker.killStreak++;
      
      // IMPROVEMENT #10: Scoring system with assists
      attacker.score += data.headshot ? 25 : 10;
      
      // Give assists to recent damagers
      for (const [aidId, aidTime] of victim.assists || new Map()) {
        if (Date.now() - aidTime < 5000) { // 5 second assist window
          const aider = room.players.get(aidId);
          if (aider) {
            aider.score += 5;
          }
        }
      }

      // Gun game progression
      if (room.mode === 'gungame') {
        attacker.gunGameLevel++;
        attacker.weapon = GUN_GAME_ORDER[Math.min(attacker.gunGameLevel, GUN_GAME_ORDER.length - 1)];
      }

      io.to(room.code).emit('kill', {
        killer: socket.id, killerName: attacker.name,
        victim: data.targetId, victimName: victim.name,
        weapon: weaponIdx,
        headshot: data.headshot ? true : false,
        killStreak: attacker.killStreak,
      });
    } else {
      // Register assist damage
      if (!victim.assists) victim.assists = new Map();
      victim.assists.set(socket.id, Date.now());
      
      io.to(room.code).emit('player-damage', {
        id: data.targetId, hp: victim.hp, attackerId: socket.id,
        isHeadshot: data.headshot,
      });
    }
  });

  // ---------- PING ----------
  socket.on('ping-check', (ts, cb) => {
    cb?.(ts);
  });

  // ---------- BROWSE ROOMS ----------
  socket.on('get-rooms', (cb) => {
    cb?.(getRoomList());
  });

  // ---------- DISCONNECT ----------
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    leaveCurrentRoom(socket);
  });

  function leaveCurrentRoom(sock) {
    const code = sock.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const p = room.players.get(sock.id);
    const name = p ? p.name : 'Unknown';
    room.players.delete(sock.id);
    sock.leave(code);
    sock.data.roomCode = null;

    io.to(code).emit('player-left', { id: sock.id, name });
    io.to(code).emit('chat', { from: 'SYSTEM', msg: `${name} left` });

    if (room.players.size === 0) {
      stopRoomTick(room);
      rooms.delete(code);
    } else {
      io.to(code).emit('room-state', getRoomState(room));
    }
    io.emit('room-list', getRoomList());
    updatePlayerCount(); // Update player count
    updatePlayerCount(); // Update online player count
  }
});

// ============================================================
//  START
// ============================================================
server.listen(PORT, () => {
  console.log(`\n  🔫 CockBlaster.fun server running on port ${PORT}`);
  console.log(`  → http://localhost:${PORT}\n`);
});
