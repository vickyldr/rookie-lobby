// 自学习·第 1 步：每天把机器人最近的问答提炼成「待沉淀知识」草稿，写进 knowledge.pending.md。
// 你审核（删掉不对的、留下好的）后，运行 approve.mjs 才真正入库——机器人不会自动学没审过的东西。
//
// 跑法（建议每天定时一次）：
//   node digest.mjs
//   或 pm2：pm2 start digest.mjs --name rookie-digest --cron "0 21 * * *" --no-autorestart
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, "qa-log.jsonl");
const PENDING = path.join(__dirname, "knowledge.pending.md");
const { RELAY_URL, RELAY_KEY, RELAY_MODEL = "claude-sonnet-4-6" } = process.env;
const WINDOW_H = Math.max(1, Number(process.env.DIGEST_WINDOW_HOURS) || 24);

if (!RELAY_URL || !RELAY_KEY) {
  console.error("digest 需要 .env 里的 RELAY_URL + RELAY_KEY。");
  process.exit(1);
}

let lines = [];
try {
  lines = fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
} catch {
  console.log("还没有 qa-log.jsonl（没人问过机器人），今天没东西可提炼。");
  process.exit(0);
}

const since = Date.now() - WINDOW_H * 3600 * 1000;
const recs = lines
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((r) => r && r.ts >= since && r.q);

if (!recs.length) {
  console.log(`最近 ${WINDOW_H}h 内没有问答记录。`);
  process.exit(0);
}

const transcript = recs.map((r, i) => `【${i + 1}】问：${r.q}\n答：${r.a || ""}`).join("\n\n");
const sys = [
  "你是知识库维护助手。下面是带教机器人最近收到的提问、它的回答、以及用户的纠正。",
  "请提炼出【值得沉淀进知识库】的新问答条目：",
  "1) 用户纠正过的（出现『错了 / 不对 / 应该是…』之类）——给出修正后的正确答案；",
  "2) 被反复问、且现有回答不够好或没覆盖的——给出简洁正确的标准答案。",
  "要求：每条用『Q：…』一行、『A：…』一行的格式，简短可执行，用中文；",
  "只输出你有把握、确实值得长期入库的；闲聊、一次性的、你拿不准对错的，一律丢弃；",
  "如果没有值得沉淀的，只回复两个字：无。",
].join("\n");

const res = await fetch(RELAY_URL, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${RELAY_KEY}` },
  body: JSON.stringify({
    model: RELAY_MODEL,
    max_tokens: 1500,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: transcript },
    ],
  }),
});
if (!res.ok) {
  console.error(`relay 出错 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
const j = await res.json();
const draft = (j.choices?.[0]?.message?.content ?? "").trim();
if (!draft || draft === "无") {
  console.log(`最近 ${WINDOW_H}h 共 ${recs.length} 条对话，没有值得沉淀的新知识。`);
  process.exit(0);
}

const stamp = new Date().toLocaleString();
fs.appendFileSync(
  PENDING,
  `\n\n## 待审（${stamp}，覆盖最近 ${WINDOW_H}h，共 ${recs.length} 条对话）\n${draft}\n`
);
console.log(
  `已生成待审草稿 → ${PENDING}\n` +
    `请打开它，把不对的删掉、留下好的，然后运行：node approve.mjs 入库。`
);
