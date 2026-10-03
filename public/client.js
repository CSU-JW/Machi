// client.js
let ws = null;
let myId = null;
let game = null;
let roomId = null;
let myToken = null;
let kicked = false;   // 是否被踢（用于停止自动重连）

const CARD_NAMES = {
  wheat:'麦田', ranch:'牧场', bakery:'面包店', cafe:'咖啡店',
  convenience:'便利店', forest:'林场', stadium:'体育馆',
  tvStation:'电视塔', mall:'商场', dairy:'奶制品工厂',
  orchard:'果园', mine:'矿山', teaHouse:'奶茶店',
  craft:'工艺品工厂', farm:'农产品工厂',
};
const CARD_POINTS = {
  wheat:[1], ranch:[2], bakery:[2,3], cafe:[3], convenience:[4],
  forest:[5], stadium:[6], tvStation:[6], mall:[6],
  dairy:[7], orchard:[8], mine:[9], teaHouse:[9,10],
  craft:[10], farm:[11,12],
};
const CARD_COSTS = {
  wheat:1, ranch:2, bakery:2, cafe:2, convenience:2, forest:3,
  stadium:6, tvStation:8, mall:7, dairy:3, orchard:3, mine:3,
  teaHouse:3, craft:3, farm:2,
};
const CARD_TYPE = {
  wheat:'any', ranch:'any', forest:'any',
  bakery:'self', convenience:'self', dairy:'self', orchard:'self',
  mine:'self', craft:'self', farm:'self',
  cafe:'other', teaHouse:'other',
  stadium:'six', tvStation:'six', mall:'six',
};
const SIX_CARDS = ['stadium','tvStation','mall'];
const LANDMARK_NAMES = {
  train:'火车站', radio:'广播中心', mallC:'商业中心', park:'游乐园',
};
const LANDMARK_COSTS = {
  train:4, radio:16, mallC:10, park:22,
};

// ---------- 加入游戏 ----------
function join() {
  const name = document.getElementById('nameInput').value.trim() || '玩家';
  const savedToken = localStorage.getItem('machi_token');
  kicked = false;
  connect(name, savedToken);
}

function connect(name, token) {
  ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', name, token }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'joined') {
      myId = msg.playerId;
      roomId = msg.roomId;
      myToken = msg.token;
      localStorage.setItem('machi_token', myToken);
      localStorage.setItem('machi_name', msg.name);
      document.getElementById('joinMsg').textContent =
        `已加入房间 ${roomId}，你是玩家 ${myId}` + (msg.reconnect ? '（重连成功）' : '');
    }
    else if (msg.type === 'waiting') {
      document.getElementById('joinMsg').textContent =
        `房间 ${msg.roomId} 等待中，还差 ${msg.need} 人...`;
    }
    else if (msg.type === 'state') {
      game = msg.game;
      document.getElementById('join').style.display = 'none';
      document.getElementById('game').style.display = 'block';
      document.getElementById('roomInfo').textContent = `（房间 ${roomId}，你是 ${myId} 号）`;
      render();
    }
    else if (msg.type === 'kick') {
      // 被踢：停止重连，提示用户
      kicked = true;
      alert(msg.msg || '你已在其他页面打开游戏');
      document.getElementById('joinMsg').textContent = '你已在其他页面打开游戏，此页面已断开';
      document.getElementById('game').style.display = 'none';
      document.getElementById('join').style.display = 'block';
    }
    else if (msg.type === 'error') {
      alert(msg.msg);
    }
  };

  ws.onclose = () => {
    if (kicked) return;   // 被踢的不自动重连

    document.getElementById('joinMsg').textContent = '连接断开，3 秒后重连...';
    setTimeout(() => {
      if (myToken) {
        const name = localStorage.getItem('machi_name') || '玩家';
        connect(name, myToken);
      }
    }, 3000);
  };
}

function findMe() {
  if (!game || myId === null) return null;
  return game.players.find(p => p.id === myId);
}

// ---------- 骰子动画 ----------
let lastDiceKey = '';
function animateDice(realSum, realValues) {
  const el = document.getElementById('dice');
  const key = realValues.join('+') + '|' + realSum;
  if (key === lastDiceKey) return;
  lastDiceKey = key;

  el.classList.add('rolling');
  let count = 0;
  const timer = setInterval(() => {
    el.textContent = `🎲 ${1 + Math.floor(Math.random() * 12)}`;
    count++;
    if (count >= 8) {
      clearInterval(timer);
      el.classList.remove('rolling');
      el.textContent = `🎲 ${realSum} (${realValues.join(' + ')})`;
    }
  }, 60);
}

// ---------- 渲染 ----------
function render() {
  if (!game) return;
  const me = findMe();

  const banner = document.getElementById('turnBanner');
  const currentPlayer = game.players[game.current];
  if (me && game.current === me.id) {
    banner.textContent = `⚡ 轮到你了（第 ${game.turnNumber} 回合）`;
    banner.classList.add('me');
  } else {
    banner.textContent = `⏳ 轮到 ${currentPlayer.name}（第 ${game.turnNumber} 回合）`;
    banner.classList.remove('me');
  }

  if (game.dice) {
    animateDice(game.dice.sum, game.dice.values);
  } else {
    document.getElementById('dice').textContent = '';
    lastDiceKey = '';
  }

  const playersEl = document.getElementById('players');
  playersEl.innerHTML = '';
  game.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player' + (i === game.current ? ' active' : '') + (p.connected === false ? ' offline' : '');

    const cardStr = Object.keys(p.cards).filter(id => p.cards[id] > 0)
      .map(id => {
        const type = CARD_TYPE[id] || 'self';
        return `<span class="tag tag-${type}">${CARD_NAMES[id] || id}×${p.cards[id]}</span>`;
      }).join('') || '<span style="color:#aaa;">无</span>';

    const lmStr = Object.keys(p.landmarks).filter(id => p.landmarks[id])
      .map(id => `<span class="tag tag-landmark">${LANDMARK_NAMES[id] || id}</span>`)
      .join('') || '<span style="color:#aaa;">无</span>';

    const offlineBadge = p.connected === false ? '<span class="badge-offline">离线</span>' : '';

    div.innerHTML = `
      <h3>${p.name}${me && p.id === me.id ? '（你）' : ''}${offlineBadge}</h3>
      <div class="money">💰 ${p.money}</div>
      <div class="cards">${cardStr}</div>
      <div class="landmarks">${lmStr}</div>
    `;
    playersEl.appendChild(div);
  });

  if (game.cardPool) {
    const poolDiv = document.createElement('div');
    poolDiv.style.cssText = 'width:100%;font-size:12px;color:#888;margin-top:8px;';
    const poolStr = Object.keys(game.cardPool)
      .filter(id => game.cardPool[id] > 0)
      .map(id => `${CARD_NAMES[id] || id}:${game.cardPool[id]}`)
      .join('  ');
    poolDiv.textContent = `[牌堆] ${poolStr}`;
    playersEl.appendChild(poolDiv);
  }

  const actionsEl = document.getElementById('actions');
  actionsEl.innerHTML = '';
  const isMyTurn = me && game.current === me.id;

  if (isMyTurn && game.pendingChoice) {
    renderPendingChoice(actionsEl, me);
    renderLog();
    return;
  }

  if (!me) {
    actionsEl.textContent = '正在同步身份...';
  } else if (isMyTurn) {
    if (!game.dice) {
      const btn1 = document.createElement('button');
      btn1.textContent = '掷 1 个骰子';
      btn1.onclick = () => ws.send(JSON.stringify({ type: 'roll', count: 1 }));
      actionsEl.appendChild(btn1);

      if (me.landmarks.train) {
        const btn2 = document.createElement('button');
        btn2.textContent = '掷 2 个骰子';
        btn2.onclick = () => ws.send(JSON.stringify({ type: 'roll', count: 2 }));
        actionsEl.appendChild(btn2);
      }
    } else if (game.settled) {
      if (!game.boughtThisTurn) {
        const points = game.dice.sum;
        for (const cid of Object.keys(CARD_NAMES)) {
          if (!CARD_POINTS[cid].includes(points)) continue;
          const btn = document.createElement('button');
          btn.textContent = `买 ${CARD_NAMES[cid]} (${CARD_COSTS[cid]}元)`;
          btn.onclick = () => ws.send(JSON.stringify({ type: 'buy', cardId: cid }));
          actionsEl.appendChild(btn);
        }
      } else {
        const span = document.createElement('span');
        span.textContent = '（本回合已购买过）';
        span.style.cssText = 'color:#888;margin-right:8px;';
        actionsEl.appendChild(span);
      }

      for (const lid of Object.keys(LANDMARK_NAMES)) {
        if (me.landmarks[lid]) continue;
        const btn = document.createElement('button');
        btn.textContent = `建 ${LANDMARK_NAMES[lid]} (${LANDMARK_COSTS[lid]}元)`;
        btn.onclick = () => ws.send(JSON.stringify({ type: 'build', landmarkId: lid }));
        actionsEl.appendChild(btn);
      }

      const endBtn = document.createElement('button');
      endBtn.textContent = '结束回合';
      endBtn.onclick = () => ws.send(JSON.stringify({ type: 'endTurn' }));
      actionsEl.appendChild(endBtn);
    } else {
      actionsEl.textContent = '等待结算...';
    }
  } else {
    actionsEl.textContent = '等待其他玩家...';
  }

  renderLog();
}

// ---------- 待选择 UI ----------
function renderPendingChoice(container, me) {
  const pc = game.pendingChoice;

  if (pc.type === 'askReroll') {
    const tip = document.createElement('div');
    tip.textContent = `你掷出了 ${game.dice.sum}，是否接受？`;
    tip.style.cssText = 'width:100%;margin-bottom:8px;font-weight:bold;';
    container.appendChild(tip);

    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = '接受点数，结算';
    acceptBtn.onclick = () => ws.send(JSON.stringify({ type: 'choice', choice: { type: 'accept' } }));
    container.appendChild(acceptBtn);

    const canRerollRadio = me.landmarks.radio;
    const canRerollPark = me.landmarks.park && game.dice.firstCount === 2;

    if (canRerollRadio || canRerollPark) {
      const r1 = document.createElement('button');
      r1.textContent = '重掷 1 个骰子';
      r1.onclick = () => ws.send(JSON.stringify({ type: 'choice', choice: { type: 'reroll', count: 1 } }));
      container.appendChild(r1);

      if (canRerollPark) {
        const r2 = document.createElement('button');
        r2.textContent = '重掷 2 个骰子';
        r2.onclick = () => ws.send(JSON.stringify({ type: 'choice', choice: { type: 'reroll', count: 2 } }));
        container.appendChild(r2);
      }
    }
    return;
  }

  if (pc.type === 'askStadium') {
    const tip = document.createElement('div');
    tip.textContent = '体育馆：是否向全场其他玩家各收 2 元？';
    tip.style.cssText = 'width:100%;margin-bottom:8px;font-weight:bold;';
    container.appendChild(tip);
    const yes = document.createElement('button');
    yes.textContent = '发动';
    yes.onclick = () => ws.send(JSON.stringify({ type: 'choice', choice: { type: 'askStadium', activate: true } }));
    container.appendChild(yes);
    const no = document.createElement('button');
    no.textContent = '不发动';
    no.onclick = () => ws.send(JSON.stringify({ type: 'choice', choice: { type: 'askStadium', activate: false } }));
    container.appendChild(no);
    return;
  }

  if (pc.type === 'askTv') {
    const tip = document.createElement('div');
    tip.textContent = '电视塔：是否向一名玩家收取 5 元？';
    tip.style.cssText = 'width:100%;margin-bottom:8px;font-weight:bold;';
    container.appendChild(tip);
    const yes = document.createElement('button');
    yes.textContent = '发动';
    yes.onclick = () => ws.send(JSON.stringify({ type: 'choice', choice: { type: 'askTv', activate: true } }));
    container.appendChild(yes);
    const no = document.createElement('button');
    no.textContent = '不发动';
    no.onclick = () => ws.send(JSON.stringify({ type: 'choice', choice: { type: 'askTv', activate: false } }));
    container.appendChild(no);
    return;
  }

  if (pc.type === 'tvPickTarget') {
    const tip = document.createElement('div');
    tip.textContent = '电视塔：选择一名玩家，收取 5 元';
    tip.style.cssText = 'width:100%;margin-bottom:8px;font-weight:bold;';
    container.appendChild(tip);
    game.players.forEach(p => {
      if (p.id === me.id) return;
      const btn = document.createElement('button');
      btn.textContent = p.name;
      btn.onclick = () => ws.send(JSON.stringify({ type: 'choice', choice: { type: 'tvPickTarget', targetId: p.id } }));
      container.appendChild(btn);
    });
    return;
  }

  if (pc.type === 'askMall') {
    const tip = document.createElement('div');
    tip.textContent = '商场：是否与一名玩家交换卡牌？';
    tip.style.cssText = 'width:100%;margin-bottom:8px;font-weight:bold;';
    container.appendChild(tip);
    const yes = document.createElement('button');
    yes.textContent = '发动';
    yes.onclick = () => ws.send(JSON.stringify({ type: 'choice', choice: { type: 'askMall', activate: true } }));
    container.appendChild(yes);
    const no = document.createElement('button');
    no.textContent = '不发动';
    no.onclick = () => ws.send(JSON.stringify({ type: 'choice', choice: { type: 'askMall', activate: false } }));
    container.appendChild(no);
    return;
  }

  if (pc.type === 'mallPickTarget') {
    const tip = document.createElement('div');
    tip.textContent = '商场：选择一个玩家进行交换';
    tip.style.cssText = 'width:100%;margin-bottom:8px;font-weight:bold;';
    container.appendChild(tip);
    game.players.forEach(p => {
      if (p.id === me.id) return;
      const has = Object.keys(p.cards).some(id => p.cards[id] > 0 && !SIX_CARDS.includes(id));
      const btn = document.createElement('button');
      btn.textContent = p.name + (has ? '' : '（无可交换卡）');
      btn.disabled = !has;
      btn.onclick = () => ws.send(JSON.stringify({ type: 'choice', choice: { type: 'mallPickTarget', targetId: p.id } }));
      container.appendChild(btn);
    });
    return;
  }

  if (pc.type === 'mallPickCards') {
    const target = game.players.find(p => p.id === pc.targetId);
    const tip = document.createElement('div');
    tip.textContent = `商场：与 ${target.name} 交换。先选你的一张卡，再选对方的一张卡`;
    tip.style.cssText = 'width:100%;margin-bottom:8px;font-weight:bold;';
    container.appendChild(tip);

    const myCards = Object.keys(me.cards).filter(id => me.cards[id] > 0 && !SIX_CARDS.includes(id));
    const targetCards = Object.keys(target.cards).filter(id => target.cards[id] > 0 && !SIX_CARDS.includes(id));

    let selectedMine = null;
    let selectedTarget = null;

    const mineDiv = document.createElement('div');
    mineDiv.style.cssText = 'width:100%;margin-bottom:6px;';
    mineDiv.innerHTML = '<span style="color:#555;">你的卡：</span>';
    myCards.forEach(id => {
      const btn = document.createElement('button');
      btn.textContent = `${CARD_NAMES[id]}×${me.cards[id]}`;
      btn.onclick = () => {
        selectedMine = id;
        Array.from(mineDiv.querySelectorAll('button')).forEach(b => b.style.outline = '');
        btn.style.outline = '2px solid #4caf50';
        trySubmit();
      };
      mineDiv.appendChild(btn);
    });
    container.appendChild(mineDiv);

    const targetDiv = document.createElement('div');
    targetDiv.style.cssText = 'width:100%;margin-bottom:6px;';
    targetDiv.innerHTML = `<span style="color:#555;">${target.name} 的卡：</span>`;
    targetCards.forEach(id => {
      const btn = document.createElement('button');
      btn.textContent = `${CARD_NAMES[id]}×${target.cards[id]}`;
      btn.onclick = () => {
        selectedTarget = id;
        Array.from(targetDiv.querySelectorAll('button')).forEach(b => b.style.outline = '');
        btn.style.outline = '2px solid #4caf50';
        trySubmit();
      };
      targetDiv.appendChild(btn);
    });
    container.appendChild(targetDiv);

    function trySubmit() {
      if (selectedMine && selectedTarget) {
        ws.send(JSON.stringify({
          type: 'choice',
          choice: { type: 'mallPickCards', targetId: target.id, myCardId: selectedMine, targetCardId: selectedTarget }
        }));
      }
    }
    return;
  }

  container.textContent = '等待选择...';
}

// ---------- 日志 ----------
function renderLog() {
  const logEl = document.getElementById('log');
  const logs = game.log || [];
  let lastTurn = null;
  let html = '';
  logs.slice(-80).forEach(entry => {
    const text = typeof entry === 'string' ? entry : entry.text;
    const turn = typeof entry === 'string' ? null : entry.turn;
    if (turn !== null && turn !== lastTurn) {
      html += `<div class="turn-sep">—— 第 ${turn} 回合 ——</div>`;
      lastTurn = turn;
    }
    html += `<div>${text}</div>`;
  });
  logEl.innerHTML = html;
  logEl.scrollTop = logEl.scrollHeight;
}