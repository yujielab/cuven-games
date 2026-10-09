/*!
 * monopoly-deal-worker.js — Monopoly Deal 对战后端 v1.16.0（Cloudflare Worker + Durable Object）
 *
 * 一个文件包含：规则引擎（v1.14.0；含 3 张自定义行动卡、追赶机制、赌一把、奖池、加注、大乐透、秘密竞价、赌场礼赠、抵押、恶意收购（轮盘赌）、拍卖、成就、出牌超时，
 * 以及 AI 对手 botChoose）+ HTTP 接口（建房、加入、全球匹配 /api/match、请 AI 入座 /api/rooms/:id/bot）+ 房间 Durable Object（WebSocket 对战）。
 * 全球匹配和房间共用同一个 Durable Object 类和绑定（排队处是名为 __match__ 的那个对象），部署不需要新增任何绑定。
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
 *     TURN_SECONDS     单张出牌的时限（默认不限时；设 5–600 秒开启）：超时作废 1 次出牌，次数用完自动结束回合
 *     RESPOND_SECONDS  回应、弃牌的时限（默认 25，可设 5–600，0 = 不限时）：超时自动接受 / 按建议付款 / 按建议弃牌
 *     CLAIM_SECONDS    对手离线满多少秒后，在线的一方可以申请判胜（默认 300 = 5 分钟，可设 1–3600）
 *   Telegram 表情包（聊天里发贴纸；不配就不显示）：
 *     TG_BOT_TOKEN     【机密 / Secret】任意一个 Telegram 机器人的 token（找 @BotFather 建一个）。只在服务器上用来读表情包，绝不发给浏览器
 *     TG_STICKER_SETS  要用的表情包名字，逗号分隔、最多 8 个（就是 t.me/addstickers/<名字> 里的那段）
 *     TG_EMOJI_SET     对局里表情面板（顶栏笑脸）用的 Telegram 自定义表情包名字（t.me/addemoji/<名字> 里的那段），默认 GameEmoji；
 *                      设成 off 就用回系统自带的 12 个表情。同样要 TG_BOT_TOKEN
 *     TG_CHIP_SET      筹码图标（名字旁边那一排：满 / 半 / 空）用的 Telegram 自定义表情包名字，取前三个（金 / 银 / 铜），默认 ParisOlympicEmoji；
 *                      设成 off 就用 CONFIG.ART 里的图（电力.png / 半电力.png）或内置图标
 *     TG_FACE_SET      中央指示器里表现对方状态的表情（得手、被抢、思考、离线……）用的 Telegram 自定义表情包，默认 HandDrawnEmoji；设成 off 就只有箭头
 *     TG_API           可选：Telegram API 地址（默认 https://api.telegram.org；想走自己的转发 Worker 就填它的地址）
 *     LOTTIE_URL       可选：自己托管的 lottie_light.min.js（lottie-web 5.13.0，放 R2 上就行）。动画贴纸靠它播放；不填就从 jsDelivr / unpkg 取。
 *                      不管从哪取，服务器都会核对文件指纹（SHA-384），对不上就不用
 *   卡牌 PNG 不经过 Worker：前端直接从 R2 自定义域名加载（见前端文件顶部 CONFIG）。
 *   部署后浏览器打开 /api/health 自检：会逐项说明绑定、房间对象、变量是否正常。
 *
 * ━━━━━━━━━━━━━━━━━━━━ HTTP 接口（均支持 CORS） ━━━━━━━━━━━━━━━━━━━━
 *   GET  /api/health                            自检（绑定 / 房间对象 / 变量）
 *   GET  /api/meta                              牌面数据、颜色、图片清单、规则（前端启动时拉一次）
 *   POST /api/rooms           { name, preset?, claim? }  建房 → { roomId, seat: 0, token }；preset: 'balanced' | 'official'
 *   GET  /api/rooms/:code                            房间状态 → { players: [{ name, online } | null], started, phase, … }
 *   POST /api/rooms/:code/join { name, token?, claim?, seat? }  加入 → { roomId, seat, token }；带上已有 token = 回到原座位
 *                                                    claim：客户端预先生成的 32 位十六进制凭证，网络重试时不会被当成第三个人
 *                                                    seat：房间满了、本机又没有凭证（换了浏览器 / 清了缓存）时拿回这个座位——
 *                                                    只有这个座位现在离线才行（在线 → SEAT_ONLINE），旧凭证随即作废
 *   POST /api/match           { name, preset?, claim?, rec?, pid? }  全球匹配；pid = 设备编号，不会把同一台设备配给自己
 *   POST /api/match/cancel    { roomId }             取消排队
 *   POST /api/rooms/:code/bot { token, rec? }        排队没等到真人：请 AI 对手入座（只有房主能请）
 *   GET  /api/stickers                               配好的 Telegram 表情包清单 { sets: [{ name, title, stickers: [{ id, emoji, kind }] }], emotes: 同样格式的一套或 null }（没配 = 空）
 *   GET  /api/stickers/img/:id[?thumb=1]             表情图片（只给清单里的；kind: static = webp，video = webm，animated 给静态缩略图），边缘缓存一年
 *   GET  /api/stickers/anim/:id                      动画贴纸（kind: animated，Telegram 的 .tgs）解压成 Lottie JSON，前端用 lottie 播放
 *   GET  /api/stickers/player.js?v=5.13.0            Lottie 播放器（lottie_light，只有 SVG 渲染、不执行表达式），核对过指纹再给；国内打不开外国 CDN 也能用
 *   GET  /api/rooms/:code/ws?token=…&v=2&last=n      WebSocket 对战连接；v=2 = 联机协议 v2（增量 + 校验 + 断线补课 + 聊天），
 *                                                    last = 客户端看到的最后一次更新编号（手里有局面时才带）
 *   出错统一返回 { ok: false, error: { code, message } }，message 是中文。
 *
 * ━━━━━━━━━━━━━━━━━━━━ WebSocket 消息 ━━━━━━━━━━━━━━━━━━━━
 *   客户端 → 服务器
 *     'ping'                                      心跳（运行时自动回 'pong'，不唤醒对象）
 *     { t: 'act', id, aid?, action: { type, …参数 } }   出牌等动作（格式同引擎 dispatch，player 不用填）
 *                                                 aid：动作的唯一编号，断线后原样重发，同一个 aid 只执行一次
 *     { t: 'rematch' }                            再来一局（双方都发了才开新局）
 *     { t: 'emote', e } / { t: 'emote', s }       发表情（e：内置的 12 个之一；s：表情面板那套自定义表情里的 id；每人至少间隔 1.2 秒）
 *     { t: 'sync' }                               重新要一份完整状态
 *     { t: 'who' }                                问一下双方在线状态（回 { t: 'room' }）；等对手时客户端每 15 秒问一次
 *     { t: 'claim' }                              对手离线满 CLAIM_SECONDS：申请判胜（服务器替对手认输，结束原因 'away'）
 *     { t: 'chat', text, cid }                    聊天（v2；最长 120 字，每 1.5 秒 1 条、最多连发 4 条；cid 客户端自编号，用来认回自己那条）
 *     { t: 'chat', sticker: id, cid }             发一个 Telegram 表情（只能是 /api/stickers 清单里的）
 *   服务器 → 客户端
 *     { t: 'welcome', seat, room, view?, options?, discardHint?, log? }   连上时 / 开新局时的完整状态
 *     { t: 'update', events, lines, room, view, options, discardHint }    每次有人动作后（events 已按座位脱敏，lines 是中文日志）
 *     { t: 'room', room }                                                  在线状态 / 再来一局意向变化
 *     { t: 'emote', seat, e, s?, k?, count }                               有人发了表情（s / k：自定义表情的 id 和种类，e 是它对应的系统表情；count = 他这局发的第几个）
 *     { t: 'award', seat, award: 'emoteMaster' }                           有人一回合内发了 5 个以上表情，拿到「表情大师」
 *     { t: 'ack', id, ok, error? }                                         自己动作的结果
 *     { t: 'error', code, message }    { t: 'fatal', code, message }（随后断开，如房间已过期 / 凭证无效）
 *     { t: 'replaced' }                    同一个座位在别的窗口 / 设备上连上了，这条连接随即断开（客户端不要自动重连）
 *   v2 另外：
 *     welcome / update 都带 n（更新编号）和 hash（局面校验值）；update 有 base 时局面字段换成 patch（相对编号 base 那次的增量，null = 没变）
 *     { t: 'update', catchup: k, … 完整局面 }   断线期间错过的 k 次更新合成一条（事件按顺序拼起来）
 *     { t: 'resume', n, hash, room, clock }      断线期间什么都没错过：核对 hash 就接着用手里的局面
 *     { t: 'chatlog', list }  { t: 'chat', m: { id, seat, text, at }, cid? }  { t: 'chatNo', cid, message }   聊天记录 / 新消息 / 被限速
 *   room = { id, preset, round, started, mode: 'room' | 'match', rematch: [bool, bool], score: [分, 分]（每局赢家得这局的分值，加注后会翻倍）,
 *            emotes: [这一回合的表情数, …], claimAfter: 毫秒, players: [{ name, online, away?: 离线了多少毫秒 } | null, …] }
 *   在线：同一个座位只留最新一条连接；连接还挂着但 75 秒没有心跳也算离线（手机断网、App 被挂起时服务器收不到断开事件）
 *
 * ━━━━━━━━━━━━━━━━━━━━ 联机规则 ━━━━━━━━━━━━━━━━━━━━
 *   被收钱 / 被偷 / 被抢时，一律由被针对的人亲自点「接受 / 付款 / 反对行动」（autoResolve: false）：
 *   如果没有「反对行动」就秒结算，等于告诉对方你手里没有「反对行动」。
 *   出满 3 张（且没有待回应的行动）自动结束回合（autoEndTurn: true）。
 *   几率一律不公开、而且是动态的（"手气"，见引擎里的 chance）：每个靠几率的机制都以规则里的 xxxChance 为基准，
 *     同一个人连续落空就越来越容易中，刚中过下一次难一点，地产进度落后的一方更容易中好结果。只在服务器上掷，
 *     几率、保底次数和手气计数都不进玩家视角，/api/meta 也不给。双方用同一套公式。
 *   追赶机制（comeback: true），双方完全对称，只帮落后的一方；满足条件时按手气几率触发（基准 comebackChance: 20）：
 *     逆风补给  回合开始时，对手比你多 2 套以上完整地产 → 这回合多摸 1 张
 *     背水一战  回合开始时，对手只差一套就赢、而你比他少 → 这回合可以出 4 张
 *   赌一把（gamble: true）：打出收钱的牌（租金 / 讨债人 / 生日）时可以选押 ×2 或 ×4，每回合最多一次。
 *     押 ×m 的基准几率是 1/m，实际按手气现算（开局有一点新手手气）；赢了这次收 m 倍，输了这张牌（连同叠的「租金翻倍」）作废。
 *     双方规则一样；用对局自己的随机数在服务器上结算，客户端改不了。
 *   奖池（jackpot: true）：每次有人赌输，奖池 +1 张（最多 3 张）；下一个押 ×4 赌赢的人把奖池里的张数全部摸走。
 *   加注（doubling: true，规则同双陆棋的加倍方块）：在自己回合开始、还没出牌时，可以把这局的分值翻倍（最高 ×8）。
 *     对方选「跟注」：继续打，这局赢家得翻倍后的分，之后只有跟注的一方能再加注；
 *     选「弃牌」：这局直接输，按加注前的分值算。房间战绩按分累计。
 *   大乐透（lottery: true）：收租结算时按手气几率（基准 lotteryChance: 15）额外中一笔彩票奖金，金额 5–20M 随机，
 *     从抽牌堆和弃牌堆里的钱币随机凑出这个数（凑不满就给凑得出的最多），直接进收租人的银行。双方规则一样。
 *     保底（lotteryPity: 4，不公开）：每人各自计数，连续收租 4 次都没中，第 4 次必中；中了（或保底）就重新计数。
 *   成就（每局每人每项一次，只是荣誉，不影响规则）。全部只在自己的一个回合之内计数，回合开始时重新算：
 *     超级大盗  一回合内让对方损失超过 10M（收到的钱、偷走 / 抢走 / 毁掉的地产按面值算），或抢走一整套地产
 *     破坏大师  回合开始时对方桌上有地产，这回合内被你清到一张不剩
 *     超级金库  回合开始时对方银行里有钱，这回合内被你搬空；或者这回合内自己的银行超过 30M（回合开始时还不到）
 *     表情大师  一回合内发了 5 个以上表情（服务层计数，见 room.emotes / room.emoteAward）
 *   秘密竞价（auction: true）：双方同时有同一种颜色的完整套（没抵押的）就触发。双方各从银行里挑牌暗标出价，
 *     都出完后亮价：出价高的拿走双方的出价，并毁掉对方那套（连同房屋、旅馆进弃牌堆）；一样多就各自退回。
 *     同一段"双方都有"只竞价一次，有一方没了这套、之后再凑齐才会再触发。
 *   赌场礼赠（casinoGift: true）：同一个人连续 3 次押 ×4 赌一把（输赢都算，押一次 ×2 就重新数），下回合开始拿到一份礼赠，
 *     可以自己打开或送给对方（对方不能拒收，强制打开）。打开时好坏按打开的人的手气几率（基准好结果 40%），
 *     再在这一类里从用得上的等概率抽一种。坏结果：清空打开方的银行和地产、抵押打开方租金最高的一套完整地产
 *     （两样都无从谈起时是空盒）；好结果：一整套地产、4 种颜色的地产各一张、一张 10M 行动卡、一张行动卡、
 *     两张「反对行动」、两张全色租金、银行进账 20M。牌都从抽牌堆 / 弃牌堆里拿。
 *   抵押：抵押中的那套收不了租，也不算胜利套数；满 5 个回合后付原价租金（满套租金）赎回，之前赎回付双倍，钱进弃牌堆。
 *   恶意收购（takeover: true）：开局随机定一种地产颜色（公开，view.takeover.color）。整局第一次有人集齐这种颜色的完整套就触发（整局一次）：
 *     双方银行 + 桌上的地产（连同房屋、旅馆）立即按面值折成筹码（牌进弃牌堆），开始轮盘赌——触发的人先玩，另一个人后玩，一方玩一方看。
 *     每人至少 1 局、最多 3 局，每局押 1–20M（不超过手上的筹码），三选一：押红 / 黑 / 单 / 双，中了押的筹码翻倍；
 *     押一个具体数字，中了 ×5、立即结束他的轮盘赌，另外拿到所有颜色的地产各一张 + 一张 10M 行动卡（破产 / 清算）；
 *     开出绿色 0 筹码清零、立即结束。每局开奖后可以带着筹码离开（SPIN 之后才能 CASH_OUT），筹码立即换成钱存进银行；
 *     打满 3 局自动离开，筹码输光就结束。动作：{ type: 'SPIN', pick: 'red' | 'black' | 'odd' | 'even' | 数字, wager }、{ type: 'CASH_OUT' }。
 *     几率（押红黑单双中 55%、押数字中 15%、开出 0 有 30%）不公开；轮盘上的数字见 /api/meta 的 roulette。
 *   拍卖（sale: true）：双方桌上同时有 ≥2 种相同颜色的地产（各自都有这种颜色，不必成套）时掷一次 saleChance（70%，不公开），整局只掷一次，
 *     没中这局就没有拍卖。中了：从双方都有的颜色里随机挑一种，从抽牌堆 / 弃牌堆拿一张这种颜色的地产公开拍卖。起拍价 0，双方轮流出价
 *     （刚出过价的人等对方加价），每次至少比当前最高价多 1M，不能超过自己银行里的钱。开拍 8 秒没人出价就流拍；有人出价后 6 秒没人加价就成交；
 *     加价没有上限，但整场最长 30 分钟，到点按当前最高价成交。成交时从银行里挑刚好够、张数最少的牌付款（不找零，钱进弃牌堆），拍品进他的地产区。
 *     动作：{ type: 'SALE_BID', amount }。计时由服务器管：到点服务器发 SALE_CLOSE 落槌（客户端发来的会被拒绝）；倒计时在 clock 里（kind 'sale'）。
 *   一回合只触发一个机制：追赶、赌一把（含奖池）、大乐透、秘密竞价、赌场礼赠、拍卖，同一回合里最多出现一个，互不叠加（恶意收购不占名额）。
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

  const VERSION = '1.14.0';

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
  const BETS = [2, 4];  // 赌一把可以押的倍数：押 ×m 的基准几率是 1/m，实际按手气现算
  const AWARDS = { thief: '超级大盗', destroyer: '破坏大师', vault: '超级金库' }; // 引擎负责的成就（表情大师在服务层）


  const PENDING_ACTIONS = ['rent', 'debtCollector', 'birthday', 'slyDeal', 'forcedDeal', 'dealBreaker', 'bankruptcy', 'liquidation', 'hugeWin', 'raise', 'auction', 'gift', 'tycoon', 'takeover', 'sale'];
  // 恶意收购的轮盘：和前端那张内盘图上的格子一一对应（从 0 开始顺时针）。这张图只有 31 格，没有 3、7、12、28、29、35
  const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 26];
  const WHEEL_RED = [32, 19, 21, 25, 34, 27, 36, 30, 23, 5, 16, 1, 14, 9, 18];
  const ROULETTE_PICKS = ['red', 'black', 'odd', 'even']; // 押颜色 / 单双；押具体数字时 pick 是那个数
  const ROULETTE_HIT = 5; // 押中数字：押的筹码 ×5
  // 赌场礼赠里可能开出的东西：先按 giftBadChance 定好坏，再在这一类里从当下用得上的等概率抽一种
  const GIFTS = ['fullSet', 'fourProps', 'wipe', 'bigAction', 'action', 'jsn', 'wildRent', 'cash', 'mortgage'];
  const BAD_GIFTS = ['wipe', 'mortgage'];
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
    forcedDealFromOwnFullSet: false, // 强买强卖时能否拿自己完整套里的牌去换
    payWithBuildings: true,          // 房屋 / 旅馆能否拿来付款（收款方存入银行）
    autoResolve: true,               // 被询问方只有唯一选择时自动结算：没有「反对行动」就自动接受；桌面不够付就自动全付
    stalemateTurns: 6,               // 牌堆和弃牌堆都空、连续这么多回合没人出牌 → 判平局；双方都没手牌时立即判。0 = 关闭
    maxTurns: 0,                     // >0 时超过该回合数判平局，0 = 不限
    logLimit: 400,                   // 内置日志最多保留条数，0 = 不限
    autoEndTurn: false,              // 出牌次数用完（且没有待回应的行动）时自动结束回合
    comeback: false,                 // 追赶机制：落后 2 套以上回合开始多摸 1 张（逆风补给）；对手到赛点时本回合多出 1 张（背水一战）
    comebackChance: 20,              // 追赶机制的基准几率（%），实际按手气现算（见 chance）；不公开
    luckSeat: -1,                    // 暗中照顾哪个座位（-1 = 谁都不照顾）：对 AI 时动态难度用（可能照顾 AI，也可能照顾玩家），不公开
    luckEdge: 0,                     // 照顾多少：这个座位所有几率 +luckEdge 个百分点、对方 -luckEdge（0–40）；不公开
    drawSeat: -1,                    // 摸牌照顾哪个座位（-1 = 不照顾）：对 AI 的前几局用，不公开
    drawEdge: 0,                     // 照顾多少：被照顾的一方从牌堆顶 drawEdge+1 张里挑最好的、另一方挑最差的（0–8，含开局发牌）；不公开
    gamble: false,                   // 赌一把：收钱的牌可以押 ×2 或 ×4（几率按手气现算、不公开），输了这张牌作废；每回合最多一次
    jackpot: false,                  // 奖池：每次赌输奖池 +1 张，下一个押 ×4 赌赢的人全部摸走
    potMax: 3,                       // 奖池最多攒几张
    doubling: false,                 // 加注：自己回合开始时可以把这局分值翻倍，对方跟注或弃牌（双陆棋的加倍方块）
    maxStake: 8,                     // 一局最高几倍
    lottery: false,                  // 大乐透：收租结算时按几率额外中一笔彩票奖金（从牌堆 / 弃牌堆里的钱凑）
    lotteryChance: 15,               // 每次收租中奖的基准几率（%），实际按手气现算；不公开
    lotteryPity: 4,                  // 保底：同一个人连续收租这么多次都没中，这一次必中（0 = 不保底）
    lotteryMin: 5,                   // 奖金下限（M）
    lotteryMax: 20,                  // 奖金上限（M）
    auction: false,                  // 秘密竞价：双方同时有同一种颜色的完整套时触发，暗标出价，出价高的拿走双方出价并毁掉对方那套
    casinoGift: false,               // 赌场礼赠：同一个人连续 giftStreak 次押 ×4 赌一把，下回合开始拿到一份礼赠（自己打开或送给对方）
    giftStreak: 3,                   // 连续几次押 ×4 换一份礼赠
    giftBadChance: 60,               // 礼赠开出坏结果（清空 / 抵押）的基准几率（%），实际按打开的人的手气现算；不公开
    mortgageTurns: 5,                // 抵押：满这么多回合后按原价租金赎回，之前赎回要付双倍
    power: false,                    // 电力系统：被对方拿走 / 毁掉东西时攒电力（电力保险），攒满收租 ×surgeMult
    powerCap: 3,                     // 电力上限（点）。内部按半点记，到上限后溢出的不算
    insuranceStep: 3,                // 电力保险：每失去这么多 M（付出去的、被偷 / 被抢 / 被毁的面值），电力 +0.5
    surgeMult: 2,                    // 电力满格：收租乘几倍（不论是否成套）
    surgeTurns: 2,                   // 满格加成：除了攒满的那个回合，之后再持续几个自己的回合；结束时电力清零
    ghostKit: false,                 // 捉鬼套装：累计从对方银行拿走 / 让对方失去的面值超过门槛就触发一次老虎机抽奖
    ghostStep: 10,                   // 门槛：第 1 次 10M、第 2 次 20M、第 3 次 30M……（每触发一次 +ghostStep，没有上限）；触发后累计清零
    ghostGoodChance: 40,             // 抽奖好结果的基准几率（%，实际按手气现算，不公开）：多拿两张讨债人；其余是坏结果：失去随机颜色的一张地产
    tycoon: false,                   // 贪婪大亨：每局最先累计从对方那里拿到（偷、抢、强买强卖换来、对方用地产付给你）超过 tycoonAt 地产面值的人，触发一次（整局只有一次）
    tycoonAt: 18,                    // 门槛（M，超过才算）
    vampireStep: 3,                  // 选了吸血：对方每往银行存这么多 M，吸血的一方白拿 1M
    tycoonCash: 50,                  // 选了套现：按自己现有地产总值的这个百分比（向上取整）存进银行
    takeover: false,                 // 恶意收购：开局随机定一种颜色，谁先集齐这种颜色的完整套就触发轮盘赌（整局一次）
    rouletteMin: 1,                  // 轮盘赌每局最少押多少（M）
    rouletteMax: 20,                 // 每局最多押多少（M）
    rouletteSpins: 3,                // 每人最多玩几局（至少一局）
    rouletteEvenChance: 55,          // 押红黑 / 单双中奖的几率（%）；不公开
    rouletteNumberChance: 15,        // 押具体数字中奖的几率（%）；不公开
    rouletteZeroChance: 30,          // 开出绿色 0（筹码清零）的几率（%），押什么都一样；不公开
    sale: false,                     // 拍卖：双方桌上有 ≥2 种相同颜色的地产时掷一次（整局只掷一次），中了就从牌堆 / 弃牌堆里拿一张这种颜色的地产公开拍卖
    saleChance: 70,                  // 拍卖触发的几率（%）；不公开
    saleOpenSeconds: 8,              // 开拍后这么多秒没人出价就流拍
    saleHoldSeconds: 6,              // 有人出价后这么多秒没人加价就成交
    saleMaxMinutes: 30,              // 一场拍卖最长多少分钟（到点按当前最高价成交）
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
    luckSeat: [-1, 1],
    luckEdge: [0, 40],
    drawSeat: [-1, 1],
    drawEdge: [0, 8],
    potMax: [1, 10],
    maxStake: [2, 64],
    lotteryChance: [0, 100],
    lotteryPity: [0, 20],
    lotteryMin: [1, 57],
    lotteryMax: [1, 57],
    giftStreak: [1, 20],
    giftBadChance: [0, 100],
    mortgageTurns: [1, 50],
    powerCap: [1, 10],
    insuranceStep: [1, 60],
    surgeMult: [1, 20],
    surgeTurns: [1, 20],
    ghostStep: [1, 200],
    ghostGoodChance: [0, 100],
    tycoonAt: [1, 200],
    vampireStep: [1, 50],
    tycoonCash: [0, 100],
    rouletteMin: [1, 20],
    rouletteMax: [1, 100],
    rouletteSpins: [1, 10],
    rouletteEvenChance: [0, 100],
    rouletteNumberChance: [0, 100],
    rouletteZeroChance: [0, 100],
    saleChance: [0, 100],
    saleOpenSeconds: [3, 120],
    saleHoldSeconds: [2, 120],
    saleMaxMinutes: [1, 240],
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
  deepFreeze(WHEEL);
  deepFreeze(WHEEL_RED);

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
    BAD_PICK: '押注方式不对：押红 / 黑 / 单 / 双，或者押轮盘上的一个数字（不能押 0）',
    BAD_WAGER: '押注金额不对',
    MUST_SPIN: '至少要转一局才能离开',
    SALE_LEADING: '你现在就是最高出价，等对方加价',
    SALE_TOO_LOW: '出价至少要比当前最高价多 1M',
    SALE_NO_MONEY: '银行里的钱不够出这个价（只能用银行里的钱）',
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
  const newStats = () => ({ cardsPlayed: 0, received: 0, paid: 0, biggestHit: 0, steals: 0, setsStolen: 0, justSayNo: 0, bets: 0, betsWon: 0, dealt: 0, lottery: 0, lottoMiss: 0, x4Streak: 0, ...newLuck() });
  // 手气计数（见 chance）：>0 连续落空几次，-1 刚中过。赌一把一开局就是 2（新手手气）。只在服务器上，视角里看不到
  function newLuck() { return { luckGamble: 2, luckGhost: 0, luckLottery: 0, luckGift: 0, luckComeback: 0 }; }
  const LUCK_KEYS = Object.keys(newLuck());

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
      auctioned: (s.auctioned || []).slice(),
      tycoon: s.tycoon ? Object.assign({}, s.tycoon) : null,
      takeover: s.takeover ? Object.assign({}, s.takeover) : null,
      sale: Object.assign({}, s.sale),
      seq: s.seq,
      log: s.log,
    };
  }

  function clonePlayer(p) {
    return {
      name: p.name,
      hand: p.hand.slice(),
      bank: p.bank.slice(),
      sets: p.sets.map((x) => ({ id: x.id, color: x.color, cards: x.cards.slice(), house: x.house, hotel: x.hotel, mortgage: x.mortgage ? { turn: x.mortgage.turn } : null })),
      loose: p.loose.slice(),
      stats: Object.assign({}, p.stats),
      boost: p.boost ? { mult: p.boost.mult, colors: p.boost.colors.slice() } : null,
      awards: p.awards.slice(),
      gift: p.gift || 0,
      power: p.power,
      lost: p.lost,
      haul: p.haul,
      ghostN: p.ghostN,
      curse: p.curse,
      grab: p.grab,
      surge: p.surge ? { left: p.surge.left, since: p.surge.since } : null,
    };
  }

  // 电力系统 / 捉鬼套装的个人状态。power 按半点记（0–powerCap×2）；lost：失去了、还没凑满一档电力保险的面值；
  // surge：满格加成 { left: 还剩几个自己的回合, since: 攒满的那个回合号 }；haul：上次触发捉鬼套装后，累计从对方拿走 / 让对方失去的面值；
  // ghostN：捉鬼套装触发过几次（门槛跟着涨）；curse：下回合开始要摸的 1M 张数（捉鬼套装坏结果、又没有地产可丢时）；
  // grab：累计从对方那里拿到的地产面值（贪婪大亨）
  function newPower() { return { power: 0, lost: 0, haul: 0, ghostN: 0, curse: 0, grab: 0, surge: null }; }

  function clonePending(pd) {
    const c = Object.assign({}, pd);
    c.doubles = pd.doubles.slice();
    c.chain = pd.chain.map((x) => ({ player: x.player, cardId: x.cardId }));
    if (pd.bids) c.bids = pd.bids.map((b) => (b ? b.slice() : null));
    if (pd.sets) c.sets = pd.sets.slice();
    if (pd.action === 'takeover') { // 轮盘赌：双方各自的筹码、局数、是否玩完
      for (const k of ['order', 'chips', 'start', 'spins', 'done']) c[k] = pd[k].slice();
      c.result = pd.result.map((r) => (r ? Object.assign({}, r) : null));
      c.last = pd.last ? Object.assign({}, pd.last) : null;
    }
    if (pd.action === 'sale') c.history = pd.history.map((h) => Object.assign({}, h)); // 拍卖：出价记录
    return c;
  }

  // 旧版存档补字段（1.0 → 1.1）
  function migrate(s) {
    if (s.pending && s.pending.kind && !s.pending.action) {
      s.pending.action = { debt: 'debtCollector', sly: 'slyDeal', forced: 'forcedDeal' }[s.pending.kind] || s.pending.kind;
      delete s.pending.kind;
    }
    if (Array.isArray(s.players)) s.players.forEach((p) => { if (p && typeof p === 'object') { p.stats = Object.assign(newStats(), p.stats); if (!p.boost) p.boost = null; if (!Array.isArray(p.awards)) p.awards = []; if (!Number.isInteger(p.gift)) p.gift = 0; for (const [k, v] of Object.entries(newPower())) if (k === 'surge' ? p.surge === undefined : !Number.isInteger(p[k])) p[k] = v; } });
    if (!Array.isArray(s.auctioned)) s.auctioned = [];
    if (s.tycoon === undefined) s.tycoon = null;
    if (s.takeover === undefined) s.takeover = null; // 旧存档：这局没有恶意收购
    if (!s.sale || typeof s.sale !== 'object') s.sale = { rolled: false }; // 旧存档：拍卖还没掷过
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
      if (!Number.isInteger(p.gift) || p.gift < 0) bad(`玩家 ${i} 的赌场礼赠数无效`);
      if (!Number.isInteger(p.power) || p.power < 0 || p.power > s.rules.powerCap * 2) bad(`玩家 ${i} 的电力无效`);
      for (const k of ['lost', 'haul', 'ghostN', 'curse', 'grab']) if (!Number.isInteger(p[k]) || p[k] < 0) bad(`玩家 ${i} 的 ${k} 无效`);
      if (p.surge != null && (typeof p.surge !== 'object' || !Number.isInteger(p.surge.left) || p.surge.left < 0 || !Number.isInteger(p.surge.since))) bad(`玩家 ${i} 的满格加成无效`);
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
        if (x.mortgage != null && (typeof x.mortgage !== 'object' || !Number.isInteger(x.mortgage.turn))) bad(`地产组 ${x.id} 的抵押数据无效`);
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
    if (!Array.isArray(s.auctioned) || !s.auctioned.every(isColor)) bad('auctioned 无效');
    const ty = s.tycoon;
    if (ty != null && (typeof ty !== 'object' || !isPlayer(ty.player) || [null, 'vampire', 'cash'].indexOf(ty.mode) < 0 || !Number.isInteger(ty.depo) || ty.depo < 0 || !Number.isInteger(ty.owed) || ty.owed < 0)) bad('贪婪大亨数据无效');
    const tk = s.takeover;
    if (tk != null && (typeof tk !== 'object' || !isColor(tk.color) || !(tk.player == null || isPlayer(tk.player)))) bad('恶意收购数据无效');
    if (!s.sale || typeof s.sale !== 'object' || typeof s.sale.rolled !== 'boolean') bad('拍卖数据无效');
    return out;
  }

  function validatePending(s) {
    const pd = s.pending;
    if (!pd || typeof pd !== 'object') return '回应阶段缺少 pending';
    if (PENDING_ACTIONS.indexOf(pd.action) < 0) return `未知的待回应行动 ${pd.action}`;
    if (!s.turn || pd.actor !== s.turn.player || pd.target !== other(pd.actor)) return 'pending 双方与回合不符';
    if (!Array.isArray(pd.chain) || !Array.isArray(pd.doubles)) return 'pending 结构损坏';
    const A = s.players[pd.actor];
    const T = s.players[pd.target];
    if (!A || !T || !Array.isArray(A.sets) || !Array.isArray(T.sets)) return 'pending 指向的玩家无效';
    if (pd.action === 'auction') { // 秘密竞价：双方各出一次价，顺序不限
      if (!isColor(pd.color) || !Array.isArray(pd.bids) || pd.bids.length !== 2 || !Array.isArray(pd.sets) || pd.sets.length !== 2) return '竞价数据损坏';
      for (const i of [0, 1]) {
        const b = pd.bids[i];
        if (b != null && (!Array.isArray(b) || !b.every((id) => s.players[i].bank.indexOf(id) >= 0))) return '竞价出的牌不在银行里';
        const x = s.players[i].sets.find((y) => y && y.id === pd.sets[i]);
        if (!x || !isFull(x) || x.color !== pd.color) return '竞价的地产已失效';
      }
      return isPlayer(pd.awaiting) && pd.bids[pd.awaiting] == null ? null : '竞价轮到的人已经出过价';
    }
    if (pd.action === 'gift') return pd.awaiting === pd.actor && s.players[pd.actor].gift > 0 ? null : '赌场礼赠数据异常';
    if (pd.action === 'tycoon') return s.tycoon && !s.tycoon.mode && pd.awaiting === s.tycoon.player ? null : '贪婪大亨数据异常';
    if (pd.action === 'takeover') { // 轮盘赌：按 order 轮流，轮到的是第一个还没玩完的人
      const tk = s.takeover;
      if (!tk || !isPlayer(tk.player) || pd.color !== tk.color) return '恶意收购数据异常';
      const arr = (k, ok) => Array.isArray(pd[k]) && pd[k].length === 2 && pd[k].every(ok);
      const nat = (x) => Number.isInteger(x) && x >= 0;
      if (!arr('order', isPlayer) || pd.order[0] !== tk.player || pd.order[1] !== other(tk.player)) return '轮盘赌顺序异常';
      if (!arr('chips', nat) || !arr('start', nat) || !arr('spins', (x) => nat(x) && x <= s.rules.rouletteSpins) || !arr('done', (x) => typeof x === 'boolean') || !Array.isArray(pd.result) || pd.result.length !== 2) return '轮盘赌数据损坏';
      const next = pd.order.find((p) => !pd.done[p]);
      return next != null && pd.awaiting === next && pd.spins[next] < s.rules.rouletteSpins && pd.chips[next] >= s.rules.rouletteMin && pd.chips[next] > 0 ? null : '轮盘赌轮到的人不对';
    }
    if (pd.action === 'sale') { // 拍卖：拍品还在抽牌堆 / 弃牌堆里（成交才拿出来），最高价不超过领先者银行里的钱
      if (!isColor(pd.color) || !isCardId(pd.cardId) || !isProp(pd.cardId) || colorsOf(pd.cardId).indexOf(pd.color) < 0) return '拍品无效';
      if (s.deck.indexOf(pd.cardId) < 0 && s.discard.indexOf(pd.cardId) < 0) return '拍品已经不在牌堆里';
      if (!Number.isInteger(pd.amount) || pd.amount < 0 || !Number.isInteger(pd.step) || pd.step < 0 || !Array.isArray(pd.history)) return '拍卖数据损坏';
      if (pd.leader == null) return pd.amount === 0 && pd.awaiting === pd.actor ? null : '拍卖数据损坏';
      if (!isPlayer(pd.leader) || pd.awaiting !== other(pd.leader)) return '拍卖轮到的人不对';
      return sum(s.players[pd.leader].bank) >= pd.amount ? null : '最高出价超过了银行里的钱';
    }
    if (pd.awaiting !== (pd.chain.length % 2 ? pd.actor : pd.target)) return 'pending.awaiting 与「反对行动」链不符';
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
    for (const set of s.players[pi].sets) if (set.color === color && !set.mortgage) best = Math.max(best, setRent(s, set)); // 抵押中的套收不了租
    return best;
  }

  // 赎回抵押：满 mortgageTurns 回合后付这套的原价（满套租金），之前赎回付双倍
  function redeemCost(s, set) {
    const c = COLORS[set.color];
    const base = c.rent[c.size - 1];
    return s.turn.number - set.mortgage.turn >= s.rules.mortgageTurns ? base : base * 2;
  }

  // Huge Win 加成：按这个颜色收租时乘几倍（没有加成就是 1）
  function boostFor(s, pi, color) {
    const b = s.players[pi].boost;
    return b && b.colors.indexOf(color) >= 0 ? b.mult : 1;
  }

  function fullColors(s, pi) {
    const out = [];
    for (const set of s.players[pi].sets) if (isFull(set) && !set.mortgage && out.indexOf(set.color) < 0) out.push(set.color); // 抵押中的套不算胜利条件
    return out;
  }
  // ─── 手气：隐藏的动态几率 ───
  // 靠几率的机制（赌一把、捉鬼套装、大乐透、赌场礼赠、追赶机制）都不用固定几率，每次按当时的局面现算，只在服务器上掷：
  //   连续落空  同一个人同一种机制每落空一次，下一次更容易中（dry）
  //   刚中过    中了之后的下一次难一点（cool）
  //   局面      地产进度落后的一方更容易中好结果，领先的一方更难（swing，进度差最多算 2 套）
  // 规则里的 xxxChance 只是基准值。几率和计数都不进玩家视角；两个人用同一套公式、只看各自的状态，对谁都公平。
  const LUCK = {
    gamble2: { key: 'luckGamble', dry: 7, cool: 8, swing: 6, lo: 30, hi: 72 },
    gamble4: { key: 'luckGamble', dry: 4, cool: 5, swing: 4, lo: 12, hi: 42 },
    ghost: { key: 'luckGhost', dry: 12, cool: 10, swing: 10, lo: 15, hi: 80 },
    lottery: { key: 'luckLottery', dry: 5, cool: 6, swing: 4, lo: 5, hi: 55 },
    gift: { key: 'luckGift', dry: 10, cool: 10, swing: 12, lo: 15, hi: 80 },
    comeback: { key: 'luckComeback', dry: 6, cool: 5, swing: 5, lo: 5, hi: 60 },
  };
  // 地产进度：每组按凑了几成算（满了算 1 套），抵押中的不算
  function progress(s, pi) {
    let v = 0;
    for (const set of s.players[pi].sets) if (!set.mortgage) v += Math.min(1, set.cards.length / sizeOf(set.color));
    return v;
  }
  function chance(s, pi, kind, base) {
    if (base <= 0 || base >= 100) return base <= 0 ? 0 : 100; // 规则写死 0 / 100（"从不" / "必中"）就照办，不加手气
    const k = LUCK[kind];
    const L = s.players[pi].stats[k.key] || 0;
    const behind = Math.max(-2, Math.min(2, progress(s, other(pi)) - progress(s, pi)));
    // 暗中照顾（luckSeat / luckEdge）：被照顾的一方每次都加几个百分点、对方减同样多，上下限也跟着放宽
    const e = s.rules.luckEdge > 0 && s.rules.luckSeat >= 0 ? (s.rules.luckSeat === pi ? s.rules.luckEdge : -s.rules.luckEdge) : 0;
    const c = base + (L > 0 ? L * k.dry : L < 0 ? -k.cool : 0) + behind * k.swing + e;
    return Math.max(Math.max(0, k.lo - Math.abs(e)), Math.min(Math.min(100, k.hi + Math.abs(e)), Math.round(c)));
  }
  function luckAfter(s, pi, kind, won) {
    const st = s.players[pi].stats;
    const key = LUCK[kind].key;
    st[key] = won ? -1 : Math.max(0, st[key] || 0) + 1;
  }
  function roll(s, pi, kind, base) {
    const won = rand(s) * 100 < chance(s, pi, kind, base);
    luckAfter(s, pi, kind, won);
    return won;
  }
  // 玩家看不到的规则（几率基准、保底次数）和计数
  const HIDDEN_RULES = ['comebackChance', 'lotteryChance', 'lotteryPity', 'giftBadChance', 'ghostGoodChance', 'luckSeat', 'luckEdge', 'drawSeat', 'drawEdge', 'rouletteEvenChance', 'rouletteNumberChance', 'rouletteZeroChance', 'saleChance'];
  function publicRules(r) {
    const o = Object.assign({}, r);
    for (const k of HIDDEN_RULES) delete o[k];
    return o;
  }
  function publicStats(st) {
    const o = Object.assign({}, st);
    delete o.lottoMiss;
    for (const k of LUCK_KEYS) delete o[k];
    return o;
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
      players: [0, 1].map((i) => ({ name: cleanName(names[i], i), hand: [], bank: [], sets: [], loose: [], stats: newStats(), boost: null, awards: [], gift: 0, ...newPower() })),
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
      auctioned: [],  // 秘密竞价：双方都有、已经竞价过的颜色（只要一直都有就不再竞价）
      tycoon: null,   // 贪婪大亨：{ player, mode: null（还没选）| 'vampire' | 'cash', depo: 对方存了还没满一档的钱, owed: 欠着没发的吸血奖励 }
      takeover: null, // 恶意收购：{ color: 开局随机定的颜色, player: 谁先集齐触发的（null = 还没触发） }
      sale: { rolled: false }, // 拍卖：整局只掷一次（rolled = 已经掷过，中没中都算）
      seq: 0,
      log: [],
    };
    s.deck = shuffle(s, CARDS.map((c) => c.id));
    const first = isPlayer(o.firstPlayer) ? o.firstPlayer : rand(s) < 0.5 ? 0 : 1;
    const ev = [];
    emit(s, ev, { type: 'gameStart', first, seed });
    if (rules.takeover) {
      s.takeover = { color: COLOR_KEYS[Math.floor(rand(s) * COLOR_KEYS.length)], player: null };
      emit(s, ev, { type: 'takeoverColor', color: s.takeover.color });
    }
    for (const pi of [first, other(first)]) {
      const ids = [];
      for (let k = 0; k < rules.startingHand && s.deck.length; k++) ids.push(takeCard(s, pi, ids));
      s.players[pi].hand.push(...ids);
      emit(s, ev, { type: 'deal', player: pi, count: ids.length, cardIds: ids });
    }
    startTurn(s, first, ev);
    appendLog(s, ev);
    return s;
  }

  function startTurn(s, pi, ev) {
    // mech：这回合已经触发过的机制（追赶 / 赌一把 / 大乐透 / 秘密竞价 / 赌场礼赠）。一回合只触发一个，机制之间不叠加
    s.turn = Object.assign({ player: pi, number: s.turn.number + 1, plays: 0, bonus: 0, gambled: false, lapsed: 0, mech: null }, turnBase(s, pi));
    s.phase = 'play';
    s.pending = null;
    s.discardNeed = 0;
    emit(s, ev, { type: 'turnStart', player: pi, turn: s.turn.number });
    // 在对手回合里被动凑齐 3 套的玩家（比如被强买强卖送了一张），要等到自己回合开始才算赢
    if (fullColors(s, pi).length >= s.rules.setsToWin) return endGame(s, ev, pi, 'sets');
    if (s.rules.maxTurns > 0 && s.turn.number > s.rules.maxTurns) return endGame(s, ev, null, 'maxTurns');
    const hand = s.players[pi].hand;
    let n = !hand.length ? s.rules.drawWhenEmpty : s.turn.number === 1 ? s.rules.firstTurnDraw : s.rules.drawPerTurn;
    if (s.players[pi].curse > 0) n = cursedDraw(s, ev, pi, n); // 捉鬼套装的坏结果：这回合先摸的几张都是 1M
    const gift = s.rules.casinoGift && s.players[pi].gift > 0; // 上回合攒下的赌场礼赠：这回合的机制就是它
    if (gift) s.turn.mech = 'gift';
    if (s.rules.comeback && !s.turn.mech) {
      // 两个追赶机制都只帮落后的一方，双方规则完全对称；领先方照样可以一回合直接赢。
      // 满足条件也只按手气几率触发（基准 comebackChance，各自掷一次；落后越久越容易），偶尔出现的翻盘机会，不会变成稳定的"落后奖励"
      const mine = fullColors(s, pi).length;
      const theirs = fullColors(s, other(pi)).length;
      const lucky = () => roll(s, pi, 'comeback', s.rules.comebackChance);
      if (theirs === s.rules.setsToWin - 1 && mine < theirs && lucky()) {
        s.turn.bonus = 1;
        s.turn.mech = 'comeback';
        emit(s, ev, { type: 'comeback', player: pi, kind: 'lastStand', plays: playsMax(s) });
      }
      if (!s.turn.mech && theirs - mine >= 2 && n > 0 && lucky()) {
        n += 1;
        s.turn.mech = 'comeback';
        emit(s, ev, { type: 'comeback', player: pi, kind: 'catchUp', extra: 1 });
      }
    }
    drawCards(s, pi, n, ev);
    if (s.rules.stalemateTurns > 0 && !s.deck.length && !s.discard.length && !s.players[0].hand.length && !s.players[1].hand.length) {
      return endGame(s, ev, null, 'stalemate'); // 牌全在桌面上，再也不会有牌动了
    }
    if (gift) openGift(s, ev, pi);
    else checkAuction(s, ev);
  }

  /* ─────────── 电力系统 & 捉鬼套装 ───────────
   * 电力按半点记，上限 powerCap 点，不会自然衰减。电力保险：每失去 insuranceStep（付出去的、被偷 / 被抢 / 被毁的面值）+0.5，
   * 到上限后溢出的不算。攒满的那一刻开始满格加成：收租 ×surgeMult（不论是否成套），持续到之后第 surgeTurns 个自己的回合结束，
   * 然后电力清零。
   * 捉鬼套装：累计从对方拿走 / 让对方失去的面值（收到的付款、偷 / 抢 / 毁掉的地产、破产拿走的钱、竞价赢来的……）
   * 超过门槛就触发一次，累计清零、门槛 +ghostStep（10 → 20 → 30M……）。触发时老虎机抽奖：ghostGoodChance% 多拿两张讨债人
   * （从牌堆 / 弃牌堆里拿）；否则失去随机颜色的一张地产（进弃牌堆），没有地产可丢就弃掉全部手牌、下回合开始摸的 5 张都是 1M。
   * 这几样都是规则后果，不占"一回合一个机制"的名额 */
  const surgeFor = (s, pi) => (s.rules.power && s.players[pi].surge ? s.rules.surgeMult : 1);
  const ghostBar = (s, pi) => s.rules.ghostStep * (s.players[pi].ghostN + 1); // 下一次触发的门槛

  // victim 失去了 v（by 造成的；by 为 null 表示不是对方造成的）：失去的一方攒电力保险，造成的一方攒捉鬼套装
  function hurt(s, ev, victim, by, v) {
    if (!(v > 0)) return;
    insurance(s, ev, victim, v);
    if (by != null && by !== victim) haul(s, ev, by, v);
  }

  function insurance(s, ev, pi, v) {
    if (!s.rules.power) return;
    const P = s.players[pi];
    const cap = s.rules.powerCap * 2;
    P.lost += v;
    while (P.lost >= s.rules.insuranceStep) {
      P.lost -= s.rules.insuranceStep;
      const gained = P.power < cap ? 1 : 0;
      P.power += gained;
      emit(s, ev, { type: 'insurance', player: pi, gained, power: P.power, step: s.rules.insuranceStep });
      if (gained && P.power >= cap && !P.surge) {
        P.surge = { left: s.rules.surgeTurns, since: s.turn.number };
        emit(s, ev, { type: 'surge', player: pi, mult: s.rules.surgeMult, turns: s.rules.surgeTurns });
      }
    }
  }

  // 回合结束：满格加成倒数（攒满的那个回合不算），数完电力清零
  function powerTurnEnd(s, ev, pi) {
    const P = s.players[pi];
    if (!P.surge) return;
    if (P.surge.since !== s.turn.number) P.surge.left -= 1;
    if (P.surge.left > 0) return;
    const before = P.power;
    P.surge = null;
    P.power = 0;
    emit(s, ev, { type: 'surgeEnd', player: pi, power: 0, lost: before });
  }

  function haul(s, ev, pi, v) {
    if (!s.rules.ghostKit) return;
    const P = s.players[pi];
    P.haul += v;
    if (P.haul > ghostBar(s, pi)) ghostKit(s, ev, pi);
  }

  function ghostKit(s, ev, pi) {
    const P = s.players[pi];
    const out = { type: 'ghost', player: pi, haul: P.haul, bar: ghostBar(s, pi) };
    P.haul = 0;
    P.ghostN += 1;
    out.next = ghostBar(s, pi);
    out.good = roll(s, pi, 'ghost', s.rules.ghostGoodChance);
    let lost = 0;
    if (out.good) { // 两张讨债人，从牌堆 / 弃牌堆里拿；不够就有几张给几张
      const ids = s.deck.concat(s.discard).filter((id) => isAct(id, 'debtCollector')).slice(0, 2);
      ids.forEach((id) => takeFromPiles(s, id));
      P.hand.push(...ids);
      Object.assign(out, { kind: 'debt', cardIds: ids, count: ids.length });
    } else {
      const colors = [];
      for (const set of P.sets) if (set.cards.length && colors.indexOf(set.color) < 0) colors.push(set.color);
      if (colors.length) { // 随机一种颜色，再从这种颜色里随机一张
        const color = colors[Math.floor(rand(s) * colors.length)];
        const cards = [];
        for (const set of P.sets) if (set.color === color) cards.push(...set.cards);
        const id = cards[Math.floor(rand(s) * cards.length)];
        detach(s, pi, id);
        s.discard.push(id);
        lost = valueOf(id);
        Object.assign(out, { kind: 'lose', color, cardId: id });
      } else { // 没有地产可丢：弃掉全部手牌（牌面公开），下回合开始摸的 5 张都是 1M
        const hand = P.hand.splice(0);
        s.discard.push(...hand);
        P.curse = 5;
        Object.assign(out, { kind: 'curse', handIds: hand, handCount: hand.length, count: P.curse });
      }
    }
    emit(s, ev, out);
    if (lost) insurance(s, ev, pi, lost); // 丢掉的地产也算失去
  }

  // 下回合开始先摸 1M：从牌堆 / 弃牌堆里找，不够的照常摸。返回还要照常摸几张
  function cursedDraw(s, ev, pi, n) {
    const P = s.players[pi];
    const want = P.curse;
    P.curse = 0;
    if (!s.rules.ghostKit) return n;
    const ones = s.deck.concat(s.discard).filter((id) => CARDS[id].type === 'money' && CARDS[id].value === 1).slice(0, want);
    ones.forEach((id) => takeFromPiles(s, id));
    P.hand.push(...ones);
    emit(s, ev, { type: 'ghostCurse', player: pi, count: ones.length, want });
    emit(s, ev, { type: 'draw', player: pi, count: ones.length, cardIds: ones });
    return want - ones.length;
  }

  /* ─────────── 贪婪大亨 ───────────
   * 每局最先累计从对方那里拿到超过 tycoonAt 地产面值的人触发（整局只触发一次，之后谁都不会再触发）：
   * 狡猾交易、交易破坏者抢来的整套（只算地产，不算房屋旅馆）、强买强卖换来的那张、对方用地产付给你的，都算。
   * 触发后二选一：
   *  - 吸血：直到这局结束，对方每往银行存 vampireStep，你白拿 1M（从牌堆 / 弃牌堆里的钱凑，凑不齐的先欠着）；
   *    对方向你收的钱（租金、讨债、生日）、对方用破产拿你银行的钱，都只算一半（向上取整）
   *  - 套现：马上拿两张全色租金（从牌堆 / 弃牌堆里拿），再按自己现有地产总面值的 tycoonCash%（向上取整）从牌堆 / 弃牌堆里凑钱存进银行
   * 也是规则后果，不占"一回合一个机制"的名额 */
  const vampire = (s, pi) => !!(s.tycoon && s.tycoon.mode === 'vampire' && s.tycoon.player === pi);
  const halfOf = (v) => Math.ceil(v / 2);
  const cashOf = (s, v) => Math.ceil((v * s.rules.tycoonCash) / 100); // 套现能拿多少
  const propValue = (s, pi) => { let v = 0; for (const set of s.players[pi].sets) v += sum(set.cards); return v; };

  function grabbed(s, ev, pi, v) {
    if (!s.rules.tycoon || s.tycoon || !(v > 0)) return;
    const P = s.players[pi];
    P.grab += v;
    if (P.grab <= s.rules.tycoonAt) return;
    s.tycoon = { player: pi, mode: null, depo: 0, owed: 0 };
    emit(s, ev, { type: 'tycoon', player: pi, grab: P.grab, at: s.rules.tycoonAt });
  }

  // 触发了还没选：等手上的事结算完（回到出牌阶段）再让他二选一
  function checkTycoon(s, ev) {
    const t = s.tycoon;
    if (!t || t.mode || s.phase !== 'play' || s.pending) return;
    const actor = s.turn.player;
    s.pending = {
      id: s.nextPendingId++, action: 'tycoon', actor, target: other(actor), cardId: null, amount: 0, base: 0, color: null,
      doubles: [], wild: false, targetCardId: null, giveCardId: null, targetSetId: null, chain: [], awaiting: t.player,
    };
    s.phase = 'respond';
    emit(s, ev, { type: 'tycoonOffered', pendingId: s.pending.id, player: t.player });
  }

  // 从牌堆 / 弃牌堆里凑钱进某人的银行
  function payFromPiles(s, pi, target) {
    const got = collectMoney(s, target);
    got.forEach((id) => takeFromPiles(s, id));
    s.players[pi].bank.push(...got);
    return got;
  }

  function tycoonChoose(s, pi, a, ev) {
    if (s.phase !== 'respond' || !s.pending || s.pending.action !== 'tycoon') fail('WRONG_PHASE');
    if (s.pending.awaiting !== pi) fail('NOT_YOUR_RESPONSE');
    const t = s.tycoon;
    const out = { type: 'tycoonChosen', pendingId: s.pending.id, player: pi };
    if (a.vampire) {
      t.mode = 'vampire';
      Object.assign(out, { mode: 'vampire', step: s.rules.vampireStep });
    } else {
      t.mode = 'cash';
      const rents = s.deck.concat(s.discard).filter((id) => CARDS[id].type === 'rent' && CARDS[id].any).slice(0, 2);
      rents.forEach((id) => takeFromPiles(s, id));
      s.players[pi].hand.push(...rents);
      const value = propValue(s, pi);
      const got = payFromPiles(s, pi, cashOf(s, value));
      Object.assign(out, { mode: 'cash', rentIds: rents, rentCount: rents.length, propValue: value, pct: s.rules.tycoonCash, target: cashOf(s, value), amount: sum(got), cardIds: got });
    }
    emit(s, ev, out);
    finishPending(s, ev);
  }

  // 吸血：对方存钱，每满一档白拿 1M；牌堆和弃牌堆里凑不出来的先欠着，下次一起补
  function vampireDrip(s, ev, pi, v) {
    const t = s.tycoon;
    if (!t || t.mode !== 'vampire' || pi !== other(t.player)) return;
    t.depo += v;
    const n = Math.floor(t.depo / s.rules.vampireStep);
    if (!n) return;
    t.depo -= n * s.rules.vampireStep;
    t.owed += n;
    const got = payFromPiles(s, t.player, t.owed);
    t.owed -= sum(got);
    emit(s, ev, { type: 'vampire', player: t.player, from: pi, earned: n, amount: sum(got), cardIds: got, owed: t.owed });
  }

  /* ─────────── 秘密竞价 ───────────
   * 双方同时有某种颜色的完整套（没抵押的）就触发：双方各从银行里挑牌暗标出价（谁都看不到对方出了什么），
   * 都出完后亮价，出价高的拿走双方的出价，并毁掉对方那套（连同房屋、旅馆进弃牌堆）；一样多就各自退回。
   * 同一段"双方都有"只竞价一次：平局后不会每回合再来，有一方没了这套、之后再凑齐才会再触发。 */
  function bothFullColors(s) {
    const has = (pi) => new Set(s.players[pi].sets.filter((x) => isFull(x) && !x.mortgage).map((x) => x.color));
    const a = has(0);
    const b = has(1);
    return COLOR_KEYS.filter((c) => a.has(c) && b.has(c));
  }

  function checkAuction(s, ev) {
    if (!s.rules.auction) return;
    const both = bothFullColors(s);
    s.auctioned = s.auctioned.filter((c) => both.indexOf(c) >= 0);
    if (s.phase !== 'play' || s.turn.mech) return;
    const fresh = both.filter((c) => s.auctioned.indexOf(c) < 0);
    if (!fresh.length) return;
    const full = (c) => COLORS[c].rent[COLORS[c].size - 1];
    const color = fresh.sort((x, y) => full(y) - full(x))[0]; // 几种颜色同时满足：竞价最值钱的那种
    s.auctioned.push(color);
    s.turn.mech = 'auction';
    const setOf = (pi) => s.players[pi].sets.filter((x) => x.color === color && isFull(x) && !x.mortgage).sort((x, y) => setRent(s, y) - setRent(s, x))[0].id;
    const actor = s.turn.player;
    s.pending = {
      id: s.nextPendingId++, action: 'auction', actor, target: other(actor), cardId: null, amount: 0, base: 0, color,
      doubles: [], wild: false, targetCardId: null, giveCardId: null, targetSetId: null, chain: [], awaiting: actor,
      sets: [setOf(0), setOf(1)], bids: [null, null],
    };
    s.phase = 'respond';
    emit(s, ev, { type: 'auctionStart', pendingId: s.pending.id, color, sets: s.pending.sets.slice() });
    for (const pi of [actor, other(actor)]) { // 银行是空的只能出 0：直接替他出
      if (s.phase === 'respond' && s.pending.bids[pi] == null && !s.players[pi].bank.length) placeBid(s, ev, pi, []);
    }
  }

  function placeBid(s, ev, pi, ids) {
    const pd = s.pending;
    pd.bids[pi] = ids.slice();
    emit(s, ev, { type: 'auctionBid', pendingId: pd.id, player: pi, cardIds: ids.slice(), amount: sum(ids) });
    if (pd.bids[0] != null && pd.bids[1] != null) return resolveAuction(s, ev);
    pd.awaiting = pd.bids[pd.actor] == null ? pd.actor : pd.target;
    return undefined;
  }

  function bid(s, pi, a, ev) {
    if (s.phase !== 'respond' || !s.pending || s.pending.action !== 'auction') fail('WRONG_PHASE');
    if (s.pending.bids[pi] != null) fail('ALREADY_BID');
    const ids = requireIdList(a.cardIds == null ? [] : a.cardIds);
    for (const id of ids) if (s.players[pi].bank.indexOf(id) < 0) fail('NOT_IN_BANK');
    placeBid(s, ev, pi, ids);
  }

  function resolveAuction(s, ev) {
    const pd = s.pending;
    const amounts = pd.bids.map(sum);
    const winner = amounts[0] === amounts[1] ? null : amounts[0] > amounts[1] ? 0 : 1;
    const out = { type: 'auctionResult', pendingId: pd.id, color: pd.color, bids: pd.bids.map((b) => b.slice()), amounts, winner, destroyed: null };
    if (winner != null) {
      const loser = other(winner);
      const L = s.players[loser];
      for (const id of pd.bids[loser]) { L.bank.splice(L.bank.indexOf(id), 1); s.players[winner].bank.push(id); }
      L.stats.paid += amounts[loser];
      s.players[winner].stats.received += amounts[loser];
      const idx = L.sets.findIndex((x) => x.id === pd.sets[loser]);
      if (idx >= 0) {
        const set = L.sets.splice(idx, 1)[0];
        const gone = set.cards.concat(set.house != null ? [set.house] : [], set.hotel != null ? [set.hotel] : []);
        s.discard.push(...gone);
        out.destroyed = { setId: set.id, color: set.color, cardIds: gone };
        addDealt(s, winner, amounts[loser] + sum(gone));
      }
    }
    emit(s, ev, out);
    if (winner != null) hurt(s, ev, other(winner), winner, amounts[other(winner)] + (out.destroyed ? sum(out.destroyed.cardIds) : 0));
    finishPending(s, ev);
  }

  /* ─────────── 赌场礼赠 ───────────
   * 同一个人连续 giftStreak 次押 ×4 赌一把（输赢都算，中间押一次 ×2 就重新数），下回合开始拿到一份礼赠：
   * 自己打开，或者送给对方（对方不能拒收，强制打开）。打开时从当下用得上的结果里等概率抽一种；
   * 需要的牌都从抽牌堆 / 弃牌堆里拿（整副牌一共 109 张，不凭空变牌）。 */
  function openGift(s, ev, pi) {
    s.pending = {
      id: s.nextPendingId++, action: 'gift', actor: pi, target: other(pi), cardId: null, amount: 0, base: 0, color: null,
      doubles: [], wild: false, targetCardId: null, giveCardId: null, targetSetId: null, chain: [], awaiting: pi,
    };
    s.phase = 'respond';
    emit(s, ev, { type: 'giftOffered', pendingId: s.pending.id, player: pi });
  }

  function giftAction(s, pi, a, ev) {
    if (s.phase !== 'respond' || !s.pending || s.pending.action !== 'gift') fail('WRONG_PHASE');
    if (s.pending.awaiting !== pi) fail('NOT_YOUR_RESPONSE');
    const to = a.give ? other(pi) : pi;
    s.players[pi].gift -= 1;
    const r = openBox(s, to);
    if (to !== pi && r.lost) addDealt(s, pi, r.lost); // 送出去的礼盒把对方炸空了：算你的战果
    const lost = r.lost || 0;
    delete r.lost;
    emit(s, ev, Object.assign({ type: 'giftOpened', pendingId: s.pending.id, by: pi, to, given: !!a.give }, r));
    hurt(s, ev, to, to !== pi ? pi : null, lost);
    finishPending(s, ev);
  }

  // 凑钱：在面值不超过剩余金额的钱里随机挑，面值越大越容易被挑中（大乐透、礼赠的存款都用它）
  function collectMoney(s, target) {
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
    return got;
  }

  function takeFromPiles(s, id) {
    const from = s.deck.indexOf(id) >= 0 ? s.deck : s.discard;
    from.splice(from.indexOf(id), 1);
    return id;
  }

  function openBox(s, to) {
    const P = s.players[to];
    const pool = () => s.deck.concat(s.discard);
    const pickOne = (ids) => ids[Math.floor(rand(s) * ids.length)];
    const pickSome = (ids, n) => { const left = ids.slice(); const out = []; while (out.length < n && left.length) out.push(left.splice(Math.floor(rand(s) * left.length), 1)[0]); return out; };
    const props = (color) => pool().filter((id) => CARDS[id].type === 'property' && CARDS[id].color === color);
    const wilds = (color) => pool().filter((id) => CARDS[id].type === 'wild' && !CARDS[id].any && CARDS[id].colors.indexOf(color) >= 0);
    const setColors = COLOR_KEYS.filter((c) => props(c).length + wilds(c).length >= sizeOf(c));
    const propColors = COLOR_KEYS.filter((c) => props(c).length);
    const bigActions = pool().filter((id) => isAct(id, 'bankruptcy') || isAct(id, 'liquidation') || isAct(id, 'hugeWin'));
    const actions = pool().filter((id) => CARDS[id].type === 'action');
    const jsns = pool().filter((id) => isAct(id, 'justSayNo'));
    const wildRents = pool().filter((id) => CARDS[id].type === 'rent' && CARDS[id].any);
    const money = pool().filter((id) => CARDS[id].type === 'money');
    const mortgageable = P.sets.filter((x) => isFull(x) && !x.mortgage);
    const can = {
      fullSet: setColors.length > 0,
      fourProps: propColors.length > 0,
      wipe: P.bank.length > 0 || P.sets.length > 0,
      bigAction: bigActions.length > 0,
      action: actions.length > 0,
      jsn: jsns.length > 0,
      wildRent: wildRents.length > 0,
      cash: money.length > 0,
      mortgage: mortgageable.length > 0,
    };
    // 先定好坏（打开的人的手气几率，基准是 100 - giftBadChance 的好结果），再在这一类里抽；这一类一样都用不上
    // （比如打开的人什么都没有，清空和抵押都无从谈起）就是空盒，不改投另一类
    const bad = !roll(s, to, 'gift', 100 - s.rules.giftBadChance);
    const open = GIFTS.filter((k) => can[k] && (BAD_GIFTS.indexOf(k) >= 0) === bad);
    if (!open.length) return { kind: 'none', bad };
    const kind = pickOne(open);
    const r = (() => {
      switch (kind) {
        case 'fullSet': { // 一整套：先用单色地产，不够再用双色多功能地产
          const color = pickOne(setColors);
          const ids = props(color).slice(0, sizeOf(color));
          const need = sizeOf(color) - ids.length;
          if (need > 0) ids.push(...wilds(color).slice(0, need));
          ids.forEach((id) => takeFromPiles(s, id));
          const set = { id: s.nextSetId++, color, cards: ids, house: null, hotel: null, mortgage: null };
          P.sets.push(set);
          return { kind, color, cardIds: ids.slice(), setId: set.id };
        }
        case 'fourProps': { // 4 种颜色的地产各一张（颜色不够 4 种就有几种给几张）
          const placements = pickSome(propColors, 4).map((color) => {
            const id = takeFromPiles(s, pickOne(props(color)));
            return { cardId: id, color, setId: placeCard(s, to, id, color) };
          });
          return { kind, cardIds: placements.map((x) => x.cardId), placements };
        }
        case 'wipe': { // 立刻清算：银行和地产全部进弃牌堆（散落的建筑不算地产，留着）
          const bankIds = P.bank.splice(0);
          const propIds = [];
          for (const set of P.sets) {
            propIds.push(...set.cards);
            if (set.house != null) propIds.push(set.house);
            if (set.hotel != null) propIds.push(set.hotel);
          }
          P.sets = [];
          s.discard.push(...bankIds, ...propIds);
          return { kind, bankIds, propIds, lost: sum(bankIds) + sum(propIds) };
        }
        case 'bigAction':
        case 'action': {
          const id = takeFromPiles(s, pickOne(kind === 'bigAction' ? bigActions : actions));
          P.hand.push(id);
          return { kind, cardIds: [id] };
        }
        case 'jsn':
        case 'wildRent': {
          const ids = pickSome(kind === 'jsn' ? jsns : wildRents, 2);
          ids.forEach((id) => { takeFromPiles(s, id); P.hand.push(id); });
          return { kind, cardIds: ids };
        }
        case 'cash': {
          const ids = collectMoney(s, 20);
          ids.forEach((id) => { takeFromPiles(s, id); P.bank.push(id); });
          return { kind, cardIds: ids, amount: sum(ids) };
        }
        default: { // mortgage：抵押打开方租金最高的一套完整地产
          const set = mortgageable.sort((x, y) => setRent(s, y) - setRent(s, x))[0];
          set.mortgage = { turn: s.turn.number };
          return { kind, setId: set.id, color: set.color, cost: redeemCost(s, set) };
        }
      }
    })();
    r.bad = bad;
    return r;
  }

  /* ─────────── 恶意收购 & 轮盘赌 ───────────
   * 开局随机定一种颜色（公开）。整局第一次有人集齐这种颜色的完整套，等手上的事结算完（回到出牌阶段）就触发，整局只触发一次：
   * 双方银行 + 桌上的地产（连同房屋、旅馆、散落的建筑）立即按面值折成筹码，这些牌全部进弃牌堆。
   * 然后触发的人先玩、另一个人后玩（一方玩一方看），每人 1–rouletteSpins 局，每局押 rouletteMin–rouletteMax（不超过手上的筹码），三选一：
   *   押红 / 黑 / 单 / 双  中了押的筹码翻倍（几率 rouletteEvenChance）
   *   押一个具体数字      中了押的筹码 ×5，立即结束他的轮盘赌，另外拿到所有颜色的地产各一张 + 一张 10M 行动卡（破产 / 清算，不含 Huge Win）
   *                      （几率 rouletteNumberChance）
   *   不管押什么，都有 rouletteZeroChance 开出绿色 0：筹码清零，立即结束他的轮盘赌；其余情况输掉押的筹码
   * 每局开奖后可以带着筹码离开，筹码立即换成钱（从抽牌堆 / 弃牌堆里凑，钱不够凑就用行动卡、租金卡当钱）存进银行；
   * 打满局数自动离开；筹码输光（或开局就没有筹码）就结束。双方都玩完，对局接着打。
   * 几率不公开；对 AI 的局里暗中照顾（luckSeat / luckEdge）同样生效（中奖几率 ±edge/2、开出 0 的几率 ∓edge/2）。
   * 是规则后果，不占"一回合一个机制"的名额 */
  const rouletteColor = (n) => (n === 0 ? 'green' : WHEEL_RED.indexOf(n) >= 0 ? 'red' : 'black');
  const isRoulettePick = (p) => ROULETTE_PICKS.indexOf(p) >= 0 || (Number.isInteger(p) && p !== 0 && WHEEL.indexOf(p) >= 0);
  function pickMatches(n, pick) {
    if (n === 0) return false;
    if (Number.isInteger(pick)) return n === pick;
    if (pick === 'red' || pick === 'black') return rouletteColor(n) === pick;
    return (n % 2 === 1) === (pick === 'odd');
  }

  function checkTakeover(s, ev) {
    const t = s.takeover;
    if (!s.rules.takeover || !t || t.player != null || s.phase !== 'play' || s.pending) return;
    const has = (pi) => s.players[pi].sets.some((x) => x.color === t.color && isFull(x));
    const who = [s.turn.player, other(s.turn.player)].find(has);
    if (who == null) return;
    t.player = who;
    const chips = [0, 0];
    const cardIds = [[], []];
    for (const pi of [0, 1]) { // 银行、地产、建筑全部进弃牌堆，按面值折成筹码
      const P = s.players[pi];
      const ids = P.bank.splice(0);
      for (const set of P.sets) {
        ids.push(...set.cards);
        if (set.house != null) ids.push(set.house);
        if (set.hotel != null) ids.push(set.hotel);
      }
      P.sets = [];
      ids.push(...P.loose.splice(0));
      s.discard.push(...ids);
      chips[pi] = sum(ids);
      cardIds[pi] = ids;
    }
    rebaseAwards(s);
    s.pending = {
      id: s.nextPendingId++, action: 'takeover', actor: s.turn.player, target: other(s.turn.player), cardId: null, amount: 0, base: 0, color: t.color,
      doubles: [], wild: false, targetCardId: null, giveCardId: null, targetSetId: null, chain: [], awaiting: who,
      order: [who, other(who)], chips: chips.slice(), start: chips.slice(), spins: [0, 0], done: [false, false], result: [null, null], step: 0, last: null,
    };
    s.phase = 'respond';
    emit(s, ev, { type: 'takeoverStart', pendingId: s.pending.id, player: who, color: t.color, chips, cardIds });
    nextRoulette(s, ev);
  }

  // 恶意收购把桌面清空、又换成钱，不是谁打出来的战果：成就的回合基准跟着重算，免得白送"破坏大师""超级金库"
  function rebaseAwards(s) {
    const pi = s.turn.player;
    const o = other(pi);
    Object.assign(s.turn, { oppProps: propCount(s, o), oppBank: s.players[o].bank.length, myBank: Math.max(s.turn.myBank || 0, sum(s.players[pi].bank)) });
  }

  // 轮到下一个还没玩完的人；没有筹码的直接跳过；都玩完了就结束，回到出牌阶段
  function nextRoulette(s, ev) {
    const pd = s.pending;
    for (const pi of pd.order) {
      if (pd.done[pi]) continue;
      if (pd.chips[pi] > 0 && pd.chips[pi] < s.rules.rouletteMin) return endSession(s, ev, pi, 'skip'); // 不够押一局：筹码直接换钱
      if (pd.chips[pi] <= 0) {
        pd.done[pi] = true;
        pd.result[pi] = { reason: 'skip', chips: pd.chips[pi], amount: 0 };
        emit(s, ev, { type: 'rouletteSkip', pendingId: pd.id, player: pi, chips: pd.chips[pi] });
        continue;
      }
      pd.awaiting = pi;
      emit(s, ev, { type: 'rouletteTurn', pendingId: pd.id, player: pi, chips: pd.chips[pi], spins: s.rules.rouletteSpins });
      return;
    }
    emit(s, ev, { type: 'takeoverEnd', pendingId: pd.id, result: pd.result.map((r) => Object.assign({}, r)) });
    rebaseAwards(s);
    finishPending(s, ev);
  }

  function requireRoulette(s, pi) {
    if (s.phase !== 'respond' || !s.pending || s.pending.action !== 'takeover') fail('WRONG_PHASE');
    if (s.pending.awaiting !== pi) fail('NOT_YOUR_RESPONSE');
    return s.pending;
  }

  // 这一局的几率：开出 0 的几率押什么都一样，中奖几率看押法；暗中照顾按一半算
  function rouletteOdds(s, pi, number) {
    const r = s.rules;
    const e = r.luckEdge > 0 && r.luckSeat >= 0 ? (r.luckSeat === pi ? r.luckEdge : -r.luckEdge) / 2 : 0;
    const zero = Math.max(0, Math.min(100, r.rouletteZeroChance - e));
    const win = Math.max(0, Math.min(100 - zero, (number ? r.rouletteNumberChance : r.rouletteEvenChance) + e));
    return { zero, win };
  }

  function spin(s, pi, a, ev) {
    const pd = requireRoulette(s, pi);
    if (!isRoulettePick(a.pick)) fail('BAD_PICK');
    const max = Math.min(s.rules.rouletteMax, pd.chips[pi]);
    if (!Number.isInteger(a.wager) || a.wager < s.rules.rouletteMin || a.wager > max) fail('BAD_WAGER');
    const number = Number.isInteger(a.pick);
    const odds = rouletteOdds(s, pi, number);
    const r = rand(s) * 100;
    const outcome = r < odds.zero ? 'zero' : r < odds.zero + odds.win ? (number ? 'hit' : 'win') : 'lose';
    // 先定输赢，再从轮盘上挑一个和结果对得上的数
    const nums = WHEEL.filter((n) => n !== 0);
    const pool = outcome === 'zero' ? [0] : outcome === 'hit' ? [a.pick] : nums.filter((n) => pickMatches(n, a.pick) === (outcome === 'win'));
    const n = pool[Math.floor(rand(s) * pool.length)];
    const before = pd.chips[pi];
    const delta = outcome === 'zero' ? -before : outcome === 'win' ? a.wager : outcome === 'hit' ? a.wager * (ROULETTE_HIT - 1) : -a.wager;
    pd.chips[pi] = before + delta;
    pd.spins[pi] += 1;
    pd.step += 1;
    pd.last = { player: pi, round: pd.spins[pi], pick: a.pick, wager: a.wager, number: n, color: rouletteColor(n), outcome, delta, before, chips: pd.chips[pi] };
    emit(s, ev, Object.assign({ type: 'rouletteSpin', pendingId: pd.id }, pd.last));
    if (outcome === 'zero') return endSession(s, ev, pi, 'zero');
    if (outcome === 'hit') {
      takeoverPrize(s, ev, pi);
      return endSession(s, ev, pi, 'hit');
    }
    if (!pd.chips[pi]) return endSession(s, ev, pi, 'bust');
    if (pd.spins[pi] >= s.rules.rouletteSpins || pd.chips[pi] < s.rules.rouletteMin) return endSession(s, ev, pi, 'last');
    return undefined; // 接着由他决定：再转一局，还是带着筹码离开
  }

  function cashOut(s, pi, a, ev) {
    const pd = requireRoulette(s, pi);
    if (!pd.spins[pi]) fail('MUST_SPIN');
    pd.step += 1;
    endSession(s, ev, pi, 'cash');
  }

  // 一个人的轮盘赌结束：还有筹码就换成钱存进银行
  function endSession(s, ev, pi, reason) {
    const pd = s.pending;
    const chips = pd.chips[pi];
    pd.done[pi] = true;
    if (chips > 0) {
      const got = cashFromPiles(s, chips);
      s.players[pi].bank.push(...got);
      pd.result[pi] = { reason, chips, amount: sum(got) };
      emit(s, ev, { type: 'rouletteCashOut', pendingId: pd.id, player: pi, reason, chips, amount: sum(got), cardIds: got });
    } else {
      pd.result[pi] = { reason, chips: 0, amount: 0 };
      emit(s, ev, { type: 'rouletteBust', pendingId: pd.id, player: pi, reason });
    }
    nextRoulette(s, ev);
  }

  // 筹码换钱：先从抽牌堆 / 弃牌堆里凑钱（同大乐透）；钱不够凑（整副牌只有 57M 的钱）再用租金卡、行动卡当钱，
  // 先用对局面影响小的（租金、经过、生日……），交易破坏者、反对行动和 10M 的三张排在最后；同一档里大的先用。还凑不满就给凑得出的最多
  const CASH_TIER = { slyDeal: 1, forcedDeal: 1, justSayNo: 2, dealBreaker: 2, bankruptcy: 2, liquidation: 2, hugeWin: 2 };
  function cashFromPiles(s, target) {
    const got = collectMoney(s, target);
    got.forEach((id) => takeFromPiles(s, id));
    const left = target - sum(got);
    if (left > 0) {
      const tier = (id) => CASH_TIER[CARDS[id].action] || 0;
      const spare = s.discard.concat(s.deck).filter((id) => !isProp(id) && CARDS[id].type !== 'money' && valueOf(id) > 0);
      const fill = (order) => {
        const out = [];
        let need = left;
        for (const id of order) if (valueOf(id) <= need) { out.push(id); need -= valueOf(id); if (!need) break; }
        return out;
      };
      const tiered = fill(spare.slice().sort((x, y) => tier(x) - tier(y) || valueOf(y) - valueOf(x)));
      const plain = sum(tiered) < left ? fill(spare.slice().sort((x, y) => valueOf(y) - valueOf(x))) : null; // 按档凑差一点：只按大小凑能凑得更准就用它
      (plain && sum(plain) > sum(tiered) ? plain : tiered).forEach((id) => got.push(takeFromPiles(s, id)));
    }
    return got;
  }

  // 押中数字的奖励：所有颜色的地产各一张（先用单色地产，没有再用含这种颜色的双色多功能地产），再加一张 10M 行动卡（不含 Huge Win）进手牌
  function takeoverPrize(s, ev, pi) {
    const pool = () => s.deck.concat(s.discard);
    const pickOne = (ids) => ids[Math.floor(rand(s) * ids.length)];
    const placements = [];
    for (const color of COLOR_KEYS) {
      let ids = pool().filter((id) => CARDS[id].type === 'property' && CARDS[id].color === color);
      if (!ids.length) ids = pool().filter((id) => CARDS[id].type === 'wild' && !CARDS[id].any && CARDS[id].colors.indexOf(color) >= 0);
      if (!ids.length) continue;
      const id = takeFromPiles(s, pickOne(ids));
      placements.push({ cardId: id, color, setId: placeCard(s, pi, id, color) });
    }
    const big = pool().filter((id) => isAct(id, 'bankruptcy') || isAct(id, 'liquidation'));
    const actionId = big.length ? takeFromPiles(s, pickOne(big)) : null;
    if (actionId != null) s.players[pi].hand.push(actionId);
    emit(s, ev, { type: 'roulettePrize', pendingId: s.pending.id, player: pi, cardIds: placements.map((x) => x.cardId), placements, actionId, hasAction: actionId != null });
  }

  /* ─────────── 拍卖 ───────────
   * 双方桌上同时有 ≥2 种相同颜色的地产（各自都有这种颜色的地产，不必成套）时，按 saleChance 掷一次——整局只掷这一次，
   * 没中这局就不会再有拍卖。中了：从双方都有的颜色里随机挑一种，从抽牌堆 / 弃牌堆里拿一张这种颜色的地产公开拍卖
   * （先用单色地产，没有再用含这种颜色的双色多功能地产；这些颜色在牌堆里都拿不出来就先不掷，等以后再看）。
   * 起拍价 0，双方轮流出价（刚出过价的人要等对方加价），每次至少比当前最高价多 1M，出价不能超过自己银行里的钱。
   * 计时在服务层（引擎不看时间）：开拍后 saleOpenSeconds 秒没人出价就流拍；有人出价后 saleHoldSeconds 秒没人加价就成交；
   * 整场最长 saleMaxMinutes 分钟，到点按当前最高价成交。到点由服务器发 SALE_CLOSE（客户端发来的会被拒绝）。
   * 成交：从最高出价者的银行里挑刚好够、张数最少的牌付款（不找零），钱进弃牌堆；拍品放进他的地产区。
   * 遵守"一回合只触发一个机制"：这回合已经触发过别的机制就先不掷，之后的回合再看 */
  function sharedColors(s) {
    const has = (pi) => new Set(s.players[pi].sets.filter((x) => x.cards.length).map((x) => x.color));
    const a = has(0);
    const b = has(1);
    return COLOR_KEYS.filter((c) => a.has(c) && b.has(c));
  }

  function saleLots(s, color) {
    const pool = s.deck.concat(s.discard);
    const props = pool.filter((id) => CARDS[id].type === 'property' && CARDS[id].color === color);
    return props.length ? props : pool.filter((id) => CARDS[id].type === 'wild' && !CARDS[id].any && CARDS[id].colors.indexOf(color) >= 0);
  }

  function checkSale(s, ev) {
    if (!s.rules.sale || s.sale.rolled || s.phase !== 'play' || s.pending || s.turn.mech) return;
    const shared = sharedColors(s);
    if (shared.length < 2) return;
    const colors = shared.filter((c) => saleLots(s, c).length);
    if (!colors.length) return;
    if (s.players.every((p) => sum(p.bank) < 1)) return; // 两边银行都空：谁也出不了价，先不掷（掷了也只是白白流拍）
    s.sale.rolled = true;
    if (rand(s) * 100 >= s.rules.saleChance) return; // 没中：这局不会再有拍卖
    const color = colors[Math.floor(rand(s) * colors.length)];
    const lots = saleLots(s, color);
    const cardId = lots[Math.floor(rand(s) * lots.length)];
    s.turn.mech = 'sale';
    const actor = s.turn.player;
    s.pending = {
      id: s.nextPendingId++, action: 'sale', actor, target: other(actor), cardId, amount: 0, base: 0, color,
      doubles: [], wild: false, targetCardId: null, giveCardId: null, targetSetId: null, chain: [], awaiting: actor,
      leader: null, step: 0, history: [],
    };
    s.phase = 'respond';
    emit(s, ev, { type: 'saleStart', pendingId: s.pending.id, color, cardId, shared });
  }

  function requireSale(s) {
    if (s.phase !== 'respond' || !s.pending || s.pending.action !== 'sale') fail('WRONG_PHASE');
    return s.pending;
  }

  // 出价 / 加价：谁都可以开第一口价；之后只有被超过的一方能加价
  function saleBid(s, pi, a, ev) {
    const pd = requireSale(s);
    if (pd.leader === pi) fail('SALE_LEADING');
    if (!Number.isInteger(a.amount) || a.amount < pd.amount + 1) fail('SALE_TOO_LOW');
    if (a.amount > sum(s.players[pi].bank)) fail('SALE_NO_MONEY');
    pd.amount = a.amount;
    pd.leader = pi;
    pd.awaiting = other(pi);
    pd.step += 1;
    pd.history.push({ player: pi, amount: a.amount });
    if (pd.history.length > 12) pd.history.shift();
    emit(s, ev, { type: 'saleBid', pendingId: pd.id, player: pi, amount: a.amount });
  }

  // 落槌（只由服务器的计时发出）：有人出过价就成交，没人出价就流拍
  function saleClose(s, pi, a, ev) {
    const pd = requireSale(s);
    const out = { type: 'saleEnd', pendingId: pd.id, color: pd.color, cardId: pd.cardId, sold: pd.leader != null };
    if (pd.leader != null) {
      const w = pd.leader;
      const P = s.players[w];
      const paid = bankSubset(P.bank, pd.amount);
      for (const id of paid) { P.bank.splice(P.bank.indexOf(id), 1); s.discard.push(id); }
      takeFromPiles(s, pd.cardId);
      const setId = placeCard(s, w, pd.cardId, pd.color);
      P.stats.paid += sum(paid);
      // 付拍卖款不是谁打出来的战果：要是回合方的对手为此花光了银行，"超级金库"不算
      if (w !== s.turn.player) s.turn.oppBank = Math.min(s.turn.oppBank || 0, P.bank.length);
      Object.assign(out, { player: w, price: pd.amount, paid: sum(paid), paidIds: paid, setId });
    }
    emit(s, ev, out);
    finishPending(s, ev);
  }

  // 赎回抵押：自己回合的出牌阶段随时可以，用银行里的钱付（不找零），钱进弃牌堆；不占出牌次数
  function redeem(s, pi, a, ev) {
    requireMain(s, pi);
    const p = s.players[pi];
    const set = p.sets.find((x) => x.id === a.setId);
    if (!set || !set.mortgage) fail('NOT_MORTGAGED');
    const ids = requireIdList(a.cardIds);
    for (const id of ids) if (p.bank.indexOf(id) < 0) fail('NOT_IN_BANK');
    const cost = redeemCost(s, set);
    if (sum(ids) < cost) fail('PAY_NOT_ENOUGH');
    for (const id of ids) { p.bank.splice(p.bank.indexOf(id), 1); s.discard.push(id); }
    set.mortgage = null;
    emit(s, ev, { type: 'redeemed', player: pi, setId: set.id, color: set.color, cost, paid: sum(ids), cardIds: ids.slice() });
    checkWin(s, ev);
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

  // 从牌堆顶摸一张。设了摸牌照顾（drawSeat / drawEdge）时：被照顾的一方从顶上几张里挑对自己最好的，另一方挑最差的
  // （其余的牌留在原处）。extra：这次已经摸到、还没进手牌的牌
  function takeCard(s, pi, extra) {
    const k = s.rules.drawEdge > 0 && s.rules.drawSeat >= 0 ? Math.min(s.deck.length, s.rules.drawEdge + 1) : 1;
    if (k <= 1) return s.deck.pop();
    const fav = s.rules.drawSeat === pi;
    // 被照顾的一方没明显领先时才从 drawEdge+1 张里挑好牌（领先了就正常摸，比分不至于一边倒）；
    // 另一方一直从少几张里挑差的，到了赛点再从 3 倍那么多张里挑最差的，基本摸不到最后那张
    const gap = progress(s, pi) - progress(s, other(pi));
    if (fav && gap >= 0.5) return s.deck.pop();
    const point = !fav && fullColors(s, pi).length >= s.rules.setsToWin - 1;
    const n = Math.min(s.deck.length, fav ? k : point ? s.rules.drawEdge * 3 + 1 : Math.ceil(s.rules.drawEdge / 2) + 1);
    let at = s.deck.length - 1;
    let bv = null;
    for (let j = s.deck.length - n; j < s.deck.length; j++) {
      const v = cardWorth(s, pi, s.deck[j], extra);
      if (bv == null || (fav ? v > bv : v < bv)) { bv = v; at = j; }
    }
    return s.deck.splice(at, 1)[0];
  }

  // 一张牌对 pi 大概有多好（只给摸牌照顾用）：能凑满一套的地产、强力行动牌、大钱 > 散地产、小钱
  function cardWorth(s, pi, id, extra) {
    const c = CARDS[id];
    const hand = s.players[pi].hand.concat(extra || []);
    const prop = (color) => {
      const have = fillOf(s, pi, color) + hand.filter((h) => CARDS[h].type === 'property' && CARDS[h].color === color).length;
      return have + 1 >= sizeOf(color) ? 18 : 5 + (have / sizeOf(color)) * 8;
    };
    const myFull = fullColors(s, pi);
    switch (c.type) {
      case 'money': return c.value * 0.9;
      case 'property': return prop(c.color);
      case 'wild': return c.any ? 12 : 4 + Math.max(...c.colors.map(prop)) * 0.8;
      case 'rent': return 3 + (c.any ? 3 : 0) + (myFull.some((k) => c.any || c.colors.indexOf(k) >= 0) ? 7 : 0);
      default: return ({ dealBreaker: fullColors(s, other(pi)).length ? 20 : 9, justSayNo: fullColors(s, other(pi)).length >= s.rules.setsToWin - 1 ? 25 : 13, slyDeal: 9, forcedDeal: 8, debtCollector: 6, birthday: 4, passGo: 6,
        doubleRent: 5, house: myFull.length ? 8 : 2, hotel: myFull.length ? 7 : 2, bankruptcy: 10, liquidation: 11, hugeWin: 10 })[c.action] || 5;
    }
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
      got.push(takeCard(s, pi, got));
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
    BID: bid,
    GIFT: giftAction,
    REDEEM: redeem,
    TYCOON: tycoonChoose,
    SPIN: spin,
    CASH_OUT: cashOut,
    SALE_BID: saleBid,
    SALE_CLOSE: saleClose,
  }));

  function reduce(s, a, ev) {
    if (!a || typeof a !== 'object' || typeof a.type !== 'string') fail('BAD_ACTION');
    const fn = HANDLERS[a.type];
    if (typeof fn !== 'function') fail('UNKNOWN_ACTION');
    if (!isPlayer(a.player)) fail('BAD_PLAYER');
    if (s.phase === 'gameOver') fail('GAME_OVER');
    fn(s, a.player, a, ev);
    checkTycoon(s, ev); // 刚触发贪婪大亨：先让他选，再看要不要自动结束回合
    checkTakeover(s, ev); // 有人集齐了恶意收购的颜色：先玩轮盘赌（出满 3 张的也等轮盘赌玩完再结束回合）
    checkSale(s, ev); // 双方有 ≥2 种相同颜色的地产：整局掷一次，中了就开拍（出满 3 张的也等拍完再结束回合）
    autoEndTurn(s, ev);
    if (s.phase === 'play') checkAuction(s, ev); // 这一步让双方都有了同色完整套：开始秘密竞价
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
    if (s.pending && s.pending.action === 'takeover') return; // 轮盘赌的输赢不算这回合的战果（结束时重新定基准）
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
    const got = collectMoney(s, target);
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
    vampireDrip(s, ev, pi, valueOf(a.cardId));
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
    if (s.turn.mech) fail('MECH_USED');
  }

  // 押 ×m：基准几率 1/m，实际按手气现算（见 chance）。赢了这次收 m 倍，输了返回 0（牌已经打出去作废）
  function rollBet(s, pi, a, ev, amount, doubles) {
    if (a.bet == null) return amount;
    s.turn.gambled = true;
    s.turn.mech = 'gamble';
    const won = roll(s, pi, a.bet >= 4 ? 'gamble4' : 'gamble2', 100 / a.bet);
    const st = s.players[pi].stats;
    st.bets++;
    if (won) st.betsWon++;
    // 赌场礼赠：连续押 ×4 的次数（押 ×2 就断）；攒够了下回合开始送一份
    st.x4Streak = a.bet >= 4 ? st.x4Streak + 1 : 0;
    const giftNow = s.rules.casinoGift && st.x4Streak >= s.rules.giftStreak;
    if (giftNow) st.x4Streak = 0;
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
    if (giftNow) {
      s.players[pi].gift++;
      emit(s, ev, { type: 'giftEarned', player: pi, streak: s.rules.giftStreak });
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
    const surge = surgeFor(s, pi);
    checkBet(s, a);
    spend(s, pi, a.cardId);
    for (const id of doubles) spend(s, pi, id);
    s.turn.plays += 1 + doubles.length;
    s.players[pi].boost = null; // Huge Win 加成只管下一次收租：这次用掉（选的颜色不在加成里也一样作废）
    const amount = rollBet(s, pi, a, ev, base * Math.pow(2, doubles.length) * boost * surge, doubles);
    if (!amount) return undefined; // 赌输了：牌作废，不用对方回应
    return openPending(s, ev, { action: 'rent', cardId: a.cardId, doubles: doubles.slice(), color, base, boost, surge, amount, wild: !!c.any, bet: a.bet || 1 });
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
    if ((isPaymentKind(pd.action) || pd.action === 'bankruptcy') && vampire(s, pd.target)) { // 贪婪大亨吸血：向他收的钱只算一半
      pd.full = pd.amount;
      pd.amount = halfOf(pd.amount);
      pd.half = true;
    }
    s.pending = pd;
    s.phase = 'respond';
    const e = { type: 'actionPlayed', player: actor, cardId: pd.cardId, action: pd.action, pendingId: pd.id, target: pd.target };
    if (pd.half) Object.assign(e, { half: true, full: pd.full });
    if (isPaymentKind(pd.action)) { e.amount = pd.amount; if (pd.bet > 1) e.bet = pd.bet; }
    if (pd.action === 'rent') Object.assign(e, { color: pd.color, base: pd.base, doubles: pd.doubles.slice(), wild: pd.wild, boost: pd.boost || 1, surge: pd.surge || 1 });
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
    if (['auction', 'gift', 'tycoon', 'takeover', 'sale'].indexOf(s.pending.action) >= 0) fail('WRONG_PHASE'); // 这几个有自己的动作（BID / GIFT / TYCOON / SPIN / SALE_BID）
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
    const placements = transfer(s, from, to, ids);
    const paid = sum(ids);
    s.players[from].stats.paid += paid;
    const st = s.players[to].stats;
    st.received += paid;
    addDealt(s, to, paid);
    st.biggestHit = Math.max(st.biggestHit, paid);
    emit(s, ev, { type: 'payment', pendingId: pd.id, action: pd.action, from, to, amount: pd.amount, paid, cardIds: ids.slice(), placements, auto: !!auto });
    hurt(s, ev, from, to, paid);
    grabbed(s, ev, to, sum(ids.filter(isProp)));
    // 大乐透：收租结算时按手气几率额外中奖（对方付不出钱也照样可能中）；同一个人连续 lotteryPity 次没中，这一次保底必中。
    // 保底时牌堆和弃牌堆里一张钱都凑不出来就不算中，计数留着，下次收租接着保底
    // 这回合已经触发过别的机制（比如这张租金押了赌一把）就不开奖，也不算一次没中
    if (pd.action === 'rent' && s.rules.lottery && !s.turn.mech) {
      const ls = s.players[to].stats;
      const hit = rand(s) * 100 < chance(s, to, 'lottery', s.rules.lotteryChance);
      const pity = !hit && s.rules.lotteryPity > 0 && ls.lottoMiss + 1 >= s.rules.lotteryPity;
      const won = (hit || pity) && lottery(s, to, ev, pity);
      ls.lottoMiss = won ? 0 : ls.lottoMiss + 1;
      luckAfter(s, to, 'lottery', won);
      if (won) s.turn.mech = 'lottery';
    }
    finishPending(s, ev);
  }

  // 把桌面上的牌交给对方：地产进对方地产区（保持原颜色），其余进对方银行
  function transfer(s, from, to, ids) {
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
    return placements;
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
      hurt(s, ev, T, A, valueOf(pd.targetCardId));
      grabbed(s, ev, A, valueOf(pd.targetCardId));
    } else if (pd.action === 'forcedDeal') {
      const giveColor = detach(s, A, pd.giveCardId);
      const takeColor = detach(s, T, pd.targetCardId);
      const gaveSetId = placeCard(s, T, pd.giveCardId, giveColor);
      const tookSetId = placeCard(s, A, pd.targetCardId, takeColor);
      s.players[A].stats.steals++;
      addDealt(s, A, valueOf(pd.targetCardId));
      emit(s, ev, { type: 'swap', pendingId: pd.id, actor: A, target: T, gave: pd.giveCardId, took: pd.targetCardId, gaveColor: giveColor, tookColor: takeColor, gaveSetId, tookSetId });
      grabbed(s, ev, A, valueOf(pd.targetCardId));
    } else if (pd.action === 'dealBreaker') {
      const tp = s.players[T];
      const idx = tp.sets.findIndex((x) => x.id === pd.targetSetId);
      if (idx < 0) fail('BAD_TARGET');
      const set = tp.sets.splice(idx, 1)[0];
      s.players[A].sets.push(set);
      const v = sum(set.cards.concat(set.house != null ? [set.house] : [], set.hotel != null ? [set.hotel] : []));
      addDealt(s, A, v, true);
      emit(s, ev, { type: 'setStolen', pendingId: pd.id, from: T, to: A, setId: set.id, color: set.color, cardIds: set.cards.slice(), house: set.house, hotel: set.hotel });
      hurt(s, ev, T, A, v);
      grabbed(s, ev, A, sum(set.cards));
    } else if (pd.action === 'bankruptcy') {
      const tb = s.players[T].bank;
      const ids = vampire(s, T) ? bankSubset(tb, halfOf(sum(tb))) : tb.slice(); // 吸血：只拿走一半（不找零）
      for (const id of ids) tb.splice(tb.indexOf(id), 1);
      s.players[A].bank.push(...ids);
      const got = sum(ids);
      s.players[T].stats.paid += got;
      const st = s.players[A].stats;
      st.received += got;
      addDealt(s, A, got);
      st.biggestHit = Math.max(st.biggestHit, got);
      emit(s, ev, { type: 'bankrupt', pendingId: pd.id, from: T, to: A, cardIds: ids, amount: got, half: vampire(s, T) });
      hurt(s, ev, T, A, got);
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
      hurt(s, ev, T, A, sum(gone));
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
      hurt(s, ev, T, A, sum(gone));
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
    const away = a.away === true; // 服务器替长时间离线的一方认输（对手申请判胜）
    emit(s, ev, Object.assign({ type: 'resign', player: pi }, away ? { away } : null));
    endGame(s, ev, other(pi), away ? 'away' : 'resign');
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
    powerTurnEnd(s, ev, pi);
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
      turn: { player: s.turn.player, number: s.turn.number, plays: s.turn.plays, max: playsMax(s), bonus: s.turn.bonus || 0, gambled: !!s.turn.gambled, lapsed: s.turn.lapsed || 0, mech: s.turn.mech || null, playsLeft: Math.max(0, playsMax(s) - s.turn.plays) },
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
          mortgage: set.mortgage ? { turn: set.mortgage.turn, cost: redeemCost(s, set), cheapAt: set.mortgage.turn + s.rules.mortgageTurns } : null,
        })),
        loose: p.loose.slice(),
        fullColors: fullColors(s, i),
        tableValue: sum(payableItems(s, i)),
        stats: publicStats(p.stats),
        boost: p.boost ? { mult: p.boost.mult, colors: p.boost.colors.slice() } : null,
        awards: p.awards.slice(),
        gift: p.gift || 0,
        power: p.power || 0,   // 半点
        lost: p.lost || 0,
        haul: p.haul || 0,
        ghostBar: ghostBar(s, i),
        ghostN: p.ghostN || 0,
        curse: p.curse || 0,
        grab: p.grab || 0,
        surge: p.surge ? { left: p.surge.left, since: p.surge.since } : null,
      })),
      pending: s.pending ? viewPending(s, v) : null,
      discardNeed: s.phase === 'discard' ? s.discardNeed : 0,
      result: s.result ? Object.assign({}, s.result) : null,
      stake: s.stake,
      cube: s.cube,
      pot: s.pot,
      tycoon: s.tycoon ? Object.assign({}, s.tycoon) : null,
      takeover: s.takeover ? Object.assign({}, s.takeover) : null,
      rules: publicRules(r),
    };
  }

  // 秘密竞价的出价是暗标：别人只看得到"出过价了"（true），看不到出了哪些牌
  function viewPending(s, v) {
    const c = clonePending(s.pending);
    if (c.bids) c.bids = c.bids.map((b, i) => (b == null ? null : i === v ? b : true));
    return c;
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
      redeem: main ? me.sets.filter((x) => x.mortgage).map((x) => ({ setId: x.id, color: x.color, cost: redeemCost(s, x), early: s.turn.number - x.mortgage.turn < s.rules.mortgageTurns, cheapAt: x.mortgage.turn + s.rules.mortgageTurns })) : [],
      respond: s.phase === 'respond' && (s.pending.awaiting === pi || (s.pending.action === 'auction' && s.pending.bids[pi] == null) || (s.pending.action === 'sale' && s.pending.leader !== pi)) ? respondOptions(s, pi) : null, // 拍卖：没领先的一方都能出价
      discard: s.phase === 'discard' && s.turn.player === pi ? { count: s.discardNeed } : null,
    };
  }

  const betsFor = (s) => (s.rules.gamble && !s.turn.gambled && !s.turn.mech ? BETS.slice() : []); // 这回合触发过别的机制就不能再赌

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
        const surge = surgeFor(s, pi);
        if (base > 0) colors.push({ color, amount: base * boost * surge, base, boost, surge });
      }
      if (!colors.length) return null;
      const doubleIds = me.hand.filter((h) => isAct(h, 'doubleRent'));
      const maxDoubles = c.any && !s.rules.doubleRentWithWildRent ? 0 : Math.max(0, Math.min(doubleIds.length, s.rules.maxDoubleRent, left - 1));
      return { kind: 'rent', colors, doubleIds, maxDoubles, wild: c.any, bets: betsFor(s), half: vampire(s, oi) };
    }
    switch (c.action) {
      case 'passGo':
        return { kind: 'passGo' };
      case 'debtCollector':
        return { kind: 'debtCollector', amount: 5, bets: betsFor(s), half: vampire(s, oi) };
      case 'birthday':
        return { kind: 'birthday', amount: 2, bets: betsFor(s), half: vampire(s, oi) };
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
        return bank.length ? { kind: 'bankruptcy', amount: sum(bank), count: bank.length, half: vampire(s, oi) } : null;
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
    if (pd.action === 'auction') {
      const bank = s.players[pi].bank.slice();
      return { pendingId: pd.id, action: 'auction', color: pd.color, bank, bankTotal: sum(bank), oppBid: pd.bids[other(pi)] != null, mySetId: pd.sets[pi], oppSetId: pd.sets[other(pi)] };
    }
    if (pd.action === 'gift') return { pendingId: pd.id, action: 'gift', canOpen: true, canGive: true };
    if (pd.action === 'sale') {
      const bank = sum(s.players[pi].bank);
      return { pendingId: pd.id, action: 'sale', color: pd.color, cardId: pd.cardId, price: pd.amount, leader: pd.leader, min: pd.amount + 1, max: bank, canBid: bank >= pd.amount + 1 };
    }
    if (pd.action === 'takeover') {
      const r = s.rules;
      return { pendingId: pd.id, action: 'takeover', color: pd.color, chips: pd.chips[pi], start: pd.start[pi], spins: pd.spins[pi], maxSpins: r.rouletteSpins,
        canCashOut: pd.spins[pi] > 0, min: r.rouletteMin, max: Math.min(r.rouletteMax, pd.chips[pi]), picks: ROULETTE_PICKS.slice(), numbers: WHEEL.filter((n) => n !== 0), mult: ROULETTE_HIT };
    }
    if (pd.action === 'tycoon') {
      const value = propValue(s, pi);
      return { pendingId: pd.id, action: 'tycoon', propValue: value, cash: cashOf(s, value), pct: s.rules.tycoonCash, rentAny: s.deck.concat(s.discard).filter((id) => CARDS[id].type === 'rent' && CARDS[id].any).length, step: s.rules.vampireStep };
    }
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
    if (o.respond && o.respond.action === 'auction') { // 第一个是出 0（超时就替他出 0），也给一个全押、一个随机出价
      const bank = o.respond.bank;
      const some = bank.filter((id, k) => (k + s.seq) % 2 === 0);
      return [{ type: 'BID', player: pi, cardIds: [] }, { type: 'BID', player: pi, cardIds: bank.slice() }, { type: 'BID', player: pi, cardIds: some }];
    }
    if (o.respond && o.respond.action === 'gift') return [{ type: 'GIFT', player: pi, give: false }, { type: 'GIFT', player: pi, give: true }];
    if (o.respond && o.respond.action === 'tycoon') return [{ type: 'TYCOON', player: pi, vampire: false }, { type: 'TYCOON', player: pi, vampire: true }];
    if (o.respond && o.respond.action === 'sale') { // 拍卖：加 1M、加 2M、加 5M（不超过银行里的钱）；出不起就没有可做的
      const R = o.respond;
      if (!R.canBid) return [];
      return [...new Set([R.min, R.min + 1, R.min + 4].filter((x) => x <= R.max))].map((amount) => ({ type: 'SALE_BID', player: pi, amount }));
    }
    if (o.respond && o.respond.action === 'takeover') { // 能离开时第一个是离开（超时就带着筹码走），否则第一个是押最少的红色（超时替他转一局）
      const R = o.respond;
      const out = R.canCashOut ? [{ type: 'CASH_OUT', player: pi }] : [];
      for (const pick of R.picks) out.push({ type: 'SPIN', player: pi, pick, wager: R.min }, { type: 'SPIN', player: pi, pick, wager: R.max });
      out.push({ type: 'SPIN', player: pi, pick: R.numbers[s.seq % R.numbers.length], wager: R.min });
      return out;
    }
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
    for (const r of o.redeem) if (sum(s.players[pi].bank) >= r.cost) acts.push({ type: 'REDEEM', player: pi, setId: r.setId, cardIds: bankSubset(s.players[pi].bank, r.cost) });
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

  /* ═══════════════════════════ AI 对手（荷官） ═══════════════════════════
   * 只用自己座位看得到的东西做决定：自己的手牌、桌面、双方银行、对方手牌张数、正在发生的行动——不看对方手牌和牌堆顺序。
   * level（0–1）是牌力：越高越少犯错、越会抢关键牌、越舍得用「反对行动」。局内还会按地产进度自动收放：
   * 领先了就松一点，落后了就紧一点（像荷官控场，让对局一直有悬念）。rnd 不传就用 Math.random（不碰对局自己的随机数）。 */
  function botChoose(s, pi, opts) {
    const o = opts || {};
    const rnd = typeof o.rnd === 'function' ? o.rnd : Math.random;
    const acts = listActions(s, pi);
    if (!acts.length) return null;
    if (acts.length === 1 && acts[0].type !== 'SALE_BID') return acts[0]; // 拍卖可以不出价：交给 botRespond 决定
    const oi = other(pi);
    const ahead = progress(s, pi) - progress(s, oi);
    const lv = o.level == null ? 0.6 : o.level;
    const L = Math.max(0, Math.min(0.97, o.firm ? lv : lv - 0.22 * Math.max(0, ahead - 0.4) + 0.12 * Math.max(0, -ahead - 0.6))); // firm：不按进度收放（一直全力）
    const op = getOptions(s, pi);
    if (op.respond) return botRespond(s, pi, op.respond, acts, L, rnd, !!o.firm);
    const me = s.players[pi];
    const them = s.players[oi];
    const bankTotal = sum(me.bank);
    const colorOfOn = (P, id) => { for (const set of P.sets) if (set.cards.indexOf(id) >= 0) return set.color; return null; };
    const gainFor = (color) => (fillOf(s, pi, color) + 1 >= sizeOf(color) ? 45 : fillOf(s, pi, color) * 6);
    const hurtFor = (color) => (color && wouldComplete(s, oi, color) ? 18 : 0);
    const attack = (v) => (rnd() < (1 - L) * 0.55 ? v - 45 : v); // 手软：偶尔放过一次进攻
    const over = me.hand.length > s.rules.handLimit; // 手牌超了：大牌存了 / 随手打掉也比弃掉强
    const oppPay = sum(payableItems(s, oi)); // 对方桌上能拿来付款的总额（0 = 收钱的牌打出去也是白打）
    const score = (a) => {
      const c = CARDS[a.cardId];
      switch (a.type) {
        case 'END_TURN': return 1 + (rnd() < (1 - L) * 0.25 ? 30 : 0); // 牌力低时偶尔提前收手
        case 'MOVE_CARD': { // 整理桌面不占出牌次数：挪一张多功能地产能凑满一个新颜色就挪（从满套挪出、挪进已经满了的颜色都不算，不会来回挪）
          const from = me.sets.find((x) => x.cards.indexOf(a.cardId) >= 0);
          if (!from || isFull(from) || fullColors(s, pi).indexOf(a.color) >= 0) return -5;
          const to = a.setId != null ? me.sets.find((x) => x.id === a.setId) : null;
          if ((to ? to.cards.length : fillOf(s, pi, a.color)) + 1 < sizeOf(a.color)) return -5;
          return fullColors(s, pi).length + 1 >= s.rules.setsToWin ? 300 : 120; // 免费的，要赶在出满 3 张（自动结束回合）之前挪
        }
        case 'RAISE': case 'MOVE_BUILDING': return -5;
        case 'REDEEM': return 26;
        case 'PLAY_BANK': {
          if (c.type === 'action' && ['dealBreaker', 'justSayNo', 'slyDeal', 'liquidation', 'hugeWin', 'bankruptcy'].indexOf(c.action) >= 0) return rnd() < (1 - L) * 0.3 ? 20 : over ? 2 : -5; // 牌力低时偶尔把大牌当钱存了；平时攥在手里（银行是亮着的，存掉大牌一眼就看得出），手牌超了才存
          return 8 + c.value * (bankTotal < 8 ? 2 : 1);
        }
        case 'PLAY_PROPERTY': return 40 + gainFor(a.color) + (a.color && fullColors(s, pi).length >= s.rules.setsToWin - 1 && fillOf(s, pi, a.color) + 1 >= sizeOf(a.color) ? 200 : 0);
        case 'PLAY_ACTION': {
          const p = (op.hand.find((h) => h.cardId === a.cardId) || {}).play || {};
          const bet = a.bet ? (rnd() < (a.bet === 2 ? 0.28 : 0.1) ? 4 : -60) : 0; // 偶尔赌一把，制造悬念
          if (c.type === 'rent') {
            const col = (p.colors || []).find((x) => x.color === a.color);
            const amt = (col ? col.amount : 0) * Math.pow(2, (a.doubles || []).length);
            if (!a.bet && !oppPay) return -5; // 对方桌上一分钱都没有：留着（赌一把的不算——中了照样有好处）
            if (amt < 2) return over ? 3 : -5; // 收 1M 不值一张租金卡
            const boost = op.playsLeft > 1 && fullColors(s, pi).indexOf(a.color) < 0 && me.hand.some((h) => isProp(h) && colorsOf(h).indexOf(a.color) >= 0); // 手里有同色地产：先放下去，租金更高
            return 30 + Math.min(amt, sum(them.bank) + 6) * 3 - (a.doubles || []).length * 5 + bet - (boost ? 25 : 0);
          }
          switch (c.action) {
            case 'dealBreaker': { const set = them.sets.find((x) => x.id === a.targetSetId); return attack(90 + (set ? sum(set.cards) : 0) * 2); }
            case 'liquidation': return attack(80);
            case 'hugeWin': return p.remove >= 3 ? attack(78) : over ? 8 : -5; // 对方桌上不到 3 张：留着
            case 'slyDeal': { const col = colorOfOn(them, a.targetCardId); return attack(48 + valueOf(a.targetCardId) * 3 + (col ? gainFor(col) : 0) + hurtFor(col)); }
            case 'forcedDeal': { // 换过去的那张（多功能地产按它能放的每种颜色算）不能正好帮对方凑满一套，更不能直接送他赢；扣分放在 attack 外面，手软也不会犯这个错
              const tc = colorOfOn(them, a.targetCardId); const gc = colorOfOn(me, a.giveCardId);
              const gives = colorsOf(a.giveCardId).filter((col) => wouldComplete(s, oi, col));
              const giveCost = gives.some((col) => fullCountWith(s, oi, col) >= s.rules.setsToWin) ? 400 : gives.length ? 70 : 0;
              return -giveCost + attack(22 + (valueOf(a.targetCardId) - valueOf(a.giveCardId)) * 3 + (tc ? gainFor(tc) : 0) - (gc && fillOf(s, pi, gc) + 1 >= sizeOf(gc) ? 60 : 0));
            }
            case 'debtCollector': return !a.bet && !oppPay ? -5 : 44 + bet;
            case 'birthday': return !a.bet && !oppPay ? -5 : 34 + bet;
            case 'bankruptcy': return sum(them.bank) >= 4 || over ? attack(14 + sum(them.bank) * 3) : -5; // 银行里没几个钱：留着
            case 'passGo': return me.hand.length <= 4 ? 58 : me.hand.length + 1 > s.rules.handLimit + (op.playsLeft - 1) ? 4 : 18; // 摸完回合末要弃牌：先出别的
            case 'house': case 'hotel': return 50;
            default: return 5;
          }
        }
        default: return 0;
      }
    };
    // tease（下马威局）：能直接赢也先压着，等对方摸到赛点再收（或者拖太久了 / 牌快摸完了），让对方觉得"就差一点"
    let pool = acts;
    if (o.tease && fullColors(s, oi).length < s.rules.setsToWin - 1 && s.turn.number < 30 && s.deck.length > 12) {
      const need = s.rules.setsToWin;
      const winsNow = (a) => ((a.type === 'PLAY_PROPERTY' || a.type === 'MOVE_CARD') && a.color && fullCountWith(s, pi, a.color) >= need) ||
        (a.type === 'PLAY_ACTION' && CARDS[a.cardId].action === 'dealBreaker' && fullColors(s, pi).length + 1 >= need);
      const rest = acts.filter((a) => !winsNow(a));
      if (rest.length && rest.length < acts.length) pool = rest;
    }
    const ranked = pool.map((a) => ({ a, v: score(a) + rnd() * 3 })).sort((x, y) => y.v - x.v);
    // 牌力不满：有时挑第二、第三好的（但不会挑负分的）
    if (ranked.length > 1 && rnd() > L) {
      const pool = ranked.slice(1, 4).filter((x) => x.v > 0);
      if (pool.length) return pool[Math.floor(rnd() * pool.length)].a;
    }
    return ranked[0].a;
  }

  function botRespond(s, pi, R, acts, L, rnd, firm) {
    const pick = (t) => acts.find((a) => a.type === t);
    const pd = s.pending;
    if (R.action === 'auction') { // 出价：按自己那套值多少出（输了钱和整套都没了）；牌力低时常常出少了，但银行里有钱就不会一分不出
      const mine = s.players[pi].sets.find((x) => x.id === R.mySetId);
      if (!R.bankTotal || !mine) return acts[0];
      const worth = sum(mine.cards) + (mine.house != null ? 3 : 0) + (mine.hotel != null ? 4 : 0) + COLORS[mine.color].rent[sizeOf(mine.color) - 1];
      let target = Math.round(worth * (0.6 + 0.6 * L) + (rnd() - 0.5) * 3);
      if (rnd() < (1 - L) * 0.5) target = Math.round(target * (0.4 + rnd() * 0.3));
      return { type: 'BID', player: pi, cardIds: bankSubset(R.bank, Math.max(1, Math.min(R.bankTotal, target))) };
    }
    if (R.action === 'gift') { // 礼盒：对方领先就送给他开（领先的人手气差），自己领先就自己开
      const giveIt = progress(s, other(pi)) > progress(s, pi) ? rnd() < 0.5 + L * 0.4 : rnd() < 0.25;
      return acts.find((a) => a.give === giveIt) || acts[0];
    }
    if (R.action === 'tycoon') return acts.find((a) => a.vampire === (sum(s.players[other(pi)].bank) >= 6 ? rnd() < 0.6 : rnd() < 0.3)) || acts[0];
    if (R.action === 'sale') { // 拍卖：按这张地产对自己值多少出价（能凑满一套、能拦住对方凑满的更舍得），超过心理价就不跟了（返回 null）
      const color = R.color;
      const completes = wouldComplete(s, pi, R.color);
      const blocks = wouldComplete(s, other(pi), color);
      let worth = valueOf(R.cardId) + 1 + (completes ? 4 + COLORS[color].rent[sizeOf(color) - 1] : fillOf(s, pi, color) * 1.5) + (blocks ? 3 : 0);
      worth = worth * (0.7 + 0.5 * L) + (rnd() - 0.5) * 2;
      const cap = Math.min(R.max, Math.floor(worth), completes ? R.max : Math.floor(R.max * 0.8));
      if (R.min > cap) return null;
      return { type: 'SALE_BID', player: pi, amount: R.min + 1 <= cap && rnd() < 0.3 ? R.min + 1 : R.min };
    }
    if (R.action === 'takeover') { // 轮盘赌：赢了多半见好就收，输了更想翻本；偶尔押个数字搏一把
      const cash = acts.find((a) => a.type === 'CASH_OUT');
      if (cash && rnd() < (R.chips >= R.start ? 0.5 + 0.35 * L : 0.25 + 0.2 * L)) return cash;
      const number = rnd() < 0.15;
      const pick = number ? R.numbers[Math.floor(rnd() * R.numbers.length)] : R.picks[Math.floor(rnd() * R.picks.length)];
      const wager = Math.max(R.min, Math.min(R.max, Math.round(R.max * (0.35 + rnd() * 0.65))));
      return { type: 'SPIN', player: pi, pick, wager };
    }
    if (pd && pd.action === 'raise') return progress(s, other(pi)) - progress(s, pi) > 1.6 && rnd() < 0.5 ? pick('FOLD') || acts[0] : pick('ACCEPT') || acts[0];
    const jsn = pick('JUST_SAY_NO');
    if (jsn) {
      let threat = 0;
      if (R.role === 'actor') threat = 0.8; // 对方挡了我：再挡回去
      else if (['dealBreaker', 'liquidation', 'hugeWin'].indexOf(pd.action) >= 0) threat = 1;
      else if (pd.action === 'bankruptcy') threat = pd.amount >= 6 ? 0.9 : 0.3;
      else if (pd.action === 'slyDeal' || pd.action === 'forcedDeal') {
        const col = (() => { for (const set of s.players[pi].sets) if (set.cards.indexOf(pd.targetCardId) >= 0) return set; return null; })();
        threat = col && isFull(col) ? 0.9 : col && col.cards.length >= sizeOf(col.color) - 1 ? 0.7 : 0.25;
      } else if (isPaymentKind(pd.action)) { // 看真要付出去的是什么：只动银行里的钱就别轻易浪费反对行动；要交出快凑满的地产（或者正好帮对方凑满的）就挡
        const me = s.players[pi];
        const pay = suggestPayment(s, pi, pd.amount);
        const hurts = pay.some((id) => { const set = me.sets.find((x) => x.cards.indexOf(id) >= 0); return set && (set.cards.length >= sizeOf(set.color) - 1 || colorsOf(id).some((col) => wouldComplete(s, other(pi), col))); });
        const cash = pay.every((id) => me.bank.indexOf(id) >= 0);
        threat = hurts ? 0.95 : cash ? (pd.amount >= 8 ? 0.6 : pd.amount >= 5 ? 0.25 : 0.05) : pd.amount >= 5 ? 0.6 : 0.3;
      }
      // firm（下马威局）：对方这一下可能直接赢 / 拿走整套时一定挡
      if (firm && (threat >= 0.7 || fullColors(s, other(pi)).length >= s.rules.setsToWin - 1) && R.role !== 'actor') return jsn;
      if (rnd() < threat * (0.35 + 0.6 * L)) return jsn;
    }
    return pick('PAY') || pick('ACCEPT') || acts[0];
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
      const danger = colorsOf(id).filter((col) => wouldComplete(s, oi, col)); // 多功能地产：对方拿过去可以放进它能放的任何一种颜色
      if (danger.length) cost += danger.some((col) => fullCountWith(s, oi, col) >= s.rules.setsToWin) ? 500 : 60;
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
    if (e.type === 'auctionBid' && e.player !== viewer) { const c = Object.assign({}, e); delete c.cardIds; delete c.amount; return c; } // 暗标
    if (e.type === 'giftOpened' && e.to !== viewer && ['bigAction', 'action'].indexOf(e.kind) >= 0) { const c = Object.assign({}, e); delete c.cardIds; return c; } // 进了别人手里的牌
    if (e.type === 'ghost' && e.player !== viewer && e.kind === 'debt') { const c = Object.assign({}, e); delete c.cardIds; return c; } // 捉鬼套装送进手里的讨债人：只说张数
    if (e.type === 'lottery' && 'pity' in e) { const c = Object.assign({}, e); delete c.pity; return redact(c, viewer); } // 保底也不公开
    if (e.type === 'tycoonChosen' && e.player !== viewer && e.rentIds) { const c = Object.assign({}, e); delete c.rentIds; return c; } // 套现拿进手里的全色租金
    if (e.type === 'roulettePrize' && e.player !== viewer && e.actionId != null) { const c = Object.assign({}, e); delete c.actionId; return c; } // 进了别人手里的 10M 行动卡
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
    const W = (h) => `${(h || 0) / 2} 点筹码`;
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
        const H = e.half ? `（${T} 在吸血，原价 ${e.full}M 只算一半）` : '';
        switch (e.action) {
          case 'passGo': return `${P} 打出${C(e.cardId)}，再摸 2 张`;
          case 'debtCollector': return `${P} 打出${C(e.cardId)}，向 ${T} 讨 ${e.amount}M${e.bet > 1 ? `（赌赢 ×${e.bet}）` : ''}${H}`;
          case 'birthday': return `${P} 打出${C(e.cardId)}，${T} 要随礼 ${e.amount}M${e.bet > 1 ? `（赌赢 ×${e.bet}）` : ''}${H}`;
          case 'rent': return `${P} 打出${C(e.cardId)}${e.doubles && e.doubles.length ? `并叠了 ${e.doubles.length} 张${A('doubleRent')}` : ''}，按${Z(e.color)}向 ${T} 收租 ${e.amount}M${e.boost > 1 ? `（${A('hugeWin')} ×${e.boost}）` : ''}${e.surge > 1 ? `（电力满格 ×${e.surge}）` : ''}${e.bet > 1 ? `（赌赢 ×${e.bet}）` : ''}${H}`;
          case 'slyDeal': return `${P} 打出${C(e.cardId)}，要拿走 ${T} 的${C(e.targetCardId)}`;
          case 'forcedDeal': return `${P} 打出${C(e.cardId)}，要用${C(e.giveCardId)}换 ${T} 的${C(e.targetCardId)}`;
          case 'dealBreaker': return `${P} 打出${C(e.cardId)}，要抢走 ${T} 的整套${Z(e.color)}`;
          case 'bankruptcy': return e.half ? `${P} 打出${C(e.cardId)}，要拿走 ${T} 银行里一半的钱（${e.amount}M，${T} 在吸血、只算一半）` : `${P} 打出${C(e.cardId)}，要拿走 ${T} 银行里的全部 ${e.amount}M`;
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
      case 'bankrupt': return e.cardIds.length ? `${N(e.to)} 拿走了 ${N(e.from)} 银行里${e.half ? '一半的钱' : '的全部'} ${e.amount}M` : `${N(e.from)} 的银行已经空了，什么也没拿到`;
      case 'liquidated': return `${N(e.by)} 清算了 ${N(e.from)} 的整套${Z(e.color)}` + (e.handCount ? `，${N(e.from)} 的 ${e.handCount} 张手牌全部弃掉` : '');
      case 'hugeWin': {
        const gone = e.cardIds.length ? `${N(e.from)} 桌上的 ${e.cardIds.length} 张地产全部消失` : `${N(e.from)} 桌上本来就没有地产`;
        return gone + (e.boostColors.length ? `；${N(e.by)} 的${e.boostColors.map(Z).join('、')}下次收租 ×${e.mult}` : '');
      }
      case 'autoEndTurn': return e.lapsed ? `${N(e.player)} 的出牌次数用完（${e.lapsed} 次超时），自动结束回合` : `${N(e.player)} 出满 ${e.plays} 张，自动结束回合`;
      case 'playLapsed': return `${N(e.player)} 出牌超时，作废 1 次出牌（${e.plays}/${e.max}）`;
      case 'auctionStart': return `秘密竞价：双方都有完整的${Z(e.color)}，开始暗标出价`;
      case 'auctionBid': return `${N(e.player)} 已出价` + (e.cardIds ? `（${e.amount}M${e.cardIds.length ? `：${L(e.cardIds)}` : ''}）` : '');
      case 'auctionResult':
        if (e.winner == null) return `秘密竞价平局（${e.amounts[0]}M 对 ${e.amounts[1]}M），出价各自退回`;
        return `秘密竞价：${N(e.winner)} 出 ${e.amounts[e.winner]}M 胜过 ${e.amounts[1 - e.winner]}M，拿走双方出价` + (e.destroyed ? `，毁掉 ${N(1 - e.winner)} 的${Z(e.color)}` : '');
      case 'giftEarned': return `${N(e.player)} 连续 ${e.streak} 次押 ×4，获得「赌场礼赠」（下回合开启）`;
      case 'giftOffered': return `${N(e.player)} 的「赌场礼赠」到了：自己打开，还是送给对方？`;
      case 'giftOpened': {
        const T = N(e.to);
        const what = {
          fullSet: () => `${T} 得到一整套${Z(e.color)}`,
          fourProps: () => `${T} 得到 ${e.cardIds.length} 张不同颜色的地产：${L(e.cardIds)}`,
          wipe: () => `${T} 的银行和地产全部清空`,
          bigAction: () => `${T} 得到一张 10M 行动卡${e.cardIds ? C(e.cardIds[0]) : ''}`,
          action: () => `${T} 得到一张行动卡${e.cardIds ? C(e.cardIds[0]) : ''}`,
          jsn: () => `${T} 得到 ${e.cardIds.length} 张${A('justSayNo')}`,
          wildRent: () => `${T} 得到 ${e.cardIds.length} 张全色租金`,
          cash: () => `${T} 银行进账 ${e.amount}M`,
          mortgage: () => `${T} 的${Z(e.color)}被抵押（赎回前收不了这套的租、也不算胜利套数）`,
          none: () => '里面是空的（坏结果）',
        }[e.kind] || (() => '');
        return `${N(e.by)} ${e.given ? `把「赌场礼赠」送给 ${T}（强制打开）` : '打开了「赌场礼赠」'}：${what()}`;
      }
      case 'insurance': return e.gained ? `筹码保险：${N(e.player)} 又失去了 ${e.step}M，筹码 +0.5（现在 ${W(e.power)}）` : `筹码保险：${N(e.player)} 又失去了 ${e.step}M，但筹码已满，溢出的不算`;
      case 'surge': return `${N(e.player)} 筹码满格：收租 ×${e.mult}（不论是否成套），持续到之后第 ${e.turns} 个自己的回合结束，然后筹码清零`;
      case 'surgeEnd': return `${N(e.player)} 的满格加成结束，筹码清零`;
      case 'ghost': {
        const what = e.kind === 'debt' ? (e.count ? `好运：多拿 ${e.count} 张${A('debtCollector')}` : `好运，但牌堆和弃牌堆里已经没有${A('debtCollector')}了`)
          : e.kind === 'lose' ? `厄运：失去一张${Z(e.color)}地产${C(e.cardId)}`
          : `厄运：没有地产可丢，${e.handCount ? `弃掉全部 ${e.handCount} 张手牌，` : ''}下回合开始摸的 ${e.count} 张都是 1M`;
        return `捉鬼套装：${N(e.player)} 累计让对方失去 ${e.haul}M（超过 ${e.bar}M），老虎机抽奖——${what}。累计清零，下次门槛 ${e.next}M`;
      }
      case 'tycoon': return `贪婪大亨：${N(e.player)} 从对方那里拿到的地产累计 ${e.grab}M（超过 ${e.at}M），整局只触发这一次`;
      case 'tycoonOffered': return `${N(e.player)} 在选：吸血，还是套现`;
      case 'tycoonChosen':
        if (e.mode === 'vampire') return `${N(e.player)} 选了吸血：之后对方每往银行存 ${e.step}M，${N(e.player)} 白拿 1M；对方向 ${N(e.player)} 收的钱、用${A('bankruptcy')}拿的钱都只算一半`;
        return `${N(e.player)} 选了套现：拿到 ${e.rentCount} 张全色租金，地产总值 ${e.propValue}M 的${e.pct == null || e.pct === 50 ? '一半' : `${e.pct}%`} ${e.amount}M 存进银行` + (e.amount < e.target ? `（牌堆和弃牌堆里的钱只凑出这些，应得 ${e.target}M）` : '');
      case 'vampire': return `吸血：${N(e.from)} 往银行存钱，${N(e.player)} 白拿 ${e.amount}M` + (e.cardIds && e.cardIds.length ? `（${L(e.cardIds)}）` : '') + (e.owed ? `，还欠 ${e.owed}M 等牌堆里有钱再补` : '');
      case 'ghostCurse': return `捉鬼套装：${N(e.player)} 这回合先摸 ${e.count} 张 1M` + (e.count < e.want ? `（1M 只剩这些，其余 ${e.want - e.count} 张照常摸）` : '');
      case 'redeemed': return `${N(e.player)} 付 ${e.paid}M 赎回了抵押的${Z(e.color)}`;
      case 'takeoverColor': return `恶意收购：这局的颜色是${Z(e.color)}——谁先集齐一整套${Z(e.color)}，就触发轮盘赌`;
      case 'takeoverStart': return `恶意收购：${N(e.player)} 首先集齐了整套${Z(e.color)}！双方的银行和地产全部折成筹码（${N(0)} ${e.chips[0]}M、${N(1)} ${e.chips[1]}M），开始轮盘赌`;
      case 'rouletteTurn': return `轮盘赌：轮到 ${N(e.player)}（筹码 ${e.chips}M，最多 ${e.spins} 局）`;
      case 'rouletteSkip': return `轮盘赌：${N(e.player)} 没有筹码，跳过`;
      case 'rouletteSpin': {
        const pick = Number.isInteger(e.pick) ? `数字 ${e.pick}` : { red: '红色', black: '黑色', odd: '单数', even: '双数' }[e.pick];
        const got = e.number === 0 ? '绿色 0' : `${e.number}（${e.color === 'red' ? '红' : '黑'}${e.number % 2 ? '·单' : '·双'}）`;
        const res = { win: `赢了 +${e.wager}M`, lose: `输了 −${e.wager}M`, hit: `押中数字！${e.wager}M ×${ROULETTE_HIT}`, zero: '筹码清零' }[e.outcome];
        return `${N(e.player)} 第 ${e.round} 局押${pick} ${e.wager}M，开出 ${got}：${res}（筹码 ${e.chips}M）`;
      }
      case 'roulettePrize': return `${N(e.player)} 押中数字的奖励：${e.cardIds.length} 张不同颜色的地产${L(e.cardIds)}` + (e.hasAction ? `，外加一张 10M 行动卡${e.actionId != null ? C(e.actionId) : ''}` : '');
      case 'rouletteCashOut': {
        const why = { cash: '带着筹码离开', last: '玩满了', hit: '押中数字', skip: '筹码不够押一局' }[e.reason] || '离开';
        return `${N(e.player)} ${why}：${e.chips}M 筹码换成 ${e.amount}M 存进银行` + (e.amount < e.chips ? '（牌堆和弃牌堆里只凑出这些）' : '');
      }
      case 'rouletteBust': return `${N(e.player)} 的筹码${e.reason === 'zero' ? '被绿色 0 清零' : '输光了'}，轮盘赌结束`;
      case 'takeoverEnd': return '恶意收购结束，对局继续';
      case 'saleStart': return `拍卖：双方都有${e.shared.map(Z).join('、')}的地产，系统拿出一张${C(e.cardId)}（${Z(e.color)}）公开拍卖——起拍价 0，每次至少加 1M，只能用银行里的钱`;
      case 'saleBid': return `${N(e.player)} 出价 ${e.amount}M`;
      case 'saleEnd': return e.sold ? `成交：${N(e.player)} 以 ${e.price}M 拍得${C(e.cardId)}（从银行付了 ${e.paid}M${e.paid > e.price ? '，不找零' : ''}）` : `${C(e.cardId)}流拍：没人出价`;
      case 'award': return `${N(e.player)} 获得成就「${AWARDS[e.award] || e.award}」`;
      case 'lottery': return `大乐透：${N(e.player)} 中奖 ${e.amount}M（${L(e.cardIds)}）`;
      case 'raiseOffered': return `${N(e.player)} 要求加注：这局从 ×${e.from} 改为 ×${e.stake}`;
      case 'raiseTaken': return `${N(e.player)} 跟注，这局 ×${e.stake}`;
      case 'folded': return `${N(e.player)} 弃牌`;
      case 'jackpot': return `奖池开奖：${N(e.player)} 押 ×4 赌赢，摸走奖池里的 ${e.count} 张`;
      case 'gamble': return `${N(e.player)} 用${C(e.cardId)}赌一把（押 ×${e.mult}）：` + (e.won ? `赢了，${e.base}M 变成 ${e.amount}M` : `落空，这张牌作废`);
      case 'comeback': return e.kind === 'lastStand' ? `背水一战：对手到了赛点，${N(e.player)} 本回合可以出 ${e.plays} 张` : `逆风补给：${N(e.player)} 落后两套以上，本回合多摸 ${e.extra} 张`;
      case 'setStolen': return `${N(e.to)} 抢走了 ${N(e.from)} 的整套${Z(e.color)}` + (e.house != null || e.hotel != null ? '，连同上面的建筑' : '');
      case 'move': return `${N(e.player)} 把${C(e.cardId)}调整到${Z(e.color)}`;
      case 'buildingMoved': return `${N(e.player)} 把${C(e.cardId)}挪到${Z(e.color)}`;
      case 'discardRequired': return `${N(e.player)} 手牌超过 ${s.rules.handLimit} 张，需要弃 ${e.count} 张`;
      case 'discard': return `${N(e.player)} 弃掉了` + (e.cardIds ? L(e.cardIds) : ` ${e.count} 张牌`);
      case 'turnEnd': return `${N(e.player)} 结束回合`;
      case 'resign': return e.away ? `${N(e.player)} 离线太久，判负` : `${N(e.player)} 认输`;
      case 'gameOver':
        if (e.reason === 'sets') return `${N(e.winner)} 凑齐 ${s.rules.setsToWin} 套不同颜色的完整地产，获胜！` + (e.stake > 1 ? `这局 ×${e.stake}` : '');
        if (e.reason === 'resign') return `${N(e.winner)} 获胜（对方认输）` + (e.stake > 1 ? `，这局 ×${e.stake}` : '');
        if (e.reason === 'away') return `${N(e.winner)} 获胜（对方离线太久）` + (e.stake > 1 ? `，这局 ×${e.stake}` : '');
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
      /** AI 对手替 pi 挑一个动作（只看 pi 看得到的信息）；opts = { level: 0–1 牌力, firm: 不按进度收放, tease: 能赢先压着等对方到赛点, rnd } */
      botChoose: (pi, opts) => (isPlayer(pi) ? botChoose(s, pi, opts) : null),
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
    publicRules,
    ROULETTE: deepFreeze({ wheel: WHEEL.slice(), red: WHEEL_RED.slice(), picks: ROULETTE_PICKS.slice(), hit: ROULETTE_HIT }),
    _internal: { cloneState, sanitizeRules, chance },
  };
});

/* ═══════════════════════════ 对战服务 ═══════════════════════════ */

const MD = globalThis.MonopolyDeal;
const SERVICE_VERSION = '1.16.0';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉了容易看错的 0 O 1 I
const ROOM_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const NAME_MAX = 16;
// 联机房间的规则：被针对时一律由本人点「接受 / 付款」，不自动结算——否则"秒结算"会暴露对方手里有没有「反对行动」
const ROOM_RULES = Object.freeze({ autoResolve: false, logLimit: 200, autoEndTurn: true, comeback: true, comebackChance: 20, gamble: true, jackpot: true, doubling: true, lottery: true, lotteryChance: 15, lotteryPity: 4, auction: true, casinoGift: true, power: true, ghostKit: true, tycoon: true, takeover: true, sale: true });
// 客户端动作里只认这些字段，player 一律由服务器按座位填写
const ACTION_KEYS = ['type', 'cardId', 'color', 'setId', 'doubles', 'targetCardId', 'giveCardId', 'targetSetId', 'cardIds', 'bet', 'give', 'vampire', 'pick', 'wager', 'amount'];
// 对局中可以互发的表情（固定几个，防止被拿来刷屏或传别的东西）
const EMOTES = ['👍', '😂', '😮', '😭', '😤', '🎉', '😎', '🤔', '😱', '🙏', '🔥', '💰'];

/* ─────────── 联机协议 v2（给卡牌对战量身定做） ───────────
 * 卡牌对战一回合只有几下动作，但每一下都得"准、稳、不丢"。所以 v2 做的是：
 *   1. 每次更新带编号 n（房间里单调递增）。客户端连上时报上自己看到的最后一个编号（?last=），
 *      断线期间错过的几步（最近 HIST_MAX 次）合成一条"补课"更新发过去，客户端照样播动画、飞牌，不会整桌突然跳变。
 *   2. 局面（view / options / discardHint）只发和上一次的差异（JSON 增量），再附一个校验值 hash：
 *      客户端打完补丁算一遍，对不上（或者编号接不上）就自己要一份完整局面，绝不带着错的桌面继续打。
 *   3. 动作带唯一编号 aid，重连后原样重发，服务器记住每个座位最近 8 个，同一个只执行一次。
 *   4. 聊天：服务器存最近 CHAT_MAX 条，连上时一起下发；限速、去掉控制字符、限长。
 * 老客户端（不带 v=2）照旧收完整快照，部署前后都能连。 */
const PROTO = 2;
const HIST_MAX = 40;
const CHAT_MAX = 60;
const CHAT_LEN = 120;
const norm = (x) => JSON.parse(JSON.stringify(x));
// 规范化 JSON（键排序）再算 FNV-1a：两端对同一个局面算出同一个值
const canon = (x) => (x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? '[' + x.map(canon).join(',') + ']'
  : '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}');
function hashOf(x) {
  const t = canon(x);
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
// JSON 增量：{ $: 新值 } 整个换掉；{ x: 1 } 删掉这个键；{ o: { 键: 增量 } } 对象逐键；{ a: { 下标: 增量 } } 等长数组逐项。没变返回 undefined
function diffJson(a, b) {
  if (a === b) return undefined;
  const oa = a !== null && typeof a === 'object';
  const ob = b !== null && typeof b === 'object';
  if (!oa || !ob || Array.isArray(a) !== Array.isArray(b)) return { $: b };
  const out = {};
  let any = false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return { $: b };
    for (let i = 0; i < b.length; i++) { const d = diffJson(a[i], b[i]); if (d !== undefined) { out[i] = d; any = true; } }
    return any ? { a: out } : undefined;
  }
  for (const k of Object.keys(b)) { const d = Object.prototype.hasOwnProperty.call(a, k) ? diffJson(a[k], b[k]) : { $: b[k] }; if (d !== undefined) { out[k] = d; any = true; } }
  for (const k of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(b, k)) { out[k] = { x: 1 }; any = true; }
  return any ? { o: out } : undefined;
}
/* ─────────── Telegram 表情包 ───────────
 * 机器人 token 只在服务器上用：浏览器只能拿到清单（不含 token、不含 file_id）和清单里那些表情的图片。
 * 清单按 6 小时缓存在内存里（Telegram 暂时连不上就继续用上次的，一分钟后再试）；图片走边缘缓存（Cache API）+ 实例内存，同一张图 Telegram 只取一次。
 * 三种贴纸都能动：视频贴纸（.webm）前端用 <video> 放；动画贴纸（.tgs = gzip 压缩的 Lottie JSON）服务器解压成 JSON，前端用 lottie 播放；
 * 放不了（播放器加载失败、浏览器不支持、系统设置了减少动态效果）就显示静态缩略图。 */
const TG_SETS_MAX = 8;
const TG_PER_SET = 120;
const TG_TTL = 6 * 3600e3; // 清单缓存多久（全取到时）
const TG_TTL_PART = 600e3; // 有几套没取到：十分钟后再试
const TG_RETRY = 60e3; // 一套都没取到：一分钟后再试
let TG = null; // { key, at, until, sets: [对外的清单], byId: Map(id → { file, thumb, kind, emoji }), errors }
let TG_FLIGHT = null; // 正在取的清单（同时来的请求共用）
const tgBase = (env) => String(env.TG_API || 'https://api.telegram.org').replace(/\/+$/, '');
const tgNames = (env) => String(env.TG_STICKER_SETS || '').split(/[\s,，]+/).filter((n) => /^[A-Za-z0-9_]{1,64}$/.test(n)).slice(0, TG_SETS_MAX);
const TG_EMOJI_MAX = 200; // 表情面板放多少个：Telegram 一套自定义表情最多 200 个，全放
const tgSetName = (v, def) => { const n = String(v == null ? def : v).trim(); return /^[A-Za-z0-9_]{1,64}$/.test(n) && n.toLowerCase() !== 'off' ? n : ''; };
const tgEmojiName = (env) => tgSetName(env.TG_EMOJI_SET, 'GameEmoji');
const tgChipName = (env) => tgSetName(env.TG_CHIP_SET, 'ParisOlympicEmoji'); // 筹码图标：这套的前三个（金 / 银 / 铜 = 满 / 半 / 空）
const tgFaceName = (env) => tgSetName(env.TG_FACE_SET, 'HandDrawnEmoji'); // 中央指示器里对方的表情：按每张对应的系统表情挑
const STICKER_ID = /^[A-Za-z0-9_-]{4,64}$/;
const tgErr = (env, e) => String((e && e.message) || e).split(String(env.TG_BOT_TOKEN || '\u0000')).join('***'); // 出错信息里万一带了 token，抹掉
// 同一实例同时最多 6 个请求去 Telegram：表情面板一打开几十张缩略图一起要，一下子全打过去会被限流（429），有的表情就出不来
const TG_PAR = 6;
let tgActive = 0;
const tgQueue = [];
const tgSlot = () => new Promise((res) => { if (tgActive < TG_PAR) { tgActive++; res(); } else tgQueue.push(res); });
const tgFree = () => { const next = tgQueue.shift(); if (next) next(); else tgActive--; };
async function tgCall(env, method, params, retried) {
  const u = new URL(`${tgBase(env)}/bot${env.TG_BOT_TOKEN}/${method}`);
  for (const k of Object.keys(params || {})) u.searchParams.set(k, params[k]);
  const r = await fetch(u.toString(), { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  const wait = j && j.error_code === 429 && j.parameters ? Number(j.parameters.retry_after) || 1 : 0;
  if (wait && wait <= 5 && !retried) { await new Promise((res) => setTimeout(res, wait * 1000)); return tgCall(env, method, params, true); } // 被限流：按它说的等一下再试一次
  if (!j || !j.ok) throw new Error((j && j.description) || `${method} 返回 ${r.status}`);
  return j.result;
}
async function loadStickers(env) {
  const names = env.TG_BOT_TOKEN ? tgNames(env) : [];
  const emo = env.TG_BOT_TOKEN ? tgEmojiName(env) : '';
  const chip = env.TG_BOT_TOKEN ? tgChipName(env) : '';
  const face = env.TG_BOT_TOKEN ? tgFaceName(env) : '';
  if (!names.length && !emo && !chip && !face) return null;
  const key = names.join(',') + '|' + emo + '|' + chip + '|' + face;
  if (TG && TG.key === key && Date.now() < TG.until) return TG;
  if (!TG_FLIGHT || TG_FLIGHT.key !== key) TG_FLIGHT = { key, p: fetchStickers(env, names, key, emo, chip, face).finally(() => { TG_FLIGHT = null; }) }; // 同时来的请求只去 Telegram 取一次
  return TG_FLIGHT.p;
}
// 表情面板那套（自定义表情包）和聊天里的贴纸一样取、一样给图，只是单独列出来，发的时候只认这一套
async function fetchStickers(env, names, key, emo, chip, face) {
  const byId = new Map();
  const errors = [];
  const role = names.map(() => 'set').concat(emo ? ['emo'] : [], chip ? ['chip'] : [], face ? ['face'] : []); // 聊天贴纸 / 表情面板 / 筹码图标 / 中央指示器表情
  const all = names.concat(emo ? [emo] : [], chip ? [chip] : [], face ? [face] : []);
  const got = await Promise.all(all.map((name) => tgCall(env, 'getStickerSet', { name }).catch((e) => { errors.push(`${name}：${tgErr(env, e)}`); return null; })));
  const sets = [];
  let emotes = null;
  let chips = null;
  let faces = null;
  got.forEach((r, i) => {
    if (!r) return;
    const isEmo = role[i] === 'emo' || role[i] === 'face';
    const list = [];
    for (const st of (r.stickers || []).slice(0, role[i] === 'chip' ? 3 : isEmo ? TG_EMOJI_MAX : TG_PER_SET)) {
      const id = st.file_unique_id;
      if (!id || !STICKER_ID.test(id) || !st.file_id) continue;
      const kind = st.is_video ? 'video' : st.is_animated ? 'animated' : 'static';
      const th = st.thumbnail || st.thumb;
      // 没有缩略图的（自定义表情常这样）也收下：前端不放缩略图，直接放动画 / 视频，放不了就显示对应的系统表情
      byId.set(id, { file: st.file_id, thumb: th ? th.file_id : null, kind, emoji: st.emoji || '' });
      list.push(th || kind === 'static' ? { id, emoji: st.emoji || '', kind } : { id, emoji: st.emoji || '', kind, nt: 1 });
    }
    if (!list.length) return;
    if (role[i] === 'chip') { if (list.length === 3) chips = list; }
    else if (role[i] === 'face') faces = list;
    else if (isEmo) emotes = { name: r.name || emo, title: r.title || emo, stickers: list };
    else sets.push({ name: r.name || all[i], title: r.title || all[i], stickers: list });
  });
  const now = Date.now();
  const got1 = sets.length || emotes || chips || faces;
  // 一套都没取到：有上次的先用上次的，一分钟后再试（不是每个请求都去敲 Telegram）；有几套没取到：十分钟后再试
  if (!got1 && TG && TG.key === key && (TG.sets.length || TG.emotes || TG.chips || TG.faces)) { TG.until = now + TG_RETRY; TG.errors = errors; return TG; }
  const emoteIds = new Set(emotes ? emotes.stickers.map((x) => x.id) : []);
  TG = { key, at: now, until: now + (!got1 ? TG_RETRY : errors.length ? TG_TTL_PART : TG_TTL), sets, emotes, emoteIds, chips, faces, byId, errors };
  return TG;
}
async function stickerList(env, cors) {
  let T = null;
  try { T = await loadStickers(env); } catch (e) { T = null; }
  return json({ ok: true, sets: T ? T.sets : [], emotes: T ? T.emotes || null : null, chips: T ? T.chips || null : null, faces: T ? T.faces || null : null }, 200, Object.assign({ 'Cache-Control': 'public, max-age=600' }, cors));
}
// 图片两层缓存：边缘缓存（caches.default，自定义域名下才生效）+ 本实例内存（workers.dev 上也有用，按字节限量、先进先出）；
// 同一张图同时被多人要，只去 Telegram 取一次
const STK_MEM = new Map();
const STK_MEM_MAX = 8 * 1024 * 1024;
const STK_FILE_MAX = 2 * 1024 * 1024;
let stkMemBytes = 0;
const stkFlight = new Map();
function stkRemember(k, v) {
  if (STK_MEM.has(k) || v.body.byteLength > STK_FILE_MAX / 2) return;
  STK_MEM.set(k, v);
  stkMemBytes += v.body.byteLength;
  for (const [old, x] of STK_MEM) { if (stkMemBytes <= STK_MEM_MAX) break; STK_MEM.delete(old); stkMemBytes -= x.body.byteLength; }
}
// mode: 'img' 原文件（动画贴纸给缩略图）/ 'thumb' 缩略图 / 'anim' 动画贴纸解压成的 Lottie JSON
async function stkFetch(env, id, mode) {
  const T = await loadStickers(env);
  const s = T && T.byId.get(id);
  if (!s || (mode === 'anim' && s.kind !== 'animated')) throw new HttpError('NO_STICKER');
  if (mode !== 'anim' && s.kind === 'animated' && !s.thumb) throw new HttpError('NO_STICKER'); // 没有缩略图的动画表情：只有动画
  await tgSlot();
  try { return await stkFetchNow(env, s, mode); } finally { tgFree(); }
}
async function stkFetchNow(env, s, mode) {
  const fileId = mode === 'anim' ? s.file : (mode === 'thumb' || s.kind === 'animated') && s.thumb ? s.thumb : s.file;
  let f;
  try { f = await tgCall(env, 'getFile', { file_id: fileId }); } catch (e) { throw new HttpError('TG_DOWN', tgErr(env, e)); }
  const fp = String(f.file_path || '');
  if (!fp || fp.includes('..')) throw new HttpError('TG_DOWN', 'bad file path');
  let r;
  try { r = await fetch(`${tgBase(env)}/file/bot${env.TG_BOT_TOKEN}/${fp}`); } catch (e) { throw new HttpError('TG_DOWN', tgErr(env, e)); }
  if (!r.ok) throw new HttpError('TG_DOWN', String(r.status));
  const body = await r.arrayBuffer();
  if (body.byteLength > STK_FILE_MAX) throw new HttpError('TG_DOWN', 'file too large');
  if (mode === 'anim') return { body: await tgsToJson(body), type: 'application/json; charset=utf-8' };
  const ext = fp.split('.').pop().toLowerCase();
  const type = { webp: 'image/webp', webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[ext] || 'application/octet-stream';
  return { body, type };
}
// .tgs = gzip 压缩的 Lottie JSON：边解压边数字节（防"压缩炸弹"），再确认真是 Lottie
const STK_JSON_MAX = 3 * 1024 * 1024;
async function tgsToJson(buf) {
  const u8 = new Uint8Array(buf);
  let out = u8;
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    const rd = new Response(buf).body.pipeThrough(new DecompressionStream('gzip')).getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      let c;
      try { c = await rd.read(); } catch (e) { throw new HttpError('TG_DOWN', 'bad animation'); }
      if (c.done) break;
      n += c.value.byteLength;
      if (n > STK_JSON_MAX) { rd.cancel().catch(() => {}); throw new HttpError('TG_DOWN', 'animation too large'); }
      parts.push(c.value);
    }
    out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
  }
  let j = null;
  try { j = JSON.parse(new TextDecoder().decode(out)); } catch (e) { j = null; }
  if (!j || typeof j !== 'object' || !Array.isArray(j.layers) || !(j.w > 0) || !(j.h > 0)) throw new HttpError('TG_DOWN', 'bad animation');
  return out.buffer.byteLength === out.byteLength ? out.buffer : out.slice().buffer;
}
async function stickerImg(request, env, id, mode, cors) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const mk = `${mode === 'anim' ? 'anim' : 'img'}/${id}${mode === 'thumb' ? '?thumb=1' : ''}`;
  const key = new Request(`${new URL(request.url).origin}/api/stickers/${mk}`, { method: 'GET' }); // 规整过的地址当缓存键，多带的参数不会把缓存打散
  const done = (res) => { const h = new Headers(res.headers); Object.keys(cors).forEach((k) => h.set(k, cors[k])); return new Response(res.body, { status: res.status, headers: h }); };
  if (cache) { const hit = await cache.match(key); if (hit) return done(hit); }
  let v = STK_MEM.get(mk);
  if (!v) {
    if (!stkFlight.has(mk)) stkFlight.set(mk, stkFetch(env, id, mode).then((x) => { stkRemember(mk, x); return x; }).finally(() => stkFlight.delete(mk)));
    v = await stkFlight.get(mk);
  }
  const res = new Response(v.body.slice(0), { headers: { 'Content-Type': v.type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
  if (cache) await cache.put(key, res.clone());
  return done(res);
}
// Lottie 播放器：固定版本 + 固定指纹。先用自己托管的（LOTTIE_URL），再试 jsDelivr、unpkg；拿到的文件指纹对上才用，
// 存在实例内存 + 边缘缓存里。前端 <script integrity> 用同一个指纹再核一遍。
const LOTTIE_VER = '5.13.0';
const LOTTIE_SRI = 'sha384-Gr3FGWSrOz4fzm9bvrWwhuQH87JMUCLlOTaHhpddbnlHHWCZPxMeQ3KUPsomzIii';
const lottieSrcs = (env) => [env.LOTTIE_URL, `https://cdn.jsdelivr.net/npm/lottie-web@${LOTTIE_VER}/build/player/lottie_light.min.js`, `https://unpkg.com/lottie-web@${LOTTIE_VER}/build/player/lottie_light.min.js`].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
let LOTTIE_JS = null;
let lottieFlight = null;
let lottieErr = '';
let lottieFailAt = 0; // 上次全部失败的时间：一分钟内不再去试，直接回错误
const sri384 = async (buf) => 'sha384-' + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-384', buf))));
async function lottieJs(env) {
  if (LOTTIE_JS) return LOTTIE_JS;
  if (Date.now() - lottieFailAt < 60e3) throw new HttpError('NO_PLAYER', lottieErr);
  if (!lottieFlight) {
    lottieFlight = (async () => {
      const why = [];
      for (const u of lottieSrcs(env)) {
        try {
          const r = await fetch(u);
          if (!r.ok) { why.push(`${new URL(u).host} ${r.status}`); continue; }
          const b = await r.arrayBuffer();
          if ((await sri384(b)) !== LOTTIE_SRI) { why.push(`${new URL(u).host} 文件指纹不对`); continue; }
          LOTTIE_JS = b;
          lottieErr = '';
          return b;
        } catch (e) { why.push(`${new URL(u).host} ${String((e && e.message) || e).slice(0, 80)}`); }
      }
      lottieErr = why.join('；');
      lottieFailAt = Date.now();
      throw new HttpError('NO_PLAYER', lottieErr);
    })().finally(() => { lottieFlight = null; });
  }
  return lottieFlight;
}
async function lottiePlayer(request, env, cors) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const key = new Request(`${new URL(request.url).origin}/api/stickers/player.js?v=${LOTTIE_VER}`, { method: 'GET' });
  const done = (res) => { const h = new Headers(res.headers); Object.keys(cors).forEach((k) => h.set(k, cors[k])); return new Response(res.body, { status: res.status, headers: h }); };
  if (cache) { const hit = await cache.match(key); if (hit) return done(hit); }
  const b = await lottieJs(env);
  const res = new Response(b.slice(0), { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
  if (cache) await cache.put(key, res.clone());
  return done(res);
}

// 聊天文字：去掉控制字符和改变书写方向的隐藏字符，空白合并，限长
function cleanChat(t) {
  if (typeof t !== 'string') return '';
  const s = t.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, CHAT_LEN).join('');
}

/* ─────────── 全球匹配 + AI 对手 ───────────
 * 匹配：一个固定名字（__match__）的房间对象当排队处，只记一个"正在等人的房间"。新来的人先看有没有人在等（MATCH_FRESH 以内的），
 * 有就直接坐进那个房间开局（真人对真人）；没有就自己开一个房间排上。前端等 botAfter（每次随机几秒）还没人来，就请 AI 对手入座。
 * AI 对手和真人一样显示：随机英文昵称，房间信息里不带任何 AI 标记；全程不说话、不发表情。
 * 难度按玩家的匹配战绩动态调（botLevel）：长期让 AI 赢七成（玩家胜率 BOT_TARGET = 三成）。第一局放水；之后看"累计欠账"——
 * 每局玩家输了欠账 +0.3、赢了 -0.7（= 目标胜率 - 这局结果），欠得越多 AI 越弱、赢得越多 AI 越强。AI 强到顶了还压不住，
 * 就暗中给 AI 加手气；弱到底了还在输，就暗中给玩家加手气（luckSeat / luckEdge，都不下发）。
 * 连输会放水（连输 2 / 3 / 4 局一档比一档松），免得一直输到不想玩；连赢三局紧一点。局内引擎还会按进度收放。
 * 例外：每个玩家对 AI 的前 x 局（1–3 随机）是下马威局，AI 几乎必赢（见 cleanRec / botLevel）。 */
// 一次更新在前端大概要放多久的动画，玩家才能接着操作（揭晓 → 结算 → 排队的大场面）：倒计时把这段时间补上
function fxMs(events) {
  const EACH = { gamble: 3900, lottery: 3300, auctionResult: 3400, giftOpened: 3200, tycoonChosen: 2400, ghost: 6400, award: 2000, auctionStart: 2400, giftEarned: 2400, surge: 2400, tycoon: 2400, jackpot: 900, takeoverStart: 3600, rouletteSpin: 7600, roulettePrize: 2200, saleStart: 2600, saleEnd: 2800 };
  let ms = 0;
  for (const e of events || []) ms += EACH[e.type] || 0;
  if ((events || []).some((e) => e.type === 'actionPlayed' && e.target != null)) ms += 1800; // 出牌亮相
  if ((events || []).some((e) => (e.type === 'payment' && e.paid > 10) || (e.type === 'bankrupt' && e.amount > 10))) ms += 1500; // 金币雨
  return Math.min(15000, ms);
}

const MATCH_ID = '__match__';
const MATCH_FRESH = 9000;
const BOT_AFTER = [3500, 8500]; // 等多久请 AI 入座：每次在这个范围里随机（上限要小于 MATCH_FRESH，排着的房间才一直能被真人配上）
// AI 对手的名字：随机英文昵称，几种常见写法混着来（Ethan / mia_07 / JackW / lily.chen / Noah2003 / EvanKim）
const BOT_FIRST = ['Ethan', 'Mia', 'Leo', 'Olivia', 'Noah', 'Emma', 'Liam', 'Ava', 'Lucas', 'Chloe', 'Mason', 'Lily', 'Jack', 'Grace', 'Ryan', 'Zoe',
  'Owen', 'Ella', 'Dylan', 'Ruby', 'Caleb', 'Nora', 'Aiden', 'Ivy', 'Logan', 'Hazel', 'Evan', 'Luna', 'Kevin', 'Sophie', 'Jason', 'Amy', 'Tyler', 'Kate',
  'Max', 'Anna', 'Sam', 'Emily', 'Alex', 'Jenny', 'Ben', 'Lucy', 'Nathan', 'Sarah', 'Eric', 'Claire', 'Daniel', 'Hannah', 'Henry', 'Iris'];
const BOT_LAST = ['lee', 'chen', 'wang', 'kim', 'park', 'lin', 'wu', 'tan', 'smith', 'brown', 'king', 'young', 'hall', 'ng', 'ho', 'scott'];
function botName(avoid) {
  const any = (a) => a[Math.floor(Math.random() * a.length)];
  for (;;) {
    const f = any(BOT_FIRST);
    const r = Math.random();
    const n = r < 0.3 ? f
      : r < 0.48 ? `${f.toLowerCase()}_${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`
      : r < 0.62 ? f + any('ABCDEFGHJKLMNPRSTW'.split(''))
      : r < 0.78 ? `${f.toLowerCase()}.${any(BOT_LAST)}`
      : r < 0.9 ? f + (1990 + Math.floor(Math.random() * 18))
      : f + any(BOT_LAST).replace(/^./, (c) => c.toUpperCase());
    if (n !== avoid && n.length <= NAME_MAX) return n;
  }
}
const BOT_TARGET = 0.3; // 玩家长期期望胜率（AI 赢七成）
const DEBT_MAX = 8;     // 欠账上下限（防止一直赢 / 一直输的人把账攒得太深，回不来）
const REC_V = 2;        // 战绩格式：目标胜率改过，旧版的欠账作废、按胜负重算
// 下马威：每个玩家对 AI 的前 x 局（x 在 1–3 里随机，第一次记战绩时定下来）AI 全力、手气和摸牌都暗中偏向 AI，几乎必赢——激起"非赢回来不可"的劲头
function cleanRec(rec) {
  const g = Math.max(0, Math.min(9999, Math.floor(Number(rec && rec.g) || 0)));
  const w = Math.max(0, Math.min(g, Math.floor(Number(rec && rec.w) || 0)));
  const streak = Math.max(-50, Math.min(50, Math.round(Number(rec && rec.streak) || 0)));
  const raw = Number(rec && rec.i);
  const i = Math.max(-DEBT_MAX, Math.min(DEBT_MAX, rec && rec.v === REC_V && Number.isFinite(raw) ? raw : BOT_TARGET * g - w)); // 老战绩：按胜负补算欠账
  const x = [1, 2, 3].indexOf(rec && rec.x) >= 0 ? rec.x : 1 + Math.floor(Math.random() * 3);
  return { g, w, streak, i: Math.round(i * 100) / 100, v: REC_V, x };
}
// 一局打完记账（只算对 AI 的局）
function recAfter(rec, outcome) {
  const r = cleanRec(rec);
  r.g += 1;
  if (outcome === 1) r.w += 1;
  r.streak = outcome === 1 ? Math.max(1, r.streak + 1) : outcome === 0 ? Math.min(-1, r.streak - 1) : 0;
  r.i = Math.round(Math.max(-DEBT_MAX, Math.min(DEBT_MAX, r.i + BOT_TARGET - outcome)) * 100) / 100;
  return r;
}
// 难度 D（-1 ~ 1.95）：0 ~ 0.95 就是 AI 的牌力；> 0.95 时 AI 用满牌力，超出部分换成暗中给 AI 的手气（1.95 → AI 所有几率 +40、玩家 -40）；
// < 0 时 AI 牌力 0，不够的换成暗中给玩家的手气。favor：手气给谁（'bot' / 'player'）
function botLevel(rec) {
  const r = cleanRec(rec);
  if (r.g < r.x) return { level: 0.97, edge: 40, favor: 'bot', draw: 2, firm: true, tease: true }; // 下马威局：全力 + 手气 + 摸牌都偏向 AI，赢之前先吊着
  const base = Math.max(-1, Math.min(1.95, 1.4 - 0.3 * r.i)); // 先把长期那部分夹住，连输放水才一定有效
  let d = base + (r.streak <= -4 ? -0.9 : r.streak <= -3 ? -0.45 : r.streak <= -2 ? -0.15 : r.streak >= 3 ? 0.1 : 0);
  d = Math.max(-1, Math.min(1.95, d));
  if (d < 0) return { level: 0, edge: Math.round(-d * 40), favor: 'player' };
  if (d <= 0.95) return { level: d, edge: 0 };
  return { level: 0.97, edge: Math.min(40, Math.round((d - 0.95) * 40)), favor: 'bot' };
}

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
  BAD_TOKEN: [403, '座位凭证无效，请重新加入房间'],
  SEAT_ONLINE: [409, '这个座位正在别的设备上使用，先在那台设备上退出，或者等它掉线后再试'],
  NO_STICKER: [404, '没有这个表情'],
  TG_DOWN: [502, '暂时拿不到 Telegram 表情包'],
  NO_PLAYER: [502, '暂时拿不到表情动画播放器'],
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
// 在线判断：客户端每 15 秒发一次心跳（运行时自动回 pong）。连接还挂着但 75 秒没心跳 = 实际已经掉线（手机断网、App 被系统挂起）
const STALE_MS = 75000;
// 对手离线满 5 分钟（可用 CLAIM_SECONDS 改），在线的一方可以申请直接判胜（不用一直干等）
const claimMs = (env) => { const v = Number(env.CLAIM_SECONDS); return Number.isFinite(v) && v >= 1 && v <= 3600 ? v * 1000 : 300000; };
const fmtDur = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} 分${ms % 60000 >= 1000 ? ` ${Math.floor((ms % 60000) / 1000)} 秒` : '钟'}` : `${Math.max(1, Math.round(ms / 1000))} 秒`);
const goodPid = (p) => (typeof p === 'string' && /^[0-9a-f]{16,32}$/.test(p) ? p : null);
// 倒计时：出牌默认不限时；回应 / 弃牌 25 秒，时间到了服务器替他做最稳妥的选择。0 = 不限时（这个决定点没有倒计时）
const CLOCK_SECONDS = Object.freeze({ play: 0, respond: 25, discard: 25 });
const clockMs = (env, kind) => {
  const raw = kind === 'play' ? env.TURN_SECONDS : env.RESPOND_SECONDS;
  const v = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(v)) return CLOCK_SECONDS[kind] * 1000;
  return v >= 5 && v <= 600 ? v * 1000 : v === 0 ? 0 : CLOCK_SECONDS[kind] * 1000;
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
  const sec = (k) => (clockMs(env, k) ? `限时 ${clockMs(env, k) / 1000} 秒` : '不限时');
  add('TURN_SECONDS', true, `出牌${sec('play')}；回应 / 弃牌${sec('respond')}（RESPOND_SECONDS）`);
  if (env.TG_BOT_TOKEN || env.TG_STICKER_SETS) {
    let T = null;
    let err = '';
    try { T = await loadStickers(env); } catch (e) { err = tgErr(env, e); }
    const emo = tgEmojiName(env);
    const chip = tgChipName(env);
    const face = tgFaceName(env);
    if (env.TG_BOT_TOKEN && face) add('对方表情', !!(T && T.faces), T && T.faces ? `用 ${face}（${T.faces.length} 个），中央指示器按对方的状态挑表情` : `取不到表情包 ${face}，中央指示器只有箭头`);
    if (env.TG_BOT_TOKEN && chip) add('筹码图标', !!(T && T.chips), T && T.chips ? `用 ${chip} 的前三个（满 / 半 / 空）` : `取不到表情包 ${chip}（或不到 3 个），先用 CONFIG.ART 里的图 / 内置图标`);
    if (env.TG_BOT_TOKEN && emo) add('表情面板', !!(T && T.emotes), T && T.emotes ? `用 ${T.emotes.title}（${T.emotes.stickers.length} 个自定义表情）` : `取不到表情包 ${emo}，先用系统表情${T && T.errors && T.errors.length ? `：${T.errors.join('；')}` : err ? `：${err}` : ''}`);
    const n = T ? T.sets.reduce((t, x) => t + x.stickers.length, 0) : 0;
    add('Telegram 表情包', !!(T && T.sets.length) || (!!env.TG_BOT_TOKEN && !tgNames(env).length), !env.TG_BOT_TOKEN ? '设了 TG_STICKER_SETS 但没有 TG_BOT_TOKEN（要设成机密）'
      : !tgNames(env).length ? '没有设 TG_STICKER_SETS（聊天里不显示贴纸；要用就填表情包名字，逗号分隔）'
        : T && T.sets.length ? `已接入 ${T.sets.length} 套、${n} 个表情${T.errors && T.errors.length ? `；没取到：${T.errors.join('；')}` : ''}`
          : `一套都没取到：${err || (T && T.errors ? T.errors.join('；') : '')}`);
    if (T && T.sets.concat(T.emotes || []).some((x) => x.stickers.some((y) => y.kind === 'animated'))) {
      let okP = true;
      try { await lottieJs(env); } catch (e) { okP = false; }
      add('表情动画播放器', okP, okP ? `lottie-web ${LOTTIE_VER}，指纹核对通过` : `取不到，动画贴纸只显示静态图（${lottieErr || '未知原因'}）；可以把 lottie_light.min.js 放到 R2，填 LOTTIE_URL`);
    }
  } else add('Telegram 表情包', true, '未配置（聊天里不显示表情包；要用就设 TG_BOT_TOKEN 和 TG_STICKER_SETS）');
  add('CLAIM_SECONDS', true, `对手离线满 ${claimMs(env) % 60000 ? claimMs(env) / 1000 + ' 秒' : claimMs(env) / 60000 + ' 分钟'}可以申请判胜`);
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
  rules: MD.publicRules(MD.DEFAULT_RULES),
  roomRules: MD.publicRules(ROOM_RULES),
  roulette: MD.ROULETTE,
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
  if (path === '/api/stickers' && method === 'GET') return stickerList(env, cors);
  const sm = path.match(/^\/api\/stickers\/img\/([A-Za-z0-9_-]{4,64})$/);
  if (sm && method === 'GET') return stickerImg(request, env, sm[1], url.searchParams.get('thumb') === '1' ? 'thumb' : 'img', cors);
  const am = path.match(/^\/api\/stickers\/anim\/([A-Za-z0-9_-]{4,64})$/);
  if (am && method === 'GET') return stickerImg(request, env, am[1], 'anim', cors);
  if (path === '/api/stickers/player.js' && method === 'GET') return lottiePlayer(request, env, cors);
  if (path === '/api/rooms' && method === 'POST') return createRoom(request, env, cors);
  if (path === '/api/match' && method === 'POST') return matchRoom(request, env, cors);
  if (path === '/api/match/cancel' && method === 'POST') {
    const body = await readJson(request);
    await callRoom(roomStub(env, MATCH_ID), 'cancel', { roomId: String(body.roomId || '') });
    return json({ ok: true }, 200, cors);
  }

  const m = path.match(/^\/api\/rooms\/([^/]+)(?:\/(join|ws|bot))?$/);
  if (m) {
    const code = decodeURIComponent(m[1]).toUpperCase();
    if (!ROOM_RE.test(code)) throw new HttpError('BAD_ROOM');
    const stub = roomStub(env, code);
    if (!m[2] && method === 'GET') return rpcResponse(await callRoom(stub, 'info'), cors);
    if (m[2] === 'join' && method === 'POST') {
      const body = await readJson(request);
      return rpcResponse(await callRoom(stub, 'join', { name: body.name, token: typeof body.token === 'string' ? body.token : '', claim: body.claim, seat: body.seat }), cors);
    }
    if (m[2] === 'bot' && method === 'POST') { // 匹配不到真人：请 AI 对手入座，同时从排队处撤下这个房间
      const body = await readJson(request);
      const r = await callRoom(stub, 'addBot', { token: typeof body.token === 'string' ? body.token : '', rec: body.rec });
      await callRoom(roomStub(env, MATCH_ID), 'cancel', { roomId: code });
      return rpcResponse(r, cors);
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

// 全球匹配：先坐进正在等人的房间（真人对真人）；没人在等就自己开一个排上，botAfter 后前端会请 AI 对手入座
async function matchRoom(request, env, cors) {
  const body = await readJson(request);
  const q = roomStub(env, MATCH_ID);
  for (let i = 0; i < 3; i++) {
    const t = await callRoom(q, 'queue', { take: true });
    if (!t || !t.roomId) break;
    // 只坐进"房主还在线、还没开局、不是自己开的"房间：房主关了页面没取消、或者自己连点两次，都不会配进空房间 / 自己打自己
    const r = await callRoom(roomStub(env, t.roomId), 'join', { name: body.name, token: '', claim: body.claim, match: true, pid: body.pid });
    if (r && r.ok) return json(Object.assign(r, { matched: true }), 200, cors);
  }
  for (let i = 0; i < 5; i++) {
    const roomId = newRoomId();
    const r = await callRoom(roomStub(env, roomId), 'create', { roomId, name: body.name, preset: body.preset, claim: body.claim, match: true, pid: body.pid });
    if (r.ok) {
      await callRoom(q, 'queue', { roomId });
      return json(Object.assign(r, { matched: false, botAfter: BOT_AFTER[0] + Math.floor(Math.random() * (BOT_AFTER[1] - BOT_AFTER[0])) }), 201, cors);
    }
  }
  throw new HttpError('BUSY');
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
 *       clock = { key, seat, kind, total, deadline }：现在等谁做哪个决定、几点到期。同一个决定点 key 不变，换了就重新计时；
 *         这一步的更新在前端要先放一会儿动画（老虎机、开奖、成就……）才能操作的话，限时加上这段时间（fxMs，最多 15 秒）
 * 闹钟（alarm）只有一个，同时管两件事：倒计时到期（替人做决定）和空房间到期清理，取较早的那个时间。
 * 连接用休眠 WebSocket：没人说话时对象可以休眠不计费，醒来后从存储重新读出房间和对局。 */

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = undefined; // undefined = 还没从存储读；null = 房间不存在
    this.game = null;
    this.sent = [null, null]; // 每个座位最后一次发出去的局面 { n, body }：下一次只发差异（只在内存里，对象休眠后清空 → 发完整的）
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
    r.botAt = null;
    r.botPlan = null; // AI 上一局想好、没来得及出的那步作废
    r.sale = null; // 拍卖的 30 分钟上限从开拍算起：每局重新记（挂起编号每局从 1 开始，不清会撞上上一局的）
    r.fullSeen = [0, 0];
    r.hist = []; // 新的一局：断线补课从这里重新记
    r.seen = [Date.now(), Date.now()]; // 离线时长最早从开局算起（开局时还没连上的一方也一样）
    const b = r.seats.findIndex((x) => x && x.bot);
    const lv = b >= 0 ? botLevel(r.rec) : null;
    if (lv) Object.assign(r.seats[b].bot, { level: lv.level, firm: !!lv.firm, tease: !!lv.tease });
    const rules = Object.assign({}, ROOM_RULES, lv && lv.edge ? { luckSeat: lv.favor === 'bot' ? b : 1 - b, luckEdge: lv.edge } : null, lv && lv.draw ? { drawSeat: b, drawEdge: lv.draw } : null);
    this.game = MD.createGame({ players: r.seats.map((x) => x.name), seed: newToken(), preset: r.preset, rules });
  }

  /* ── RPC：由 Worker 调用 ── */

  async create({ roomId, name, preset, claim, match, pid }) {
    await this.load();
    if (this.room) return { ok: false, code: 'EXISTS' };
    const token = goodClaim(claim) || newToken();
    this.room = {
      id: roomId,
      mode: match ? 'match' : 'room',
      createdAt: Date.now(),
      preset: preset === 'official' ? 'official' : 'balanced',
      round: 0,
      rematch: [false, false],
      seats: [Object.assign({ name: cleanName(name, 0), token }, goodPid(pid) ? { pid: goodPid(pid) } : null), null],
      seen: [Date.now(), 0],
      expireAt: Date.now() + ttlMs(this.env),
    };
    this.game = null;
    await this.save();
    await this.scheduleAlarm();
    return { ok: true, roomId, seat: 0, token, preset: this.room.preset };
  }

  // seat：房间满了时"我是这个座位的玩家"——换了浏览器 / 清了缓存 / 隐私窗口，本机没有凭证了，只要那个座位现在不在线就能拿回来
  // match：全球匹配来的，只坐进房主在线、还没开局、不是同一台设备开的房间
  async join({ name, token, claim, seat, match, pid }) {
    await this.load();
    if (!this.room) return { ok: false, code: 'NOT_FOUND' };
    const seats = this.room.seats;
    const c = goodClaim(claim);
    const known = [token, c].filter(Boolean);
    const mine = seats.findIndex((x) => x && known.indexOf(x.token) >= 0);
    if (mine >= 0) return { ok: true, roomId: this.room.id, seat: mine, token: seats[mine].token, preset: this.room.preset }; // 原座位重连（含"上次加入其实成功了，只是没收到回复"）
    if (match) {
      const host = seats[0];
      const fresh = Date.now() - (this.room.createdAt || 0) < 6000; // 刚开的房间，房主可能还没连上
      if (seats[1] || this.game || !host || (goodPid(pid) && host.pid === goodPid(pid)) || !(fresh || this.online(0))) return { ok: false, code: 'FULL' };
    }
    if (seats[1]) {
      const i = seat === 0 || seat === 1 ? seat : -1;
      if (i < 0 || !seats[i] || seats[i].bot) return { ok: false, code: 'FULL' };
      if (this.online(i)) return { ok: false, code: 'SEAT_ONLINE' };
      // 拿回座位：换一张新凭证，旧设备上的凭证随即作废（它再连会被告知"在别的设备上重新加入过"）
      seats[i].token = c || newToken();
      for (const w of this.ctx.getWebSockets('seat' + i)) { this.send(w, { t: 'fatal', code: 'BAD_TOKEN', message: '这个座位已经在别的设备上重新加入了' }); try { w.close(4003, 'BAD_TOKEN'); } catch (e) { /* 已断开 */ } }
      await this.save();
      return { ok: true, roomId: this.room.id, seat: i, token: seats[i].token, preset: this.room.preset, reclaimed: true };
    }
    seats[1] = Object.assign({ name: cleanName(name, 1), token: c || newToken() }, goodPid(pid) ? { pid: goodPid(pid) } : null);
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

  // 匹配不到真人：AI 对手坐进 1 号座位开局。只有房主（0 号座位的凭证）能请；已经有人坐下就什么都不做
  async addBot({ token, rec }) {
    await this.load();
    if (!this.room) return { ok: false, code: 'NOT_FOUND' };
    const seats = this.room.seats;
    if (!seats[0] || !token || seats[0].token !== token) return { ok: false, code: 'BAD_TOKEN' };
    if (seats[1]) return { ok: true, started: true };
    this.room.rec = cleanRec(rec);
    seats[1] = { name: botName(seats[0].name), token: newToken(), bot: { level: 0.5 } };
    this.startGame();
    this.syncClock();
    this.clockDirty = false;
    this.planBot([]);
    await this.save();
    this.broadcastWelcome();
    await this.scheduleAlarm();
    return { ok: true, started: true };
  }

  // 排队处（只在 __match__ 这个对象上用）：take 取走一个还新鲜的等待房间；给 roomId 就把它排上
  async queue({ take, roomId }) {
    const w = await this.ctx.storage.get('waiting');
    if (take) {
      if (!w || Date.now() - w.at > MATCH_FRESH) return { ok: true, roomId: null };
      await this.ctx.storage.put({ waiting: null });
      return { ok: true, roomId: w.roomId };
    }
    if (typeof roomId === 'string' && ROOM_RE.test(roomId)) await this.ctx.storage.put({ waiting: { roomId, at: Date.now() } });
    return { ok: true };
  }

  async cancel({ roomId }) {
    const w = await this.ctx.storage.get('waiting');
    if (w && w.roomId === roomId) await this.ctx.storage.put({ waiting: null });
    return { ok: true };
  }

  /* ── WebSocket ── */

  async fetch(request) {
    const url = new URL(request.url);
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') return this.acceptSocket(url);
    const m = url.pathname.match(/^\/rpc\/(create|join|info|ping|addBot|queue|cancel)$/);
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
    await this.seatSocket(server, seat, { v: Number(url.searchParams.get('v')) || 1, last: url.searchParams.has('last') ? Number(url.searchParams.get('last')) : -1 });
    return new Response(null, { status: 101, webSocket: client });
  }

  // 新连接坐上座位。同一个座位只留最新的连接：旧连接多半已经半死（换网络、App 切到后台），留着会让对手看到"在线"却等不到人；
  // 同一台设备开了两个窗口时，旧窗口会收到 replaced，停下来让玩家自己选在哪个窗口继续
  async seatSocket(server, seat, opts) {
    const o = opts || {};
    for (const w of this.ctx.getWebSockets('seat' + seat)) {
      this.send(w, { t: 'replaced' });
      try { w.close(4009, 'REPLACED'); } catch (e) { /* 已断开 */ }
    }
    this.ctx.acceptWebSocket(server, ['seat' + seat]);
    server.serializeAttachment({ seat, at: Date.now(), v: o.v >= PROTO ? PROTO : 1 });
    this.room.seen = this.room.seen || [0, 0];
    this.room.seen[seat] = Date.now();
    this.room.expireAt = Date.now() + ttlMs(this.env);
    // v2 断线重连：错过的几步能补就补（客户端照样播动画），补不了（太久 / 换了一局 / 对象重启过）才发完整局面
    const back = o.v >= PROTO ? this.resumeFor(seat, o.last) : null;
    this.send(server, back || this.welcome(seat)); // 两边都断过线、倒计时暂停了的话，这里会重新开始计时
    if (o.v >= PROTO) this.send(server, { t: 'chatlog', list: (this.room.chat || []).slice() });
    this.broadcastRoom();
    await this.save();
    await this.scheduleAlarm();
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    const seat = this.seatOf(ws);
    if (!this.room || seat == null || !this.room.seats[seat]) {
      this.send(ws, { t: 'fatal', code: 'NOT_FOUND', message: ERRORS.NOT_FOUND[1] });
      try { ws.close(4004, 'NOT_FOUND'); } catch (e) { /* 已断开 */ }
      return;
    }
    if (raw === 'ping') { // 运行时不支持自动回 pong 时才会走到这里：自己记下心跳时间
      ws.serializeAttachment(Object.assign({}, ws.deserializeAttachment(), { rx: Date.now() }));
      return this.send(ws, 'pong');
    }
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
      case 'who': return this.send(ws, { t: 'room', room: this.roomInfo() }); // 等对手时定期问一下在线状态（连接半死不会触发断开事件）
      case 'claim': return this.onClaim(ws, seat);
      case 'chat': return this.onChat(ws, seat, msg);
      default: return this.send(ws, { t: 'error', code: 'UNKNOWN', message: '未知的消息类型' });
    }
  }

  async webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch (e) { /* 已关闭 */ }
    await this.load();
    if (!this.room) return;
    const seat = this.seatOf(ws);
    if (seat != null && !this.online(seat, ws)) { // 这个座位最后一条连接断了：从现在开始算离线（半死了很久才断开的，从最后一次心跳算）
      const b = this.beatOf(ws);
      this.room.seen = this.room.seen || [0, 0];
      this.room.seen[seat] = Math.max(this.room.seen[seat] || 0, b && Date.now() - b >= STALE_MS ? b : Date.now());
      await this.save();
    }
    this.broadcastRoom(ws);
  }

  // 申请判胜：对手（真人）离线满 claimMs，替他认输
  async onClaim(ws, seat) {
    const o = 1 - seat;
    const other = this.room.seats[o];
    if (!this.game || this.game.phase === 'gameOver' || !other || other.bot) return this.send(ws, { t: 'error', code: 'NO_CLAIM', message: '现在不能申请判胜' });
    const away = this.awayMs(o);
    const need = claimMs(this.env);
    if (away < need) {
      this.send(ws, { t: 'room', room: this.roomInfo() });
      return this.send(ws, { t: 'error', code: 'NOT_AWAY', message: away ? `对手才离线 ${fmtDur(away)}，满 ${fmtDur(need)}才能判胜` : '对手还在线' });
    }
    const r = this.game.dispatch({ type: 'RESIGN', player: o, away: true });
    if (!r.ok) return this.send(ws, { t: 'error', code: 'NO_CLAIM', message: r.error.message });
    await this.commit(r);
    return undefined;
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async onAction(ws, seat, msg) {
    const id = msg.id;
    if (!this.game) return this.send(ws, { t: 'ack', id, ok: false, error: { code: 'NOT_STARTED', message: '对手还没加入，对局还没开始' } });
    // 断线重连后客户端会把没收到确认的动作原样重发一次：同一个 aid 只执行一次
    const aid = typeof msg.aid === 'string' && msg.aid.length <= 40 ? msg.aid : null;
    const done = (this.room.acts && this.room.acts[seat]) || [];
    if (aid && (done.indexOf(aid) >= 0 || (this.room.lastAct && this.room.lastAct[seat] === aid))) return this.send(ws, { t: 'ack', id, ok: true, dup: true, n: this.room.n || 0 });
    if (!this.allow(ws)) return this.send(ws, { t: 'ack', id, ok: false, error: { code: 'TOO_FAST', message: '操作太快了，稍等一下' } });
    const src = msg.action && typeof msg.action === 'object' && !Array.isArray(msg.action) ? msg.action : {};
    if (src.type === 'TIMEOUT_PLAY' || src.type === 'SALE_CLOSE') return this.send(ws, { t: 'ack', id, ok: false, error: { code: 'UNKNOWN_ACTION', message: '未知的操作' } }); // 只有服务器的倒计时能发（出牌超时、拍卖落槌）
    const action = { player: seat };
    for (const k of ACTION_KEYS) if (Object.prototype.hasOwnProperty.call(src, k)) action[k] = src[k];
    const r = this.game.dispatch(action);
    if (!r.ok) return this.send(ws, { t: 'ack', id, ok: false, error: r.error });
    if (aid) {
      this.room.acts = this.room.acts || [[], []];
      this.room.acts[seat] = this.room.acts[seat].concat(aid).slice(-8); // 最近 8 个动作编号：重连后重发的同一个动作只执行一次
    }
    await this.commit(r, null, (n) => this.send(ws, { t: 'ack', id, ok: true, n }));
    return undefined;
  }

  // 动作生效之后：记战绩、重新计时、存档、（先回执）再把更新推给两边，最后重排闹钟
  async commit(r, extra, ack) {
    if (this.game.phase === 'gameOver' && this.room.scoredRound !== this.room.round) { // 记本房间战绩
      const w = this.game.result.winner;
      this.room.score = this.room.score || [0, 0];
      if (w === 0 || w === 1) this.room.score[w] += this.game.result.stake || 1; // 按分累计：加注过的局分值更高
      this.room.scoredRound = this.room.round;
      const b = this.botSeat();
      if (b >= 0) { // 对 AI 的战绩：下一局按它调难度；新战绩也发给玩家那边存着，下次匹配带上来
        this.room.rec = recAfter(this.room.rec, w === 1 - b ? 1 : w === b ? 0 : 0.5);
        extra = Object.assign({}, extra, { rec: this.room.rec });
      }
    }
    this.planBot(r.events);
    this.fxGrace = fxMs(r.events);
    this.syncClock();
    this.fxGrace = 0;
    this.clockDirty = false;
    const n = (this.room.n || 0) + 1;
    this.room.n = n;
    this.room.hist = (this.room.hist || []).concat({ n, events: r.events, extra: extra || null }).slice(-HIST_MAX);
    await this.save();
    if (ack) ack(n);
    for (const w of this.ctx.getWebSockets()) {
      const s = this.seatOf(w);
      if (s == null) continue;
      const events = this.game.redact(r.events, s);
      const head = Object.assign({ t: 'update', events, lines: events.map((e) => this.game.describe(e, s)) }, extra);
      this.send(w, this.protoOf(w) >= PROTO ? this.pack(s, n, head) : Object.assign(head, this.snapshot(s)));
    }
    this.noteSets();
    await this.scheduleAlarm();
  }

  /* ── AI 对手：没有连接，靠闹钟出牌；等玩家那边的动画放完再动，像真人一样有思考停顿 ── */

  botSeat() {
    const seats = this.room && this.room.seats;
    return seats ? seats.findIndex((x) => x && x.bot) : -1;
  }

  botNeeds(b) {
    const g = this.game;
    if (!g || g.phase === 'gameOver') return false;
    const o = g.getOptions(b);
    if (o && o.respond && o.respond.action === 'auction' && g.getView(b).pending.bids[b] != null) return false; // 已经出过价了
    return g.listActions(b).length > 0;
  }

  planBot(events) {
    const b = this.botSeat();
    if (b < 0) return;
    if (!this.botNeeds(b)) { this.room.botAt = null; this.room.botPlan = null; return; }
    if (this.room.botAt && this.room.botAt > Date.now()) return;
    // 先想好这一步出什么，停多久看出的是什么（botChoose 只用 Math.random、不碰对局的随机数：早想晚想都一样）；
    // 拍卖照旧到点再想（价钱一直在变）。到点时局面变了（seq 不同）就作废重想
    const v = this.game.getView(null);
    const sale = v.phase === 'respond' && v.pending && v.pending.action === 'sale';
    const bot = this.room.seats[b].bot;
    const a = sale ? null : this.game.botChoose(b, { level: bot.level, firm: !!bot.firm, tease: !!bot.tease });
    this.room.botPlan = a ? { seq: v.seq, a } : null;
    let ms = this.botDelay(events || [], b, a);
    // 有倒计时的决定：怎么想都在到点前 2.5 秒出手（时限设得很短时也不会被系统代操作）。同一个决定点只是换了人（秘密竞价对方先出了价）倒计时不重开，按剩下的算
    const ck = sale ? null : this.clockNow();
    const lim = ck && ck.kind !== 'sale' ? clockMs(this.env, ck.kind) : 0;
    if (lim) {
      const c = this.room.clock;
      const left = c && c.key === ck.key ? c.deadline - Date.now() : lim + fxMs(events || []); // 新的决定点：syncClock 马上按 时限 + 动画时间 开始倒计时
      ms = Math.max(Math.min(ms, 300), Math.min(ms, left - 2500));
    }
    this.room.botAt = Date.now() + ms;
  }

  // 停多久再动 = settle（等前端把上一下放完：牌飞到位、亮相、盖章、排队的大场面）+ think（想一想，看要出的是什么）。
  // think：收手、存钱、放地产很快；出攻击牌、出「反对行动」、交一大笔钱之前停一拍——几档区间互相重叠，停顿长短不会变成明牌
  botDelay(events, b, a) {
    const v = this.game.getView(null);
    // 拍卖是限时的（几秒没人加价就成交）：想 1–3.5 秒就出手；先等这一下的动画放完（开拍、同时触发的大场面——和倒计时让出的时间一样）
    if (v.phase === 'respond' && v.pending && v.pending.action === 'sale') return 1100 + Math.random() * 2400 + Math.min(15000, fxMs(events));
    const U = (lo, hi) => lo + Math.random() * (hi - lo);
    const has = (types) => events.some((e) => types.indexOf(e.type) >= 0);
    // ① settle。牌飞到位：存钱、付款的银行数字滚得比放地产久；轮到 AI 时摸牌飞过去
    const FLY = { property: 900, move: 900, building: 900, discard: 900, draw: 1200, steal: 1300, swap: 1300, setStolen: 1300, bank: 1600, payment: 1600 };
    let ms = 0;
    for (const e of events) ms = Math.max(ms, FLY[e.type] || 0);
    const ap = events.filter((e) => e.type === 'actionPlayed');
    if (ap.length) ms = Math.max(ms, ap.some((e) => e.player === b) ? (ap.some((e) => e.player === b && e.target != null) ? 1800 : 1500) : 1000); // 行动卡亮相：AI 的牌翻面亮相约 1.5 秒（冲着玩家的多停一会儿），玩家自己的短
    if (has(['justSayNo', 'setStolen', 'bankrupt', 'liquidated', 'hugeWin'])) ms = Math.max(ms, 1700); // 盖章
    // 排队的大场面：一个接一个放，时间累加（秘密竞价开场、赌场礼赠到手的登场动画也等它放完，不抢在动画上面出价 / 出牌）。AI 自己的成就、电力满格、礼赠、贪婪大亨、捉鬼套装前端放的是短版
    const EXTRA = { gamble: 3900, lottery: 3700, ghost: 6800, auctionStart: 2800, auctionResult: 3700, giftEarned: 2800, giftOpened: 3500, tycoon: 3300, tycoonChosen: 2700, surge: 2800, comeback: 1800, award: 2600, jackpot: 1500, takeoverStart: 4200, rouletteSpin: 7600, roulettePrize: 2400, saleEnd: 2800 };
    const MINE = { award: 1500, surge: 1800, giftEarned: 1800, tycoon: 1800, ghost: 6000 };
    for (const e of events) ms += (e.player === b && MINE[e.type]) || EXTRA[e.type] || 0;
    if (events.some((e) => e.type === 'payment' && e.paid > 10)) ms += 1700; // 金币雨
    // 前端先播完揭晓的大场面才结算（牌飞、银行数字滚动），再给结算留一点时间
    const REVEAL = ['gamble', 'lottery', 'auctionResult', 'giftOpened', 'tycoonChosen', 'takeoverStart']; // 和前端 SUSPENSE 一致（捉鬼套装、成就排在结算后面，各自的时间在 EXTRA 里）；轮盘赌的 7.6 秒已经包含停下后的结果
    if (events.some((e) => REVEAL.indexOf(e.type) >= 0 || (e.type === 'payment' && e.paid > 10))) ms += 1200;
    // 集齐一整套的大场面：玩家的放 3 秒，AI 的 2.1 秒（一下换出两套——两边同时凑满——前端两段接着放，都等）
    const full = [0, 1].map((i) => v.players[i].fullColors.length);
    const seen = this.room.fullSeen || [0, 0];
    if (full[1 - b] > seen[1 - b]) ms += 2600;
    if (full[b] > seen[b]) ms += 1500;
    // ② think
    const t = a ? a.type : '';
    const c = a && a.cardId != null ? MD.CARDS[a.cardId] : null;
    if (v.phase === 'respond') {
      ms += t === 'JUST_SAY_NO' ? U(1200, 2000) : t === 'PAY' ? (v.pending.amount >= 5 ? U(900, 1600) : U(500, 900)) : t === 'ACCEPT' && v.pending.action !== 'raise' ? U(450, 850)
        : t === 'BID' ? U(1200, 2000) : U(900, 1500); // 轮盘赌接着转还是走、礼赠、贪婪大亨、加注：想一想
    } else if (v.phase === 'discard') ms += U(600, 1000);
    else {
      ms += t === 'END_TURN' ? U(250, 500) : t === 'PLAY_BANK' ? U(400, 750) : t !== 'PLAY_ACTION' ? U(450, 850)
        : c.type === 'rent' || ['debtCollector', 'birthday', 'slyDeal', 'forcedDeal', 'dealBreaker', 'bankruptcy', 'liquidation', 'hugeWin'].indexOf(c.action) >= 0 ? U(900, 1500) : U(550, 950); // 冲着对方的牌（收租、讨债、抢牌……）先停一拍
      if (events.some((e) => e.type === 'turnStart' && e.player === b)) ms += U(150, 400); // 回合开头：摸完牌看一眼
      else if (!events.length && v.turn.number <= 1 && v.turn.plays === 0) ms += 2600; // 开局 AI 先手：等发牌动画落定，再像刚理好牌一样出第一张
    }
    return Math.min(14000, ms);
  }

  async botMove() {
    const b = this.botSeat();
    const plan = this.room.botPlan;
    this.room.botAt = null;
    this.room.botPlan = null;
    if (b < 0 || !this.botNeeds(b)) { await this.save(); return; }
    const bot = this.room.seats[b].bot;
    const a = plan && plan.seq === this.game.getView(null).seq ? plan.a : this.game.botChoose(b, { level: bot.level, firm: !!bot.firm, tease: !!bot.tease }); // 想好之后局面没变：照想好的出
    if (!a && this.game.getView(null).pending && this.game.getView(null).pending.action === 'sale') { await this.save(); return; } // 拍卖：不跟了（对方再加价时会重新考虑）
    let r = a ? this.game.dispatch(a) : { ok: false };
    if (!r.ok) { // 不该发生：退一步，结束回合 / 付款 / 接受
      const acts = this.game.listActions(b);
      const fb = acts.find((x) => x.type === 'END_TURN') || acts.find((x) => x.type === 'PAY') || acts.find((x) => x.type === 'ACCEPT') || acts[0];
      r = fb ? this.game.dispatch(fb) : { ok: false };
      if (!r.ok) { console.error('[monopoly-deal] AI 出牌失败', r.error); await this.save(); return; }
    }
    await this.commit(r);
  }

  // 记下双方完整套数：botDelay 靠它判断这一步有没有集齐新的一套，好等那段大场面动画放完再出牌
  noteSets() {
    if (this.botSeat() < 0) return;
    const v = this.game.getView(null);
    this.room.fullSeen = [0, 1].map((i) => v.players[i].fullColors.length);
  }

  /* ── 倒计时（出牌默认不限时，回应 / 弃牌限时） ── */

  // 现在等谁做哪个决定。出牌阶段每出一张（或超时作废一次）plays 都会变，所以每张牌各算各的时间
  clockNow() {
    const g = this.game;
    if (!g || g.phase === 'gameOver') return null;
    const v = g.getView(null);
    const pd = v.phase === 'respond' ? v.pending : null;
    const kind = pd ? (pd.action === 'sale' ? 'sale' : 'respond') : v.phase === 'discard' ? 'discard' : 'play';
    const seat = pd ? pd.awaiting : v.turn.player;
    // 轮盘赌每转一局 / 换人都是新的决定点（step 每次 +1）
    return { seat, kind, key: [this.room.round || 0, v.turn.number, v.phase, v.turn.plays, pd ? `${pd.id}.${pd.chain.length}.${pd.step || 0}.${pd.action === 'takeover' ? pd.awaiting : ''}` : '', v.discardNeed || 0].join('|') };
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
    if (c && c.key === now.key) { // 同一个决定点（比如秘密竞价一方出完价）：不重新计时，只换"等谁"
      if (c.seat !== now.seat) { c.seat = now.seat; this.clockDirty = true; }
      return false;
    }
    const total = now.kind === 'sale' ? this.saleMs() : clockMs(this.env, now.kind);
    if (!total) { // 这种决定点不限时：没有倒计时
      if (!c) return false;
      this.room.clock = null;
      this.clockDirty = true;
      return true;
    }
    const grace = Math.min(15000, this.fxGrace || 0); // 前端还要先放一会儿动画（老虎机、开奖、成就……）才能操作：这段时间不算
    this.room.clock = { key: now.key, seat: now.seat, kind: now.kind, total: total + grace, deadline: Date.now() + total + grace };
    this.clockDirty = true;
    return true;
  }

  // 拍卖这一口还能等多久：没人出价时 saleOpenSeconds，有人出价后 saleHoldSeconds；整场不超过开拍后 saleMaxMinutes
  saleMs() {
    const v = this.game.getView(null);
    const pd = v.pending;
    const r = v.rules;
    if (!this.room.sale || this.room.sale.id !== pd.id) this.room.sale = { id: pd.id, start: Date.now() };
    const left = this.room.sale.start + r.saleMaxMinutes * 60000 - Date.now();
    return Math.max(1, Math.min(left, (pd.leader == null ? r.saleOpenSeconds : r.saleHoldSeconds) * 1000));
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
    if (r.botAt && this.game && this.ctx.getWebSockets().length) t = Math.min(t, r.botAt); // AI 只在有人看着的时候出牌
    await this.ctx.storage.setAlarm(t);
  }

  // 时间到：出牌阶段作废 1 次出牌（用完自动结束回合）；被询问时接受或按建议付款（不会替人出「反对行动」）；弃牌按建议弃；
  // 秘密竞价没出价的出 0（两边都没出就一个一个替）；赌场礼赠自己打开；轮盘赌带着筹码离开（一局都没转就替他押最少的红色）
  async timeout() {
    const c = this.room.clock;
    const now = this.clockNow();
    if (!c || !now || now.key !== c.key) { this.syncClock(); return; }
    if (c.kind === 'sale') { // 拍卖到点：落槌（成交或流拍），不算谁超时
      const r = this.game.dispatch({ type: 'SALE_CLOSE', player: c.seat });
      if (!r.ok) { console.error('[monopoly-deal] 拍卖落槌失败', r.error); c.deadline = Date.now() + 1000; return; }
      await this.commit(r);
      return;
    }
    const acts = c.kind === 'play' ? [{ type: 'TIMEOUT_PLAY', player: c.seat }] : this.game.listActions(c.seat);
    const pick = (t) => acts.find((a) => a.type === t);
    const a = pick('TIMEOUT_PLAY') || pick('ACCEPT') || pick('PAY') || pick('DISCARD') || pick('BID') || pick('GIFT') || pick('TYCOON') || pick('FOLD') || pick('CASH_OUT') || pick('SPIN'); // 竞价超时出 0，礼赠超时自己打开，贪婪大亨超时选套现，轮盘赌超时带着筹码离开（一局都没转就替他押最少的红色）
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
    let st = null;
    if (typeof msg.s === 'string' && STICKER_ID.test(msg.s)) { // 表情面板那套自定义表情：只认清单里的，对应的系统表情以服务器为准
      let T = null;
      try { T = await loadStickers(this.env); } catch (e) { T = null; }
      const x = T && T.emoteIds && T.emoteIds.has(msg.s) ? T.byId.get(msg.s) : null;
      if (!x) return undefined;
      st = { s: msg.s, k: x.kind, e: x.emoji || '🙂' };
    } else if (EMOTES.indexOf(msg.e) < 0) return undefined;
    const att = ws.deserializeAttachment() || {};
    const now = Date.now();
    if (att.emoteAt && now - att.emoteAt < 1200) return undefined;
    ws.serializeAttachment(Object.assign({}, att, { emoteAt: now }));
    return this.emote(seat, st ? st.e : msg.e, st);
  }

  // 广播一个表情（真人和 AI 对手共用）；st：自定义表情 { s, k }
  async emote(seat, e, st) {
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
    for (const w of this.ctx.getWebSockets()) this.send(w, st ? { t: 'emote', seat, e, s: st.s, k: st.k, count } : { t: 'emote', seat, e, count });
    if (award) for (const w of this.ctx.getWebSockets()) this.send(w, { t: 'award', seat, award: 'emoteMaster' });
    if (count) await this.save();
    return undefined;
  }

  async onRematch(ws, seat) {
    if (!this.game || this.game.phase !== 'gameOver') return this.send(ws, { t: 'error', code: 'NOT_OVER', message: '这一局还没结束' });
    this.room.rematch[seat] = true;
    const b = this.botSeat();
    if (b >= 0) this.room.rematch[b] = true; // AI 对手随时奉陪
    if (this.room.rematch[0] && this.room.rematch[1]) {
      this.startGame();
      this.syncClock();
      this.clockDirty = false;
      this.planBot([]);
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
    if (this.game && live && this.room.botAt && now >= this.room.botAt - 30) await this.botMove();
    const c = this.room.clock;
    if (this.game && c && !live) { this.room.clock = null; await this.save(); } // 没人在线：倒计时暂停（AI 想牌时响的闹钟也算），连上后重新计时
    else if (this.game && c && now >= c.deadline - 50) await this.timeout();
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

  // 这个座位的连接最近一次有动静的时间（心跳 = 运行时自动回 pong 的时间；没有就看连上的时间）
  lastBeat(i, exclude) {
    let t = 0;
    for (const w of this.ctx.getWebSockets('seat' + i)) if (w !== exclude && w.readyState === 1) t = Math.max(t, this.beatOf(w));
    return t;
  }

  beatOf(w) {
    const a = w.deserializeAttachment() || {};
    let hb = null;
    try { hb = this.ctx.getWebSocketAutoResponseTimestamp(w); } catch (e) { /* 本地老版本运行时没有这个接口 */ }
    return Math.max(hb ? +hb : 0, a.at || 0, a.rx || 0);
  }

  online(i, exclude) {
    const b = this.lastBeat(i, exclude);
    return b > 0 && Date.now() - b < STALE_MS;
  }

  // 离线了多久（在线 / AI = 0）
  awayMs(i) {
    const x = this.room.seats[i];
    if (!x || x.bot || this.online(i)) return 0;
    const last = Math.max((this.room.seen && this.room.seen[i]) || 0, this.lastBeat(i));
    return last ? Math.max(1, Date.now() - last) : 0;
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
      mode: r.mode || 'room',
      players: r.seats.map((x, i) => {
        if (!x) return null;
        const on = x.bot ? true : this.online(i, exclude);
        return on ? { name: x.name, online: true } : { name: x.name, online: false, away: this.game ? this.awayMs(i) : 0 }; // away：离线多少毫秒
      }),
      claimAfter: claimMs(this.env),
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

  protoOf(ws) {
    const a = ws.deserializeAttachment();
    return (a && a.v) || 1;
  }

  // v2 更新：局面只发差异（这个座位上一次收到的是 sent[seat]），附校验值；没有基准就发完整的
  pack(seat, n, head) {
    const snap = this.snapshot(seat);
    const body = norm({ view: snap.view, options: snap.options, discardHint: snap.discardHint });
    const msg = Object.assign(head, { n, hash: hashOf(body), room: snap.room, clock: snap.clock });
    const prev = this.sent[seat];
    if (prev) {
      const d = diffJson(prev.body, body);
      msg.base = prev.n;
      msg.patch = d === undefined ? null : d;
    } else Object.assign(msg, body);
    this.sent[seat] = { n, body };
    return msg;
  }

  // 断线重连时客户端说它看到第 last 次更新：没错过就只确认一下；错过的都还在 hist 里就合成一条补课更新；否则返回 null（发完整局面）
  resumeFor(seat, last) {
    const r = this.room;
    const cur = r.n || 0;
    if (!this.game || !(last >= 0) || last > cur) return null; // last < 0：客户端手里没有局面
    const snap = this.snapshot(seat);
    const body = norm({ view: snap.view, options: snap.options, discardHint: snap.discardHint });
    const hash = hashOf(body);
    if (last === cur) { this.sent[seat] = { n: cur, body }; return { t: 'resume', n: cur, hash, room: snap.room, clock: snap.clock }; }
    const missed = (r.hist || []).filter((x) => x.n > last);
    if (!missed.length || missed[0].n !== last + 1) return null;
    const events = this.game.redact([].concat(...missed.map((x) => x.events)), seat);
    this.sent[seat] = { n: cur, body };
    return Object.assign({ t: 'update', catchup: missed.length, events, lines: events.map((e) => this.game.describe(e, seat)) }, ...missed.map((x) => x.extra || {}),
      { n: cur, hash, room: snap.room, clock: snap.clock }, body);
  }

  // 聊天：限速（令牌桶：每 1.5 秒 1 条，最多攒 4 条）、清洗、存最近 CHAT_MAX 条、广播给房间里所有连接
  async onChat(ws, seat, msg) {
    const text = cleanChat(msg.text);
    const cid = typeof msg.cid === 'string' && msg.cid.length <= 24 ? msg.cid : undefined;
    const sid = typeof msg.sticker === 'string' && STICKER_ID.test(msg.sticker) ? msg.sticker : null;
    if (!text && !sid) return undefined;
    const att = ws.deserializeAttachment() || {};
    const now = Date.now();
    const b = att.chatB || { n: 4, t: now };
    b.n = Math.min(4, b.n + (now - b.t) / 1500);
    b.t = now;
    if (b.n < 1) return this.send(ws, { t: 'chatNo', cid, message: '说得太快了，歇一会儿再发' });
    b.n -= 1;
    ws.serializeAttachment(Object.assign({}, att, { chatB: b }));
    let sticker = null;
    if (sid) { // 表情：只认配好的那几套里的
      let T = null;
      try { T = await loadStickers(this.env); } catch (e) { T = null; }
      const st = T && T.byId.get(sid);
      if (!st) return this.send(ws, { t: 'chatNo', cid, message: '这个表情用不了' });
      sticker = { id: sid, emoji: st.emoji, kind: st.kind };
    }
    const r = this.room;
    r.chatN = (r.chatN || 0) + 1;
    const m = sticker ? { id: r.chatN, seat, text: '', sticker, at: now } : { id: r.chatN, seat, text, at: now };
    r.chat = (r.chat || []).concat(m).slice(-CHAT_MAX);
    await this.save();
    for (const w of this.ctx.getWebSockets()) if (this.protoOf(w) >= PROTO) this.send(w, w === ws ? { t: 'chat', m, cid } : { t: 'chat', m });
    return undefined;
  }

  welcome(seat) {
    const base = { t: 'welcome', seat, engine: MD.VERSION, room: this.roomInfo(), n: this.room.n || 0 };
    if (!this.game) { this.sent[seat] = null; return base; }
    const log = this.game.getLog(seat).slice(-60).map((e) => this.game.describe(e, seat));
    const snap = this.snapshot(seat);
    const body = norm({ view: snap.view, options: snap.options, discardHint: snap.discardHint });
    this.sent[seat] = { n: this.room.n || 0, body };
    return Object.assign(base, snap, body, { log, hash: hashOf(body) });
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
