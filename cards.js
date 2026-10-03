// cards.js

// 触发类型：
// 'any'   —— 任何人掷出该点数都触发（麦田/牧场/林场）
// 'self'  —— 只有自己回合掷出才触发（面包店/便利店/工厂类）
// 'other' —— 别人掷出时，别人付钱给我（咖啡店/奶茶店）
// 'six'   —— 6 点特殊卡，自己掷出 6 时触发

const CARDS = {
  wheat:      { id:'wheat',      name:'麦田',       cost:1, points:[1],      trigger:'any',   limit:14, effect:{type:'gain', amount:1} },
  ranch:      { id:'ranch',      name:'牧场',       cost:2, points:[2],      trigger:'any',   limit:10, effect:{type:'gain', amount:1} },
  bakery:     { id:'bakery',     name:'面包店',     cost:2, points:[2,3],    trigger:'self',  limit:12,  effect:{type:'gain', amount:1} },
  cafe:       { id:'cafe',       name:'咖啡店',     cost:2, points:[3],      trigger:'other', limit:8,  effect:{type:'take', amount:1} },
  convenience:{ id:'convenience',name:'便利店',     cost:2, points:[4],      trigger:'self',  limit:8,  effect:{type:'gain', amount:3} },
  forest:     { id:'forest',     name:'林场',       cost:3, points:[5],      trigger:'any',   limit:8,  effect:{type:'gain', amount:1} },
  stadium:    { id:'stadium',    name:'体育馆',     cost:6, points:[6],      trigger:'six',   limit:4,  effect:{type:'takeAll', amount:2} },
  tvStation:  { id:'tvStation',  name:'电视塔',     cost:8, points:[6],      trigger:'six',   limit:4,  effect:{type:'takeOne', amount:5} },
  mall:       { id:'mall',       name:'商场',       cost:7, points:[6],      trigger:'six',   limit:4,  effect:{type:'swap'} },

  dairy:      { id:'dairy',      name:'奶制品工厂', cost:3, points:[7],      trigger:'self',  limit:8,  effect:{type:'perCard', dep:'ranch', amount:2} },
  orchard:    { id:'orchard',    name:'果园',       cost:3, points:[8],      trigger:'self',  limit:8,  effect:{type:'perCard', dep:'forest', amount:2} },
  mine:       { id:'mine',       name:'矿山',       cost:3, points:[9],      trigger:'self',  limit:8,  effect:{type:'perCard', dep:'mine', amount:2} },
  teaHouse:   { id:'teaHouse',   name:'奶茶店',     cost:3, points:[9,10],   trigger:'other', limit:8,  effect:{type:'take', amount:3} },
  craft:      { id:'craft',      name:'工艺品工厂', cost:3, points:[10],     trigger:'self',  limit:7,  effect:{type:'perCardMulti', deps:['forest','mine'], amount:2} },
  farm:       { id:'farm',       name:'农产品工厂', cost:2, points:[11,12],  trigger:'self',  limit:7,  effect:{type:'perCard', dep:'wheat', amount:2} },
};

const UNIQUE_CARDS = ['stadium', 'tvStation', 'mall'];
const SIX_CARDS = ['stadium', 'tvStation', 'mall'];

const LANDMARKS = {
  train:  { id:'train',  name:'火车站',   cost:4  },
  radio:  { id:'radio',  name:'广播中心', cost:16 },
  mallC:  { id:'mallC',  name:'商业中心', cost:10 },
  park:   { id:'park',   name:'游乐园',   cost:22 },
};

// 生成初始公共牌堆：每种卡剩余数量 = limit
function createCardPool() {
  const pool = {};
  for (const id of Object.keys(CARDS)) pool[id] = CARDS[id].limit;
  return pool;
}

module.exports = { CARDS, LANDMARKS, UNIQUE_CARDS, SIX_CARDS, createCardPool };