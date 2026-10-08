const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine');

function readyGame() {
  const game = E.createGame(['甲', '乙']);
  game.dice = { count: 1, values: [4], sum: 4, firstCount: 1 };
  game.settled = true;
  return game;
}

const DANGEROUS_KEYS = ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf', 'not-a-card'];

for (const key of DANGEROUS_KEYS) {
  test(`非法卡牌 ID「${key}」不会抛异常，也不会被当成卡牌`, () => {
    const game = readyGame();
    assert.doesNotThrow(() => E.canBuy(game, key));
    assert.equal(E.canBuy(game, key).ok, false);
    assert.doesNotThrow(() => E.buyCard(game, key));
    assert.equal(E.buyCard(game, key).ok, false);
  });

  test(`非法地标 ID「${key}」不会抛异常，也不会被当成地标`, () => {
    const game = readyGame();
    assert.doesNotThrow(() => E.canBuild(game, key));
    assert.equal(E.canBuild(game, key).ok, false);
    assert.doesNotThrow(() => E.buildLandmark(game, key));
    assert.equal(E.buildLandmark(game, key).ok, false);
  });
}

test('商场交换拒绝原型键，且不会污染卡牌表', () => {
  const game = E.createGame(['甲', '乙']);
  game.players[0].cards = { wheat: 1 };
  game.players[1].cards = { ranch: 1 };

  const badMine = E.handleChoice(game, 0, { type: 'mallPickCards', targetId: 1, myCardId: '__proto__', targetCardId: 'ranch' });
  assert.equal(badMine.ok, false);
  const badTheirs = E.handleChoice(game, 0, { type: 'mallPickCards', targetId: 1, myCardId: 'wheat', targetCardId: 'constructor' });
  assert.equal(badTheirs.ok, false);
  assert.deepEqual(game.players[0].cards, { wheat: 1 });
  assert.deepEqual(game.players[1].cards, { ranch: 1 });

  const ok = E.handleChoice(game, 0, { type: 'mallPickCards', targetId: 1, myCardId: 'wheat', targetCardId: 'ranch' });
  assert.equal(ok.ok, true);
  assert.equal(game.players[0].cards.ranch, 1);
  assert.equal(game.players[1].cards.wheat, 1);
});

