// 审稿/翻译机器人（长连接）。和答疑bot(server.js)完全独立，用另一个飞书应用。
//   @它发【视频】 → 下载→抽音频(ffmpeg)→whisper转写(带时间戳)→Claude翻中文 → 回"[0:00–0:05] …"
//   @它发【文字】(粗略修改意见) → 回一段可直接发给红人的润色文字
//
// 需要：① 一个新的飞书自建应用(给它当身份)  ② VPS 装 ffmpeg  ③ 中转开通 whisper-1
// 跑法：cd review-bot && npm install && cp .env.example .env（填好）&& pm2 start review-bot.mjs --name review-bot
import "dotenv/config";
import * as Lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const {
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_DOMAIN = "feishu",
  RELAY_URL, // 复用答疑bot那套中转：https://你的中转/v1/chat/completions
  RELAY_KEY,
  RELAY_MODEL = "claude-sonnet-4-6",
  WHISPER_MODEL = "whisper-1",
  WHISPER_URL, // 不填就自动从 RELAY_URL 推出 /v1/audio/transcriptions
  TARGET_LANG = "中文", // 视频翻译成什么语言
} = process.env;

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !RELAY_URL || !RELAY_KEY) {
  console.error("缺少环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET / RELAY_URL / RELAY_KEY");
  process.exit(1);
}

const OPEN_BASE = FEISHU_DOMAIN === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
const TRANSCRIBE_URL = WHISPER_URL || RELAY_URL.replace(/\/chat\/completions.*$/, "/audio/transcriptions");
const domain = FEISHU_DOMAIN === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
const client = new Lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, domain });
const wsClient = new Lark.WSClient({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, domain });

async function reply(chatId, text) {
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
  });
}

// 回复到"那条消息"上（普通引用回复）：平铺群不会硬开话题；话题群里回复也自然留在话题里
async function replyTo(messageId, text) {
  await client.im.message.reply({
    path: { message_id: messageId },
    data: { msg_type: "text", content: JSON.stringify({ text }) },
  });
}

// 记住每个话题里"最初发视频的同学"，TL 给意见时好 @ 回他
const threadVideoSender = new Map(); // threadKey -> { openId, ts }
const threadKeyOf = (msg) => msg.thread_id || msg.root_id || msg.parent_id || msg.chat_id;

// ---- 通用 LLM（中转，OpenAI 兼容）----
async function llmChat(system, user, maxTokens = 1500) {
  const res = await fetch(RELAY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${RELAY_KEY}` },
    body: JSON.stringify({
      model: RELAY_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`中转 ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

// ---- 飞书：拿 tenant token、下载消息里的视频文件 ----
let _tok = { v: "", exp: 0 };
async function tenantToken() {
  if (_tok.v && Date.now() < _tok.exp) return _tok.v;
  const res = await fetch(`${OPEN_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const j = await res.json();
  if (!j.tenant_access_token) throw new Error("tenant_access_token 失败: " + JSON.stringify(j).slice(0, 120));
  _tok = { v: j.tenant_access_token, exp: Date.now() + Math.max(60, (j.expire || 7200) - 60) * 1000 };
  return _tok.v;
}
async function downloadMedia(messageId, fileKey, destPath) {
  const token = await tenantToken();
  const url = `${OPEN_BASE}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`下载视频失败 ${res.status}: ${(await res.text()).slice(0, 120)}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

// ---- ffmpeg 抽音频（16k 单声道 wav，whisper 最爱）----
function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ar", "16000", "-ac", "1", audioPath]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error("ffmpeg 没装? " + e.message)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg 失败: " + err.slice(-200)))));
  });
}

// ---- whisper 转写（带时间戳）----
async function transcribe(audioPath) {
  const fd = new FormData();
  fd.append("model", WHISPER_MODEL);
  fd.append("response_format", "verbose_json");
  fd.append("file", new Blob([fs.readFileSync(audioPath)]), "audio.wav");
  const res = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${RELAY_KEY}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json(); // { text, language, segments:[{start,end,text}] }
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
async function translateSegments(segments) {
  const src = segments.map((s) => `[${fmt(s.start)}-${fmt(s.end)}] ${(s.text || "").trim()}`).join("\n");
  const sys =
    `你是资深视频字幕译者。下面是一条红人视频的原文（带时间戳分段）。请翻译成自然、通顺、完整的${TARGET_LANG}：\n` +
    "1) 保留每段开头的时间戳 [x:xx-x:xx]；\n" +
    "2) 结合整体上下文来翻，每段要地道流畅、符合中文表达习惯，把话说完整——不要生硬直译、不要刻意精简或省略语气；\n" +
    "3) 让整段读起来连贯自然，像人写的字幕，而不是一条条干巴巴的直译；\n" +
    "4) 只输出带时间戳的译文，不要额外解释。";
  return llmChat(sys, src, 2000);
}
async function polishFeedback(rough) {
  const sys =
    "你帮 KOL 运营，把给红人的粗略修改意见润色成【可以直接复制发给海外红人】的一段话：" +
    "礼貌、专业、清晰，能分点就分点，默认用英文（若意见里明显指定了别的语言就用那个）。" +
    "只输出可直接发送的正文，不要解释、不要加引号。";
  return llmChat(sys, rough);
}

// ---- de-dupe ----
const seen = new Set();
const once = (id) => {
  if (!id || seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 5000) seen.clear();
  return true;
};

// 飞书常把视频当 post(富文本)发，文件藏在 content.content 里的 {tag:"media",file_key}
function findMediaInPost(content) {
  try {
    for (const row of content.content || []) {
      for (const el of row) {
        if (el && (el.tag === "media" || el.tag === "video") && (el.file_key || el.image_key)) {
          return el.file_key || el.image_key;
        }
      }
    }
  } catch {}
  return null;
}
// 从 post 里抽纯文字（当反馈意见用）
function textFromPost(content) {
  const out = [];
  try {
    if (content.title) out.push(content.title);
    for (const row of content.content || []) {
      for (const el of row) {
        if (el && (el.tag === "text" || el.tag === "a") && el.text) out.push(el.text);
      }
    }
  } catch {}
  return out.join(" ").replace(/@_user_\d+/g, " ").trim();
}

async function handleMessage(data) {
  const msg = data?.message;
  if (!msg || !once(msg.message_id)) return;
  console.log(
    `[msg] type=${msg.message_type} chat=${msg.chat_type} mentions=${(msg.mentions || []).length} content=${(msg.content || "").slice(0, 120)}`
  );
  // 群里只在被 @ 时响应；私聊直接响应
  const mentioned = Array.isArray(msg.mentions) && msg.mentions.length > 0;
  if (msg.chat_type === "group" && !mentioned) return;
  const senderOpenId = data.sender?.sender_id?.open_id;
  const tkey = threadKeyOf(msg);

  let content = {};
  try {
    content = JSON.parse(msg.content || "{}");
  } catch {}

  // 找视频文件：直接 media/video 类型，或藏在 post 富文本里
  let fileKey = null;
  if (msg.message_type === "media" || msg.message_type === "video") {
    fileKey = content.file_key || content.image_key;
  } else if (msg.message_type === "post") {
    fileKey = findMediaInPost(content);
  }

  // 视频 → 转写 + 翻译，并记住这个话题里"发视频的同学"
  if (fileKey) {
    if (senderOpenId) threadVideoSender.set(tkey, { openId: senderOpenId, ts: Date.now() });
    await replyTo(msg.message_id, "🎬 收到视频，正在转写+翻译，请稍等（视频越长越久）…");
    const vid = path.join(os.tmpdir(), msg.message_id + ".mp4");
    const aud = path.join(os.tmpdir(), msg.message_id + ".wav");
    try {
      await downloadMedia(msg.message_id, fileKey, vid);
      await extractAudio(vid, aud);
      const tr = await transcribe(aud);
      const segs = tr.segments || [];
      if (!segs.length) {
        await replyTo(msg.message_id, "这条视频没听出语音（可能是纯音乐/无人声）。");
        return;
      }
      const zh = await translateSegments(segs);
      await replyTo(msg.message_id, `📝 视频翻译（语言：${tr.language || "?"}）\n\n${zh}`);
    } catch (e) {
      console.error("video error:", e);
      await replyTo(msg.message_id, "处理视频出错了：" + String(e.message || e).slice(0, 160));
    } finally {
      fs.unlink(vid, () => {});
      fs.unlink(aud, () => {});
    }
    return;
  }

  // 文字（text 或 post 里的纯文字）= 修改意见 → 润色 + @回发视频的同学
  let text = "";
  if (msg.message_type === "text") {
    text = (content.text || "").replace(/@_user_\d+/g, " ").trim();
  } else if (msg.message_type === "post") {
    text = textFromPost(content);
  }
  if (!text) return;
  try {
    const out = await polishFeedback(text);
    const target = threadVideoSender.get(tkey); // 这个话题里发视频的人
    const at = target && target.openId ? `<at user_id="${target.openId}"></at> ` : "";
    await replyTo(msg.message_id, `${at}✍️ 可直接发给红人：\n\n${out}`);
  } catch (e) {
    console.error("polish error:", e);
    await replyTo(msg.message_id, "润色出错了，稍后再试。");
  }
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    handleMessage(data).catch((e) => console.error(e));
  },
});

wsClient.start({ eventDispatcher });
console.log(
  `review-bot 已启动（长连接）domain=${FEISHU_DOMAIN} 翻译模型=${WHISPER_MODEL}+${RELAY_MODEL} 转写接口=${TRANSCRIBE_URL}`
);
http.createServer((_req, res) => res.end("ok")).listen(process.env.PORT || 3100);
