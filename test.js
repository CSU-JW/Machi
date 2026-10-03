// test.js
const E = require('./engine');
const { CARDS, LANDMARKS } = require('./cards');

const g = E.createGame(['A', 'B', 'C', 'D']);

// ---------- 打印某个玩家的状态 ----------
function formatPlayer(p) {
  const cardStr = Object.keys(p.cards)
    .filter(id => p.cards[id] > 0)
    .map(id => `${CARDS[id].name}x${p.cards[id]}`)
    .join(' ') || '（无卡牌）';

  const lmStr = Object.keys(p.landmarks)
    .filter(id => p.landmarks[id])
    .map(id => LANDMARKS[id].name)
    .join(' ') || '（无地标）';

  return `  ${p.name}: ${p.money}元 | 卡牌: ${cardStr} | 地标: ${lmStr}`;
}

// ---------- 打印全场状态 + 牌堆 ----------
function printBoard(g, title) {
  console.log(`\n===== ${title} =====`);
  g.players.forEach(p => console.log(formatPlayer(p)));

  const poolStr = Object.keys(g.cardPool)
    .filter(id => g.cardPool[id] > 0)
    .map(id => `${CARDS[id].name}:${g.cardPool[id]}`)
    .join(' ');
  console.log(`  [牌堆] ${poolStr}`);
}

// ---------- 简易 AI 回合 ----------
function aiTurn(g) {
  const p = g.players[g.current];
  const rollCount = p.landmarks.train ? (Math.random() < 0.5 ? 1 : 2) : 1;
  g.dice = { ...E.rollDice(rollCount), firstCount: rollCount };
  g.rerolled = false;

  console.log(`\n----- ${p.name} 的回合，掷出 ${g.dice.sum} (${g.dice.values.join('+')}) -----`);
  const events = E.settle(g, p.id, g.dice.sum);
  events.forEach(e => console.log('  ' + e));

  // 购买：优先买当前点数对应的、买得起的卡
  for (const cid of Object.keys(CARDS)) {
    const c = CARDS[cid];
    if (c.points.includes(g.dice.sum) && E.canBuy(g, cid).ok) {
      E.buyCard(g, cid);
      break;
    }
  }
  // 建设：随便建一个能建的
  for (const lid of Object.keys(LANDMARKS)) {
    if (E.canBuild(g, lid).ok) { E.buildLandmark(g, lid); break; }
  }
}

// ---------- 开局状态 ----------
printBoard(g, '开局状态');

// ---------- 主循环 ----------
let turn = 0;
while (turn < 200) {
  aiTurn(g);

  printBoard(g, `第 ${turn + 1} 回合结束（当前玩家: ${g.players[g.current].name}）`);

  if (E.isWin(g.players[g.current])) break;
  g.current = (g.current + 1) % 4;
  turn++;
}

// ---------- 最终结果 ----------
console.log('\n=== 最终财富 ===');
g.players.forEach(p => console.log(`${p.name}: ${p.money} 元, 地标 ${Object.values(p.landmarks).filter(Boolean).length}/4`));