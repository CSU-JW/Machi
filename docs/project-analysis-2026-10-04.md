# Machi「梦想小镇」项目全景分析

> 分析对象：`D:\temp\Machi-main`（本地无 `.git`，以当前工作区文件为准）
> 基线：`node --test test/*.test.js` = 63 通过 / 0 失败
> 分析日期：2026-10-04

---

## 0. 一句话结论

这是一个完成度相当高的四人联机桌游：服务端权威、规则引擎 + DLC 扩展 + 三档人机 + 观战 + 聊天 + 重连都已经跑通，并且有 63 个真实测试兜底。当前最大的问题不在功能缺失，而在三处「结构债」：

1. **协议入口没有做键白名单校验**，一个已登录玩家用 `cardId: "__proto__"` 就能让整个 Node 进程崩溃（已实测复现，P0）。
2. **人类掉线没有接管/超时机制**，对局会被永久卡死；规则再好也无法在高并发/弱网下可靠运行（P1）。
3. **规则数据在多处重复实现**（引擎、人机、客户端、DLC runtime、balance），已经出现文档与代码数值不一致（麦田/面包店牌堆），继续加卡会越来越难（P2，也是「规则建模」的核心）。

下面按「功能地图 → 关键问题 → 规则建模 → 结算时序 → 平衡 → 优化路线图 → 意外方向」展开。

---

## 1. 技术栈与运行方式

| 层 | 实现 |
|---|---|
| 运行时 | Node.js CommonJS，无框架 |
| 传输 | `http` + `ws`（WebSocket 同端口），`ws@^8.22.0` |
| 认证 | 自研 `AuthStore`，`crypto.scryptSync` + 随机盐 + `timingSafeEqual` |
| 状态 | 全内存：`rooms: Map`、`sessions: Map`；账号持久化到 `data/accounts.json` |
| 引擎 | `engine.js`（纯函数式状态机，服务端权威） |
| 卡牌数据 | `cards.js`（原版）+ `dlc1/catalog.js`（DLC 数据） |
| DLC 规则 | `dlc1/runtime.js`（角色/任务/事件/新建筑效果） |
| 人机 | `bots.js`（三档难度 + 期望收益/压制策略） |
| 前端 | 原生 JS + DOM，`public/index.html` + `public/client.js` + `public/style.css` |
| 测试 | `node --test`，`test/*.test.js`，63 个用例 |

启动：`npm start`（默认 3000 端口）；部署见 `CHANGELOG.md`（腾讯云 + PM2）。

---

## 2. 已实现功能地图

**账号与大厅**
- 账号注册/登录 + 游客登录（游客身份 = `sha256(deviceId)`，用于断线重连与防重复占座）。
- 会话 token 有效期 7 天；设备 cookie `machi_device` 用于设备级身份。
- 大厅房间列表、创建房间（可勾选 DLC）、房间编号最小空号复用、空房自动关闭。
- 单人测试房 `test`：永不关闭，退出只复位。

**房间（等待期）**
- 4 参赛席 + 不限观战席；参赛满/对局中后来者自动进观战席。
- 席位排序不变式：真人参赛 → 人机 → 观战者；房主永远是真人（大部分路径成立，见 P2-3）。
- 头像四选一（狗/鸡/鱼/鸭），点击他人头像查看角色与任务。
- 房主可开关 DLC、添加/移除人机、开始游戏（≥2 参赛者，满员也需手动确认）。
- 房间聊天：实时广播、100 条历史、300 字上限、500ms 限流、系统提示、观战标识。

**对局**
- 掷 1/2 骰、点数触发、收费/收益结算、购卡（每回合 1 张）、建设（每回合 1 个）。
- 6 点特殊卡：体育馆、电视塔、商场（每人限 1、不参与交换、特殊结算顺序）。
- 四地标胜利：火车站、广播中心、商业中心、游乐园；重投、额外回合、商业中心加成。
- 双骰收入修正 `a = max((m+n)/6, 1)`，向上取整，单骰恒为 1。
- 观战：实时状态、返回房间、断线 30 秒移出、对局结束 8 秒自动回房（或立即回房）。
- 断线重连：等待房 30 秒清理，对局中席位保留 10 分钟。

**DLC「海滨假日」**
- 11 张新建筑（绿/蓝/红/紫四色 + 效果公式 + 上限）。
- 8 个城市事件（每轮一张、每人每轮最多 1 元、额外回合不刷新轮次）。
- 8 个城镇任务（入门/进阶/挑战三选一，奖励券/现金/便民服务）。
- 6 个角色（建筑师、采购员、园艺师、导游、会计、收藏家；二选一、30 秒选择、冷却按自己回合编号）。
- 紫色建筑统一「每人限 1、不可交换」，与博物馆唯一性一致。

**人机**
- 三档难度：简单（买得起就买）、普通（期望收益/成本比 + 预留建设资金）、困难（识别领跑者、红卡狙击、蓝卡押注、断供压制、落后追分）。
- 掷骰支持期望加权 softmax 选择（`ROLL_PARAMS`），DLC 自动选角色/任务。

---

## 3. 关键问题清单（按严重度）

### P0 — 已登录玩家可用非法 `cardId` 打崩整个服务进程（远程 DoS）

**位置**：`engine.js:308-321`（`canBuy`），入口 `server.js:751-755`（`buy` 消息）。

`CARDS` 是普通对象字面量，任何未拦截的原型键都会命中 `Object.prototype`：
`CARDS["__proto__"] === Object.prototype`、`CARDS["constructor"]` 是函数。于是：

```js
const card = CARDS[cardId];          // cardId = "__proto__" → 真值
...
if (!card.points.includes(g.dice.sum)) // card.points === undefined → TypeError
```

**实测复现**：本地起服务 → 游客登录 → 进测试房 → 开局 → 掷骰结算 → 发送
`{"type":"buy","cardId":"__proto__"}`，进程以未捕获 `TypeError` 退出（exit code 1）：

```
TypeError: Cannot read properties of undefined (reading 'includes')
    at canBuy (engine.js:318:20)
    at Object.buyCard (engine.js:328:15)
    at handleGameAction (server.js:752:24)
```

影响：任意已登录玩家只要轮到自己且已结算，就能让线上进程崩溃（PM2 会重启，但会反复宕机、丢对局）。`constructor`、`hasOwnProperty`、`toString` 等键同理。

**修复建议**
1. 所有按 id 索引的查表统一改为安全查表：
   `if (!Object.prototype.hasOwnProperty.call(CARDS, cardId)) return { ok:false, reason:'无此卡' };`
   推荐直接把 `CARDS`、`LANDMARKS`、`cardPool`、`players[].cards` 建成 `Object.create(null)` 或 `Map`。
2. `ws.on('message')` 外层加 `try/catch`，记录日志并回 `error`，避免单个坏消息拖垮进程。
3. 给 `WebSocketServer` 加 `maxPayload`（例如 64KB），并加针对该键集的回归测试（`__proto__` / `constructor` / `hasOwnProperty` / `toString`）。
4. 同类风险点：`mortgage`/`mallPickCards` 里的 `roll.cards[myCardId]` 也没有 `hasOwnProperty` 校验（不会崩，但会产生 `undefined`/NaN 文案），建议一并收口。

---

### P1 — 人类掉线/挂机会永久卡死对局（无回合超时、无托管）

**位置**：`server.js:441-473`（`releaseGameMember`）、`server.js:887-926`（`disconnectFromRoom`）、`engine.js:113-198`（依赖玩家 `choice`）。

现状：
- 对局中掉线：席位保留 10 分钟；期间轮到该玩家，其他人只能等。10 分钟后 `releaseGameMember` 只把 `identityKey` / `socket` 清掉，**`room.game.players[playerId]` 仍然保留**，且没有 bot 接管、没有自动 `endTurn`。
- 于是「掉线者正好是当前回合玩家」= 整局永久卡死；其他玩家无法推进，也无法跳过。`incomePending` / `pendingChoice` 卡在 6 点收费选择时同样死锁。
- 这是弱网/手机切后台场景下的必然事件，不是极端情况。

**修复建议**
- 给每个回合加服务端计时器（例如 45–60 秒）。超时按「接受当前骰子 → 用与 bot 相同的启发式自动买/建 → 结束回合」自动推进。
- 掉线即刻托管：保留席位与可见状态，但由 bot 逻辑暂代决策，直到重连；重连后交还控制权。
- `releaseGameMember` 到达 TTL 时，要么继续托管，要么在「无真人参赛者」时强制结束；绝不能留下无人可操作的当前回合。
- 增加「离线 · 托管中 · 还差 N 秒」的客户端提示。

---

### P2-1 — 加入带人机的房间后，`playerId` 与数组下标错位，导致人机无法移除

**位置**：`server.js:619-662`（`handleJoinRoom`）、`server.js:1037-1050`（`removeBot`）。

`handleJoinRoom` 用 `participantCount` 作为新成员的 `playerId`，但插入位置是「最后一个真人之后、人机之前」；只有 `insertIndex === 0` 时才调用 `reindexWaitingRoom`。

例如房间已有 `[真人A, 人机1]`，真人 B 加入：
- `participantCount = 2`，B 的 `playerId = 2`，但插入后数组是 `[A, B, 人机1]`，B 实际在下标 1。
- `waitingPayload.players` 按数组顺序映射，人机的 `id` 仍是旧值 1；客户端「移除人机」发送 `playerId: 1`，服务端取 `room.members[1]` = 真人 B → 拒绝 `INVALID_BOT`。
- 同一错位还导致 B 在等待房调用 `setAvatar` 时取到人机席位，提示「当前没有玩家席位」。

**修复建议**：插入后无条件 `reindexWaitingRoom(room)`；或移除按数组下标定位，改用稳定 `seatKey` / 成员对象。补一条「带人机房再加入真人后仍可移除人机/改头像」的测试。

---

### P2-2 — 文档与代码数值已经不一致（牌堆上限）

`rules.txt:33` 麦田 10、`rules.txt:35` 面包店 8；`cards.js:10` 麦田 **14**、`cards.js:12` 面包店 **12**。其余 13 种一致。四人开局各扣 1 张后，麦田可购 10 张（文档 6 张）、面包店可购 8 张（文档 4 张）。

这不是单纯文档问题：它直接影响麦田锁场、面包店铺场速度与平衡。建议明确「线上为准」的是哪一版，然后让 `cards.js`、`rules.txt`、`dlc1/balance.md`、`CHANGELOG.md` 与测试同源；最好加一条「牌堆上限一致性」的自动化测试。

---

### P2-3 — 观战/房主不变式存在一个破口

等待房里只有 1 真人参赛者 + 1 人机时，该真人可以切到观战席（`participants.length <= 1` 只挡住了「唯一参赛者」，没挡住「唯一真人」）。此时：
- `waitingPayload.hostId = participants[0].playerId` 指向人机；真人的 `myId` 为 null，`isHost` 永假；
- 没人能加/移人机、开关 DLC、开始游戏，房间功能暂时不可用（真人是可以再切回参赛席恢复的，所以是 P2 而非 P1）。

建议：房主检查统一用「真人身份」而非 `participants[0]`；切换席位时保证至少保留 1 名真人参赛者，或允许房主以观战身份继续控制等待房。

---

### P2-4 — 全量状态广播 + 无上限日志 + 无 payload 上限

**位置**：`server.js:188-213`（`broadcastGame`）、`engine.js` 的 `g.log`。

- 每次动作都把整个 `game`（含全部玩家、牌堆、完整 `log`）`JSON.stringify` 后广播给房间所有成员；`log` 无上限，长局会线性膨胀。客户端只渲染末 80 条，传输与内存都被浪费。
- `WebSocketServer` 未设 `maxPayload`，默认上限极大；恶意客户端可发大消息放大内存/CPU。

建议：日志改为增量事件（`logAppend`），或服务端截断到固定长度（如 500 条）；`state` 只带必要字段；`new WebSocketServer({ server, maxPayload: 64 * 1024 })`。

---

### P3 — 认证与持久化的稳健性

- `auth-store.js` 的 `load()` 在 `accounts.json` 解析失败时只打日志并继续用空数据；下一次注册调用 `save()` 会把原文件覆盖为空账号列表。建议先备份损坏文件并 fail fast，或写 `.corrupt-<ts>` 再重建。
- 登录/注册没有失败限流，配合 scrypt 可被用于 CPU 消耗攻击；建议按设备/IP 加滑动窗口限流。
- `sessions` 全内存，PM2 重启即全部登出（token 失效）；若可接受，至少在文档写明；若不可接受，落盘或用 Redis。
- `websocket` 无连接数/消息频率上限；聊天有 500ms 限流，其余消息没有。

---

### P3 — 前端与工程化

- `public/client.js:474-528` 手抄了一份卡牌元数据（名称/点数/价格/图片/描述/类型/SIX_CARDS），与 `cards.js`、`bots.js`、`engine.js` 各自维护一份 `SIX_CARDS`。任何新卡/改数值都要改 4 处，P2-2 就是这种漂移的实例。
- `escapeHtml()`（`client.js:567`）是死代码（全站用 `textContent`，本身没问题）。
- DLC 选择文案说「倒计时结束自动选择」，但界面没有可见倒计时；`game.dlc.taskDeadline` 已经传到前端，可以直接渲染。
- `animateDice` 对单骰在动画阶段随机显示 1–12（`client.js:732`），观感上像是双骰；建议按 `game.dice.count` 限制为 1–6。
- `index.html` 内联了一大段 `<style>`，同时又加载 `style.css`，存在重复/覆盖；长期维护建议合并到一处。
- `package.json` 的 `main` 指向 `cards.js`（实际入口是 `server.js`）；没有 `engines` 字段（实际需要 Node ≥18，且这里跑在 Node 24）；仓库无 CI 配置。

---

## 4. 规则建模分析（重点）

### 4.1 当前模型

原版卡牌是「触发器 + 效果」的数据描述：

```js
{ id, name, cost, points:[...], trigger:'any|self|other|six', limit,
  effect:{ type:'gain|take|takeAll|takeOne|swap|perCard|perCardMulti', ... } }
```

DLC 卡则是另一套：

```js
{ id, name, points, cost, color, limit, unique,
  effect:'fixed|take|landmarkStep|diceCount|seafood|blueKinds|landmarks|factoryKinds' }
```

然后由 `cards.js` 把颜色映射成 `trigger`，并在 `engine.js` 里用 `effect.type === 'dlc'` 分叉到 `dlc1/runtime.js`。地标效果完全硬编码在引擎里（`bonusFor`、`canReroll`、`updateExtraTurn`、`isWin`）。

### 4.2 问题

1. **两套并行规则语言**：原版 `effect.type` vs DLC `effect.rule`，加上 `trigger` 与 `color` 的二次映射；加一张卡要在 `cards.js` + `engine.js` + `bots.js` + `client.js` + `rules/balance/tests` 间反复切换。
2. **`six` 触发器语义过载**：它同时表示「6 点」+「每人唯一」+「不可交换」+「需要交互选择」+「特殊结算顺序」。任何一个属性的扩展（例如未来出一张 6 点但可交换的卡）都要改多处条件。
3. **顺序是过程式的**：收费 → 6 点选择 → 系统收益 → 商场交换，散落在 `settle` / `handleChoice` / `nextSixChoice` / `finishIncome` 之间，没有显式的阶段/优先级模型，难以穷举测试与扩展。
4. **地标不是数据**：地标只有 `{id,name,cost}`，效果写在引擎 `if` 里；DLC 的角色/任务/事件也大量 `switch`。
5. **客户端与 AI 各有一份规则理解**：客户端只做展示，AI 用启发式近似；两者都会随规则变化漂移（见第 6 节双骰期望误差）。

### 4.3 建议的目标模型

把「规则」变成**声明式目录 + 统一结算管线**：

```js
// rules/catalog.js —— 唯一数据源（服务端/客户端/AI/文档共用）
{
  id: 'dairy', name: '奶制品工厂', cost: 3, points: [7],
  triggers: [{ on: 'roll', scope: 'self' }],
  effects: [{ op: 'gainPer', dep: 'ranch', amount: 2 }],
  constraints: { maxOwned: null, exchangeable: true },
  phase: 'income', priority: 100,
}
```

```js
// rules/resolver.js —— 收集 → 排序 → 执行
resolve(triggerContext) {
  const events = collect(triggerContext);           // 谁在什么点数、什么 scope 下触发
  events.sort(byPhaseThenPriorityThenSeat);         // 显式优先级 + 座位序
  for (const e of events) applyEffect(e, triggerContext);
}
```

- `collect` 只负责「是否触发」（含 self/any/other/all、唯一性、可交换性）。
- `applyEffect` 是 `op` 注册表（`gain`、`gainPer`、`take`、`takeEach`、`swap`、`bonus`…），DLC 只是多注册几个 `op`，不需要第二套 runtime。
- 地标变成带 `hooks` 的 descriptor：`diceCount`、`onWinningRoll`、`onIncomeBonus`、`onAfterTurn`、`winCondition`。
- 客户端从同一目录生成 `CARD_NAMES/POINTS/COSTS/IMAGES`，或由 `/api/catalog` 下发；`SIX_CARDS` 只导出一次。
- 文档可以由目录生成（或至少由一条 conformance 测试对照 `rules.txt` 断言 cost/limit/points）。

收益：新增卡只改数据 + 一个 `op`；结算顺序可被单元测试穷举；AI 可以直接读同一目录做 EV；文档与代码不再漂移。

---

## 5. 结算时序（现状与建议）

现状（`engine.js:113-198`）：

1. `settle()` 先遍历所有玩家，按座位顺序结算所有 `trigger === 'other'` 的红卡收费（付款方为当前掷骰者，付款上限为现有余额）。
2. 若最终点数为 6 且掷骰者有体育馆 → 先询问体育馆（向其他人各收 2）；有电视塔 → 再询问并选目标（收最多 5）。
3. `finishIncome()` 按玩家、按卡牌结算 `any` / `self` 收益（含 DLC 收益、商业中心加成、双骰倍率），并触发 DLC `afterIncome` 与广播中心额外回合。
4. 最后 `mallChoice()` 询问商场交换。

这套顺序与 `rules.txt` / DLC README 一致，测试也覆盖了主要分支。问题在于它是「函数调用顺序」而不是「数据化阶段」：
- 想插入新阶段（如「回合开始前」「掷骰前」「结算后」「回合结束」）需要改控制流；
- 6 点的子顺序（体育馆 → 电视塔 → 系统收益含博物馆 → 商场）由 `nextSixChoice` 手工串起来；
- 「同类收费按座位序」只在 owner 维度成立，同一 owner 的多张红卡内部按 `Object.keys` 插入顺序处理（目前没有规则冲突，但属于隐式语义）。

建议：显式定义 `PHASES = ['redCharge','sixChoice','income','exchange','endTurn']` 与每张卡的 `phase/priority`；`settle` 只负责 `collect + sort + run`。这样 6 点特殊卡只是 `phase:'sixChoice'`，博物馆只是 `phase:'income'`，新卡天然可插拔。

---

## 6. 平衡建模

### 6.1 双骰倍率的 `ceil` 量化问题

`diceIncomeMultiplier` 给出连续倍率 `a = max((m+n)/6, 1)`，但实际收益是 `Math.ceil(raw * a)`。对最常见的 `raw = 1`：

| 双骰和 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|
| 倍率 | 1.167 | 1.333 | 1.5 | 1.667 | 1.833 | 2.0 |
| raw=1 实得 | 2 | 2 | 2 | 2 | 2 | 2 |

也就是说：**1 元收益卡在双骰 7–12 时全部变成 +2**，平滑倍率在低面值卡上实际退化为「×2」。`raw=2` 则 7–9 得 3、10–12 得 4。建议先明确设计意图：
- 想保留平滑 → 对「同一玩家同一张卡」先求和再乘倍率一次取整，或用固定倍率表/四舍五入；
- 想做成「双骰更强」的明确手感 → 直接在文档里写成 ×2（7–12），并去掉伪平滑。

### 6.2 AI 与引擎的双骰期望已经不一致

`bots.js:20` 用 `profile(pt) * max(pt/6, 1)` 近似倍率，但引擎是 `ceil`。以单点卡 `points:[7]`、`raw=1` 为例：
- 引擎每轮期望 = `P(7) × ceil(1 × 7/6) = 1/6 × 2 ≈ 0.333`
- 机器人每轮期望 = `1/6 × 7/6 ≈ 0.194`（低估约 42%）

这会让高难度 AI 系统性低估双骰卡（尤其是 7 点区）。建议 AI 直接复用解析器的收益函数，或至少用与引擎一致的 `ceil` 期望。

### 6.3 其他平衡观察

- **矿山是二次增长**：`mine` 的 `perCard dep:'mine'` 表示 n 张矿山在 9 点时收益 `2n²`（文档写法如此，代码忠实实现）；配合 8 张库存理论值很高。建议加「每张卡每次触发上限」或递减收益，并用模拟验证。
- **双骰与单骰不对称**：倍率只作用于双骰，且双骰天然解锁 7–12 工厂；一旦拥有 7+ 卡，双骰优势会被放大。建议统计「有火车站后单/双骰选择率」与胜率。
- **商业中心无合计上限**：面包店等按张数线性 +1 且无上限，容易形成滚雪球；至少需要遥测数据支撑。
- **先手优势**：座位 1 每轮先动，收费也按座位序；可考虑每轮轮换先手，或统计座位胜率。
- **DLC 便民服务与额外回合**：`D.end` 在额外回合结束时会再检查一次 `serviceLeft`，广播中心链可能让 3 次「便民服务」在一个轮次内消耗两次。是否意图如此建议写明并测试。
- **缺实战数据**：`dlc1/balance.js` 只算静态单卡期望，不模拟互动与随机性。建议加一个 headless 模拟器：固定策略跑 10k 局，输出座位胜率、平均局时、各卡购买率/每元收益、角色胜率、任务完成回合。

---

## 7. 优化路线图（建议顺序）

**第一优先（稳定性）**
1. 修 P0：所有 id 查表加 `hasOwnProperty`/`Map`，`ws` 消息外层 `try/catch`，加 `maxPayload`，补 `__proto__`/`constructor` 回归测试。
2. 修 P1：回合超时 + 掉线托管；确保任何单人无法推进时对局都能自动前进。
3. 修 P2-1：插入后统一 `reindexWaitingRoom`；补测试。

**第二优先（一致性与可维护性）**
4. 建立单一规则目录 + 结算解析器（第 4 节），先迁移 1–2 张卡验证模式，再全量迁移。
5. 客户端改为消费同一目录（或 `/api/catalog`），删除手抄元数据与重复 `SIX_CARDS`。
6. 同步 `cards.js` 与 `rules.txt` 的牌堆上限，加 conformance 测试。
7. 日志增量/截断 + `state` 瘦身。

**第三优先（体验与运营）**
8. 可见的 30 秒角色/任务倒计时；购买/建设失败原因内联展示（服务端 already 返回 reason）。
9. 重连/离线/托管状态提示；房主可移出挂机席位。
10. 单骰动画限制 1–6；合并重复样式；`package.json` 修正 `main`/`engines`。
11. 认证限流、损坏账号文件备份、会话持久化决策。

**第四优先（增长）**
12. 对局回放/复盘（日志已带 `turn`，加 seeded RNG 即可录制）。
13. 战绩/排行榜/成就、房间邀请链接、再来一局投票。
14. 自定义房间参数（初始资金、回合时限、牌堆上限、DLC 子集）。
15. PWA/移动端适配与本地化。

---

## 8. 「想不到」的方向

- **可重放随机数**：把 `rollDice` 的 RNG 注入化并记录 seed + 输入序列，就能做回放、观战回看、争议仲裁与回归测试（当前 `Math.random` 让测试只能打桩）。
- **协议模糊测试**：这次 5 分钟就找到一个 P0，说明 WS 消息入口值得用 fuzz/property test 覆盖所有 `type` 与字段组合（尤其是对象键、NaN、超长字符串、数组代替对象）。
- **规则一致性编译**：把 `rules.txt` 中的 cost/limit/points 写成结构化表格，生成 `cards.js` 与文档，从根上消除 P2-2；或至少加一条「文档 ↔ 代码」断言。
- **托管/教练模式**：把 `bots.js` 的 EV 反向暴露为「提示」按钮，新人能学规则，AI 逻辑也复用同一份规则解析器。
- **单进程 → 水平扩展**：当前 `rooms`/`sessions` 全内存，PM2 cluster 或多实例会分裂状态。若未来流量上来，需要 Redis pub/sub + 粘性会话，或明确「单实例」约束。
- **掉线快照**：PM2 重启会丢所有房间与对局，可加定期快照 + 启动恢复，避免「部署即掉局」。
- **观战与反作弊**：全量 `state` 会暴露所有玩家手牌（桌游里是公开信息，问题不大），但若未来加入隐藏信息，需要 per-viewer 投影。
- **平衡自动化**：headless 模拟 + 参数搜索（牌堆上限、倍率表、AI 权重）可以自动给出候选平衡方案，而不是手工调数值。

---

## 9. 测试与验收建议

现有 63 个测试已经覆盖：引擎规则、DLC、人机、服务端集成、认证、平衡数值。建议新增：

1. **安全回归**：`buy`/`build`/`mallPickCards` 传 `__proto__`、`constructor`、`hasOwnProperty`、`toString`，断言服务不崩溃且返回合法错误。
2. **超时/掉线**：当前回合玩家断线、6 点 `pendingChoice` 中掉线、全员掉线、重连接管。
3. **座位映射**：带人机房间再加入真人后，移除人机、改头像、切席位、开局全部正确。
4. **文档一致性**：`cards.js` 与 `rules.txt` 的 cost/limit/points 对照。
5. **结算顺序属性测试**：随机生成玩家资金/卡牌/骰子，断言「先收费、不追缴、座位序、资金非负、总额守恒」。
6. **长局稳定性**：500+ 回合后 `log` 大小、广播 payload 大小、内存增长有上限。
7. **模拟对局**：10k 局统计座位胜率、平均局时、卡牌购买率/每元收益（可作为发布前平衡门禁）。

---

## 10. 参考位置

| 主题 | 文件:行 |
|---|---|
| 卡牌定义/上限 | `cards.js:10`、`cards.js:12`、`cards.js:32-49` |
| 规则文档上限 | `rules.txt:33`、`rules.txt:35` |
| 结算主体 | `engine.js:113-198` |
| 购买校验（P0） | `engine.js:308-321`、`server.js:751-755` |
| 建设/地标 | `engine.js:344-383` |
| 回合结束/额外回合 | `engine.js:384-401`、`dlc1/runtime.js:130-137` |
| 对局广播/日志 | `server.js:188-213` |
| 加入房间/座位（P2-1） | `server.js:596-662`、`server.js:1037-1050` |
| 掉线/释放（P1） | `server.js:441-473`、`server.js:887-926` |
| 人机 EV（6.2） | `bots.js:20-135`、`bots.js:82-108` |
| 客户端重复元数据 | `public/client.js:474-528` |
| DLC 效果/任务/事件 | `dlc1/runtime.js:48-137`、`dlc1/catalog.js` |

