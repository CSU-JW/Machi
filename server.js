// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = require('./engine');
const { CARDS, LANDMARKS } = require('./cards');

// ---------- 静态文件服务 ----------
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);

  const ext = path.extname(filePath);
  const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// ---------- 房间管理 ----------
const rooms = {};
let nextRoomId = 1;

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify({ type: 'state', game: room.game });
  for (const ws of room.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.playerId = null;
  ws.token = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ================= 加入 / 重连 =================
    if (msg.type === 'join') {
      const name = (msg.name || '玩家').slice(0, 8);
      const oldToken = msg.token;

      // 尝试重连
      if (oldToken) {
        for (const rid of Object.keys(rooms)) {
          const room = rooms[rid];
          if (!room.game) continue;
          const player = room.game.players.find(p => p.token === oldToken);
          if (player) {
            // 踢掉该玩家的所有旧连接
            const oldConns = room.clients.filter(c => c.playerId === player.id);
            for (const old of oldConns) {
              send(old, { type: 'kick', msg: '你的账号在另一个页面打开了，当前页面已断开' });
              old.playerId = -1;   // 标记为已踢，close 时不再做离线处理
              old.close();
            }
            room.clients = room.clients.filter(c => c.playerId !== player.id);

            ws.roomId = rid;
            ws.playerId = player.id;
            ws.token = oldToken;
            room.clients.push(ws);
            player.connected = true;

            console.log(`[reconnect] 房间 ${rid}，玩家 ${player.name} 重连（旧连接已踢）`);
            send(ws, { type: 'joined', roomId: rid, playerId: player.id, name: player.name, token: oldToken, reconnect: true });
            broadcast(rid);
            return;
          }
        }
      }

      // 新玩家加入：找人数 < 4 的房间
      let roomId = Object.keys(rooms).find(id => rooms[id].clients.length < 4);
      if (!roomId) {
        roomId = String(nextRoomId++);
        rooms[roomId] = { game: null, clients: [], names: [], tokens: [] };
      }
      const room = rooms[roomId];
      const playerId = room.clients.length;
      const token = crypto.randomBytes(16).toString('hex');

      room.clients.push(ws);
      room.names.push(name);
      room.tokens.push(token);
      ws.roomId = roomId;
      ws.playerId = playerId;
      ws.token = token;

      console.log(`[join] 房间 ${roomId}，玩家 ${name}(id=${playerId})，当前人数 ${room.clients.length}`);
      send(ws, { type: 'joined', roomId, playerId, name, token });

      if (room.clients.length === 4) {
        console.log(`[start] 房间 ${roomId} 开局！`);
        room.game = E.createGame(room.names);
        room.game.players.forEach((p, i) => { p.token = room.tokens[i]; });
        broadcast(roomId);
      } else {
        for (const c of room.clients) {
          send(c, { type: 'waiting', roomId, need: 4 - room.clients.length });
        }
      }
      return;
    }

    // ================= 以下操作要求已在游戏中 =================
    const room = rooms[ws.roomId];
    if (!room || !room.game) return;
    const g = room.game;

    if (ws.playerId !== g.current) {
      send(ws, { type: 'error', msg: '还没轮到你' });
      return;
    }

    const p = g.players[g.current];

    // ---- 掷骰 ----
    if (msg.type === 'roll') {
      if (g.dice) { send(ws, { type: 'error', msg: '本回合已掷过' }); return; }
      const count = msg.count === 2 && p.landmarks.train ? 2 : 1;
      g.dice = { ...E.rollDice(count), firstCount: count };
      g.rerolled = false;
      g.settled = false;
      if (E.canReroll(g, p)) {
        g.pendingChoice = { type: 'askReroll', rollerId: p.id };
      } else {
        const result = E.settle(g, p.id, g.dice.sum);
        g.log.push(...result.events.map(t => ({ text: t, turn: g.turnNumber })));
        g.settled = true;
        if (result.needChoice) g.pendingChoice = result.needChoice;
      }
      broadcast(ws.roomId);
      return;
    }

    // ---- 选择 ----
    if (msg.type === 'choice') {
      if (!g.pendingChoice) { send(ws, { type: 'error', msg: '当前没有待选择' }); return; }
      const result = E.handleChoice(g, p.id, msg.choice);
      if (!result.ok) { send(ws, { type: 'error', msg: result.error }); return; }
      g.log.push(...result.events.map(t => ({ text: t, turn: g.turnNumber })));
      g.pendingChoice = result.needChoice || null;
      broadcast(ws.roomId);
      return;
    }

    // ---- 购买 ----
    if (msg.type === 'buy') {
      const r = E.buyCard(g, msg.cardId);
      if (!r.ok) send(ws, { type: 'error', msg: r.reason });
      broadcast(ws.roomId);
      return;
    }

    // ---- 建设 ----
    if (msg.type === 'build') {
      const r = E.buildLandmark(g, msg.landmarkId);
      if (!r.ok) send(ws, { type: 'error', msg: r.reason });
      broadcast(ws.roomId);
      return;
    }

    // ---- 结束回合 ----
    if (msg.type === 'endTurn') {
      if (g.pendingChoice) { send(ws, { type: 'error', msg: '还有选择未完成' }); return; }
      if (E.isWin(p)) { broadcast(ws.roomId); return; }
      g.current = (g.current + 1) % 4;
      g.dice = null;
      g.rerolled = false;
      g.settled = false;
      g.boughtThisTurn = false;
      g.pendingChoice = null;
      g.phase = 'roll';
      g.turnNumber += 1;
      broadcast(ws.roomId);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomId];
    if (!room) return;

    // 被踢的旧连接，直接移除，不做离线标记
    if (ws.playerId === -1) {
      room.clients = room.clients.filter(c => c !== ws);
      return;
    }

    if (room.game) {
      const player = room.game.players.find(p => p.id === ws.playerId);
      // 确认没有其他同一玩家的活跃连接
      const stillConnected = room.clients.some(
        c => c !== ws && c.playerId === ws.playerId && c.readyState === 1
      );
      if (player && !stillConnected) player.connected = false;
    }
    room.clients = room.clients.filter(c => c !== ws);
    console.log(`[leave] 房间 ${ws.roomId}，玩家 ${ws.playerId} 离线，剩余连接 ${room.clients.length}`);
    broadcast(ws.roomId);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`服务已启动：http://localhost:${PORT}`);
});