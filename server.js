const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const E = require('./engine');
const D = require('./dlc1/runtime');
const { CARDS, LANDMARKS, SIX_CARDS } = require('./cards');
const { AuthStore, AuthError, cleanNickname } = require('./auth-store');
const B = require('./bots');

const MAX_PLAYERS = 4;
const WAITING_SEAT_TTL_MS = 30_000;
const GAME_SEAT_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHAT_MAX_LENGTH = 300;
const CHAT_HISTORY_LIMIT = 100;
const CHAT_RATE_LIMIT_MS = 500;

function createMachiServer(options = {}) {
  const publicDir = options.publicDir || path.join(__dirname, 'public');
  const dataDir = options.dataDir || process.env.MACHI_DATA_DIR || path.join(__dirname, 'data');
  const authStore = options.authStore || new AuthStore(path.join(dataDir, 'accounts.json'));
  const botTurnDelayMs = options.botTurnDelayMs ?? 1100;
  const botJitterMs = options.botJitterMs ?? 600;
  const gameOverResetMs = options.gameOverResetMs ?? 8000;
  const turnTimeoutMs = options.turnTimeoutMs ?? 60_000;
  const disconnectedTurnTimeoutMs = options.disconnectedTurnTimeoutMs ?? 12_000;
  const authWindowMs = options.authWindowMs ?? 60_000;
  const authMaxAttempts = options.authMaxAttempts ?? 20;
  const rooms = new Map();
  const sessions = new Map();
  const authAttempts = new Map();

  // 房间编号从 1 开始，取最小空闲编号（关闭后的空号会被复用）
  function createRoom(dlcEnabled = false) {
    let id = 1;
    while (rooms.has(String(id))) id += 1;
    const room = { id: String(id), members: [], game: null, dlcEnabled: dlcEnabled === true, chatLog: [], botTimer: null, gameOverTimer: null, turnTimer: null };
    rooms.set(room.id, room);
    return room;
  }

  // 关闭并清除房间：测试房永不关闭，只复位保留
  function closeRoom(room) {
    if (room.taskTimer) clearTimeout(room.taskTimer);
    if (room.botTimer) clearTimeout(room.botTimer);
    if (room.gameOverTimer) clearTimeout(room.gameOverTimer);
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.botTimer = null;
    room.gameOverTimer = null;
    room.turnTimer = null;
    if (room.testRoom) {
      room.members = [];
      room.game = null;
      room.chatLog = [];
      room.dlcEnabled = false;
      console.log('[reset] 单人测试房已复位（保留）');
      return;
    }
    rooms.delete(room.id);
    console.log(`[close] 房间 ${room.id} 已关闭清除`);
  }

  // 对局结束：所有人（参赛者与观战者）自动回到等待房，席位保持不变
  function resetGameToWaiting(room) {
    if (!room.game) return;
    if (room.taskTimer) clearTimeout(room.taskTimer);
    if (room.botTimer) clearTimeout(room.botTimer);
    if (room.gameOverTimer) clearTimeout(room.gameOverTimer);
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.taskTimer = null;
    room.botTimer = null;
    room.gameOverTimer = null;
    room.turnTimer = null;
    room.game = null;
    console.log(`[reset] 房间 ${room.id} 对局结束，全员返回等待房`);
    sendWaiting(room);
    broadcastLobby();
  }

  rooms.set('test',{id:'test',members:[],game:null,dlcEnabled:false,testRoom:true,chatLog:[],botTimer:null,gameOverTimer:null,turnTimer:null});

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
    if (requestUrl.pathname === '/api/catalog') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ cards: CARDS, landmarks: LANDMARKS, sixCards: SIX_CARDS }));
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

    // 仅公开DLC目录内的静态展示文件，不暴露运行时代码。
    const isDlc = pathname.startsWith('/dlc1/');
    if (isDlc && !(/^\/dlc1\/assets\/cards\/[a-zA-Z0-9-]+\.(png|webp|jpg)$/.test(pathname) || pathname === '/dlc1/catalog.js')) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    const root = isDlc ? path.join(__dirname,'dlc1') : publicDir;
    const relativePath = (isDlc ? pathname.slice(6) : pathname).replace(/^[/\\]+/, '');
    const filePath = path.resolve(root, relativePath);
    const publicRoot = path.resolve(root) + path.sep;
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
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    fs.readFile(filePath, (readError, data) => {
      if (readError) {
        res.writeHead(readError.code === 'ENOENT' ? 404 : 500);
        res.end(readError.code === 'ENOENT' ? 'Not Found' : 'Server Error');
        return;
      }
      const isImageAsset = pathname.startsWith('/assets/') || pathname.startsWith('/dlc1/assets/');
      res.writeHead(200, {
        'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': isImageAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
  }

  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
  wss.on('close', () => {
    for (const room of rooms.values()) {
      clearTurnTimer(room);
      if (room.botTimer) clearTimeout(room.botTimer);
      if (room.gameOverTimer) clearTimeout(room.gameOverTimer);
      if (room.taskTimer) clearTimeout(room.taskTimer);
      room.botTimer = null;
      room.gameOverTimer = null;
      room.taskTimer = null;
    }
  });

  function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function sendError(ws, message, code = 'BAD_REQUEST') {
    send(ws, { type: 'error', code, msg: message });
  }

  function roomSummary(room) {
    const participants = room.members.filter(member => !member.isSpectator && (member.identityKey || member.isBot));
    const spectators = room.members.filter(member => member.isSpectator && member.identityKey);
    return {
      id: room.id,
      playerCount: participants.length,
      spectatorCount: spectators.length,
      capacity: room.testRoom ? 1 : MAX_PLAYERS,
      testRoom: Boolean(room.testRoom),
      dlcEnabled: room.dlcEnabled,
      status: room.game ? 'playing' : 'waiting',
      players: participants.map(member => (member.isBot ? `🤖${member.name}` : member.name)),
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
    const g=room.game, p=g.players[g.current];
    if (Array.isArray(g.log) && g.log.length > 500) g.log.splice(0, g.log.length - 500);
    const shopQuotes={buy:{},build:{}};
    for(const id of Object.keys(g.cardPool))shopQuotes.buy[id]=D.quote(g,p,'buy',id,CARDS[id].cost);
    for(const id of Object.keys(LANDMARKS))shopQuotes.build[id]=D.quote(g,p,'build',id,LANDMARKS[id].cost);
    const payload = JSON.stringify({ type: 'state', game: {...g,shopQuotes} });
    for (const member of room.members) {
      if (member.socket && member.socket.readyState === WebSocket.OPEN) member.socket.send(payload);
    }
    // 对局结束：延时自动返回等待房（所有人席位不变）
    if (g.gameOver && !room.gameOverTimer) {
      const finishedGame = g;
      room.gameOverTimer = setTimeout(() => {
        room.gameOverTimer = null;
        if (room.game === finishedGame) resetGameToWaiting(room);
      }, gameOverResetMs);
      room.gameOverTimer.unref?.();
    }
    scheduleBotDrive(room);
    scheduleTurnTimer(room);
  }

  function sendWaiting(room) {
    const participants = room.members.filter(member => !member.isSpectator);
    const payload = waitingPayload(room, participants);
    for (const member of room.members) {
      if (member.socket) send(member.socket, payload);
    }
  }

  function waitingPayload(room, participants) {
    return {
      type: 'waiting',
      roomId: room.id,
      dlcEnabled: room.dlcEnabled,
      gameRunning: Boolean(room.game),
      hostId: participants[0]?.playerId ?? null,
      need: (room.testRoom ? 1 : MAX_PLAYERS) - participants.length,
      capacity: room.testRoom ? 1 : MAX_PLAYERS,
      testRoom: Boolean(room.testRoom),
      players: participants.map(member => ({
        id: member.playerId,
        name: member.name,
        avatar: member.avatar,
        connected: member.connected,
        bot: member.isBot === true,
        difficulty: member.botDifficulty || null,
      })),
      spectators: room.members.filter(member => member.isSpectator).map(member => ({
        name: member.name,
        avatar: member.avatar,
        connected: member.connected,
        seatKey: member.seatKey,
      })),
    };
  }

  // 只向单个连接发送房间快照（加入房间、请求房间视图时使用）
  function sendWaitingTo(ws, room) {
    const participants = room.members.filter(member => !member.isSpectator);
    send(ws, waitingPayload(room, participants));
  }

  function broadcastChat(room, entry) {
    const payload = JSON.stringify({ type: 'chat', ...entry });
    for (const member of room.members) {
      if (member.socket && member.socket.readyState === WebSocket.OPEN) member.socket.send(payload);
    }
  }

  function sendChatHistory(ws, room) {
    send(ws, { type: 'chatHistory', messages: room.chatLog || [] });
  }

  // 观战者加入的系统提示（只广播，不写入历史）
  function announceSpectatorJoin(room, name) {
    broadcastChat(room, { system: true, text: `${name} 加入了观战`, ts: Date.now() });
  }

  // 房间聊天：与游戏进程无关，等待开局和游戏进行中都可用（观战者同样可发言）。
  function handleChat(ws, msg) {
    const room = rooms.get(ws.roomId);
    if (!room) return sendError(ws, '你当前不在房间中', 'NOT_IN_ROOM');
    const member = room.members.find(item => item.socket === ws);
    if (!member || member.identityKey !== identityKey(ws.identity)) {
      return sendError(ws, '当前连接没有该玩家席位', 'INVALID_SEAT');
    }
    const text = String(msg.text || '').replace(/[\r\n\t]+/g, ' ').trim();
    if (!text) return sendError(ws, '消息不能为空', 'EMPTY_MESSAGE');
    if (text.length > CHAT_MAX_LENGTH) return sendError(ws, `消息最长 ${CHAT_MAX_LENGTH} 个字符`, 'MESSAGE_TOO_LONG');
    const now = Date.now();
    if (ws.lastChatAt && now - ws.lastChatAt < CHAT_RATE_LIMIT_MS) {
      return sendError(ws, '发送太频繁，请稍等再试', 'RATE_LIMITED');
    }
    ws.lastChatAt = now;
    if (!room.chatLog) room.chatLog = [];
    const entry = {
      playerId: member.playerId,
      seatKey: member.seatKey,
      name: member.name,
      avatar: member.avatar,
      spectator: member.isSpectator === true,
      text,
      ts: now,
    };
    room.chatLog.push(entry);
    if (room.chatLog.length > CHAT_HISTORY_LIMIT) room.chatLog.splice(0, room.chatLog.length - CHAT_HISTORY_LIMIT);
    broadcastChat(room, entry);
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
    if (room.game && !member.isSpectator) room.game.players[member.playerId].connected = true;

    send(ws, {
      type: 'roomJoined',
      roomId: room.id,
      playerId: member.playerId,
      spectator: member.isSpectator === true,
      seatKey: member.seatKey,
      name: member.name,
      reconnect,
    });
    sendChatHistory(ws, room);
    sendWaitingTo(ws, room); // 观战者也先看到与正常一致的房间界面
    if (room.game) broadcastGame(room);
    else sendWaiting(room);
    broadcastLobby();
  }

  function reindexWaitingRoom(room) {
    let index = 0;
    room.members.forEach((member) => {
      if (member.isSpectator) {
        member.playerId = null;
        if (member.socket) {
          member.socket.playerId = null;
          send(member.socket, {
            type: 'roomJoined', roomId: room.id, playerId: null, spectator: true,
            seatKey: member.seatKey, name: member.name, reconnect: true,
          });
        }
        return;
      }
      member.playerId = index;
      index += 1;
      if (member.socket) {
        member.socket.playerId = member.playerId;
        send(member.socket, {
          type: 'roomJoined', roomId: room.id, playerId: member.playerId, spectator: false,
          seatKey: member.seatKey, name: member.name, reconnect: true,
        });
      }
    });
  }

  function removeWaitingMember(room, member) {
    if (room.game) return;
    if (member.cleanupTimer) clearTimeout(member.cleanupTimer);
    room.members = room.members.filter(item => item !== member);
    if (!room.members.some(item => !item.isBot)) {
      // 没有真人玩家（只剩人机无人接管）：直接关闭房间
      closeRoom(room);
      broadcastLobby();
      return;
    }
    if (!room.members.some(item => !item.isBot && !item.isSpectator)) {
      // 没有真人参赛玩家：第一位真人观战者自动转为参赛席（移到最前成为房主）
      const spectator = room.members.find(item => !item.isBot && item.isSpectator);
      if (spectator) {
        spectator.isSpectator = false;
        room.members = [spectator, ...room.members.filter(item => item !== spectator)];
      }
    }
    // 房主身份自动转接给列表第一位玩家，人机保留
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

    const remainingHumans = room.members.filter(item => item.identityKey);
    if (!remainingHumans.length && !room.members.some(item => item.isBot)) {
      // 房间里没有任何真人玩家也没有人机：普通房间直接关闭清除，测试房复位保留
      closeRoom(room);
    } else if (!remainingHumans.some(item => !item.isSpectator)) {
      // 所有真人参赛玩家都已离场（可能只剩人机/观战者）：
      // 强制结束本局，清理已离场的参赛席位（不再显示离线），人机保留，观战者自动转为参赛房主
      room.members = room.members.filter(item => item.identityKey || item.isBot);
      if (!room.members.some(item => !item.isBot && !item.isSpectator)) {
        const spectator = room.members.find(item => !item.isBot && item.isSpectator);
        if (spectator) {
          spectator.isSpectator = false;
          room.members = [spectator, ...room.members.filter(item => item !== spectator)];
        }
      }
      reindexWaitingRoom(room);
      broadcastChat(room, { system: true, text: '所有参赛玩家已退出，本局强制结束，返回房间', ts: Date.now() });
      resetGameToWaiting(room);
    } else {
      broadcastGame(room);
    }
    broadcastLobby();
  }

  function startGame(room) {
    const participants = room.members.filter(member => !member.isSpectator);
    room.game = E.createGame(participants.map(member => member.name), {dlcEnabled:room.dlcEnabled});
    if(room.game.dlc){
      const startedGame=room.game;
      room.taskTimer=setTimeout(()=>{
        if(room.game!==startedGame||!room.game.dlc.selecting)return;
        D.finishTaskSelection(room.game);broadcastGame(room);
      },30000);
      room.taskTimer.unref?.();
    }
    participants.forEach((member, index) => {
      member.playerId = index;
      if (member.socket) member.socket.playerId = index;
      room.game.players[index].connected = member.connected;
      room.game.players[index].avatar = member.avatar;
      if (member.isBot) {
        room.game.players[index].bot = true;
        room.game.players[index].difficulty = member.botDifficulty;
      }
    });
    room.members.filter(member => member.isSpectator).forEach((member) => {
      member.playerId = null;
      if (member.socket) member.socket.playerId = null;
    });
    // 人机在开局时自动选择 DLC 角色与任务
    if (room.game.dlc?.selecting) {
      const startedGame = room.game;
      let delay = 400;
      room.members.forEach((member, index) => {
        if (!member.isBot) return;
        const timer = setTimeout(() => {
          if (room.game !== startedGame || !room.game.dlc?.selecting) return;
          const player = room.game.players[index];
          if (player.dlc && !player.dlc.roleChosen) D.chooseRole(room.game, index, B.chooseRole(room.game, player, member.botDifficulty));
          if (player.dlc && !player.dlc.taskId) D.chooseTask(room.game, index, B.chooseTask(room.game, player, member.botDifficulty));
          broadcastGame(room);
        }, delay);
        timer.unref?.();
        delay += 250;
      });
    }
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

      if (isAuthRateLimited(ws, msg)) {
        send(ws, { type: 'authError', code: 'RATE_LIMITED', msg: '尝试过于频繁，请稍后再试' });
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

  function authAttemptKey(ws, msg) {
    return ws.serverDeviceId || String(msg.deviceId || '') || ws._socket?.remoteAddress || 'unknown';
  }

  function isAuthRateLimited(ws, msg) {
    const key = authAttemptKey(ws, msg);
    const now = Date.now();
    const entry = authAttempts.get(key);
    if (!entry || entry.resetAt <= now) {
      authAttempts.set(key, { count: 1, resetAt: now + authWindowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > authMaxAttempts;
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
    const participantCount = room.members.filter(item => !item.isSpectator).length;
    if (room.game || participantCount >= (room.testRoom ? 1 : MAX_PLAYERS)) {
      // 对局中，或参赛席位已满：自动进入观战席（任何人可进房间）
      const member = {
        playerId: null,
        identityKey: key,
        deviceIds: new Set([ws.deviceId]),
        name: ws.identity.nickname,
        avatar: 'dog',
        connected: true,
        socket: null,
        cleanupTimer: null,
        isSpectator: true,
        seatKey: crypto.randomBytes(8).toString('hex'),
      };
      room.members.push(member);
      console.log(`[join] 房间 ${room.id}，${member.name} 加入观战席`);
      attachToMember(ws, room, member, false);
      if (room.game) announceSpectatorJoin(room, member.name);
      return;
    }

    const member = {
      playerId: participantCount,
      identityKey: key,
      deviceIds: new Set([ws.deviceId]),
      name: ws.identity.nickname,
      avatar: ['dog','chick','fish','duck'][participantCount],
      connected: true,
      socket: null,
      cleanupTimer: null,
      isSpectator: false,
      seatKey: crypto.randomBytes(8).toString('hex'),
    };
    // 插入到最后一个真人参赛者之后、第一个人机/观战者之前（真人优先成为房主）
    let insertIndex = 0;
    for (let i = 0; i < room.members.length; i += 1) {
      if (!room.members[i].isSpectator && !room.members[i].isBot) insertIndex = i + 1;
    }
    room.members.splice(insertIndex, 0, member);
    reindexWaitingRoom(room);
    console.log(`[join] 房间 ${room.id}，${member.name}，当前人数 ${participantCount + 1}`);
    attachToMember(ws, room, member, false);
  }

  function handleLeaveRoom(ws) {
    const room = rooms.get(ws.roomId);
    if (!room) return sendError(ws, '你当前不在房间中', 'NOT_IN_ROOM');
    const key = identityKey(ws.identity);
    const member = room.members.find(item => item.socket === ws && item.identityKey === key);
    if (!member) return sendError(ws, '玩家席位不存在', 'NOT_IN_ROOM');
    if (room.game && !member.isSpectator) {
      ws.roomId = null;
      ws.playerId = null;
      releaseGameMember(room, member);
      send(ws, { type: 'leftRoom' });
      sendLobby(ws);
      return;
    }
    if (member.cleanupTimer) clearTimeout(member.cleanupTimer);
    member.socket = null;
    ws.roomId = null;
    ws.playerId = null;
    if (room.game) {
      // 对局中观战者离开：直接移除，不影响对局
      room.members = room.members.filter(item => item !== member);
      broadcastLobby();
    } else {
      removeWaitingMember(room, member);
    }
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
    if (game.gameOver) return sendError(ws, '游戏已经结束', 'GAME_OVER');
    if(msg.type==='chooseRole'){
      const result=D.chooseRole(game,ws.playerId,msg.role);
      if(!result.ok)return sendError(ws,result.reason,'INVALID_ROLE');
      broadcastGame(room);return;
    }
    if (msg.type === 'chooseTask') {
      const result = D.chooseTask(game,ws.playerId,msg.taskId);
      if(!result.ok)return sendError(ws,result.reason,'INVALID_TASK');
      broadcastGame(room);return;
    }
    if(game.dlc?.selecting)return sendError(ws,'请先选择角色和城镇任务，30秒后自动选择','TASK_SELECTION');
    if (ws.playerId !== game.current) return sendError(ws, '还没轮到你', 'NOT_YOUR_TURN');

    const player = game.players[game.current];
    if(msg.type==='useRole'){
      const result=D.useRole(game,player);
      if(!result.ok)return sendError(ws,result.reason,'ROLE_UNAVAILABLE');
      broadcastGame(room);return;
    }
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
      const allowed = game.pendingChoice.type==='askReroll' ? ['accept','reroll'] : [game.pendingChoice.type];
      if(!allowed.includes(msg.choice?.type))return sendError(ws,'请完成当前选择','INVALID_CHOICE');
      const result = E.handleChoice(game, player.id, msg.choice || {});
      if (!result.ok) return sendError(ws, result.error, 'INVALID_CHOICE');
      game.log.push(...result.events.map(text => ({ text, turn: game.turnNumber })));
      game.pendingChoice = result.needChoice || null;
      broadcastGame(room);
      return;
    }

    if (msg.type === 'buy') {
      const result = E.buyCard(game, msg.cardId, msg.discount || 'none');
      if (!result.ok) sendError(ws, result.reason, 'BUY_FAILED');
      broadcastGame(room);
      return;
    }

    if (msg.type === 'build') {
      const result = E.buildLandmark(game, msg.landmarkId, msg.discount || 'none');
      if (!result.ok) sendError(ws, result.reason, 'BUILD_FAILED');
      broadcastGame(room);
      return;
    }

    if (msg.type === 'endTurn') {
      if (game.pendingChoice) return sendError(ws, '还有选择未完成', 'PENDING_CHOICE');
      if (!game.settled || !game.dice) return sendError(ws,'请先掷骰并完成结算','NOT_SETTLED');
      if (E.isWin(player)) {
        broadcastGame(room);
        return;
      }
      E.endTurn(game);
      broadcastGame(room);
    }
  }

  // ---------- 人机驱动 ----------
  function botDelay() {
    return botTurnDelayMs + Math.floor(Math.random() * botJitterMs);
  }

  function scheduleBotDrive(room) {
    if (room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
    }
    const game = room.game;
    if (!game || game.gameOver || game.dlc?.selecting) return;
    const member = room.members[game.current];
    if (!member || !member.isBot) return;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      driveBotTurn(room);
    }, botDelay());
    room.botTimer.unref?.();
  }

  function clearTurnTimer(room) {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
  }

  function currentParticipant(room) {
    const game = room.game;
    if (!game) return null;
    return room.members.find(member => !member.isSpectator && member.playerId === game.current) || null;
  }

  function scheduleTurnTimer(room) {
    clearTurnTimer(room);
    const game = room.game;
    if (!game || game.gameOver || game.dlc?.selecting) return;
    const member = currentParticipant(room);
    if (!member || member.isBot) return;
    const delay = member.connected === false ? disconnectedTurnTimeoutMs : turnTimeoutMs;
    room.turnTimer = setTimeout(() => {
      room.turnTimer = null;
      autoPlayTurn(room);
    }, delay);
    room.turnTimer.unref?.();
  }

  function pushEvents(game, events) {
    if (!events || !events.length) return;
    game.log.push(...events.map(text => ({ text, turn: game.turnNumber })));
  }

  // 超时/掉线托管：按普通难度替当前玩家完成这一回合，避免对局卡死。
  function autoPlayTurn(room) {
    const game = room.game;
    if (!game || game.gameOver || game.dlc?.selecting) return;
    const member = currentParticipant(room);
    if (!member || member.isBot) return;
    const player = game.players[game.current];
    const difficulty = 'normal';
    let steps = 0;
    while (steps < 24 && room.game === game && !game.gameOver && !game.dlc?.selecting) {
      steps += 1;
      if (game.pendingChoice) {
        const choice = B.decideChoice(game, player, difficulty);
        const result = choice ? E.handleChoice(game, player.id, choice) : null;
        if (!result || !result.ok) {
          if (!game.settled && game.dice) {
            const settled = E.settle(game, player.id, game.dice.sum);
            pushEvents(game, settled.events);
            game.settled = true;
          }
          game.pendingChoice = null;
        } else {
          pushEvents(game, result.events);
          game.pendingChoice = result.needChoice || null;
        }
        continue;
      }
      if (!game.dice) {
        const count = B.decideRollCount(game, player, difficulty);
        game.dice = { ...E.rollDice(count), firstCount: count };
        game.rerolled = false;
        game.settled = false;
        if (E.canReroll(game, player)) {
          game.pendingChoice = { type: 'askReroll', rollerId: player.id };
        } else {
          const result = E.settle(game, player.id, game.dice.sum);
          pushEvents(game, result.events);
          game.settled = true;
          if (result.needChoice) game.pendingChoice = result.needChoice;
        }
        continue;
      }
      if (!game.settled) break;
      if (game.dlc && player.dlc?.role === 4) D.useRole(game, player);
      if (!game.boughtThisTurn) {
        const buy = B.decideBuy(game, player, difficulty);
        if (buy && E.canBuy(game, buy.cardId, buy.source).ok) E.buyCard(game, buy.cardId, buy.source);
      }
      if (!game.builtThisTurn) {
        const build = B.decideBuild(game, player, difficulty);
        if (build && E.canBuild(game, build.landmarkId, build.source).ok) E.buildLandmark(game, build.landmarkId, build.source);
      }
      if (game.pendingChoice) continue;
      if (E.isWin(player) || game.gameOver) break;
      const ended = E.endTurn(game);
      // 只有广播中心给的额外回合才继续托管；单人房间 current 会绕回自己，不能靠 current 判断。
      if (ended.gameOver || !ended.extraTurn || game.gameOver) break;
    }
    console.log(`[turn] 房间 ${room.id}：${player.name} 超时未操作，已自动完成回合`);
    broadcastGame(room);
  }

  function driveBotTurn(room) {
    const game = room.game;
    if (!game || game.gameOver || game.dlc?.selecting) return;
    const member = room.members[game.current];
    if (!member || !member.isBot) return;
    const player = game.players[game.current];

    // 1. 待选抉择（重掷/体育馆/电视塔/商场）
    if (game.pendingChoice) {
      const choice = B.decideChoice(game, player, member.botDifficulty);
      let result = null;
      if (choice) {
        result = E.handleChoice(game, player.id, choice);
        if (!result.ok) {
          console.error(`[bot] 房间 ${room.id} 抉择失败：${result.error} ${JSON.stringify(choice)}`);
          result = null;
        }
      }
      if (!result) {
        // 兜底：接受当前点数并完成结算，避免卡死
        if (!game.settled && game.dice) {
          const settled = E.settle(game, player.id, game.dice.sum);
          game.log.push(...settled.events.map(text => ({ text, turn: game.turnNumber })));
          game.settled = true;
        }
        game.pendingChoice = null;
      } else {
        game.log.push(...result.events.map(text => ({ text, turn: game.turnNumber })));
        game.pendingChoice = result.needChoice || null;
      }
      broadcastGame(room);
      return;
    }

    // 2. 掷骰
    if (!game.dice) {
      const count = B.decideRollCount(game, player, member.botDifficulty);
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

    // 3. 结算后：会计技能 → 购卡 → 建设 → 结束回合
    if (game.settled) {
      if (game.dlc && player.dlc?.role === 4 && D.useRole(game, player).ok) {
        broadcastGame(room);
        return;
      }
      if (!game.boughtThisTurn) {
        const buy = B.decideBuy(game, player, member.botDifficulty);
        if (buy && E.canBuy(game, buy.cardId, buy.source).ok) {
          E.buyCard(game, buy.cardId, buy.source);
          broadcastGame(room);
          return;
        }
      }
      if (!game.builtThisTurn) {
        const build = B.decideBuild(game, player, member.botDifficulty);
        if (build && E.canBuild(game, build.landmarkId, build.source).ok) {
          E.buildLandmark(game, build.landmarkId, build.source);
          broadcastGame(room);
          return;
        }
      }
      if (game.pendingChoice) {
        broadcastGame(room);
        return;
      }
      if (E.isWin(player)) {
        broadcastGame(room);
        return;
      }
      E.endTurn(game);
      broadcastGame(room);
      return;
    }
    broadcastGame(room);
  }

  function disconnectFromRoom(ws) {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const member = room.members.find(item => item.socket === ws);
    if (!member || ws.replaced) return;
    member.socket = null;
    member.connected = false;
    if (member.isSpectator) {
      // 观战者断线：30 秒后仍未重连则移出房间
      member.cleanupTimer = setTimeout(() => {
        if (!member.connected && member.socket === null && rooms.get(room.id) === room) {
          room.members = room.members.filter(item => item !== member);
          if (!room.game) sendWaiting(room);
          broadcastLobby();
        }
      }, WAITING_SEAT_TTL_MS);
      member.cleanupTimer.unref?.();
      broadcastLobby();
      return;
    }
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
      try {
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
        const room = createRoom(msg.dlcEnabled);
        broadcastLobby();
        send(ws, { type: 'roomCreated', roomId: room.id });
        return;
      }
      if(msg.type==='setDlc'){
        const room=rooms.get(ws.roomId);
        if(!room||room.game)return sendError(ws,'只能在等待开局时修改DLC','SETTINGS_LOCKED');
        if(room.members[0]?.socket!==ws)return sendError(ws,'只有房主可以修改DLC','HOST_ONLY');
        if(typeof msg.enabled!=='boolean')return sendError(ws,'DLC开关值无效','INVALID_SETTING');
        room.dlcEnabled=msg.enabled;sendWaiting(room);broadcastLobby();return;
      }
      if (msg.type === 'requestLobby') return sendLobby(ws);
      if (msg.type === 'requestRoom') {
        const room = rooms.get(ws.roomId);
        if (!room) return sendError(ws, '你当前不在房间中', 'NOT_IN_ROOM');
        sendWaitingTo(ws, room);
        return;
      }
      if (msg.type === 'chat') return handleChat(ws, msg);
      if (msg.type === 'logout') {
        if (ws.roomId) return sendError(ws, '请先退出当前房间', 'LEAVE_ROOM_FIRST');
        sessions.delete(ws.sessionToken);
        ws.identity = null;
        ws.sessionToken = null;
        send(ws, { type: 'loggedOut' });
        return;
      }
      if(msg.type==='setAvatar'||msg.type==='startTest'){
        const room=rooms.get(ws.roomId),member=room?.members[ws.playerId];
        if(!member||member.socket!==ws)return sendError(ws,'当前没有玩家席位');
        if(msg.type==='startTest'){
          if(!room.testRoom||room.game)return sendError(ws,'仅等待中的测试房间可手动开始');
          startGame(room);return;
        }
        if(!['dog','chick','fish','duck'].includes(msg.avatar))return sendError(ws,'无效头像');
        member.avatar=msg.avatar;
        if(room.game){room.game.players[ws.playerId].avatar=msg.avatar;broadcastGame(room);}else sendWaiting(room);
        return;
      }
      if (msg.type === 'addBot') {
        const room = rooms.get(ws.roomId);
        if (!room) return sendError(ws, '你当前不在房间中', 'NOT_IN_ROOM');
        if (room.game) return sendError(ws, '游戏已经开始', 'ROOM_STARTED');
        if (room.testRoom) return sendError(ws, '测试房间不能添加人机', 'TEST_ROOM');
        if (room.members[0]?.socket !== ws) return sendError(ws, '只有房主可以添加人机', 'HOST_ONLY');
        const difficulty = String(msg.difficulty || '');
        if (!B.DIFFICULTIES.includes(difficulty)) return sendError(ws, '人机难度无效', 'INVALID_BOT');
        const participantCount = room.members.filter(item => !item.isSpectator).length;
        if (participantCount >= MAX_PLAYERS) return sendError(ws, '房间已满，没有空位', 'ROOM_FULL');
        // 编号按当前空位复用：同一难度最多 1-3 号，移除后新加的人机补用最小空号
        const usedSeqs = room.members
          .filter(item => item.isBot && item.botDifficulty === difficulty)
          .map(item => item.botSeq);
        let seq = 1;
        while (usedSeqs.includes(seq)) seq += 1;
        const member = {
          playerId: participantCount,
          identityKey: null,
          deviceIds: new Set(),
          name: `${B.BOT_LABELS[difficulty]}人机·${seq}`,
          botSeq: seq,
          avatar: ['dog','chick','fish','duck'][participantCount],
          connected: true,
          socket: null,
          cleanupTimer: null,
          isBot: true,
          isSpectator: false,
          botDifficulty: difficulty,
          seatKey: crypto.randomBytes(8).toString('hex'),
        };
        // 插入到观战者之前，保持参赛者在成员列表前部
        let insertIndex = room.members.length;
        for (let i = 0; i < room.members.length; i += 1) {
          if (room.members[i].isSpectator) { insertIndex = i; break; }
        }
        room.members.splice(insertIndex, 0, member);
        console.log(`[bot] 房间 ${room.id} 添加${B.BOT_LABELS[difficulty]}人机，当前人数 ${participantCount + 1}`);
        sendWaiting(room);
        broadcastLobby();
        return;
      }
      if (msg.type === 'removeBot') {
        const room = rooms.get(ws.roomId);
        if (!room) return sendError(ws, '你当前不在房间中', 'NOT_IN_ROOM');
        if (room.game) return sendError(ws, '游戏已经开始', 'ROOM_STARTED');
        if (room.members[0]?.socket !== ws) return sendError(ws, '只有房主可以移除人机', 'HOST_ONLY');
        const index = Number(msg.playerId);
        const target = room.members[index];
        if (!target || !target.isBot) return sendError(ws, '该席位不是人机', 'INVALID_BOT');
        room.members.splice(index, 1);
        reindexWaitingRoom(room);
        sendWaiting(room);
        broadcastLobby();
        return;
      }
      if (msg.type === 'toggleSeat') {
        const room = rooms.get(ws.roomId);
        if (!room) return sendError(ws, '你当前不在房间中', 'NOT_IN_ROOM');
        if (room.game) return sendError(ws, '只能在等待开局时切换席位', 'SETTINGS_LOCKED');
        if (room.testRoom) return sendError(ws, '单人测试房不支持观战席', 'TEST_ROOM');
        const member = room.members.find(item => item.socket === ws && item.identityKey === identityKey(ws.identity));
        if (!member) return sendError(ws, '当前没有席位', 'NOT_IN_ROOM');
        const participants = room.members.filter(item => !item.isSpectator);
        const switchingToSpectator = !member.isSpectator; // 先记录切换方向，再翻转标记
        if (member.isSpectator) {
          // 观战席 → 参赛席（有空位时）
          if (participants.length >= MAX_PLAYERS) return sendError(ws, '参赛席位已满', 'ROOM_FULL');
          member.isSpectator = false;
        } else {
          // 参赛席 → 观战席（必须保留至少一名参赛玩家）
          if (participants.length <= 1) return sendError(ws, '你是唯一的参赛玩家，无法切换到观战席', 'ONLY_PARTICIPANT');
          member.isSpectator = true;
        }
        // 重排：真人参赛者在前（保持原顺序），人机随后，观战者在最后。
        // 观战 → 参赛：插到最后一个真人参赛者之后、第一个人机之前，保证真人优先成为房主。
        const others = room.members.filter(item => item !== member);
        if (!switchingToSpectator) {
          const humans = others.filter(item => !item.isSpectator && !item.isBot);
          const bots = others.filter(item => !item.isSpectator && item.isBot);
          const spectators = others.filter(item => item.isSpectator);
          room.members = [...humans, member, ...bots, ...spectators];
        } else {
          const humans = others.filter(item => !item.isSpectator && !item.isBot);
          const bots = others.filter(item => !item.isSpectator && item.isBot);
          const spectators = others.filter(item => item.isSpectator);
          room.members = [...humans, ...bots, ...spectators, member];
        }
        reindexWaitingRoom(room);
        sendWaiting(room);
        broadcastLobby();
        return;
      }
      if (msg.type === 'returnToRoom') {
        const room = rooms.get(ws.roomId);
        if (!room || !room.game || !room.game.gameOver) return sendError(ws, '当前对局尚未结束', 'GAME_NOT_OVER');
        resetGameToWaiting(room);
        return;
      }
      if (msg.type === 'startGame') {
        const room = rooms.get(ws.roomId);
        if (!room) return sendError(ws, '你当前不在房间中', 'NOT_IN_ROOM');
        if (room.game) return sendError(ws, '游戏已经开始', 'ROOM_STARTED');
        if (room.members[0]?.socket !== ws) return sendError(ws, '只有房主可以开始游戏', 'HOST_ONLY');
        const participantCount = room.members.filter(item => !item.isSpectator).length;
        if (participantCount < 2) return sendError(ws, '至少需要 2 名参赛玩家才能开始', 'NOT_ENOUGH_PLAYERS');
        startGame(room);
        return;
      }
      if (['roll', 'choice', 'buy', 'build', 'endTurn', 'chooseTask', 'chooseRole', 'useRole'].includes(msg.type)) {
        handleGameAction(ws, msg);
      }
      } catch (messageError) {
        console.error(`[ws] 消息处理异常：${messageError.stack || messageError.message}`);
        sendError(ws, '服务器处理消息失败', 'INTERNAL_ERROR');
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
    for (const [key, entry] of authAttempts) {
      if (entry.resetAt <= now) authAttempts.delete(key);
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
