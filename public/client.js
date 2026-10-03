let ws = null;
let reconnectTimer = null;
let myId = null;
let game = null;
let roomId = null;
let currentUser = null;
let kicked = false;
let lastGameOverKey = '';
let cardModalPayload = null;

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
      lastGameOverKey = '';
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
      lastGameOverKey = '';
      closeCardModal();
      closeGameOverModal();
      showScreen('lobby');
      send({ type: 'requestLobby' });
      return;
    }

    if (msg.type === 'state') {
      game = msg.game;
      showScreen('game');
      document.getElementById('roomInfo').textContent = `（房间 ${roomId}，${myId + 1} 号玩家）`;
      render();
      if (game.gameOver) showGameOver();
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
document.getElementById('cardModalClose').addEventListener('click', closeCardModal);
document.getElementById('cardModalCancel').addEventListener('click', closeCardModal);
document.getElementById('cardConfirmButton').addEventListener('click', () => {
  if (!cardModalPayload) return;
  const payload = cardModalPayload;
  closeCardModal();
  send(payload);
});
document.getElementById('cardModal').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeCardModal();
});
document.getElementById('gameOverClose').addEventListener('click', closeGameOverModal);
document.getElementById('gameOverLobby').addEventListener('click', () => {
  closeGameOverModal();
  send({ type: 'leaveRoom' });
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  closeCardModal();
  closeGameOverModal();
});

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
const CARD_IMAGES = {
  wheat:'wheat.jpg', ranch:'ranch.jpg', bakery:'bakery.jpg', cafe:'cafe.jpg',
  convenience:'convenience.jpg', forest:'forest.jpg', stadium:'stadium.jpg',
  tvStation:'tv-station.jpg', mall:'mall.jpg', dairy:'dairy.jpg',
  orchard:'orchard.jpg', mine:'mine.jpg', teaHouse:'tea-house.jpg',
  craft:'craft.jpg', farm:'farm.jpg',
};
const CARD_DESCRIPTIONS = {
  wheat:'任意玩家掷出 1：你获得 1 元。',
  ranch:'任意玩家掷出 2：你获得 1 元。',
  bakery:'自己掷出 2～3：你获得 1 元。',
  cafe:'他人掷出 3：向该玩家收取 1 元。',
  convenience:'自己掷出 4：你获得 3 元。',
  forest:'任意玩家掷出 5：你获得 1 元。',
  stadium:'自己掷出 6：可向其他玩家各收取最多 2 元。',
  tvStation:'自己掷出 6：可选择一名玩家，收取最多 5 元。',
  mall:'自己掷出 6：可与一名玩家交换一张非 6 点卡牌。',
  dairy:'自己掷出 7：每张牧场带来 2 元。',
  orchard:'自己掷出 8：每张林场带来 2 元。',
  mine:'自己掷出 9：每张矿山按矿山数量带来 2 元。',
  teaHouse:'他人掷出 9～10：每张向该玩家收取最多 2 元。',
  craft:'自己掷出 10：每张林场和矿山带来 2 元。',
  farm:'自己掷出 11～12：每张麦田和果园带来 2 元。',
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

function cardPointLabel(cardId) {
  const points = CARD_POINTS[cardId] || [];
  if (points.length > 1 && points.every((point, index) => index === 0 || point === points[index - 1] + 1)) {
    return `${points[0]}～${points[points.length - 1]}`;
  }
  return points.join(' / ');
}

function closeCardModal() {
  const modal = document.getElementById('cardModal');
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
  cardModalPayload = null;
}

function openCardModal(cardId, options = {}) {
  const modal = document.getElementById('cardModal');
  document.getElementById('cardModalArt').src = `assets/cards/${CARD_IMAGES[cardId]}`;
  document.getElementById('cardModalArt').alt = `${CARD_NAMES[cardId]}卡通图`;
  document.getElementById('cardModalPoints').textContent = `🎲 ${cardPointLabel(cardId)}`;
  document.getElementById('cardModalCost').textContent = `🪙 ${CARD_COSTS[cardId]}`;
  document.getElementById('cardModalTitle').textContent = CARD_NAMES[cardId];
  document.getElementById('cardModalDescription').textContent = CARD_DESCRIPTIONS[cardId];

  const status = document.getElementById('cardModalStatus');
  status.textContent = options.status || '';
  status.classList.toggle('error', Boolean(options.disabledReason));

  const confirmButton = document.getElementById('cardConfirmButton');
  cardModalPayload = options.payload || null;
  confirmButton.hidden = !options.showConfirm;
  confirmButton.disabled = Boolean(options.disabledReason) || !cardModalPayload;
  confirmButton.textContent = options.confirmLabel || '确认购买';
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('cardModalClose').focus();
}

function createCardTile(cardId, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `game-card card-${CARD_TYPE[cardId] || 'self'}${options.disabledReason ? ' unavailable' : ''}`;
  button.setAttribute('aria-label', `查看${CARD_NAMES[cardId]}详情`);

  const image = document.createElement('img');
  image.src = `assets/cards/${CARD_IMAGES[cardId]}`;
  image.alt = `${CARD_NAMES[cardId]}卡通图`;
  image.loading = options.eager ? 'eager' : 'lazy';

  const shade = document.createElement('span');
  shade.className = 'card-shade';
  const points = document.createElement('span');
  points.className = 'card-points';
  points.textContent = `🎲 ${cardPointLabel(cardId)}`;
  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = CARD_NAMES[cardId];
  const price = document.createElement('span');
  price.className = 'card-price';
  price.textContent = `🪙 ${CARD_COSTS[cardId]}`;
  button.append(image, shade, points, name, price);

  if (options.remaining !== undefined) {
    const stock = document.createElement('span');
    stock.className = 'card-stock';
    stock.textContent = `余 ${options.remaining}`;
    button.appendChild(stock);
  }

  const statusParts = [];
  if (options.remaining !== undefined) statusParts.push(`牌堆剩余 ${options.remaining} 张`);
  if (options.owned) statusParts.push(`你拥有 ${options.owned} 张`);
  if (options.disabledReason) statusParts.push(options.disabledReason);
  button.addEventListener('click', () => openCardModal(cardId, {
    payload: options.payload,
    showConfirm: Boolean(options.showConfirm),
    disabledReason: options.disabledReason,
    status: statusParts.join(' · '),
    confirmLabel: options.confirmLabel,
  }));
  return button;
}

function createOwnedCard(cardId, count) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'owned-card';
  button.setAttribute('aria-label', `查看${CARD_NAMES[cardId]}详情，拥有 ${count} 张`);
  const image = document.createElement('img');
  image.src = `assets/cards/${CARD_IMAGES[cardId]}`;
  image.alt = '';
  image.loading = 'lazy';
  const badge = document.createElement('span');
  badge.textContent = `×${count}`;
  button.append(image, badge);
  button.addEventListener('click', () => openCardModal(cardId, {
    status: `拥有 ${count} 张`,
    showConfirm: false,
  }));
  return button;
}

function closeGameOverModal() {
  const modal = document.getElementById('gameOverModal');
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
}

function showGameOver() {
  const winner = game.players.find(player => player.id === game.winnerId);
  if (!winner) return;
  const key = `${roomId}:${game.turnNumber}:${game.winnerId}`;
  if (lastGameOverKey === key) return;
  lastGameOverKey = key;
  document.getElementById('gameOverTitle').textContent = winner.id === myId ? '恭喜，你获胜了！' : '游戏结束';
  document.getElementById('gameOverText').textContent = winner.id === myId
    ? '你率先建成了全部 4 个地标，梦想小镇圆满落成！'
    : `${winner.name} 率先建成全部 4 个地标，获得胜利。`;
  const modal = document.getElementById('gameOverModal');
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
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
  if (game.gameOver) {
    const winner = game.players.find(player => player.id === game.winnerId);
    banner.textContent = `🏆 ${winner ? winner.name : '玩家'} 获胜 · 游戏结束`;
    banner.classList.remove('me');
  } else if (me && game.current === me.id) {
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
  playersElement.replaceChildren();
  game.players.forEach((player, index) => {
    const playerPanel = document.createElement('div');
    playerPanel.className = `player${index === game.current && !game.gameOver ? ' active' : ''}${player.connected === false ? ' offline' : ''}`;

    const heading = document.createElement('h3');
    heading.append(document.createTextNode(`${player.name}${me && player.id === me.id ? '（你）' : ''}`));
    if (player.connected === false) {
      const badge = document.createElement('span');
      badge.className = 'badge-offline';
      badge.textContent = '离线';
      heading.appendChild(badge);
    }
    const money = document.createElement('div');
    money.className = 'money';
    money.textContent = `🪙 ${player.money}`;

    const ownedCards = document.createElement('div');
    ownedCards.className = 'owned-cards';
    const ownedIds = Object.keys(player.cards).filter(id => player.cards[id] > 0);
    if (ownedIds.length) ownedIds.forEach(id => ownedCards.appendChild(createOwnedCard(id, player.cards[id])));
    else ownedCards.textContent = '暂无建筑卡';

    const landmarks = document.createElement('div');
    landmarks.className = 'landmarks';
    const landmarkIds = Object.keys(player.landmarks).filter(id => player.landmarks[id]);
    if (landmarkIds.length) {
      landmarkIds.forEach(id => {
        const tag = document.createElement('span');
        tag.className = 'tag tag-landmark';
        tag.textContent = `🏛️ ${LANDMARK_NAMES[id]}`;
        landmarks.appendChild(tag);
      });
    } else landmarks.textContent = '尚未建设地标';
    playerPanel.append(heading, money, ownedCards, landmarks);
    playersElement.appendChild(playerPanel);
  });

  if (game.cardPool) {
    const shelf = document.createElement('details');
    shelf.className = 'market-shelf';
    const summary = document.createElement('summary');
    summary.textContent = '卡牌图鉴与公共牌堆库存';
    const grid = document.createElement('div');
    grid.className = 'market-grid';
    Object.keys(CARD_NAMES).forEach(id => grid.appendChild(createCardTile(id, {
      remaining: game.cardPool[id] || 0,
      disabledReason: (game.cardPool[id] || 0) <= 0 ? '已售罄' : '',
    })));
    shelf.append(summary, grid);
    playersElement.appendChild(shelf);
  }

  const actions = document.getElementById('actions');
  actions.replaceChildren();
  const isMyTurn = me && game.current === me.id;
  if (game.gameOver) {
    addTip(actions, '本局已经结束，可查看最终城镇或返回大厅。');
    renderLog();
    return;
  }
  if (isMyTurn && game.pendingChoice) {
    renderPendingChoice(actions, me);
    renderLog();
    return;
  }

  if (!me) actions.textContent = '正在同步身份…';
  else if (isMyTurn) {
    if (!game.dice) {
      const heading = document.createElement('h3');
      heading.className = 'action-heading';
      heading.textContent = '轮到你行动';
      const hint = document.createElement('p');
      hint.className = 'action-hint';
      hint.textContent = '先选择本回合要投掷的骰子数量。';
      const buttons = document.createElement('div');
      buttons.className = 'dice-buttons';
      addAction(buttons, '🎲 掷 1 个骰子', { type: 'roll', count: 1 });
      if (me.landmarks.train) addAction(buttons, '🎲🎲 掷 2 个骰子', { type: 'roll', count: 2 });
      actions.append(heading, hint, buttons);
    } else if (game.settled) {
      if (!game.boughtThisTurn) {
        const heading = document.createElement('h3');
        heading.className = 'action-heading';
        heading.textContent = `点数 ${game.dice.sum} · 可购买卡牌`;
        const hint = document.createElement('p');
        hint.className = 'action-hint';
        hint.textContent = '点击卡牌查看简要效果，再点击“确认购买”。';
        const grid = document.createElement('div');
        grid.className = 'purchase-grid';
        const matchingIds = Object.keys(CARD_NAMES).filter(id => CARD_POINTS[id].includes(game.dice.sum));
        matchingIds.forEach(id => {
          const remaining = game.cardPool[id] || 0;
          let disabledReason = '';
          if (remaining <= 0) disabledReason = '牌堆已经售罄';
          else if (me.money < CARD_COSTS[id]) disabledReason = `资金不足，还差 ${CARD_COSTS[id] - me.money} 元`;
          else if (SIX_CARDS.includes(id) && (me.cards[id] || 0) > 0) disabledReason = '该特殊卡每人只能拥有一张';
          grid.appendChild(createCardTile(id, {
            remaining,
            owned: me.cards[id] || 0,
            showConfirm: true,
            disabledReason,
            payload: disabledReason ? null : { type: 'buy', cardId: id },
            confirmLabel: `确认购买 · ${CARD_COSTS[id]} 元`,
            eager: true,
          }));
        });
        actions.append(heading, hint, grid);
      } else {
        addTip(actions, '✅ 本回合已经购买过一张卡牌');
      }

      const landmarkActions = document.createElement('div');
      landmarkActions.className = 'landmark-actions';
      if (!game.builtThisTurn) {
        for (const id of Object.keys(LANDMARK_NAMES)) {
          if (!me.landmarks[id]) {
            const button = addAction(landmarkActions, `🏛️ 建 ${LANDMARK_NAMES[id]} · ${LANDMARK_COSTS[id]} 元`, { type: 'build', landmarkId: id });
            button.disabled = me.money < LANDMARK_COSTS[id];
            if (button.disabled) button.title = '资金不足';
          }
        }
      } else {
        const buildNote = document.createElement('span');
        buildNote.textContent = '✅ 本回合已经建设过地标';
        landmarkActions.appendChild(buildNote);
      }
      actions.appendChild(landmarkActions);
      const turnActions = document.createElement('div');
      turnActions.className = 'turn-actions';
      addAction(turnActions, '结束回合 →', { type: 'endTurn' });
      actions.appendChild(turnActions);
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
