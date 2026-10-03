// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
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

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ================= 加入房间 =================
    if (msg.type === 'join') {
      const name = (msg.name || '玩家').slice(0, 8);

      let roomId = Object.keys(rooms).find(id => rooms[id].clients.length < 4);
      if (!roomId) {
        roomId = String(nextRoomId++);
        rooms[roomId] = { game: null, clients: [], names: [] };
      }
      const room = rooms[roomId];
      const playerId = room.clients.length;

      room.clients.push(ws);
      room.names.push(name);
      ws.roomId = roomId;
      ws.playerId = playerId;

      console.log(`[join] 房间 ${roomId}，玩家 ${name}(id=${playerId})，当前人数 ${room.clients.length}`);
      send(ws, { type: 'joined', roomId, playerId, name });

      if (room.clients.length === 4) {
        console.log(`[start] 房间 ${roomId} 开局！`);
        room.game = E.createGame(room.names);
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

      // 不结算！先看是否有重掷机会
      if (E.canReroll(g, p)) {
        // 有重掷机会：等待玩家选择接受或重掷
        g.pendingChoice = { type: 'askReroll', rollerId: p.id };
      } else {
        // 没有重掷机会：直接结算
        const result = E.settle(g, p.id, g.dice.sum);
        g.log.push(...result.events);
        g.settled = true;
        if (result.needChoice) g.pendingChoice = result.needChoice;
      }
      broadcast(ws.roomId);
      return;
    }

    // ---- 处理选择 ----
    if (msg.type === 'choice') {
      if (!g.pendingChoice) { send(ws, { type: 'error', msg: '当前没有待选择' }); return; }
      const result = E.handleChoice(g, p.id, msg.choice);
      if (!result.ok) { send(ws, { type: 'error', msg: result.error }); return; }
      g.log.push(...result.events);
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

    // ---- 建设地标 ----
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
      broadcast(ws.roomId);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomId];
    if (!room) return;
    room.clients = room.clients.filter(c => c !== ws);
    console.log(`[leave] 房间 ${ws.roomId}，剩余 ${room.clients.length} 人`);
    if (room.clients.length === 0) delete rooms[ws.roomId];
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`服务已启动：http://localhost:${PORT}`);
});