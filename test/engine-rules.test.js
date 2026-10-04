const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine');

test('广播中心在最终接受的两枚骰子为对子时给予额外回合', () => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const player = game.players[0];
  player.landmarks.radio = true;
  game.dice = { count: 2, values: [4, 4], sum: 8, firstCount: 2 };

  const result = E.settle(game, 0, 8);
  assert.equal(game.extraTurn, true);
  assert.ok(result.events.some(event => event.includes('广播中心')));

  const turnResult = E.endTurn(game);
  assert.equal(turnResult.extraTurn, true);
  assert.equal(game.current, 0);
  assert.equal(game.extraTurn, false);
  assert.equal(game.turnNumber, 2);
});

test('广播中心不再提供重掷，非对子或单骰也不会给予额外回合', () => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const player = game.players[0];
  player.landmarks.radio = true;
  game.dice = { count: 2, values: [2, 3], sum: 5, firstCount: 2 };
  assert.equal(E.canReroll(game, player), false);
  E.settle(game, 0, 5);
  assert.equal(game.extraTurn, false);

  game.dice = { count: 1, values: [3], sum: 3, firstCount: 1 };
  game.settled = false;
  E.settle(game, 0, 3);
  assert.equal(game.extraTurn, false);
});

test('游乐园在首次投掷一个或两个骰子后都可以重掷', () => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const player = game.players[0];
  player.landmarks.park = true;
  game.dice = { count: 1, values: [2], sum: 2, firstCount: 1 };
  assert.equal(E.canReroll(game, player), true);
  game.dice = { count: 2, values: [1, 2], sum: 3, firstCount: 2 };
  assert.equal(E.canReroll(game, player), true);
});

test('游乐园重掷后只触发重投结果，第一次结果完全作废', t => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const player = game.players[0];
  player.landmarks.park = true;
  game.dice = { count: 1, values: [1], sum: 1, firstCount: 1 };
  game.pendingChoice = { type: 'askReroll', rollerId: 0 };

  const originalRandom = Math.random;
  Math.random = () => 0.4;
  t.after(() => { Math.random = originalRandom; });

  const result = E.handleChoice(game, 0, { type: 'reroll', count: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(game.dice.values, [3]);
  assert.deepEqual(game.players.map(item => item.money), [4, 3, 3, 3]);
  assert.equal(result.events.some(event => event.includes('麦田')), false);
  assert.equal(result.events.some(event => event.includes('面包店')), true);
});

test('游乐园从单骰结果重投两枚骰子时仍要求火车站', t => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const player = game.players[0];
  player.landmarks.park = true;
  game.dice = { count: 1, values: [4], sum: 4, firstCount: 1 };
  assert.equal(E.handleChoice(game, 0, { type: 'reroll', count: 2 }).ok, false);

  player.landmarks.train = true;
  const originalRandom = Math.random;
  Math.random = () => 0;
  t.after(() => { Math.random = originalRandom; });
  const result = E.handleChoice(game, 0, { type: 'reroll', count: 2 });
  assert.equal(result.ok, true);
  assert.equal(game.dice.count, 2);
  assert.deepEqual(game.dice.values, [1, 1]);
});

test('体育馆只能拿走其他玩家现有资金，任何玩家资金都不会为负', () => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const roller = game.players[0];
  roller.cards.stadium = 1;
  roller.money = 0;
  game.players[1].money = 1;
  game.players[2].money = 2;
  game.players[3].money = 0;

  const result = E.handleChoice(game, 0, { type: 'askStadium', activate: true });
  assert.equal(result.ok, true);
  assert.equal(roller.money, 3);
  assert.deepEqual(game.players.slice(1).map(player => player.money), [0, 0, 0]);
});

test('电视塔及咖啡店收费不超过付款方现有资金', () => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const roller = game.players[0];
  roller.cards.tvStation = 1;
  roller.money = 0;
  game.players[1].money = 3;
  const tvResult = E.handleChoice(game, 0, { type: 'tvPickTarget', targetId: 1 });
  assert.equal(tvResult.ok, true);
  assert.equal(roller.money, 3);
  assert.equal(game.players[1].money, 0);

  roller.money = 1;
  roller.cards.bakery = 0;
  game.players[1].cards.cafe = 2;
  game.dice = { count: 1, values: [3], sum: 3, firstCount: 1 };
  E.settle(game, 0, 3);
  assert.equal(roller.money, 0);
  assert.equal(game.players[1].money, 1);
  assert.ok(game.players.every(player => player.money >= 0));
});

test('双骰收入修正：点数和≥7 时卡牌收益乘以 (m+n)/6 并向上取整', () => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const player = game.players[0];
  player.cards.dairy = 1;
  player.cards.ranch = 2;
  game.dice = { count: 2, values: [3, 4], sum: 7, firstCount: 2 };

  const result = E.settle(game, 0, 7);
  // 奶制品基础收益 2×2=4，修正 a=7/6 → ceil(4×7/6)=5
  assert.equal(player.money, 3 + 5);
  assert.ok(result.events.some(event => event.includes('（×1.17）')), '日志应直接显示倍率');
  assert.equal(E.diceIncomeMultiplier(game), 7 / 6);
});

test('单骰与双骰低和（≤6）不享受修正，a 为 1', () => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const player = game.players[0];
  game.dice = { count: 2, values: [1, 2], sum: 3, firstCount: 2 };
  assert.equal(E.diceIncomeMultiplier(game), 1);
  E.settle(game, 0, 3);
  assert.equal(player.money, 3 + 1); // 面包店 +1，无放大

  game.dice = { count: 1, values: [6], sum: 6, firstCount: 1 };
  assert.equal(E.diceIncomeMultiplier(game), 1);
});

test('红卡收费同样适用双骰修正，且不超过付款方现有资金', () => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  game.players[1].cards.teaHouse = 1;
  game.players[0].money = 10;
  game.dice = { count: 2, values: [4, 5], sum: 9, firstCount: 2 };

  E.settle(game, 0, 9);
  // 奶茶店 2 × 9/6 = 3 → 甲支付 3
  assert.equal(game.players[1].money, 3 + 3);
  assert.equal(game.players[0].money, 10 - 3);

  // 付款方资金不足时封顶
  const game2 = E.createGame(['甲', '乙', '丙', '丁']);
  game2.players[1].cards.teaHouse = 1;
  game2.players[0].money = 2;
  game2.dice = { count: 2, values: [4, 5], sum: 9, firstCount: 2 };
  E.settle(game2, 0, 9);
  assert.equal(game2.players[0].money, 0);
  assert.equal(game2.players[1].money, 3 + 2);
});
