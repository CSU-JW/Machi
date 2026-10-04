const DLC = require('./catalog');
const BLUE = ['wheat','ranch','forest','fishery','harbor'];
const PURPLE = ['stadium','tvStation','mall','museum'];
const FACTORIES = ['dairy','craft','farm'];
const count = (p,id) => p.cards[id] || 0;
const kinds = p => Object.keys(p.cards).filter(id => count(p,id)>0 && !PURPLE.includes(id));
const landmarks = p => Object.values(p.landmarks).filter(Boolean).length;
const shuffle = values => {
  const result = [...values];
  for (let i=result.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [result[i],result[j]]=[result[j],result[i]]; }
  return result;
};
function add(g,text) { g.log.push({text,turn:g.turnNumber}); }
function init(g) {
  const roles=shuffle(DLC.roles.map((_,i)=>i));
  g.dlc={round:0,deck:[],eventIndex:null,eventUsed:[],extra:false,selecting:true,taskDeadline:Date.now()+30000};
  for (const p of g.players) {
    p.dlc={role:roles[p.id],roleChosen:false,roleOptions:[roles[p.id],shuffle(roles.filter(r=>r!==roles[p.id]))[0]],used:0,readyAt:1,ownTurn:p.id===0?1:0,thresholds:[],coupons:[],taskId:null,taskDone:false,serviceLeft:0,serviceReady:0,
      taskOptions:['入门','进阶','挑战'].map(tier=>shuffle(DLC.tasks.filter(t=>t.tier===tier))[0].id)};
  }
  nextEvent(g);
}
function nextEvent(g) {
  const d=g.dlc;
  if(!d.deck.length){d.deck=shuffle(DLC.events.map((_,i)=>i));if(d.deck.length>1&&d.deck[0]===d.eventIndex)[d.deck[0],d.deck[1]]=[d.deck[1],d.deck[0]];}
  d.eventIndex=d.deck.shift();d.round++;d.eventUsed=[];
  add(g,`海滨假日第${d.round}轮：${DLC.events[d.eventIndex].name}`);
}
function chooseTask(g,id,taskId) {
  const p=g.players[id];
  if(!g.dlc?.selecting || !p?.dlc || p.dlc.taskId || !p.dlc.taskOptions.includes(taskId)) return {ok:false,reason:'当前任务不可选择'};
  p.dlc.taskId=taskId;
  if(g.players.every(p=>p.dlc.taskId&&p.dlc.roleChosen))g.dlc.selecting=false;
  return {ok:true};
}
function finishTaskSelection(g) {
  if(!g.dlc?.selecting)return;
  for(const p of g.players) {if(!p.dlc.taskId)p.dlc.taskId=p.dlc.taskOptions[0];p.dlc.roleChosen=true;}
  g.dlc.selecting=false;
}
function chooseRole(g,id,role) {
  const d=g.players[id]?.dlc;
  if(!g.dlc?.selecting||!d||d.roleChosen||!d.roleOptions.includes(role))return {ok:false,reason:'当前角色不可选择'};
  d.role=role;d.roleChosen=true;
  if(g.players.every(p=>p.dlc.taskId&&p.dlc.roleChosen))g.dlc.selecting=false;
  return {ok:true};
}
function income(card,p,g) {
  switch(card.effect.rule){
    case 'fixed': case 'take': return card.effect.amount;
    case 'landmarkStep': return landmarks(p)>=2?3:2;
    case 'diceCount': return g.dice.count===2?2:1;
    case 'seafood': return Math.min(9,count(p,'fishery')*3+count(p,'ranch'));
    case 'blueKinds': return Math.min(8,BLUE.filter(id=>count(p,id)).length*2);
    case 'landmarks': return Math.min(8,2+landmarks(p)*2);
    case 'factoryKinds': return Math.min(12,FACTORIES.filter(id=>count(p,id)).length*3);
    default: throw new Error('未知DLC建筑效果');
  }
}
function afterIncome(g,p,triggered,events) {
  if(!g.dlc)return;
  const d=p.dlc;
  if(d.role===2&&d.used<3&&triggered.some(id=>['wheat','florist'].includes(id))){p.money++;d.used++;events.push(`${p.name} 园艺师 +1`);}
  if(g.dlc.extra||g.dlc.eventUsed.includes(p.id))return;
  const e=g.dlc.eventIndex;
  const groups={0:['wheat','ranch','fishery'],3:['bookshop','museum'],4:['harbor','aquarium','spa']};
  const active=groups[e]?triggered.some(id=>groups[e].includes(id)):e===6&&g.dice.count===2&&g.dice.values[0]!==g.dice.values[1];
  if(active){p.money++;g.dlc.eventUsed.push(p.id);events.push(`${p.name} ${DLC.events[e].name} +1`);}
}
function roleReady(p,role) {return p.dlc?.role===role&&p.dlc.used<(role===0?1:3)&&p.dlc.ownTurn>=p.dlc.readyAt;}
function quote(g,p,kind,id,cost) {
  const choices=[{source:'none',label:'原价',discount:0,rebate:0}];
  if(g.dlc){
    const d=p.dlc, normal=!PURPLE.includes(id);
    if((kind==='build'&&roleReady(p,0))||(kind==='buy'&&normal&&roleReady(p,1)))choices.push({source:'role',label:kind==='build'?'建筑师技能':'采购员技能',discount:kind==='build'?3:1,rebate:0});
    d.coupons.forEach((c,i)=>{if(c.kind===kind&&d.ownTurn>=c.readyAt&&(kind==='build'||normal))choices.push({source:`coupon:${i}`,label:`${c.value}元${kind==='build'?'地标':'购卡'}券`,discount:c.value,rebate:0});});
    if(!g.dlc.eventUsed.includes(p.id)){
      const e=g.dlc.eventIndex;
      if((kind==='buy'&&normal&&e===1)||(kind==='build'&&e===2))choices.push({source:'event',label:DLC.events[e].name,discount:1,rebate:0});
      if(kind==='buy'&&normal&&e===5&&!g.dlc.extra&&!count(p,id)&&cost>1)choices.push({source:'event',label:'创业扶持（支付后返1元）',discount:0,rebate:1});
    }
  }
  return choices.map(q=>({...q,discount:Math.min(q.discount,Math.max(0,cost-1)),cost:Math.max(1,cost-q.discount)}));
}
function selectQuote(g,p,kind,id,cost,source='none') {return quote(g,p,kind,id,cost).find(q=>q.source===source);}
function consume(g,p,q) {
  if(!g.dlc)return;
  if(q.source==='role'){p.dlc.used++;p.dlc.readyAt=p.dlc.ownTurn+4;}
  if(q.source.startsWith('coupon:'))p.dlc.coupons.splice(Number(q.source.split(':')[1]),1);
  if(q.source==='event')g.dlc.eventUsed.push(p.id);
  if(q.rebate)p.money+=q.rebate;
}
function checkTasks(g) {
  if(!g.dlc||g.gameOver)return;
  for(const p of g.players){
    const d=p.dlc, ids=kinds(p);
    if(d.role===5)for(const n of [4,6,8])if(ids.length>=n&&!d.thresholds.includes(n)){d.thresholds.push(n);d.used++;p.money++;add(g,`${p.name} 收藏家：建筑种类达到${n}，+1`);}
    if(d.taskDone||!d.taskId)continue;
    const conditions={
      variety:ids.length>=4,
      blue:BLUE.filter(id=>count(p,id)).length>=3,
      coast:count(p,'fishery')>=2&&count(p,'seafoodMarket')>=1,
      industry:FACTORIES.every(id=>count(p,id)>0),
      tourism:landmarks(p)>=2&&count(p,'aquarium')>0&&count(p,'spa')>0,
      diversity:ids.length>=8&&ids.filter(id=>DLC.buildings.some(c=>c.id===id)).length>=2,
      research:['techPark',...FACTORIES,'ranch','forest'].every(id=>count(p,id)>0),
      community:ids.reduce((s,id)=>s+count(p,id),0)>=10&&ids.length>=6&&landmarks(p)>=1,
    };
    if(!conditions[d.taskId])continue;
    d.taskDone=true;
    const coupon=(kind,value)=>d.coupons.push({kind,value,readyAt:d.ownTurn+1});
    switch(d.taskId){
      case 'variety':p.money+=2;break;
      case 'blue':coupon('buy',2);break;
      case 'coast':p.money+=4;break;
      case 'industry':coupon('build',4);break;
      case 'tourism':coupon('buy',2);coupon('buy',2);break;
      case 'diversity':p.money+=6;break;
      case 'research':coupon('build',6);break;
      case 'community':p.money+=3;d.serviceLeft=3;d.serviceReady=d.ownTurn+1;break;
    }
    const task=DLC.tasks.find(t=>t.id===d.taskId);add(g,`${p.name} 完成任务「${task.name}」：${task.reward}`);
  }
}
function afterBuild(g,p) {if(g.dlc&&!g.gameOver&&p.dlc.role===3&&p.dlc.used<3){p.dlc.used++;p.money++;add(g,`${p.name} 导游返还1元`);}checkTasks(g);}
function useRole(g,p) {
  if(!g.dlc||g.gameOver||g.dlc.selecting||g.pendingChoice||!g.settled||g.current!==p.id||!roleReady(p,4)||p.money>2)return {ok:false,reason:'当前不能使用会计技能'};
  p.money++;p.dlc.used++;p.dlc.readyAt=p.dlc.ownTurn+3;add(g,`${p.name} 使用会计技能，+1`);return {ok:true};
}
function end(g,p,extra) {
  if(!g.dlc)return;
  const d=p.dlc;
  if(d.serviceLeft>0&&d.ownTurn>=d.serviceReady){p.money++;d.serviceLeft--;add(g,`${p.name} 便民服务 +1（剩余${d.serviceLeft}次）`);}
  if(!extra&&g.current===0)nextEvent(g);
  g.dlc.extra=extra;
  g.players[g.current].dlc.ownTurn++;
}
module.exports={init,chooseRole,chooseTask,finishTaskSelection,income,afterIncome,quote,selectQuote,consume,checkTasks,afterBuild,useRole,end};
