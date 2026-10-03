const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const E = require('./engine');
const { AuthStore, AuthError, cleanNickname } = require('./auth-store');

const MAX_PLAYERS = 4;
const INITIAL_ROOM_COUNT = 3;
const WAITING_SEAT_TTL_MS = 30_000;
const GAME_SEAT_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createMachiServer(options = {}) {
  const publicDir = options.publicDir || path.join(__dirname, 'public');
  const dataDir = options.dataDir || process.env.MACHI_DATA_DIR || path.join(__dirname, 'data');
  const authStore = options.authStore || new AuthStore(path.join(dataDir, 'accounts.json'));
  const rooms = new Map();
  const sessions = new Map();
  let nextRoomId = 1;

  function createRoom() {
    const id = String(nextRoomId++);
    const room = { id, members: [], game: null };
    rooms.set(id, room);
    return room;
  }

  for (let i = 0; i < INITIAL_ROOM_COUNT; i += 1) createRoom();

  function readCookie(header, name) {
    const cookies = String(header || '').split(';');
    for (const cookie of cookies) {
      const separator = cookie.indexOf('=');
      if (separator < 0) continue;
      if (cookie.slice(0, separator).trim() === name) return cookie.slice(separator + 1).trim();
    }
    return null;
  }

  function validDeviceId(value) {
    return /^[a-zA-Z0-9_-]{16,128}$/.test(String(value || ''));
  }

  function serveStatic(req, res) {
    const requestUrl = new URL(req.url, 'http://localhost');
    if (!validDeviceId(readCookie(req.headers.cookie, 'machi_device'))) {
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader(
        'Set-Cookie',
        `machi_device=${crypto.randomBytes(24).toString('hex')}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure}`,
      );
    }
    if (requestUrl.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    const relativePath = pathname.replace(/^[/\\]+/, '');
    const filePath = path.resolve(publicDir, relativePath);
    const publicRoot = path.resolve(publicDir) + path.sep;
    if (!filePath.startsWith(publicRoot)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    };
    fs.readFile(filePath, (readError, data) => {
      if (readError) {
        res.writeHead(readError.code === 'ENOENT' ? 404 : 500);
        res.end(readError.code === 'ENOENT' ? 'Not Found' : 'Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server });

  function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function sendError(ws, message, code = 'BAD_REQUEST') {
    send(ws, { type: 'error', code, msg: message });
  }

  function roomSummary(room) {
    const activeMembers = room.members.filter(member => member.identityKey);
    return {
      id: room.id,
      playerCount: activeMembers.length,
      capacity: MAX_PLAYERS,
      status: room.game ? 'playing' : 'waiting',
      players: activeMembers.map(member => member.name),
    };
  }

  function broadcastLobby() {
    const payload = JSON.stringify({
      type: 'lobby',
      rooms: Array.from(rooms.values()).map(roomSummary),
    });
    for (const client of wss.clients) {
      if (client.identity && client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  function sendLobby(ws) {
    send(ws, { type: 'lobby', rooms: Array.from(rooms.values()).map(roomSummary) });
  }

  function broadcastGame(room) {
    if (!room.game) return;
    const payload = JSON.stringify({ type: 'state', game: room.game });
    for (const member of room.members) {
      if (member.socket && member.socket.readyState === WebSocket.OPEN) member.socket.send(payload);
    }
  }

  function sendWaiting(room) {
    const payload = {
      type: 'waiting',
      roomId: room.id,
      need: MAX_PLAYERS - room.members.length,
      players: room.members.map(member => ({
        id: member.playerId,
        name: member.name,
        connected: member.connected,
      })),
    };
    for (const member of room.members) {
      if (member.socket) send(member.socket, payload);
    }
  }

  function identityKey(identity) {
    return `${identity.kind}:${identity.id}`;
  }

  function sanitizeDeviceId(value) {
    const deviceId = String(value || '');
    return validDeviceId(deviceId)
      ? deviceId
      : crypto.randomBytes(24).toString('hex');
  }

  function createSession(identity, deviceId) {
    const token = crypto.randomBytes(32).toString('hex');
    const session = {
      identity,
      deviceId: sanitizeDeviceId(deviceId),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    sessions.set(token, session);
    return { token, session };
  }

  function publicIdentity(identity) {
    return {
      kind: identity.kind,
      username: identity.username || null,
      nickname: identity.nickname,
    };
  }

  function sendAuthenticated(ws, token) {
    send(ws, {
      type: 'authenticated',
      sessionToken: token,
      user: publicIdentity(ws.identity),
      deviceId: ws.deviceId,
    });
  }

  function findIdentityMembership(key) {
    for (const room of rooms.values()) {
      const member = room.members.find(item => item.identityKey === key);
      if (member) return { room, member };
    }
    return null;
  }

  function findDeviceMembership(deviceId) {
    for (const room of rooms.values()) {
      const member = room.members.find(item => item.deviceIds.has(deviceId));
      if (member) return { room, member };
    }
    return null;
  }

  function kickPreviousSocket(member, replacement) {
    const previous = member.socket;
    if (!previous || previous === replacement || previous.readyState === WebSocket.CLOSED) return;
    previous.replaced = true;
    send(previous, { type: 'kick', msg: '该玩家身份已在另一个页面连接，本页面已断开' });
    previous.close(4001, 'replaced');
  }

  function attachToMember(ws, room, member, reconnect = true) {
    if (member.cleanupTimer) {
      clearTimeout(member.cleanupTimer);
      member.cleanupTimer = null;
    }
    kickPreviousSocket(member, ws);
    member.socket = ws;
    member.connected = true;
    member.deviceIds.add(ws.deviceId);
    ws.roomId = room.id;
    ws.playerId = member.playerId;
    ws.replaced = false;
    if (room.game) room.game.players[member.playerId].connected = true;

    send(ws, {
      type: 'roomJoined',
      roomId: room.id,
      playerId: member.playerId,
      name: member.name,
      reconnect,
    });
    if (room.game) broadcastGame(room);
    else sendWaiting(room);
    broadcastLobby();
  }

  function reindexWaitingRoom(room) {
    room.members.forEach((member, index) => {
      member.playerId = index;
      if (member.socket) {
        member.socket.playerId = index;
        send(member.socket, {
          type: 'roomJoined', roomId: room.id, playerId: index,
          name: member.name, reconnect: true,
        });
      }
    });
  }

  function removeWaitingMember(room, member) {
    if (room.game) return;
    if (member.cleanupTimer) clearTimeout(member.cleanupTimer);
    room.members = room.members.filter(item => item !== member);
    reindexWaitingRoom(room);
    sendWaiting(room);
    broadcastLobby();
  }

  function releaseGameMember(room, member) {
    if (!room.game || !member.identityKey) return;
    if (member.cleanupTimer) clearTimeout(member.cleanupTimer);
    member.cleanupTimer = null;
    member.socket = null;
    member.connected = false;
    member.identityKey = null;
    member.deviceIds.clear();
    room.game.players[member.playerId].connected = false;

    if (room.members.every(item => !item.identityKey)) {
      room.members = [];
      room.game = null;
      console.log(`[reset] 房间 ${room.id} 已恢复为空房`);
    } else {
      broadcastGame(room);
    }
    broadcastLobby();
  }

  function startGame(room) {
    room.game = E.createGame(room.members.map(member => member.name));
    room.members.forEach((member, index) => {
      member.playerId = index;
      if (member.socket) member.socket.playerId = index;
      room.game.players[index].connected = member.connected;
    });
    console.log(`[start] 房间 ${room.id} 开局`);
    broadcastGame(room);
    broadcastLobby();
  }

  function restoreMembership(ws) {
    const found = findIdentityMembership(identityKey(ws.identity));
    if (found) attachToMember(ws, found.room, found.member, true);
    else sendLobby(ws);
  }

  function authenticateSocket(ws, token, session) {
    ws.identity = session.identity;
    ws.deviceId = session.deviceId;
    ws.sessionToken = token;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    sendAuthenticated(ws, token);
    restoreMembership(ws);
  }

  function handleAuthentication(ws, msg) {
    try {
      if (msg.type === 'resumeSession') {
        const token = String(msg.sessionToken || '');
        const session = sessions.get(token);
        if (!session || session.expiresAt <= Date.now()) {
          if (session) sessions.delete(token);
          send(ws, { type: 'authRequired', msg: '登录状态已失效，请重新登录' });
          return;
        }
        if (ws.serverDeviceId && session.deviceId !== ws.serverDeviceId) {
          send(ws, { type: 'authRequired', msg: '请在这台设备上重新登录' });
          return;
        }
        if (session.identity.kind === 'account') {
          const account = authStore.findById(session.identity.id);
          if (!account) {
            sessions.delete(token);
            send(ws, { type: 'authRequired', msg: '账号不存在，请重新登录' });
            return;
          }
          session.identity = { kind: 'account', ...account };
        }
        authenticateSocket(ws, token, session);
        return;
      }

      let identity;
      const authenticatedDeviceId = ws.serverDeviceId || sanitizeDeviceId(msg.deviceId);
      if (msg.type === 'register') {
        const account = authStore.register(msg);
        identity = { kind: 'account', ...account };
      } else if (msg.type === 'login') {
        const account = authStore.authenticate(msg);
        identity = { kind: 'account', ...account };
      } else if (msg.type === 'guestLogin') {
        const nickname = cleanNickname(msg.nickname);
        if (!nickname) throw new AuthError('INVALID_NICKNAME', '请输入游客昵称');
        identity = {
          kind: 'guest',
          id: crypto.createHash('sha256').update(authenticatedDeviceId).digest('hex'),
          nickname,
        };
      } else {
        send(ws, { type: 'authRequired', msg: '请先登录或选择游客进入' });
        return;
      }

      const { token, session } = createSession(identity, authenticatedDeviceId);
      authenticateSocket(ws, token, session);
    } catch (authError) {
      send(ws, {
        type: 'authError',
        code: authError.code || 'AUTH_FAILED',
        msg: authError.message || '登录失败',
      });
    }
  }

  function handleJoinRoom(ws, msg) {
    const roomId = String(msg.roomId || '');
    const room = rooms.get(roomId);
    if (!room) return sendError(ws, '房间不存在', 'ROOM_NOT_FOUND');

    const key = identityKey(ws.identity);
    const existing = findIdentityMembership(key);
    if (existing) {
      if (existing.room.id !== roomId) {
        return sendError(ws, `你已在房间 ${existing.room.id}，请先退出该房间`, 'ALREADY_IN_ROOM');
      }
      attachToMember(ws, existing.room, existing.member, true);
      return;
    }

    const deviceOccupant = findDeviceMembership(ws.deviceId);
    if (deviceOccupant) {
      return sendError(
        ws,
        `这台设备已有玩家在房间 ${deviceOccupant.room.id}，不能重复占用玩家席位`,
        'DEVICE_ALREADY_IN_ROOM',
      );
    }
    if (room.game) return sendError(ws, '该房间游戏已经开始', 'ROOM_STARTED');
    if (room.members.length >= MAX_PLAYERS) return sendError(ws, '该房间已满', 'ROOM_FULL');

    const member = {
      playerId: room.members.length,
      identityKey: key,
      deviceIds: new Set([ws.deviceId]),
      name: ws.identity.nickname,
      connected: true,
      socket: null,
      cleanupTimer: null,
    };
    room.members.push(member);
    console.log(`[join] 房间 ${room.id}，${member.name}，当前人数 ${room.members.length}`);
    attachToMember(ws, room, member, false);
    if (room.members.length === MAX_PLAYERS) startGame(room);
  }

  function handleLeaveRoom(ws) {
    const room = rooms.get(ws.roomId);
    if (!room) return sendError(ws, '你当前不在房间中', 'NOT_IN_ROOM');
    const key = identityKey(ws.identity);
    const member = room.members.find(item => item.playerId === ws.playerId && item.identityKey === key);
    if (!member) return sendError(ws, '玩家席位不存在', 'NOT_IN_ROOM');
    if (room.game) {
      ws.roomId = null;
      ws.playerId = null;
      releaseGameMember(room, member);
      send(ws, { type: 'leftRoom' });
      sendLobby(ws);
      return;
    }
    member.socket = null;
    ws.roomId = null;
    ws.playerId = null;
    removeWaitingMember(room, member);
    send(ws, { type: 'leftRoom' });
    sendLobby(ws);
  }

  function handleGameAction(ws, msg) {
    const room = rooms.get(ws.roomId);
    if (!room || !room.game) return sendError(ws, '游戏尚未开始', 'GAME_NOT_STARTED');
    const game = room.game;
    const member = room.members[ws.playerId];
    if (!member || member.identityKey !== identityKey(ws.identity) || member.socket !== ws) {
      return sendError(ws, '当前连接没有该玩家席位', 'INVALID_SEAT');
    }
    if (ws.playerId !== game.current) return sendError(ws, '还没轮到你', 'NOT_YOUR_TURN');

    const player = game.players[game.current];
    if (msg.type === 'roll') {
      if (game.dice) return sendError(ws, '本回合已掷过', 'ALREADY_ROLLED');
      const count = msg.count === 2 && player.landmarks.train ? 2 : 1;
      game.dice = { ...E.rollDice(count), firstCount: count };
      game.rerolled = false;
      game.settled = false;
      if (E.canReroll(game, player)) {
        game.pendingChoice = { type: 'askReroll', rollerId: player.id };
      } else {
        const result = E.settle(game, player.id, game.dice.sum);
        game.log.push(...result.events.map(text => ({ text, turn: game.turnNumber })));
        game.settled = true;
        if (result.needChoice) game.pendingChoice = result.needChoice;
      }
      broadcastGame(room);
      return;
    }

    if (msg.type === 'choice') {
      if (!game.pendingChoice) return sendError(ws, '当前没有待选择', 'NO_PENDING_CHOICE');
      const result = E.handleChoice(game, player.id, msg.choice || {});
      if (!result.ok) return sendError(ws, result.error, 'INVALID_CHOICE');
      game.log.push(...result.events.map(text => ({ text, turn: game.turnNumber })));
      game.pendingChoice = result.needChoice || null;
      broadcastGame(room);
      return;
    }

    if (msg.type === 'buy') {
      const result = E.buyCard(game, msg.cardId);
      if (!result.ok) sendError(ws, result.reason, 'BUY_FAILED');
      broadcastGame(room);
      return;
    }

    if (msg.type === 'build') {
      const result = E.buildLandmark(game, msg.landmarkId);
      if (!result.ok) sendError(ws, result.reason, 'BUILD_FAILED');
      broadcastGame(room);
      return;
    }

    if (msg.type === 'endTurn') {
      if (game.pendingChoice) return sendError(ws, '还有选择未完成', 'PENDING_CHOICE');
      if (E.isWin(player)) {
        broadcastGame(room);
        return;
      }
      game.current = (game.current + 1) % MAX_PLAYERS;
      game.dice = null;
      game.rerolled = false;
      game.settled = false;
      game.boughtThisTurn = false;
      game.pendingChoice = null;
      game.phase = 'roll';
      game.turnNumber += 1;
      broadcastGame(room);
    }
  }

  function disconnectFromRoom(ws) {
    const room = rooms.get(ws.roomId);
    if (!room || ws.playerId === null) return;
    const member = room.members.find(item => item.playerId === ws.playerId);
    if (!member || member.socket !== ws || ws.replaced) return;
    member.socket = null;
    member.connected = false;
    if (room.game) {
      room.game.players[member.playerId].connected = false;
      broadcastGame(room);
      member.cleanupTimer = setTimeout(() => {
        if (!member.connected && member.socket === null && rooms.get(room.id) === room) {
          releaseGameMember(room, member);
        }
      }, GAME_SEAT_TTL_MS);
      member.cleanupTimer.unref?.();
    } else {
      member.cleanupTimer = setTimeout(() => {
        if (!member.connected && member.socket === null && rooms.get(room.id) === room) {
          removeWaitingMember(room, member);
        }
      }, WAITING_SEAT_TTL_MS);
      member.cleanupTimer.unref?.();
      sendWaiting(room);
    }
    broadcastLobby();
  }

  wss.on('connection', (ws, request) => {
    ws.identity = null;
    ws.deviceId = null;
    ws.sessionToken = null;
    ws.roomId = null;
    ws.playerId = null;
    ws.replaced = false;
    const cookieDeviceId = readCookie(request.headers.cookie, 'machi_device');
    ws.serverDeviceId = validDeviceId(cookieDeviceId) ? cookieDeviceId : null;
    send(ws, { type: 'hello' });

    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendError(ws, '消息格式错误', 'INVALID_JSON');
        return;
      }

      if (!ws.identity) {
        handleAuthentication(ws, msg);
        return;
      }
      if (msg.type === 'joinRoom') return handleJoinRoom(ws, msg);
      if (msg.type === 'leaveRoom') return handleLeaveRoom(ws);
      if (msg.type === 'createRoom') {
        const room = createRoom();
        broadcastLobby();
        send(ws, { type: 'roomCreated', roomId: room.id });
        return;
      }
      if (msg.type === 'requestLobby') return sendLobby(ws);
      if (msg.type === 'logout') {
        if (ws.roomId) return sendError(ws, '请先退出当前房间', 'LEAVE_ROOM_FIRST');
        sessions.delete(ws.sessionToken);
        ws.identity = null;
        ws.sessionToken = null;
        send(ws, { type: 'loggedOut' });
        return;
      }
      if (['roll', 'choice', 'buy', 'build', 'endTurn'].includes(msg.type)) {
        handleGameAction(ws, msg);
      }
    });

    ws.on('close', () => disconnectFromRoom(ws));
    ws.on('error', socketError => console.error(`[ws] ${socketError.message}`));
  });

  const cleanupSessions = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  }, 60 * 60 * 1000);
  cleanupSessions.unref?.();

  return { server, wss, rooms, sessions, authStore };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createMachiServer();
  app.server.listen(port, () => console.log(`服务已启动：http://localhost:${port}`));
}

module.exports = { createMachiServer };
