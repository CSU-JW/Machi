// bots.js —— 人机决策模块（服务端）
// 三档难度：
//   easy   —— 简单：掷骰随缘（有火车站就双骰），结算后有钱就买最便宜的匹配卡。
//   normal —— 普通：计算每张卡的期望收益/成本，按性价比购买、预留资金建设地标。
//   hard   —— 困难：针对其他玩家当前状态（领跑者、资金、骰子分布）做压制性策略，
//             包括红卡狙击领跑者、蓝卡押注其骰面、断供其产业链依赖、领先防守建设等。
const { CARDS, LANDMARKS } = require('./cards');
const D = require('./dlc1/runtime');

const DIFFICULTIES = ['easy', 'normal', 'hard'];
const BOT_LABELS = { easy: '简单', normal: '普通', hard: '困难' };
const SIX_CARDS = ['stadium', 'tvStation', 'mall', 'museum'];

// ---------- 骰子概率 ----------
const P1 = p => (p >= 1 && p <= 6 ? 1 / 6 : 0); // 单骰
const P2 = p => (p >= 2 && p <= 12 ? (6 - Math.abs(7 - p)) / 36 : 0); // 双骰
const profileOf = player => (player.landmarks && player.landmarks.train ? P2 : P1);
const countOf = (p, id) => (p.cards[id] || 0);
// 双骰收入修正加权命中率：点数为 p 时收益按 max(p/6,1) 放大（与引擎一致）
const weightedHits = (cardId, profile) =>
  CARDS[cardId].points.reduce((s, pt) => s + profile(pt) * Math.max(pt / 6, 1), 0);
const landmarkCount = p => Object.values(p.landmarks).filter(Boolean).length;

// ---------- 收益估算 ----------
// 某张卡触发一次时给 owner 带来的理想收益（不考虑对手资金上限）。
function triggerIncome(card, owner, game) {
  if (card.dlc) return D.income(card, owner, game);
  const mallBonus = owner.landmarks && owner.landmarks.mallC ? 1 : 0;
  switch (card.effect.type) {
    case 'gain': return card.effect.amount + mallBonus;
    case 'takeAll': return card.effect.amount;
    case 'takeOne': return card.effect.amount;
    case 'swap': return 1;
    case 'perCard': {
      const dep = countOf(owner, card.effect.dep);
      return (card.effect.amount + mallBonus) * Math.max(dep, 1);
    }
    case 'perCardMulti': {
      const total = card.effect.deps.reduce((s, d) => s + countOf(owner, d), 0);
      return (card.effect.amount + mallBonus) * Math.max(total, 1);
    }
    default: return 1;
  }
}

// 完整一轮（每名玩家各掷一次）内该卡给 owner 带来的期望收益。
function roundEv(game, owner, cardId) {
  const card = CARDS[cardId];
  if (!card) return 0;
  if (card.trigger === 'six') {
    if (cardId === 'stadium') return (1 / 6) * 2 * Math.max(game.players.length - 1, 1);
    if (cardId === 'tvStation') return (1 / 6) * 5;
    if (cardId === 'mall') return 0.3;
    return 0;
  }
  const income = triggerIncome(card, owner, game);
  let hits = 0;
  if (card.trigger === 'self') {
    hits = weightedHits(cardId, profileOf(owner));
  } else if (card.trigger === 'any') {
    for (const pl of game.players) hits += weightedHits(cardId, profileOf(pl));
  } else if (card.trigger === 'other') {
    for (const pl of game.players) if (pl.id !== owner.id) hits += weightedHits(cardId, profileOf(pl));
  }
  return income * hits;
}

// 对局领跑者：已建成地标最多者领先，其次比资金。
function findLeader(game, selfId) {
  let best = null;
  for (const pl of game.players) {
    if (pl.id === selfId) continue;
    if (!best
      || landmarkCount(pl) > landmarkCount(best)
      || (landmarkCount(pl) === landmarkCount(best) && pl.money > best.money)) best = pl;
  }
  return best;
}

// 自己掷出某个点数时的净收益：收入 − 对手红卡收费（收费以我的资金为上限）。
// count 为骰子个数，双骰时收益按 max(sum/6,1) 修正（与引擎一致）。
function valueOfSum(game, me, sum, count = 1) {
  const multiplier = count === 2 ? Math.max(sum / 6, 1) : 1;
  let value = 0;
  for (const id of Object.keys(me.cards)) {
    const n = countOf(me, id);
    if (n <= 0 || !CARDS[id] || !CARDS[id].points.includes(sum)) continue;
    const card = CARDS[id];
    if (card.trigger === 'self' || card.trigger === 'any') {
      value += Math.ceil(triggerIncome(card, me, game) * n * multiplier);
    } else if (card.trigger === 'six') {
      value += id === 'stadium' ? 2 * Math.max(game.players.length - 1, 1) : id === 'tvStation' ? 4 : 1;
    }
  }
  for (const opp of game.players) {
    if (opp.id === me.id) continue;
    for (const id of Object.keys(opp.cards)) {
      const n = countOf(opp, id);
      if (n <= 0 || !CARDS[id] || CARDS[id].trigger !== 'other' || !CARDS[id].points.includes(sum)) continue;
      value -= Math.min(Math.ceil(triggerIncome(CARDS[id], opp, game) * n * multiplier), me.money);
    }
  }
  return value;
}

function avgRollValue(game, me, count) {
  const profile = count === 2 ? P2 : P1;
  let total = 0;
  const maxSum = count === 2 ? 12 : 6;
  for (let s = count; s <= maxSum; s += 1) total += profile(s) * valueOfSum(game, me, s, count);
  return total;
}

// ---------- 卡牌取舍 ----------
function bestOwnedCard(game, player) {
  let best = null;
  for (const id of Object.keys(player.cards)) {
    if (countOf(player, id) <= 0 || SIX_CARDS.includes(id)) continue;
    const ev = roundEv(game, player, id);
    if (!best || ev > best.ev) best = { id, ev };
  }
  return best;
}

function worstOwnedCard(game, player) {
  let worst = null;
  for (const id of Object.keys(player.cards)) {
    if (countOf(player, id) <= 0 || SIX_CARDS.includes(id)) continue;
    const ev = roundEv(game, player, id);
    if (!worst || ev < worst.ev) worst = { id, ev };
  }
  return worst;
}

// 最优支付方案：DLC 角色技能/优惠券/事件折扣中选实付最低的来源。
function bestQuote(game, player, kind, id, cost) {
  const quotes = D.quote(game, player, kind, id, cost);
  let best = quotes[0];
  for (const q of quotes) if (q.cost < best.cost) best = q;
  return best;
}

// ---------- 掷骰与选择 ----------
function decideRollCount(game, player, difficulty) {
  if (!player.landmarks.train) return 1;
  // 简单：粗略判断——自己拥有 7 点及以上可触发的卡时才投两个骰子
  if (difficulty === 'easy') {
    const hasHighCard = Object.keys(player.cards).some(id =>
      countOf(player, id) > 0
      && CARDS[id]
      && CARDS[id].trigger === 'self'
      && CARDS[id].points.some(pt => pt >= 7));
    return hasHighCard ? 2 : 1;
  }
  // 普通/困难：比较单骰与双骰的期望收益（双骰期望已含收入修正）
  const ev1 = avgRollValue(game, player, 1);
  const ev2 = avgRollValue(game, player, 2);
  if (difficulty === 'hard') {
    // 困难：落后于领跑者时更愿意承担双骰风险追分
    const leader = findLeader(game, player.id);
    const behind = Boolean(leader && (
      landmarkCount(leader) > landmarkCount(player)
      || (landmarkCount(leader) === landmarkCount(player) && leader.money > player.money + 3)));
    return ev2 + (behind ? 0.5 : 0) > ev1 ? 2 : 1;
  }
  return ev2 > ev1 ? 2 : 1;
}

function decideChoice(game, player, difficulty) {
  const choice = game.pendingChoice;
  if (!choice) return null;

  if (choice.type === 'askReroll') {
    if (difficulty === 'easy') return { type: 'accept' };
    const current = valueOfSum(game, player, game.dice.sum, game.dice.count);
    let bestCount = 1;
    let bestValue = avgRollValue(game, player, 1);
    if (player.landmarks.train) {
      const v2 = avgRollValue(game, player, 2);
      if (v2 > bestValue) { bestCount = 2; bestValue = v2; }
    }
    const margin = difficulty === 'hard' ? 0.25 : 0;
    if (current + margin < bestValue) return { type: 'reroll', count: bestCount };
    return { type: 'accept' };
  }

  if (choice.type === 'askStadium') {
    return { type: 'askStadium', activate: game.players.some(p => p.id !== player.id && p.money > 0) };
  }

  if (choice.type === 'askTv') {
    return { type: 'askTv', activate: game.players.some(p => p.id !== player.id && p.money > 0) };
  }

  if (choice.type === 'tvPickTarget') {
    // 普通：收最有钱的；困难：收领跑者（地标最多，其次资金）。
    let target = null;
    for (const p of game.players) {
      if (p.id === player.id) continue;
      if (!target) { target = p; continue; }
      const score = candidate => (difficulty === 'hard' ? landmarkCount(candidate) : 0);
      if (score(p) > score(target) || (score(p) === score(target) && p.money > target.money)) target = p;
    }
    return { type: 'tvPickTarget', targetId: target ? target.id : null };
  }

  if (choice.type === 'askMall') {
    if (difficulty === 'easy') return { type: 'askMall', activate: false };
    const mine = worstOwnedCard(game, player);
    const targets = game.players.filter(p =>
      p.id !== player.id
      && Object.keys(p.cards).some(id => countOf(p, id) > 0 && !SIX_CARDS.includes(id)));
    const worthwhile = targets.some((p) => {
      const theirs = bestOwnedCard(game, p);
      return theirs && (!mine || theirs.ev > mine.ev);
    });
    return { type: 'askMall', activate: worthwhile };
  }

  if (choice.type === 'mallPickTarget') {
    const candidates = game.players.filter(p =>
      p.id !== player.id
      && Object.keys(p.cards).some(id => countOf(p, id) > 0 && !SIX_CARDS.includes(id)));
    if (!candidates.length) return null;
    if (difficulty === 'hard') {
      const leader = findLeader(game, player.id);
      if (leader && candidates.includes(leader)) return { type: 'mallPickTarget', targetId: leader.id };
    }
    let best = null;
    for (const p of candidates) {
      const theirs = bestOwnedCard(game, p);
      const ev = theirs ? theirs.ev : -1;
      if (!best || ev > best.ev) best = { target: p, ev };
    }
    return { type: 'mallPickTarget', targetId: best.target.id };
  }

  if (choice.type === 'mallPickCards') {
    const target = game.players.find(p => p.id === choice.targetId);
    const mine = worstOwnedCard(game, player);
    const theirs = bestOwnedCard(game, target);
    if (!mine || !theirs) return null;
    return { type: 'mallPickCards', targetId: target.id, myCardId: mine.id, targetCardId: theirs.id };
  }

  return null;
}

// ---------- 购买 ----------
// 困难模式的压制性评分。
function counterScore(game, me, cardId) {
  const card = CARDS[cardId];
  const leader = findLeader(game, me.id);
  let score = 0;

  if (card.trigger === 'self') {
    score += roundEv(game, me, cardId);
    // 自己已有的产业链卡依赖该卡时，买它有联动收益。
    for (const other of Object.keys(me.cards)) {
      const c = CARDS[other];
      if (!c || countOf(me, other) <= 0 || !c.effect) continue;
      if (c.effect.type === 'perCard' && c.effect.dep === cardId) score += triggerIncome(c, me, game) * weightedHits(other, profileOf(me));
      if (c.effect.type === 'perCardMulti' && c.effect.deps.includes(cardId)) score += triggerIncome(c, me, game) * weightedHits(other, profileOf(me));
    }
  } else if (card.trigger === 'any') {
    // 蓝卡押注全桌，领跑者的骰面权重更高。
    for (const pl of game.players) {
      const weight = leader && pl.id === leader.id ? 1.5 : 1;
      score += triggerIncome(card, me, game) * weightedHits(cardId, profileOf(pl)) * weight;
    }
  } else if (card.trigger === 'other') {
    // 红卡狙击：优先覆盖领跑者与有钱玩家的骰面。
    for (const pl of game.players) {
      if (pl.id === me.id) continue;
      let weight = leader && pl.id === leader.id ? 1.5 : 1;
      if (pl.money < triggerIncome(card, me, game)) weight *= 0.6;
      score += triggerIncome(card, me, game) * weightedHits(cardId, profileOf(pl)) * weight;
    }
  } else {
    score += roundEv(game, me, cardId);
  }

  // 断供压制：领跑者产业链依赖的卡被买走会削弱其收入。
  if (leader) {
    for (const other of Object.keys(leader.cards)) {
      const c = CARDS[other];
      if (!c || countOf(leader, other) <= 0 || !c.effect) continue;
      if (c.effect.type === 'perCard' && c.effect.dep === cardId) score += 1.2;
      if (c.effect.type === 'perCardMulti' && c.effect.deps.includes(cardId)) score += 1.2;
    }
  }
  return score;
}

function decideBuy(game, player, difficulty) {
  if (!game.dice || !game.settled || game.boughtThisTurn) return null;
  const sum = game.dice.sum;
  const options = [];
  for (const id of Object.keys(game.cardPool)) {
    if ((game.cardPool[id] || 0) <= 0) continue;
    const card = CARDS[id];
    if (!card || !card.points.includes(sum)) continue;
    if (card.dlc && !game.dlcEnabled) continue;
    if (SIX_CARDS.includes(id) && countOf(player, id) > 0) continue;
    const quote = bestQuote(game, player, 'buy', id, card.cost);
    if (player.money < quote.cost) continue;
    let score;
    if (difficulty === 'easy') score = -quote.cost; // 越便宜越好
    else if (difficulty === 'normal') score = roundEv(game, player, id) / quote.cost;
    else score = counterScore(game, player, id) / quote.cost;
    options.push({ id, source: quote.source, score });
  }
  if (!options.length) return null;
  options.sort((a, b) => b.score - a.score);
  return { cardId: options[0].id, source: options[0].source };
}

// ---------- 建设 ----------
const BUILD_PRIORITY_NORMAL = ['train', 'mallC', 'park', 'radio'];
const BUILD_PRIORITY_HARD = ['train', 'park', 'mallC', 'radio'];

function decideBuild(game, player, difficulty) {
  if (!game.dice || !game.settled || game.builtThisTurn) return null;
  const unbuilt = Object.keys(LANDMARKS).filter(id => !player.landmarks[id]);
  const affordable = unbuilt
    .map(id => ({ id, quote: bestQuote(game, player, 'build', id, LANDMARKS[id].cost) }))
    .filter(item => player.money >= item.quote.cost);
  if (!affordable.length) return null;

  if (difficulty === 'easy') {
    affordable.sort((a, b) => a.quote.cost - b.quote.cost);
    return { landmarkId: affordable[0].id, source: affordable[0].quote.source };
  }

  const leader = difficulty === 'hard' ? findLeader(game, player.id) : null;
  const inDanger = Boolean(leader && landmarkCount(leader) >= 3); // 领跑者只差一个地标
  const reserve = 2;
  const priority = difficulty === 'hard' ? BUILD_PRIORITY_HARD : BUILD_PRIORITY_NORMAL;
  const pool = inDanger ? affordable : affordable.filter(item => player.money >= item.quote.cost + reserve);
  if (!pool.length) return null;
  for (const id of priority) {
    const hit = pool.find(item => item.id === id);
    if (hit) return { landmarkId: hit.id, source: hit.quote.source };
  }
  pool.sort((a, b) => a.quote.cost - b.quote.cost);
  return { landmarkId: pool[0].id, source: pool[0].quote.source };
}

// ---------- DLC 角色与任务 ----------
const ROLE_SCORE_NORMAL = { 0: 3, 1: 3, 2: 3, 3: 3, 4: 2, 5: 2 };
const ROLE_PREFERENCE_HARD = [0, 3, 4, 1, 2, 5]; // 建筑师→导游→会计→采购员→园艺师→收藏家

function chooseRole(game, player, difficulty) {
  const options = player.dlc.roleOptions;
  if (difficulty === 'easy') return options[0];
  if (difficulty === 'normal') {
    let best = options[0];
    for (const r of options) if ((ROLE_SCORE_NORMAL[r] || 0) > (ROLE_SCORE_NORMAL[best] || 0)) best = r;
    return best;
  }
  for (const r of ROLE_PREFERENCE_HARD) if (options.includes(r)) return r;
  return options[0];
}

const TASK_SCORE = { variety: 3, blue: 4, coast: 3, industry: 2, tourism: 3, diversity: 2, research: 1, community: 2 };

function chooseTask(game, player, difficulty) {
  const options = player.dlc.taskOptions;
  if (difficulty === 'easy') return options[0];
  let best = options[0];
  let bestScore = -1;
  for (const id of options) {
    let score = TASK_SCORE[id] || 0;
    if (difficulty === 'hard') {
      const role = player.dlc.role;
      if (id === 'tourism' && [0, 3].includes(role)) score += 2; // 建筑师/导游与地标任务协同
      if ((id === 'diversity' || id === 'community') && role === 5) score += 1; // 收藏家
      if (id === 'variety' && role === 2) score += 1; // 园艺师
    }
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}

module.exports = {
  DIFFICULTIES,
  BOT_LABELS,
  decideRollCount,
  decideChoice,
  decideBuy,
  decideBuild,
  chooseRole,
  chooseTask,
};
