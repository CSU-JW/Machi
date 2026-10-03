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

      // 尝试重连：token 匹配且房间还在
      if (oldToken) {
        for (const rid of Object.keys(rooms)) {
          const room = rooms[rid];
          if (!room.game) continue;
          const player = room.game.players.find(p => p.token === oldToken);
          if (player) {
            // 替换旧的 ws
            room.clients = room.clients.filter(c => c.playerId !== player.id);
            ws.roomId = rid;
            ws.playerId = player.id;
            ws.token = oldToken;
            room.clients.push(ws);
            player.connected = true;
            console.log(`[reconnect] 房间 ${rid}，玩家 ${player.name} 重连`);
            send(ws, { type: 'joined', roomId: rid, playerId: player.id, name: player.name, token: oldToken, reconnect: true });
            broadcast(rid);
            return;
          }
        }
      }

      // 新玩家加入
      let roomId = Object.keys(rooms).find(id => {
        const r = rooms[id];
        return r.clients.length < 4 && (!r.game || r.game.players.some(p => !p.connected) === false);
      });
      // 简单策略：找人数 < 4 的房间
      roomId = Object.keys(rooms).find(id => rooms[id].clients.length < 4);
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
        // 给每个玩家绑定 token
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
      g.turnNumber += 1;   // 回合数 +1
      broadcast(ws.roomId);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomId];
    if (!room) return;
    // 标记该玩家离线，但保留房间
    if (room.game) {
      const player = room.game.players.find(p => p.id === ws.playerId);
      if (player) player.connected = false;
    }
    room.clients = room.clients.filter(c => c !== ws);
    console.log(`[leave] 房间 ${ws.roomId}，玩家 ${ws.playerId} 离线，剩余连接 ${room.clients.length}`);
    // 广播状态，让其他人看到"离线"
    broadcast(ws.roomId);
    // 如果所有人都离线，可以保留房间一段时间；这里简化：不删
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`服务已启动：http://localhost:${PORT}`);
});