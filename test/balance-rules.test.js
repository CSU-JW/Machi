const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine');
const { CARDS, LANDMARKS } = require('../cards');

test('每回合最多建设一个地标，下回合恢复建设资格', () => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const player = game.players[0];
  player.money = 100;
  game.settled = true;
  game.dice = { count: 1, values: [1], sum: 1, firstCount: 1 };

  assert.equal(E.buildLandmark(game, 'train').ok, true);
  const secondBuild = E.buildLandmark(game, 'radio');
  assert.equal(secondBuild.ok, false);
  assert.equal(secondBuild.reason, '本回合已建设过地标');

  E.endTurn(game);
  game.current = 0;
  game.settled = true;
  game.dice = { count: 1, values: [1], sum: 1, firstCount: 1 };
  assert.equal(E.buildLandmark(game, 'radio').ok, true);
});

test('奶茶店收益、电视塔价格和商业中心价格采用新数值', () => {
  assert.equal(CARDS.teaHouse.effect.amount, 2);
  assert.equal(CARDS.tvStation.cost, 6);
  assert.equal(LANDMARKS.mallC.cost, 13);
});

test('农产品工厂同时按照麦田和果园数量计算收益', () => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const player = game.players[0];
  player.cards.farm = 1;
  player.cards.wheat = 2;
  player.cards.orchard = 3;
  player.money = 0;
  game.dice = { count: 2, values: [5, 6], sum: 11, firstCount: 2 };

  const result = E.settle(game, 0, 11);
  assert.equal(player.money, 10);
  assert.ok(result.events.some(event => event.includes('农产品工厂')));
});

test('建成第四个地标后立即标记游戏结束和胜者', () => {
  const game = E.createGame(['甲', '乙', '丙', '丁']);
  const player = game.players[0];
  player.money = 100;
  player.landmarks.train = true;
  player.landmarks.radio = true;
  player.landmarks.mallC = true;
  game.settled = true;
  game.dice = { count: 2, values: [6, 6], sum: 12, firstCount: 2 };

  assert.equal(E.buildLandmark(game, 'park').ok, true);
  assert.equal(game.gameOver, true);
  assert.equal(game.winnerId, 0);
  assert.equal(game.phase, 'finished');
  assert.equal(E.endTurn(game).gameOver, true);
  assert.equal(game.current, 0);
});
