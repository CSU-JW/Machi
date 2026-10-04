let ws = null;
let reconnectTimer = null;
let myId = null;
let game = null;
let roomId = null;
let currentUser = null;
let kicked = false;
let lastGameOverKey = '';
let cardModalPayload = null;
let chatLog = [];
let chatUnread = 0;
let chatErrorTimer = null;

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
      chatLog = [];
      renderChat();
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
      chatLog = [];
      renderChat();
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
      chatLog = [];
      renderChat();
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
      chatLog = [];
      renderChat();
      closeCardModal();
      closeGameOverModal();
      showScreen('lobby');
      send({ type: 'requestLobby' });
      return;
    }

    if (msg.type === 'state') {
      closeCardModal();
      document.getElementById('playerDialog').close();
      game = msg.game;
      showScreen('game');
      document.getElementById('roomInfo').textContent = roomId==='test'?'（单人测试）':`（房间 ${roomId}，${myId + 1} 号玩家）`;
      render();
      if (game.gameOver) showGameOver();
      return;
    }

    if (msg.type === 'chatHistory') {
      chatLog = Array.isArray(msg.messages) ? msg.messages.slice(-100) : [];
      renderChat();
      return;
    }

    if (msg.type === 'chat') {
      chatLog.push(msg);
      if (chatLog.length > 100) chatLog.splice(0, chatLog.length - 100);
      const gameChat = document.getElementById('chat');
      if (document.getElementById('game').classList.contains('active')
        && gameChat.classList.contains('collapsed')) {
        chatUnread += 1;
      }
      renderChat();
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
      if (['EMPTY_MESSAGE', 'MESSAGE_TOO_LONG', 'RATE_LIMITED'].includes(msg.code)) {
        showChatError(msg.msg || '消息发送失败');
        return;
      }
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
    heading.textContent = room.testRoom ? '🧪 单人测试房间' : `房间 ${room.id}`;
    const status = document.createElement('span');
    status.className = `status${room.status === 'playing' ? ' playing' : ''}`;
    status.textContent = room.status === 'playing' ? '游戏中' : '等待中';
    title.append(heading, status);

    const count = document.createElement('div');
    count.className = 'room-count';
    count.textContent = `${room.playerCount} / ${room.capacity} 位玩家 · ${room.dlcEnabled ? '🌊 海滨假日 DLC' : '原版'}`;
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
  const isHost = msg.hostId === myId;
  document.getElementById('roomDlc').checked = Boolean(msg.dlcEnabled);
  document.getElementById('roomDlc').disabled = !isHost;
  document.getElementById('dlcSettingHint').textContent = `${isHost ? '你是房主，可在开局前切换。' : '由房主切换。'}开局后锁定；DLC包含11种新建筑、任务、事件和角色。`;
  document.getElementById('waitingRoomId').textContent = msg.roomId;
  document.getElementById('waitingText').textContent = msg.testRoom ? '单人练习：选好头像和模式后点击开始。' : `还差 ${msg.need} 人，满 4 人后自动开始游戏`;

  const bots = (msg.players || []).filter(p => p.bot);
  const members = (msg.players || []).filter(Boolean);
  const botControls = document.getElementById('botControls');
  botControls.hidden = !isHost || msg.testRoom;
  if (!botControls.hidden) {
    document.getElementById('startGameButton').disabled = !(members.length >= 2 && bots.length > 0);
    document.getElementById('botHint').textContent = bots.length
      ? `已添加 ${bots.length} 名人机：满 4 人自动开局，也可点击「开始游戏」立即开局。`
      : '可添加人机补位（简单/普通/困难）：满 4 人自动开局。';
  }

  const list = document.getElementById('waitingPlayers');
  list.replaceChildren();
  for (let index = 0; index < (msg.capacity || 4); index += 1) {
    const seat = document.createElement('div');
    const player = msg.players[index];
    if (player) {
      if (player.bot) {
        seat.className = 'seat bot';
        seat.textContent = `🤖 ${index + 1} 号位 · ${player.name}`;
        if (isHost) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'seat-remove';
          remove.textContent = '✕ 移除';
          remove.addEventListener('click', () => send({ type: 'removeBot', playerId: player.id }));
          seat.appendChild(remove);
        }
      } else {
        seat.className = `seat${player.connected === false ? ' offline' : ''}`;
        seat.textContent = `${AVATARS[player.avatar]?.icon || '🐶'} ${index + 1} 号位 · ${player.name}${player.id === myId ? '（你）' : ''}${player.connected === false ? ' · 离线' : ''}`;
      }
    } else {
      seat.className = 'seat empty';
      seat.textContent = `${index + 1} 号位 · 等待玩家`;
    }
    list.appendChild(seat);
  }
  list.append(avatarPicker(msg.players.find(p=>p.id===myId)?.avatar));
  if(msg.testRoom)addAction(list,'开始单人测试',{type:'startTest'});
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

document.getElementById('createRoomButton').addEventListener('click', () => send({ type: 'createRoom', dlcEnabled:document.getElementById('createDlc').checked }));
document.getElementById('roomDlc').addEventListener('change', event => send({type:'setDlc',enabled:event.target.checked}));
document.getElementById('addBotButton').addEventListener('click', () => send({ type: 'addBot', difficulty: document.getElementById('botDifficulty').value }));
document.getElementById('startGameButton').addEventListener('click', () => send({ type: 'startGame' }));
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
const SIX_CARDS = ['stadium','tvStation','mall','museum'];
const LANDMARK_NAMES = { train:'火车站', radio:'广播中心', mallC:'商业中心', park:'游乐园' };
const LANDMARK_COSTS = { train:4, radio:16, mallC:13, park:22 };
const AVATARS={dog:{icon:'🐶',name:'小狗'},chick:{icon:'🐥',name:'小鸡'},fish:{icon:'🐟',name:'小鱼'},duck:{icon:'🦆',name:'小鸭'}};
const BOT_LABELS={easy:'简单',normal:'普通',hard:'困难'};
const LANDMARK_INFO={train:'每回合可选择投掷1个或2个骰子。',radio:'最终投掷2个骰子且为对子时，本回合结束后获得额外回合。',mallC:'面包店、便利店、咖啡店、奶茶店、果园每张收入+1；奶制品、家具、农产品工厂的每份原料收益+1。不作用于DLC建筑。',park:'每回合首次投掷后可选择重投一次；只结算最终结果。投2骰仍需火车站。'};
for(const id of Object.keys(LANDMARK_NAMES)){
  CARD_NAMES[id]=LANDMARK_NAMES[id];CARD_COSTS[id]=LANDMARK_COSTS[id];CARD_TYPE[id]='landmark';CARD_POINTS[id]=[];CARD_DESCRIPTIONS[id]=LANDMARK_INFO[id];CARD_IMAGES[id]=`/assets/landmarks/${id}.png`;
}
function playerName(p){return `${p.bot?'🤖':''}${p.name} [${p.dlc?(p.dlc.roleChosen?DLC1.roles[p.dlc.role].name:'待选角色'):'市民'}]`;}
function avatarPicker(selected){
  const box=document.createElement('div');box.className='avatar-picker';
  for(const [id,a] of Object.entries(AVATARS)){const b=addAction(box,`${a.icon} ${a.name}`,{type:'setAvatar',avatar:id});b.classList.toggle('selected',id===selected);b.setAttribute('aria-pressed',String(id===selected));}
  return box;
}
function openPlayer(p){
  const dialog=document.getElementById('playerDialog'),body=document.getElementById('playerDetails');body.replaceChildren();
  document.getElementById('playerTitle').textContent=`${AVATARS[p.avatar]?.icon||'🐶'} ${playerName(p)}`;
  if(p.dlc)body.append(roleTaskDetails(p));else addTip(body,'原版模式：无角色技能和任务。');
  if(p.id===myId){addTip(body,'更换头像');body.append(avatarPicker(p.avatar));}
  dialog.showModal();
}
function landmarkTile(id,p){
  const built=p.landmarks[id];
  const tile=createCardTile(id,{status:built?'已建成':'未建成'});
  tile.classList.add('landmark-tile');tile.classList.toggle('unbuilt',!built);
  tile.querySelector('.card-points').textContent=built?'✓ 已建成':'未建成';
  tile.onclick=()=>{
    const canBuild=p.id===myId&&!built&&!game.gameOver&&!game.dlc?.selecting&&game.current===p.id&&game.settled&&!game.pendingChoice&&!game.builtThisTurn;
    openCardModal(id,{status:built?'已建成':'未建成',unbuilt:!built,showConfirm:canBuild,payload:canBuild?{type:'build',landmarkId:id}:null});
  };
  return tile;
}
for(const card of DLC1.buildings){
  CARD_NAMES[card.id]=card.name;CARD_POINTS[card.id]=card.points;CARD_COSTS[card.id]=card.cost;
  CARD_IMAGES[card.id]=`/dlc1/assets/cards/${card.id}.png`;
  CARD_DESCRIPTIONS[card.id]=card.description;
  CARD_TYPE[card.id]=({green:'self',blue:'any',red:'other',purple:'six'})[card.color];
}
function cardImage(id){return CARD_IMAGES[id].startsWith('/')?CARD_IMAGES[id]:`assets/cards/${CARD_IMAGES[id]}`;}
function priceOptions(kind,id,cost){return game?.shopQuotes?.[kind]?.[id] || [{source:'none',label:'原价',cost,rebate:0}];}
function fillDiscount(select,quotes){
  select.replaceChildren();
  const sorted=[...quotes].sort((a,b)=>(a.cost-a.rebate)-(b.cost-b.rebate)||a.cost-b.cost);
  for(const q of sorted){const o=document.createElement('option');o.value=q.source;o.textContent=`${q.label} · 支付${q.cost}元`;select.append(o);}
}

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
  modal.querySelector('.detail-card').className = `detail-card card-${CARD_TYPE[cardId] || 'self'}`;
  modal.querySelector('.detail-card').classList.toggle('unbuilt',Boolean(options.unbuilt));
  document.getElementById('cardModalArt').src = cardImage(cardId);
  document.getElementById('cardModalArt').alt = `${CARD_NAMES[cardId]}卡通图`;
  document.getElementById('cardModalPoints').textContent = LANDMARK_NAMES[cardId]?'🏛️ 地标':`🎲 ${cardPointLabel(cardId)}`;
  document.getElementById('cardModalCost').textContent = `🪙 ${CARD_COSTS[cardId]}`;
  document.getElementById('cardModalTitle').textContent = CARD_NAMES[cardId];
  document.getElementById('cardModalDescription').textContent = CARD_DESCRIPTIONS[cardId];

  const status = document.getElementById('cardModalStatus');
  const category = { self:'绿色 · 自己回合收益', any:'蓝色 · 任意玩家回合收益', other:'红色 · 向其他玩家收款', six:'紫色 · 每人限一张' }[CARD_TYPE[cardId]];
  status.textContent = [category, options.status].filter(Boolean).join(' · ');
  status.classList.toggle('error', Boolean(options.disabledReason));

  const confirmButton = document.getElementById('cardConfirmButton');
  cardModalPayload = options.payload || null;
  confirmButton.hidden = !options.showConfirm;
  confirmButton.disabled = Boolean(options.disabledReason) || !cardModalPayload;
  confirmButton.textContent = options.confirmLabel || '确认购买';
  const discountLabel=document.getElementById('discountLabel'), select=document.getElementById('cardDiscount');
  discountLabel.hidden=!options.showConfirm;
  if(options.showConfirm){
    const kind=LANDMARK_NAMES[cardId]?'build':'buy';
    const quotes=priceOptions(kind,cardId,CARD_COSTS[cardId]);fillDiscount(select,quotes);
    const update=()=>{
      const q=quotes.find(q=>q.source===select.value);
      const reason=options.disabledReason || (findMe().money<q.cost?'资金不足':'');
      confirmButton.disabled=Boolean(reason);
      confirmButton.textContent=`${kind==='build'?'确认建设':'确认购买'} · ${q.cost} 元`;
      cardModalPayload=reason?null:kind==='build'?{type:'build',landmarkId:cardId,discount:q.source}:{type:'buy',cardId,discount:q.source};
      status.textContent=[category, options.status,reason].filter(Boolean).join(' · ');
      status.classList.toggle('error',Boolean(reason));
    };
    select.onchange=update;update();
  }
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
  image.src = cardImage(cardId);
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
  button.className = `owned-card card-${CARD_TYPE[cardId] || 'self'}`;
  button.setAttribute('aria-label', `查看${CARD_NAMES[cardId]}详情，拥有 ${count} 张`);
  const image = document.createElement('img');
  image.src = cardImage(cardId);
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
    : `${playerName(winner)} 率先建成全部 4 个地标，获得胜利。`;
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
  renderDlcPanel(me);
  const banner = document.getElementById('turnBanner');
  const currentPlayer = game.players[game.current];
  if (game.gameOver) {
    const winner = game.players.find(player => player.id === game.winnerId);
    banner.textContent = `🏆 ${winner ? playerName(winner) : '玩家'} 获胜 · 游戏结束`;
    banner.classList.remove('me');
  } else if (me && game.current === me.id) {
    const extraTurnText = game.extraTurn ? ' · 广播中心已触发，结束后再行动一次' : '';
    banner.textContent = `⚡ 轮到你了（第 ${game.turnNumber} 回合）${extraTurnText}`;
    banner.classList.add('me');
  } else {
    banner.textContent = `⏳ 轮到 ${playerName(currentPlayer)}（第 ${game.turnNumber} 回合）`;
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
    const avatar=document.createElement('button');avatar.className='player-avatar';avatar.textContent=player.bot?'🤖':(AVATARS[player.avatar]?.icon||'🐶');avatar.setAttribute('aria-label',`查看${player.name}的角色和任务`);avatar.onclick=()=>openPlayer(player);
    heading.append(avatar,document.createTextNode(`${playerName(player)}${me && player.id === me.id ? '（你）' : ''}`));
    if (player.bot) {
      const botBadge = document.createElement('span');
      botBadge.className = 'badge-bot';
      botBadge.textContent = `${BOT_LABELS[player.difficulty] || ''}人机`;
      heading.appendChild(botBadge);
    }
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
    Object.keys(LANDMARK_NAMES).forEach(id=>landmarks.append(landmarkTile(id,player)));
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
    Object.keys(game.cardPool).forEach(id => grid.appendChild(createCardTile(id, {
      remaining: game.cardPool[id] || 0,
      disabledReason: (game.cardPool[id] || 0) <= 0 ? '已售罄' : '',
    })));
    shelf.append(summary, grid);
    playersElement.appendChild(shelf);
  }

  const actions = document.getElementById('actions');
  actions.replaceChildren();
  const isMyTurn = me && game.current === me.id;
  if(game.dlc?.selecting){addTip(actions,'请选择角色和任务，倒计时结束后自动选择。');renderLog();return;}
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
        const matchingIds = Object.keys(game.cardPool).filter(id => CARD_POINTS[id].includes(game.dice.sum));
        matchingIds.forEach(id => {
          const remaining = game.cardPool[id] || 0;
          let disabledReason = '';
          if (remaining <= 0) disabledReason = '牌堆已经售罄';
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
            landmarkActions.append(landmarkTile(id,me));
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
      addAction(container, playerName(player), { type:'choice', choice:{ type:'tvPickTarget', targetId:player.id } });
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
      const button = addAction(container, `${playerName(player)}${hasCards ? '' : '（无可交换卡）'}`, { type:'choice', choice:{ type:'mallPickTarget', targetId:player.id } });
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

function renderDlcPanel(me){
  const panel=document.getElementById('dlcPanel');panel.hidden=!game.dlc;panel.replaceChildren();
  if(!game.dlc||!me)return;
  const event=DLC1.events[game.dlc.eventIndex];
  addTip(panel,`🌊 海滨假日 · 第${game.dlc.round}轮 · ${event.name}`);
  const description=document.createElement('p');description.textContent=event.effect;panel.append(description);
  if(game.dlc.selecting&&!me.dlc.roleChosen){
    addTip(panel,'角色二选一（允许不同玩家选择同一角色）');
    for(const id of me.dlc.roleOptions){const r=DLC1.roles[id];addAction(panel,`${r.name} · ${r.type}\n${r.effect}`,{type:'chooseRole',role:id});}
  }
  if(game.dlc.selecting&&!me.dlc.taskId){
    addTip(panel,'选择本局任务：难度越高，奖励越高。开局30秒未选择将自动选入门任务和首个角色。');
    for(const id of me.dlc.taskOptions){
      const t=DLC1.tasks.find(t=>t.id===id);
      addAction(panel,`${t.tier} · ${t.name}\n${t.condition}\n奖励：${t.reward}`,{type:'chooseTask',taskId:id});
    }
  }
  if(!me.dlc.roleChosen)return;
  const details=document.createElement('details');details.open=true;
  const summary=document.createElement('summary');summary.textContent='我的技能与任务';details.append(summary);
  for(const p of [me]){
    const d=p.dlc,role=DLC1.roles[d.role],task=DLC1.tasks.find(t=>t.id===d.taskId);
    const row=document.createElement('div');row.className='dlc-player';
    const title=document.createElement('strong');title.textContent=`${playerName(p)}（${role.type}）`;
    const info=document.createElement('p');info.textContent=role.effect;
    const status=document.createElement('p');status.textContent=`技能已用 ${d.used}/${d.role===0?1:3} 次${[1,4].includes(d.role)&&d.used>0&&d.readyAt>d.ownTurn?` · 冷却中，距可用还差${d.readyAt-d.ownTurn}个自己的回合`:''}；任务：${task?task.name:'选择中'}${d.taskDone?' ✅ 已完成':''}`;
    row.append(title,info,status);
    if(task){const t=document.createElement('p');t.textContent=`${task.condition} 奖励：${task.reward}`;row.append(t);}
    if(p.id===me.id){
      if(d.coupons.length){const c=document.createElement('p');c.textContent='持有券：'+d.coupons.map(c=>`${c.value}元${c.kind==='buy'?'购卡':'地标'}券${d.ownTurn<c.readyAt?'（下回合生效）':''}`).join('、');row.append(c);}
      if(d.serviceLeft){const s=document.createElement('p');s.textContent=`便民服务剩余 ${d.serviceLeft} 次`;row.append(s);}
      if(d.role===4){const b=addAction(row,'使用会计技能 · 获得1元',{type:'useRole'});b.disabled=game.gameOver||game.dlc.selecting||game.current!==p.id||!game.settled||Boolean(game.pendingChoice)||d.used>=3||d.ownTurn<d.readyAt||p.money>2;}
    }
    details.append(row);
  }
  panel.append(details);
}

function roleTaskDetails(p){
  const box=document.createElement('div'),d=p.dlc,role=DLC1.roles[d.role],task=DLC1.tasks.find(t=>t.id===d.taskId);
  const skill=document.createElement('p');skill.textContent=d.roleChosen?`${role.name} · ${role.type}：${role.effect}（已用${d.used}/${d.role===0?1:3}次）`:'正在选择角色';
  const mission=document.createElement('p');mission.textContent=task?`${d.taskDone?'✅ 已完成':'任务'} · ${task.name}：${task.condition} 奖励：${task.reward}`:'正在选择任务';
  box.append(skill,mission);return box;
}

function chatTimeLabel(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function chatLineElement(entry) {
  const row = document.createElement('div');
  const mine = entry.playerId === myId;
  row.className = `chat-msg${mine ? ' mine' : ''}`;
  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  const who = document.createElement('span');
  who.textContent = `${AVATARS[entry.avatar]?.icon || '💬'} ${entry.name}${mine ? '（你）' : ''}`;
  const time = document.createElement('span');
  time.textContent = chatTimeLabel(entry.ts);
  meta.append(who, time);
  const text = document.createElement('div');
  text.className = 'chat-text';
  text.textContent = entry.text;
  row.append(meta, text);
  return row;
}

function updateChatUnread() {
  const badge = document.getElementById('chatUnread');
  if (!badge) return;
  badge.hidden = chatUnread === 0;
  badge.textContent = String(chatUnread);
}

function renderChat() {
  for (const id of ['chatMessages', 'waitingChatMessages']) {
    const container = document.getElementById(id);
    if (!container) continue;
    container.replaceChildren();
    for (const entry of chatLog) container.appendChild(chatLineElement(entry));
    container.scrollTop = container.scrollHeight;
  }
  updateChatUnread();
}

function showChatError(message) {
  for (const id of ['chatError', 'waitingChatError']) {
    const node = document.getElementById(id);
    if (node) node.textContent = message;
  }
  clearTimeout(chatErrorTimer);
  chatErrorTimer = setTimeout(() => {
    for (const id of ['chatError', 'waitingChatError']) {
      const node = document.getElementById(id);
      if (node) node.textContent = '';
    }
  }, 2500);
}

function submitChat(event) {
  event.preventDefault();
  const input = event.currentTarget.querySelector('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  if (!send({ type: 'chat', text })) input.value = text;
}

document.getElementById('chatForm').addEventListener('submit', submitChat);
document.getElementById('waitingChatForm').addEventListener('submit', submitChat);
document.getElementById('chatToggle').addEventListener('click', () => {
  const panel = document.getElementById('chat');
  const collapsed = panel.classList.toggle('collapsed');
  panel.querySelector('#chatToggle').setAttribute('aria-expanded', String(!collapsed));
  if (!collapsed) chatUnread = 0;
  updateChatUnread();
  if (!collapsed) {
    const messages = document.getElementById('chatMessages');
    messages.scrollTop = messages.scrollHeight;
  }
});

getDeviceId();
connect();
