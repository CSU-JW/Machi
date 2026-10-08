const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../engine');
const D=require('../dlc1/runtime');
const {CARDS}=require('../cards');
test('角色二选一有效校验、重复提交拒绝、双方选择后开始',()=>{
  const g=E.createGame(['甲'],{dlcEnabled:true}),d=g.players[0].dlc;
  assert.equal(new Set(d.roleOptions).size,2);
  assert.equal(D.chooseRole(g,0,99).ok,false);
  assert.equal(D.chooseRole(g,0,d.roleOptions[1]).ok,true);
  assert.equal(d.role,d.roleOptions[1]);assert.equal(g.dlc.selecting,true);
  assert.equal(D.chooseRole(g,0,d.roleOptions[0]).ok,false);
  D.chooseTask(g,0,d.taskOptions[0]);assert.equal(g.dlc.selecting,false);
});
test('单人回合可以连续进行且六点不出现无目标的收费选择',()=>{
  const g=E.createGame(['测试']);g.players[0].cards={stadium:1,tvStation:1,mall:1};
  g.dice={sum:6,count:1,values:[6]};g.settled=true;
  assert.equal(E.settle(g,0,6).needChoice,null);
  E.endTurn(g);assert.equal(g.current,0);assert.equal(g.turnNumber,2);
});
function setup(dlc=true){
  const g=E.createGame(['甲','乙','丙','丁'],{dlcEnabled:dlc});
  if(dlc){D.finishTaskSelection(g);g.dlc.eventIndex=7;for(const p of g.players){p.dlc.role=0;p.dlc.taskId=null;}}
  return g;
}
function roll(g,sum){g.dice={count:sum>6?2:1,values:sum>6?[6,sum-6]:[sum],sum};g.settled=true;return E.settle(g,g.current,sum);}
test('所有座位均先支付咖啡店，再获得面包店收入；不追缴新收益',()=>{
  for(let id=0;id<4;id++){
    const g=setup(false);g.current=id;const p=g.players[id];p.money=0;
    const other=g.players[(id+1)%4];other.cards.cafe=2;other.money=0;
    const r=roll(g,3);assert.equal(p.money,1);assert.equal(other.money,0);
    assert.match(r.events[0],/支付 0/);assert.match(r.events[1],/面包店/);
  }
});
test('奶茶店和夜市优先于工厂，同类按座位依次收取现有资金',()=>{
  const g=setup();g.players[0].cards={craft:1,forest:2};g.players[0].money=3;
  g.players[1].cards={teaHouse:1};g.players[1].money=0;
  g.players[2].cards={nightMarket:1};g.players[2].money=0;
  const r=roll(g,10);assert.deepEqual(g.players.map(p=>p.money),[7,3,0,3]);
  assert.match(r.events[0],/奶茶店/);assert.match(r.events[1],/夜市/);assert.match(r.events[2],/工艺品/);
});
test('体育馆、电视塔收费全部完成才发博物馆收益，拒绝收费也继续结算',()=>{
  for(const activate of [true,false]){
    const g=setup();g.players[0].cards={stadium:1,tvStation:1,museum:1};g.players[0].money=0;
    let r=roll(g,6);assert.equal(r.needChoice.type,'askStadium');assert.equal(g.players[0].money,0);
    r=E.handleChoice(g,0,{type:'askStadium',activate});assert.equal(r.needChoice.type,'askTv');
    assert.equal(g.players[0].money,activate?6:0);
    r=E.handleChoice(g,0,{type:'askTv',activate:false});
    assert.equal(g.players[0].money,activate?9:3);assert.match(r.events.at(-1),/博物馆/);assert.equal(g.incomePending,false);
  }
});
test('接受与重投都使用新的收费优先顺序，旧投掷不会结算',t=>{
  for(const mode of ['accept','reroll']){
    const g=setup(false);g.players[0].money=0;g.players[0].landmarks.park=true;g.players[1].cards.cafe=1;
    g.dice={count:1,values:[mode==='accept'?3:1],sum:mode==='accept'?3:1,firstCount:1};
    const original=Math.random;Math.random=()=>0.4;
    let r;try{r=E.handleChoice(g,0,{type:mode,count:1});}finally{Math.random=original;}
    assert.equal(r.ok,true);assert.equal(g.players[0].money,1);assert.equal(g.players[1].money,3);
    assert.ok(!r.events.some(e=>e.includes('麦田')));
  }
});
test('关闭DLC时没有新牌、任务、事件或角色，且无法购买DLC卡',()=>{
  const g=setup(false);assert.equal(Object.keys(g.cardPool).length,15);assert.equal(g.dlc,undefined);
  roll(g,1);assert.equal(E.buyCard(g,'florist').ok,false);
  const enabled=setup();assert.equal(Object.keys(enabled.cardPool).length,26);
});
test('11种新建筑公式与上限',()=>{
  const g=setup();g.dice={count:2};const p=g.players[0];p.cards={wheat:1,ranch:2,forest:2,fishery:4,harbor:1,dairy:1,craft:1,farm:1};
  p.landmarks={train:true,radio:true,mallC:true,park:false};
  const cases={florist:2,fishery:1,bookshop:2,busDepot:3,harbor:2,museum:3,seafoodMarket:9,aquarium:8,spa:8,nightMarket:4,techPark:9};
  for(const [id,value] of Object.entries(cases))assert.equal(D.income(CARDS[id],p,g),value,id);
  g.dice.count=1;assert.equal(D.income(CARDS.harbor,p,g),1);
});
test('任务三档候选、超时默认与四种不同角色',()=>{
  const g=E.createGame(['甲','乙','丙','丁'],{dlcEnabled:true});
  assert.equal(new Set(g.players.map(p=>p.dlc.role)).size,4);
  assert.equal(D.chooseTask(g,0,'forged').ok,false);
  const selected=g.players[0].dlc.taskOptions[2];assert.equal(D.chooseTask(g,0,selected).ok,true);
  assert.equal(D.chooseTask(g,0,g.players[0].dlc.taskOptions[0]).ok,false);
  D.finishTaskSelection(g);assert.equal(g.dlc.selecting,false);assert.equal(g.players[0].dlc.taskId,selected);
  assert.equal(g.players[1].dlc.taskId,g.players[1].dlc.taskOptions[0]);
});
test('任务券不重复领取，下个自己的回合生效，优惠不可叠加且失败不消耗',()=>{
  const g=setup(),p=g.players[0];p.dlc.taskId='blue';p.cards={wheat:1,ranch:1,forest:1};
  D.checkTasks(g);D.checkTasks(g);assert.equal(p.dlc.coupons.length,1);
  assert.equal(D.quote(g,p,'buy','bookshop',2).length,1);
  p.dlc.ownTurn++;p.dlc.role=1;g.dlc.eventIndex=1;roll(g,3);
  p.money=0;assert.equal(E.buyCard(g,'bookshop','coupon:0').ok,false);assert.equal(p.dlc.coupons.length,1);
  p.money=1;assert.equal(E.buyCard(g,'bookshop','coupon:0').ok,true);assert.equal(p.money,0);assert.equal(p.dlc.coupons.length,0);
  assert.equal(p.dlc.used,0);assert.deepEqual(g.dlc.eventUsed,[]);
});
test('主动技能冷却与次数上限，会计不能打断未结算阶段',()=>{
  const g=setup(),p=g.players[0];p.dlc.role=4;p.money=0;
  assert.equal(D.useRole(g,p).ok,false);g.settled=true;
  for(let i=0;i<3;i++){
    p.money=0;assert.equal(D.useRole(g,p).ok,true);assert.equal(D.useRole(g,p).ok,false);
    p.dlc.ownTurn+=3;
  }
  p.money=0;assert.equal(D.useRole(g,p).ok,false);assert.equal(p.dlc.used,3);
});
test('采购员实际购买后才进入冷却，建筑师只使用一次',()=>{
  const g=setup(),p=g.players[0];p.dlc.role=1;p.money=10;roll(g,3);
  assert.equal(E.buyCard(g,'bookshop','role').ok,true);assert.equal(p.dlc.readyAt,5);
  g.boughtThisTurn=false;p.dlc.ownTurn=4;assert.equal(E.buyCard(g,'bookshop','role').ok,false);
  p.dlc.ownTurn=5;assert.equal(E.buyCard(g,'bookshop','role').ok,true);
  p.dlc.role=0;p.dlc.used=0;p.dlc.readyAt=1;p.money=100;
  assert.equal(E.buildLandmark(g,'train','role').ok,true);assert.equal(p.money,99);
  g.builtThisTurn=false;assert.equal(E.buildLandmark(g,'radio','role').ok,false);
});
test('收藏家不刷重复阈值，便民服务延迟生效且最多三次',()=>{
  const g=setup(),p=g.players[0];p.dlc.role=5;p.cards={wheat:1,bakery:1,ranch:1,forest:1};p.money=0;
  D.checkTasks(g);D.checkTasks(g);assert.equal(p.money,1);
  p.dlc.serviceLeft=3;p.dlc.serviceReady=p.dlc.ownTurn;
  D.end(g,p,true);assert.equal(p.money,1);assert.equal(p.dlc.serviceLeft,3);
  D.end(g,p,false);assert.equal(p.money,2);assert.equal(p.dlc.serviceLeft,2);
  D.end(g,p,false);D.end(g,p,false);
  assert.equal(p.money,4);assert.equal(p.dlc.serviceLeft,0);
  D.end(g,p,false);assert.equal(p.money,4);
});
test('事件每轮最多一次，额外回合不换事件，四位行动结束才换',()=>{
  const g=setup(),p=g.players[0];g.dlc.eventIndex=0;
  const before=p.money;roll(g,1);assert.equal(p.money,before+2);
  g.extraTurn=true;E.endTurn(g);roll(g,1);assert.equal(p.money,before+3);assert.equal(g.dlc.round,1);
  E.endTurn(g);E.endTurn(g);E.endTurn(g);assert.equal(g.dlc.round,1);
  E.endTurn(g);assert.equal(g.dlc.round,2);assert.deepEqual(g.dlc.eventUsed,[]);
});
test('博物馆每人唯一且不可商场交换，胜利后不再发任务奖励',()=>{
  const g=setup(),p=g.players[0];p.cards.museum=1;p.money=100;roll(g,6);
  assert.equal(E.buyCard(g,'museum').ok,false);
  assert.equal(E.handleChoice(g,0,{type:'mallPickCards',targetId:1,myCardId:'museum',targetCardId:'wheat'}).ok,false);
  p.landmarks={train:true,radio:true,mallC:true,park:false};p.dlc.role=3;p.dlc.taskId='variety';p.cards={wheat:1,bakery:1,ranch:1,forest:1};
  assert.equal(E.buildLandmark(g,'park').ok,true);assert.equal(g.gameOver,true);assert.equal(p.money,81);assert.equal(p.dlc.taskDone,false);
});
