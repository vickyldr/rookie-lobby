// todo / 日报 监督 v1（口令式，可靠优先）。
// 识别靠"开头口令词 + 飞书 @ 的人"，不靠 AI 猜，命中就处理、不命中就交回问答。
//
// 口令（在群里 @机器人 时用）：
//   派单 @某人 任务内容        → 记一条任务（可同时 @多人）
//   完成 #3                     → 把 #3 标记完成
//   未完成todo / 我的todo       → 看任务清单
//   日报 今天做了…             → 交今天的日报
//   谁没交日报                  → 按 interns.txt 花名册算今天谁还没交
//
// 数据存 tasks.json；花名册放 interns.txt（每行一个名字）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dirname, "tasks.json");
const ROSTER = path.join(__dirname, "interns.txt");

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return { nextId: 1, todos: [], reports: [] };
  }
}
function save(d) {
  try {
    fs.writeFileSync(STORE, JSON.stringify(d, null, 2));
  } catch {}
}
function roster() {
  try {
    return fs
      .readFileSync(ROSTER, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  } catch {
    return [];
  }
}
function today() {
  return new Date().toLocaleDateString("zh-CN");
}

// ctx: { text, mentions:[{name,id:{open_id}}], senderName, senderOpenId, botName }
// 返回 { reply } = 已作为 todo/日报 处理；返回 null = 交回问答。
export function handleTodo(ctx) {
  const text = (ctx.text || "").trim();
  const others = (ctx.mentions || []).filter((m) => (m.name || "") !== ctx.botName);
  const me = ctx.senderName || "某同学";

  // —— 交日报：以「日报」开头 ——
  if (/^日报([\s:：]|$)/.test(text)) {
    const d = load();
    d.reports.push({
      name: me,
      openId: ctx.senderOpenId,
      date: today(),
      ts: Date.now(),
      content: text.replace(/^日报[\s:：]*/, "").slice(0, 800),
    });
    save(d);
    const names = roster();
    const reported = new Set(d.reports.filter((r) => r.date === today()).map((r) => r.name));
    const missing = names.filter((n) => !reported.has(n));
    const tail = names.length
      ? `\n今天还没交的：${missing.length ? missing.join("、") : "无，全交齐了 🎉"}`
      : "";
    return { reply: `📝 收到 ${me} 今天的日报 ✅${tail}` };
  }

  // —— 查谁没交日报 ——
  if (/谁.*(没|未|还没).*日报|日报.*(谁没|没交|未交)/.test(text)) {
    const names = roster();
    if (!names.length)
      return { reply: "还没设花名册：在服务器建 interns.txt（每行一个实习生名字），我才能算谁没交。" };
    const d = load();
    const reported = new Set(d.reports.filter((r) => r.date === today()).map((r) => r.name));
    const missing = names.filter((n) => !reported.has(n));
    return {
      reply: missing.length ? `今天还没交日报的：${missing.join("、")}` : "今天花名册上的人都交日报了 🎉",
    };
  }

  // —— 标记完成：完成 #3 ——
  const m = text.match(/^(完成|做完|搞定|done)\s*#?\s*(\d+)/i);
  if (m) {
    const id = Number(m[2]);
    const d = load();
    const todo = d.todos.find((x) => x.id === id);
    if (!todo) return { reply: `没找到 #${id}。发「未完成todo」看看现有任务。` };
    todo.status = "done";
    todo.doneTs = Date.now();
    todo.doneBy = me;
    save(d);
    return { reply: `✅ #${id} 已完成：${todo.task}` };
  }

  // —— 看清单：未完成todo / 我的todo / 任务列表 ——
  if (/^(未完成|待办|我的|全部|所有)?\s*(todo|任务)(列表|清单)?$/i.test(text)) {
    const d = load();
    let list = d.todos.filter((x) => x.status !== "done");
    if (/我的/.test(text))
      list = list.filter((x) => x.assigneeOpenId === ctx.senderOpenId || x.assigneeName === me);
    if (!list.length) return { reply: "当前没有未完成的任务 🎉" };
    return {
      reply: "未完成任务：\n" + list.map((x) => `#${x.id} @${x.assigneeName}：${x.task}`).join("\n"),
    };
  }

  // —— 派单：派单 @某人 任务内容（可同时 @多人）——
  if (/^(派单|布置|安排|分配)/.test(text) && others.length) {
    const task = text
      .replace(/^(派单|布置|安排|分配)[:：]?/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!task) return { reply: "派单要带任务内容，例如：派单 @张三 整理10个红人名单" };
    const d = load();
    const created = [];
    for (const a of others) {
      const id = d.nextId++;
      d.todos.push({
        id,
        assigneeName: a.name || "某人",
        assigneeOpenId: a.id?.open_id,
        assigner: me,
        task,
        ts: Date.now(),
        status: "pending",
      });
      created.push(`#${id} @${a.name}`);
    }
    save(d);
    return { reply: `📌 已派单：${created.join("、")}\n内容：${task}\n完成后发「完成 #编号」。` };
  }

  return null; // 不是 todo/日报，交回问答
}
