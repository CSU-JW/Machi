// DLC1 共用规则数据：对局、卡牌预览与收益分析。
const DLC1 = {
  version: '0.2-playtest',
  buildings: [
    {id:'florist',name:'花店',points:[1],cost:1,color:'green',limit:6,description:'自己掷出1：获得3元。',effect:'fixed',amount:3},
    {id:'fishery',name:'渔场',points:[2],cost:2,color:'blue',limit:6,description:'任意玩家掷出2：获得1元。',effect:'fixed',amount:1},
    {id:'bookshop',name:'书店',points:[3],cost:2,color:'green',limit:6,description:'自己掷出3：获得3元。',effect:'fixed',amount:3},
    {id:'busDepot',name:'公交站',points:[4],cost:2,color:'green',limit:6,description:'自己掷出4：获得2元；已建成至少2个地标时改为4元。',effect:'landmarkStep'},
    {id:'harbor',name:'港口',points:[5],cost:4,color:'blue',limit:6,description:'任意玩家掷出5：单骰获得1元，双骰获得2元。',effect:'diceCount'},
    {id:'museum',name:'博物馆',points:[6],cost:5,color:'purple',limit:4,unique:true,description:'自己掷出6：自动获得3元。每人限1张，不可交换。',effect:'fixed',amount:3},
    {id:'seafoodMarket',name:'海鲜市场',points:[7],cost:3,color:'green',limit:6,description:'自己掷出7：每张渔场提供3元，每张牧场提供1元；每张市场最多获得9元。',effect:'seafood'},
    {id:'aquarium',name:'水族馆',points:[8],cost:4,color:'green',limit:6,description:'自己掷出8：每种不同蓝色建筑提供2元；每张水族馆最多获得8元。',effect:'blueKinds'},
    {id:'spa',name:'温泉旅馆',points:[9],cost:3,color:'green',limit:6,description:'自己掷出9：获得2元，每个已建成地标再提供2元，最多8元。',effect:'landmarks'},
    {id:'nightMarket',name:'夜市',points:[10],cost:3,color:'red',limit:6,description:'他人掷出10：向该玩家收取最多4元。',effect:'take',amount:4},
    {id:'techPark',name:'科技园',points:[11,12],cost:4,color:'green',limit:6,description:'自己掷出11～12：每种不同工厂提供3元；最多12元。工厂指奶制品、工艺品、农产品工厂。',effect:'factoryKinds'},
  ],
  tasks: [
    {id:'variety',name:'街区初成',tier:'入门',condition:'同时拥有4种普通建筑（不含紫卡）；初始卡计入。',reward:'获得2元。',cap:2,reason:'最少新增2种；奖励约为两次购买的折扣。'},
    {id:'blue',name:'蓝色经济',tier:'入门',condition:'同时拥有3种蓝色建筑。',reward:'获得一张2元购卡券。',cap:2,reason:'已有麦田，仍需至少购买两种蓝卡。'},
    {id:'coast',name:'海滨产业链',tier:'进阶',condition:'同时拥有2张渔场和1张海鲜市场。',reward:'获得4元。',cap:4,reason:'至少3次购买、7元投入，且包含双骰区建筑。'},
    {id:'industry',name:'产业协作',tier:'进阶',condition:'同时拥有奶制品、工艺品、农产品工厂各1张。',reward:'获得一张4元地标券。',cap:4,reason:'至少3次购买、8元投入，覆盖7、10、11～12三组点数。'},
    {id:'tourism',name:'观光路线',tier:'进阶',condition:'建成至少2个地标，同时拥有水族馆和温泉旅馆。',reward:'获得两张各2元购卡券。',cap:4,reason:'地标本身是胜利进度，因此不再给高额加速胜利奖励。'},
    {id:'diversity',name:'多彩城镇',tier:'挑战',condition:'同时拥有8种不同普通建筑，其中包含至少2种DLC建筑。',reward:'获得6元。',cap:6,reason:'从初始两种起至少6次购买，承担不同点数的等待成本。'},
    {id:'research',name:'科研网络',tier:'挑战',condition:'同时拥有科技园、三种工厂各1张，以及牧场、林场各1张。',reward:'获得一张6元地标券。',cap:6,reason:'至少6次购买、17元投入，要求多个双骰区点数。'},
    {id:'community',name:'社区建设',tier:'挑战',condition:'拥有至少10张普通建筑、至少6种，且建成至少1个地标。',reward:'获得3元，并获得“便民服务”：以后自己的回合结束时自动获得1元，最多触发3次。',cap:6,reason:'至少新增8张；延迟奖励总量封顶，不能滚成永久收入。'},
  ],
  events: [
    {name:'丰收集市',effect:'每位玩家自己的基础回合中，若麦田、牧场或渔场至少一种触发，结算后额外获得1元。每人本轮最多1元。'},
    {name:'购物节',effect:'每位玩家本轮第一次购买普通建筑减价1元，最低支付1元。'},
    {name:'建筑周',effect:'每位玩家本轮第一次建设地标减价1元，最低支付1元。'},
    {name:'文化日',effect:'每位玩家自己的基础回合中，若书店或博物馆触发，额外获得1元。每人本轮最多1元。'},
    {name:'海滨假日',effect:'每位玩家自己的基础回合中，若港口、水族馆或温泉旅馆触发，额外获得1元。每人本轮最多1元。'},
    {name:'创业扶持',effect:'每位玩家自己的基础回合购买此前未拥有的普通建筑后，返还1元。每人本轮最多1次。'},
    {name:'双骰巡游',effect:'每位玩家自己的基础回合最终接受的骰子为两个且不同点，结算后获得1元。每人本轮最多1元。'},
    {name:'平静的一周',effect:'本轮没有额外效果。'},
  ],
  roles: [
    {name:'建筑师',type:'主动·整局1次',effect:'自己的建设阶段选择一个地标，支付时减价3元，最低支付1元；成功建设才消耗技能。',cap:'3元'},
    {name:'采购员',type:'主动·冷却3个自己的回合',effect:'购买本次点数对应的普通建筑时减价1元。整局最多3次；第t回合使用后，第t+4个自己的回合可再用。',cap:'3元'},
    {name:'园艺师',type:'被动',effect:'在自己的回合，麦田或花店触发后额外获得1元；每回合最多1次，整局最多3次。',cap:'3元'},
    {name:'导游',type:'被动',effect:'自己每建成一个地标，返还1元；仅前3个地标有效。',cap:'3元'},
    {name:'会计',type:'主动·冷却2个自己的回合',effect:'自己的结算结束后，若资金不超过2元，可获得1元。第t回合使用后，第t+3个自己的回合可再用；整局最多3次。',cap:'3元'},
    {name:'收藏家',type:'被动',effect:'自己的第4、第6、第8种普通建筑首次达成时各获得1元。失去再获得不重复奖励。',cap:'3元'},
  ],
};
if (typeof module !== 'undefined') module.exports = DLC1;
if (typeof window !== 'undefined') window.DLC1 = DLC1;
