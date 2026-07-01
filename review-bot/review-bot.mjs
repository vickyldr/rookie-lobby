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
// 注意：Azure 的 chat/whisper 是两个独立完整 URL，请直接配 WHISPER_URL，别靠推导
const TRANSCRIBE_URL = WHISPER_URL || RELAY_URL.replace(/\/chat\/completions.*$/, "/audio/transcriptions");
// Azure OpenAI 用 `api-key` 请求头（不是标准 OpenAI 的 Bearer），且模型名在 URL 里而非 body
const isAzure = (u) => /\.azure\.com/i.test(u || "");
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

// ---- 限流保护：串行队列 + 自动重试 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class RateLimitError extends Error {}
const isRateLimit = (e) =>
  e instanceof RateLimitError || /\b429\b|rate.?limit|too many|频率|限流|qps/i.test(String(e?.message || e));
const BUSY_MSG = "😥 同时使用的人太多啦，请等一分钟再 @我试一次~";

// 被中转限流(429)就自动等一会儿重试；等了几轮还不行就抛出，让上层回一句友好提示。
// 6s→12s→18s 共约 36s，配合"请等一分钟"的提示，正好覆盖一分钟的限流窗口。
async function withRetry(fn, { tries = 3, baseMs = 6000, label = "" } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isRateLimit(e) || i === tries - 1) throw e;
      const wait = baseMs * (i + 1); // 6s, 12s, 18s
      console.warn(`[retry] ${label} 触发限流，${wait / 1000}s 后重试 (${i + 1}/${tries})`);
      await sleep(wait);
    }
  }
  throw last;
}

// 串行队列：下载+转写+翻译这种重活一次只跑一个，天然把并发压到中转限流以内，也让排队有序。
let _chain = Promise.resolve();
let videoQueueLen = 0; // 还没处理完的视频条数（含正在处理的那条）
function enqueue(task) {
  const run = _chain.then(task, task); // 不管前一个成败都继续下一个
  _chain = run.catch(() => {});
  return run;
}

// ---- 通用 LLM（中转，OpenAI 兼容）----
async function llmChat(system, user, maxTokens = 1500) {
  const res = await fetch(RELAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(isAzure(RELAY_URL) ? { "api-key": RELAY_KEY } : { authorization: `Bearer ${RELAY_KEY}` }),
    },
    body: JSON.stringify({
      model: RELAY_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 160);
    if (res.status === 429) throw new RateLimitError(`中转限流 429: ${body}`);
    throw new Error(`中转 ${res.status}: ${body}`);
  }
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
  if (!isAzure(TRANSCRIBE_URL)) fd.append("model", WHISPER_MODEL); // Azure 的模型在 URL 里，body 里放会报错
  fd.append("response_format", "verbose_json");
  fd.append("file", new Blob([fs.readFileSync(audioPath)]), "audio.wav");
  const res = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: isAzure(TRANSCRIBE_URL) ? { "api-key": RELAY_KEY } : { authorization: `Bearer ${RELAY_KEY}` },
    body: fd,
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (res.status === 429) throw new RateLimitError(`whisper限流 429: ${body}`);
    throw new Error(`whisper ${res.status}: ${body}`);
  }
  return res.json(); // { text, language, segments:[{start,end,text}] }
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// whisper 会把语音切成 1 秒一段，逐段翻会很"机翻"。先把碎片合并成句子级大块：
// 遇到句末标点/明显停顿/块够长就断句——翻译更连贯，行数更少，也更快。
function mergeSegments(segments) {
  const endsSentence = (t) => /[.!?。！？…]["'”’)\]]?\s*$/.test(t);
  const blocks = [];
  for (const s of segments) {
    const text = (s.text || "").trim();
    if (!text) continue;
    const cur = blocks[blocks.length - 1];
    const gap = cur ? s.start - cur.end : Infinity;
    const tooLong = cur && (cur.text.length >= 80 || cur.end - cur.start >= 12);
    if (!cur || endsSentence(cur.text) || tooLong || gap > 1.0) {
      blocks.push({ start: s.start, end: s.end, text });
    } else {
      cur.text = `${cur.text} ${text}`.trim();
      cur.end = s.end;
    }
  }
  return blocks;
}

async function translateSegments(segments) {
  const blocks = mergeSegments(segments);
  const src = blocks.map((s) => `[${fmt(s.start)}-${fmt(s.end)}] ${s.text}`).join("\n");
  const sys =
    `你是资深视频译者，在帮 KOL 运营审稿。下面是一条红人视频的原文（可能是德语/英语等外语，带时间戳分段）。把它翻成地道、自然、口语化的${TARGET_LANG}：\n` +
    "1) 保留每段开头的时间戳 [x:xx-x:xx]，逐段对应输出；\n" +
    "2) 按中文的表达习惯来译——可以调整语序、补足省略、合并短句，让它读起来像中文母语者在说话，绝不要逐字直译、不要翻译腔；\n" +
    "3) 口语、广告词、网红用语要翻得自然接地气；\n" +
    "4) 只输出带时间戳的译文，每段一行，不要任何额外解释。";
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
    const ahead = videoQueueLen; // 前面还有几条在处理/排队
    videoQueueLen++;
    await replyTo(
      msg.message_id,
      ahead > 0
        ? `🎬 收到视频，前面还有 ${ahead} 条在处理，排队中，请稍等…`
        : "🎬 收到视频，正在转写+翻译，请稍等（视频越长越久）…"
    );
    // 进串行队列：一次只处理一条，既不会打爆中转限流，也让排队有先后
    enqueue(async () => {
      const vid = path.join(os.tmpdir(), msg.message_id + ".mp4");
      const aud = path.join(os.tmpdir(), msg.message_id + ".wav");
      try {
        await downloadMedia(msg.message_id, fileKey, vid);
        await extractAudio(vid, aud);
        const tr = await withRetry(() => transcribe(aud), { label: "whisper" });
        const segs = tr.segments || [];
        if (!segs.length) {
          await replyTo(msg.message_id, "这条视频没听出语音（可能是纯音乐/无人声）。");
          return;
        }
        const zh = await withRetry(() => translateSegments(segs), { label: "翻译" });
        await replyTo(msg.message_id, `📝 视频翻译（语言：${tr.language || "?"}）\n\n${zh}`);
      } catch (e) {
        console.error("video error:", e);
        await replyTo(
          msg.message_id,
          isRateLimit(e) ? BUSY_MSG : "处理视频出错了：" + String(e.message || e).slice(0, 160)
        );
      } finally {
        videoQueueLen--;
        fs.unlink(vid, () => {});
        fs.unlink(aud, () => {});
      }
    });
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
    const out = await withRetry(() => polishFeedback(text), { label: "润色" });
    const target = threadVideoSender.get(tkey); // 这个话题里发视频的人
    const at = target && target.openId ? `<at user_id="${target.openId}"></at> ` : "";
    await replyTo(msg.message_id, `${at}✍️ 可直接发给红人：\n\n${out}`);
  } catch (e) {
    console.error("polish error:", e);
    await replyTo(msg.message_id, isRateLimit(e) ? BUSY_MSG : "润色出错了，稍后再试。");
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
