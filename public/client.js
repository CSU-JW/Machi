let ws = null;
let reconnectTimer = null;
let myId = null;
let game = null;
let roomId = null;
let currentUser = null;
let kicked = false;

const SESSION_KEY = 'machi_session_token';
const DEVICE_KEY = 'machi_device_id';

function getDeviceId() {
  let value = localStorage.getItem(DEVICE_KEY);
  if (!value) {
    value = window.crypto?.randomUUID?.().replace(/-/g, '')
      || `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, value);
  }
  return value;
}

function showScreen(id) {
  for (const element of document.querySelectorAll('.screen')) element.classList.remove('active');
  document.getElementById(id).classList.add('active');
}

function setAuthMessage(message) {
  document.getElementById('authMessage').textContent = message || '';
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert('正在连接服务器，请稍后再试');
    return false;
  }
  ws.send(JSON.stringify(payload));
  return true;
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${scheme}://${location.host}`);

  ws.onopen = () => {
    document.getElementById('connectionStatus').style.display = 'none';
    const sessionToken = localStorage.getItem(SESSION_KEY);
    if (sessionToken) send({ type: 'resumeSession', sessionToken });
    else showScreen('auth');
  };

  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'hello') return;

    if (msg.type === 'authenticated') {
      localStorage.setItem(SESSION_KEY, msg.sessionToken);
      if (msg.deviceId) localStorage.setItem(DEVICE_KEY, msg.deviceId);
      currentUser = msg.user;
      kicked = false;
      setAuthMessage('');
      const label = msg.user.kind === 'account'
        ? `${msg.user.nickname}（账号：${msg.user.username}）`
        : `${msg.user.nickname}（游客）`;
      document.getElementById('profileName').textContent = label;
      document.getElementById('gameProfile').textContent = label;
      return;
    }

    if (msg.type === 'authRequired') {
      localStorage.removeItem(SESSION_KEY);
      currentUser = null;
      roomId = null;
      myId = null;
      game = null;
      showScreen('auth');
      setAuthMessage(msg.msg || '请登录');
      return;
    }

    if (msg.type === 'authError') {
      setAuthMessage(msg.msg || '登录失败');
      return;
    }

    if (msg.type === 'loggedOut') {
      localStorage.removeItem(SESSION_KEY);
      currentUser = null;
      roomId = null;
      myId = null;
      game = null;
      showScreen('auth');
      setAuthMessage('已安全退出');
      return;
    }

    if (msg.type === 'lobby') {
      renderLobby(msg.rooms || []);
      if (currentUser && roomId === null) showScreen('lobby');
      return;
    }

    if (msg.type === 'roomCreated') {
      joinRoom(msg.roomId);
      return;
    }

    if (msg.type === 'roomJoined') {
      roomId = String(msg.roomId);
      myId = msg.playerId;
      game = null;
      document.getElementById('waitingRoomId').textContent = roomId;
      showScreen('waiting');
      return;
    }

    if (msg.type === 'waiting') {
      roomId = String(msg.roomId);
      renderWaiting(msg);
      showScreen('waiting');
      return;
    }

    if (msg.type === 'leftRoom') {
      roomId = null;
      myId = null;
      game = null;
      showScreen('lobby');
      send({ type: 'requestLobby' });
      return;
    }

    if (msg.type === 'state') {
      game = msg.game;
      showScreen('game');
      document.getElementById('roomInfo').textContent = `（房间 ${roomId}，${myId + 1} 号玩家）`;
      render();
      return;
    }

    if (msg.type === 'kick') {
      kicked = true;
      document.getElementById('connectionStatus').style.display = 'none';
      showScreen('auth');
      setAuthMessage(msg.msg || '当前玩家身份已在其他页面连接');
      return;
    }

    if (msg.type === 'error') {
      alert(msg.msg || '操作失败');
    }
  };

  ws.onclose = () => {
    ws = null;
    if (kicked) return;
    document.getElementById('connectionStatus').style.display = 'block';
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => ws?.close();
}

function renderLobby(rooms) {
  const container = document.getElementById('rooms');
  container.replaceChildren();
  for (const room of rooms) {
    const card = document.createElement('article');
    card.className = 'panel room-card';

    const title = document.createElement('div');
    title.className = 'room-title';
    const heading = document.createElement('h3');
    heading.textContent = `房间 ${room.id}`;
    const status = document.createElement('span');
    status.className = `status${room.status === 'playing' ? ' playing' : ''}`;
    status.textContent = room.status === 'playing' ? '游戏中' : '等待中';
    title.append(heading, status);

    const count = document.createElement('div');
    count.className = 'room-count';
    count.textContent = `${room.playerCount} / ${room.capacity} 位玩家`;
    const players = document.createElement('div');
    players.className = 'room-players';
    players.textContent = room.players.length ? room.players.join('、') : '暂无玩家，等你加入';
    const button = document.createElement('button');
    button.className = 'primary';
    button.disabled = room.status === 'playing' || room.playerCount >= room.capacity;
    button.textContent = room.status === 'playing' ? '游戏已开始' : room.playerCount >= room.capacity ? '房间已满' : '加入房间';
    button.addEventListener('click', () => joinRoom(room.id));
    card.append(title, count, players, button);
    container.appendChild(card);
  }
}

function renderWaiting(msg) {
  document.getElementById('waitingRoomId').textContent = msg.roomId;
  document.getElementById('waitingText').textContent = `还差 ${msg.need} 人，满 4 人后自动开始游戏`;
  const list = document.getElementById('waitingPlayers');
  list.replaceChildren();
  for (let index = 0; index < 4; index += 1) {
    const seat = document.createElement('div');
    const player = msg.players[index];
    if (player) {
      seat.className = `seat${player.connected === false ? ' offline' : ''}`;
      seat.textContent = `${index + 1} 号位 · ${player.name}${player.id === myId ? '（你）' : ''}${player.connected === false ? ' · 离线' : ''}`;
    } else {
      seat.className = 'seat empty';
      seat.textContent = `${index + 1} 号位 · 等待玩家`;
    }
    list.appendChild(seat);
  }
}

function joinRoom(id) { send({ type: 'joinRoom', roomId: String(id) }); }

document.querySelectorAll('.tab').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === button));
    document.querySelectorAll('.auth-form').forEach(form => form.classList.toggle('active', form.id === `${button.dataset.tab}Form`));
    setAuthMessage('');
  });
});

document.getElementById('loginForm').addEventListener('submit', event => {
  event.preventDefault();
  setAuthMessage('');
  send({
    type: 'login',
    username: document.getElementById('loginUsername').value,
    password: document.getElementById('loginPassword').value,
    deviceId: getDeviceId(),
  });
});

document.getElementById('registerForm').addEventListener('submit', event => {
  event.preventDefault();
  setAuthMessage('');
  send({
    type: 'register',
    username: document.getElementById('registerUsername').value,
    nickname: document.getElementById('registerNickname').value,
    password: document.getElementById('registerPassword').value,
    deviceId: getDeviceId(),
  });
});

document.getElementById('guestForm').addEventListener('submit', event => {
  event.preventDefault();
  setAuthMessage('');
  send({
    type: 'guestLogin',
    nickname: document.getElementById('guestNickname').value,
    deviceId: getDeviceId(),
  });
});

document.getElementById('createRoomButton').addEventListener('click', () => send({ type: 'createRoom' }));
document.getElementById('leaveRoomButton').addEventListener('click', () => send({ type: 'leaveRoom' }));
document.getElementById('leaveGameButton').addEventListener('click', () => {
  if (confirm('退出后将放弃本局席位，且不能再回到这局游戏。确定退出吗？')) send({ type: 'leaveRoom' });
});
document.getElementById('logoutButton').addEventListener('click', () => send({ type: 'logout' }));

const CARD_NAMES = {
  wheat:'麦田', ranch:'牧场', bakery:'面包店', cafe:'咖啡店',
  convenience:'便利店', forest:'林场', stadium:'体育馆',
  tvStation:'电视塔', mall:'商场', dairy:'奶制品工厂',
  orchard:'果园', mine:'矿山', teaHouse:'奶茶店',
  craft:'工艺品工厂', farm:'农产品工厂',
};
const CARD_POINTS = {
  wheat:[1], ranch:[2], bakery:[2,3], cafe:[3], convenience:[4],
  forest:[5], stadium:[6], tvStation:[6], mall:[6], dairy:[7],
  orchard:[8], mine:[9], teaHouse:[9,10], craft:[10], farm:[11,12],
};
const CARD_COSTS = {
  wheat:1, ranch:2, bakery:2, cafe:2, convenience:2, forest:3,
  stadium:6, tvStation:6, mall:7, dairy:3, orchard:3, mine:3,
  teaHouse:3, craft:3, farm:2,
};
const CARD_TYPE = {
  wheat:'any', ranch:'any', forest:'any', bakery:'self', convenience:'self',
  dairy:'self', orchard:'self', mine:'self', craft:'self', farm:'self',
  cafe:'other', teaHouse:'other', stadium:'six', tvStation:'six', mall:'six',
};
const SIX_CARDS = ['stadium','tvStation','mall'];
const LANDMARK_NAMES = { train:'火车站', radio:'广播中心', mallC:'商业中心', park:'游乐园' };
const LANDMARK_COSTS = { train:4, radio:16, mallC:13, park:22 };

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function findMe() {
  if (!game || myId === null) return null;
  return game.players.find(player => player.id === myId);
}

let lastDiceKey = '';
function animateDice(realSum, realValues) {
  const element = document.getElementById('dice');
  const key = `${realValues.join('+')}|${realSum}`;
  if (key === lastDiceKey) return;
  lastDiceKey = key;
  element.classList.add('rolling');
  let count = 0;
  const timer = setInterval(() => {
    element.textContent = `🎲 ${1 + Math.floor(Math.random() * 12)}`;
    count += 1;
    if (count >= 8) {
      clearInterval(timer);
      element.classList.remove('rolling');
      element.textContent = `🎲 ${realSum} (${realValues.join(' + ')})`;
    }
  }, 60);
}

function render() {
  if (!game) return;
  const me = findMe();
  const banner = document.getElementById('turnBanner');
  const currentPlayer = game.players[game.current];
  if (me && game.current === me.id) {
    const extraTurnText = game.extraTurn ? ' · 广播中心已触发，结束后再行动一次' : '';
    banner.textContent = `⚡ 轮到你了（第 ${game.turnNumber} 回合）${extraTurnText}`;
    banner.classList.add('me');
  } else {
    banner.textContent = `⏳ 轮到 ${currentPlayer.name}（第 ${game.turnNumber} 回合）`;
    banner.classList.remove('me');
  }

  if (game.dice) animateDice(game.dice.sum, game.dice.values);
  else {
    document.getElementById('dice').textContent = '';
    lastDiceKey = '';
  }

  const playersElement = document.getElementById('players');
  playersElement.innerHTML = '';
  game.players.forEach((player, index) => {
    const card = document.createElement('div');
    card.className = `player${index === game.current ? ' active' : ''}${player.connected === false ? ' offline' : ''}`;
    const cardText = Object.keys(player.cards).filter(id => player.cards[id] > 0)
      .map(id => `<span class="tag tag-${CARD_TYPE[id] || 'self'}">${escapeHtml(CARD_NAMES[id] || id)}×${player.cards[id]}</span>`)
      .join('') || '<span style="color:#aaa">无</span>';
    const landmarkText = Object.keys(player.landmarks).filter(id => player.landmarks[id])
      .map(id => `<span class="tag tag-landmark">${escapeHtml(LANDMARK_NAMES[id] || id)}</span>`)
      .join('') || '<span style="color:#aaa">无</span>';
    const offlineBadge = player.connected === false ? '<span class="badge-offline">离线</span>' : '';
    card.innerHTML = `
      <h3>${escapeHtml(player.name)}${me && player.id === me.id ? '（你）' : ''}${offlineBadge}</h3>
      <div class="money">💰 ${player.money}</div>
      <div class="cards">${cardText}</div>
      <div class="landmarks">${landmarkText}</div>`;
    playersElement.appendChild(card);
  });

  if (game.cardPool) {
    const pool = document.createElement('div');
    pool.style.cssText = 'width:100%;font-size:12px;color:#888;margin-top:8px';
    const poolText = Object.keys(game.cardPool).filter(id => game.cardPool[id] > 0)
      .map(id => `${CARD_NAMES[id] || id}:${game.cardPool[id]}`).join('  ');
    pool.textContent = `[牌堆] ${poolText}`;
    playersElement.appendChild(pool);
  }

  const actions = document.getElementById('actions');
  actions.innerHTML = '';
  const isMyTurn = me && game.current === me.id;
  if (isMyTurn && game.pendingChoice) {
    renderPendingChoice(actions, me);
    renderLog();
    return;
  }

  if (!me) actions.textContent = '正在同步身份…';
  else if (isMyTurn) {
    if (!game.dice) {
      addAction(actions, '掷 1 个骰子', { type: 'roll', count: 1 });
      if (me.landmarks.train) addAction(actions, '掷 2 个骰子', { type: 'roll', count: 2 });
    } else if (game.settled) {
      if (!game.boughtThisTurn) {
        for (const id of Object.keys(CARD_NAMES)) {
          if (CARD_POINTS[id].includes(game.dice.sum)) addAction(actions, `买 ${CARD_NAMES[id]} (${CARD_COSTS[id]}元)`, { type: 'buy', cardId: id });
        }
      } else {
        const note = document.createElement('span');
        note.textContent = '（本回合已购买过）';
        note.style.cssText = 'color:#888;margin-right:8px';
        actions.appendChild(note);
      }
      if (!game.builtThisTurn) {
        for (const id of Object.keys(LANDMARK_NAMES)) {
          if (!me.landmarks[id]) addAction(actions, `建 ${LANDMARK_NAMES[id]} (${LANDMARK_COSTS[id]}元)`, { type: 'build', landmarkId: id });
        }
      } else {
        const buildNote = document.createElement('span');
        buildNote.textContent = '（本回合已建设过地标）';
        buildNote.style.cssText = 'color:#888;margin-right:8px';
        actions.appendChild(buildNote);
      }
      addAction(actions, '结束回合', { type: 'endTurn' });
    } else actions.textContent = '等待结算…';
  } else actions.textContent = '等待其他玩家…';
  renderLog();
}

function addAction(container, label, payload) {
  const button = document.createElement('button');
  button.textContent = label;
  if (payload) button.addEventListener('click', () => send(payload));
  container.appendChild(button);
  return button;
}

function addTip(container, text) {
  const tip = document.createElement('div');
  tip.textContent = text;
  tip.style.cssText = 'width:100%;margin-bottom:8px;font-weight:bold';
  container.appendChild(tip);
}

function renderPendingChoice(container, me) {
  const choice = game.pendingChoice;
  if (choice.type === 'askReroll') {
    addTip(container, `你掷出了 ${game.dice.sum}，是否接受？`);
    addAction(container, '接受点数，结算', { type:'choice', choice:{ type:'accept' } });
    if (me.landmarks.park) {
      addAction(container, '重掷 1 个骰子', { type:'choice', choice:{ type:'reroll', count:1 } });
      if (me.landmarks.train) addAction(container, '重掷 2 个骰子', { type:'choice', choice:{ type:'reroll', count:2 } });
    }
    return;
  }
  if (choice.type === 'askStadium') {
    addTip(container, '体育馆：是否向全场其他玩家各收 2 元？');
    addAction(container, '发动', { type:'choice', choice:{ type:'askStadium', activate:true } });
    addAction(container, '不发动', { type:'choice', choice:{ type:'askStadium', activate:false } });
    return;
  }
  if (choice.type === 'askTv') {
    addTip(container, '电视塔：是否向一名玩家收取 5 元？');
    addAction(container, '发动', { type:'choice', choice:{ type:'askTv', activate:true } });
    addAction(container, '不发动', { type:'choice', choice:{ type:'askTv', activate:false } });
    return;
  }
  if (choice.type === 'tvPickTarget') {
    addTip(container, '电视塔：选择一名玩家，收取 5 元');
    game.players.filter(player => player.id !== me.id).forEach(player => {
      addAction(container, player.name, { type:'choice', choice:{ type:'tvPickTarget', targetId:player.id } });
    });
    return;
  }
  if (choice.type === 'askMall') {
    addTip(container, '商场：是否与一名玩家交换卡牌？');
    addAction(container, '发动', { type:'choice', choice:{ type:'askMall', activate:true } });
    addAction(container, '不发动', { type:'choice', choice:{ type:'askMall', activate:false } });
    return;
  }
  if (choice.type === 'mallPickTarget') {
    addTip(container, '商场：选择一个玩家进行交换');
    game.players.filter(player => player.id !== me.id).forEach(player => {
      const hasCards = Object.keys(player.cards).some(id => player.cards[id] > 0 && !SIX_CARDS.includes(id));
      const button = addAction(container, `${player.name}${hasCards ? '' : '（无可交换卡）'}`, { type:'choice', choice:{ type:'mallPickTarget', targetId:player.id } });
      button.disabled = !hasCards;
    });
    return;
  }
  if (choice.type === 'mallPickCards') {
    const target = game.players.find(player => player.id === choice.targetId);
    addTip(container, `商场：与 ${target.name} 交换。先选你的一张卡，再选对方的一张卡`);
    let mine = null;
    let theirs = null;
    const mineBox = document.createElement('div');
    const targetBox = document.createElement('div');
    mineBox.style.cssText = targetBox.style.cssText = 'width:100%;margin-bottom:6px';
    const mineLabel = document.createElement('span');
    mineLabel.textContent = '你的卡：';
    mineBox.appendChild(mineLabel);
    const targetLabel = document.createElement('span');
    targetLabel.textContent = `${target.name} 的卡：`;
    targetBox.appendChild(targetLabel);
    const trySubmit = () => {
      if (mine && theirs) send({ type:'choice', choice:{ type:'mallPickCards', targetId:target.id, myCardId:mine, targetCardId:theirs } });
    };
    Object.keys(me.cards).filter(id => me.cards[id] > 0 && !SIX_CARDS.includes(id)).forEach(id => {
      const button = addAction(mineBox, `${CARD_NAMES[id]}×${me.cards[id]}`, null);
      button.onclick = () => { mine = id; mineBox.querySelectorAll('button').forEach(item => item.style.outline = ''); button.style.outline = '2px solid #4caf50'; trySubmit(); };
    });
    Object.keys(target.cards).filter(id => target.cards[id] > 0 && !SIX_CARDS.includes(id)).forEach(id => {
      const button = addAction(targetBox, `${CARD_NAMES[id]}×${target.cards[id]}`, null);
      button.onclick = () => { theirs = id; targetBox.querySelectorAll('button').forEach(item => item.style.outline = ''); button.style.outline = '2px solid #4caf50'; trySubmit(); };
    });
    container.append(mineBox, targetBox);
    return;
  }
  container.textContent = '等待选择…';
}

function renderLog() {
  const log = document.getElementById('log');
  log.replaceChildren();
  let lastTurn = null;
  for (const entry of (game.log || []).slice(-80)) {
    const text = typeof entry === 'string' ? entry : entry.text;
    const turn = typeof entry === 'string' ? null : entry.turn;
    if (turn !== null && turn !== lastTurn) {
      const separator = document.createElement('div');
      separator.className = 'turn-sep';
      separator.textContent = `—— 第 ${turn} 回合 ——`;
      log.appendChild(separator);
      lastTurn = turn;
    }
    const line = document.createElement('div');
    line.textContent = text;
    log.appendChild(line);
  }
  log.scrollTop = log.scrollHeight;
}

getDeviceId();
connect();
