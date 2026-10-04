const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { createMachiServer } = require('../server');

class TestClient {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const waiterIndex = this.waiters.findIndex(waiter => waiter.match(message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  waitFor(type, predicate = () => true, timeout = 2000) {
    const match = message => message.type === type && predicate(message);
    const queuedIndex = this.messages.findIndex(match);
    if (queuedIndex >= 0) return Promise.resolve(this.messages.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(new Error(`等待消息 ${type} 超时；已有消息：${JSON.stringify(this.messages)}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }
}

async function createFixture(t, serverOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(__dirname, '.tmp-server-'));
  const app = createMachiServer({ dataDir, ...serverOptions });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.close());
    await new Promise(resolve => app.wss.close(() => app.server.close(resolve)));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    app,
    async client() {
      const client = new TestClient(`ws://127.0.0.1:${address.port}`);
      clients.push(client);
      await client.open();
      return client;
    },
  };
}

async function guest(client, nickname, deviceId) {
  client.send({ type: 'guestLogin', nickname, deviceId });
  const auth = await client.waitFor('authenticated');
  await client.waitFor('lobby');
  return auth;
}

test('大厅初始只保留单人测试房，创建房间从1号开始并复用空号', async t => {
  const fixture = await createFixture(t);
  const client = await fixture.client();
  client.send({ type: 'guestLogin', nickname: '游客甲', deviceId: 'device_0000000000000001' });
  await client.waitFor('authenticated');
  const lobby = await client.waitFor('lobby');
  assert.deepEqual(lobby.rooms.map(room => room.id), ['test']);
  assert.ok(lobby.rooms.every(room => room.playerCount === 0 && room.status === 'waiting'));

  client.send({ type: 'createRoom', dlcEnabled: false });
  const created = await client.waitFor('roomCreated');
  assert.equal(created.roomId, '1');
  client.send({ type: 'requestLobby' });
  const lobby2 = await client.waitFor('lobby');
  assert.deepEqual(lobby2.rooms.map(room => room.id).sort(), ['1', 'test']);

  // 加入后退出：空房立即关闭清除
  client.send({ type: 'joinRoom', roomId: '1' });
  await client.waitFor('roomJoined');
  client.send({ type: 'leaveRoom' });
  await client.waitFor('leftRoom');
  assert.equal(fixture.app.rooms.has('1'), false, '空房应被关闭清除');
  // 再次创建：复用 1 号
  client.send({ type: 'createRoom', dlcEnabled: true });
  const created2 = await client.waitFor('roomCreated');
  assert.equal(created2.roomId, '1');
  assert.equal(fixture.app.rooms.get('1').dlcEnabled, true);
});

test('单人测试房限一席、手动开局、头像同步及退出复位',async t=>{
  const f=await createFixture(t),a=await f.client(),b=await f.client();
  await guest(a,'测试员','solo_test_device_000001');await guest(b,'第二人','solo_test_device_000002');
  a.send({type:'joinRoom',roomId:'test'});await a.waitFor('roomJoined');
  const waiting=await a.waitFor('waiting');assert.equal(waiting.capacity,1);assert.equal(f.app.rooms.get('test').game,null);
  // 测试房满员后：后来者自动进入观战席
  b.send({type:'joinRoom',roomId:'test'});
  const joinedB=await b.waitFor('roomJoined');assert.equal(joinedB.spectator,true);
  b.send({type:'leaveRoom'});await b.waitFor('leftRoom');
  a.send({type:'setAvatar',avatar:'fish'});await a.waitFor('waiting',m=>m.players[0].avatar==='fish');
  a.send({type:'setAvatar',avatar:'invalid'});await a.waitFor('error');
  a.send({type:'startTest'});let state=await a.waitFor('state');assert.equal(state.game.players.length,1);assert.equal(state.game.players[0].avatar,'fish');
  a.send({type:'roll',count:1});await a.waitFor('state',m=>m.game.settled);
  a.send({type:'endTurn'});state=await a.waitFor('state',m=>m.game.turnNumber===2);assert.equal(state.game.current,0);
  a.send({type:'setAvatar',avatar:'duck'});await a.waitFor('state',m=>m.game.players[0].avatar==='duck');
  a.send({type:'leaveRoom'});await a.waitFor('leftRoom');assert.equal(f.app.rooms.get('test').game,null);
});

test('同一游客重复连接只接管原席位，不会新增玩家', async t => {
  const fixture = await createFixture(t);
  const first = await fixture.client();
  await guest(first, '第一次昵称', 'same_device_000000000001');
  first.send({ type: 'createRoom', dlcEnabled: false });
  await first.waitFor('roomCreated');
  first.send({ type: 'joinRoom', roomId: '1' });
  const joined = await first.waitFor('roomJoined');
  assert.equal(joined.playerId, 0);

  const second = await fixture.client();
  await guest(second, '换了昵称', 'same_device_000000000001');
  const rejoined = await second.waitFor('roomJoined');
  assert.equal(rejoined.playerId, 0);
  assert.equal(rejoined.reconnect, true);
  assert.equal(fixture.app.rooms.get('1').members.length, 1);
  assert.equal(fixture.app.rooms.get('1').members[0].name, '第一次昵称');
});

test('同一设备切换为其他身份也不能重复占座', async t => {
  const fixture = await createFixture(t);
  const guestClient = await fixture.client();
  const deviceId = 'shared_device_000000000001';
  await guest(guestClient, '游客席位', deviceId);
  guestClient.send({ type: 'createRoom', dlcEnabled: false });
  await guestClient.waitFor('roomCreated');
  guestClient.send({ type: 'joinRoom', roomId: '1' });
  await guestClient.waitFor('roomJoined');

  const accountClient = await fixture.client();
  accountClient.send({
    type: 'register', username: 'account_1', password: '12345678', nickname: '账号玩家', deviceId,
  });
  await accountClient.waitFor('authenticated');
  await accountClient.waitFor('lobby');
  accountClient.send({ type: 'joinRoom', roomId: '1' });
  const denied = await accountClient.waitFor('error');
  assert.equal(denied.code, 'DEVICE_ALREADY_IN_ROOM');
  assert.equal(fixture.app.rooms.get('1').members.length, 1);
});

test('四个不同身份加入指定房间后正常开局', async t => {
  const fixture = await createFixture(t);
  const clients = [];
  const first = await fixture.client();
  await guest(first, '玩家1', 'unique_device_00000000000');
  first.send({ type: 'createRoom', dlcEnabled: false });
  await first.waitFor('roomCreated');
  first.send({ type: 'joinRoom', roomId: '1' });
  await first.waitFor('roomJoined');
  clients.push(first);
  for (let index = 1; index < 4; index += 1) {
    const client = await fixture.client();
    await guest(client, `玩家${index + 1}`, `unique_device_0000000000${index}`);
    client.send({ type: 'joinRoom', roomId: '1' });
    await client.waitFor('roomJoined');
    clients.push(client);
  }
  // 满员不再自动开局，由房主确认开始
  clients[0].send({ type: 'startGame' });
  const state = await clients[3].waitFor('state');
  assert.equal(state.game.players.length, 4);
  assert.deepEqual(state.game.players.map(player => player.name), ['玩家1', '玩家2', '玩家3', '玩家4']);
  assert.ok(fixture.app.rooms.get('1').game);
});

test('开局后主动退出会释放身份，全部退出后房间关闭清除，编号复用', async t => {
  const fixture = await createFixture(t);
  const clients = [];
  const first = await fixture.client();
  await guest(first, '离场玩家1', 'leave_device_00000000000');
  first.send({ type: 'createRoom', dlcEnabled: false });
  await first.waitFor('roomCreated');
  first.send({ type: 'joinRoom', roomId: '1' });
  await first.waitFor('roomJoined');
  clients.push(first);
  for (let index = 1; index < 4; index += 1) {
    const client = await fixture.client();
    await guest(client, `离场玩家${index + 1}`, `leave_device_00000000000${index}`);
    client.send({ type: 'joinRoom', roomId: '1' });
    await client.waitFor('roomJoined');
    clients.push(client);
  }
  clients[0].send({ type: 'startGame' });
  await clients[3].waitFor('state');

  for (const client of clients) {
    client.send({ type: 'leaveRoom' });
    await client.waitFor('leftRoom');
  }
  assert.equal(fixture.app.rooms.has('1'), false, '全员退出后房间应被关闭清除');

  // 重建房间：空号 1 被复用
  clients[0].send({ type: 'createRoom', dlcEnabled: false });
  const created = await clients[0].waitFor('roomCreated');
  assert.equal(created.roomId, '1');
  clients[0].send({ type: 'joinRoom', roomId: '1' });
  const joinedAgain = await clients[0].waitFor('roomJoined');
  assert.equal(joinedAgain.roomId, '1');
});

test('房主DLC开关同步、非房主拒绝、开局锁定，任务与重连状态保持',async t=>{
  const f=await createFixture(t),clients=[];
  const first=await f.client();await guest(first,'扩展玩家0','dlc_device_00000000000');
  first.send({type:'createRoom',dlcEnabled:false});await first.waitFor('roomCreated');
  first.send({type:'joinRoom',roomId:'1'});await first.waitFor('roomJoined');clients.push(first);
  for(let i=1;i<2;i++){
    const c=await f.client();await guest(c,`扩展玩家${i}`,`dlc_device_00000000000${i}`);
    c.send({type:'joinRoom',roomId:'1'});await c.waitFor('roomJoined');clients.push(c);
  }
  clients[1].send({type:'setDlc',enabled:true});assert.equal((await clients[1].waitFor('error')).code,'HOST_ONLY');
  clients[0].send({type:'setDlc',enabled:true});
  await clients[1].waitFor('waiting',m=>m.dlcEnabled===true);
  for(let i=2;i<4;i++){
    const c=await f.client();await guest(c,`扩展玩家${i}`,`dlc_device_00000000000${i}`);c.send({type:'joinRoom',roomId:'1'});await c.waitFor('roomJoined');clients.push(c);
  }
  clients[0].send({type:'startGame'});
  let state=await clients[3].waitFor('state');assert.equal(state.game.dlcEnabled,true);assert.equal(Object.keys(state.game.cardPool).length,26);
  clients[0].send({type:'setDlc',enabled:false});assert.equal((await clients[0].waitFor('error')).code,'SETTINGS_LOCKED');
  clients[0].send({type:'roll',count:1});assert.equal((await clients[0].waitFor('error')).code,'TASK_SELECTION');
  for(let i=0;i<4;i++){
    clients[i].send({type:'chooseTask',taskId:state.game.players[i].dlc.taskOptions[0]});
    clients[i].send({type:'chooseRole',role:state.game.players[i].dlc.roleOptions[0]});
  }
  state=await clients[0].waitFor('state',m=>!m.game.dlc.selecting);
  const replacement=await f.client();replacement.send({type:'guestLogin',nickname:'重新连接',deviceId:'dlc_device_000000000003'});
  await replacement.waitFor('authenticated');await replacement.waitFor('roomJoined');
  const rejoined=await replacement.waitFor('state');assert.deepEqual(rejoined.game.players[3].dlc,state.game.players[3].dlc);
  clients[0].send({type:'endTurn'});assert.equal((await clients[0].waitFor('error')).code,'NOT_SETTLED');
});

test('原版房间创建可关闭DLC，静态新卡可加载且运行时代码不可下载',async t=>{
  const f=await createFixture(t),c=await f.client();await guest(c,'建房玩家','create_dlc_device_000001');
  c.send({type:'createRoom',dlcEnabled:false});const created=await c.waitFor('roomCreated');assert.equal(f.app.rooms.get(created.roomId).dlcEnabled,false);
  const base=`http://127.0.0.1:${f.app.server.address().port}`;
  for(const url of ['/dlc1/catalog.js','/dlc1/assets/cards/museum.png'])assert.equal((await fetch(base+url)).status,200);
  assert.equal((await fetch(base+'/dlc1/runtime.js')).status,404);
});

test('房间聊天：广播、历史、校验、限流，等待与对局中均可用', async t => {
  const f = await createFixture(t);
  const a = await f.client(); await guest(a, '聊天甲', 'chat_device_0000000001');
  const b = await f.client(); await guest(b, '聊天乙', 'chat_device_0000000002');
  a.send({ type: 'createRoom', dlcEnabled: false }); await a.waitFor('roomCreated');
  a.send({ type: 'joinRoom', roomId: '1' }); await a.waitFor('roomJoined');
  const emptyHistory = await a.waitFor('chatHistory'); assert.deepEqual(emptyHistory.messages, []);
  b.send({ type: 'joinRoom', roomId: '1' }); await b.waitFor('roomJoined');
  await b.waitFor('chatHistory');

  a.send({ type: 'chat', text: '大家好' });
  const chat = await b.waitFor('chat');
  assert.equal(chat.text, '大家好');
  assert.equal(chat.name, '聊天甲');
  assert.equal(chat.playerId, 0);
  assert.ok(chat.ts > 0);

  // 500ms 内连续发言被限流
  a.send({ type: 'chat', text: '连发一条' });
  assert.equal((await a.waitFor('error')).code, 'RATE_LIMITED');
  // 空消息与超长消息被拒绝
  a.send({ type: 'chat', text: '   ' });
  assert.equal((await a.waitFor('error')).code, 'EMPTY_MESSAGE');
  a.send({ type: 'chat', text: 'x'.repeat(301) });
  assert.equal((await a.waitFor('error')).code, 'MESSAGE_TOO_LONG');
  // 大厅中的玩家没有席位，不能发言
  const c = await f.client(); await guest(c, '路人丙', 'chat_device_0000000003');
  c.send({ type: 'chat', text: '插话' });
  assert.equal((await c.waitFor('error')).code, 'NOT_IN_ROOM');
  // 后加入的玩家能收到聊天历史
  const d = await f.client(); await guest(d, '聊天丁', 'chat_device_0000000004');
  d.send({ type: 'joinRoom', roomId: '1' }); await d.waitFor('roomJoined');
  const history = await d.waitFor('chatHistory');
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].text, '大家好');

  // 满 4 人后由房主确认开局，聊天依然可用
  const e = await f.client(); await guest(e, '聊天戊', 'chat_device_0000000005');
  e.send({ type: 'joinRoom', roomId: '1' }); await e.waitFor('roomJoined');
  a.send({ type: 'startGame' });
  await a.waitFor('state');
  b.send({ type: 'chat', text: '开局啦' });
  assert.equal((await a.waitFor('chat', m => m.text === '开局啦')).name, '聊天乙');
  assert.equal((await d.waitFor('chat', m => m.text === '开局啦')).text, '开局啦');
});

// 驱动房主自己的回合，其余回合交给人机，直到指定回合数。
async function driveHumanTurns(host, state, targetTurn) {
  for (let i = 0; i < 60 && !state.game.gameOver && state.game.turnNumber < targetTurn; i += 1) {
    if (state.game.current === 0) {
      if (!state.game.dice) host.send({ type: 'roll', count: 1 });
      else if (state.game.settled) host.send({ type: 'endTurn' });
    }
    state = await host.waitFor('state');
  }
  return state;
}

test('房主添加人机后手动开局，人机自动行动且不发聊天', async t => {
  const f = await createFixture(t, { botTurnDelayMs: 5, botJitterMs: 0 });
  const host = await f.client();
  await guest(host, '房主甲', 'bot_host_device_0001');
  host.send({ type: 'createRoom', dlcEnabled: false });
  await host.waitFor('roomCreated');
  host.send({ type: 'joinRoom', roomId: '1' });
  await host.waitFor('roomJoined');
  await host.waitFor('chatHistory');
  host.send({ type: 'addBot', difficulty: 'easy' });
  await host.waitFor('waiting', m => m.players.filter(p => p.bot).length === 1);
  host.send({ type: 'addBot', difficulty: 'normal' });
  await host.waitFor('waiting', m => m.players.filter(p => p.bot).length === 2);
  host.send({ type: 'addBot', difficulty: 'hard' });
  await host.waitFor('waiting', m => m.players.filter(p => p.bot).length === 3);
  // 满员不自动开局，由房主确认
  host.send({ type: 'startGame' });
  const firstState = await host.waitFor('state');
  assert.equal(firstState.game.players.length, 4);
  assert.deepEqual(firstState.game.players.slice(1).map(p => p.difficulty), ['easy', 'normal', 'hard']);
  assert.ok(firstState.game.players.slice(1).every(p => p.bot === true));

  // 人机完成自己回合后，回合数应推进到第 5 回合（回到房主）
  const state = await driveHumanTurns(host, firstState, 5);
  assert.ok(state.game.turnNumber >= 5 || state.game.gameOver, `对局应推进，当前回合 ${state.game.turnNumber}`);
  // 人机从未发送聊天消息
  assert.equal(f.app.rooms.get('1').chatLog.length, 0);
});

test('DLC 对局：人机自动选择角色与任务并正常行动', async t => {
  const f = await createFixture(t, { botTurnDelayMs: 5, botJitterMs: 0 });
  const host = await f.client();
  await guest(host, '房主乙', 'botdlc_host_00001');
  host.send({ type: 'createRoom', dlcEnabled: false });
  await host.waitFor('roomCreated');
  host.send({ type: 'joinRoom', roomId: '1' });
  await host.waitFor('roomJoined');
  await host.waitFor('chatHistory');
  host.send({ type: 'setDlc', enabled: true });
  await host.waitFor('waiting', m => m.dlcEnabled === true);
  for (let i = 0; i < 3; i += 1) {
    host.send({ type: 'addBot', difficulty: ['easy', 'normal', 'hard'][i] });
    await host.waitFor('waiting', m => m.players.filter(p => p.bot).length === i + 1);
  }
  host.send({ type: 'startGame' });
  const firstState = await host.waitFor('state');
  assert.ok(firstState.game.dlc.selecting, '开局应先进入选择阶段');
  // 等待人机自动完成选择
  await new Promise(resolve => setTimeout(resolve, 1500));
  const game = f.app.rooms.get('1').game;
  assert.ok(game.players.slice(1).every(p => p.dlc.roleChosen && p.dlc.taskId), '人机应自动完成角色与任务选择');
  host.send({ type: 'chooseTask', taskId: game.players[0].dlc.taskOptions[0] });
  host.send({ type: 'chooseRole', role: game.players[0].dlc.roleOptions[0] });
  let state = await host.waitFor('state', m => !m.game.dlc.selecting);
  state = await driveHumanTurns(host, state, 5);
  assert.ok(state.game.turnNumber >= 5 || state.game.gameOver, `DLC 对局应推进，当前回合 ${state.game.turnNumber}`);
});

test('人机管理：非房主不可操作、可移除、房主可手动开局', async t => {
  const f = await createFixture(t);
  const host = await f.client();
  await guest(host, '房主丙', 'botm_host_0000001');
  const other = await f.client();
  await guest(other, '访客丁', 'botm_guest_00001');
  host.send({ type: 'createRoom', dlcEnabled: false });
  await host.waitFor('roomCreated');
  host.send({ type: 'joinRoom', roomId: '1' });
  await host.waitFor('roomJoined');
  await host.waitFor('chatHistory');
  other.send({ type: 'joinRoom', roomId: '1' });
  await other.waitFor('roomJoined');
  await other.waitFor('chatHistory');
  // 非房主添加人机被拒
  other.send({ type: 'addBot', difficulty: 'easy' });
  assert.equal((await other.waitFor('error')).code, 'HOST_ONLY');
  // 非法难度被拒
  host.send({ type: 'addBot', difficulty: 'brutal' });
  assert.equal((await host.waitFor('error')).code, 'INVALID_BOT');
  // 添加人机：等待消息中带 bot 标记与难度
  host.send({ type: 'addBot', difficulty: 'hard' });
  const waiting = await host.waitFor('waiting', m => m.players.some(p => p.bot));
  const bot = waiting.players.find(p => p.bot);
  assert.equal(bot.difficulty, 'hard');
  // 移除人机
  host.send({ type: 'removeBot', playerId: bot.id });
  await host.waitFor('waiting', m => !m.players.some(p => p.bot));
  // 无需人机也能由房主开始（2 真人）
  host.send({ type: 'startGame' });
  let state = await host.waitFor('state');
  assert.equal(state.game.players.length, 2);
  // 全员退出后房间关闭，重建后带人机开始（2 真人 + 1 人机）
  host.send({ type: 'leaveRoom' });
  await host.waitFor('leftRoom');
  other.send({ type: 'leaveRoom' });
  await other.waitFor('leftRoom');
  assert.equal(f.app.rooms.has('1'), false, '全员退出后房间应关闭清除');
  host.send({ type: 'createRoom', dlcEnabled: false });
  const created = await host.waitFor('roomCreated');
  assert.equal(created.roomId, '1', '空号应复用');
  host.send({ type: 'joinRoom', roomId: '1' });
  await host.waitFor('roomJoined');
  await host.waitFor('chatHistory');
  other.send({ type: 'joinRoom', roomId: '1' });
  await other.waitFor('roomJoined');
  await other.waitFor('chatHistory');
  host.send({ type: 'addBot', difficulty: 'normal' });
  await host.waitFor('waiting', m => m.players.some(p => p.bot));
  host.send({ type: 'startGame' });
  state = await host.waitFor('state');
  assert.equal(state.game.players.length, 3);
  assert.equal(state.game.players[2].bot, true);
  assert.equal(state.game.players[2].difficulty, 'normal');
  // 全员退出后房间关闭
  host.send({ type: 'leaveRoom' });
  await host.waitFor('leftRoom');
  other.send({ type: 'leaveRoom' });
  await other.waitFor('leftRoom');
  assert.equal(f.app.rooms.has('1'), false, '全员退出后房间应关闭清除');
});

test('满员不再自动开局：仅房主可确认开始，非房主开始被拒', async t => {
  const f = await createFixture(t);
  const host = await f.client();
  await guest(host, '房主己', 'manual_host_000001');
  host.send({ type: 'createRoom', dlcEnabled: false });
  const roomId = String((await host.waitFor('roomCreated')).roomId);
  host.send({ type: 'joinRoom', roomId });
  await host.waitFor('roomJoined');
  await host.waitFor('chatHistory');
  const others = [];
  for (let i = 0; i < 3; i += 1) {
    const c = await f.client();
    await guest(c, `路人${i}`, `manual_guest_00000${i}`);
    c.send({ type: 'joinRoom', roomId });
    await c.waitFor('roomJoined');
    await c.waitFor('chatHistory');
    others.push(c);
  }
  // 满 4 人后不自动开局：房间仍处于等待状态
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(f.app.rooms.get(roomId).game, null, '满员不应自动开局');
  // 非房主不能开始
  others[0].send({ type: 'startGame' });
  assert.equal((await others[0].waitFor('error')).code, 'HOST_ONLY');
  assert.equal(f.app.rooms.get(roomId).game, null);
  // 房主确认开始
  host.send({ type: 'startGame' });
  const state = await host.waitFor('state');
  assert.equal(state.game.players.length, 4);
});

test('人机编号按空位复用：同一难度最多1-3号，移除后补用最小空号', async t => {
  const f = await createFixture(t);
  const host = await f.client();
  await guest(host, '房主戊', 'botseq_host_00001');
  host.send({ type: 'createRoom', dlcEnabled: false });
  await host.waitFor('roomCreated');
  host.send({ type: 'joinRoom', roomId: '1' });
  await host.waitFor('roomJoined');
  await host.waitFor('chatHistory');
  // 添加后移除，再次添加应复用 1 号
  host.send({ type: 'addBot', difficulty: 'easy' });
  let waiting = await host.waitFor('waiting', m => m.players.some(p => p.bot));
  assert.equal(waiting.players.find(p => p.bot).name, '简单人机·1');
  host.send({ type: 'removeBot', playerId: waiting.players.find(p => p.bot).id });
  await host.waitFor('waiting', m => !m.players.some(p => p.bot));
  host.send({ type: 'addBot', difficulty: 'easy' });
  waiting = await host.waitFor('waiting', m => m.players.some(p => p.bot));
  assert.equal(waiting.players.find(p => p.bot).name, '简单人机·1', '移除后再次添加应复用 1 号');
  // 连续添加 → 1、2、3 号，满员自动开局
  host.send({ type: 'addBot', difficulty: 'easy' });
  waiting = await host.waitFor('waiting', m => m.players.filter(p => p.bot).length === 2);
  assert.ok(waiting.players.some(p => p.bot && p.name === '简单人机·2'));
  host.send({ type: 'addBot', difficulty: 'easy' });
  await host.waitFor('waiting', m => m.players.filter(p => p.bot).length === 3);
  // 满员不自动开局，由房主确认
  host.send({ type: 'startGame' });
  const state = await host.waitFor('state');
  assert.deepEqual(
    state.game.players.slice(1).map(p => p.name),
    ['简单人机·1', '简单人机·2', '简单人机·3'],
  );
  // 房主退出复位后重开一局：移除 2 号后再添加，应补用 2 号而不是 4 号
  host.send({ type: 'leaveRoom' });
  await host.waitFor('leftRoom');
  assert.equal(f.app.rooms.has('1'), false, '全员退出后房间应关闭');
  host.send({ type: 'createRoom', dlcEnabled: false });
  const created = await host.waitFor('roomCreated');
  assert.equal(created.roomId, '1', '空号应被复用');
  host.send({ type: 'joinRoom', roomId: '1' });
  await host.waitFor('roomJoined');
  await host.waitFor('chatHistory');
  host.send({ type: 'addBot', difficulty: 'easy' });
  host.send({ type: 'addBot', difficulty: 'easy' });
  waiting = await host.waitFor('waiting', m => m.players.filter(p => p.bot).length === 2);
  const bot2 = waiting.players.find(p => p.name === '简单人机·2');
  host.send({ type: 'removeBot', playerId: bot2.id });
  await host.waitFor('waiting', m => m.players.filter(p => p.bot).length === 1);
  host.send({ type: 'addBot', difficulty: 'easy' });
  waiting = await host.waitFor('waiting', m => m.players.filter(p => p.bot).length === 2);
  assert.ok(waiting.players.some(p => p.bot && p.name === '简单人机·2'), '移除 2 号后再次添加应补用 2 号');
  host.send({ type: 'leaveRoom' });
  await host.waitFor('leftRoom');
});

test('房主退出后房主身份转接给列表第一位玩家，人机保留，全员退出后房间关闭', async t => {
  const f = await createFixture(t);
  const a = await f.client(); await guest(a, '房主一', 'hostmove_a_000001');
  const b = await f.client(); await guest(b, '玩家二', 'hostmove_b_000001');
  const c = await f.client(); await guest(c, '玩家三', 'hostmove_c_000001');
  a.send({ type: 'createRoom', dlcEnabled: false });
  const roomId = String((await a.waitFor('roomCreated')).roomId);
  a.send({ type: 'joinRoom', roomId }); await a.waitFor('roomJoined'); await a.waitFor('chatHistory');
  b.send({ type: 'joinRoom', roomId }); await b.waitFor('roomJoined'); await b.waitFor('chatHistory');
  c.send({ type: 'joinRoom', roomId }); await c.waitFor('roomJoined'); await c.waitFor('chatHistory');
  // 三人等待房：房主退出 → 身份转接给玩家二（列表第一位）
  a.send({ type: 'leaveRoom' }); await a.waitFor('leftRoom');
  const waiting = await b.waitFor('waiting', m => m.players.length === 2 && m.players[0].name === '玩家二');
  assert.equal(waiting.hostId, 0, '玩家二重排为 0 号位并成为新房主');
  // 玩家二退出：房主继续转接给玩家三
  b.send({ type: 'leaveRoom' }); await b.waitFor('leftRoom');
  const waiting3 = await c.waitFor('waiting', m => m.players.length === 1 && m.players[0].name === '玩家三');
  assert.equal(waiting3.hostId, 0);
  // 最后一人退出：房间关闭
  c.send({ type: 'leaveRoom' }); await c.waitFor('leftRoom');
  assert.equal(f.app.rooms.has(roomId), false, '全员退出后房间应关闭');

  // 房主退出时人机保留，新房主可管理人机
  a.send({ type: 'createRoom', dlcEnabled: false });
  const created = await a.waitFor('roomCreated');
  assert.equal(created.roomId, roomId, '空号应被复用');
  a.send({ type: 'joinRoom', roomId }); await a.waitFor('roomJoined'); await a.waitFor('chatHistory');
  b.send({ type: 'joinRoom', roomId }); await b.waitFor('roomJoined'); await b.waitFor('chatHistory');
  a.send({ type: 'addBot', difficulty: 'easy' });
  await b.waitFor('waiting', m => m.players.length === 3 && m.players.some(p => p.bot));
  a.send({ type: 'leaveRoom' }); await a.waitFor('leftRoom');
  const waitingBot = await b.waitFor('waiting', m =>
    m.players.length === 2 && m.players.some(p => p.bot) && m.players[0].name === '玩家二');
  assert.equal(waitingBot.hostId, 0);
  assert.equal(waitingBot.players.filter(p => p.bot).length, 1, '人机应保留');
  // 新房主可以移除人机
  b.send({ type: 'removeBot', playerId: waitingBot.players.find(p => p.bot).id });
  await b.waitFor('waiting', m => !m.players.some(p => p.bot));
  b.send({ type: 'leaveRoom' }); await b.waitFor('leftRoom');
  assert.equal(f.app.rooms.has(roomId), false, '全员退出后房间应关闭');
  assert.ok(f.app.rooms.has('test'), '测试房应始终保留');
});

test('等待房内可在参赛席与观战席之间切换，唯一的参赛者不能切走', async t => {
  const f = await createFixture(t);
  const host = await f.client();
  await guest(host, '房主', 'seat_host_0000001');
  const other = await f.client();
  await guest(other, '玩家二', 'seat_guest_00001');
  host.send({ type: 'createRoom', dlcEnabled: false });
  const roomId = String((await host.waitFor('roomCreated')).roomId);
  host.send({ type: 'joinRoom', roomId });
  await host.waitFor('roomJoined');
  await host.waitFor('chatHistory');
  // 唯一的参赛者（房主）不能切到观战席
  host.send({ type: 'toggleSeat' });
  assert.equal((await host.waitFor('error')).code, 'ONLY_PARTICIPANT');
  other.send({ type: 'joinRoom', roomId });
  await other.waitFor('roomJoined');
  await other.waitFor('chatHistory');
  // 玩家二切到观战席
  other.send({ type: 'toggleSeat' });
  const waiting = await other.waitFor('waiting', m => m.spectators.length === 1 && m.players.length === 1);
  assert.equal(waiting.spectators[0].name, '玩家二');
  assert.equal(waiting.players[0].name, '房主');
  assert.equal(waiting.hostId, 0);
  // 再切回参赛席
  other.send({ type: 'toggleSeat' });
  const waiting2 = await other.waitFor('waiting', m => m.spectators.length === 0 && m.players.length === 2);
  assert.ok(waiting2.players.some(p => p.name === '玩家二'));
  assert.ok(waiting2.players.some(p => p.name === '房主'));
});

test('对局中可加入观战：收到实时状态、系统提示与观战标识，且不能操作', async t => {
  const f = await createFixture(t);
  const host = await f.client();
  await guest(host, '房主', 'spec_host_0000001');
  const player2 = await f.client();
  await guest(player2, '玩家二', 'spec_player_0001');
  host.send({ type: 'createRoom', dlcEnabled: false });
  const roomId = String((await host.waitFor('roomCreated')).roomId);
  host.send({ type: 'joinRoom', roomId });
  await host.waitFor('roomJoined');
  await host.waitFor('chatHistory');
  player2.send({ type: 'joinRoom', roomId });
  await player2.waitFor('roomJoined');
  await player2.waitFor('chatHistory');
  host.send({ type: 'startGame' });
  await host.waitFor('state');
  // 第三人中途加入 → 自动成为观战者
  const watcher = await f.client();
  await guest(watcher, '观战者', 'spec_watcher_0001');
  watcher.send({ type: 'joinRoom', roomId });
  const joined = await watcher.waitFor('roomJoined');
  assert.equal(joined.spectator, true);
  assert.equal(joined.playerId, null);
  const state = await watcher.waitFor('state');
  assert.equal(state.game.players.length, 2);
  // 参赛者收到“加入观战”系统提示
  const sysMsg = await host.waitFor('chat', m => m.system === true);
  assert.ok(sysMsg.text.includes('观战者'));
  assert.ok(sysMsg.text.includes('加入了观战'));
  // 观战者可以发言，消息带观战标识
  watcher.send({ type: 'chat', text: '加油！' });
  const chat = await host.waitFor('chat', m => m.text === '加油！');
  assert.equal(chat.spectator, true);
  assert.equal(chat.name, '观战者');
  // 观战者不能进行游戏操作
  watcher.send({ type: 'roll', count: 1 });
  assert.equal((await watcher.waitFor('error')).code, 'INVALID_SEAT');
  // 观战者退出不影响对局
  watcher.send({ type: 'leaveRoom' });
  await watcher.waitFor('leftRoom');
  const room = f.app.rooms.get(roomId);
  assert.ok(room.game);
  assert.equal(room.members.length, 2);
});

test('对局结束自动返回等待房，参赛者与观战者席位保持不变', async t => {
  const f = await createFixture(t, { gameOverResetMs: 150 });
  const host = await f.client();
  await guest(host, '房主', 'go_host_00000001');
  const player2 = await f.client();
  await guest(player2, '玩家二', 'go_player_00001');
  host.send({ type: 'createRoom', dlcEnabled: false });
  const roomId = String((await host.waitFor('roomCreated')).roomId);
  host.send({ type: 'joinRoom', roomId });
  await host.waitFor('roomJoined');
  await host.waitFor('chatHistory');
  player2.send({ type: 'joinRoom', roomId });
  await player2.waitFor('roomJoined');
  await player2.waitFor('chatHistory');
  host.send({ type: 'startGame' });
  await host.waitFor('state');
  const watcher = await f.client();
  await guest(watcher, '观战者', 'go_watcher_00001');
  watcher.send({ type: 'joinRoom', roomId });
  await watcher.waitFor('roomJoined');
  await watcher.waitFor('state');
  // 让房主建成第 4 个地标获胜
  const room = f.app.rooms.get(roomId);
  const game = room.game;
  const player = game.players[0];
  player.money = 100;
  player.landmarks = { train: true, radio: true, mallC: true, park: false };
  game.dice = { count: 1, values: [3], sum: 3, firstCount: 1 };
  game.settled = true;
  game.builtThisTurn = false;
  game.pendingChoice = null;
  game.current = 0;
  host.send({ type: 'build', landmarkId: 'park' });
  await host.waitFor('state', m => m.game.gameOver);
  // 自动返回等待房（约150ms后），参赛者与观战者席位不变
  const waiting = await host.waitFor('waiting', m => !m.gameRunning && m.players.length === 2 && m.spectators.length === 1, 5000);
  assert.equal(waiting.players[0].name, '房主');
  assert.equal(waiting.players[1].name, '玩家二');
  assert.equal(waiting.hostId, 0);
  assert.equal(waiting.spectators[0].name, '观战者');
  const waitingWatcher = await watcher.waitFor('waiting', m => !m.gameRunning && m.spectators.length === 1, 5000);
  assert.equal(waitingWatcher.spectators.length, 1);
  assert.equal(f.app.rooms.get(roomId).game, null);
  // 结束后可再次开局（参赛者仍在席）
  host.send({ type: 'startGame' });
  const state2 = await host.waitFor('state', undefined, 5000);
  assert.equal(state2.game.players.length, 2);
});

test('等待房满员后新玩家自动进入观战席，界面数据与正常房间一致', async t => {
  const f = await createFixture(t);
  const host = await f.client();
  await guest(host, '房主', 'fullroom_host_001');
  host.send({ type: 'createRoom', dlcEnabled: false });
  const roomId = String((await host.waitFor('roomCreated')).roomId);
  host.send({ type: 'joinRoom', roomId });
  await host.waitFor('roomJoined');
  await host.waitFor('chatHistory');
  for (let i = 0; i < 3; i += 1) {
    const c = await f.client();
    await guest(c, `玩家${i}`, `fullroom_p_0000${i}`);
    c.send({ type: 'joinRoom', roomId });
    await c.waitFor('roomJoined');
    await c.waitFor('chatHistory');
  }
  // 4 名参赛者已满，第 5 人自动进入观战席
  const late = await f.client();
  await guest(late, '后来者', 'fullroom_w_0001');
  late.send({ type: 'joinRoom', roomId });
  const joined = await late.waitFor('roomJoined');
  assert.equal(joined.spectator, true);
  assert.equal(joined.playerId, null);
  const waiting = await late.waitFor('waiting', m => m.spectators.length === 1);
  assert.equal(waiting.players.length, 4);
  assert.equal(waiting.spectators[0].name, '后来者');
  assert.equal(waiting.hostId, 0);
  // 大厅同步显示观战人数
  const lobby = await late.waitFor('lobby', m => m.rooms.some(r => r.id === roomId));
  const room = lobby.rooms.find(r => r.id === roomId);
  assert.equal(room.playerCount, 4);
  assert.equal(room.spectatorCount, 1);
});
