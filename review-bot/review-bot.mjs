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

// 旗下多个 AI App，红人视频可能推广其中任意一个；每个产品的"效果"(画面该展示的成品)不同。
// 审稿时先认出是哪个产品，再按对应"效果"判。加新产品就往这个列表里加一行；也可用 .env 的 PRODUCT_INFO 覆盖。
const PRODUCT_INFO =
  process.env.PRODUCT_INFO ||
  [
    "我们旗下有多个 AI App，这条红人视频可能在推广其中某一个。各产品及其“产品效果”（画面里应展示的成品）如下：",
    "· VivaVideo：AI 剪辑工具（AI 视觉功能大集合：AI 玩法模板、文生图、文生视频、数字人等）。效果=展示这些 AI 功能做出的成品画面。",
    "· AICatch：AI 玩法模板（各种 AI 图片/视频模板）。效果=用模板生成的 AI 图片/视频成品。",
    "· Rythmix：AI 音乐（AI 歌曲、AI 音乐视频）。效果=生成的 AI 歌曲在播放 / AI 音乐视频成品。",
    "· Wisemeal：AI 卡路里。效果=画面在计算食物卡路里、并给出饮食建议。",
    "· Rymo：AI 音乐视频。效果=生成的 AI 音乐视频成品。",
    "· Recco：AI 笔记（类似 AI 聊天）。效果=展示 AI 生成的文字回答/笔记。",
    "· Inspo：集合 AICatch、Rythmix、VivaVideo 的产品。效果=上述任一类 AI 成品。",
  ].join("\n");

// 是否开启"把修改意见润色成发给红人的话"功能。.env 里设 FEEDBACK_POLISH=off 可关掉，只保留视频翻译。
const POLISH_ON = String(process.env.FEEDBACK_POLISH ?? "on").toLowerCase() !== "off";
// 是否开启"AI 自动审稿清单"（翻译后再发一条清单）。.env 里设 REVIEW_CHECKLIST=off 可关掉，只发翻译。
const CHECKLIST_ON = String(process.env.REVIEW_CHECKLIST ?? "on").toLowerCase() !== "off";
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
// 记住每个话题里视频的语言（whisper 识别的），润色反馈时用红人的语言输出
const threadVideoLang = new Map(); // threadKey -> language string，如 "german"/"spanish"
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
// 拿某条消息的详情（用来读"被回复的那条"里的视频）
async function getMessage(messageId) {
  const token = await tenantToken();
  const res = await fetch(`${OPEN_BASE}/open-apis/im/v1/messages/${messageId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const j = await res.json();
  const item = j?.data?.items?.[0];
  if (!item) throw new Error(`取消息失败 ${res.status}: ` + JSON.stringify(j).slice(0, 120));
  return item; // { message_id, msg_type, body:{content}, sender:{id,id_type} }
}
// 列出某个话题(thread)里的消息（按时间升序），用来找话题里最近的一条视频
async function listThreadMessages(threadId) {
  const token = await tenantToken();
  const url =
    `${OPEN_BASE}/open-apis/im/v1/messages?container_id_type=thread` +
    `&container_id=${encodeURIComponent(threadId)}&sort_type=ByCreateTimeAsc&page_size=50`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const j = await res.json();
  if (!res.ok) throw new Error(`列话题消息失败 ${res.status}: ` + JSON.stringify(j).slice(0, 120));
  return j?.data?.items || [];
}
// 列出群(chat)里最近的消息（按时间倒序），用来在平铺群里找最近一条视频
async function listChatMessages(chatId) {
  const token = await tenantToken();
  const url =
    `${OPEN_BASE}/open-apis/im/v1/messages?container_id_type=chat` +
    `&container_id=${encodeURIComponent(chatId)}&sort_type=ByCreateTimeDesc&page_size=20`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const j = await res.json();
  if (!res.ok) throw new Error(`列群消息失败 ${res.status}: ` + JSON.stringify(j).slice(0, 120));
  return j?.data?.items || [];
}
// 找"这次 @ 想翻译的视频"：① 被回复的那条 → ② 话题里最近的视频 → ③ 话题根 → ④ 平铺群里最近的视频
async function findRecentVideoMessage(msg) {
  console.log(
    `[find] parent=${msg.parent_id || "-"} thread=${msg.thread_id || "-"} root=${msg.root_id || "-"} chat=${msg.chat_id || "-"}`
  );
  if (msg.parent_id) {
    const p = await getMessage(msg.parent_id).catch((e) => {
      console.log("[find] parent 取失败:", String(e.message || e).slice(0, 100));
      return null;
    });
    if (p && fileKeyFromMessage(p.msg_type, p.body?.content)) return console.log("[find] 命中 parent"), p;
  }
  if (msg.thread_id) {
    const items = await listThreadMessages(msg.thread_id).catch((e) => {
      console.log("[find] thread 列表失败:", String(e.message || e).slice(0, 100));
      return [];
    });
    console.log(`[find] thread 列到 ${items.length} 条`);
    const vids = items.filter((m) => m.message_id !== msg.message_id && fileKeyFromMessage(m.msg_type, m.body?.content));
    if (vids.length) return console.log("[find] 命中 thread 视频"), vids[vids.length - 1];
  }
  if (msg.root_id) {
    const r = await getMessage(msg.root_id).catch((e) => {
      console.log("[find] root 取失败:", String(e.message || e).slice(0, 100));
      return null;
    });
    if (r && fileKeyFromMessage(r.msg_type, r.body?.content)) return console.log("[find] 命中 root"), r;
  }
  // 平铺群：视频和 @ 是两条独立消息，靠翻最近群消息找最近一条视频（限 @ 之前、30 分钟内）
  if (msg.chat_id) {
    const items = await listChatMessages(msg.chat_id).catch((e) => {
      console.log("[find] chat 列表失败:", String(e.message || e).slice(0, 100));
      return [];
    });
    console.log(`[find] chat 列到 ${items.length} 条`);
    const atTime = Number(msg.create_time) || 0;
    for (const m of items) {
      if (m.message_id === msg.message_id) continue;
      if (!fileKeyFromMessage(m.msg_type, m.body?.content)) continue;
      const t = Number(m.create_time) || 0;
      if (atTime && t && atTime - t > 30 * 60 * 1000) break; // 太久以前的不认，避免抓错
      return console.log("[find] 命中 chat 视频"), m;
    }
  }
  console.log("[find] 没找到视频");
  return null;
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
async function polishFeedback(rough, lang) {
  const target = lang ? `红人的语言（${lang}）` : "英文";
  const sys =
    "你帮 KOL 运营，把审稿同学写的粗略修改意见，整理成【可以直接复制发给红人】的一段话。要求：\n" +
    `1) 用${target}输出（信息不足以判断语言时用英文）；语气礼貌、专业、清晰；\n` +
    "2) 准确理解同学的真实意图，只传达 TA 真正想说的，不要臆造新的修改点；\n" +
    "3) 带 [x:xx-x:xx] 时间戳的内容是【对视频某个片段的指代】，当作『在这个时间点…』来引用，不要把每条时间戳都当成一条新要求；\n" +
    "4) 不要见换行就拆成新的一点——属于同一件事的话要合并；以同学的原意分点，别硬拆；\n" +
    "5) 如果同学贴了红人的原话/台词做参考，理解它是背景、别当成要红人改的指令；\n" +
    "6) 只输出可直接发送的正文，不要解释、不要加引号、不要附中文原文。";
  return llmChat(sys, rough);
}
// 带图片的 LLM 调用（gpt-4o-mini 多模态）：把若干帧当图片一起喂进去
async function llmVision(system, textUser, frames, maxTokens = 800) {
  const content = [{ type: "text", text: textUser }];
  for (const f of frames) content.push({ type: "image_url", image_url: { url: f.dataUrl, detail: "low" } });
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
        { role: "user", content },
      ],
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 160);
    if (res.status === 429) throw new RateLimitError(`视觉限流 429: ${body}`);
    throw new Error(`视觉 ${res.status}: ${body}`);
  }
  const j = await res.json();
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

// 用 ffprobe 读视频时长（秒）
function videoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
    ]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => (code === 0 ? resolve(parseFloat(out.trim()) || 0) : reject(new Error(err.slice(-120)))));
  });
}

// ffmpeg 抽帧：每秒 1 帧、缩到 512 宽；再"开头密后面疏"地挑，最多 30 张
function extractFrames(videoPath, outDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    const p = spawn("ffmpeg", ["-y", "-i", videoPath, "-vf", "fps=1,scale=512:-2", path.join(outDir, "f_%03d.jpg")]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error("ffmpeg 抽帧失败? " + e.message)));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error("抽帧失败: " + err.slice(-160)));
      const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".jpg")).sort();
      // 前 15 秒每帧都留，之后隔一帧取一张（约每 2 秒），最后封顶 30 张
      const picked = files.filter((_, i) => i < 15 || (i - 15) % 2 === 0).slice(0, 30);
      const frames = picked.map((f) => {
        const idx = parseInt((f.match(/(\d+)/) || [0, "1"])[1], 10); // f_001 = 第 1 帧
        const b64 = fs.readFileSync(path.join(outDir, f)).toString("base64");
        return { t: idx - 1, dataUrl: `data:image/jpeg;base64,${b64}` }; // t≈第几秒
      });
      resolve(frames);
    });
  });
}

// 审稿清单：看画面帧 + 口播译文，按 KOL 基础 SOP 逐项检查（内部参考，中文）
async function reviewChecklist(zhTranscript, frames, durationSec) {
  const times = frames.map((f) => `${f.t}s`).join("、");
  const sys =
    "你是 KOL 短视频审稿助手。" + PRODUCT_INFO + "\n" +
    "先从画面（logo / App 名 / 内容）判断这条视频推广的是上面哪个产品，第 5、6 项按【该产品】的效果来审；" +
    "若认不出是哪个产品，就写『不确定是哪个产品，请自行判断』，别硬套。\n" +
    "下面给你一条红人视频的【口播中文译文】和【按时间抽取的画面帧】。" +
    "严格按下面清单逐项检查，每项给 ✅ 通过 或 ⚠️ 需注意 + 一句简短说明（能指到第几秒就指）。" +
    "只看这些基础项，不要评价运镜/转场/剪辑节奏/打光/审美：\n" +
    `1) 时长：是否 ≤60 秒（本视频约 ${Math.round(durationSec)} 秒）；\n` +
    "2) Logo：画面里有没有品牌 logo？大小是否合适（别太小看不清，也别大到喧宾夺主）？大概第几秒出现；\n" +
    "3) 标题字幕：画面里有没有标题文字？把标题原文读出来、翻成中文，再简短点评（有没有点明卖点、够不够吸引人）；若没标题就标 ⚠️ 提示加标题；\n" +
    "4) App 录屏操作：有没有 app 内操作的录屏画面？是否清晰、看得懂在操作什么（结合口播判断）；\n" +
    "5) 产品效果展示：按标准，开头和结尾最好【各有一次】产品效果露出——分别检查开头、结尾有没有，各在大概第几秒；缺哪头就明确指出。" +
    "若你无法确定这个产品的『最终效果』具体长什么样，不要硬猜，直接写：『我不确定最终效果是什么，请自行判断』；\n" +
    "6) 开头/Hook：从视频开头，到『产品名 / logo / 产品效果 这三者里最早出现的那一个』为止算开头，是否太长（越短越好）？指出最早出现的是哪一样、在第几秒（效果先出现也算，不一定非要产品名）；\n" +
    "7) 口播：有没有口播、讲解是否清楚；\n" +
    "某项若从画面/口播无法判断，就写『无法判断』。\n" +
    `画面帧依次对应时间点：${times}。\n` +
    "用中文、简洁，每项一行；只输出清单本身，不要开场白、不要结尾总结。";
  const user = "【口播中文译文】\n" + (zhTranscript || "（无口播 / 未识别到语音）");
  return llmVision(sys, user, frames, 800);
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
// 从一条消息（media/video/post）里找视频 file_key；contentStr 是飞书的 content 字符串
function fileKeyFromMessage(msgType, contentStr) {
  let c = {};
  try {
    c = JSON.parse(contentStr || "{}");
  } catch {}
  if (msgType === "media" || msgType === "video") return c.file_key || c.image_key || null;
  if (msgType === "post") return findMediaInPost(c);
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
    `[msg] type=${msg.message_type} chat=${msg.chat_type} mentions=${(msg.mentions || []).length}` +
      ` thread=${msg.thread_id || "-"} root=${msg.root_id || "-"} parent=${msg.parent_id || "-"} content=${(msg.content || "").slice(0, 80)}`
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

  // 当前消息里的纯文字（去掉 @ 占位）——用来判断是"意见"还是"只是 @了一下"
  let text = "";
  if (msg.message_type === "text") text = (content.text || "").replace(/@_user_\d+/g, " ").trim();
  else if (msg.message_type === "post") text = textFromPost(content);

  // 找视频文件：直接 media/video 类型，或藏在 post 富文本里
  let fileKey = fileKeyFromMessage(msg.message_type, msg.content);
  let mediaMsgId = msg.message_id; // 视频所在消息的 id（下载资源要用它）
  let videoSenderOpenId = senderOpenId; // 默认记发 @ 的人

  // 当前消息没视频、也没写意见（只是 @了一下）→ 去"被回复的那条 / 话题里最近的视频 / 话题根"里找视频
  // 兼容两种用法：① 回复视频再 @；② 话题里没有"回复"选项，只能视频后面另发一条 @机器人
  if (!fileKey && !text) {
    try {
      const src = await findRecentVideoMessage(msg);
      if (src) {
        fileKey = fileKeyFromMessage(src.msg_type, src.body?.content);
        mediaMsgId = src.message_id;
        if (src.sender?.id_type === "open_id" && src.sender?.id) videoSenderOpenId = src.sender.id;
      }
    } catch (e) {
      console.error("找话题里的视频失败:", String(e.message || e).slice(0, 140));
    }
  }

  // 视频 → 转写 + 翻译，并记住这个话题里"发视频的同学"
  if (fileKey) {
    if (videoSenderOpenId) threadVideoSender.set(tkey, { openId: videoSenderOpenId, ts: Date.now() });
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
      const frameDir = path.join(os.tmpdir(), msg.message_id + "_frames");
      try {
        await downloadMedia(mediaMsgId, fileKey, vid);
        await extractAudio(vid, aud);
        const tr = await withRetry(() => transcribe(aud), { label: "whisper" });
        const segs = tr.segments || [];
        if (tr.language) threadVideoLang.set(tkey, tr.language); // 记住红人语言，润色反馈时用

        // 第 1 条：先发翻译（快），让审稿同学马上能看
        let zh = "";
        if (segs.length) {
          zh = await withRetry(() => translateSegments(segs), { label: "翻译" });
          await replyTo(msg.message_id, `📝 视频翻译（语言：${tr.language || "?"}）\n\n${zh}`);
        } else {
          await replyTo(msg.message_id, "这条视频没听出语音（可能是纯音乐/无人声），仅做画面审稿。");
        }

        // 第 2 条：审稿清单（看画面帧+口播，较慢；best-effort）。可用 .env 的 REVIEW_CHECKLIST=off 关掉
        if (CHECKLIST_ON) {
          try {
            const dur = await videoDuration(vid).catch(() => 0);
            const frames = await extractFrames(vid, frameDir);
            if (frames.length) {
              const cl = await withRetry(() => reviewChecklist(zh, frames, dur), { label: "审稿" });
              if (cl) await replyTo(msg.message_id, `🔍 AI 自动审稿清单（⚠️ AI 生成、仅供参考，以 TL 为准）\n${cl.trim()}`);
            }
          } catch (e) {
            console.error("checklist error:", String(e.message || e).slice(0, 140));
          }
        }
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
        fs.rm(frameDir, { recursive: true, force: true }, () => {});
      }
    });
    return;
  }

  // 反馈润色（可用 .env 的 FEEDBACK_POLISH=off 关掉；关掉后只做视频翻译）
  if (!POLISH_ON) {
    if (!text)
      await replyTo(msg.message_id, "没找到要翻译的视频～把视频和 @我 发在同一条，或在同一个话题里 @我。");
    return; // 已关闭反馈润色：即使写了意见也不处理
  }

  // 文字（text 或 post 里的纯文字）= 修改意见 → 润色 + @回发视频的同学
  if (!text) {
    // @了机器人，但既没视频、也没写意见、话题里也没找到视频 → 给个提示，别闷不吭声
    await replyTo(
      msg.message_id,
      "没找到要翻译的视频～可以：① 把视频和 @我 发在同一条；② 回复那条视频再 @我；③ 或在同一个话题里 @我。给红人的修改意见也可以直接 @我 打出来。"
    );
    return;
  }
  try {
    const out = await withRetry(() => polishFeedback(text, threadVideoLang.get(tkey)), { label: "润色" });
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
