// engine.js
const { CARDS, LANDMARKS, UNIQUE_CARDS, SIX_CARDS, createCardPool } = require('./cards');

// ---------- 初始化 ----------
function createGame(playerNames) {
  const pool = createCardPool();

  const players = playerNames.map((name, i) => ({
    id: i,
    name,
    money: 3,
    cards: { wheat: 1, bakery: 1 },
    landmarks: { train:false, radio:false, mallC:false, park:false },
  }));

  for (const p of players) {
    for (const cid of Object.keys(p.cards)) {
      pool[cid] -= p.cards[cid];
    }
  }

  return {
    players,
    current: 0,
    phase: 'roll',          // roll | settle | buy | build | end
    dice: null,             // { count, values, sum, firstCount }
    rolled: false,
    settled: false,         // 本次掷骰是否已结算
    rerolled: false,
    boughtThisTurn: false,
    cardPool: pool,
    pendingChoice: null,    // { type: 'reroll' } | { type:'stadium' } | ...
    log: [],
  };
}

// ---------- 工具 ----------
function log(g, msg) { g.log.push(msg); }
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

// 是否还能重掷（已掷、未结算、未重掷过、有对应地标）
function canReroll(g, p) {
  if (!g.dice || g.settled || g.rerolled) return false;
  const first = g.dice.firstCount;
  if (playerHasLandmark(p, 'radio')) return true;
  if (playerHasLandmark(p, 'park') && first === 2) return true;
  return false;
}

// ---------- 结算一次掷骰 ----------
// 返回 { events, needChoice }
function settle(g, rollerId, sum) {
  const events = [];
  const roller = g.players[rollerId];

  for (const owner of g.players) {
    for (const cardId of Object.keys(owner.cards)) {
      const n = owner.cards[cardId];
      if (n <= 0) continue;
      const card = CARDS[cardId];
      if (!card.points.includes(sum)) continue;

      if (card.trigger === 'any') {
        owner.money += card.effect.amount * n;
        events.push(`${owner.name} 的 ${card.name} x${n} 触发，+${card.effect.amount * n}`);
      } else if (card.trigger === 'self') {
        if (owner.id !== rollerId) continue;
        const bonus = bonusFor(owner, cardId);
        let gain = 0;
        if (card.effect.type === 'gain') {
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
        events.push(`${owner.name} 的 ${card.name} x${n} 触发，+${gain}`);
      } else if (card.trigger === 'other') {
        if (owner.id === rollerId) continue;
        const bonus = bonusFor(owner, cardId);
        const pay = (card.effect.amount + bonus) * n;
        roller.money -= pay;
        owner.money += pay;
        events.push(`${roller.name} 向 ${owner.name} 支付 ${pay}（${card.name} x${n}）`);
      }
    }
  }

  // 6 点特殊卡：逐个询问是否发动
  let needChoice = null;
  if (sum === 6) {
    needChoice = buildSixChoice(g, rollerId);
    if (!needChoice) {
      events.push(`${roller.name} 没有可发动的 6 点卡`);
    }
  }

  return { events, needChoice };
}

// 构建 6 点卡的"询问链"：先问体育馆，再问电视塔，再问商场
// 返回第一个要问的 choice，或 null（没有 6 点卡可发动）
function buildSixChoice(g, rollerId) {
  const roller = g.players[rollerId];
  const hasStadium = playerHasCard(roller, 'stadium');
  const hasTv = playerHasCard(roller, 'tvStation');
  const hasMall = playerHasCard(roller, 'mall');

  if (hasStadium) return { type: 'askStadium', rollerId };
  if (hasTv) return { type: 'askTv', rollerId };
  if (hasMall) return { type: 'askMall', rollerId };
  return null;
}

// 某玩家是否有"可用的"6 点卡（用于判断是否还要继续问）
function hasUsableSix(g, rollerId) {
  const roller = g.players[rollerId];
  if (playerHasCard(roller, 'stadium')) return true;
  if (playerHasCard(roller, 'tvStation')) return true;
  if (playerHasCard(roller, 'mall')) {
    // 商场要求自己 + 至少一个对手有非 6 点卡
    const hasMyCard = Object.keys(roller.cards).some(id =>
      roller.cards[id] > 0 && !SIX_CARDS.includes(id)
    );
    const hasTargetCard = g.players.some(p =>
      p.id !== rollerId && Object.keys(p.cards).some(id =>
        p.cards[id] > 0 && !SIX_CARDS.includes(id)
      )
    );
    return hasMyCard && hasTargetCard;
  }
  return false;
}

// ---------- 处理玩家选择 ----------
// choice: { type, ... }
function handleChoice(g, rollerId, choice) {
  const roller = g.players[rollerId];
  const events = [];

  // ============ 重掷选择 ============
  if (choice.type === 'reroll') {
    if (!canReroll(g, roller)) return { ok:false, error:'不能重掷' };
    let rerollCount = 1;
    if (roller.landmarks.park) {
      rerollCount = choice.count === 2 ? 2 : 1;
    }
    g.dice = { ...rollDice(rerollCount), firstCount: g.dice.firstCount };
    g.rerolled = true;
    // 重掷后强制结算
    const result = settle(g, rollerId, g.dice.sum);
    g.settled = true;
    events.push(...result.events);
    return { ok:true, events, needChoice: result.needChoice };
  }

  // ============ 接受点数（不重掷） ============
  if (choice.type === 'accept') {
    if (g.settled) return { ok:false, error:'已结算' };
    const result = settle(g, rollerId, g.dice.sum);
    g.settled = true;
    events.push(...result.events);
    return { ok:true, events, needChoice: result.needChoice };
  }

  // ============ 体育馆：发动 or 跳过 ============
  if (choice.type === 'askStadium') {
    if (choice.activate) {
      if (!playerHasCard(roller, 'stadium')) return { ok:false, error:'没有体育馆' };
      for (const p of g.players) {
        if (p.id === rollerId) continue;
        p.money -= 2;
        roller.money += 2;
        events.push(`${roller.name} 体育馆：向 ${p.name} 收 2`);
      }
    } else {
      events.push(`${roller.name} 跳过体育馆`);
    }
    // 继续问电视塔
    const next = nextSixChoice(g, rollerId, 'stadium');
    return { ok:true, events, needChoice: next };
  }

  // ============ 电视塔：发动（选人） or 跳过 ============
  if (choice.type === 'askTv') {
    if (choice.activate) {
      if (!playerHasCard(roller, 'tvStation')) return { ok:false, error:'没有电视塔' };
      return {
        ok:true, events,
        needChoice: { type: 'tvPickTarget', rollerId }
      };
    } else {
      events.push(`${roller.name} 跳过电视塔`);
      const next = nextSixChoice(g, rollerId, 'tvStation');
      return { ok:true, events, needChoice: next };
    }
  }

  if (choice.type === 'tvPickTarget') {
    const target = g.players.find(p => p.id === choice.targetId);
    if (!target || target.id === rollerId) return { ok:false, error:'无效目标' };
    target.money -= 5;
    roller.money += 5;
    events.push(`${roller.name} 电视塔：向 ${target.name} 收 5`);
    const next = nextSixChoice(g, rollerId, 'tvStation');
    return { ok:true, events, needChoice: next };
  }

  // ============ 商场：发动 or 跳过 ============
  if (choice.type === 'askMall') {
    if (choice.activate) {
      if (!playerHasCard(roller, 'mall')) return { ok:false, error:'没有商场' };
      // 检查是否可交换
      const hasMyCard = Object.keys(roller.cards).some(id =>
        roller.cards[id] > 0 && !SIX_CARDS.includes(id)
      );
      const hasTargetCard = g.players.some(p =>
        p.id !== rollerId && Object.keys(p.cards).some(id =>
          p.cards[id] > 0 && !SIX_CARDS.includes(id)
        )
      );
      if (!hasMyCard || !hasTargetCard) {
        events.push(`${roller.name} 商场：无可交换的卡，无法发动`);
        return { ok:true, events, needChoice: null };
      }
      return {
        ok:true, events,
        needChoice: { type: 'mallPickTarget', rollerId }
      };
    } else {
      events.push(`${roller.name} 跳过商场`);
      return { ok:true, events, needChoice: null };
    }
  }

  if (choice.type === 'mallPickTarget') {
    const target = g.players.find(p => p.id === choice.targetId);
    if (!target || target.id === rollerId) return { ok:false, error:'无效目标' };
    const targetCards = Object.keys(target.cards).filter(id =>
      target.cards[id] > 0 && !SIX_CARDS.includes(id)
    );
    if (targetCards.length === 0) return { ok:false, error:'该玩家没有可交换的卡' };
    return {
      ok:true, events,
      needChoice: { type: 'mallPickCards', rollerId, targetId: target.id }
    };
  }

  if (choice.type === 'mallPickCards') {
    const target = g.players.find(p => p.id === choice.targetId);
    if (!target) return { ok:false, error:'无效目标' };
    const myCardId = choice.myCardId;
    const targetCardId = choice.targetCardId;

    if (!roller.cards[myCardId] || roller.cards[myCardId] <= 0 || SIX_CARDS.includes(myCardId)) {
      return { ok:false, error:'你选择的自己的卡无效' };
    }
    if (!target.cards[targetCardId] || target.cards[targetCardId] <= 0 || SIX_CARDS.includes(targetCardId)) {
      return { ok:false, error:'你选择的对方的卡无效' };
    }

    roller.cards[myCardId] -= 1;
    target.cards[myCardId] = (target.cards[myCardId] || 0) + 1;
    target.cards[targetCardId] -= 1;
    roller.cards[targetCardId] = (roller.cards[targetCardId] || 0) + 1;

    events.push(`${roller.name} 用 ${CARDS[myCardId].name} 交换了 ${target.name} 的 ${CARDS[targetCardId].name}`);
    return { ok:true, events, needChoice: null };
  }

  return { ok:false, error:'未知的选择类型' };
}

// 在 6 点询问链中，找到"下一个要问的"
// after: 刚处理完哪个（'stadium' | 'tvStation' | 'mall'）
function nextSixChoice(g, rollerId, after) {
  const roller = g.players[rollerId];

  if (after === 'stadium') {
    if (playerHasCard(roller, 'tvStation')) return { type: 'askTv', rollerId };
    if (playerHasCard(roller, 'mall')) {
      // 商场可用性检查
      const hasMyCard = Object.keys(roller.cards).some(id =>
        roller.cards[id] > 0 && !SIX_CARDS.includes(id)
      );
      const hasTargetCard = g.players.some(p =>
        p.id !== rollerId && Object.keys(p.cards).some(id =>
          p.cards[id] > 0 && !SIX_CARDS.includes(id)
        )
      );
      if (hasMyCard && hasTargetCard) return { type: 'askMall', rollerId };
    }
    return null;
  }

  if (after === 'tvStation') {
    if (playerHasCard(roller, 'mall')) {
      const hasMyCard = Object.keys(roller.cards).some(id =>
        roller.cards[id] > 0 && !SIX_CARDS.includes(id)
      );
      const hasTargetCard = g.players.some(p =>
        p.id !== rollerId && Object.keys(p.cards).some(id =>
          p.cards[id] > 0 && !SIX_CARDS.includes(id)
        )
      );
      if (hasMyCard && hasTargetCard) return { type: 'askMall', rollerId };
    }
    return null;
  }

  return null;
}

// ---------- 购买 ----------
function canBuy(g, cardId) {
  const p = g.players[g.current];
  const card = CARDS[cardId];
  if (!card) return { ok:false, reason:'无此卡' };
  if (g.pendingChoice) return { ok:false, reason:'还有选择未完成' };
  if (!g.settled) return { ok:false, reason:'尚未结算' };
  if (g.boughtThisTurn) return { ok:false, reason:'本回合已购买过卡牌' };
  if (!g.dice) return { ok:false, reason:'尚未掷骰' };
  if (!card.points.includes(g.dice.sum)) return { ok:false, reason:'点数不匹配' };
  if (p.money < card.cost) return { ok:false, reason:'钱不够' };
  if (UNIQUE_CARDS.includes(cardId) && playerHasCard(p, cardId)) {
    return { ok:false, reason:'该 6 点卡已拥有' };
  }
  if ((g.cardPool[cardId] || 0) <= 0) {
    return { ok:false, reason:'该卡已被买断' };
  }
  return { ok:true };
}

function buyCard(g, cardId) {
  const chk = canBuy(g, cardId);
  if (!chk.ok) return chk;
  const p = g.players[g.current];
  const card = CARDS[cardId];
  p.money -= card.cost;
  p.cards[cardId] = (p.cards[cardId] || 0) + 1;
  g.cardPool[cardId] -= 1;
  g.boughtThisTurn = true;
  log(g, `${p.name} 购买 ${card.name}，花费 ${card.cost}（剩余 ${g.cardPool[cardId]} 张）`);
  return { ok:true };
}

// ---------- 建设地标 ----------
function canBuild(g, landmarkId) {
  const p = g.players[g.current];
  const lm = LANDMARKS[landmarkId];
  if (!lm) return { ok:false, reason:'无此地标' };
  if (g.pendingChoice) return { ok:false, reason:'还有选择未完成' };
  if (!g.settled) return { ok:false, reason:'尚未结算' };
  if (p.landmarks[landmarkId]) return { ok:false, reason:'已建成' };
  if (p.money < lm.cost) return { ok:false, reason:'钱不够' };
  return { ok:true };
}

function buildLandmark(g, landmarkId) {
  const chk = canBuild(g, landmarkId);
  if (!chk.ok) return chk;
  const p = g.players[g.current];
  const lm = LANDMARKS[landmarkId];
  p.money -= lm.cost;
  p.landmarks[landmarkId] = true;
  log(g, `${p.name} 建设 ${lm.name}，花费 ${lm.cost}`);
  if (isWin(p)) {
    log(g, `🎉 ${p.name} 建成 4 个地标，获胜！`);
  }
  return { ok:true };
}

function isWin(p) {
  return Object.values(p.landmarks).every(v => v === true);
}

module.exports = {
  createGame, rollDice, canReroll, settle, handleChoice,
  canBuy, buyCard, canBuild, buildLandmark, isWin,
};