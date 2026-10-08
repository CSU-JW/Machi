const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cleanNickname(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 12);
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateUsername(username) {
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    throw new AuthError('INVALID_USERNAME', '账号需为 3～20 位字母、数字或下划线');
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 72) {
    throw new AuthError('INVALID_PASSWORD', '密码长度需为 6～72 位');
  }
}

function validateNickname(nickname) {
  if (!nickname) throw new AuthError('INVALID_NICKNAME', '请输入昵称');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

class AuthStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { accounts: [] };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(parsed.accounts)) this.data = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.filePath, backupPath);
        } catch {
          // 备份失败时仍然继续用空数据启动，避免整个服务起不来。
        }
        console.error(`[auth] 账号数据读取失败，已备份到 ${backupPath}：${error.message}`);
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(temporaryPath, this.filePath);
  }

  register(input) {
    const username = normalizeUsername(input.username);
    const password = input.password;
    const nickname = cleanNickname(input.nickname);
    validateUsername(username);
    validatePassword(password);
    validateNickname(nickname);

    if (this.data.accounts.some(account => account.username === username)) {
      throw new AuthError('USERNAME_TAKEN', '该账号已被注册');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const account = {
      id: crypto.randomUUID(),
      username,
      nickname,
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: new Date().toISOString(),
    };
    this.data.accounts.push(account);
    this.save();
    return this.publicAccount(account);
  }

  authenticate(input) {
    const username = normalizeUsername(input.username);
    const password = input.password;
    validateUsername(username);
    validatePassword(password);

    const account = this.data.accounts.find(item => item.username === username);
    if (!account) throw new AuthError('BAD_CREDENTIALS', '账号或密码错误');

    const expected = Buffer.from(account.passwordHash, 'hex');
    const actual = Buffer.from(hashPassword(password, account.salt), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw new AuthError('BAD_CREDENTIALS', '账号或密码错误');
    }
    return this.publicAccount(account);
  }

  findById(id) {
    const account = this.data.accounts.find(item => item.id === id);
    return account ? this.publicAccount(account) : null;
  }

  publicAccount(account) {
    return { id: account.id, username: account.username, nickname: account.nickname };
  }
}

module.exports = { AuthStore, AuthError, cleanNickname };
