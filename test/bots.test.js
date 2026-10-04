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

test('掷骰数量：无火车站必为单骰，有火车站合法', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  assert.equal(B.decideRollCount(g, p, 'easy'), 1);
  p.landmarks.train = true;
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const count = B.decideRollCount(g, p, difficulty);
    assert.ok(count === 1 || count === 2);
  }
});

test('持有7点以上产业卡且有火车站时，各难度人机都选择投两个骰子', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  p.landmarks.train = true;
  p.cards.dairy = 1;
  p.cards.ranch = 2;
  // 双骰期望：P(7)=6/36，奶制品修正后 4→5，EV2≈0.83 > 单骰 EV1=0.5
  for (const difficulty of ['easy', 'normal', 'hard']) {
    assert.equal(B.decideRollCount(g, p, difficulty), 2, `${difficulty} 应选择双骰`);
  }
});

test('初始卡且资金少时，普通人机比较规划期望后选择单骰', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  p.landmarks.train = true;
  // 只有麦田+面包店、资金3：双骰能买的奶制品依赖牧场(0张)收益低，规划期望仍偏向单骰
  assert.equal(B.decideRollCount(g, p, 'normal'), 1);
  // 简单：买得起的7点卡存在（奶制品3元）→ 双骰；资金1买不起 → 单骰
  assert.equal(B.decideRollCount(g, p, 'easy'), 2);
  p.money = 1;
  assert.equal(B.decideRollCount(g, p, 'easy'), 1);
});

test('没有7点卡但牧场多时，人机因“买卡解锁期望”选择投双骰', () => {
  const g = makeGame(['甲', '乙', '丙', '丁']);
  const p = g.players[0];
  p.landmarks.train = true;
  p.cards = { ranch: 2 }; // 牧场×2：双骰掷出7可买奶制品（每轮期望约0.78）
  for (const difficulty of ['easy', 'normal', 'hard']) {
    assert.equal(B.decideRollCount(g, p, difficulty), 2, `${difficulty} 应选择双骰`);
  }
});
