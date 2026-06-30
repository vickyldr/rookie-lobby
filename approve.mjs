// 自学习·第 2 步：把你审核过的 knowledge.pending.md 入库到 knowledge.learned.md。
// 流程：digest.mjs 生成草稿 → 你打开 knowledge.pending.md 删掉不对的、留下好的 → node approve.mjs。
// 机器人会把 knowledge.learned.md 当成知识库的一部分（1 分钟内自动加载）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PENDING = path.join(__dirname, "knowledge.pending.md");
const LEARNED = path.join(__dirname, "knowledge.learned.md");

let pending = "";
try {
  pending = fs.readFileSync(PENDING, "utf8").trim();
} catch {
  console.log("没有 knowledge.pending.md，没什么可入库的。先跑 node digest.mjs。");
  process.exit(0);
}
if (!pending) {
  console.log("待审文件是空的（你可能已经全删了）。没有入库内容。");
  process.exit(0);
}

const header =
  "# 沉淀知识（人工审核后入库）\n\n" +
  "> 由 digest.mjs 生成草稿、你 approve 后写到这里。机器人把这里当知识库的一部分。\n";
if (!fs.existsSync(LEARNED)) fs.writeFileSync(LEARNED, header);

fs.appendFileSync(LEARNED, "\n" + pending + "\n");
fs.writeFileSync(PENDING, ""); // 清空待审，避免重复入库
console.log(`已入库 → ${LEARNED}\n已清空待审。机器人 1 分钟内自动加载新知识。`);
