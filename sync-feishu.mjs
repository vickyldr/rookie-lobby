// 把「公开可见的飞书文档」渲染出来、抓正文，写进 knowledge.feishu.md。
// 机器人(server.js)每分钟自动重载这个文件 —— 你在飞书改文档，几分钟后机器人就知道。
//
// 适用：文档设置为「互联网上获得链接的人可阅读」。这样不需要同组织 / 管理员 / 应用授权，
// 因为它就是一个公开网页，用无头浏览器读即可。
//
// 跑法：
//   npm install            # 装依赖（含 playwright）
//   npx playwright install chromium
//   PUBLIC_DOC_URLS="https://xxx.feishu.cn/docx/aaa,https://xxx.feishu.cn/wiki/bbb" node sync-feishu.mjs
// 或把 PUBLIC_DOC_URLS 写进 .env，用 pm2 常驻：pm2 start sync-feishu.mjs --name kol-sync
import "dotenv/config";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "knowledge.feishu.md");
const URLS = (process.env.PUBLIC_DOC_URLS || "")
  .split(/[\n,]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const EVERY = Math.max(60, Number(process.env.DOC_REFRESH_SECONDS) || 300) * 1000;

if (!URLS.length) {
  console.error("请设置 PUBLIC_DOC_URLS=公开文档链接（逗号或换行分隔）。");
  process.exit(1);
}

async function extractOne(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(2500); // 等富文本渲染完
    const text = await page.evaluate(() => {
      // 飞书文档正文容器在不同版本类名不同；命中就用，否则兜底整页可见文字。
      const sels = [
        ".bear-web-x-container",
        ".docx-page-block-children",
        ".note-editor",
        ".doc-render",
        "#mainContent",
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.innerText.trim().length > 50) return el.innerText;
      }
      return document.body.innerText;
    });
    const title = (await page.title()) || url;
    return `# ${title}\n${(text || "").trim()}`;
  } finally {
    await page.close();
  }
}

async function syncOnce() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const parts = [];
    for (const u of URLS) {
      try {
        parts.push(await extractOne(browser, u));
        console.log("✓", u);
      } catch (e) {
        console.error("✗", u, String(e).slice(0, 140));
      }
    }
    if (parts.length) {
      fs.writeFileSync(OUT, parts.join("\n\n---\n\n"), "utf8");
      console.log(`已写入 ${OUT}（${parts.length} 篇，${new Date().toLocaleString()}）`);
    } else {
      console.error("一篇都没抓到——检查链接是否真的『互联网公开可阅读』、是否需要登录。");
    }
  } finally {
    await browser.close();
  }
}

await syncOnce();
setInterval(() => syncOnce().catch((e) => console.error("同步出错:", e)), EVERY);
console.log(`飞书公开文档同步已启动：${URLS.length} 个链接，每 ${EVERY / 1000}s 刷新一次。`);
