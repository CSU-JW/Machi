// engine.js
const { CARDS, LANDMARKS, UNIQUE_CARDS, SIX_CARDS, createCardPool } = require('./cards');
const crypto = require('crypto');
const D = require('./dlc1/runtime');

// ---------- 初始化 ----------
function createGame(playerNames, options = {}) {
  const pool = createCardPool(options.dlcEnabled === true);

  const players = playerNames.map((name, i) => ({
    id: i,
    name,
    money: 3,
    cards: { wheat: 1, bakery: 1 },
    landmarks: { train:false, radio:false, mallC:false, park:false },
    connected: true,
  }));

  for (const p of players) {
    for (const cid of Object.keys(p.cards)) {
      pool[cid] -= p.cards[cid];
    }
  }

  const game = {
    dlcEnabled: options.dlcEnabled === true,
    players,
    current: 0,
    phase: 'roll',
    dice: null,
    rolled: false,
    settled: false,
    rerolled: false,
    extraTurn: false,
    boughtThisTurn: false,
    builtThisTurn: false,
    cardPool: pool,
    pendingChoice: null,
    gameOver: false,
    winnerId: null,
    turnNumber: 1,          // 当前是第几回合
    log: [],                // 每条 { text, turn }
  };
  if (game.dlcEnabled) D.init(game);
  return game;
}

// ---------- 工具 ----------
function log(g, text) {
  g.log.push({ text, turn: g.turnNumber });
}
function playerHasLandmark(p, id) { return p.landmarks[id] === true; }
function playerHasCard(p, id) { return (p.cards[id] || 0) > 0; }
function cardCount(p, id) { return p.cards[id] || 0; }

function bonusFor(p, cardId) {
  const hasMall = playerHasLandmark(p, 'mallC');
  if (!hasMall) return 0;
  if (['bakery','convenience','cafe','teaHouse'].includes(cardId)) return 1;
  if (['dairy','orchard','craft','farm'].includes(cardId)) return 1;
  return 0;
}

function rollDice(count) {
  const values = [];
  for (let i = 0; i < count; i++) values.push(1 + Math.floor(Math.random() * 6));
  const sum = values.reduce((a,b)=>a+b, 0);
  return { count, values, sum };
}

function canReroll(g, p) {
  if (!g.dice || g.settled || g.rerolled) return false;
  return playerHasLandmark(p, 'park');
}

function transferUpTo(from, to, requestedAmount) {
  const available = Math.max(0, from.money);
  const amount = Math.min(requestedAmount, available);
  from.money = Math.max(0, from.money - amount);
  to.money += amount;
  return amount;
}

function updateExtraTurn(g, roller, events) {
  const values = g.dice && Array.isArray(g.dice.values) ? g.dice.values : [];
  g.extraTurn = Boolean(
    playerHasLandmark(roller, 'radio')
    && g.dice
    && g.dice.count === 2
    && values.length === 2
    && values[0] === values[1]
  );
  if (g.extraTurn) {
    events.push(`${roller.name} 的广播中心触发：掷出对子，本回合结束后获得一个额外回合`);
  }
}

// ---------- 结算 ----------
function settle(g, rollerId, sum) {
  const events = [];
  const roller = g.players[rollerId];

  // 所有收费优先；同类收费保留原有座位顺序，不能使用稍后发放的收益付款。
  for (const owner of g.players) {
    if (owner.id === rollerId) continue;
    for (const cardId of Object.keys(owner.cards)) {
      const card = CARDS[cardId], n = owner.cards[cardId];
      if (!card || n <= 0 || (card.dlc && !g.dlcEnabled) || card.trigger !== 'other' || !card.points.includes(sum)) continue;
      const amount = card.dlc ? D.income(card, owner, g) : card.effect.amount + bonusFor(owner, cardId);
      const paid = transferUpTo(roller, owner, amount * n);
      events.push(`${roller.name} 向 ${owner.name} 支付 ${paid}（${card.name} x${n}，应付 ${amount * n}）`);
    }
  }
  g.incomePending = true;
  if (sum === 6 && g.players.length > 1) {
    // 体育馆/电视塔确认完毕后才发系统收益（包含DLC博物馆）。
    if (playerHasCard(roller,'stadium')) return {events,needChoice:{type:'askStadium',rollerId}};
    if (playerHasCard(roller,'tvStation')) return {events,needChoice:{type:'askTv',rollerId}};
  }
  const needChoice = finishIncome(g, rollerId, events);
  return {events,needChoice};
}

function finishIncome(g, rollerId, events) {
  const roller = g.players[rollerId];
  if (!g.incomePending) return mallChoice(g, rollerId);
  g.incomePending = false;
  const sum = g.dice.sum;
  const triggered = [];

  for (const owner of g.players) {
    for (const cardId of Object.keys(owner.cards)) {
      const n = owner.cards[cardId];
      if (n <= 0) continue;
      const card = CARDS[cardId];
      if (!card || (card.dlc && !g.dlcEnabled)) continue;
      if (!card.points.includes(sum)) continue;

      if (card.trigger === 'any') {
        const gain = (card.dlc ? D.income(card, owner, g) : card.effect.amount) * n;
        owner.money += gain;
        if (owner.id === rollerId) triggered.push(cardId);
        events.push(`${owner.name} 的 ${card.name} x${n} 触发，+${gain}`);
      } else if (card.trigger === 'self') {
        if (owner.id !== rollerId) continue;
        const bonus = bonusFor(owner, cardId);
        let gain = 0;
        if (card.dlc) {
          gain = D.income(card, owner, g) * n;
        } else if (card.effect.type === 'gain') {
          gain = (card.effect.amount + bonus) * n;
        } else if (card.effect.type === 'perCard') {
          const depCount = cardCount(owner, card.effect.dep);
          gain = (card.effect.amount + bonus) * depCount * n;
        } else if (card.effect.type === 'perCardMulti') {
          let depTotal = 0;
          for (const d of card.effect.deps) depTotal += cardCount(owner, d);
          gain = (card.effect.amount + bonus) * depTotal * n;
        }
        owner.money += gain;
        triggered.push(cardId);
        events.push(`${owner.name} 的 ${card.name} x${n} 触发，+${gain}`);
      }
    }
  }

  D.afterIncome(g, roller, triggered, events);
  updateExtraTurn(g, roller, events);
  return sum === 6 ? mallChoice(g, rollerId) : null;
}

function mallChoice(g, rollerId) {
  const roller = g.players[rollerId];
  if (playerHasCard(roller, 'mall')) {
    const hasMyCard = Object.keys(roller.cards).some(id => roller.cards[id] > 0 && !SIX_CARDS.includes(id));
    const hasTargetCard = g.players.some(p => p.id !== rollerId && Object.keys(p.cards).some(id => p.cards[id] > 0 && !SIX_CARDS.includes(id)));
    if (hasMyCard && hasTargetCard) return { type: 'askMall', rollerId };
  }
  return null;
}

function handleChoice(g, rollerId, choice) {
  const roller = g.players[rollerId];
  const events = [];

  if (choice.type === 'reroll') {
    if (!canReroll(g, roller)) return { ok:false, error:'不能重掷' };
    const rerollCount = choice.count === 2 ? 2 : 1;
    if (rerollCount === 2 && !roller.landmarks.train) {
      return { ok:false, error:'未建成火车站，不能投掷2个骰子' };
    }
    g.dice = { ...rollDice(rerollCount), firstCount: g.dice.firstCount };
    g.rerolled = true;
    const result = settle(g, rollerId, g.dice.sum);
    g.settled = true;
    events.push(...result.events);
    return { ok:true, events, needChoice: result.needChoice };
  }

  if (choice.type === 'accept') {
    if (g.settled) return { ok:false, error:'已结算' };
    const result = settle(g, rollerId, g.dice.sum);
    g.settled = true;
    events.push(...result.events);
    return { ok:true, events, needChoice: result.needChoice };
  }

  if (choice.type === 'askStadium') {
    if (choice.activate) {
      if (!playerHasCard(roller, 'stadium')) return { ok:false, error:'没有体育馆' };
      for (const p of g.players) {
        if (p.id === rollerId) continue;
        const paid = transferUpTo(p, roller, 2);
        events.push(`${roller.name} 体育馆：向 ${p.name} 收 ${paid}`);
      }
    } else {
      events.push(`${roller.name} 跳过体育馆`);
    }
    return { ok:true, events, needChoice: nextSixChoice(g, rollerId, 'stadium', events) };
  }

  if (choice.type === 'askTv') {
    if (choice.activate) {
      if (!playerHasCard(roller, 'tvStation')) return { ok:false, error:'没有电视塔' };
      return { ok:true, events, needChoice: { type: 'tvPickTarget', rollerId } };
    } else {
      events.push(`${roller.name} 跳过电视塔`);
      return { ok:true, events, needChoice: nextSixChoice(g, rollerId, 'tvStation', events) };
    }
  }

  if (choice.type === 'tvPickTarget') {
    const target = g.players.find(p => p.id === choice.targetId);
    if (!target || target.id === rollerId) return { ok:false, error:'无效目标' };
    const paid = transferUpTo(target, roller, 5);
    events.push(`${roller.name} 电视塔：向 ${target.name} 收 ${paid}`);
    return { ok:true, events, needChoice: nextSixChoice(g, rollerId, 'tvStation', events) };
  }

  if (choice.type === 'askMall') {
    if (choice.activate) {
      if (!playerHasCard(roller, 'mall')) return { ok:false, error:'没有商场' };
      const hasMyCard = Object.keys(roller.cards).some(id => roller.cards[id] > 0 && !SIX_CARDS.includes(id));
      const hasTargetCard = g.players.some(p => p.id !== rollerId && Object.keys(p.cards).some(id => p.cards[id] > 0 && !SIX_CARDS.includes(id)));
      if (!hasMyCard || !hasTargetCard) {
        events.push(`${roller.name} 商场：无可交换的卡，无法发动`);
        return { ok:true, events, needChoice: null };
      }
      return { ok:true, events, needChoice: { type: 'mallPickTarget', rollerId } };
    } else {
      events.push(`${roller.name} 跳过商场`);
      return { ok:true, events, needChoice: null };
    }
  }

  if (choice.type === 'mallPickTarget') {
    const target = g.players.find(p => p.id === choice.targetId);
    if (!target || target.id === rollerId) return { ok:false, error:'无效目标' };
    const targetCards = Object.keys(target.cards).filter(id => target.cards[id] > 0 && !SIX_CARDS.includes(id));
    if (targetCards.length === 0) return { ok:false, error:'该玩家没有可交换的卡' };
    return { ok:true, events, needChoice: { type: 'mallPickCards', rollerId, targetId: target.id } };
  }

  if (choice.type === 'mallPickCards') {
    const target = g.players.find(p => p.id === choice.targetId);
    if (!target) return { ok:false, error:'无效目标' };
    const myCardId = choice.myCardId;
    const targetCardId = choice.targetCardId;
    if (!roller.cards[myCardId] || roller.cards[myCardId] <= 0 || SIX_CARDS.includes(myCardId)) return { ok:false, error:'你选择的自己的卡无效' };
    if (!target.cards[targetCardId] || target.cards[targetCardId] <= 0 || SIX_CARDS.includes(targetCardId)) return { ok:false, error:'你选择的对方的卡无效' };
    roller.cards[myCardId] -= 1;
    target.cards[myCardId] = (target.cards[myCardId] || 0) + 1;
    target.cards[targetCardId] -= 1;
    roller.cards[targetCardId] = (roller.cards[targetCardId] || 0) + 1;
    events.push(`${roller.name} 用 ${CARDS[myCardId].name} 交换了 ${target.name} 的 ${CARDS[targetCardId].name}`);
    D.checkTasks(g);
    return { ok:true, events, needChoice: null };
  }

  return { ok:false, error:'未知的选择类型' };
}

function nextSixChoice(g, rollerId, after, events) {
  if (after === 'stadium' && playerHasCard(g.players[rollerId], 'tvStation')) return {type:'askTv',rollerId};
  return finishIncome(g, rollerId, events);
}

// ---------- 购买 ----------
function canBuy(g, cardId, source = 'none') {
  const p = g.players[g.current];
  const card = CARDS[cardId];
  if (!card) return { ok:false, reason:'无此卡' };
  if (g.gameOver || g.dlc?.selecting) return {ok:false,reason:'当前不能购买'};
  if (card.dlc && !g.dlcEnabled) return {ok:false,reason:'本房间未开启DLC'};
  if (g.pendingChoice) return { ok:false, reason:'还有选择未完成' };
  if (!g.settled) return { ok:false, reason:'尚未结算' };
  if (g.boughtThisTurn) return { ok:false, reason:'本回合已购买过卡牌' };
  if (!g.dice) return { ok:false, reason:'尚未掷骰' };
  if (!card.points.includes(g.dice.sum)) return { ok:false, reason:'点数不匹配' };
  const quote = D.selectQuote(g,p,'buy',cardId,card.cost,source);
  if (!quote) return {ok:false,reason:'优惠不可用'};
  if (p.money < quote.cost) return { ok:false, reason:'钱不够' };
  if (UNIQUE_CARDS.includes(cardId) && playerHasCard(p, cardId)) return { ok:false, reason:'该 6 点卡已拥有' };
  if ((g.cardPool[cardId] || 0) <= 0) return { ok:false, reason:'该卡已被买断' };
  return { ok:true };
}

function buyCard(g, cardId, source = 'none') {
  const chk = canBuy(g, cardId, source);
  if (!chk.ok) return chk;
  const p = g.players[g.current];
  const card = CARDS[cardId];
  const quote = D.selectQuote(g,p,'buy',cardId,card.cost,source);
  p.money -= quote.cost;
  D.consume(g,p,quote);
  p.cards[cardId] = (p.cards[cardId] || 0) + 1;
  g.cardPool[cardId] -= 1;
  g.boughtThisTurn = true;
  log(g, `${p.name} 购买 ${card.name}，花费 ${quote.cost}（${quote.label}，剩余 ${g.cardPool[cardId]} 张）`);
  D.checkTasks(g);
  return { ok:true };
}

// ---------- 建设 ----------
function canBuild(g, landmarkId, source = 'none') {
  const p = g.players[g.current];
  const lm = LANDMARKS[landmarkId];
  if (!lm) return { ok:false, reason:'无此地标' };
  if (g.gameOver || g.dlc?.selecting) return {ok:false,reason:'当前不能建设'};
  if (g.pendingChoice) return { ok:false, reason:'还有选择未完成' };
  if (!g.settled) return { ok:false, reason:'尚未结算' };
  if (g.builtThisTurn) return { ok:false, reason:'本回合已建设过地标' };
  if (p.landmarks[landmarkId]) return { ok:false, reason:'已建成' };
  const quote = D.selectQuote(g,p,'build',landmarkId,lm.cost,source);
  if (!quote) return {ok:false,reason:'优惠不可用'};
  if (p.money < quote.cost) return { ok:false, reason:'钱不够' };
  return { ok:true };
}

function buildLandmark(g, landmarkId, source = 'none') {
  const chk = canBuild(g, landmarkId, source);
  if (!chk.ok) return chk;
  const p = g.players[g.current];
  const lm = LANDMARKS[landmarkId];
  const quote = D.selectQuote(g,p,'build',landmarkId,lm.cost,source);
  p.money -= quote.cost;
  D.consume(g,p,quote);
  p.landmarks[landmarkId] = true;
  g.builtThisTurn = true;
  log(g, `${p.name} 建设 ${lm.name}，花费 ${quote.cost}（${quote.label}）`);
  if (isWin(p)) {
    g.gameOver = true;
    g.winnerId = p.id;
    g.phase = 'finished';
    log(g, `🎉 ${p.name} 建成 4 个地标，获胜！`);
  }
  D.afterBuild(g,p);
  return { ok:true };
}

function isWin(p) {
  return Object.values(p.landmarks).every(v => v === true);
}

function endTurn(g) {
  if (g.gameOver) return { extraTurn:false, playerId:g.current, gameOver:true };
  const extraTurn = Boolean(g.extraTurn);
  const playerId = g.current;
  if (!extraTurn) g.current = (g.current + 1) % g.players.length;
  D.end(g,g.players[playerId],extraTurn);
  g.dice = null;
  g.rerolled = false;
  g.settled = false;
  g.extraTurn = false;
  g.boughtThisTurn = false;
  g.builtThisTurn = false;
  g.pendingChoice = null;
  g.phase = 'roll';
  g.turnNumber += 1;
  return { extraTurn, playerId };
}

module.exports = {
  createGame, rollDice, canReroll, settle, handleChoice,
  canBuy, buyCard, canBuild, buildLandmark, isWin, endTurn,
};
