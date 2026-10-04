const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine');
const B = require('../bots');

function makeGame(names, dlcEnabled = false) {
  return E.createGame(names, { dlcEnabled });
}

test('人机购买决策：只买点数匹配、库存充足、买得起的合法卡', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  p.money = 10;
  g.dice = { sum: 4, count: 1, values: [4] };
  g.settled = true;
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const buy = B.decideBuy(g, p, difficulty);
    assert.ok(buy, `${difficulty} 难度应选择购买`);
    assert.ok(g.cardPool[buy.cardId] > 0, '库存充足');
    assert.ok(E.canBuy(g, buy.cardId, buy.source).ok, '购买必须合法');
  }
});

test('人机在资金不足时放弃购买', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  p.money = 0;
  g.dice = { sum: 4, count: 1, values: [4] };
  g.settled = true;
  for (const difficulty of ['easy', 'normal', 'hard']) {
    assert.equal(B.decideBuy(g, p, difficulty), null);
  }
});

test('人机建设决策：只建未建成且买得起的地标', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  p.money = 30;
  g.dice = { sum: 2, count: 1, values: [2] };
  g.settled = true;
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const build = B.decideBuild(g, p, difficulty);
    assert.ok(build, `${difficulty} 难度应返回建设`);
    assert.ok(!p.landmarks[build.landmarkId], '必须是未建成地标');
    assert.ok(E.canBuild(g, build.landmarkId, build.source).ok, '建设必须合法');
  }
});

test('普通/困难人机建设时预留资金，资金只够一个地标时不建设', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  p.money = 4; // 只够火车站，但普通/困难要预留 2 元
  g.dice = { sum: 2, count: 1, values: [2] };
  g.settled = true;
  assert.equal(B.decideBuild(g, p, 'normal'), null);
  assert.equal(B.decideBuild(g, p, 'hard'), null);
  const easy = B.decideBuild(g, p, 'easy');
  assert.equal(easy.landmarkId, 'train');
});

test('重掷决策：接受或重掷，且重掷骰数合法', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  p.landmarks.park = true;
  g.dice = { sum: 3, count: 1, values: [3], firstCount: 1 };
  g.pendingChoice = { type: 'askReroll', rollerId: 0 };
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const choice = B.decideChoice(g, p, difficulty);
    assert.ok(['accept', 'reroll'].includes(choice.type), `${difficulty} 的重掷决策类型合法`);
    if (choice.type === 'reroll') assert.ok(choice.count === 1 || (choice.count === 2 && p.landmarks.train));
  }
});

test('电视塔目标：普通选最富，困难选领跑者', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const me = g.players[0];
  g.players[1].money = 8; // 乙最富
  g.players[2].landmarks.train = true; // 丙地标领先
  g.players[3].money = 3;
  g.pendingChoice = { type: 'tvPickTarget', rollerId: 0 };
  const normal = B.decideChoice(g, me, 'normal');
  assert.equal(normal.targetId, 1);
  const hard = B.decideChoice(g, me, 'hard');
  assert.equal(hard.targetId, 2);
});

test('DLC 角色与任务选择必须来自可选列表', () => {
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const g = makeGame(['甲', '乙', '丙', '丁'], true);
    const p = g.players[0];
    const role = B.chooseRole(g, p, difficulty);
    assert.ok(p.dlc.roleOptions.includes(role), `${difficulty} 角色选择合法`);
    const task = B.chooseTask(g, p, difficulty);
    assert.ok(p.dlc.taskOptions.includes(task), `${difficulty} 任务选择合法`);
  }
});

test('掷骰数量：无火车站必为单骰，有火车站为1或2', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  for (const difficulty of ['easy', 'normal', 'hard']) {
    assert.equal(B.decideRollCount(g, p, difficulty, () => 0), 1);
  }
  p.landmarks.train = true;
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const count = B.decideRollCount(g, p, difficulty, () => 0);
    assert.ok(count === 1 || count === 2);
  }
});

test('直接按期望决定：双骰期望高选双骰，单骰期望高选单骰', () => {
  const alwaysDirect = () => 0; // 第一次随机数 < direct → 走“直接按期望”分支
  // 奶制品+牧场×2：双骰规划期望更高
  const g1 = makeGame(['甲', '乙', '丙', '丁']);
  const p1 = g1.players[0];
  p1.landmarks.train = true;
  p1.cards.dairy = 1;
  p1.cards.ranch = 2;
  for (const difficulty of ['easy', 'normal', 'hard']) {
    assert.equal(B.decideRollCount(g1, p1, difficulty, alwaysDirect), 2, `${difficulty} 直接按期望应选双骰`);
  }
  // 只有初始卡：单骰规划期望更高
  const g2 = makeGame(['甲', '乙', '丙', '丁']);
  const p2 = g2.players[0];
  p2.landmarks.train = true;
  for (const difficulty of ['easy', 'normal', 'hard']) {
    assert.equal(B.decideRollCount(g2, p2, difficulty, alwaysDirect), 1, `${difficulty} 直接按期望应选单骰`);
  }
});

// 可复现的伪随机数源（LCG），统计各难度选双骰的频率
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function rollTwoRate(game, player, difficulty, samples = 4000) {
  const rng = makeRng(20261004);
  let twos = 0;
  for (let i = 0; i < samples; i += 1) {
    if (B.decideRollCount(game, player, difficulty, rng) === 2) twos += 1;
  }
  return twos / samples;
}

test('期望加权选择：双骰期望高时选双骰概率过半，且难度越高越倾向双骰', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  p.landmarks.train = true;
  p.cards.dairy = 1;
  p.cards.ranch = 2;
  const easyRate = rollTwoRate(g, p, 'easy');
  const normalRate = rollTwoRate(g, p, 'normal');
  const hardRate = rollTwoRate(g, p, 'hard');
  assert.ok(easyRate > 0.5, `简单双骰概率应过半，实际 ${easyRate.toFixed(3)}`);
  assert.ok(normalRate > easyRate && hardRate > normalRate,
    `双骰概率应随难度递增：easy=${easyRate.toFixed(3)} normal=${normalRate.toFixed(3)} hard=${hardRate.toFixed(3)}`);
});

test('期望加权选择：单骰期望高时双骰概率随难度递减', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  p.landmarks.train = true;
  const easyRate = rollTwoRate(g, p, 'easy');
  const normalRate = rollTwoRate(g, p, 'normal');
  const hardRate = rollTwoRate(g, p, 'hard');
  assert.ok(easyRate > normalRate && normalRate > hardRate,
    `双骰概率应随难度递减：easy=${easyRate.toFixed(3)} normal=${normalRate.toFixed(3)} hard=${hardRate.toFixed(3)}`);
  assert.ok(hardRate < 0.5, `困难难度应偏向单骰，实际 ${hardRate.toFixed(3)}`);
});
