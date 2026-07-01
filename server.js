// Feishu / Lark group bot — LONG CONNECTION (WebSocket) mode.
// No public URL / HTTPS / nginx needed: the bot dials out to Feishu, receives
// message events, answers from knowledge.md via Qwen, and replies in the chat.
// Just run `node server.js` anywhere with internet.

import "dotenv/config";
import * as Lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleTodo } from "./todo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_DOMAIN = "feishu", // "feishu"(国内) | "lark"(国际)
  QWEN_KEY,
  QWEN_BASE = "https://dashscope.aliyuncs.com", // intl: https://dashscope-intl.aliyuncs.com
  QWEN_MODEL = "qwen-plus",
  // 用 Claude 中转（OpenAI 兼容格式，国内常见）：填中转的完整 chat/completions 地址 + key + 模型名。
  RELAY_URL, // 例：https://你的中转域名/v1/chat/completions
  RELAY_KEY,
  RELAY_MODEL = "claude-sonnet-4-6",
  // 或 Anthropic 原生接口（/v1/messages，x-api-key）。多数国内中转用上面的 RELAY_*，不用这个。
  ANTHROPIC_KEY,
  ANTHROPIC_BASE = "https://api.anthropic.com",
  ANTHROPIC_MODEL = "claude-sonnet-4-6",
  HANDOFF_HINT = "我不太确定这个，建议直接找 TL 确认～",
  // 让机器人实时读「你自己飞书里」的文档作为知识库（同组织才行）。
  FEISHU_WIKI_SPACE_ID, // 知识库 space_id（整本知识库一起读，含子页面）
  FEISHU_DOC_TOKENS, // 或单独几篇云文档 document_id，逗号分隔
  DOC_REFRESH_SECONDS = "300", // 多久去飞书拉一次最新内容（秒）
  BOT_NAME = "新手指引", // 机器人自己的名字，用来在 @ 列表里把自己排除掉
  TL_NAMES = "", // TL/负责人名单（逗号分隔，和飞书显示名一致）；对他们不会再说"找 TL"
  ADMIN_CODE = "", // 认领管理员的口令（可空）；私聊发「我是管理员 <口令>」即可
} = process.env;
const TL_LIST = TL_NAMES.split(",").map((s) => s.trim()).filter(Boolean);

const MODE = RELAY_URL && RELAY_KEY ? "relay" : ANTHROPIC_KEY ? "claude" : "qwen";
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || (!QWEN_KEY && MODE === "qwen")) {
  console.error("缺少环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET / (QWEN_KEY 或 RELAY_URL+RELAY_KEY 或 ANTHROPIC_KEY)");
  process.exit(1);
}

const domain = FEISHU_DOMAIN === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
const client = new Lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, domain });
const wsClient = new Lark.WSClient({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, domain });

// ---- knowledge base (hot-reloaded so edits take effect without restart) ----
// KNOWLEDGE     = knowledge.md（手写：工具用法、入职流程等固定内容）
// SYNCED        = knowledge.feishu.md（由 sync-feishu.mjs 抓「公开飞书文档」写入）
// LEARNED       = knowledge.learned.md（自学习：digest.mjs 生成草稿、你 approve 后入库）
let KNOWLEDGE = "";
let SYNCED = "";
let LEARNED = "";
function loadKnowledge() {
  try {
    KNOWLEDGE = fs.readFileSync(path.join(__dirname, "knowledge.md"), "utf8");
  } catch {
    KNOWLEDGE = "(知识库文件缺失)";
  }
  try {
    SYNCED = fs.readFileSync(path.join(__dirname, "knowledge.feishu.md"), "utf8");
  } catch {
    SYNCED = "";
  }
  try {
    LEARNED = fs.readFileSync(path.join(__dirname, "knowledge.learned.md"), "utf8");
  } catch {
    LEARNED = "";
  }
}
loadKnowledge();
setInterval(loadKnowledge, 60_000);

// ---- LIVE knowledge from YOUR OWN Feishu docs/wiki (same org as the bot) ----
// You edit the doc in Feishu → bot pulls the latest every DOC_REFRESH_SECONDS.
const OPEN_BASE = FEISHU_DOMAIN === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
let FEISHU_DOCS = ""; // text pulled from Feishu
let _tok = { v: "", exp: 0 };

async function tenantToken() {
  if (_tok.v && Date.now() < _tok.exp) return _tok.v;
  const res = await fetch(`${OPEN_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const j = await res.json();
  if (!j.tenant_access_token) throw new Error("tenant_access_token 失败: " + JSON.stringify(j).slice(0, 160));
  _tok = { v: j.tenant_access_token, exp: Date.now() + Math.max(60, (j.expire || 7200) - 60) * 1000 };
  return _tok.v;
}

async function fetchDocRaw(docId, token) {
  const res = await fetch(`${OPEN_BASE}/open-apis/docx/v1/documents/${docId}/raw_content`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`doc ${docId}: ${j.msg || j.code}`);
  return j.data?.content || "";
}

// list every docx node in a wiki space, recursing into sub-pages
async function listWikiDocs(spaceId, token, parent = "") {
  const out = [];
  let pageToken = "";
  do {
    const url = new URL(`${OPEN_BASE}/open-apis/wiki/v2/spaces/${spaceId}/nodes`);
    url.searchParams.set("page_size", "50");
    if (parent) url.searchParams.set("parent_node_token", parent);
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const j = await res.json();
    if (j.code !== 0) throw new Error(`wiki ${spaceId}: ${j.msg || j.code}`);
    for (const n of j.data?.items || []) {
      if (n.obj_type === "docx" && n.obj_token) out.push({ id: n.obj_token, title: n.title || n.obj_token });
      if (n.has_child) out.push(...(await listWikiDocs(spaceId, token, n.node_token)));
    }
    pageToken = j.data?.has_more ? j.data.page_token : "";
  } while (pageToken);
  return out;
}

async function refreshFeishuDocs() {
  if (!FEISHU_WIKI_SPACE_ID && !FEISHU_DOC_TOKENS) return;
  try {
    const token = await tenantToken();
    const docs = [];
    if (FEISHU_WIKI_SPACE_ID) docs.push(...(await listWikiDocs(FEISHU_WIKI_SPACE_ID, token)));
    for (const id of (FEISHU_DOC_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
      docs.push({ id, title: id });
    }
    const parts = [];
    for (const d of docs) {
      try {
        parts.push(`# ${d.title}\n${await fetchDocRaw(d.id, token)}`);
      } catch (e) {
        console.error("拉取文档失败", d.id, String(e).slice(0, 120));
      }
    }
    if (parts.length) {
      FEISHU_DOCS = parts.join("\n\n---\n\n");
      console.log(`已从飞书拉取 ${parts.length} 篇文档（${new Date().toLocaleTimeString()}）`);
    }
  } catch (e) {
    console.error("飞书文档刷新失败:", String(e).slice(0, 160));
  }
}
if (FEISHU_WIKI_SPACE_ID || FEISHU_DOC_TOKENS) {
  refreshFeishuDocs();
  setInterval(refreshFeishuDocs, Math.max(60, Number(DOC_REFRESH_SECONDS) || 300) * 1000);
}

// what the model actually reads: knowledge.md + synced public docs + app-authorized docs
function knowledgeText() {
  return [
    KNOWLEDGE,
    SYNCED && "===== 飞书文档（公开链接同步） =====\n" + SYNCED,
    FEISHU_DOCS && "===== 飞书文档（应用授权实时） =====\n" + FEISHU_DOCS,
    LEARNED && "===== 沉淀知识（人工审核入库） =====\n" + LEARNED,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// 把每次问答记录下来，供 digest.mjs 每天提炼成"待沉淀知识"。
function logQA(rec) {
  try {
    fs.appendFileSync(path.join(__dirname, "qa-log.jsonl"), JSON.stringify(rec) + "\n");
  } catch {}
}

// —— 管理员/TL 名单（存 open_id，自助认领）：用于"不踢皮球给TL" + 私聊审核入库 ——
const ADMIN_FILE = path.join(__dirname, "admin.json");
function loadAdmins() {
  try {
    return JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
  } catch {
    return [];
  }
}
function addAdmin(openId) {
  if (!openId) return;
  const list = loadAdmins();
  if (!list.includes(openId)) {
    list.push(openId);
    try {
      fs.writeFileSync(ADMIN_FILE, JSON.stringify(list));
    } catch {}
  }
}
// 是不是 TL：认领过（open_id）或名字在 TL_NAMES 里（需 contact 权限才有名字）
function isTLUser(openId, name) {
  return (openId && loadAdmins().includes(openId)) || (name && TL_LIST.includes(name));
}

// —— 自学习入库：把审核过的 knowledge.pending.md 并入 knowledge.learned.md ——
const PENDING_FILE = path.join(__dirname, "knowledge.pending.md");
const LEARNED_FILE = path.join(__dirname, "knowledge.learned.md");
function readPending() {
  try {
    return fs.readFileSync(PENDING_FILE, "utf8").trim();
  } catch {
    return "";
  }
}
// 把待审草稿按空行拆成一条条（去掉 ## 标题），供编号选择入库
function pendingItems() {
  const raw = readPending();
  if (!raw) return [];
  return raw
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith("#"));
}
function appendLearned(text) {
  if (!text) return;
  if (!fs.existsSync(LEARNED_FILE)) fs.writeFileSync(LEARNED_FILE, "# 沉淀知识（人工审核后入库）\n");
  fs.appendFileSync(LEARNED_FILE, "\n" + text + "\n");
}
function clearPending() {
  try {
    fs.writeFileSync(PENDING_FILE, "");
  } catch {}
}

// ---- 短期记忆：按「群 + 发问人」各记最近几轮，过期自动清，群里多人不串 ----
const CTX_TURNS = Math.max(0, Number(process.env.CTX_TURNS ?? 4)); // 记几轮（一问一答算一轮）
const CTX_TTL_MS = Math.max(60, Number(process.env.CTX_TTL_SECONDS ?? 900)) * 1000; // 多久没说话就清空
const history = new Map(); // key: `${chatId}:${senderId}` -> [{ q, a, ts }]
const ctxKey = (chatId, senderId) => `${chatId}:${senderId || "anon"}`;
function getPrior(key) {
  const arr = history.get(key);
  if (!arr) return [];
  const now = Date.now();
  const fresh = arr.filter((t) => now - t.ts <= CTX_TTL_MS);
  if (fresh.length) history.set(key, fresh);
  else history.delete(key);
  return fresh.slice(-CTX_TURNS);
}
function pushTurn(key, q, a) {
  if (CTX_TURNS === 0) return;
  const arr = getPrior(key).slice();
  arr.push({ q, a, ts: Date.now() });
  history.set(key, arr.slice(-CTX_TURNS));
  if (history.size > 5000) history.delete(history.keys().next().value); // 粗暴上限，防内存涨
}

// 一个不带知识库的通用 LLM 调用（给"按修改意见改草稿"这类内部任务用）
async function llmChat(system, userText, maxTokens = 900) {
  if (MODE === "relay") {
    const res = await fetch(RELAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${RELAY_KEY}` },
      body: JSON.stringify({
        model: RELAY_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, { role: "user", content: userText }],
      }),
    });
    if (!res.ok) throw new Error(`中转 ${res.status}`);
    const j = await res.json();
    return (j.choices?.[0]?.message?.content ?? "").trim();
  }
  if (MODE === "claude") {
    const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: userText }] }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}`);
    const j = await res.json();
    return (j.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("").trim();
  }
  const res = await fetch(`${QWEN_BASE}/compatible-mode/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${QWEN_KEY}` },
    body: JSON.stringify({
      model: QWEN_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`Qwen ${res.status}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

// ---- the brain: answer grounded in the knowledge base ----
async function answer(question, prior = [], asker = "", isTL = false) {
  const system = [
    "你是 KOL 商务团队的入职/答疑助理机器人。",
    asker ? `【当前提问人】${asker}${isTL ? "（本人就是 TL / 团队负责人）" : "（新人/实习生）"}` : "",
    "你既是这个团队的入职/答疑助理，也可以当通用 AI 助手用。",
    "规则：1) 答案简短、可执行、分点，用中文；2) 涉及【团队的具体规则 / SOP / 流程 / 金额 / 价格 / 找谁 / 账号】这类团队内部事实，只能依据下面的【团队知识库】，知识库没有就说『这个我不确定』，绝不编造；2b) 其他【通用任务】（写或改话术文案、翻译、润色、解释概念、起标题、头脑风暴、写邮件等）就正常发挥你的能力帮他，不受知识库限制；拿不准属于哪类时，优先当团队事实处理、宁可说不确定；3) 涉及金额/币种/合规/能不能改条款要谨慎，以 TL 最终确认为准；4)【每条回答都必须标明来源，别让人分不清是团队规定还是你自己想的】：a) 用到某篇带『来源链接：』的文档 → 末尾原样贴出该文档完整网址；b) 用到团队知识库里没有链接的内容（手写或已沉淀的知识）→ 结尾注明『（依据团队知识库）』；c) 团队资料里都没有、你凭通用理解或常识答的 → 结尾单独一行写『⚠️ 团队资料未覆盖，此为我的一般理解，请找 TL 核实』。绝不把自己推测的当成团队规定。",
    isTL
      ? "【重要】当前提问人本人就是 TL / 团队负责人：绝对不要让他『去找 TL 确认』；拿不准就直接说不确定、由他自己拍板。"
      : "知识库没覆盖或拿不准时，提醒他『建议找 TL 确认』。",
    "",
    "【团队知识库】",
    knowledgeText(),
  ]
    .filter(Boolean)
    .join("\n");
  // 把最近几轮对话当上下文（user/assistant 交替），让追问接得住
  const priorMsgs = [];
  for (const t of prior) {
    if (t.q) priorMsgs.push({ role: "user", content: t.q });
    if (t.a) priorMsgs.push({ role: "assistant", content: t.a });
  }
  // (1) OpenAI-compatible relay (中转) — most common in China for Claude
  if (MODE === "relay") {
    const res = await fetch(RELAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${RELAY_KEY}` },
      body: JSON.stringify({
        model: RELAY_MODEL,
        max_tokens: 900,
        messages: [
          { role: "system", content: system },
          ...priorMsgs,
          { role: "user", content: question },
        ],
      }),
    });
    if (!res.ok) throw new Error(`中转 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return (j.choices?.[0]?.message?.content ?? "").trim();
  }

  // (2) Anthropic native
  if (MODE === "claude") {
    const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 900,
        system,
        messages: [...priorMsgs, { role: "user", content: question }],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return (j.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("").trim();
  }

  const res = await fetch(`${QWEN_BASE}/compatible-mode/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${QWEN_KEY}` },
    body: JSON.stringify({
      model: QWEN_MODEL,
      max_tokens: 900,
      messages: [
        { role: "system", content: system },
        ...priorMsgs,
        { role: "user", content: question },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Qwen ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

async function reply(chatId, text) {
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
  });
}

// 把 open_id 解析成姓名（给日报/派单显示用）。需应用开 contact:user.base:readonly；
// 没开就降级成空名（派单的被指派人姓名走 @ 列表，不受影响）。带缓存。
const nameCache = new Map();
async function getUserName(openId) {
  if (!openId) return "";
  if (nameCache.has(openId)) return nameCache.get(openId);
  let name = "";
  try {
    const r = await client.contact.user.get({
      path: { user_id: openId },
      params: { user_id_type: "open_id" },
    });
    name = r?.data?.user?.name || "";
  } catch {
    name = "";
  }
  nameCache.set(openId, name);
  return name;
}

const seen = new Set(); // de-dupe by message_id
function once(id) {
  if (!id || seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 5000) seen.clear();
  return true;
}
const cleanText = (raw) => (raw || "").replace(/@_user_\d+/g, " ").replace(/\s+/g, " ").trim();

async function handleMessage(data) {
  const msg = data?.message;
  if (!msg || !once(msg.message_id)) return;
  if (msg.message_type !== "text") return;

  // only answer in private chats, or when @mentioned in a group
  const mentioned = Array.isArray(msg.mentions) && msg.mentions.length > 0;
  if (msg.chat_type === "group" && !mentioned) return;

  let text = "";
  try {
    text = cleanText(JSON.parse(msg.content || "{}").text);
  } catch {
    text = "";
  }
  if (!text) return;

  if (/转人工|人工|找人|找\s*tl/i.test(text)) {
    await reply(msg.chat_id, HANDOFF_HINT);
    return;
  }
  const senderId = data.sender?.sender_id?.open_id || data.sender?.sender_id?.user_id;
  let senderName = "";
  try {
    senderName = await getUserName(senderId);
  } catch {}
  const tl = isTLUser(senderId, senderName);
  if (tl) addAdmin(senderId); // 记住 TL 的 id，供每日草稿私聊推送
  const tt = text.trim();

  // —— 认领管理员：私聊发「我是管理员 <口令>」 ——
  if (/^(我是管理员|我是tl|设我为管理员)/i.test(tt)) {
    const code = tt.replace(/^(我是管理员|我是tl|设我为管理员)\s*/i, "").trim();
    if (ADMIN_CODE && code !== ADMIN_CODE) {
      await reply(msg.chat_id, "口令不对，没给你开管理员。");
      return;
    }
    addAdmin(senderId);
    await reply(
      msg.chat_id,
      "✅ 已把你设为管理员/TL：以后不会再让你『找 TL』；每天的新知识草稿会私聊推给你，回『待审』看、回『通过』入库、『清空待审』丢弃。"
    );
    return;
  }

  // —— 自学习审核入库（仅 TL）——
  if (tl) {
    // 看带编号的草稿
    if (/^(待审|看草稿|待沉淀|看待审)$/.test(tt)) {
      const items = pendingItems();
      await reply(
        msg.chat_id,
        items.length
          ? "📋 待审草稿（回「通过」全入库；「通过 1 3」只留这几条；「清空待审」全丢）：\n\n" +
              items.map((it, i) => `【${i + 1}】${it}`).join("\n\n")
          : "现在没有待审草稿。"
      );
      return;
    }
    // 通过 [序号...]：不带序号=全入库；带序号=只留这几条，其余丢弃
    const mm = tt.match(/^(通过|可以|入库|审核通过|approve|同意入库)\s*([\d\s,，]*)$/i);
    if (mm) {
      const items = pendingItems();
      if (!items.length) {
        await reply(msg.chat_id, "没有待审草稿可入库。");
        return;
      }
      const numsStr = (mm[2] || "").trim();
      let chosen = items;
      if (numsStr) {
        const nums = numsStr.split(/[\s,，]+/).map(Number).filter((n) => n >= 1 && n <= items.length);
        chosen = nums.map((n) => items[n - 1]);
      }
      if (!chosen.length) {
        await reply(msg.chat_id, "序号不对，没入库。发「待审」看看编号。");
        return;
      }
      appendLearned(chosen.join("\n\n"));
      clearPending();
      await reply(msg.chat_id, `✅ 已入库 ${chosen.length} 条，其余丢弃，机器人 1 分钟内学会。`);
      return;
    }
    if (/^(清空待审|丢弃草稿|删掉草稿)$/.test(tt)) {
      clearPending();
      await reply(msg.chat_id, "🗑 已清空待审草稿。");
      return;
    }
    // 按修改意见改草稿再入库：改：第一点改成xxx，二三不要
    const edit = tt.match(/^(改|修改|编辑)[:：]\s*([\s\S]+)/);
    if (edit && edit[2].trim()) {
      const items = pendingItems();
      if (!items.length) {
        await reply(msg.chat_id, "现在没有待审草稿可改。");
        return;
      }
      const numbered = items.map((it, i) => `【${i + 1}】${it}`).join("\n\n");
      const sys =
        "你在帮团队维护知识库。下面是【待审知识草稿】和审核人的【修改意见】。" +
        "请按修改意见产出【最终要入库的知识】：保留/改写审核人要的、删掉他不要的，一切以他的措辞为准。" +
        "只输出最终知识条目本身（每条简洁，条目之间空一行），不要编号、不要解释、不要多余的话。";
      const usr = `【待审知识草稿】\n${numbered}\n\n【修改意见】\n${edit[2].trim()}`;
      let finalText = "";
      try {
        finalText = await llmChat(sys, usr);
      } catch {
        await reply(msg.chat_id, "改的时候出错了，稍后再试。");
        return;
      }
      if (!finalText) {
        await reply(msg.chat_id, "没生成出内容，换个说法再试。");
        return;
      }
      appendLearned(finalText);
      clearPending();
      await reply(msg.chat_id, `✅ 已按你的修改入库：\n\n${finalText}`);
      return;
    }

    // 手动教一条：记住：<你自己写的内容>
    const mem = tt.match(/^(记住|学一下|记一下|加知识)[:：]\s*([\s\S]+)/);
    if (mem && mem[2].trim()) {
      appendLearned(mem[2].trim());
      await reply(msg.chat_id, "✅ 记住了，已进学习库，机器人 1 分钟内用上。");
      return;
    }
  }

  // —— todo / 日报 监督：命中口令就直接处理，不走问答 ——
  try {
    const todoRes = handleTodo({
      text,
      mentions: msg.mentions || [],
      senderName,
      senderOpenId: senderId,
      botName: BOT_NAME,
    });
    if (todoRes && todoRes.reply) {
      await reply(msg.chat_id, todoRes.reply);
      return;
    }
  } catch (e) {
    console.error("todo error:", e);
  }

  const key = ctxKey(msg.chat_id, senderId);
  try {
    const a = await answer(text, getPrior(key), senderName, tl);
    await reply(msg.chat_id, a || HANDOFF_HINT);
    pushTurn(key, text, a);
    logQA({ ts: Date.now(), chat_type: msg.chat_type, q: text, a });
  } catch (e) {
    console.error("answer error:", e);
    await reply(msg.chat_id, "（暂时答不了，稍后再试或找 TL）" + String(e).slice(0, 120));
  }
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    handleMessage(data).catch((e) => console.error(e));
  },
});

wsClient.start({ eventDispatcher });
const aiLabel =
  MODE === "relay" ? "中转 " + RELAY_MODEL : MODE === "claude" ? "Claude " + ANTHROPIC_MODEL : "Qwen " + QWEN_MODEL;
const docSrc =
  FEISHU_WIKI_SPACE_ID || FEISHU_DOC_TOKENS ? "飞书文档(实时)+knowledge.md" : "knowledge.md";
console.log(`feishu-bot 已启动（长连接模式）domain=${FEISHU_DOMAIN} AI=${aiLabel} 知识库=${docSrc}`);

// Tiny health server so PaaS hosts (Railway/Render) see an open port and keep
// the service alive. The bot itself uses an outbound long connection.
http.createServer((_req, res) => res.end("ok")).listen(process.env.PORT || 3000);
