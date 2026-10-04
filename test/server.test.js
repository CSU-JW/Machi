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

async function createFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(__dirname, '.tmp-server-'));
  const app = createMachiServer({ dataDir });
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

test('大厅默认展示 1、2、3 号房和单人测试房', async t => {
  const fixture = await createFixture(t);
  const client = await fixture.client();
  client.send({ type: 'guestLogin', nickname: '游客甲', deviceId: 'device_0000000000000001' });
  await client.waitFor('authenticated');
  const lobby = await client.waitFor('lobby');
  assert.deepEqual(lobby.rooms.map(room => room.id), ['1', '2', '3', 'test']);
  assert.ok(lobby.rooms.every(room => room.playerCount === 0 && room.status === 'waiting'));
});

test('单人测试房限一席、手动开局、头像同步及退出复位',async t=>{
  const f=await createFixture(t),a=await f.client(),b=await f.client();
  await guest(a,'测试员','solo_test_device_000001');await guest(b,'第二人','solo_test_device_000002');
  a.send({type:'joinRoom',roomId:'test'});await a.waitFor('roomJoined');
  const waiting=await a.waitFor('waiting');assert.equal(waiting.capacity,1);assert.equal(f.app.rooms.get('test').game,null);
  b.send({type:'joinRoom',roomId:'test'});assert.equal((await b.waitFor('error')).code,'ROOM_FULL');
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
  for (let index = 0; index < 4; index += 1) {
    const client = await fixture.client();
    await guest(client, `玩家${index + 1}`, `unique_device_0000000000${index}`);
    client.send({ type: 'joinRoom', roomId: '2' });
    await client.waitFor('roomJoined');
    clients.push(client);
  }
  const state = await clients[3].waitFor('state');
  assert.equal(state.game.players.length, 4);
  assert.deepEqual(state.game.players.map(player => player.name), ['玩家1', '玩家2', '玩家3', '玩家4']);
  assert.ok(fixture.app.rooms.get('2').game);
});

test('开局后主动退出会释放身份，全部退出后原房号恢复为空房', async t => {
  const fixture = await createFixture(t);
  const clients = [];
  for (let index = 0; index < 4; index += 1) {
    const client = await fixture.client();
    await guest(client, `离场玩家${index + 1}`, `leave_device_00000000000${index}`);
    client.send({ type: 'joinRoom', roomId: '3' });
    await client.waitFor('roomJoined');
    clients.push(client);
  }
  await clients[3].waitFor('state');

  for (const client of clients) {
    client.send({ type: 'leaveRoom' });
    await client.waitFor('leftRoom');
  }
  const room = fixture.app.rooms.get('3');
  assert.equal(room.game, null);
  assert.equal(room.members.length, 0);

  clients[0].send({ type: 'joinRoom', roomId: '1' });
  const joinedAgain = await clients[0].waitFor('roomJoined');
  assert.equal(joinedAgain.roomId, '1');
});

test('房主DLC开关同步、非房主拒绝、开局锁定，任务与重连状态保持',async t=>{
  const f=await createFixture(t),clients=[];
  for(let i=0;i<2;i++){
    const c=await f.client();await guest(c,`扩展玩家${i}`,`dlc_device_00000000000${i}`);
    c.send({type:'joinRoom',roomId:'1'});await c.waitFor('roomJoined');clients.push(c);
  }
  clients[1].send({type:'setDlc',enabled:true});assert.equal((await clients[1].waitFor('error')).code,'HOST_ONLY');
  clients[0].send({type:'setDlc',enabled:true});
  await clients[1].waitFor('waiting',m=>m.dlcEnabled===true);
  for(let i=2;i<4;i++){
    const c=await f.client();await guest(c,`扩展玩家${i}`,`dlc_device_00000000000${i}`);c.send({type:'joinRoom',roomId:'1'});await c.waitFor('roomJoined');clients.push(c);
  }
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

  // 满 4 人开局后聊天依然可用
  const e = await f.client(); await guest(e, '聊天戊', 'chat_device_0000000005');
  e.send({ type: 'joinRoom', roomId: '1' }); await e.waitFor('roomJoined');
  await a.waitFor('state');
  b.send({ type: 'chat', text: '开局啦' });
  assert.equal((await a.waitFor('chat', m => m.text === '开局啦')).name, '聊天乙');
  assert.equal((await d.waitFor('chat', m => m.text === '开局啦')).text, '开局啦');
});
