const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(__dirname)); // Serve static files from current directory

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- Game Constants & Config ---
const TAU = Math.PI * 2;
const FRICTION = 0.9;
const ACCEL = 0.85;
const PLAYER_RADIUS = 25;
const BOUNDS = { width: 1600, height: 1200 };

const DROP_CHANCE = 0.3; // 30% drop chance

const ENEMY_COLORS = {
    basic: { head: '#e74c3c', body: '#c0392b' },
    hefty: { head: '#f1c40f', body: '#7f8c8d' },
    mage: { head: '#9b59b6', body: '#8e44ad', hat: '#5b2c6f' },
    purple: { head: '#8e44ad', body: '#4a235a' },
    bossW10: { head: '#c0392b', body: '#922b21' },
    bossW20: { head: '#e74c3c', body: '#21618c', visor: '#e74c3c' },
    laserBoss: { head: '#2c3e50', body: '#000000', visor: '#ff0000' }
};

const WEAPONS = {
    pistol: { name: 'Pistol', fireRate: 15, speed: 18, damage: 30, shake: 2, type: 'standard', count: 1, spread: 0 },
    shotgun: { name: 'Shotgun', fireRate: 55, speed: 20, damage: 25, shake: 15, type: 'standard', count: 6, spread: 0.45 },
    minigun: { name: 'Minigun', fireRate: 5, speed: 22, damage: 15, shake: 3, type: 'standard', count: 1, spread: 0.12 },
    sniper: { name: 'Sniper Rifle', fireRate: 75, speed: 55, damage: 300, shake: 25, type: 'pierce', count: 1, spread: 0, laser: true },
    rpg: { name: 'RPG', fireRate: 85, speed: 18, damage: 0, shake: 20, type: 'explosive', blastRadius: 260, blastDamage: 300, particleColor: '#e74c3c' },
    grenade: { name: 'Grenade Lnch', fireRate: 45, speed: 17, damage: 0, shake: 10, type: 'explosive', blastRadius: 200, blastDamage: 180, particleColor: '#2ecc71' },
    laser: { name: 'Laser Gun', fireRate: 6, speed: 0, damage: 12, shake: 1, type: 'ray', count: 1, spread: 0 }
};

const BUFFS = [
    { id: 'dmg', name: 'Brute Force', desc: 'Damage +25%', color: 'text-red-500', icon: '⚡', apply: (s) => s.damageMult += 0.25 },
    { id: 'spd', name: 'Agility', desc: 'Move Speed +15%', color: 'text-yellow-400', icon: '👟', apply: (s) => s.speedMult += 0.15 },
    { id: 'hp', name: 'Vitality', desc: 'Max HP +50', color: 'text-green-400', icon: '❤️', apply: (s) => s.hpAdd += 50 },
    { id: 'armor', name: 'Iron Skin', desc: 'Defense +15% & Armor', color: 'text-blue-400', icon: '🛡️', apply: (s) => { s.armor += 0.15; s.hasArmor = true; } },
    { id: 'chaos', name: 'Chaos Charm', desc: 'Enemies turn traitor', color: 'text-purple-500', icon: '🌀', apply: (s) => { s.hasChaos = true; } }
];

// --- Utilities ---
const randomRange = (min, max) => Math.random() * (max - min) + min;
const checkCircleCollision = (c1, c2) => Math.hypot(c1.x - c2.x, c1.y - c2.y) < c1.radius + c2.radius;
const generateRoomId = () => Math.random().toString(36).substring(2, 6).toUpperCase();

// --- State Management ---
const rooms = {}; // { roomId: { gameState, players: {}, lastUpdate: number } }

class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = {}; // socketId -> player object
        this.gameState = {
            active: false,
            wave: 1,
            waveState: 'INTERMISSION',
            waveTimer: 600, // 10 seconds @ 60fps
            waveBatches: [],
            spawnTimer: 0,
            score: 0,
            enemies: [],
            bullets: [],
            pickups: [],
            explosions: [], // transient, for sending to client
            floatingTexts: [], // transient
            warningZones: [],
            timeScale: 1
        };
        this.loopInterval = null;
    }

    addPlayer(socketId) {
        // Player spawn logic
        this.players[socketId] = {
            id: socketId,
            x: 800 + (Math.random() * 100 - 50),
            y: 600 + (Math.random() * 100 - 50),
            vx: 0, vy: 0,
            angle: 0,
            radius: PLAYER_RADIUS,
            hp: 100,
            maxHp: 100,
            weapon: 'pistol',
            cooldown: 0,
            dead: false,
            stats: { damageMult: 1, speedMult: 1, hpAdd: 0, armor: 0 },
            color: { head: '#E6C87C', body: '#4FB5C6' } // Default colors, can randomize later
        };
    }

    removePlayer(socketId) {
        delete this.players[socketId];
        // If room empty, destroy room (handled in socket disconnect)
    }

    startGame() {
        this.gameState.active = true;
        this.gameState.wave = 1;
        this.gameState.score = 0;
        this.gameState.enemies = [];
        this.gameState.bullets = [];
        this.gameState.waveState = 'INTERMISSION';
        this.gameState.waveTimer = 300; // 5s start delay

        // Reset players
        Object.values(this.players).forEach(p => {
            p.hp = p.maxHp;
            p.dead = false;
            p.x = 800; p.y = 600;
            p.stats = { damageMult: 1, speedMult: 1, hpAdd: 0, armor: 0, hasArmor: false, hasChaos: false };
            p.weapon = 'pistol';
        });

        if (!this.loopInterval) {
            this.loopInterval = setInterval(() => this.update(), 1000 / 60);
        }
    }

    spawnEnemy(type) {
        let x, y;
        // Simple spawn logic: maintain distance from first player found (or center)
        const pIds = Object.keys(this.players);
        const refP = pIds.length > 0 ? this.players[pIds[0]] : { x: 800, y: 600 };

        if (type.includes('boss')) { x = 800; y = 600; }
        else {
            do { x = randomRange(100, 1500); y = randomRange(100, 1100); }
            while (Math.hypot(x - refP.x, y - refP.y) < 400);
        }

        let scale = 1;
        if (this.gameState.wave > 10) scale = 1.5 + (this.gameState.wave - 10) * 0.1;

        let conf = {};
        if (type === 'bossW10') conf = { hp: 15000, speed: 2, radius: 80, score: 5000, color: ENEMY_COLORS.bossW10, maxHp: 15000 };
        else if (type === 'bossW20') conf = { hp: 25000, speed: 1.2, radius: 90, score: 8000, color: ENEMY_COLORS.bossW20, maxHp: 25000 };
        else if (type === 'mage') conf = { hp: 120 * scale, speed: 1.5, radius: 30, score: 500, color: ENEMY_COLORS.mage };
        else if (type === 'purple') conf = { hp: 800 * scale, speed: 1.0, radius: 45, score: 400, color: ENEMY_COLORS.purple };
        else if (type === 'hefty') conf = { hp: 200 * scale, speed: 1.8, radius: 35, score: 300, color: ENEMY_COLORS.hefty };
        else conf = { hp: 60 * scale, speed: 3.0 + (scale - 1), radius: 25, score: 100, color: ENEMY_COLORS.basic };

        this.gameState.enemies.push({
            id: Math.random().toString(36).substr(2, 9),
            x, y, vx: 0, vy: 0, ...conf, type, angle: 0,
            state: 'CHASE', stateTimer: 0, traitorTimer: 0
        });
    }

    spawnBatch(count) {
        const w = this.gameState.wave;

        if (w === 10 && count === 1) { this.spawnEnemy('bossW10'); return; }
        if (w === 20 && count === 1) { this.spawnEnemy('bossW20'); return; }

        for (let i = 0; i < count; i++) {
            // Wave 20+: Mix all
            if (w > 20) {
                const r = Math.random();
                if (r < 0.1) this.spawnEnemy('mage');
                else if (r < 0.3) this.spawnEnemy('purple');
                else if (r < 0.6) this.spawnEnemy('hefty');
                else this.spawnEnemy('basic');
            }
            // Wave 10-20: Add Purple
            else if (w > 10) {
                const r = Math.random();
                if (w % 5 === 0 && i === 0) this.spawnEnemy('mage'); // Mage periodic
                else if (r < 0.3) this.spawnEnemy('purple');
                else if (r < 0.6) this.spawnEnemy('hefty');
                else this.spawnEnemy('basic');
            }
            // Wave 1-10
            else {
                if (w % 5 === 0 && i === 0) this.spawnEnemy('mage');
                else if (w >= 3 && Math.random() > 0.7) this.spawnEnemy('hefty');
                else this.spawnEnemy('basic');
            }
        }
    }

    update() {
        if (!this.gameState.active) return;
        const dt = this.gameState.timeScale;

        // -- Wave Logic --
        if (this.gameState.waveState === 'INTERMISSION') {
            this.gameState.waveTimer -= dt;
            if (this.gameState.waveTimer <= 0) {
                this.gameState.waveState = 'FIGHTING';
                this.gameState.spawnTimer = 0;
                const total = 4 + Math.floor(this.gameState.wave * 1.5);
                this.gameState.waveBatches = [];
                let remaining = total;
                while (remaining > 0) {
                    const batch = Math.min(remaining, 5);
                    this.gameState.waveBatches.push(batch);
                    remaining -= batch;
                }
                if (this.gameState.wave === 10 || this.gameState.wave === 20) this.gameState.waveBatches = [1];

                io.to(this.roomId).emit('sfx', 'wave');
            }
        } else if (this.gameState.waveState === 'FIGHTING') {
            if (this.gameState.enemies.length === 0) {
                if (this.gameState.spawnTimer > 0) this.gameState.spawnTimer -= dt;
                else if (this.gameState.waveBatches.length > 0) {
                    this.spawnBatch(this.gameState.waveBatches.shift());
                    this.gameState.spawnTimer = 120;
                } else {
                    this.gameState.waveState = 'INTERMISSION';
                    this.gameState.waveTimer = 600;
                    this.gameState.wave++;
                    Object.values(this.players).forEach(p => { if (!p.dead) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.25); });
                }
            }
        }

        // -- Player Updates --
        let allDead = true;
        Object.values(this.players).forEach(p => {
            if (p.dead) return;
            allDead = false;
            p.timeSinceLastInput = (p.timeSinceLastInput || 0) + 1;
            p.vx *= FRICTION; p.vy *= FRICTION;
            p.x += p.vx * dt; p.y += p.vy * dt;
            p.x = Math.max(p.radius, Math.min(BOUNDS.width - p.radius, p.x));
            p.y = Math.max(p.radius, Math.min(BOUNDS.height - p.radius, p.y));

            if (p.cooldown > 0) p.cooldown -= dt;
            if (p.shooting && p.cooldown <= 0) {
                const w = WEAPONS[p.weapon];
                p.cooldown = w.fireRate;
                p.vx -= Math.cos(p.angle) * (5 + w.shake / 2);
                p.vy -= Math.sin(p.angle) * (5 + w.shake / 2);
                io.to(this.roomId).emit('sfx', 'shoot');

                if (w.type === 'ray') {
                    // Instant Hit Scan (simplified for now: create a short lived bullet or ray object)
                    this.gameState.bullets.push({
                        x: p.x, y: p.y, angle: p.angle,
                        owner: p.id, life: 5, type: 'ray', damage: w.damage
                    });
                } else {
                    for (let i = 0; i < (w.count || 1); i++) {
                        const a = p.angle + (Math.random() - 0.5) * (w.spread || 0);
                        this.gameState.bullets.push({
                            x: p.x + Math.cos(p.angle) * 40, y: p.y + Math.sin(p.angle) * 40,
                            vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed, angle: a,
                            owner: p.id, life: 100, ...w
                        });
                    }
                }
            }

            // Chaos Charm Logic
            if (p.stats.hasChaos && Math.random() < 0.01) {
                const targets = this.gameState.enemies.filter(e => Math.hypot(e.x - p.x, e.y - p.y) < 300);
                if (targets.length > 0) {
                    const t = targets[Math.floor(Math.random() * targets.length)];
                    t.traitorTimer = 300;
                    io.to(this.roomId).emit('vfx', { type: 'dummy', x: t.x, y: t.y, color: '#purple' });
                }
            }

            for (let i = this.gameState.pickups.length - 1; i >= 0; i--) {
                const pu = this.gameState.pickups[i];
                if (Math.hypot(p.x - pu.x, p.y - pu.y) < p.radius + pu.radius + 15) {
                    if (pu.type === 'buffToken') io.to(p.id).emit('buffSelect', { options: BUFFS });
                    else if (pu.type === 'weapon') {
                        p.weapon = pu.weaponType;
                        io.to(this.roomId).emit('floatingText', { x: p.x, y: p.y - 30, text: WEAPONS[p.weapon].name.toUpperCase(), color: "#FFD700" });
                    }
                    this.gameState.pickups.splice(i, 1);
                }
            }
        });

        if (allDead && Object.keys(this.players).length > 0) {
            this.gameState.active = false;
            io.to(this.roomId).emit('gameOver', { wave: this.gameState.wave });
        }

        // -- Bullet Updates --
        for (let i = this.gameState.bullets.length - 1; i >= 0; i--) {
            const b = this.gameState.bullets[i];

            if (b.type === 'ray') {
                const p1 = { x: b.x, y: b.y };
                const p2 = { x: b.x + Math.cos(b.angle) * 2000, y: b.y + Math.sin(b.angle) * 2000 };
                this.gameState.enemies.forEach((e, idx) => {
                    const l2 = Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2);
                    if (l2 == 0) return;
                    let t = ((e.x - p1.x) * (p2.x - p1.x) + (e.y - p1.y) * (p2.y - p1.y)) / l2;
                    t = Math.max(0, Math.min(1, t));
                    const dist = Math.hypot(e.x - (p1.x + t * (p2.x - p1.x)), e.y - (p1.y + t * (p2.y - p1.y)));
                    if (dist < e.radius) {
                        const pOwner = this.players[b.owner];
                        const dmg = b.damage * (pOwner ? pOwner.stats.damageMult : 1);
                        e.hp -= dmg;
                        if (e.hp <= 0) this.killEnemy(idx, b.owner);
                    }
                });
                b.life -= dt;
                if (b.life <= 0) this.gameState.bullets.splice(i, 1);
                continue;
            }

            b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
            if (b.life <= 0) { this.gameState.bullets.splice(i, 1); continue; }

            let hit = false;
            // Similar logic for hits...
            if (b.owner === 'enemy') {
                Object.values(this.players).forEach(p => {
                    if (!p.dead && !hit && Math.hypot(b.x - p.x, b.y - p.y) < p.radius + 15) {
                        hit = true; p.hp -= b.damage * (1 - p.stats.armor);
                        if (p.hp <= 0) { p.hp = 0; p.dead = true; }
                    }
                });
            } else {
                this.gameState.enemies.forEach((e, idx) => {
                    if (!hit && Math.hypot(b.x - e.x, b.y - e.y) < e.radius + 10) {
                        hit = true;
                        if (b.type === 'explosive') this.createExplosion(b.x, b.y, b.blastRadius, b.blastDamage, b.particleColor, true, b.owner);
                        else {
                            const pOwner = this.players[b.owner];
                            e.hp -= b.damage * (pOwner ? pOwner.stats.damageMult : 1);
                            if (e.hp <= 0) this.killEnemy(idx, b.owner);
                        }
                    }
                });
            }
            if (hit && b.type !== 'pierce') this.gameState.bullets.splice(i, 1);
        }

        // -- Enemy AI Updates --
        this.gameState.enemies.forEach((e, idx) => {
            let target = null;

            // Traitor Logic
            if (e.traitorTimer > 0) {
                e.traitorTimer -= dt;
                let minDist = Infinity;
                this.gameState.enemies.forEach(other => {
                    if (other === e) return;
                    const d = Math.hypot(other.x - e.x, other.y - e.y);
                    if (d < minDist) { minDist = d; target = other; }
                });
            }

            if (!target) {
                let minDist = Infinity;
                Object.values(this.players).forEach(p => {
                    if (p.dead) return;
                    const d = Math.hypot(p.x - e.x, p.y - e.y);
                    if (d < minDist) { minDist = d; target = p; }
                });
            }

            if (!target) return;
            const dist = Math.hypot(target.x - e.x, target.y - e.y);

            // -- AI BEHAVIORS --
            if (e.type === 'mage') {
                e.angle = Math.atan2(target.y - e.y, target.x - e.x);
                if (dist < 300) { e.vx = -Math.cos(e.angle) * e.speed; e.vy = -Math.sin(e.angle) * e.speed; }
                else { e.vx = Math.cos(e.angle) * e.speed; e.vy = Math.sin(e.angle) * e.speed; }

                e.stateTimer += dt;
                if (e.stateTimer > 200) {
                    e.stateTimer = 0;
                    this.gameState.enemies.push({ x: e.x + 20, y: e.y, vx: 0, vy: 0, hp: 40, speed: 3.5, radius: 25, score: 50, color: ENEMY_COLORS.basic, type: 'basic', angle: 0, state: 'CHASE' });
                    io.to(this.roomId).emit('vfx', { type: 'spawn', x: e.x, y: e.y, color: '#9b59b6' });
                }

            } else if (e.type === 'bossW10') {
                e.stateTimer -= dt;
                if (e.stateTimer <= 0) {
                    e.state = e.state === 'CHASE' ? 'BARRAGE' : e.state === 'BARRAGE' ? 'DASH' : 'CHASE';
                    e.stateTimer = e.state === 'CHASE' ? 180 : e.state === 'BARRAGE' ? 120 : 60;
                }

                if (e.state === 'CHASE') {
                    e.angle = Math.atan2(target.y - e.y, target.x - e.x);
                    e.vx = Math.cos(e.angle) * e.speed; e.vy = Math.sin(e.angle) * e.speed;
                } else if (e.state === 'BARRAGE') {
                    e.vx *= 0.9; e.vy *= 0.9;
                    if (Math.floor(e.stateTimer) % 15 === 0) {
                        this.gameState.warningZones.push({ x: target.x + randomRange(-100, 100), y: target.y + randomRange(-100, 100), radius: 80, timer: 90 });
                    }
                } else if (e.state === 'DASH') {
                    if (e.stateTimer > 40) { e.vx = 0; e.vy = 0; }
                    else if (e.stateTimer === 40) { e.angle = Math.atan2(target.y - e.y, target.x - e.x); e.vx = Math.cos(e.angle) * 15; e.vy = Math.sin(e.angle) * 15; }
                }

            } else if (e.type === 'bossW20') {
                e.stateTimer -= dt;
                if (e.stateTimer <= 0) {
                    e.state = e.state === 'CHASE' ? 'BOMB' : 'CHASE';
                    e.stateTimer = e.state === 'CHASE' ? 200 : 100;
                }
                if (e.state === 'CHASE') {
                    e.angle = Math.atan2(target.y - e.y, target.x - e.x);
                    e.vx = Math.cos(e.angle) * e.speed; e.vy = Math.sin(e.angle) * e.speed;
                } else if (e.state === 'BOMB') {
                    e.vx *= 0.9; e.vy *= 0.9;
                    if (Math.floor(e.stateTimer) % 25 === 0) {
                        const a = Math.atan2(target.y - e.y, target.x - e.x);
                        this.gameState.bullets.push({
                            x: e.x, y: e.y, vx: Math.cos(a) * 10, vy: Math.sin(a) * 10,
                            angle: a, owner: 'enemy', life: 80, damage: 40, type: 'explosive', blastRadius: 150, blastDamage: 80, particleColor: '#fff'
                        });
                    }
                }
            } else {
                e.angle = Math.atan2(target.y - e.y, target.x - e.x);
                e.vx = Math.cos(e.angle) * e.speed; e.vy = Math.sin(e.angle) * e.speed;
            }

            e.x += e.vx * dt; e.y += e.vy * dt;

            // Attack Collision
            if (dist < target.radius + e.radius) {
                if (e.traitorTimer > 0) {
                    target.hp -= 5 * dt; e.x -= e.vx * 2; e.y -= e.vy * 2;
                    if (target.hp <= 0) this.killEnemy(this.gameState.enemies.indexOf(target), 'traitor');
                } else {
                    target.hp -= 4 * (1 - target.stats.armor) * dt;
                    e.x -= e.vx * 5; e.y -= e.vy * 5;
                    if (target.hp <= 0) { target.hp = 0; target.dead = true; }
                }
            }
        });

        // -- Warning Zones --
        for (let i = this.gameState.warningZones.length - 1; i >= 0; i--) {
            const z = this.gameState.warningZones[i];
            z.timer -= dt;
            if (z.timer <= 0) {
                this.createExplosion(z.x, z.y, z.radius, 60, '#ff4400', false, null); // false = hurts players
                this.gameState.warningZones.splice(i, 1);
            }
        }

        // -- Broadcast --
        io.to(this.roomId).emit('gamestate', {
            players: this.players,
            enemies: this.gameState.enemies,
            bullets: this.gameState.bullets,
            pickups: this.gameState.pickups,
            wave: this.gameState.wave,
            waveState: this.gameState.waveState,
            waveTimer: this.gameState.waveTimer,
            score: this.gameState.score,
            warningZones: this.gameState.warningZones
        });

        // Clear transient events
        this.gameState.explosions = [];
        this.gameState.floatingTexts = [];
    }

    createExplosion(x, y, rad, dmg, col, isEnemyTarget, sourceId) {
        // Send VFX event
        io.to(this.roomId).emit('vfx', { type: 'explosion', x, y, radius: rad, color: col });

        const targets = isEnemyTarget ? this.gameState.enemies : Object.values(this.players);

        if (isEnemyTarget) {
            // Damage Enemies
            // Source stats
            const p = this.players[sourceId];
            const mult = p ? p.stats.damageMult : 1;

            for (let i = targets.length - 1; i >= 0; i--) {
                const t = targets[i];
                if (Math.hypot(t.x - x, t.y - y) < rad + t.radius) {
                    t.hp -= dmg * mult;
                    if (t.hp <= 0) this.killEnemy(i, sourceId);
                }
            }
        } else {
            // Damage Players
            Object.values(this.players).forEach(p => {
                if (!p.dead && Math.hypot(p.x - x, p.y - y) < rad + p.radius) {
                    p.hp -= dmg * (1 - p.stats.armor);
                    if (p.hp <= 0) { p.hp = 0; p.dead = true; }
                }
            });
        }
    }

    killEnemy(idx, playerId) {
        const e = this.gameState.enemies[idx];
        if (!e) return;
        this.gameState.score += e.score;
        io.to(this.roomId).emit('vfx', { type: 'death', x: e.x, y: e.y, color: e.color.body });

        // Logic for drops
        const isSpecial = e.type.includes('boss') || e.type === 'mage' || e.type === 'purple';

        if (isSpecial || Math.random() < DROP_CHANCE) {
            const rand = Math.random();
            if (e.type.includes('boss') || rand < 0.3) {
                this.gameState.pickups.push({ x: e.x, y: e.y, radius: 25, type: 'buffToken' });
            } else {
                const weaponPool = ['grenade', 'rpg', 'shotgun', 'minigun', 'sniper'];
                if (this.gameState.wave > 20) weaponPool.push('laser');
                const w = weaponPool[Math.floor(Math.random() * weaponPool.length)];
                this.gameState.pickups.push({ x: e.x, y: e.y, radius: 15, type: 'weapon', weaponType: w });
            }
        }
        this.gameState.enemies.splice(idx, 1);
    }
}

// --- Socket.io Handling ---

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let currentRoomId = null;

    socket.on('createRoom', () => {
        const roomId = generateRoomId();
        rooms[roomId] = new GameRoom(roomId);
        socket.join(roomId);
        currentRoomId = roomId;
        rooms[roomId].addPlayer(socket.id);
        socket.emit('roomCreated', roomId);
    });

    socket.on('joinRoom', (roomId) => {
        if (rooms[roomId]) {
            socket.join(roomId);
            currentRoomId = roomId;
            rooms[roomId].addPlayer(socket.id);
            socket.emit('joinedRoom', roomId);

            // If game is already active, tell the new player to start immediately
            if (rooms[roomId].gameState.active) {
                socket.emit('gameStarted');
            }
        } else {
            socket.emit('error', 'Room not found');
        }
    });

    socket.on('startGame', () => {
        if (currentRoomId && rooms[currentRoomId]) {
            rooms[currentRoomId].startGame();
            io.to(currentRoomId).emit('gameStarted');
        }
    });

    socket.on('input', (data) => {
        // data: { keys: {w,a,s,d,' '}, angle: number }
        if (currentRoomId && rooms[currentRoomId] && rooms[currentRoomId].players[socket.id]) {
            const p = rooms[currentRoomId].players[socket.id];
            if (p.dead) return;

            const sMult = p.stats.speedMult;
            let ax = 0, ay = 0;
            if (data.keys.w) ay = -ACCEL;
            if (data.keys.s) ay = ACCEL;
            if (data.keys.a) ax = -ACCEL;
            if (data.keys.d) ax = ACCEL;

            p.vx += ax * sMult; // Note: simplified integration, should ideally use DT
            p.vy += ay * sMult;

            p.angle = data.angle;
            p.shooting = data.keys[' '];
        }
    });

    socket.on('applyBuff', (buffId) => {
        // Player chose a buff
        if (currentRoomId && rooms[currentRoomId] && rooms[currentRoomId].players[socket.id]) {
            const p = rooms[currentRoomId].players[socket.id];
            const buff = BUFFS.find(b => b.id === buffId);
            if (buff) {
                buff.apply(p.stats);
                p.maxHp = 100 + p.stats.hpAdd;
                p.hp = p.maxHp;
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (currentRoomId && rooms[currentRoomId]) {
            rooms[currentRoomId].removePlayer(socket.id);
            // If room empty, clean up
            if (Object.keys(rooms[currentRoomId].players).length === 0) {
                clearInterval(rooms[currentRoomId].loopInterval);
                delete rooms[currentRoomId];
            }
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
