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

test('大厅默认展示 1、2、3 号房', async t => {
  const fixture = await createFixture(t);
  const client = await fixture.client();
  client.send({ type: 'guestLogin', nickname: '游客甲', deviceId: 'device_0000000000000001' });
  await client.waitFor('authenticated');
  const lobby = await client.waitFor('lobby');
  assert.deepEqual(lobby.rooms.map(room => room.id), ['1', '2', '3']);
  assert.ok(lobby.rooms.every(room => room.playerCount === 0 && room.status === 'waiting'));
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
