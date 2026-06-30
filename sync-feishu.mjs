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
    await page.waitForTimeout(2500); // 等富文本首屏渲染

    // 飞书长文档/多维表格是「懒加载」的：只渲染当前可视区域，往下的内容要滚动才出来。
    // 只抓首屏会丢掉文档下半部分（比如「五、下载合同」那些细节）。
    // 所以这里一边滚动一边累积可见文字，把整篇抓全（虚拟滚动会换掉 DOM，按行去重）。
    const text = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const sels = [
        ".bear-web-x-container",
        ".docx-page-block-children",
        ".note-editor",
        ".doc-render",
        "#mainContent",
      ];
      const pickEl = () => {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && el.innerText.trim().length > 50) return el;
        }
        return document.body;
      };
      // 找到真正可滚动的容器（飞书正文常在内层 div 里滚，而非 window）
      const pickScroller = () => {
        const all = Array.from(document.querySelectorAll("div")).filter(
          (el) => el.scrollHeight > el.clientHeight + 200
        );
        return (
          all.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ||
          document.scrollingElement ||
          document.body
        );
      };
      const scroller = pickScroller();
      const seen = new Set();
      const lines = [];
      const grab = () => {
        const t = pickEl().innerText || "";
        for (const ln of t.split("\n")) {
          const k = ln.trim();
          if (k && !seen.has(k)) {
            seen.add(k);
            lines.push(ln);
          }
        }
      };
      scroller.scrollTop = 0;
      await sleep(400);
      grab();
      let lastTop = -1;
      let stable = 0;
      for (let i = 0; i < 80; i++) {
        scroller.scrollBy(0, Math.max(200, scroller.clientHeight * 0.8));
        window.scrollBy(0, 600);
        await sleep(450);
        grab();
        const reachedBottom =
          scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
        if (scroller.scrollTop === lastTop) {
          if (++stable >= 3) break; // 滚不动了（到底或不可滚）
        } else {
          stable = 0;
          lastTop = scroller.scrollTop;
        }
        if (reachedBottom) break;
      }
      return lines.join("\n");
    });

    const title = (await page.title()) || url;
    // 带上来源链接，机器人回答时可以把原文链接甩给新人
    return `# ${title}\n来源链接：${url}\n\n${(text || "").trim()}`;
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
