# Machi 全项目审查（2026-10-05）

> 审查范围：`engine.js` / `server.js` / `bots.js` / `cards.js` / `dlc1/*` / `public/*` / 资源与测试
> 基线：`node --test test/*.test.js` = 63 通过 / 0 失败
> 浏览器实测：16:9（1600×900）与 1042×871 两种视口，四角棋盘、骰子动画、卡牌弹窗、悬浮提示均正常

---

## 0. 现状数据

| 项 | 数据 |
|---|---|
| 测试 | 63 / 63 通过 |
| 原始卡图（30 张 PNG/JPG） | 40.2 MB |
| 生成的 256/512 WebP + JPEG 回退（90 个文件） | 5.0 MB |
| 对局背景图（board.webp / board.jpg） | 154 KB / 217 KB |
| 当前部署资源总计 | **44.6 MB** |
| 游戏内实际请求 | 256 WebP ≈ 17 KB/张；背景 154 KB |

---

## 1. P0：非法 `cardId` 可让服务进程崩溃（仍未修）

**位置**：`engine.js:308`（`canBuy`）、`server.js:751`（`buy` 消息入口）。

`CARDS` 是普通对象，`CARDS["__proto__"]` / `CARDS["constructor"]` / `CARDS["hasOwnProperty"]` 都会命中原型属性，随后 `card.points.includes(...)` 抛未捕获 `TypeError`，整个 Node 进程退出。

**实测**：

```js
const E = require('./engine');
const g = E.createGame(['A','B']);
g.dice = { count:1, values:[4], sum:4 }; g.settled = true;
E.canBuy(g, '__proto__');
// TypeError: Cannot read properties of undefined (reading 'includes')
```

**修复**：
1. 所有按 id 查表改成 `Object.prototype.hasOwnProperty.call(...)`，或把 `CARDS` / `LANDMARKS` / `cardPool` / `players[].cards` 建成 `Object.create(null)` / `Map`。
2. `ws.on('message')` 外层加 `try/catch`，坏消息记日志并回 `error`，不拖垮进程。
3. `new WebSocketServer({ server, maxPayload: 64 * 1024 })`。
4. 补回归测试：`__proto__` / `constructor` / `hasOwnProperty` / `toString`。
5. `mallPickCards` 的 `roller.cards[myCardId]` 也缺 `hasOwnProperty`，一并收口。

---

## 2. P1：人类掉线/挂机会永久卡死对局

**位置**：`server.js:447`（`releaseGameMember`）、`server.js:893`（`disconnectFromRoom`）。

掉线后席位保留 10 分钟，TTL 到期只清身份，`room.game.players[id]` 仍然存在，且没有回合超时或 bot 接管。只要掉线者正好是当前回合玩家，或在 6 点 `pendingChoice`（体育馆/电视塔/商场）中掉线，其余玩家无法推进，整局永久卡死。

**修复**：
- 每回合服务端计时（45–60 秒），超时自动「接受骰子 → 按 bot 启发式买/建 → 结束回合」。
- 掉线立即托管，重连交还控制权；TTL 到期要么继续托管，要么在无真人参赛时强制结束。
- 客户端显示「离线 · 托管中 · 还差 N 秒」。

---

## 3. P2：正确性、一致性、部署

### 3.1 牌堆上限与规则文档不一致

- `cards.js:10` 麦田 `limit: 14`，`rules.txt:33` 写 10。
- `cards.js:12` 面包店 `limit: 12`，`rules.txt:35` 写 8。
- 四种开局玩家各扣 1 张后，实际可购 10 / 8 张，文档是 6 / 4 张，直接影响锁场速度与平衡。

**修复**：确定唯一数值来源，同步 `cards.js` / `rules.txt` / `dlc1/balance.md` / `CHANGELOG.md`，加一条「文档 ↔ 代码」一致性测试。

### 3.2 带人机房再加入真人后，`playerId` 与数组下标错位

`server.js:602` 的 `handleJoinRoom` 用 `participantCount` 当新成员 `playerId`，但插入位置是「最后一个真人之后」；只有 `insertIndex === 0` 才 `reindexWaitingRoom`。

例：`[真人A, 人机1]` + 真人B → `[A, B, 人机1]`，B 的 `playerId = 2`，但 B 在下标 1。后果：房主移除人机时取到 B（`INVALID_BOT`），B 改头像时取到人机席位。修复：插入后无条件 `reindexWaitingRoom`，或改用稳定 `seatKey` 定位。

### 3.3 部署资源 44.6 MB，其中 40.2 MB 是没人请求的原图

游戏内只用生成的 256/512 WebP（+ JPEG 回退），唯一的原图消费者是 `dlc1/index.html` 图鉴预览页。把 1254×1254 PNG 留在部署包里会让每次部署/备份都拖着 40 MB。

**修复**：原图移到 `assets-src/`（不进部署），预览页改用 512 WebP；或用构建脚本把预览页也切到压缩图。

### 3.4 全量状态广播 + 日志无上限

`server.js:194` 的 `broadcastGame` 每次动作都把整个 `game`（含全部玩家、牌堆、完整 `log`）`JSON.stringify` 后广播；`log` 无上限，长局线性膨胀。客户端只渲染最后 80 条。

**修复**：日志改增量事件或服务端截断（如 500 条），`state` 只带必要字段。

### 3.5 `scripts/build-images.mjs` 不会刷新已有产物

`scripts/build-images.mjs:38-39` 发现目标存在就 `continue`。以后替换卡面原图再跑脚本不会重新生成缩略图。加 `--force` 或默认覆盖；同时在 README/脚本头注明依赖 `ffmpeg`。

### 3.6 账号数据损坏会被静默覆盖

`auth-store.js:50` 的 `load()` 解析失败只打日志并继续用空数据；下一次注册 `save()`（`auth-store.js:61`）会把原文件覆盖为空账号列表。建议先备份损坏文件（`.corrupt-<ts>`）再重建，或直接 fail fast。

### 3.7 登录/注册没有失败限流

`scryptSync` 是可被滥用的 CPU 消耗点；`handleAuthentication` 没有按设备/IP 的滑动窗口限流。建议加登录失败限流与连接数上限。

---

## 4. P3：UI / UX

1. **DLC 角色/任务选择被塞进顶部中间格**。`renderDlcPanel` 输出到 `.board-top`（只有 24% 高，`overflow-y:auto`），6 个角色 + 3 个任务 + 事件说明会在一个矮条里滚动。建议改成和操作面板一样的居中弹层。
2. **30 秒倒计时没有显示**。文案说「倒计时结束后自动选择」，但界面没有计时器；`game.dlc.taskDeadline` 已经传到前端，直接渲染即可。
3. **窄屏（如 1042×871）中间牌堆会滚动**。16:9 下 16/26 张都能一屏放下，4:3 或窄屏时 26 张（DLC）需要滚动。建议窄屏时自动缩小市场卡尺寸，或让中间列获得更多宽度。
4. **背景 `background-size: 100% 100%`**（`style.css:523`）保证四角广场与玩家板对齐，但在超宽屏会横向拉伸；移动端竖排回退时会把背景拉得很长。建议超宽屏用 `cover` + 最大宽度，移动端单独换一张竖版或纯色。
5. **记录面板没有收起开关**（聊天有）。长局时左侧记录占满整列，建议加折叠。
6. **操作弹层会遮住整个中间牌堆**。这是弹窗语义，但玩家在购买时看不到牌堆全貌；如果希望边买边看，可改成侧边抽屉或半透明。
7. **悬浮提示在触屏上不可用**。桌面 hover 正常，触屏只能点开详情；可接受，但可考虑长按显示。
8. **客户端仍手抄卡牌元数据**：`client.js:474/481/486/520` 重复维护 `CARD_NAMES/CARD_POINTS/CARD_COSTS/SIX_CARDS`；`engine.js`、`bots.js`、`client.js` 各有一份 `SIX_CARDS`。规则目录化时应收敛成一份。
9. **`escapeHtml`（`client.js:610`）是死代码**；全站用 `textContent`，本身安全，但可以删。
10. **`package.json`：`main` 指向 `cards.js`（实际入口 `server.js`），没有 `engines`（实际需要 Node ≥18），仓库没有 CI 配置。**

---

## 5. 规则与平衡

1. **双骰倍率的 `ceil` 量化**：`a = max(sum/6,1)` 但收益是 `ceil(raw × a)`。对 `raw = 1` 的卡（麦田/牧场/面包店等），双骰 7–12 全部得 `+2`，平滑倍率在低面值卡上退化成 ×2。要么按「同一玩家同一卡型先求和再乘倍率」取整，要么明确写成 ×2。
2. **机器人 EV 与引擎不一致**：`bots.js:20` 用 `max(pt/6,1)` 近似，忽略 `ceil`。单点 7 的 1 元卡，引擎每轮期望 ≈ 0.333，机器人只算 ≈ 0.194，系统性低估双骰卡约 20–40%。建议机器人复用引擎的收益函数。
3. **矿山二次增长**：`mine` 的 `perCard dep:'mine'` 表示 n 张矿山在 9 点时收益 `2n²`（文档如此，代码忠实），8 张库存理论上限很高。建议加每张卡每次触发的上限或递减收益，并用模拟验证。
4. **便民服务与广播中心额外回合**：`dlc1/runtime.js:130-137` 的 `end()` 在普通回合结束和额外回合结束都会检查 `serviceLeft`，一次广播中心连锁可能在同一轮消耗两次便民服务。是否意图如此建议写明并补测试。
5. **平衡验证仍是静态 EV**：`dlc1/balance.js` 只算单卡期望，不模拟互动。建议加 headless 模拟器：固定策略跑 10k 局，输出座位胜率、平均局时、各卡购买率/每元收益、角色胜率、任务完成回合。
6. `UNIQUE_CARDS` / `SIX_CARDS` 在多处重复，规则改动容易漏改。

---

## 6. 做得好的部分

- 服务端权威：所有买卖/建设/收费都在引擎校验，客户端只发意图。
- 资金转移用 `transferUpTo` 保证不出现负数，收费上限处理正确。
- 聊天限流、`textContent` 渲染防 XSS、设备级防重复占座、重连恢复席位都做得完整。
- 63 个测试覆盖引擎规则、DLC、人机策略、服务端集成；DLC 的边界（重投、收费优先、紫卡不可交换、任务不重复领取）都有测试。
- 图片管线落地：40 MB → 5 MB（生成物），游戏内只请求 256 WebP，背景 154 KB。
- 新 UI 已浏览器实测：四角玩家、中间牌堆、轮到你弹出的操作层、3D 骰子（1/2 颗）、悬浮规则提示、支付优惠按需显示，均正常。

---

## 7. 建议修复顺序

1. P0：`hasOwnProperty`/`Map` + `ws try/catch` + `maxPayload` + 回归测试。
2. P1：回合超时 + 掉线托管。
3. P2：牌堆上限同步、`reindexWaitingRoom`、部署资源瘦身、日志增量。
4. P3：DLC 选择弹层 + 倒计时、窄屏市场缩放、记录折叠。
5. 规则：双骰取整口径、机器人 EV 对齐、矿山上限、便民服务测试。
6. 工程：规则目录化（单一数据源）、CI、`engines`、`build-images --force`、账号文件容错。

