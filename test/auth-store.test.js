const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AuthStore } = require('../auth-store');

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('注册信息持久化，且密码不会明文保存', t => {
  const root = temporaryDirectory(t);
  const file = path.join(root, 'accounts.json');
  const store = new AuthStore(file);
  const account = store.register({ username: 'Player_01', password: 'secret88', nickname: '小明' });

  assert.equal(account.username, 'player_01');
  assert.equal(account.nickname, '小明');
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.equal(onDisk.includes('secret88'), false);

  const reloaded = new AuthStore(file);
  assert.equal(reloaded.authenticate({ username: 'PLAYER_01', password: 'secret88' }).id, account.id);
  assert.throws(
    () => reloaded.authenticate({ username: 'player_01', password: 'wrong-password' }),
    error => error.code === 'BAD_CREDENTIALS',
  );
});

test('拒绝重复账号和无效注册信息', t => {
  const root = temporaryDirectory(t);
  const store = new AuthStore(path.join(root, 'accounts.json'));
  store.register({ username: 'tester', password: '123456', nickname: '测试员' });
  assert.throws(
    () => store.register({ username: 'TESTER', password: 'abcdef', nickname: '另一人' }),
    error => error.code === 'USERNAME_TAKEN',
  );
  assert.throws(
    () => store.register({ username: 'x', password: '123456', nickname: '短账号' }),
    error => error.code === 'INVALID_USERNAME',
  );
});

test('账号文件损坏时会先备份，而不是静默清空覆盖', t => {
  const root = temporaryDirectory(t);
  const file = path.join(root, 'accounts.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');

  const store = new AuthStore(file);
  assert.deepEqual(store.data.accounts, []);

  const backups = fs.readdirSync(root).filter(name => name.startsWith('accounts.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, backups[0]), 'utf8'), '{ this is not json');
});
