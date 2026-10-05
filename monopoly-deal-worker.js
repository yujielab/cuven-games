/*!
 * monopoly-deal-worker.js — Monopoly Deal 真人对战后端 v1.6.0（Cloudflare Worker + Durable Object）
 *
 * 一个文件包含：规则引擎（v1.8.0，已移除 AI；含 3 张自定义行动卡、追赶机制、赌一把、奖池、加注、大乐透、成就和出牌超时）+ HTTP 接口 + 房间 Durable Object（WebSocket 对战）。
 * 服务器是唯一权威：客户端只发动作，座位由连接凭证决定，每人只收到自己能看到的信息（对方手牌、牌堆顺序不下发）。
 *
 * ━━━━━━━━━━━━━━━━━━━━ 部署（手动，不用 wrangler） ━━━━━━━━━━━━━━━━━━━━
 *   Durable Object 的类只能在上传脚本时创建，控制台的在线编辑器做不到，所以第一次用一条 curl 上传
 *   （API 令牌需要「Workers 脚本：编辑」权限）：
 *     curl "https://api.cloudflare.com/client/v4/accounts/<账户 ID>/workers/scripts/monopoly-deal" -X PUT \
 *       -H "Authorization: Bearer <API 令牌>" \
 *       -F 'metadata={"main_module":"monopoly-deal-worker.js","compatibility_date":"2025-09-01","bindings":[{"type":"durable_object_namespace","name":"ROOMS","class_name":"GameRoom"}],"migrations":{"new_tag":"v1","new_sqlite_classes":["GameRoom"]}};type=application/json' \
 *       -F 'monopoly-deal-worker.js=@monopoly-deal-worker.js;type=application/javascript+module'
 *   之后改代码：控制台 → 这个 Worker → Edit code → 整段粘贴 → Deploy。类名 GameRoom、绑定名 ROOMS 不要改。
 *   可选变量（控制台 → Settings → Variables and Secrets，纯文本）：
 *     ALLOWED_ORIGINS  允许连接的前端地址，逗号分隔，如 https://quantum.cuven.us（不设 = 不限制）
 *     ROOM_TTL_HOURS   房间无人连接多久后自动清理（默认 24）
 *     TURN_SECONDS     单张出牌的时限（默认 30，可设 5–600）：超时作废 1 次出牌，3 次都超时（90 秒）自动结束回合
 *     RESPOND_SECONDS  回应、弃牌的时限（默认 25，可设 5–600）：超时自动接受 / 按建议付款 / 按建议弃牌
 *   卡牌 PNG 不经过 Worker：前端直接从 R2 自定义域名加载（见前端文件顶部 CONFIG）。
 *   部署后浏览器打开 /api/health 自检：会逐项说明绑定、房间对象、变量是否正常。
 *
 * ━━━━━━━━━━━━━━━━━━━━ HTTP 接口（均支持 CORS） ━━━━━━━━━━━━━━━━━━━━
 *   GET  /api/health                            自检（绑定 / 房间对象 / 变量）
 *   GET  /api/meta                              牌面数据、颜色、图片清单、规则（前端启动时拉一次）
 *   POST /api/rooms           { name, preset?, claim? }  建房 → { roomId, seat: 0, token }；preset: 'balanced' | 'official'
 *   GET  /api/rooms/:code                            房间状态 → { players: [{ name, online } | null], started, phase, … }
 *   POST /api/rooms/:code/join { name, token?, claim? }  加入 → { roomId, seat, token }；带上已有 token = 回到原座位
 *                                                    claim：客户端预先生成的 32 位十六进制凭证，网络重试时不会被当成第三个人
 *   GET  /api/rooms/:code/ws?token=…                 WebSocket 对战连接
 *   出错统一返回 { ok: false, error: { code, message } }，message 是中文。
 *
 * ━━━━━━━━━━━━━━━━━━━━ WebSocket 消息 ━━━━━━━━━━━━━━━━━━━━
 *   客户端 → 服务器
 *     'ping'                                      心跳（运行时自动回 'pong'，不唤醒对象）
 *     { t: 'act', id, aid?, action: { type, …参数 } }   出牌等动作（格式同引擎 dispatch，player 不用填）
 *                                                 aid：动作的唯一编号，断线后原样重发，同一个 aid 只执行一次
 *     { t: 'rematch' }                            再来一局（双方都发了才开新局）
 *     { t: 'emote', e }                           发表情（👍 😂 😮 😭 😤 🎉 之一，每人至少间隔 1.2 秒）
 *     { t: 'sync' }                               重新要一份完整状态
 *   服务器 → 客户端
 *     { t: 'welcome', seat, room, view?, options?, discardHint?, log? }   连上时 / 开新局时的完整状态
 *     { t: 'update', events, lines, room, view, options, discardHint }    每次有人动作后（events 已按座位脱敏，lines 是中文日志）
 *     { t: 'room', room }                                                  在线状态 / 再来一局意向变化
 *     { t: 'emote', seat, e, count }                                       有人发了表情（count = 他这局发的第几个）
 *     { t: 'award', seat, award: 'emoteMaster' }                           有人一回合内发了 5 个以上表情，拿到「表情大师」
 *     { t: 'ack', id, ok, error? }                                         自己动作的结果
 *     { t: 'error', code, message }    { t: 'fatal', code, message }（随后断开，如房间已过期 / 凭证无效）
 *   room = { id, preset, round, started, rematch: [bool, bool], score: [分, 分]（每局赢家得这局的分值，加注后会翻倍）, emotes: [这一回合的表情数, …], players: [{ name, online } | null, …] }
 *
 * ━━━━━━━━━━━━━━━━━━━━ 联机规则 ━━━━━━━━━━━━━━━━━━━━
 *   被收钱 / 被偷 / 被抢时，一律由被针对的人亲自点「接受 / 付款 / 反对行动」（autoResolve: false）：
 *   如果没有「反对行动」就秒结算，等于告诉对方你手里没有「反对行动」。
 *   出满 3 张（且没有待回应的行动）自动结束回合（autoEndTurn: true）。
 *   追赶机制（comeback: true），双方完全对称，只帮落后的一方；满足条件时也只有 10% 的几率触发（comebackChance: 10）：
 *     逆风补给  回合开始时，对手比你多 2 套以上完整地产 → 这回合多摸 1 张
 *     背水一战  回合开始时，对手只差一套就赢、而你比他少 → 这回合可以出 4 张
 *   赌一把（gamble: true）：打出收钱的牌（租金 / 讨债人 / 生日）时可以选押 ×2 或 ×4，每回合最多一次。
 *     押 ×m 赢的几率正好是 1/m（×2 是 50%，×4 是 25%），赢了这次收 m 倍，输了这张牌（连同叠的「租金翻倍」）作废。
 *     期望和不赌完全一样，双方规则一样；用对局自己的随机数在服务器上结算，客户端改不了。
 *   奖池（jackpot: true）：每次有人赌输，奖池 +1 张（最多 3 张）；下一个押 ×4 赌赢的人把奖池里的张数全部摸走。
 *   加注（doubling: true，规则同双陆棋的加倍方块）：在自己回合开始、还没出牌时，可以把这局的分值翻倍（最高 ×8）。
 *     对方选「跟注」：继续打，这局赢家得翻倍后的分，之后只有跟注的一方能再加注；
 *     选「弃牌」：这局直接输，按加注前的分值算。房间战绩按分累计。
 *   大乐透（lottery: true）：收租结算时有 15% 的几率（lotteryChance）额外中一笔彩票奖金，金额 5–20M 随机，
 *     从抽牌堆和弃牌堆里的钱币随机凑出这个数（凑不满就给凑得出的最多），直接进收租人的银行。双方规则一样。
 *     保底（lotteryPity: 4）：每人各自计数，连续收租 4 次都没中，第 4 次必中；中了（或保底）就重新计数。
 *   成就（每局每人每项一次，只是荣誉，不影响规则）。全部只在自己的一个回合之内计数，回合开始时重新算：
 *     超级大盗  一回合内让对方损失超过 10M（收到的钱、偷走 / 抢走 / 毁掉的地产按面值算），或抢走一整套地产
 *     破坏大师  回合开始时对方桌上有地产，这回合内被你清到一张不剩
 *     超级金库  回合开始时对方银行里有钱，这回合内被你搬空；或者这回合内自己的银行超过 30M（回合开始时还不到）
 *     表情大师  一回合内发了 5 个以上表情（服务层计数，见 room.emotes / room.emoteAward）
 *
 * ━━━━━━━━━━━━━━━━━━━━ 自定义行动卡（各 1 张，面值 10M，可以被「反对行动」挡下） ━━━━━━━━━━━━━━━━━━━━
 *   破产      拿走对手银行里的全部牌
 *   清算      选对手一整套完整地产，连同上面的房屋 / 旅馆一起进弃牌堆，并弃掉对手全部手牌
 *   Huge Win  对手所有地产组（连同上面的建筑）进弃牌堆；自己当时已凑齐的完整套记一个 ×4 加成，
 *             下一次打出租金卡时用掉：按加成里的颜色收就 ×4，按别的颜色收则加成作废
 *   1.0 的旧存档读入时，会把这 3 张随机洗进抽牌堆。
 */
import { DurableObject } from 'cloudflare:workers';

/* ═══════════════════════════ 规则引擎 monopoly-deal-engine.js v1.2.1（原样内嵌，完整说明见引擎文件）═══════════════════════════ */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root) root.MonopolyDeal = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.8.0';

  /* ═══════════════════════════ 静态数据 ═══════════════════════════ */

  const COLOR_KEYS = ['brown', 'lightBlue', 'pink', 'orange', 'red', 'yellow', 'green', 'darkBlue', 'railroad', 'utility'];

  // size 满套张数；rent[n-1] 拥有 n 张时的租金；value 地产卡抵债面值；buildable 能否盖房屋 / 旅馆
  const COLORS = {
    brown:     { zh: '棕色',     en: 'Brown',      size: 2, rent: [1, 2],       value: 1, buildable: true,  hex: '#8B5A3C' },
    lightBlue: { zh: '浅蓝',     en: 'Light Blue', size: 3, rent: [1, 2, 3],    value: 1, buildable: true,  hex: '#A7DBF2' },
    pink:      { zh: '粉色',     en: 'Pink',       size: 3, rent: [1, 2, 4],    value: 2, buildable: true,  hex: '#D63C8C' },
    orange:    { zh: '橙色',     en: 'Orange',     size: 3, rent: [1, 3, 5],    value: 2, buildable: true,  hex: '#F3912B' },
    red:       { zh: '红色',     en: 'Red',        size: 3, rent: [2, 3, 6],    value: 3, buildable: true,  hex: '#E2332B' },
    yellow:    { zh: '黄色',     en: 'Yellow',     size: 3, rent: [2, 4, 6],    value: 3, buildable: true,  hex: '#F6D71C' },
    green:     { zh: '绿色',     en: 'Green',      size: 3, rent: [2, 4, 7],    value: 4, buildable: true,  hex: '#21A052' },
    darkBlue:  { zh: '深蓝',     en: 'Dark Blue',  size: 2, rent: [3, 8],       value: 4, buildable: true,  hex: '#1F4FA0' },
    railroad:  { zh: '车站',     en: 'Railroad',   size: 4, rent: [1, 2, 3, 4], value: 2, buildable: false, hex: '#2B2B2B' },
    utility:   { zh: '公用事业', en: 'Utility',    size: 2, rent: [1, 2],       value: 2, buildable: false, hex: '#C9E4B8' },
  };
  COLOR_KEYS.forEach((k) => { COLORS[k].key = k; });

  const HOUSE_BONUS = 3;
  const HOTEL_BONUS = 4;

  // 地产名按这副中文版卡牌（城市 / 车站）；同色内的先后顺序决定 face 序号，如 property-brown-1 = 成都
  const PROPERTY_NAMES = {
    brown:     [['Chengdu', '成都'], ['Wuhan', '武汉']],
    lightBlue: [['Dalian', '大连'], ['Harbin', '哈尔滨'], ['Shenyang', '沈阳']],
    pink:      [['Jinan', '济南'], ['Nanchang', '南昌'], ['Qingdao', '青岛']],
    orange:    [['Guiyang', '贵阳'], ['Xiamen', '厦门'], ['Changsha', '长沙']],
    red:       [['Hangzhou', '杭州'], ['Nanjing', '南京'], ['Suzhou', '苏州']],
    yellow:    [['Lanzhou', '兰州'], ["Xi'an", '西安'], ['Zhengzhou', '郑州']],
    green:     [['Fuzhou', '福州'], ['Guangzhou', '广州'], ['Tianjin', '天津']],
    darkBlue:  [['Beijing', '北京'], ['Shanghai', '上海']],
    railroad:  [['Beijing Railway Station', '北京站'], ['Chongqing Railway Station', '重庆站'], ['Guangzhou Railway Station', '广州站'], ['Shanghai Railway Station', '上海站']],
    utility:   [['Electric Company', '电力公司'], ['Water Company', '自来水公司']],
  };


  // 行动卡：value 存银行面值，count 张数，text 卡面效果（双人版措辞，可直接用作卡面说明）
  const ACTIONS = {
    dealBreaker:   { zh: '交易破坏者',     en: 'Deal Breaker',     value: 5, count: 2,  text: '抢走对手一整套完整地产，连同上面的房屋和旅馆' },
    justSayNo:     { zh: '反对行动',       en: 'Just Say No!',     value: 4, count: 3,  text: '对手对你打行动卡时打出，抵消效果；对方也可以再打一张「反对行动」抵消你的' },
    slyDeal:       { zh: '狡猾交易',       en: 'Sly Deal',         value: 3, count: 3,  text: '拿走对手 1 张不在完整套里的地产' },
    forcedDeal:    { zh: '强买强卖',       en: 'Forced Deal',      value: 3, count: 3,  text: '用自己 1 张地产换对手 1 张，都不能出自完整套' },
    debtCollector: { zh: '讨债人',         en: 'Debt Collector',   value: 3, count: 3,  text: '对手付你 5M' },
    birthday:      { zh: '今天是你的生日', en: "It's My Birthday", value: 2, count: 3,  text: '对手付你 2M' },
    passGo:        { zh: '经过',           en: 'Pass Go',          value: 1, count: 10, text: '再摸 2 张牌' },
    doubleRent:    { zh: '租金翻倍',       en: 'Double The Rent',  value: 1, count: 2,  text: '和租金卡一起打出，租金翻倍' },
    house:         { zh: '房屋',           en: 'House',            value: 3, count: 3,  text: '放在完整套上，租金 +3M（车站、公用事业除外）' },
    hotel:         { zh: '旅馆',           en: 'Hotel',            value: 4, count: 2,  text: '放在已有房屋的完整套上，租金再 +4M' },
    // 自定义行动卡：各 1 张，面值 10M。custom 的牌排在整副牌最后（牌号 106–108），不打乱原有牌号，旧存档照样能读
    bankruptcy:    { zh: '破产',           en: 'Bankruptcy',       value: 10, count: 1, custom: true, text: '拿走对手银行里的全部资产' },
    liquidation:   { zh: '清算',           en: 'Liquidation',      value: 10, count: 1, custom: true, text: '清空对手一整套完整地产（连同上面的房屋、旅馆），并弃掉对手的全部手牌' },
    hugeWin:       { zh: 'Huge Win',       en: 'Huge Win',         value: 10, count: 1, custom: true, text: '对手桌上的地产全部消失；你现有的完整套下次收租 ×4（只对那次收租选的一套生效一次）' },
  };

  const BOOST_MULT = 4; // Huge Win 的收租倍数
  const BETS = [2, 4];  // 赌一把可以押的倍数：押 ×m 赢的几率是 1/m，期望不变
  const AWARDS = { thief: '超级大盗', destroyer: '破坏大师', vault: '超级金库' }; // 引擎负责的成就（表情大师在服务层）


  const PENDING_ACTIONS = ['rent', 'debtCollector', 'birthday', 'slyDeal', 'forcedDeal', 'dealBreaker', 'bankruptcy', 'liquidation', 'hugeWin', 'raise'];
  const PHASES = ['play', 'respond', 'discard', 'gameOver'];

  /* ═══════════════════════════ 规则 ═══════════════════════════ */

  const DEFAULT_RULES = {
    handLimit: 7,                    // 回合结束时手牌上限
    playsPerTurn: 3,                 // 每回合最多出牌次数
    drawPerTurn: 2,                  // 回合开始摸牌数
    drawWhenEmpty: 5,                // 回合开始手牌为空时改摸的张数
    startingHand: 5,                 // 起手牌数
    firstTurnDraw: 0,                // 先手第 1 回合摸牌数（官方 2；双人对局里先手优势明显，默认 0 抵消）
    setsToWin: 3,                    // 获胜所需「不同颜色」完整套数量
    discardTo: 'discardPile',        // 超限弃牌去向：'discardPile' 新版规则 | 'deckBottom' 旧版规则（塞回抽牌堆底）
    jsnCountsAsPlay: false,          // 自己回合打出的「反对行动」是否占出牌次数
    maxDoubleRent: 2,                // 一张租金最多叠几张双倍（2 张 = ×4）
    doubleRentWithWildRent: true,    // 任意颜色租金能否叠双倍（部分电子版不允许）
    multiWildAloneNoRent: true,      // 只由全色多功能地产组成的地产组不能收租
    forcedDealFromOwnFullSet: false, // 强买强卖时能否拿自己完整套里的牌去换
    payWithBuildings: true,          // 房屋 / 旅馆能否拿来付款（收款方存入银行）
    autoResolve: true,               // 被询问方只有唯一选择时自动结算：没有「反对行动」就自动接受；桌面不够付就自动全付
    stalemateTurns: 6,               // 牌堆和弃牌堆都空、连续这么多回合没人出牌 → 判平局；双方都没手牌时立即判。0 = 关闭
    maxTurns: 0,                     // >0 时超过该回合数判平局，0 = 不限
    logLimit: 400,                   // 内置日志最多保留条数，0 = 不限
    autoEndTurn: false,              // 出牌次数用完（且没有待回应的行动）时自动结束回合
    comeback: false,                 // 追赶机制：落后 2 套以上回合开始多摸 1 张（逆风补给）；对手到赛点时本回合多出 1 张（背水一战）
    comebackChance: 10,              // 满足条件时，每个追赶机制触发的几率（%）；用对局自己的随机数，服务器说了算，结果可复现
    gamble: false,                   // 赌一把：收钱的牌可以押 ×2（50%）或 ×4（25%），输了这张牌作废；每回合最多一次
    jackpot: false,                  // 奖池：每次赌输奖池 +1 张，下一个押 ×4 赌赢的人全部摸走
    potMax: 3,                       // 奖池最多攒几张
    doubling: false,                 // 加注：自己回合开始时可以把这局分值翻倍，对方跟注或弃牌（双陆棋的加倍方块）
    maxStake: 8,                     // 一局最高几倍
    lottery: false,                  // 大乐透：收租结算时按几率额外中一笔彩票奖金（从牌堆 / 弃牌堆里的钱凑）
    lotteryChance: 15,               // 每次收租中奖的几率（%）
    lotteryPity: 4,                  // 保底：同一个人连续收租这么多次都没中，这一次必中（0 = 不保底）
    lotteryMin: 5,                   // 奖金下限（M）
    lotteryMax: 20,                  // 奖金上限（M）
  };

  // 数值规则的允许范围（越界自动夹回，类型不对用默认值）；枚举规则列出可选值
  const RULE_SPEC = {
    handLimit: [1, 50],
    playsPerTurn: [1, 10],
    drawPerTurn: [0, 10],
    drawWhenEmpty: [0, 15],
    startingHand: [0, 20],
    firstTurnDraw: [0, 10],
    setsToWin: [1, 10],
    maxDoubleRent: [0, 2],
    stalemateTurns: [0, 1000],
    maxTurns: [0, 100000],
    logLimit: [0, 100000],
    comebackChance: [0, 100],
    potMax: [1, 10],
    maxStake: [2, 64],
    lotteryChance: [0, 100],
    lotteryPity: [0, 20],
    lotteryMin: [1, 57],
    lotteryMax: [1, 57],
    discardTo: ['discardPile', 'deckBottom'],
  };

  const PRESETS = {
    balanced: {},                   // 默认：官方规则 + 双人平衡
    official: { firstTurnDraw: 2 }, // 纯官方规则
  };

  function sanitizeRules(input, preset) {
    const src = Object.assign({}, hasOwn(PRESETS, preset) ? PRESETS[preset] : {}, input && typeof input === 'object' ? input : {});
    const r = {};
    for (const k of Object.keys(DEFAULT_RULES)) {
      const def = DEFAULT_RULES[k];
      const v = hasOwn(src, k) ? src[k] : def;
      const spec = RULE_SPEC[k];
      if (typeof def === 'boolean') {
        r[k] = typeof v === 'boolean' ? v : def;
      } else if (typeof def === 'number') {
        const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
        r[k] = Number.isFinite(n) ? Math.min(spec[1], Math.max(spec[0], Math.round(n))) : def;
      } else {
        r[k] = spec.indexOf(v) >= 0 ? v : def;
      }
    }
    return Object.freeze(r);
  }

  /* ═══════════════════════════ 牌组 ═══════════════════════════ */

  function buildCards() {
    const list = [];
    const add = (c) => { c.id = list.length; list.push(c); };
    const zhPair = (cols) => cols.map((c) => COLORS[c].zh).join('/');
    const enPair = (cols) => cols.map((c) => COLORS[c].en).join('/');
    // 钱 20 张：1M×6 2M×5 3M×3 4M×3 5M×2 10M×1
    [[1, 6], [2, 5], [3, 3], [4, 3], [5, 2], [10, 1]].forEach(([v, n]) => {
      for (let i = 0; i < n; i++) add({ type: 'money', value: v, en: v + 'M', zh: v + 'M', face: 'money-' + v });
    });
    // 地产 28 张
    COLOR_KEYS.forEach((color) => PROPERTY_NAMES[color].forEach(([en, zh], i) => {
      add({ type: 'property', color, value: COLORS[color].value, en, zh, face: `property-${lc(color)}-${i + 1}` });
    }));
    // 多功能地产 11 张（其中全色 2 张，无面值）
    [[['darkBlue', 'green'], 4, 1], [['green', 'railroad'], 4, 1], [['lightBlue', 'railroad'], 4, 1],
      [['railroad', 'utility'], 2, 1], [['lightBlue', 'brown'], 1, 1], [['pink', 'orange'], 2, 2], [['red', 'yellow'], 3, 2]]
      .forEach(([cols, v, n]) => {
        for (let i = 0; i < n; i++) {
          add({ type: 'wild', colors: cols.slice(), any: false, value: v, en: `Property Wild Card (${enPair(cols)})`, zh: `多功能地产（${zhPair(cols)}）`, face: 'wild-' + cols.map(lc).join('-') });
        }
      });
    for (let i = 0; i < 2; i++) add({ type: 'wild', colors: COLOR_KEYS.slice(), any: true, value: 0, en: 'Property Wild Card (Any)', zh: '多功能地产（全色通用）', face: 'wild-any' });
    // 行动 34 张（自定义行动卡放到最后）
    const addAction = (k) => {
      const d = ACTIONS[k];
      for (let i = 0; i < d.count; i++) add({ type: 'action', action: k, value: d.value, en: d.en, zh: d.zh, face: 'action-' + lc(k) });
    };
    Object.keys(ACTIONS).filter((k) => !ACTIONS[k].custom).forEach(addAction);
    // 租金 13 张：双色各 2 张 + 任意颜色 3 张
    [['darkBlue', 'green'], ['red', 'yellow'], ['pink', 'orange'], ['lightBlue', 'brown'], ['railroad', 'utility']].forEach((cols) => {
      for (let i = 0; i < 2; i++) add({ type: 'rent', colors: cols.slice(), any: false, value: 1, en: `Rent (${enPair(cols)})`, zh: `租金（${zhPair(cols)}）`, face: 'rent-' + cols.map(lc).join('-') });
    });
    for (let i = 0; i < 3; i++) add({ type: 'rent', colors: COLOR_KEYS.slice(), any: true, value: 3, en: 'Rent (Any)', zh: '租金（任意颜色）', face: 'rent-any' });
    // 自定义行动卡 3 张：破产、清算、Huge Win
    Object.keys(ACTIONS).filter((k) => ACTIONS[k].custom).forEach(addAction);
    return list;
  }

  const lc = (k) => k.toLowerCase();

  // 图片清单：每种牌面一张图 + 牌背；count 为这种牌在牌组里的张数
  function buildFaces(cards) {
    const out = [];
    const at = Object.create(null);
    for (const c of cards) {
      if (at[c.face] == null) { at[c.face] = out.length; out.push({ face: c.face, zh: c.zh, en: c.en, count: 0 }); }
      out[at[c.face]].count++;
    }
    out.push({ face: 'back', zh: '牌背', en: 'Card back', count: 0 });
    return out;
  }

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
  }

  const CARDS = deepFreeze(buildCards());
  const N_CARDS = CARDS.length; // 109（标准 106 + 自定义 3）
  const FACES = deepFreeze(buildFaces(CARDS)); // 61 种牌面 + 牌背
  deepFreeze(COLORS);
  deepFreeze(ACTIONS);
  deepFreeze(DEFAULT_RULES);
  deepFreeze(COLOR_KEYS);
  deepFreeze(RULE_SPEC);
  deepFreeze(PRESETS);

  /* ═══════════════════════════ 错误 ═══════════════════════════ */

  const MESSAGES = {
    BAD_ACTION: '动作格式不对',
    BAD_PLAYER: 'player 只能是 0 或 1',
    UNKNOWN_ACTION: '未知的动作类型',
    GAME_OVER: '对局已经结束',
    NOT_YOUR_TURN: '现在不是你的回合',
    NOT_YOUR_RESPONSE: '现在不需要你回应',
    WRONG_PHASE: '当前阶段不能这样操作',
    PENDING: '还有行动在等待回应',
    NO_PLAYS_LEFT: '本回合的出牌次数用完了',
    NOT_IN_HAND: '这张牌不在你手里',
    CANNOT_BANK: '地产牌不能存进银行',
    NOT_PROPERTY: '这不是地产牌',
    BAD_COLOR: '这张牌不能当作这个颜色',
    NO_SUCH_SET: '找不到这组地产',
    SET_COLOR_MISMATCH: '颜色和这组地产不一致',
    SET_FULL: '这组地产已经凑满了',
    SAME_SET: '已经在这组里了',
    SET_REQUIRED: '同色之间挪动请指定目标组 setId',
    NOT_ON_TABLE: '这张牌不在你的桌面上',
    NOT_ACTION: '这不是行动卡',
    JSN_RESPONSE_ONLY: '「反对行动」只能在被行动卡针对时打出',
    DOUBLE_NEEDS_RENT: '「租金翻倍」要和租金卡一起打出',
    BAD_DOUBLE: 'doubles 里只能放「租金翻倍」',
    TOO_MANY_DOUBLES: '租金翻倍叠加超过上限',
    DOUBLE_NOT_WITH_WILD_RENT: '当前规则下任意颜色租金不能叠双倍',
    NO_RENT_COLOR: '你在这个颜色上没有可以收租的地产',
    BAD_TARGET: '目标无效',
    BAD_GIVE: '要交出的地产无效',
    TARGET_IN_FULL_SET: '不能动对手完整套里的地产',
    GIVE_IN_FULL_SET: '不能拿自己完整套里的地产去换',
    NOT_FULL_SET: '目标不是完整套',
    NO_BUILD_TARGET: '没有可以放置的完整套',
    NOT_BUILDABLE: '车站和公用事业不能盖房屋或旅馆',
    HAS_HOUSE: '这组已经有房屋了',
    NEEDS_HOUSE: '要先有房屋才能放旅馆',
    HAS_HOTEL: '这组已经有旅馆了',
    NOT_BUILDING: '这不是房屋或旅馆',
    HOTEL_ON_TOP: '房屋上面压着旅馆，先挪走旅馆',
    NOT_JSN: '这不是「反对行动」',
    MUST_PAY: '需要选择付款的牌（PAY）',
    NOT_PAYMENT: '现在不是付款环节',
    NOT_PAYABLE: '这张牌不能用来付款',
    DUPLICATE: '选择里有重复的牌',
    PAY_ALL_REQUIRED: '桌面总额不够，必须全部付出',
    PAY_NOT_ENOUGH: '付款金额不足',
    DISCARD_COUNT: '弃牌张数不对',
    EMPTY_BANK: '对手银行是空的，拿不到东西',
    NO_GAMBLE: '这个房间没有开「赌一把」',
    BAD_BET: '只能押 ×2 或 ×4',
    ALREADY_GAMBLED: '这回合已经赌过一次了',
    BET_NOT_ALLOWED: '只有收钱的牌（租金、讨债人、生日）可以赌',
    NO_DOUBLING: '这个房间没有开「加注」',
    RAISE_AT_START: '只能在自己回合开始、还没出牌时加注',
    NOT_YOUR_CUBE: '上次是对方跟的注，加注权在对方手里',
    MAX_STAKE: '这局已经是最高倍数了',
    NOT_RAISE: '现在没有人要求加注',
    JSN_NOT_FOR_RAISE: '「反对行动」不能用来回应加注',
    NO_EFFECT: '对手桌上没有地产，你也没有完整套，打出去没有效果',
  };

  class RuleError extends Error {
    constructor(code) {
      super(MESSAGES[code] || code);
      this.name = 'RuleError';
      this.code = code;
    }
  }
  function fail(code) { throw new RuleError(code); }

  /* ═══════════════════════════ 小工具 ═══════════════════════════ */

  function hasOwn(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
  const isCardId = (id) => Number.isInteger(id) && id >= 0 && id < N_CARDS;
  const isPlayer = (p) => p === 0 || p === 1;
  const isColor = (c) => typeof c === 'string' && hasOwn(COLORS, c);
  const isProp = (id) => CARDS[id].type === 'property' || CARDS[id].type === 'wild';
  const isAct = (id, kind) => CARDS[id].action === kind;
  const isBuilding = (id) => isAct(id, 'house') || isAct(id, 'hotel');
  const colorsOf = (id) => (CARDS[id].type === 'property' ? [CARDS[id].color] : CARDS[id].colors || []);
  const valueOf = (id) => CARDS[id].value;
  const sum = (ids) => { let t = 0; for (const id of ids) t += CARDS[id].value; return t; };
  const other = (p) => 1 - p;
  const sizeOf = (color) => COLORS[color].size;
  const isFull = (set) => set.cards.length >= COLORS[set.color].size;
  const isPaymentKind = (a) => a === 'rent' || a === 'debtCollector' || a === 'birthday';
  const isStealKind = (a) => a === 'slyDeal' || a === 'forcedDeal';
  const newStats = () => ({ cardsPlayed: 0, received: 0, paid: 0, biggestHit: 0, steals: 0, setsStolen: 0, justSayNo: 0, bets: 0, betsWon: 0, dealt: 0, lottery: 0, lottoMiss: 0 });

  function toSeed(seed) {
    if (seed == null) return Math.floor(Math.random() * 4294967296) >>> 0;
    if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(seed) >>> 0;
    const str = String(seed); // 字符串种子（如房间号）走 FNV-1a
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // mulberry32
  function step32(x) {
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function rand(s) { // 对局随机数，状态存在 s.rng，随存档序列化
    s.rng = (s.rng + 0x6D2B79F5) >>> 0;
    return step32(s.rng);
  }

  function shuffle(s, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand(s) * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // 事件先进本次动作的缓冲区，动作整体成功后才写进日志（失败的动作不留痕迹）
  function emit(s, out, e) {
    e.seq = ++s.seq;
    out.push(e);
  }

  function appendLog(s, events) {
    for (const e of events) s.log.push(deepFreeze(e));
    const lim = s.rules.logLimit;
    if (lim > 0 && s.log.length > lim) s.log.splice(0, s.log.length - lim);
  }

  /* ═══════════════════════════ 状态：克隆 / 迁移 / 校验 ═══════════════════════════ */

  // 结构化克隆：只复制会变的部分；rules 冻结共享，log 只追加（动作成功后才追加），所以都不用复制
  function cloneState(s) {
    return {
      engine: s.engine,
      rules: s.rules,
      seed: s.seed,
      rng: s.rng,
      players: s.players.map(clonePlayer),
      deck: s.deck.slice(),
      discard: s.discard.slice(),
      turn: Object.assign({}, s.turn),
      phase: s.phase,
      pending: s.pending ? clonePending(s.pending) : null,
      discardNeed: s.discardNeed,
      result: s.result ? { winner: s.result.winner, reason: s.result.reason, turn: s.result.turn, stake: s.result.stake || 1 } : null,
      stake: s.stake,
      cube: s.cube,
      pot: s.pot,
      idleTurns: s.idleTurns,
      nextSetId: s.nextSetId,
      nextPendingId: s.nextPendingId,
      seq: s.seq,
      log: s.log,
    };
  }

  function clonePlayer(p) {
    return {
      name: p.name,
      hand: p.hand.slice(),
      bank: p.bank.slice(),
      sets: p.sets.map((x) => ({ id: x.id, color: x.color, cards: x.cards.slice(), house: x.house, hotel: x.hotel })),
      loose: p.loose.slice(),
      stats: Object.assign({}, p.stats),
      boost: p.boost ? { mult: p.boost.mult, colors: p.boost.colors.slice() } : null,
      awards: p.awards.slice(),
    };
  }

  function clonePending(pd) {
    const c = Object.assign({}, pd);
    c.doubles = pd.doubles.slice();
    c.chain = pd.chain.map((x) => ({ player: x.player, cardId: x.cardId }));
    return c;
  }

  // 旧版存档补字段（1.0 → 1.1）
  function migrate(s) {
    if (s.pending && s.pending.kind && !s.pending.action) {
      s.pending.action = { debt: 'debtCollector', sly: 'slyDeal', forced: 'forcedDeal' }[s.pending.kind] || s.pending.kind;
      delete s.pending.kind;
    }
    if (Array.isArray(s.players)) s.players.forEach((p) => { if (p && typeof p === 'object') { p.stats = Object.assign(newStats(), p.stats); if (!p.boost) p.boost = null; if (!Array.isArray(p.awards)) p.awards = []; } });
    addMissingCards(s);
    if (!Number.isInteger(s.idleTurns)) s.idleTurns = 0;
    if (s.turn && typeof s.turn === 'object' && !Number.isInteger(s.turn.bonus)) s.turn.bonus = 0;
    if (s.turn && typeof s.turn === 'object' && typeof s.turn.gambled !== 'boolean') s.turn.gambled = false;
    if (s.turn && typeof s.turn === 'object' && !Number.isInteger(s.turn.lapsed)) s.turn.lapsed = 0;
    if (s.turn && typeof s.turn === 'object' && !Number.isInteger(s.turn.oppProps) && Array.isArray(s.players) && s.players.length === 2) Object.assign(s.turn, turnBase(s, s.turn.player)); // 旧存档：从现在起算这一回合
    if (!Number.isInteger(s.stake) || s.stake < 1) s.stake = 1;
    if (s.cube !== 0 && s.cube !== 1) s.cube = null;
    if (!Number.isInteger(s.pot) || s.pot < 0) s.pot = 0;
    if (!Array.isArray(s.log)) s.log = [];
    s.engine = VERSION;
    return s;
  }

  // 1.2 → 1.3：牌组新增了自定义行动卡。旧存档里没有这几张，就随机洗进抽牌堆（用对局自己的随机数，结果可复现）
  function addMissingCards(s) {
    if (!Array.isArray(s.deck) || !Array.isArray(s.discard) || !Array.isArray(s.players) || !Number.isInteger(s.rng)) return;
    const seen = new Set(s.deck.concat(s.discard));
    for (const p of s.players) {
      if (!p || typeof p !== 'object') return;
      for (const k of ['hand', 'bank', 'loose']) if (Array.isArray(p[k])) p[k].forEach((id) => seen.add(id));
      if (Array.isArray(p.sets)) for (const x of p.sets) if (x && Array.isArray(x.cards)) { x.cards.forEach((id) => seen.add(id)); seen.add(x.house); seen.add(x.hotel); }
    }
    for (let id = 0; id < N_CARDS; id++) {
      if (!seen.has(id)) s.deck.splice(Math.floor(rand(s) * (s.deck.length + 1)), 0, id);
    }
  }

  /**
   * 检查状态是否完整自洽：109 张牌各在且只在一处、地产组颜色/张数/建筑合法、阶段与待回应行动一致……
   * 返回问题列表（中文），空数组表示健康。loadGame 读档时会自动调用。
   */
  function validateState(s) {
    const out = [];
    const bad = (m) => { if (out.length < 20) out.push(m); };
    if (!s || typeof s !== 'object') return ['存档不是对象'];
    if (!s.rules || typeof s.rules !== 'object') return ['缺少 rules'];
    if (!Array.isArray(s.players) || s.players.length !== 2) return ['players 必须是两名玩家'];
    if (!Array.isArray(s.deck) || !Array.isArray(s.discard)) return ['缺少 deck / discard'];
    const where = new Array(N_CARDS).fill(null);
    const mark = (id, at) => {
      if (!isCardId(id)) return bad(`${at} 里有非法牌号 ${id}`);
      if (where[id]) return bad(`牌 ${id} 同时出现在${where[id]}和${at}`);
      where[id] = at;
    };
    s.deck.forEach((id) => mark(id, '抽牌堆'));
    s.discard.forEach((id) => mark(id, '弃牌堆'));
    const setIds = new Set();
    s.players.forEach((p, i) => {
      if (!p || typeof p !== 'object') return bad(`玩家 ${i} 数据缺失`);
      for (const k of ['hand', 'bank', 'sets', 'loose']) if (!Array.isArray(p[k])) return bad(`玩家 ${i} 缺少 ${k}`);
      if (typeof p.name !== 'string') bad(`玩家 ${i} 名字无效`);
      if (p.boost != null && (typeof p.boost !== 'object' || !Array.isArray(p.boost.colors) || !p.boost.colors.every(isColor))) bad(`玩家 ${i} 的收租加成无效`);
      if (!Array.isArray(p.awards) || !p.awards.every((k) => hasOwn(AWARDS, k))) bad(`玩家 ${i} 的成就无效`);
      p.hand.forEach((id) => mark(id, `玩家${i}手牌`));
      p.bank.forEach((id) => {
        mark(id, `玩家${i}银行`);
        if (isCardId(id) && isProp(id)) bad(`地产 ${id} 在银行里`);
      });
      p.loose.forEach((id) => {
        mark(id, `玩家${i}散落建筑`);
        if (isCardId(id) && !isBuilding(id)) bad(`散落区里的 ${id} 不是建筑`);
      });
      p.sets.forEach((x) => {
        if (!x || !isColor(x.color) || !Array.isArray(x.cards)) return bad(`玩家 ${i} 有损坏的地产组`);
        if (!Number.isInteger(x.id) || setIds.has(x.id)) bad(`地产组 id ${x.id} 无效或重复`);
        setIds.add(x.id);
        if (!(x.id < s.nextSetId)) bad(`nextSetId 落后于地产组 ${x.id}`);
        if (!x.cards.length || x.cards.length > sizeOf(x.color)) bad(`地产组 ${x.id} 张数异常`);
        x.cards.forEach((id) => {
          mark(id, `地产组${x.id}`);
          if (isCardId(id) && (!isProp(id) || colorsOf(id).indexOf(x.color) < 0)) bad(`牌 ${id} 不能放在${COLORS[x.color].zh}组`);
        });
        if (x.house != null) {
          mark(x.house, `地产组${x.id}的房屋`);
          if (isCardId(x.house) && !isAct(x.house, 'house')) bad(`地产组 ${x.id} 的房屋位不是房屋`);
          if (!COLORS[x.color].buildable) bad(`${COLORS[x.color].zh}不能有房屋`);
        }
        if (x.hotel != null) {
          mark(x.hotel, `地产组${x.id}的旅馆`);
          if (isCardId(x.hotel) && !isAct(x.hotel, 'hotel')) bad(`地产组 ${x.id} 的旅馆位不是旅馆`);
          if (x.house == null) bad(`地产组 ${x.id} 有旅馆没房屋`);
        }
      });
    });
    const lost = where.indexOf(null);
    if (lost >= 0) bad(`牌 ${lost} 丢失`);
    const t = s.turn;
    if (!t || !isPlayer(t.player) || !Number.isInteger(t.number) || t.number < 1 || !Number.isInteger(t.plays) || t.plays < 0) bad('turn 数据异常');
    else if (t.plays > s.rules.playsPerTurn + (t.bonus || 0)) bad('本回合出牌数超过上限');
    if (PHASES.indexOf(s.phase) < 0) bad(`未知阶段 ${s.phase}`);
    if (s.phase === 'respond') {
      const e = validatePending(s);
      if (e) bad(e);
    } else if (s.pending) {
      bad('不在回应阶段却有待回应行动');
    }
    if (s.phase === 'discard' && t && isPlayer(t.player) && s.players[t.player] && Array.isArray(s.players[t.player].hand)) {
      if (s.discardNeed !== s.players[t.player].hand.length - s.rules.handLimit || s.discardNeed < 1) bad('discardNeed 与手牌数不符');
    }
    if ((s.phase === 'gameOver') !== !!s.result) bad('result 与阶段不一致');
    if (s.result && !(s.result.winner == null || isPlayer(s.result.winner))) bad('result.winner 无效');
    for (const k of ['seq', 'nextSetId', 'nextPendingId', 'idleTurns', 'rng', 'pot']) if (!Number.isInteger(s[k]) || s[k] < 0) bad(`${k} 无效`);
    if (!Number.isInteger(s.stake) || s.stake < 1 || s.stake > s.rules.maxStake) bad('stake 无效');
    if (s.cube != null && !isPlayer(s.cube)) bad('cube 无效');
    if (!Array.isArray(s.log)) bad('log 缺失');
    return out;
  }

  function validatePending(s) {
    const pd = s.pending;
    if (!pd || typeof pd !== 'object') return '回应阶段缺少 pending';
    if (PENDING_ACTIONS.indexOf(pd.action) < 0) return `未知的待回应行动 ${pd.action}`;
    if (!s.turn || pd.actor !== s.turn.player || pd.target !== other(pd.actor)) return 'pending 双方与回合不符';
    if (!Array.isArray(pd.chain) || !Array.isArray(pd.doubles)) return 'pending 结构损坏';
    if (pd.awaiting !== (pd.chain.length % 2 ? pd.actor : pd.target)) return 'pending.awaiting 与「反对行动」链不符';
    const A = s.players[pd.actor];
    const T = s.players[pd.target];
    if (!A || !T || !Array.isArray(A.sets) || !Array.isArray(T.sets)) return 'pending 指向的玩家无效';
    const setOf = (p, id) => (isCardId(id) ? findSetOf(p, id) : null);
    switch (pd.action) {
      case 'slyDeal': {
        const x = setOf(T, pd.targetCardId);
        return !x || isFull(x) ? '狡猾交易的目标已失效' : null;
      }
      case 'forcedDeal': {
        const g = setOf(A, pd.giveCardId);
        const x = setOf(T, pd.targetCardId);
        if (!g || (!s.rules.forcedDealFromOwnFullSet && isFull(g))) return '强买强卖交出的牌已失效';
        return !x || isFull(x) ? '强买强卖的目标已失效' : null;
      }
      case 'dealBreaker': {
        const x = T.sets.find((y) => y && y.id === pd.targetSetId);
        return !x || !isFull(x) ? '交易破坏者的目标已失效' : null;
      }
      case 'liquidation': {
        const x = T.sets.find((y) => y && y.id === pd.targetSetId);
        return !x || !isFull(x) ? '清算的目标已失效' : null;
      }
      case 'bankruptcy':
      case 'hugeWin':
        return null;
      case 'raise':
        return pd.stake === s.stake * 2 ? null : '加注倍数异常';
      default:
        return Number.isInteger(pd.amount) && pd.amount >= 0 ? null : '付款金额异常';
    }
  }

  /* ═══════════════════════════ 桌面查询 ═══════════════════════════ */

  function findSetOf(p, id) {
    for (const set of p.sets) if (set.cards.indexOf(id) >= 0) return set;
    return null;
  }

  // 按这一组收租能收多少（未满组按张数取档；满组加房屋 / 旅馆）
  function setRent(s, set) {
    if (!set.cards.length) return 0;
    if (s.rules.multiWildAloneNoRent && set.cards.every((id) => CARDS[id].any)) return 0;
    const c = COLORS[set.color];
    const n = Math.min(set.cards.length, c.size);
    let r = c.rent[n - 1];
    if (n === c.size) {
      if (set.house != null) r += HOUSE_BONUS;
      if (set.hotel != null) r += HOTEL_BONUS;
    }
    return r;
  }

  // 同色有多组时，租金按最值钱的那组算
  function rentFor(s, pi, color) {
    let best = 0;
    for (const set of s.players[pi].sets) if (set.color === color) best = Math.max(best, setRent(s, set));
    return best;
  }

  // Huge Win 加成：按这个颜色收租时乘几倍（没有加成就是 1）
  function boostFor(s, pi, color) {
    const b = s.players[pi].boost;
    return b && b.colors.indexOf(color) >= 0 ? b.mult : 1;
  }

  function fullColors(s, pi) {
    const out = [];
    for (const set of s.players[pi].sets) if (isFull(set) && out.indexOf(set.color) < 0) out.push(set.color);
    return out;
  }

  // 能拿来付款的桌面牌：银行 + 有面值的地产 +（开关允许时）房屋 / 旅馆
  function payableItems(s, pi) {
    const p = s.players[pi];
    const items = p.bank.slice();
    const withBuildings = s.rules.payWithBuildings;
    for (const set of p.sets) {
      for (const id of set.cards) if (CARDS[id].value > 0) items.push(id);
      if (withBuildings) {
        if (set.house != null) items.push(set.house);
        if (set.hotel != null) items.push(set.hotel);
      }
    }
    if (withBuildings) for (const id of p.loose) items.push(id);
    return items;
  }

  // 本回合最多出几张（背水一战时多 1 张）
  const playsMax = (s) => s.rules.playsPerTurn + (s.turn.bonus || 0);

  function canJSN(s, pi) {
    if (!s.players[pi].hand.some((id) => isAct(id, 'justSayNo'))) return false;
    return !(s.rules.jsnCountsAsPlay && pi === s.turn.player && s.turn.plays >= playsMax(s));
  }

  function canBuild(set, kind) {
    if (!COLORS[set.color].buildable || !isFull(set)) return false;
    return kind === 'house' ? set.house == null : set.house != null && set.hotel == null;
  }

  function checkBuild(set, kind) {
    if (!COLORS[set.color].buildable) fail('NOT_BUILDABLE');
    if (!isFull(set)) fail('NOT_FULL_SET');
    if (kind === 'house') {
      if (set.house != null) fail('HAS_HOUSE');
      return;
    }
    if (set.house == null) fail('NEEDS_HOUSE');
    if (set.hotel != null) fail('HAS_HOTEL');
  }

  function stealable(s, pi) {
    const out = [];
    for (const set of s.players[pi].sets) if (!isFull(set)) out.push(...set.cards);
    return out;
  }

  function giveable(s, pi) {
    const out = [];
    for (const set of s.players[pi].sets) if (s.rules.forcedDealFromOwnFullSet || !isFull(set)) out.push(...set.cards);
    return out;
  }

  function openSetIds(p, color, exceptId) {
    return p.sets.filter((x) => x.color === color && !isFull(x) && x.id !== exceptId).map((x) => x.id);
  }

  // 给某色加 1 张能否凑满一组
  function wouldComplete(s, pi, color) {
    const need = sizeOf(color) - 1;
    return s.players[pi].sets.some((x) => x.color === color && x.cards.length === need);
  }

  // 给某色加 1 张后，完整套有几种颜色
  function fullCountWith(s, pi, color) {
    const full = fullColors(s, pi);
    return full.indexOf(color) >= 0 || !wouldComplete(s, pi, color) ? full.length : full.length + 1;
  }

  function fillOf(s, pi, color) {
    let f = 0;
    for (const x of s.players[pi].sets) if (x.color === color && !isFull(x)) f = Math.max(f, x.cards.length);
    return f;
  }

  // 把地产放进 pi 的桌面：指定 setId 就放进那组；否则放进该颜色张数最多的未满组，没有就新开一组
  function placeCard(s, pi, id, color, setId) {
    const p = s.players[pi];
    if (setId != null) {
      const set = p.sets.find((x) => x.id === setId);
      if (!set) fail('NO_SUCH_SET');
      if (set.color !== color) fail('SET_COLOR_MISMATCH');
      if (isFull(set)) fail('SET_FULL');
      set.cards.push(id);
      return set.id;
    }
    let best = null;
    for (const set of p.sets) {
      if (set.color === color && !isFull(set) && (!best || set.cards.length > best.cards.length)) best = set;
    }
    if (best) {
      best.cards.push(id);
      return best.id;
    }
    const set = { id: s.nextSetId++, color, cards: [id], house: null, hotel: null };
    p.sets.push(set);
    return set.id;
  }

  // 从 pi 的桌面（银行 / 地产组 / 散落建筑）取下一张牌；地产返回它原来所在组的颜色，其它返回 null
  function detach(s, pi, id) {
    const p = s.players[pi];
    let i = p.bank.indexOf(id);
    if (i >= 0) { p.bank.splice(i, 1); return null; }
    i = p.loose.indexOf(id);
    if (i >= 0) { p.loose.splice(i, 1); return null; }
    for (let k = 0; k < p.sets.length; k++) {
      const set = p.sets[k];
      if (set.hotel === id) { set.hotel = null; return null; }
      if (set.house === id) {
        set.house = null;
        if (set.hotel != null) { p.loose.push(set.hotel); set.hotel = null; } // 旅馆必须压在房屋上
        return null;
      }
      const j = set.cards.indexOf(id);
      if (j >= 0) {
        set.cards.splice(j, 1);
        if (!set.cards.length) { // 整组空了：建筑留在地产区，成为散落建筑，之后可挪到别的完整套
          if (set.house != null) p.loose.push(set.house);
          if (set.hotel != null) p.loose.push(set.hotel);
          p.sets.splice(k, 1);
        }
        return set.color;
      }
    }
    return fail('NOT_ON_TABLE');
  }

  /* ═══════════════════════════ 开局与回合 ═══════════════════════════ */

  function cleanName(n, i) {
    const t = n == null ? '' : String(n).trim();
    return t ? t.slice(0, 32) : `玩家 ${i + 1}`;
  }

  function initState(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const rules = sanitizeRules(o.rules, typeof o.preset === 'string' ? o.preset : 'balanced');
    const seed = toSeed(o.seed);
    const names = Array.isArray(o.players) ? o.players : [];
    const s = {
      engine: VERSION,
      rules,
      seed,
      rng: seed,
      players: [0, 1].map((i) => ({ name: cleanName(names[i], i), hand: [], bank: [], sets: [], loose: [], stats: newStats(), boost: null, awards: [] })),
      deck: [],
      discard: [],
      turn: { player: 0, number: 0, plays: 0 },
      phase: 'play',
      pending: null,
      discardNeed: 0,
      result: null,
      stake: 1,       // 这局的分值（加注会翻倍）
      cube: null,     // 加注权：null = 双方都能加，0 / 1 = 只有这一方能加（上次跟注的人）
      pot: 0,         // 奖池里攒了几张
      idleTurns: 0,
      nextSetId: 1,
      nextPendingId: 1,
      seq: 0,
      log: [],
    };
    s.deck = shuffle(s, CARDS.map((c) => c.id));
    const first = isPlayer(o.firstPlayer) ? o.firstPlayer : rand(s) < 0.5 ? 0 : 1;
    const ev = [];
    emit(s, ev, { type: 'gameStart', first, seed });
    for (const pi of [first, other(first)]) {
      const ids = [];
      for (let k = 0; k < rules.startingHand && s.deck.length; k++) ids.push(s.deck.pop());
      s.players[pi].hand.push(...ids);
      emit(s, ev, { type: 'deal', player: pi, count: ids.length, cardIds: ids });
    }
    startTurn(s, first, ev);
    appendLog(s, ev);
    return s;
  }

  function startTurn(s, pi, ev) {
    s.turn = Object.assign({ player: pi, number: s.turn.number + 1, plays: 0, bonus: 0, gambled: false, lapsed: 0 }, turnBase(s, pi));
    s.phase = 'play';
    s.pending = null;
    s.discardNeed = 0;
    emit(s, ev, { type: 'turnStart', player: pi, turn: s.turn.number });
    // 在对手回合里被动凑齐 3 套的玩家（比如被强买强卖送了一张），要等到自己回合开始才算赢
    if (fullColors(s, pi).length >= s.rules.setsToWin) return endGame(s, ev, pi, 'sets');
    if (s.rules.maxTurns > 0 && s.turn.number > s.rules.maxTurns) return endGame(s, ev, null, 'maxTurns');
    const hand = s.players[pi].hand;
    let n = !hand.length ? s.rules.drawWhenEmpty : s.turn.number === 1 ? s.rules.firstTurnDraw : s.rules.drawPerTurn;
    if (s.rules.comeback) {
      // 两个追赶机制都只帮落后的一方，双方规则完全对称；领先方照样可以一回合直接赢。
      // 满足条件也只按 comebackChance 的几率触发（各自掷一次），偶尔出现的翻盘机会，不会变成稳定的"落后奖励"
      const mine = fullColors(s, pi).length;
      const theirs = fullColors(s, other(pi)).length;
      const lucky = () => rand(s) * 100 < s.rules.comebackChance;
      if (theirs === s.rules.setsToWin - 1 && mine < theirs && lucky()) {
        s.turn.bonus = 1;
        emit(s, ev, { type: 'comeback', player: pi, kind: 'lastStand', plays: playsMax(s) });
      }
      if (theirs - mine >= 2 && n > 0 && lucky()) {
        n += 1;
        emit(s, ev, { type: 'comeback', player: pi, kind: 'catchUp', extra: 1 });
      }
    }
    drawCards(s, pi, n, ev);
    if (s.rules.stalemateTurns > 0 && !s.deck.length && !s.discard.length && !s.players[0].hand.length && !s.players[1].hand.length) {
      endGame(s, ev, null, 'stalemate'); // 牌全在桌面上，再也不会有牌动了
    }
  }

  function endGame(s, ev, winner, reason) {
    s.phase = 'gameOver';
    s.pending = null;
    s.discardNeed = 0;
    s.result = { winner, reason, turn: s.turn.number, stake: s.stake || 1 };
    emit(s, ev, { type: 'gameOver', winner, reason, stake: s.stake || 1 });
  }

  // 当前玩家在自己回合内凑齐即刻获胜
  function checkWin(s, ev) {
    if (s.phase !== 'gameOver' && fullColors(s, s.turn.player).length >= s.rules.setsToWin) endGame(s, ev, s.turn.player, 'sets');
  }

  function drawCards(s, pi, n, ev) {
    if (n <= 0) return;
    const got = [];
    while (got.length < n) {
      if (!s.deck.length) {
        if (!s.discard.length) break;
        s.deck = shuffle(s, s.discard);
        s.discard = [];
        emit(s, ev, { type: 'reshuffle', count: s.deck.length });
      }
      got.push(s.deck.pop());
    }
    s.players[pi].hand.push(...got);
    emit(s, ev, { type: 'draw', player: pi, count: got.length, cardIds: got });
  }

  /* ═══════════════════════════ 动作处理 ═══════════════════════════ */

  // 无原型对象：'constructor'、'__proto__' 之类的 type 不会误命中
  const HANDLERS = Object.freeze(Object.assign(Object.create(null), {
    PLAY_BANK: playBank,
    PLAY_PROPERTY: playProperty,
    PLAY_ACTION: playAction,
    MOVE_CARD: moveCard,
    MOVE_BUILDING: moveBuilding,
    END_TURN: endTurn,
    DISCARD: discardCards,
    JUST_SAY_NO: justSayNo,
    ACCEPT: accept,
    PAY: pay,
    RESIGN: resign,
    RAISE: raise,
    FOLD: fold,
    TIMEOUT_PLAY: timeoutPlay,
  }));

  function reduce(s, a, ev) {
    if (!a || typeof a !== 'object' || typeof a.type !== 'string') fail('BAD_ACTION');
    const fn = HANDLERS[a.type];
    if (typeof fn !== 'function') fail('UNKNOWN_ACTION');
    if (!isPlayer(a.player)) fail('BAD_PLAYER');
    if (s.phase === 'gameOver') fail('GAME_OVER');
    fn(s, a.player, a, ev);
    autoEndTurn(s, ev);
    checkAwards(s, ev);
  }

  function propCount(s, pi) { let n = 0; for (const set of s.players[pi].sets) n += set.cards.length; return n; }

  // 成就只在一个回合之内计数：回合开始时记下对方的地产张数、对方银行张数、自己的银行金额，这回合的战果从 0 算起。
  // 伤害都发生在回合方的对手身上（被收钱、被偷的永远是另一方），所以只看回合方
  function turnBase(s, pi) {
    const o = other(pi);
    return { dealt: 0, stolen: 0, oppProps: propCount(s, o), oppBank: s.players[o].bank.length, myBank: sum(s.players[pi].bank) };
  }
  // 拿走 / 毁掉对方多少面值：整局统计照记，回合方的另记进这一回合
  function addDealt(s, pi, v, stole) {
    const st = s.players[pi].stats;
    st.dealt += v;
    if (stole) st.setsStolen++;
    if (pi !== s.turn.player) return;
    s.turn.dealt = (s.turn.dealt || 0) + v;
    if (stole) s.turn.stolen = (s.turn.stolen || 0) + 1;
  }

  // 成就：每局每人每项一次，只是荣誉。每个动作之后、以及回合交接之前各看一次（回合最后一步达成的也不漏）
  function checkAwards(s, ev) {
    const t = s.turn;
    const pi = t.player;
    const o = other(pi);
    if ((t.dealt || 0) > 10 || (t.stolen || 0) >= 1) award(s, ev, pi, 'thief');
    if (t.oppProps > 0 && propCount(s, o) === 0) award(s, ev, pi, 'destroyer');
    if (t.oppBank > 0 && !s.players[o].bank.length) award(s, ev, pi, 'vault');
    if (t.myBank <= 30 && sum(s.players[pi].bank) > 30) award(s, ev, pi, 'vault');
  }

  function award(s, ev, pi, key) {
    const list = s.players[pi].awards;
    if (list.indexOf(key) >= 0) return;
    list.push(key);
    emit(s, ev, { type: 'award', player: pi, award: key });
  }

  // 大乐透：奖金 lotteryMin–lotteryMax 随机，从弃牌堆和抽牌堆里的钱币凑，不超过这个数。
  // 每次在面值不超过剩余金额的钱里随机挑一张，面值越大越容易被挑中：张数少，组合又每次不一样
  function lottery(s, pi, ev, pity) {
    const lo = Math.min(s.rules.lotteryMin, s.rules.lotteryMax);
    const hi = Math.max(s.rules.lotteryMin, s.rules.lotteryMax);
    const target = lo + Math.floor(rand(s) * (hi - lo + 1));
    const pool = s.discard.concat(s.deck).filter((id) => CARDS[id].type === 'money');
    const got = [];
    let left = target;
    for (;;) {
      const fit = pool.filter((id) => valueOf(id) <= left && got.indexOf(id) < 0);
      if (!fit.length) break;
      let r = rand(s) * sum(fit);
      let pick = fit[fit.length - 1];
      for (const id of fit) { r -= valueOf(id); if (r < 0) { pick = id; break; } }
      got.push(pick);
      left -= valueOf(pick);
      if (!left) break;
    }
    if (!got.length) return false;
    for (const id of got) {
      const from = s.discard.indexOf(id) >= 0 ? s.discard : s.deck;
      from.splice(from.indexOf(id), 1);
    }
    s.players[pi].bank.push(...got);
    const amount = sum(got);
    s.players[pi].stats.lottery += amount;
    emit(s, ev, { type: 'lottery', player: pi, target, amount, cardIds: got.slice(), pity: !!pity });
    return true;
  }

  // 出满次数、也没有待回应的行动了：自动结束回合（手牌超限会先进入弃牌阶段）
  function autoEndTurn(s, ev) {
    if (!s.rules.autoEndTurn || s.phase !== 'play' || s.turn.plays < playsMax(s)) return;
    emit(s, ev, { type: 'autoEndTurn', player: s.turn.player, plays: s.turn.plays, lapsed: s.turn.lapsed || 0 });
    endTurn(s, s.turn.player, null, ev);
  }

  // 出牌超时：作废 1 次出牌机会。只由服务器在单张出牌时限到点时发出（客户端发来的会被服务拒绝）；
  // 次数用完照常走自动结束回合，所以 3 次都超时就是 3 × 时限后结束回合
  function timeoutPlay(s, pi, a, ev) {
    requireMain(s, pi);
    s.turn.plays++;
    s.turn.lapsed = (s.turn.lapsed || 0) + 1;
    emit(s, ev, { type: 'playLapsed', player: pi, plays: s.turn.plays, max: playsMax(s) });
    if (!s.rules.autoEndTurn && s.turn.plays >= playsMax(s)) endTurn(s, pi, null, ev); // 没开自动结束回合时也不能让人一直耗着
  }

  function requireMain(s, pi) {
    if (s.turn.player !== pi) fail('NOT_YOUR_TURN');
    if (s.phase === 'respond') fail('PENDING');
    if (s.phase !== 'play') fail('WRONG_PHASE');
  }

  function requirePlays(s, n) {
    if (s.turn.plays + n > playsMax(s)) fail('NO_PLAYS_LEFT');
  }

  function requireHand(s, pi, id) {
    if (!isCardId(id) || s.players[pi].hand.indexOf(id) < 0) fail('NOT_IN_HAND');
  }

  function requireIdList(list) {
    if (!Array.isArray(list) || list.length > N_CARDS) fail('BAD_ACTION');
    if (new Set(list).size !== list.length) fail('DUPLICATE');
    return list;
  }

  function fromHand(s, pi, id) {
    const h = s.players[pi].hand;
    const i = h.indexOf(id);
    if (i < 0) fail('NOT_IN_HAND');
    h.splice(i, 1);
  }

  function spend(s, pi, id) {
    fromHand(s, pi, id);
    s.discard.push(id);
    s.players[pi].stats.cardsPlayed++;
  }

  function playBank(s, pi, a, ev) {
    requireMain(s, pi);
    requireHand(s, pi, a.cardId);
    requirePlays(s, 1);
    if (isProp(a.cardId)) fail('CANNOT_BANK');
    fromHand(s, pi, a.cardId);
    s.players[pi].bank.push(a.cardId);
    s.players[pi].stats.cardsPlayed++;
    s.turn.plays++;
    emit(s, ev, { type: 'bank', player: pi, cardId: a.cardId, value: valueOf(a.cardId) });
  }

  function playProperty(s, pi, a, ev) {
    requireMain(s, pi);
    requireHand(s, pi, a.cardId);
    requirePlays(s, 1);
    if (!isProp(a.cardId)) fail('NOT_PROPERTY');
    const color = pickColor(s, pi, a.cardId, a.color, a.setId);
    fromHand(s, pi, a.cardId);
    const setId = placeCard(s, pi, a.cardId, color, a.setId);
    s.players[pi].stats.cardsPlayed++;
    s.turn.plays++;
    emit(s, ev, { type: 'property', player: pi, cardId: a.cardId, color, setId });
    checkWin(s, ev);
  }

  // 颜色优先级：显式 color > 目标组的颜色 > 自动挑
  function pickColor(s, pi, id, color, setId) {
    const cols = colorsOf(id);
    if (color == null && setId != null) {
      const set = s.players[pi].sets.find((x) => x.id === setId);
      if (!set) fail('NO_SUCH_SET');
      color = set.color;
    }
    if (color == null) return cols.length === 1 ? cols[0] : bestColor(s, pi, id);
    if (cols.indexOf(color) < 0) fail('BAD_COLOR');
    return color;
  }

  // 给多功能地产挑颜色：能凑满的优先，其次进度最高的，都没有就挑小套
  function bestColor(s, pi, id) {
    const p = s.players[pi];
    let best = null;
    let bestScore = -Infinity;
    for (const color of colorsOf(id)) {
      const size = sizeOf(color);
      let fill = 0;
      let owned = false;
      for (const set of p.sets) {
        if (set.color !== color) continue;
        if (isFull(set)) owned = true;
        else fill = Math.max(fill, set.cards.length);
      }
      let score = fill * 10 + (fill === size - 1 ? 100 : 0) + COLORS[color].rent[size - 1] / 10;
      if (fill === 0) score -= size + (owned ? 30 : 0);
      if (score > bestScore) { bestScore = score; best = color; }
    }
    return best;
  }

  // 赌一把：先查押注是否合法（出牌前），出牌后再掷骰子
  function checkBet(s, a) {
    if (a.bet == null) return;
    if (!s.rules.gamble) fail('NO_GAMBLE');
    if (BETS.indexOf(a.bet) < 0) fail('BAD_BET');
    if (s.turn.gambled) fail('ALREADY_GAMBLED');
  }

  // 押 ×m 赢的几率正好 1/m：赢了这次收 m 倍，输了返回 0（牌已经打出去作废）。期望不变，用对局自己的随机数
  function rollBet(s, pi, a, ev, amount, doubles) {
    if (a.bet == null) return amount;
    s.turn.gambled = true;
    const won = rand(s) * a.bet < 1;
    const st = s.players[pi].stats;
    st.bets++;
    if (won) st.betsWon++;
    // 奖池：赌输的每一把往里放 1 张，押 ×4 赌赢的人全部摸走
    let jackpot = 0;
    if (s.rules.jackpot) {
      if (!won) s.pot = Math.min(s.rules.potMax, s.pot + 1);
      else if (a.bet >= 4 && s.pot > 0) { jackpot = s.pot; s.pot = 0; }
    }
    emit(s, ev, { type: 'gamble', player: pi, cardId: a.cardId, doubles: (doubles || []).slice(), action: CARDS[a.cardId].type === 'rent' ? 'rent' : CARDS[a.cardId].action, mult: a.bet, won, base: amount, amount: won ? amount * a.bet : 0, pot: s.pot, jackpot });
    if (jackpot) {
      emit(s, ev, { type: 'jackpot', player: pi, count: jackpot });
      drawCards(s, pi, jackpot, ev);
    }
    return won ? amount * a.bet : 0;
  }

  function playAction(s, pi, a, ev) {
    requireMain(s, pi);
    requireHand(s, pi, a.cardId);
    const c = CARDS[a.cardId];
    if (c.type === 'rent') return playRent(s, pi, a, ev);
    if (c.type !== 'action') fail('NOT_ACTION');
    if (a.bet != null && c.action !== 'debtCollector' && c.action !== 'birthday') fail('BET_NOT_ALLOWED');
    const me = s.players[pi];
    const op = s.players[other(pi)];
    switch (c.action) {
      case 'justSayNo':
        return fail('JSN_RESPONSE_ONLY');
      case 'doubleRent':
        return fail('DOUBLE_NEEDS_RENT');
      case 'passGo':
        requirePlays(s, 1);
        spend(s, pi, a.cardId);
        s.turn.plays++;
        emit(s, ev, { type: 'actionPlayed', player: pi, cardId: a.cardId, action: 'passGo' });
        return drawCards(s, pi, 2, ev);
      case 'house':
      case 'hotel': {
        requirePlays(s, 1);
        let set;
        if (a.setId != null) {
          set = me.sets.find((x) => x.id === a.setId);
          if (!set) fail('NO_SUCH_SET');
          checkBuild(set, c.action);
        } else {
          for (const x of me.sets) if (canBuild(x, c.action) && (!set || setRent(s, x) > setRent(s, set))) set = x;
          if (!set) fail('NO_BUILD_TARGET');
        }
        fromHand(s, pi, a.cardId);
        set[c.action] = a.cardId;
        me.stats.cardsPlayed++;
        s.turn.plays++;
        return emit(s, ev, { type: 'building', player: pi, cardId: a.cardId, building: c.action, setId: set.id, color: set.color });
      }
      case 'debtCollector':
      case 'birthday': {
        requirePlays(s, 1);
        checkBet(s, a);
        spend(s, pi, a.cardId);
        s.turn.plays++;
        const amount = rollBet(s, pi, a, ev, c.action === 'birthday' ? 2 : 5);
        if (!amount) return undefined;
        return openPending(s, ev, { action: c.action, cardId: a.cardId, amount, bet: a.bet || 1 });
      }
      case 'slyDeal': {
        requirePlays(s, 1);
        const set = isCardId(a.targetCardId) ? findSetOf(op, a.targetCardId) : null;
        if (!set) fail('BAD_TARGET');
        if (isFull(set)) fail('TARGET_IN_FULL_SET');
        spend(s, pi, a.cardId);
        s.turn.plays++;
        return openPending(s, ev, { action: 'slyDeal', cardId: a.cardId, targetCardId: a.targetCardId, color: set.color });
      }
      case 'forcedDeal': {
        requirePlays(s, 1);
        const mine = isCardId(a.giveCardId) ? findSetOf(me, a.giveCardId) : null;
        if (!mine) fail('BAD_GIVE');
        if (!s.rules.forcedDealFromOwnFullSet && isFull(mine)) fail('GIVE_IN_FULL_SET');
        const theirs = isCardId(a.targetCardId) ? findSetOf(op, a.targetCardId) : null;
        if (!theirs) fail('BAD_TARGET');
        if (isFull(theirs)) fail('TARGET_IN_FULL_SET');
        spend(s, pi, a.cardId);
        s.turn.plays++;
        return openPending(s, ev, { action: 'forcedDeal', cardId: a.cardId, giveCardId: a.giveCardId, targetCardId: a.targetCardId, color: theirs.color });
      }
      case 'dealBreaker': {
        requirePlays(s, 1);
        const set = op.sets.find((x) => x.id === a.targetSetId);
        if (!set) fail('BAD_TARGET');
        if (!isFull(set)) fail('NOT_FULL_SET');
        spend(s, pi, a.cardId);
        s.turn.plays++;
        return openPending(s, ev, { action: 'dealBreaker', cardId: a.cardId, targetSetId: set.id, color: set.color });
      }
      case 'bankruptcy':
        requirePlays(s, 1);
        if (!op.bank.length) fail('EMPTY_BANK');
        spend(s, pi, a.cardId);
        s.turn.plays++;
        return openPending(s, ev, { action: 'bankruptcy', cardId: a.cardId, amount: sum(op.bank) });
      case 'liquidation': {
        requirePlays(s, 1);
        const set = op.sets.find((x) => x.id === a.targetSetId);
        if (!set) fail('BAD_TARGET');
        if (!isFull(set)) fail('NOT_FULL_SET');
        spend(s, pi, a.cardId);
        s.turn.plays++;
        return openPending(s, ev, { action: 'liquidation', cardId: a.cardId, targetSetId: set.id, color: set.color });
      }
      case 'hugeWin':
        requirePlays(s, 1);
        if (!op.sets.length && !fullColors(s, pi).length) fail('NO_EFFECT');
        spend(s, pi, a.cardId);
        s.turn.plays++;
        return openPending(s, ev, { action: 'hugeWin', cardId: a.cardId });
      default:
        return fail('NOT_ACTION');
    }
  }

  function playRent(s, pi, a, ev) {
    const c = CARDS[a.cardId];
    const doubles = a.doubles == null ? [] : requireIdList(a.doubles);
    for (const id of doubles) {
      requireHand(s, pi, id);
      if (!isAct(id, 'doubleRent')) fail('BAD_DOUBLE');
    }
    if (doubles.length > s.rules.maxDoubleRent) fail('TOO_MANY_DOUBLES');
    if (c.any && doubles.length && !s.rules.doubleRentWithWildRent) fail('DOUBLE_NOT_WITH_WILD_RENT');
    requirePlays(s, 1 + doubles.length);
    let color = a.color;
    if (color == null) { // 省略颜色：自动取租金最高的那个
      let top = 0;
      for (const col of c.colors) {
        const r = rentFor(s, pi, col);
        if (r > top) { top = r; color = col; }
      }
      if (color == null) fail('NO_RENT_COLOR');
    }
    if (c.colors.indexOf(color) < 0) fail('BAD_COLOR');
    const base = rentFor(s, pi, color);
    if (base <= 0) fail('NO_RENT_COLOR');
    const boost = boostFor(s, pi, color);
    checkBet(s, a);
    spend(s, pi, a.cardId);
    for (const id of doubles) spend(s, pi, id);
    s.turn.plays += 1 + doubles.length;
    s.players[pi].boost = null; // Huge Win 加成只管下一次收租：这次用掉（选的颜色不在加成里也一样作废）
    const amount = rollBet(s, pi, a, ev, base * Math.pow(2, doubles.length) * boost, doubles);
    if (!amount) return undefined; // 赌输了：牌作废，不用对方回应
    return openPending(s, ev, { action: 'rent', cardId: a.cardId, doubles: doubles.slice(), color, base, boost, amount, wild: !!c.any, bet: a.bet || 1 });
  }

  /* ─────────── 待回应行动（收钱 / 偷 / 换 / 抢）与「反对行动」链 ───────────
   * chain 为偶数长度时轮到被针对方（target）：可以反对行动、接受或付款；
   * 奇数长度时轮到发起方（actor）：可以再反对行动，或接受（行动作废）。 */

  function openPending(s, ev, init) {
    const actor = s.turn.player;
    const pd = Object.assign({
      id: s.nextPendingId++,
      action: null,
      actor,
      target: other(actor),
      cardId: null,
      amount: 0,
      base: 0,
      color: null,
      doubles: [],
      wild: false,
      targetCardId: null,
      giveCardId: null,
      targetSetId: null,
      chain: [],
      awaiting: other(actor),
    }, init);
    s.pending = pd;
    s.phase = 'respond';
    const e = { type: 'actionPlayed', player: actor, cardId: pd.cardId, action: pd.action, pendingId: pd.id, target: pd.target };
    if (isPaymentKind(pd.action)) { e.amount = pd.amount; if (pd.bet > 1) e.bet = pd.bet; }
    if (pd.action === 'rent') Object.assign(e, { color: pd.color, base: pd.base, doubles: pd.doubles.slice(), wild: pd.wild, boost: pd.boost || 1 });
    else if (pd.action === 'bankruptcy') e.amount = pd.amount;
    else if (pd.action === 'liquidation') Object.assign(e, { targetSetId: pd.targetSetId, color: pd.color });
    else if (pd.action === 'slyDeal') Object.assign(e, { targetCardId: pd.targetCardId, color: pd.color });
    else if (pd.action === 'forcedDeal') Object.assign(e, { giveCardId: pd.giveCardId, targetCardId: pd.targetCardId });
    else if (pd.action === 'dealBreaker') Object.assign(e, { targetSetId: pd.targetSetId, color: pd.color });
    emit(s, ev, e);
    settle(s, ev);
  }

  // 推进待回应行动：能自动结算就结算，否则发出 awaiting 等人操作
  function settle(s, ev) {
    const pd = s.pending;
    if (!pd) return;
    const who = pd.awaiting;
    if (s.rules.autoResolve && !canJSN(s, who)) {
      if (pd.chain.length % 2 === 1) return cancelPending(s, ev);      // 发起方没有「反对行动」可反制 → 行动作废
      if (!isPaymentKind(pd.action)) return resolvePending(s, ev);     // 被偷 / 换 / 抢的一方没有「反对行动」→ 直接生效
      const items = payableItems(s, who);
      if (sum(items) <= pd.amount) return payWith(s, ev, items, true); // 桌面不够或刚好够 → 只能全付
    }
    emit(s, ev, { type: 'awaiting', pendingId: pd.id, player: who, role: pd.chain.length % 2 ? 'actor' : 'target', action: pd.action });
  }

  function requireAwaiting(s, pi) {
    if (s.phase !== 'respond' || !s.pending) fail('WRONG_PHASE');
    if (s.pending.awaiting !== pi) fail('NOT_YOUR_RESPONSE');
    return s.pending;
  }

  function justSayNo(s, pi, a, ev) {
    const pd = requireAwaiting(s, pi);
    requireHand(s, pi, a.cardId);
    if (!isAct(a.cardId, 'justSayNo')) fail('NOT_JSN');
    if (pd.action === 'raise') fail('JSN_NOT_FOR_RAISE');
    const counts = s.rules.jsnCountsAsPlay && pi === s.turn.player;
    if (counts) requirePlays(s, 1);
    fromHand(s, pi, a.cardId);
    s.discard.push(a.cardId);
    s.players[pi].stats.justSayNo++;
    if (counts) s.turn.plays++;
    pd.chain.push({ player: pi, cardId: a.cardId });
    pd.awaiting = other(pi);
    emit(s, ev, { type: 'justSayNo', player: pi, cardId: a.cardId, pendingId: pd.id, depth: pd.chain.length, blocked: pd.chain.length % 2 === 1 });
    settle(s, ev);
  }

  function accept(s, pi, a, ev) {
    const pd = requireAwaiting(s, pi);
    if (pd.chain.length % 2 === 1) return cancelPending(s, ev);
    if (isPaymentKind(pd.action)) fail('MUST_PAY');
    resolvePending(s, ev);
  }

  function pay(s, pi, a, ev) {
    const pd = requireAwaiting(s, pi);
    if (pd.chain.length % 2 === 1 || !isPaymentKind(pd.action)) fail('NOT_PAYMENT');
    const ids = requireIdList(a.cardIds);
    const items = payableItems(s, pi);
    for (const id of ids) if (items.indexOf(id) < 0) fail('NOT_PAYABLE');
    if (sum(items) <= pd.amount) {
      if (ids.length !== items.length) fail('PAY_ALL_REQUIRED');
    } else if (sum(ids) < pd.amount) {
      fail('PAY_NOT_ENOUGH');
    }
    payWith(s, ev, ids, false);
  }

  // 付款：地产进收款方地产区（保持原颜色），钱 / 行动卡 / 建筑进收款方银行；不找零
  function payWith(s, ev, ids, auto) {
    const pd = s.pending;
    const from = pd.target;
    const to = pd.actor;
    const placements = [];
    for (const id of ids) {
      const color = detach(s, from, id);
      if (isProp(id)) {
        placements.push({ cardId: id, to: 'set', color, setId: placeCard(s, to, id, color) });
      } else {
        s.players[to].bank.push(id);
        placements.push({ cardId: id, to: 'bank' });
      }
    }
    const paid = sum(ids);
    s.players[from].stats.paid += paid;
    const st = s.players[to].stats;
    st.received += paid;
    addDealt(s, to, paid);
    st.biggestHit = Math.max(st.biggestHit, paid);
    emit(s, ev, { type: 'payment', pendingId: pd.id, action: pd.action, from, to, amount: pd.amount, paid, cardIds: ids.slice(), placements, auto: !!auto });
    // 大乐透：收租结算时按几率额外中奖（对方付不出钱也照样可能中）；同一个人连续 lotteryPity 次没中，这一次保底必中。
    // 保底时牌堆和弃牌堆里一张钱都凑不出来就不算中，计数留着，下次收租接着保底
    if (pd.action === 'rent' && s.rules.lottery) {
      const ls = s.players[to].stats;
      const hit = rand(s) * 100 < s.rules.lotteryChance;
      const pity = !hit && s.rules.lotteryPity > 0 && ls.lottoMiss + 1 >= s.rules.lotteryPity;
      ls.lottoMiss = (hit || pity) && lottery(s, to, ev, pity) ? 0 : ls.lottoMiss + 1;
    }
    finishPending(s, ev);
  }

  function resolvePending(s, ev) {
    const pd = s.pending;
    const A = pd.actor;
    const T = pd.target;
    if (pd.action === 'slyDeal') {
      const color = detach(s, T, pd.targetCardId);
      const setId = placeCard(s, A, pd.targetCardId, color);
      s.players[A].stats.steals++;
      addDealt(s, A, valueOf(pd.targetCardId));
      emit(s, ev, { type: 'steal', pendingId: pd.id, from: T, to: A, cardId: pd.targetCardId, color, setId });
    } else if (pd.action === 'forcedDeal') {
      const giveColor = detach(s, A, pd.giveCardId);
      const takeColor = detach(s, T, pd.targetCardId);
      const gaveSetId = placeCard(s, T, pd.giveCardId, giveColor);
      const tookSetId = placeCard(s, A, pd.targetCardId, takeColor);
      s.players[A].stats.steals++;
      addDealt(s, A, valueOf(pd.targetCardId));
      emit(s, ev, { type: 'swap', pendingId: pd.id, actor: A, target: T, gave: pd.giveCardId, took: pd.targetCardId, gaveColor: giveColor, tookColor: takeColor, gaveSetId, tookSetId });
    } else if (pd.action === 'dealBreaker') {
      const tp = s.players[T];
      const idx = tp.sets.findIndex((x) => x.id === pd.targetSetId);
      if (idx < 0) fail('BAD_TARGET');
      const set = tp.sets.splice(idx, 1)[0];
      s.players[A].sets.push(set);
      addDealt(s, A, sum(set.cards.concat(set.house != null ? [set.house] : [], set.hotel != null ? [set.hotel] : [])), true);
      emit(s, ev, { type: 'setStolen', pendingId: pd.id, from: T, to: A, setId: set.id, color: set.color, cardIds: set.cards.slice(), house: set.house, hotel: set.hotel });
    } else if (pd.action === 'bankruptcy') {
      const ids = s.players[T].bank.splice(0);
      s.players[A].bank.push(...ids);
      const got = sum(ids);
      s.players[T].stats.paid += got;
      const st = s.players[A].stats;
      st.received += got;
      addDealt(s, A, got);
      st.biggestHit = Math.max(st.biggestHit, got);
      emit(s, ev, { type: 'bankrupt', pendingId: pd.id, from: T, to: A, cardIds: ids, amount: got });
    } else if (pd.action === 'liquidation') {
      const tp = s.players[T];
      const idx = tp.sets.findIndex((x) => x.id === pd.targetSetId);
      if (idx < 0) fail('BAD_TARGET');
      const set = tp.sets.splice(idx, 1)[0];
      const gone = set.cards.concat(set.house != null ? [set.house] : [], set.hotel != null ? [set.hotel] : []);
      const hand = tp.hand.splice(0); // 弃到弃牌堆，牌面公开，不用脱敏
      s.discard.push(...gone, ...hand);
      addDealt(s, A, sum(gone));
      emit(s, ev, { type: 'liquidated', pendingId: pd.id, from: T, by: A, setId: set.id, color: set.color, cardIds: gone, handIds: hand, handCount: hand.length });
    } else if (pd.action === 'raise') {
      s.stake = pd.stake;
      s.cube = T; // 跟注的一方拿到加注权
      emit(s, ev, { type: 'raiseTaken', pendingId: pd.id, player: T, stake: s.stake });
    } else if (pd.action === 'hugeWin') {
      const tp = s.players[T];
      const gone = [];
      for (const set of tp.sets) {
        gone.push(...set.cards);
        if (set.house != null) gone.push(set.house);
        if (set.hotel != null) gone.push(set.hotel);
      }
      tp.sets = []; // 散落建筑不是地产，留着
      s.discard.push(...gone);
      addDealt(s, A, sum(gone));
      const colors = fullColors(s, A);
      s.players[A].boost = colors.length ? { mult: BOOST_MULT, colors } : null; // 再打一张会覆盖上一张的加成
      emit(s, ev, { type: 'hugeWin', pendingId: pd.id, from: T, by: A, cardIds: gone, boostColors: colors, mult: BOOST_MULT });
    }
    finishPending(s, ev);
  }

  function cancelPending(s, ev) {
    const pd = s.pending;
    emit(s, ev, { type: 'canceled', pendingId: pd.id, action: pd.action, actor: pd.actor, target: pd.target });
    finishPending(s, ev);
  }

  function finishPending(s, ev) {
    s.pending = null;
    s.phase = 'play';
    checkWin(s, ev);
  }

  /* ─────────── 整理桌面（不占出牌次数） ─────────── */

  function moveCard(s, pi, a, ev) {
    requireMain(s, pi);
    const p = s.players[pi];
    const from = isCardId(a.cardId) ? findSetOf(p, a.cardId) : null;
    if (!from) fail('NOT_ON_TABLE');
    let target = null;
    if (a.setId != null) {
      if (a.setId === from.id) fail('SAME_SET');
      target = p.sets.find((x) => x.id === a.setId);
      if (!target) fail('NO_SUCH_SET');
    }
    const color = a.color != null ? a.color : target ? target.color : from.color;
    if (colorsOf(a.cardId).indexOf(color) < 0) fail('BAD_COLOR');
    if (target) {
      if (target.color !== color) fail('SET_COLOR_MISMATCH');
      if (isFull(target)) fail('SET_FULL');
    } else if (color === from.color) {
      fail('SET_REQUIRED');
    }
    const fromSetId = from.id;
    detach(s, pi, a.cardId);
    const setId = placeCard(s, pi, a.cardId, color, a.setId);
    emit(s, ev, { type: 'move', player: pi, cardId: a.cardId, color, fromSetId, setId });
    checkWin(s, ev);
  }

  function moveBuilding(s, pi, a, ev) {
    requireMain(s, pi);
    if (!isCardId(a.cardId) || !isBuilding(a.cardId)) fail('NOT_BUILDING');
    const p = s.players[pi];
    const kind = CARDS[a.cardId].action;
    const looseAt = p.loose.indexOf(a.cardId);
    const src = looseAt >= 0 ? null : p.sets.find((x) => x[kind] === a.cardId);
    if (looseAt < 0 && !src) fail('NOT_ON_TABLE');
    const target = p.sets.find((x) => x.id === a.setId);
    if (!target) fail('NO_SUCH_SET');
    if (target === src) fail('SAME_SET');
    if (kind === 'house' && src && src.hotel != null) fail('HOTEL_ON_TOP');
    checkBuild(target, kind);
    if (src) src[kind] = null;
    else p.loose.splice(looseAt, 1);
    target[kind] = a.cardId;
    emit(s, ev, { type: 'buildingMoved', player: pi, cardId: a.cardId, building: kind, fromSetId: src ? src.id : null, setId: target.id, color: target.color });
  }

  /* ─────────── 加注（双陆棋的加倍方块）：自己回合开始时把这局分值翻倍，对方跟注或弃牌 ─────────── */

  const canRaise = (s, pi) => !!(s.rules.doubling && s.phase === 'play' && s.turn.player === pi && s.turn.plays === 0 && (s.cube == null || s.cube === pi) && s.stake * 2 <= s.rules.maxStake);

  function raise(s, pi, a, ev) {
    requireMain(s, pi);
    if (!s.rules.doubling) fail('NO_DOUBLING');
    if (s.turn.plays > 0) fail('RAISE_AT_START');
    if (s.cube != null && s.cube !== pi) fail('NOT_YOUR_CUBE');
    if (s.stake * 2 > s.rules.maxStake) fail('MAX_STAKE');
    const pd = { id: s.nextPendingId++, action: 'raise', actor: pi, target: other(pi), cardId: null, amount: 0, base: 0, color: null, doubles: [], wild: false, targetCardId: null, giveCardId: null, targetSetId: null, chain: [], awaiting: other(pi), stake: s.stake * 2 };
    s.pending = pd;
    s.phase = 'respond';
    emit(s, ev, { type: 'raiseOffered', pendingId: pd.id, player: pi, target: pd.target, stake: pd.stake, from: s.stake });
    emit(s, ev, { type: 'awaiting', pendingId: pd.id, player: pd.target, role: 'target', action: 'raise' });
  }

  // 弃牌：这局直接输，按加注前的分值算
  function fold(s, pi, a, ev) {
    const pd = requireAwaiting(s, pi);
    if (pd.action !== 'raise') fail('NOT_RAISE');
    emit(s, ev, { type: 'folded', pendingId: pd.id, player: pi, stake: s.stake });
    endGame(s, ev, pd.actor, 'fold');
  }

  /* ─────────── 认输（任何阶段、任何一方） ─────────── */

  function resign(s, pi, a, ev) {
    emit(s, ev, { type: 'resign', player: pi });
    endGame(s, ev, other(pi), 'resign');
  }

  /* ─────────── 回合结束 ─────────── */

  function endTurn(s, pi, a, ev) {
    requireMain(s, pi);
    const over = s.players[pi].hand.length - s.rules.handLimit;
    if (over > 0) {
      s.phase = 'discard';
      s.discardNeed = over;
      return emit(s, ev, { type: 'discardRequired', player: pi, count: over });
    }
    passTurn(s, ev);
  }

  function discardCards(s, pi, a, ev) {
    if (s.turn.player !== pi) fail('NOT_YOUR_TURN');
    if (s.phase !== 'discard') fail('WRONG_PHASE');
    const ids = requireIdList(a.cardIds);
    if (ids.length !== s.discardNeed) fail('DISCARD_COUNT');
    for (const id of ids) requireHand(s, pi, id);
    for (const id of ids) fromHand(s, pi, id);
    if (s.rules.discardTo === 'deckBottom') s.deck.unshift(...ids);
    else s.discard.push(...ids);
    s.discardNeed = 0;
    emit(s, ev, { type: 'discard', player: pi, count: ids.length, cardIds: ids.slice(), to: s.rules.discardTo });
    passTurn(s, ev);
  }

  function passTurn(s, ev) {
    const pi = s.turn.player;
    checkAwards(s, ev); // 这一回合的成就先结算，再换人重新计数
    emit(s, ev, { type: 'turnEnd', player: pi });
    // 牌堆和弃牌堆都空了还一张不出 → 记一个空转回合；空转太久判平局，防止双方攥着牌无限拖下去
    s.idleTurns = !s.deck.length && !s.discard.length && s.turn.plays - (s.turn.lapsed || 0) === 0 ? s.idleTurns + 1 : 0; // 超时作废的不算出过牌
    if (s.rules.stalemateTurns > 0 && s.idleTurns >= s.rules.stalemateTurns) return endGame(s, ev, null, 'stalemate');
    startTurn(s, other(pi), ev);
  }

  /* ═══════════════════════════ 视图与可选操作 ═══════════════════════════ */

  function activePlayer(s) {
    if (s.phase === 'gameOver') return null;
    return s.phase === 'respond' ? s.pending.awaiting : s.turn.player;
  }

  // 某个玩家的视角：只给自己手牌，对手只给张数；viewer 传 null 即观战视角
  function getView(s, viewer) {
    const r = s.rules;
    const v = isPlayer(viewer) ? viewer : null;
    return {
      engine: VERSION,
      viewer: v,
      seq: s.seq,
      phase: s.phase,
      activePlayer: activePlayer(s),
      turn: { player: s.turn.player, number: s.turn.number, plays: s.turn.plays, max: playsMax(s), bonus: s.turn.bonus || 0, gambled: !!s.turn.gambled, lapsed: s.turn.lapsed || 0, playsLeft: Math.max(0, playsMax(s) - s.turn.plays) },
      deckCount: s.deck.length,
      discardCount: s.discard.length,
      discardTop: s.discard.length ? s.discard[s.discard.length - 1] : null,
      discard: s.discard.slice(),
      players: s.players.map((p, i) => ({
        index: i,
        name: p.name,
        handCount: p.hand.length,
        hand: v === i ? p.hand.slice() : null,
        bank: p.bank.slice(),
        bankTotal: sum(p.bank),
        sets: p.sets.map((set) => ({
          id: set.id,
          color: set.color,
          cards: set.cards.slice(),
          house: set.house,
          hotel: set.hotel,
          size: sizeOf(set.color),
          full: isFull(set),
          rent: setRent(s, set),
        })),
        loose: p.loose.slice(),
        fullColors: fullColors(s, i),
        tableValue: sum(payableItems(s, i)),
        stats: Object.assign({}, p.stats),
        boost: p.boost ? { mult: p.boost.mult, colors: p.boost.colors.slice() } : null,
        awards: p.awards.slice(),
      })),
      pending: s.pending ? clonePending(s.pending) : null,
      discardNeed: s.phase === 'discard' ? s.discardNeed : 0,
      result: s.result ? Object.assign({}, s.result) : null,
      stake: s.stake,
      cube: s.cube,
      pot: s.pot,
      rules: r,
    };
  }

  // 结构化的"现在能做什么"，直接用来驱动 UI
  function getOptions(s, pi) {
    if (!isPlayer(pi)) return null;
    const me = s.players[pi];
    const main = s.phase === 'play' && s.turn.player === pi;
    const left = main ? playsMax(s) - s.turn.plays : 0;
    return {
      player: pi,
      phase: s.phase,
      yourTurn: s.turn.player === pi && s.phase !== 'gameOver',
      playsLeft: left,
      canEndTurn: main,
      canResign: s.phase !== 'gameOver',
      hand: me.hand.map((id) => ({ cardId: id, bank: left > 0 && !isProp(id), play: left > 0 ? playOption(s, pi, id, left) : null })),
      moves: main ? moveOptions(s, pi) : { cards: [], buildings: [] },
      raise: canRaise(s, pi) ? { stake: s.stake * 2, from: s.stake } : null,
      respond: s.phase === 'respond' && s.pending.awaiting === pi ? respondOptions(s, pi) : null,
      discard: s.phase === 'discard' && s.turn.player === pi ? { count: s.discardNeed } : null,
    };
  }

  const betsFor = (s) => (s.rules.gamble && !s.turn.gambled ? BETS.slice() : []);

  function playOption(s, pi, id, left) {
    const c = CARDS[id];
    const me = s.players[pi];
    const oi = other(pi);
    if (c.type === 'money') return null;
    if (c.type === 'property' || c.type === 'wild') {
      return { kind: 'property', colors: colorsOf(id).map((color) => ({ color, setIds: openSetIds(me, color) })) };
    }
    if (c.type === 'rent') {
      const colors = [];
      for (const color of c.colors) {
        const base = rentFor(s, pi, color);
        const boost = boostFor(s, pi, color);
        if (base > 0) colors.push({ color, amount: base * boost, base, boost });
      }
      if (!colors.length) return null;
      const doubleIds = me.hand.filter((h) => isAct(h, 'doubleRent'));
      const maxDoubles = c.any && !s.rules.doubleRentWithWildRent ? 0 : Math.max(0, Math.min(doubleIds.length, s.rules.maxDoubleRent, left - 1));
      return { kind: 'rent', colors, doubleIds, maxDoubles, wild: c.any, bets: betsFor(s) };
    }
    switch (c.action) {
      case 'passGo':
        return { kind: 'passGo' };
      case 'debtCollector':
        return { kind: 'debtCollector', amount: 5, bets: betsFor(s) };
      case 'birthday':
        return { kind: 'birthday', amount: 2, bets: betsFor(s) };
      case 'house':
      case 'hotel': {
        const setIds = me.sets.filter((x) => canBuild(x, c.action)).map((x) => x.id);
        return setIds.length ? { kind: c.action, setIds } : null;
      }
      case 'slyDeal': {
        const targets = stealable(s, oi);
        return targets.length ? { kind: 'slyDeal', targets } : null;
      }
      case 'forcedDeal': {
        const give = giveable(s, pi);
        const take = stealable(s, oi);
        return give.length && take.length ? { kind: 'forcedDeal', give, take } : null;
      }
      case 'dealBreaker': {
        const targets = s.players[oi].sets.filter(isFull).map((x) => x.id);
        return targets.length ? { kind: 'dealBreaker', targets } : null;
      }
      case 'bankruptcy': {
        const bank = s.players[oi].bank;
        return bank.length ? { kind: 'bankruptcy', amount: sum(bank), count: bank.length } : null;
      }
      case 'liquidation': {
        const targets = s.players[oi].sets.filter(isFull).map((x) => x.id);
        return targets.length ? { kind: 'liquidation', targets, handCount: s.players[oi].hand.length } : null;
      }
      case 'hugeWin': {
        let remove = 0;
        for (const x of s.players[oi].sets) remove += x.cards.length + (x.house != null ? 1 : 0) + (x.hotel != null ? 1 : 0);
        const colors = fullColors(s, pi);
        return remove || colors.length ? { kind: 'hugeWin', remove, colors, mult: BOOST_MULT } : null;
      }
      default:
        return null; // 反对行动、租金翻倍不能单独打出
    }
  }

  function moveOptions(s, pi) {
    const p = s.players[pi];
    const cards = [];
    const buildings = [];
    for (const set of p.sets) {
      for (const id of set.cards) {
        const targets = [];
        for (const color of colorsOf(id)) {
          const setIds = openSetIds(p, color, set.id);
          const auto = color !== set.color; // 换色时可以不指定组，自动归位
          if (setIds.length || auto) targets.push({ color, setIds, auto });
        }
        if (targets.length) cards.push({ cardId: id, fromSetId: set.id, color: set.color, targets });
      }
    }
    const tryBuilding = (id, src) => {
      const kind = CARDS[id].action;
      if (kind === 'house' && src && src.hotel != null) return;
      const setIds = p.sets.filter((x) => x !== src && canBuild(x, kind)).map((x) => x.id);
      if (setIds.length) buildings.push({ cardId: id, fromSetId: src ? src.id : null, setIds });
    };
    for (const set of p.sets) {
      if (set.house != null) tryBuilding(set.house, set);
      if (set.hotel != null) tryBuilding(set.hotel, set);
    }
    for (const id of p.loose) tryBuilding(id, null);
    return { cards, buildings };
  }

  function respondOptions(s, pi) {
    const pd = s.pending;
    const role = pd.chain.length % 2 === 0 ? 'target' : 'actor';
    const jsnIds = canJSN(s, pi) ? s.players[pi].hand.filter((id) => isAct(id, 'justSayNo')) : [];
    const o = {
      pendingId: pd.id,
      action: pd.action,
      role,
      amount: pd.amount,
      jsnIds,
      canJustSayNo: jsnIds.length > 0,
      canAccept: role === 'actor' || !isPaymentKind(pd.action),
      mustPay: role === 'target' && isPaymentKind(pd.action),
    };
    if (pd.action === 'raise') Object.assign(o, { jsnIds: [], canJustSayNo: false, canFold: true, stake: pd.stake, from: s.stake });
    if (o.mustPay) {
      o.payable = payableItems(s, pi);
      o.payableTotal = sum(o.payable);
      o.mustPayAll = o.payableTotal <= pd.amount;
      o.suggested = suggestPayment(s, pi, pd.amount);
    }
    return o;
  }

  // 平铺出所有具体可执行的动作（AI、测试用；付款、弃牌只给推荐组合）
  function listActions(s, pi) {
    const o = getOptions(s, pi);
    if (!o) return [];
    const acts = [];
    if (o.respond) {
      const R = o.respond;
      if (R.canJustSayNo) acts.push({ type: 'JUST_SAY_NO', player: pi, cardId: R.jsnIds[0] });
      if (R.canAccept) acts.push({ type: 'ACCEPT', player: pi });
      if (R.canFold) acts.push({ type: 'FOLD', player: pi });
      if (R.mustPay) acts.push({ type: 'PAY', player: pi, cardIds: R.suggested });
      return acts;
    }
    if (o.discard) return [{ type: 'DISCARD', player: pi, cardIds: suggestDiscard(s, pi, o.discard.count) }];
    if (!o.canEndTurn) return acts;
    acts.push({ type: 'END_TURN', player: pi });
    if (o.raise) acts.push({ type: 'RAISE', player: pi });
    const A = (cardId, extra) => Object.assign({ type: 'PLAY_ACTION', player: pi, cardId }, extra);
    for (const h of o.hand) {
      if (h.bank) acts.push({ type: 'PLAY_BANK', player: pi, cardId: h.cardId });
      const p = h.play;
      if (!p) continue;
      switch (p.kind) {
        case 'property':
          for (const c of p.colors) acts.push({ type: 'PLAY_PROPERTY', player: pi, cardId: h.cardId, color: c.color });
          break;
        case 'rent':
          for (const c of p.colors) for (let d = 0; d <= p.maxDoubles; d++) {
            acts.push(A(h.cardId, { color: c.color, doubles: p.doubleIds.slice(0, d) }));
            for (const bet of p.bets) acts.push(A(h.cardId, { color: c.color, doubles: p.doubleIds.slice(0, d), bet }));
          }
          break;
        case 'debtCollector':
        case 'birthday':
          acts.push(A(h.cardId));
          for (const bet of p.bets) acts.push(A(h.cardId, { bet }));
          break;
        case 'house':
        case 'hotel':
          for (const setId of p.setIds) acts.push(A(h.cardId, { setId }));
          break;
        case 'slyDeal':
          for (const t of p.targets) acts.push(A(h.cardId, { targetCardId: t }));
          break;
        case 'forcedDeal':
          for (const g of p.give) for (const t of p.take) acts.push(A(h.cardId, { giveCardId: g, targetCardId: t }));
          break;
        case 'dealBreaker':
        case 'liquidation':
          for (const t of p.targets) acts.push(A(h.cardId, { targetSetId: t }));
          break;
        default:
          acts.push(A(h.cardId, {}));
      }
    }
    for (const m of o.moves.cards) {
      for (const t of m.targets) {
        if (t.auto) acts.push({ type: 'MOVE_CARD', player: pi, cardId: m.cardId, color: t.color });
        for (const setId of t.setIds) acts.push({ type: 'MOVE_CARD', player: pi, cardId: m.cardId, color: t.color, setId });
      }
    }
    for (const m of o.moves.buildings) for (const setId of m.setIds) acts.push({ type: 'MOVE_BUILDING', player: pi, cardId: m.cardId, setId });
    return acts;
  }

  /* ═══════════════════════════ 付款 / 弃牌建议 ═══════════════════════════ */

  // 付出某张桌面牌的"心疼程度"：银行 < 散落建筑 < 散牌地产 < 快凑满的组 < 完整套；
  // 还会避开"送过去正好帮对手凑满"的牌
  function payCost(s, pi, id) {
    const p = s.players[pi];
    if (p.bank.indexOf(id) >= 0) return valueOf(id) - 100;
    if (p.loose.indexOf(id) >= 0) return valueOf(id);
    for (const set of p.sets) {
      if (set.house === id || set.hotel === id) return valueOf(id) + (isFull(set) ? 40 : 0);
      if (set.cards.indexOf(id) < 0) continue;
      const oi = other(pi);
      let cost = valueOf(id) + (isFull(set) ? 100 : set.cards.length * 15) + (CARDS[id].type === 'wild' ? 5 : 0);
      if (wouldComplete(s, oi, set.color)) cost += fullCountWith(s, oi, set.color) >= s.rules.setsToWin ? 500 : 60;
      else cost += fillOf(s, oi, set.color) * 8;
      return cost;
    }
    return valueOf(id);
  }

  // 子集和：银行里总额 ≥ amount 且最小的组合（同额取张数少的）
  function bankSubset(ids, amount) {
    const best = new Map([[0, []]]);
    for (const id of ids) {
      const v = valueOf(id);
      for (const [t, arr] of Array.from(best.entries())) {
        const cur = best.get(t + v);
        if (!cur || cur.length > arr.length + 1) best.set(t + v, arr.concat(id));
      }
    }
    let pick = null;
    let pickTotal = Infinity;
    for (const [t, arr] of best) {
      if (t >= amount && (t < pickTotal || (t === pickTotal && arr.length < pick.length))) { pick = arr; pickTotal = t; }
    }
    return pick || ids.slice();
  }

  function suggestPayment(s, pi, amount) {
    if (!isPlayer(pi)) return [];
    const items = payableItems(s, pi);
    if (sum(items) <= amount) return items;
    const bank = s.players[pi].bank;
    if (sum(bank) >= amount) return bankSubset(bank, amount);
    const cost = new Map(items.map((id) => [id, payCost(s, pi, id)]));
    const chosen = bank.slice();
    let total = sum(bank);
    const rest = items.filter((id) => bank.indexOf(id) < 0).sort((x, y) => cost.get(x) - cost.get(y));
    for (const id of rest) {
      if (total >= amount) break;
      chosen.push(id);
      total += valueOf(id);
    }
    // 回头剔除多余的牌，先试最心疼的
    const ranked = chosen.slice().sort((x, y) => cost.get(y) - cost.get(x));
    for (const id of ranked) {
      if (total - valueOf(id) >= amount) {
        chosen.splice(chosen.indexOf(id), 1);
        total -= valueOf(id);
      }
    }
    return chosen;
  }

  function keepScore(s, pi, id) {
    const c = CARDS[id];
    if (c.type === 'property' || c.type === 'wild') return 70 + c.value;
    if (c.type === 'money') return 10 + c.value * 2;
    if (c.type === 'rent') return 22 + (c.any ? 8 : 0) + (c.colors.some((col) => rentFor(s, pi, col) > 0) ? 12 : 0);
    return { hugeWin: 99, justSayNo: 100, liquidation: 97, dealBreaker: 95, bankruptcy: 90, slyDeal: 60, forcedDeal: 50, debtCollector: 45, birthday: 35, hotel: 34, house: 32, doubleRent: 28, passGo: 20 }[c.action];
  }

  function suggestDiscard(s, pi, count) {
    if (!isPlayer(pi)) return [];
    return s.players[pi].hand.slice()
      .sort((x, y) => keepScore(s, pi, x) - keepScore(s, pi, y) || valueOf(x) - valueOf(y) || x - y)
      .slice(0, Math.max(0, count | 0));
  }

  /* ═══════════════════════════ 日志 ═══════════════════════════ */

  function redact(e, viewer) {
    if (!e || typeof e !== 'object') return e;
    const secret = (e.type === 'draw' || e.type === 'deal' || (e.type === 'discard' && e.to === 'deckBottom')) && e.player !== viewer && e.cardIds;
    if (!secret) return e;
    const c = Object.assign({}, e);
    delete c.cardIds;
    return c;
  }

  function describe(s, e, viewer) {
    if (!e || typeof e !== 'object') return '';
    const N = (i) => (isPlayer(i) ? s.players[i].name : '—');
    const C = (id) => (isCardId(id) ? `「${CARDS[id].zh}」` : '');
    const Z = (col) => (isColor(col) ? COLORS[col].zh : '');
    const L = (ids) => (Array.isArray(ids) ? ids.map(C).join('') : '');
    const A = (k) => `「${ACTIONS[k].zh}」`;
    switch (e.type) {
      case 'gameStart': return `对局开始，${N(e.first)} 先手`;
      case 'deal': return `${N(e.player)} 拿到 ${e.count} 张起手牌` + (e.cardIds && e.player === viewer ? `：${L(e.cardIds)}` : '');
      case 'turnStart': return `第 ${e.turn} 回合 · ${N(e.player)}`;
      case 'draw':
        if (!e.count) return `${N(e.player)} 想摸牌，但牌堆已经空了`;
        return `${N(e.player)} 摸了 ${e.count} 张牌` + (e.cardIds && e.player === viewer ? `：${L(e.cardIds)}` : '');
      case 'reshuffle': return `抽牌堆用完，弃牌堆洗成新的抽牌堆（${e.count} 张）`;
      case 'bank': return `${N(e.player)} 把${C(e.cardId)}存进银行（${e.value}M）`;
      case 'property': return `${N(e.player)} 打出地产${C(e.cardId)}，归入${Z(e.color)}`;
      case 'building': return `${N(e.player)} 在${Z(e.color)}上放了${C(e.cardId)}`;
      case 'actionPlayed': {
        const P = N(e.player);
        const T = N(e.target);
        switch (e.action) {
          case 'passGo': return `${P} 打出${C(e.cardId)}，再摸 2 张`;
          case 'debtCollector': return `${P} 打出${C(e.cardId)}，向 ${T} 讨 ${e.amount}M${e.bet > 1 ? `（赌赢 ×${e.bet}）` : ''}`;
          case 'birthday': return `${P} 打出${C(e.cardId)}，${T} 要随礼 ${e.amount}M${e.bet > 1 ? `（赌赢 ×${e.bet}）` : ''}`;
          case 'rent': return `${P} 打出${C(e.cardId)}${e.doubles && e.doubles.length ? `并叠了 ${e.doubles.length} 张${A('doubleRent')}` : ''}，按${Z(e.color)}向 ${T} 收租 ${e.amount}M${e.boost > 1 ? `（${A('hugeWin')} ×${e.boost}）` : ''}${e.bet > 1 ? `（赌赢 ×${e.bet}）` : ''}`;
          case 'slyDeal': return `${P} 打出${C(e.cardId)}，要拿走 ${T} 的${C(e.targetCardId)}`;
          case 'forcedDeal': return `${P} 打出${C(e.cardId)}，要用${C(e.giveCardId)}换 ${T} 的${C(e.targetCardId)}`;
          case 'dealBreaker': return `${P} 打出${C(e.cardId)}，要抢走 ${T} 的整套${Z(e.color)}`;
          case 'bankruptcy': return `${P} 打出${C(e.cardId)}，要拿走 ${T} 银行里的全部 ${e.amount}M`;
          case 'liquidation': return `${P} 打出${C(e.cardId)}，要清算 ${T} 的整套${Z(e.color)}，并弃掉 ${T} 的全部手牌`;
          case 'hugeWin': return `${P} 打出${C(e.cardId)}，${T} 桌上的地产将全部消失`;
          default: return `${P} 打出${C(e.cardId)}`;
        }
      }
      case 'awaiting': return e.role === 'target' ? `等待 ${N(e.player)} 回应` : `等待 ${N(e.player)} 决定是否反制`;
      case 'justSayNo': return `${N(e.player)} 打出${C(e.cardId)}` + (e.blocked ? '，行动被挡下' : '，行动恢复生效');
      case 'canceled': return `${N(e.actor)} 的行动被${A('justSayNo')}取消`;
      case 'payment': {
        if (!e.cardIds || !e.cardIds.length) return `${N(e.from)} 桌面上没有能付的牌，免付`;
        const note = e.paid < e.amount ? `（应付 ${e.amount}M，已全部付出）` : e.paid > e.amount ? `（应付 ${e.amount}M，不找零）` : '';
        return `${N(e.from)} 付给 ${N(e.to)} ${e.paid}M：${L(e.cardIds)}${note}`;
      }
      case 'steal': return `${N(e.to)} 拿走了 ${N(e.from)} 的${C(e.cardId)}`;
      case 'swap': return `${N(e.actor)} 用${C(e.gave)}换走了 ${N(e.target)} 的${C(e.took)}`;
      case 'bankrupt': return e.cardIds.length ? `${N(e.to)} 拿走了 ${N(e.from)} 银行里的全部 ${e.amount}M` : `${N(e.from)} 的银行已经空了，什么也没拿到`;
      case 'liquidated': return `${N(e.by)} 清算了 ${N(e.from)} 的整套${Z(e.color)}` + (e.handCount ? `，${N(e.from)} 的 ${e.handCount} 张手牌全部弃掉` : '');
      case 'hugeWin': {
        const gone = e.cardIds.length ? `${N(e.from)} 桌上的 ${e.cardIds.length} 张地产全部消失` : `${N(e.from)} 桌上本来就没有地产`;
        return gone + (e.boostColors.length ? `；${N(e.by)} 的${e.boostColors.map(Z).join('、')}下次收租 ×${e.mult}` : '');
      }
      case 'autoEndTurn': return e.lapsed ? `${N(e.player)} 的出牌次数用完（${e.lapsed} 次超时），自动结束回合` : `${N(e.player)} 出满 ${e.plays} 张，自动结束回合`;
      case 'playLapsed': return `${N(e.player)} 出牌超时，作废 1 次出牌（${e.plays}/${e.max}）`;
      case 'award': return `${N(e.player)} 获得成就「${AWARDS[e.award] || e.award}」`;
      case 'lottery': return `大乐透${e.pity ? '（保底）' : ''}：${N(e.player)} 中奖 ${e.amount}M（${L(e.cardIds)}）`;
      case 'raiseOffered': return `${N(e.player)} 要求加注：这局从 ×${e.from} 改为 ×${e.stake}`;
      case 'raiseTaken': return `${N(e.player)} 跟注，这局 ×${e.stake}`;
      case 'folded': return `${N(e.player)} 弃牌`;
      case 'jackpot': return `奖池开奖：${N(e.player)} 押 ×4 赌赢，摸走奖池里的 ${e.count} 张`;
      case 'gamble': return `${N(e.player)} 用${C(e.cardId)}赌一把（押 ×${e.mult}，${Math.round(100 / e.mult)}% 几率）：` + (e.won ? `赢了，${e.base}M 变成 ${e.amount}M` : `落空，这张牌作废`);
      case 'comeback': return e.kind === 'lastStand' ? `背水一战：对手到了赛点，${N(e.player)} 本回合可以出 ${e.plays} 张` : `逆风补给：${N(e.player)} 落后两套以上，本回合多摸 ${e.extra} 张`;
      case 'setStolen': return `${N(e.to)} 抢走了 ${N(e.from)} 的整套${Z(e.color)}` + (e.house != null || e.hotel != null ? '，连同上面的建筑' : '');
      case 'move': return `${N(e.player)} 把${C(e.cardId)}调整到${Z(e.color)}`;
      case 'buildingMoved': return `${N(e.player)} 把${C(e.cardId)}挪到${Z(e.color)}`;
      case 'discardRequired': return `${N(e.player)} 手牌超过 ${s.rules.handLimit} 张，需要弃 ${e.count} 张`;
      case 'discard': return `${N(e.player)} 弃掉了` + (e.cardIds ? L(e.cardIds) : ` ${e.count} 张牌`);
      case 'turnEnd': return `${N(e.player)} 结束回合`;
      case 'resign': return `${N(e.player)} 认输`;
      case 'gameOver':
        if (e.reason === 'sets') return `${N(e.winner)} 凑齐 ${s.rules.setsToWin} 套不同颜色的完整地产，获胜！` + (e.stake > 1 ? `这局 ×${e.stake}` : '');
        if (e.reason === 'resign') return `${N(e.winner)} 获胜（对方认输）` + (e.stake > 1 ? `，这局 ×${e.stake}` : '');
        if (e.reason === 'fold') return `${N(e.winner)} 获胜（对方弃牌），这局 ×${e.stake}`;
        if (e.reason === 'stalemate') return '牌堆耗尽、双方都打不出牌，平局';
        return '达到回合上限，平局';
      default: return String(e.type || '');
    }
  }

  /* ═══════════════════════════ 对外接口 ═══════════════════════════ */

  function wrap(initial) {
    let s = initial;
    const listeners = [];
    const queue = [];
    let delivering = false;
    let game = null;

    const run = (action, commit) => {
      const next = cloneState(s);
      const ev = [];
      try {
        reduce(next, action, ev);
      } catch (err) {
        if (err instanceof RuleError) return { ok: false, error: { code: err.code, message: err.message } };
        if (typeof console !== 'undefined' && console.error) console.error('[MonopolyDeal] 内部错误，状态已回滚', err);
        return { ok: false, error: { code: 'INTERNAL', message: '引擎内部错误，状态已回滚：' + (err && err.message) } };
      }
      if (!commit) return { ok: true };
      s = next;
      appendLog(s, ev);
      // 按顺序送达：监听器里再 dispatch 产生的事件，会排在当前这批之后
      queue.push(ev);
      if (!delivering) {
        delivering = true;
        try {
          while (queue.length) {
            const batch = queue.shift();
            for (const fn of listeners.slice()) {
              try { fn(batch, game); } catch (e) { if (typeof console !== 'undefined' && console.error) console.error(e); }
            }
          }
        } finally {
          delivering = false;
        }
      }
      return { ok: true, events: ev };
    };

    game = {
      /** 执行动作。成功 → { ok:true, events }；失败 → { ok:false, error:{ code, message } }，状态不变 */
      dispatch: (action) => run(action, true),
      /** 只校验不执行（预演） */
      can: (action) => run(action, false),
      /** 订阅结算事件，返回取消订阅函数 */
      on(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      /** 完整状态副本（含双方手牌和牌堆顺序，只给主机 / 服务器用） */
      getState: () => JSON.parse(JSON.stringify(s)),
      /** 玩家视角；viewer 为 null 时是观战视角 */
      getView: (viewer) => getView(s, viewer),
      /** 结构化的可选操作，驱动 UI；player 无效时返回 null */
      getOptions: (pi) => getOptions(s, pi),
      /** 平铺的全部具体动作 */
      listActions: (pi) => listActions(s, pi),
      /** 此刻该谁操作；对局结束为 null */
      activePlayer: () => activePlayer(s),
      /** 推荐付款组合（默认按当前待付金额） */
      suggestPayment: (pi, amount) => suggestPayment(s, pi, amount != null ? amount : s.pending ? s.pending.amount : 0),
      /** 推荐弃牌（默认按当前需弃张数） */
      suggestDiscard: (pi, count) => suggestDiscard(s, pi, count != null ? count : s.discardNeed),
      /** 某玩家在某颜色上能收多少租 */
      rentFor: (pi, color) => (isPlayer(pi) && isColor(color) ? rentFor(s, pi, color) : 0),
      /** 内置日志（已按 viewer 脱敏），sinceSeq 用于增量拉取 */
      getLog: (viewer, sinceSeq) => {
        const out = [];
        for (const e of s.log) if (e.seq > (sinceSeq || 0)) out.push(redact(e, viewer));
        return out;
      },
      /** 按 viewer 脱敏事件（联机下发前用） */
      redact: (events, viewer) => (Array.isArray(events) ? events.map((e) => redact(e, viewer)) : []),
      /** 事件 → 中文日志文本 */
      describe: (event, viewer) => describe(s, event, viewer),
      /** 自检：返回问题列表，空数组表示状态健康 */
      validate: () => validateState(s),
      /** 存档字符串，用 MonopolyDeal.loadGame 读回 */
      serialize: () => JSON.stringify(s),
      get phase() { return s.phase; },
      get result() { return s.result ? Object.assign({}, s.result) : null; },
    };
    return game;
  }

  /**
   * 新开一局
   * @param {object}   [opts]
   * @param {string[]} [opts.players]      两位玩家名字
   * @param {number|string} [opts.seed]    随机种子（数字或字符串，省略则随机）
   * @param {0|1}      [opts.firstPlayer]  先手（省略则随机）
   * @param {'balanced'|'official'} [opts.preset]  规则预设，默认 balanced
   * @param {object}   [opts.rules]        单项规则，覆盖预设
   */
  function createGame(opts) {
    return wrap(initState(opts));
  }

  /** 读档：接受 serialize() 的字符串或 getState() 的对象；损坏的存档会抛出带原因的错误 */
  function loadGame(data) {
    let s;
    try {
      s = typeof data === 'string' ? JSON.parse(data) : JSON.parse(JSON.stringify(data));
    } catch (e) {
      throw new Error('存档不是合法的 JSON');
    }
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('无法识别的存档');
    if (String(s.engine || '').split('.')[0] !== VERSION.split('.')[0]) throw new Error(`存档版本 ${s.engine} 与引擎 ${VERSION} 不兼容`);
    s.rules = sanitizeRules(s.rules, null);
    migrate(s);
    const problems = validateState(s);
    if (problems.length) throw new Error('存档损坏：' + problems.join('；'));
    return wrap(s);
  }

  return {
    VERSION,
    CARDS,
    FACES,
    COLORS,
    COLOR_KEYS,
    ACTIONS,
    DEFAULT_RULES,
    PRESETS,
    HOUSE_BONUS,
    HOTEL_BONUS,
    RuleError,
    createGame,
    loadGame,
    validateState,
    _internal: { cloneState, sanitizeRules },
  };
});

/* ═══════════════════════════ 对战服务 ═══════════════════════════ */

const MD = globalThis.MonopolyDeal;
const SERVICE_VERSION = '1.6.0';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉了容易看错的 0 O 1 I
const ROOM_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const NAME_MAX = 16;
// 联机房间的规则：被针对时一律由本人点「接受 / 付款」，不自动结算——否则"秒结算"会暴露对方手里有没有「反对行动」
const ROOM_RULES = Object.freeze({ autoResolve: false, logLimit: 200, autoEndTurn: true, comeback: true, comebackChance: 10, gamble: true, jackpot: true, doubling: true, lottery: true, lotteryChance: 15, lotteryPity: 4 });
// 客户端动作里只认这些字段，player 一律由服务器按座位填写
const ACTION_KEYS = ['type', 'cardId', 'color', 'setId', 'doubles', 'targetCardId', 'giveCardId', 'targetSetId', 'cardIds', 'bet'];
// 对局中可以互发的表情（固定几个，防止被拿来刷屏或传别的东西）
const EMOTES = ['👍', '😂', '😮', '😭', '😤', '🎉', '😎', '🤔', '😱', '🙏', '🔥', '💰'];

const ERRORS = {
  NOT_FOUND: [404, '房间不存在或已过期'],
  FULL: [409, '房间已满，两个座位都有人了'],
  BAD_ROOM: [400, '房间码应为 6 位字母或数字'],
  BAD_JSON: [400, '请求内容不是合法的 JSON'],
  TOO_LARGE: [413, '请求内容太大'],
  NOT_WS: [426, '这个地址需要用 WebSocket 连接'],
  FORBIDDEN_ORIGIN: [403, '这个网站没有被允许连接对战服务'],
  BUSY: [503, '暂时无法创建房间，请稍后再试'],
  NO_ROUTE: [404, '没有这个接口'],
  NO_BINDING: [500, '后端还没绑定 Durable Object：需要「变量名 ROOMS → 类 GameRoom」，按部署说明执行一次带 migrations 的上传'],
  ROOM_DOWN: [500, '房间对象调用失败'],
  SERVER: [500, '服务器出错了'],
};

class HttpError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const newRoomId = () => Array.from(randomBytes(6), (b) => ROOM_ALPHABET[b & 31]).join('');
const newToken = () => Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
const ttlMs = (env) => Math.max(1, Number(env.ROOM_TTL_HOURS) || 24) * 3600e3;
// 出牌倒计时：每个要做决定的时刻各自限时——出一张牌 30 秒，回应 / 弃牌 25 秒。时间到了服务器替他做最稳妥的选择
const CLOCK_SECONDS = Object.freeze({ play: 30, respond: 25, discard: 25 });
const clockMs = (env, kind) => {
  const v = Number(kind === 'play' ? env.TURN_SECONDS : env.RESPOND_SECONDS);
  return (v >= 5 && v <= 600 ? v : CLOCK_SECONDS[kind]) * 1000;
};
// 客户端自带的凭证：32 位十六进制（和服务器生成的同一格式）
const goodClaim = (c) => (typeof c === 'string' && /^[0-9a-f]{32}$/.test(c) ? c : null);

function cleanName(n, i) {
  const t = typeof n === 'string' ? n.replace(/\s+/g, ' ').trim() : '';
  return t ? Array.from(t).slice(0, NAME_MAX).join('') : `玩家 ${i + 1}`;
}

/* ─────────── HTTP 工具 ─────────── */

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers) });
}

function errorResponse(code, cors, detail) {
  const [status, message] = ERRORS[code] || ERRORS.SERVER;
  return json({ ok: false, error: { code, message: detail ? `${message}（${detail}）` : message } }, status, cors);
}

// 取房间对象；没绑定就给出明确的配置错误，而不是笼统的 500
function roomStub(env, code) {
  const ns = env.ROOMS;
  if (!ns || typeof ns.idFromName !== 'function') throw new HttpError('NO_BINDING');
  return ns.get(ns.idFromName(code));
}

// 用 fetch 调房间对象（不依赖 Durable Object RPC，兼容日期再旧也能用）
async function callRoom(stub, method, args) {
  let res;
  try {
    res = await stub.fetch('https://room/rpc/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) });
  } catch (e) {
    throw new HttpError('ROOM_DOWN', e && e.message);
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { throw new HttpError('ROOM_DOWN', `HTTP ${res.status} ${text.slice(0, 120)}`); }
}

// 自检：浏览器打开 /api/health 就能看到哪一项没配好
async function health(env, cors) {
  const checks = [];
  const add = (name, ok, message) => checks.push({ name, ok, message });
  const ns = env.ROOMS;
  const bound = !!ns && typeof ns.idFromName === 'function';
  add('Durable Object 绑定', bound, bound ? 'ROOMS 已绑定' : '没有找到绑定 ROOMS。需要执行一次带 migrations 的上传（会同时创建类 GameRoom 和绑定）');
  if (bound) {
    try {
      const r = await callRoom(ns.get(ns.idFromName('__health__')), 'ping', {});
      add('房间对象', !!(r && r.ok), r && r.ok ? `可以创建和读写（存储：${r.storage}）` : '房间对象返回异常');
    } catch (e) {
      add('房间对象', false, `调用失败：${e.detail || e.message}。通常是类 GameRoom 还没创建，需要执行一次带 migrations 的上传`);
    }
  }
  add('ALLOWED_ORIGINS', true, env.ALLOWED_ORIGINS ? `只允许 ${env.ALLOWED_ORIGINS}` : '未设置，不限制来源');
  add('ROOM_TTL_HOURS', true, `空房间 ${ttlMs(env) / 3600e3} 小时后清理`);
  add('TURN_SECONDS', true, `单张出牌限时 ${clockMs(env, 'play') / 1000} 秒，回应 / 弃牌限时 ${clockMs(env, 'respond') / 1000} 秒（RESPOND_SECONDS）`);
  return json({ ok: checks.every((c) => c.ok), service: SERVICE_VERSION, engine: MD.VERSION, checks }, 200, Object.assign({ 'Cache-Control': 'no-store' }, cors));
}

const allowList = (env) => String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(request, env) {
  const list = allowList(env);
  const origin = request.headers.get('Origin');
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
  if (list.includes('*')) h['Access-Control-Allow-Origin'] = '*';
  else if (origin && list.includes(origin)) Object.assign(h, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
  return h;
}

function originAllowed(request, env) {
  const list = allowList(env);
  if (list.includes('*')) return true;
  const o = request.headers.get('Origin');
  return !!o && list.includes(o);
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 2048) throw new HttpError('TOO_LARGE');
  if (!text) return {};
  let v;
  try { v = JSON.parse(text); } catch (e) { throw new HttpError('BAD_JSON'); }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// 前端启动时拉一次的静态数据（牌面、颜色、图片清单、规则）
const META_JSON = JSON.stringify({
  ok: true,
  service: SERVICE_VERSION,
  engine: MD.VERSION,
  cards: MD.CARDS,
  faces: MD.FACES,
  colors: MD.COLORS,
  colorKeys: MD.COLOR_KEYS,
  actions: MD.ACTIONS,
  houseBonus: MD.HOUSE_BONUS,
  hotelBonus: MD.HOTEL_BONUS,
  presets: MD.PRESETS,
  rules: MD.DEFAULT_RULES,
  roomRules: ROOM_RULES,
});

/* ─────────── 路由 ─────────── */

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      return await route(request, env, cors);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e.code, cors, e.detail);
      console.error('[monopoly-deal]', e);
      return errorResponse('SERVER', cors, e && e.message);
    }
  },
};

async function route(request, env, cors) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if ((path === '/' || path === '/api') && method === 'GET') {
    return json({ ok: true, service: 'Monopoly Deal 对战服务', version: SERVICE_VERSION, engine: MD.VERSION }, 200, cors);
  }
  if (path === '/api/meta' && method === 'GET') {
    return new Response(META_JSON, { headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }, cors) });
  }
  if (path === '/api/health' && method === 'GET') return health(env, cors);
  if (path === '/api/rooms' && method === 'POST') return createRoom(request, env, cors);

  const m = path.match(/^\/api\/rooms\/([^/]+)(?:\/(join|ws))?$/);
  if (m) {
    const code = decodeURIComponent(m[1]).toUpperCase();
    if (!ROOM_RE.test(code)) throw new HttpError('BAD_ROOM');
    const stub = roomStub(env, code);
    if (!m[2] && method === 'GET') return rpcResponse(await callRoom(stub, 'info'), cors);
    if (m[2] === 'join' && method === 'POST') {
      const body = await readJson(request);
      return rpcResponse(await callRoom(stub, 'join', { name: body.name, token: typeof body.token === 'string' ? body.token : '', claim: body.claim }), cors);
    }
    if (m[2] === 'ws' && method === 'GET') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') throw new HttpError('NOT_WS');
      if (!originAllowed(request, env)) throw new HttpError('FORBIDDEN_ORIGIN');
      return stub.fetch(request);
    }
  }
  throw new HttpError('NO_ROUTE');
}

function rpcResponse(r, cors) {
  return r && r.ok ? json(r, 200, cors) : errorResponse((r && r.code) || 'SERVER', cors);
}

async function createRoom(request, env, cors) {
  const body = await readJson(request);
  for (let i = 0; i < 5; i++) { // 房间码撞了就换一个
    const roomId = newRoomId();
    const r = await callRoom(roomStub(env, roomId), 'create', { roomId, name: body.name, preset: body.preset, claim: body.claim });
    if (r.ok) return json(r, 201, cors);
  }
  throw new HttpError('BUSY');
}

/* ─────────── 房间：一个房间一个 Durable Object ───────────
 * 存储：room = { id, createdAt, expireAt, preset, round, rematch:[bool,bool], seats:[{ name, token } | null, …], clock }
 *       game = 引擎存档字符串（每个成功的动作后写一次）
 *       clock = { key, seat, kind, total, deadline }：现在等谁做哪个决定、几点到期。同一个决定点 key 不变，换了就重新计时
 * 闹钟（alarm）只有一个，同时管两件事：倒计时到期（替人做决定）和空房间到期清理，取较早的那个时间。
 * 连接用休眠 WebSocket：没人说话时对象可以休眠不计费，醒来后从存储重新读出房间和对局。 */

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = undefined; // undefined = 还没从存储读；null = 房间不存在
    this.game = null;
    try {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    } catch (e) { /* 本地老版本运行时没有这个接口，不影响功能 */ }
  }

  async load() {
    if (this.room !== undefined) return;
    const got = await this.ctx.storage.get(['room', 'game']);
    if (this.room !== undefined) return;
    this.room = got.get('room') || null;
    this.game = null;
    const saved = got.get('game');
    if (this.room && saved) {
      try {
        // 套用当前的房间规则：部署新版本后，进行中的旧对局也按新规则走（比如出满自动结束回合）
        const state = JSON.parse(saved);
        state.rules = Object.assign({}, state.rules, ROOM_RULES);
        this.game = MD.loadGame(state);
      } catch (e) {
        console.error('[monopoly-deal] 存档损坏，已丢弃这一局', e);
      }
    }
  }

  async save() {
    const data = { room: this.room };
    if (this.game) data.game = this.game.serialize();
    await this.ctx.storage.put(data);
  }

  startGame() {
    const r = this.room;
    r.round = (r.round || 0) + 1;
    r.rematch = [false, false];
    r.emotes = [0, 0];
    r.emoteTurn = 0;
    r.emoteAward = [false, false];
    this.game = MD.createGame({ players: r.seats.map((x) => x.name), seed: newToken(), preset: r.preset, rules: ROOM_RULES });
  }

  /* ── RPC：由 Worker 调用 ── */

  async create({ roomId, name, preset, claim }) {
    await this.load();
    if (this.room) return { ok: false, code: 'EXISTS' };
    const token = goodClaim(claim) || newToken();
    this.room = {
      id: roomId,
      createdAt: Date.now(),
      preset: preset === 'official' ? 'official' : 'balanced',
      round: 0,
      rematch: [false, false],
      seats: [{ name: cleanName(name, 0), token }, null],
      expireAt: Date.now() + ttlMs(this.env),
    };
    this.game = null;
    await this.save();
    await this.scheduleAlarm();
    return { ok: true, roomId, seat: 0, token, preset: this.room.preset };
  }

  async join({ name, token, claim }) {
    await this.load();
    if (!this.room) return { ok: false, code: 'NOT_FOUND' };
    const seats = this.room.seats;
    const c = goodClaim(claim);
    const known = [token, c].filter(Boolean);
    const mine = seats.findIndex((x) => x && known.indexOf(x.token) >= 0);
    if (mine >= 0) return { ok: true, roomId: this.room.id, seat: mine, token: seats[mine].token, preset: this.room.preset }; // 原座位重连（含"上次加入其实成功了，只是没收到回复"）
    if (seats[1]) return { ok: false, code: 'FULL' };
    seats[1] = { name: cleanName(name, 1), token: c || newToken() };
    this.startGame();
    await this.save();
    this.broadcastWelcome(); // 房主那边直接进入对局
    await this.flushClock(); // 第一个决定点开始计时
    return { ok: true, roomId: this.room.id, seat: 1, token: seats[1].token, preset: this.room.preset };
  }

  async info() {
    await this.load();
    if (!this.room) return { ok: false, code: 'NOT_FOUND' };
    return Object.assign({ ok: true }, this.roomInfo(), { phase: this.game ? this.game.phase : 'waiting' });
  }

  /* ── WebSocket ── */

  async fetch(request) {
    const url = new URL(request.url);
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') return this.acceptSocket(url);
    const m = url.pathname.match(/^\/rpc\/(create|join|info|ping)$/);
    if (!m) return new Response('not found', { status: 404 });
    let args = {};
    try { args = (await request.json()) || {}; } catch (e) { args = {}; }
    const r = await this[m[1]](args);
    return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }

  async ping() {
    await this.ctx.storage.get('room'); // 只读，不写任何东西
    return { ok: true, storage: this.ctx.storage.sql ? 'SQLite' : 'KV' };
  }

  async acceptSocket(url) {
    await this.load();
    const token = url.searchParams.get('token') || '';
    const seat = this.room ? this.room.seats.findIndex((x) => x && x.token === token) : -1;
    const [client, server] = Object.values(new WebSocketPair());
    if (seat < 0) { // 先接上再说明原因：浏览器拿不到握手失败的状态码
      server.accept();
      const code = this.room ? 'BAD_TOKEN' : 'NOT_FOUND';
      server.send(JSON.stringify({ t: 'fatal', code, message: this.room ? '座位凭证无效，请重新加入房间' : ERRORS.NOT_FOUND[1] }));
      server.close(code === 'BAD_TOKEN' ? 4003 : 4004, code);
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server, ['seat' + seat]);
    server.serializeAttachment({ seat });
    this.room.expireAt = Date.now() + ttlMs(this.env);
    this.send(server, this.welcome(seat)); // 两边都断过线、倒计时暂停了的话，这里会重新开始计时
    this.broadcastRoom();
    await this.save();
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    const seat = this.seatOf(ws);
    if (!this.room || seat == null || !this.room.seats[seat]) {
      this.send(ws, { t: 'fatal', code: 'NOT_FOUND', message: ERRORS.NOT_FOUND[1] });
      try { ws.close(4004, 'NOT_FOUND'); } catch (e) { /* 已断开 */ }
      return;
    }
    if (raw === 'ping') return this.send(ws, 'pong');
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch (e) {
      return this.send(ws, { t: 'error', code: 'BAD_JSON', message: '消息格式不对' });
    }
    if (!msg || typeof msg !== 'object') return undefined;
    switch (msg.t) {
      case 'act': return this.onAction(ws, seat, msg);
      case 'emote': return this.onEmote(ws, seat, msg);
      case 'rematch': return this.onRematch(ws, seat);
      case 'sync': this.send(ws, this.welcome(seat)); return this.flushClock();
      default: return this.send(ws, { t: 'error', code: 'UNKNOWN', message: '未知的消息类型' });
    }
  }

  async webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch (e) { /* 已关闭 */ }
    await this.load();
    if (this.room) this.broadcastRoom(ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async onAction(ws, seat, msg) {
    const id = msg.id;
    if (!this.game) return this.send(ws, { t: 'ack', id, ok: false, error: { code: 'NOT_STARTED', message: '对手还没加入，对局还没开始' } });
    // 断线重连后客户端会把没收到确认的动作原样重发一次：同一个 aid 只执行一次
    const aid = typeof msg.aid === 'string' && msg.aid.length <= 40 ? msg.aid : null;
    if (aid && this.room.lastAct && this.room.lastAct[seat] === aid) return this.send(ws, { t: 'ack', id, ok: true, dup: true });
    if (!this.allow(ws)) return this.send(ws, { t: 'ack', id, ok: false, error: { code: 'TOO_FAST', message: '操作太快了，稍等一下' } });
    const src = msg.action && typeof msg.action === 'object' && !Array.isArray(msg.action) ? msg.action : {};
    if (src.type === 'TIMEOUT_PLAY') return this.send(ws, { t: 'ack', id, ok: false, error: { code: 'UNKNOWN_ACTION', message: '未知的操作' } }); // 只有服务器的倒计时能发
    const action = { player: seat };
    for (const k of ACTION_KEYS) if (Object.prototype.hasOwnProperty.call(src, k)) action[k] = src[k];
    const r = this.game.dispatch(action);
    if (!r.ok) return this.send(ws, { t: 'ack', id, ok: false, error: r.error });
    if (aid) {
      this.room.lastAct = this.room.lastAct || [null, null];
      this.room.lastAct[seat] = aid;
    }
    await this.commit(r, null, () => this.send(ws, { t: 'ack', id, ok: true }));
    return undefined;
  }

  // 动作生效之后：记战绩、重新计时、存档、（先回执）再把更新推给两边，最后重排闹钟
  async commit(r, extra, ack) {
    if (this.game.phase === 'gameOver' && this.room.scoredRound !== this.room.round) { // 记本房间战绩
      const w = this.game.result.winner;
      this.room.score = this.room.score || [0, 0];
      if (w === 0 || w === 1) this.room.score[w] += this.game.result.stake || 1; // 按分累计：加注过的局分值更高
      this.room.scoredRound = this.room.round;
    }
    this.syncClock();
    this.clockDirty = false;
    await this.save();
    if (ack) ack();
    for (const w of this.ctx.getWebSockets()) {
      const s = this.seatOf(w);
      if (s == null) continue;
      const events = this.game.redact(r.events, s);
      this.send(w, Object.assign({ t: 'update', events, lines: events.map((e) => this.game.describe(e, s)) }, extra, this.snapshot(s)));
    }
    await this.scheduleAlarm();
  }

  /* ── 出牌倒计时 ── */

  // 现在等谁做哪个决定。出牌阶段每出一张（或超时作废一次）plays 都会变，所以每张牌各算各的时间
  clockNow() {
    const g = this.game;
    if (!g || g.phase === 'gameOver') return null;
    const v = g.getView(null);
    const pd = v.phase === 'respond' ? v.pending : null;
    const kind = pd ? 'respond' : v.phase === 'discard' ? 'discard' : 'play';
    const seat = pd ? pd.awaiting : v.turn.player;
    return { seat, kind, key: [this.room.round || 0, v.turn.number, v.phase, v.turn.plays, pd ? `${pd.id}.${pd.chain.length}` : '', v.discardNeed || 0].join('|') };
  }

  // 决定点变了就重新计时；返回是否有变化（有变化要存档、重排闹钟）
  syncClock() {
    const now = this.clockNow();
    const c = this.room.clock;
    if (!now) {
      if (!c) return false;
      this.room.clock = null;
      this.clockDirty = true;
      return true;
    }
    if (c && c.key === now.key) return false;
    const total = clockMs(this.env, now.kind);
    this.room.clock = { key: now.key, seat: now.seat, kind: now.kind, total, deadline: Date.now() + total };
    this.clockDirty = true;
    return true;
  }

  clockInfo() {
    const c = this.room.clock;
    return c ? { key: c.key, seat: c.seat, kind: c.kind, total: c.total, left: Math.max(0, c.deadline - Date.now()) } : null;
  }

  async flushClock() {
    if (!this.clockDirty) return;
    this.clockDirty = false;
    await this.save();
    await this.scheduleAlarm();
  }

  // 闹钟定在"倒计时到期"和"空房间到期"里较早的那个；没人连着的时候倒计时不走
  async scheduleAlarm() {
    const r = this.room;
    if (!r) return;
    let t = r.expireAt || Date.now() + ttlMs(this.env);
    if (r.clock && this.game && this.ctx.getWebSockets().length) t = Math.min(t, r.clock.deadline);
    await this.ctx.storage.setAlarm(t);
  }

  // 时间到：出牌阶段作废 1 次出牌（用完自动结束回合）；被询问时接受或按建议付款（不会替人出「反对行动」）；弃牌按建议弃
  async timeout() {
    const c = this.room.clock;
    const now = this.clockNow();
    if (!c || !now || now.key !== c.key) { this.syncClock(); return; }
    const acts = c.kind === 'play' ? [{ type: 'TIMEOUT_PLAY', player: c.seat }] : this.game.listActions(c.seat);
    const pick = (t) => acts.find((a) => a.type === t);
    const a = pick('TIMEOUT_PLAY') || pick('ACCEPT') || pick('PAY') || pick('DISCARD') || pick('FOLD');
    const r = a ? this.game.dispatch(a) : { ok: false };
    if (!r.ok) { // 不该发生；过一个时限再试，别卡在这里
      console.error('[monopoly-deal] 倒计时代操作失败', c.kind, r.error);
      c.deadline = Date.now() + c.total;
      return;
    }
    await this.commit(r, { timeout: { seat: c.seat, kind: c.kind, action: a.type } });
  }

  // 限速：每个连接每秒最多 20 个动作（令牌桶，突发上限 40）。正常手速碰不到，只挡异常客户端刷屏
  allow(ws) {
    const att = ws.deserializeAttachment() || {};
    const now = Date.now();
    const b = att.bucket || { n: 40, t: now };
    b.n = Math.min(40, b.n + ((now - b.t) / 1000) * 20);
    b.t = now;
    if (b.n < 1) return false;
    b.n -= 1;
    ws.serializeAttachment(Object.assign({}, att, { bucket: b }));
    return true;
  }

  // 表情：转发给房间里所有连接；每个连接至少间隔 1.2 秒
  async onEmote(ws, seat, msg) {
    if (EMOTES.indexOf(msg.e) < 0) return undefined;
    const att = ws.deserializeAttachment() || {};
    const now = Date.now();
    if (att.emoteAt && now - att.emoteAt < 1200) return undefined;
    ws.serializeAttachment(Object.assign({}, att, { emoteAt: now }));
    // 表情计数只算这一回合（换回合就清零）：一回合内发到第 6 个拿「表情大师」，每局每人一次（只在对局进行中计数）
    let count = 0;
    let award = false;
    if (this.game && this.game.phase !== 'gameOver') {
      const r = this.room;
      const turn = this.game.getView(null).turn.number;
      if (r.emoteTurn !== turn) { r.emoteTurn = turn; r.emotes = [0, 0]; }
      r.emotes = r.emotes || [0, 0];
      r.emoteAward = r.emoteAward || [false, false];
      count = ++r.emotes[seat];
      if (count >= 6 && !r.emoteAward[seat]) award = r.emoteAward[seat] = true;
    }
    for (const w of this.ctx.getWebSockets()) this.send(w, { t: 'emote', seat, e: msg.e, count });
    if (award) for (const w of this.ctx.getWebSockets()) this.send(w, { t: 'award', seat, award: 'emoteMaster' });
    if (count) await this.save();
    return undefined;
  }

  async onRematch(ws, seat) {
    if (!this.game || this.game.phase !== 'gameOver') return this.send(ws, { t: 'error', code: 'NOT_OVER', message: '这一局还没结束' });
    this.room.rematch[seat] = true;
    if (this.room.rematch[0] && this.room.rematch[1]) {
      this.startGame();
      this.syncClock();
      this.clockDirty = false;
      await this.save();
      this.broadcastWelcome();
      await this.scheduleAlarm();
    } else {
      await this.save();
      this.broadcastRoom();
    }
    return undefined;
  }

  // 闹钟响了：倒计时到期就替人做决定（两边都不在线就先暂停，有人连上再重新计时）；空房间到期自动清理，还有人连着就顺延
  async alarm() {
    await this.load();
    if (!this.room) return;
    const now = Date.now();
    const live = this.ctx.getWebSockets().length > 0;
    const c = this.room.clock;
    if (this.game && c && now >= c.deadline - 50) {
      if (live) await this.timeout();
      else { this.room.clock = null; await this.save(); }
    }
    if (now >= (this.room.expireAt || 0)) {
      if (!live) {
        await this.ctx.storage.deleteAll();
        this.room = null;
        this.game = null;
        return;
      }
      this.room.expireAt = now + 3600e3;
      await this.save();
    }
    await this.scheduleAlarm();
  }

  /* ── 下发 ── */

  seatOf(ws) {
    const a = ws.deserializeAttachment();
    return a && (a.seat === 0 || a.seat === 1) ? a.seat : null;
  }

  online(i, exclude) {
    return this.ctx.getWebSockets('seat' + i).some((w) => w !== exclude && w.readyState === 1);
  }

  roomInfo(exclude) {
    const r = this.room;
    return {
      id: r.id,
      preset: r.preset,
      round: r.round || 0,
      started: !!this.game,
      rematch: r.rematch.slice(),
      score: (r.score || [0, 0]).slice(),
      emotes: (r.emotes || [0, 0]).slice(),
      emoteAward: (r.emoteAward || [false, false]).slice(),
      players: r.seats.map((x, i) => (x ? { name: x.name, online: this.online(i, exclude) } : null)),
    };
  }

  snapshot(seat) {
    const g = this.game;
    const view = g.getView(seat);
    this.syncClock();
    return {
      room: this.roomInfo(),
      clock: this.clockInfo(),
      view,
      options: g.getOptions(seat),
      discardHint: view.phase === 'discard' && view.turn.player === seat ? g.suggestDiscard(seat) : null,
    };
  }

  welcome(seat) {
    const base = { t: 'welcome', seat, engine: MD.VERSION, room: this.roomInfo() };
    if (!this.game) return base;
    const log = this.game.getLog(seat).slice(-60).map((e) => this.game.describe(e, seat));
    return Object.assign(base, this.snapshot(seat), { log });
  }

  broadcastWelcome() {
    for (const w of this.ctx.getWebSockets()) {
      const s = this.seatOf(w);
      if (s != null) this.send(w, this.welcome(s));
    }
  }

  broadcastRoom(exclude) {
    const msg = { t: 'room', room: this.roomInfo(exclude) };
    for (const w of this.ctx.getWebSockets()) if (w !== exclude) this.send(w, msg);
  }

  send(ws, msg) {
    try {
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } catch (e) { /* 对方已断开 */ }
  }
}
