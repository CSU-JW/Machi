const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CARDS, LANDMARKS } = require('../cards');

const rules = fs.readFileSync(path.join(__dirname, '..', 'rules.txt'), 'utf8');

const CARD_LIMITS = {
  麦田: 'wheat',
  牧场: 'ranch',
  面包店: 'bakery',
  咖啡店: 'cafe',
  便利店: 'convenience',
  林场: 'forest',
  体育馆: 'stadium',
  电视塔: 'tvStation',
  商场: 'mall',
  奶制品工厂: 'dairy',
  果园: 'orchard',
  矿山: 'mine',
  奶茶店: 'teaHouse',
  工艺品工厂: 'craft',
  农产品工厂: 'farm',
};

for (const [name, id] of Object.entries(CARD_LIMITS)) {
  test(`rules.txt 牌堆上限「${name}」与 cards.js 一致`, () => {
    assert.ok(
      rules.includes(`${name}：${CARDS[id].limit}`),
      `rules.txt 应包含「${name}：${CARDS[id].limit}」`,
    );
  });
}

const LANDMARK_COSTS = { 火车站: 'train', 广播中心: 'radio', 商业中心: 'mallC', 游乐园: 'park' };

for (const [name, id] of Object.entries(LANDMARK_COSTS)) {
  test(`rules.txt 地标造价「${name}」与 cards.js 一致`, () => {
    assert.ok(
      rules.includes(`${name}：价值${LANDMARKS[id].cost}`),
      `rules.txt 应包含「${name}：价值${LANDMARKS[id].cost}」`,
    );
  });
}

