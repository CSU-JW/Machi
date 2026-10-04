const { buildings } = require('./catalog');
const probability = (points, dice) => points.reduce((sum, point) => sum + (dice === 1 ? (point >= 1 && point <= 6 ? 1 / 6 : 0) : Math.max(0, 6 - Math.abs(7 - point)) / 36), 0);
function amount(card, dice, stage) {
  const dependencies = [0, 2, 3][stage];
  switch (card.effect) {
    case 'fixed': case 'take': return card.amount;
    case 'landmarkStep': return stage === 2 ? 3 : 2;
    case 'diceCount': return dice === 1 ? 1 : 2;
    case 'seafood': return Math.min(9, dependencies * 3); // 示例持有0/2/3渔场，无牧场
    case 'blueKinds': return Math.min(8, [1, 3, 4][stage] * 2);
    case 'landmarks': return Math.min(8, 2 + [0, 1, 3][stage] * 2);
    case 'factoryKinds': return [0, 2, 3][stage] * 3;
    default: throw new Error(card.effect);
  }
}
function expected(card, ownDice, otherDice, stage) {
  const own = probability(card.points, ownDice) * amount(card, ownDice, stage);
  const other = 3 * probability(card.points, otherDice) * amount(card, otherDice, stage);
  return card.color === 'blue' ? own + other : card.color === 'red' ? other : own;
}
console.log('四人每轮每张卡的期望收益（红卡为足额付款上界）；依赖示例见源码与 balance.md。');
console.table(buildings.map(card => {
  const values = [[1,1,0],[2,1,1],[2,2,2]].map(args => expected(card, ...args));
  return {建筑:card.name,价格:card.cost,全单骰:values[0].toFixed(3),自己双骰:values[1].toFixed(3),全双骰:values[2].toFixed(3),晚期每元收益:(values[2]/card.cost).toFixed(3)};
}));
module.exports = { probability, expected };
