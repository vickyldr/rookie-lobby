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
} = process.env;

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
let KNOWLEDGE = "";
let SYNCED = "";
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
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---- the brain: answer grounded in the knowledge base ----
async function answer(question) {
  const system = [
    "你是 KOL 商务团队的入职/答疑助理机器人。",
    "只根据下面【团队知识库】回答新人的问题（付款 SOP、合同修改 SOP、合同助手工具用法、入职流程）。",
    "规则：1) 答案简短、可执行、分点，用中文；2) 知识库没覆盖的，明确说『这个我不确定，建议找 TL 确认』，绝不编造；3) 涉及金额/币种/合规/能不能改条款，提醒以 TL 最终确认为准。",
    "",
    "【团队知识库】",
    knowledgeText(),
  ].join("\n");
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
        messages: [{ role: "user", content: question }],
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
  try {
    const a = await answer(text);
    await reply(msg.chat_id, a || HANDOFF_HINT);
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
