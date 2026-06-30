// 把「公开可见的飞书文档」渲染出来、抓正文，写进 knowledge.feishu.md。
// 机器人(server.js)每分钟自动重载这个文件 —— 你在飞书改文档，几分钟后机器人就知道。
//
// 适用：文档设置为「互联网上获得链接的人可阅读」。这样不需要同组织 / 管理员 / 应用授权，
// 因为它就是一个公开网页，用无头浏览器读即可。
//
// 两个能力：
//  1) 长文档/表格懒加载 —— 边滚动边累积可见文字，把整篇抓全（不只首屏）。
//  2) 跟随链接（FOLLOW_LINKS，默认开）—— 如果某个链接是「索引页/多维表格」，
//     里面又链到一堆飞书文档，会自动把那些子文档也抓下来（往下一层）。
//
// 跑法：
//   npm install            # 装依赖（含 playwright）
//   npx playwright install chromium
//   PUBLIC_DOC_URLS="https://xxx.feishu.cn/docx/aaa,https://xxx.feishu.cn/wiki/bbb" node sync-feishu.mjs
// 或把 PUBLIC_DOC_URLS 写进 .env，用 pm2 常驻：pm2 start sync-feishu.mjs --name rookie-sync
import "dotenv/config";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "knowledge.feishu.md");
// 文档清单：可以写在 .env 的 PUBLIC_DOC_URLS，也可以放一个 docs.txt（每行一个链接，# 开头是注释）。
// 想加新文档/会议纪要，直接编辑 docs.txt 即可，不用碰 .env。两处会合并去重。
function readDocsFile() {
  try {
    return fs
      .readFileSync(path.join(__dirname, "docs.txt"), "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}
const URLS = [
  ...new Set(
    [...(process.env.PUBLIC_DOC_URLS || "").split(/[\n,]+/), ...readDocsFile()]
      .map((s) => s.trim())
      .filter(Boolean)
  ),
];
const EVERY = Math.max(60, Number(process.env.DOC_REFRESH_SECONDS) || 300) * 1000;
// 把「索引页/多维表格」里链接到的飞书文档也一并抓下来（往下一层）。设 FOLLOW_LINKS=0 关闭。
const FOLLOW_LINKS = (process.env.FOLLOW_LINKS ?? "1") !== "0";

if (!URLS.length) {
  console.error("请设置 PUBLIC_DOC_URLS=公开文档链接（逗号或换行分隔）。");
  process.exit(1);
}

// 只跟随飞书的「文档」类链接（docx / wiki）；base、外链(youtube等)不跟随，避免循环和噪音。
const isFeishuDoc = (u) => /\/\/[^/]+\.feishu\.[a-z]+\/(docx|wiki)\//.test(u);
// 文档去重用：去掉 query 和末尾斜杠（docx/wiki 的 query 没意义）。
const normDoc = (u) => u.split("#")[0].replace(/\?.*$/, "").replace(/\/+$/, "");

async function extractOne(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(2500); // 等富文本首屏渲染

    // 飞书长文档/多维表格是「懒加载」的：只渲染当前可视区域，往下要滚动才出来。
    // 边滚边累积可见文字 + 顺手收集页面里的飞书文档链接（虚拟滚动会换 DOM，按内容去重）。
    const result = await page.evaluate(async () => {
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
      // 找到真正可滚动的容器（飞书正文/表格常在内层 div 里滚，而非 window）
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
      const links = new Set();
      const grab = () => {
        const t = pickEl().innerText || "";
        for (const ln of t.split("\n")) {
          const k = ln.trim();
          if (k && !seen.has(k)) {
            seen.add(k);
            lines.push(ln);
          }
        }
        // 收集当前渲染出来的所有飞书文档链接
        document.querySelectorAll("a[href]").forEach((a) => {
          const h = a.href || "";
          if (/\/\/[^/]+\.feishu\.[a-z]+\/(docx|wiki)\//.test(h)) links.add(h);
        });
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
      return { text: lines.join("\n"), links: [...links] };
    });

    const title = (await page.title()) || url;
    // 带上来源链接，机器人回答时可以把原文链接甩给新人
    const md = `# ${title}\n来源链接：${url}\n\n${(result.text || "").trim()}`;
    return { md, links: result.links || [] };
  } finally {
    await page.close();
  }
}

async function syncOnce() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    const parts = [];
    const done = new Set(URLS.map(normDoc)); // 已处理（含顶层链接，避免子文档重复抓）
    const discovered = [];

    // 第一层：用户在 PUBLIC_DOC_URLS 里列的链接
    for (const u of URLS) {
      try {
        const { md, links } = await extractOne(browser, u);
        parts.push(md);
        console.log("✓", u);
        if (FOLLOW_LINKS) {
          for (const l of links) {
            if (isFeishuDoc(l) && !done.has(normDoc(l))) {
              done.add(normDoc(l));
              discovered.push(l);
            }
          }
        }
      } catch (e) {
        console.error("✗", u, String(e).slice(0, 140));
      }
    }

    // 第二层：索引页/表格里链接到的子文档（只往下一层，不再递归，避免抓爆）
    if (FOLLOW_LINKS && discovered.length) {
      console.log(`↳ 从索引里发现 ${discovered.length} 篇子文档，继续抓取…`);
      for (const u of discovered) {
        try {
          const { md } = await extractOne(browser, u);
          parts.push(md);
          console.log("  ✓(子)", u);
        } catch (e) {
          console.error("  ✗(子)", u, String(e).slice(0, 120));
        }
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

// 防止上一轮还没跑完、下一轮又开始（跟随链接后单轮可能较久）。
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    await syncOnce();
  } finally {
    running = false;
  }
}

await tick();
setInterval(() => tick().catch((e) => console.error("同步出错:", e)), EVERY);
console.log(
  `飞书公开文档同步已启动：${URLS.length} 个入口链接，跟随链接=${FOLLOW_LINKS ? "开" : "关"}，每 ${
    EVERY / 1000
  }s 刷新一次。`
);
