# roockie-lobby · 新人带教机器人

飞书群里 **@它** 或私聊提问，它按你的**飞书文档 + `knowledge.md`** 回答新人的问题（入职流程、付款 SOP、改约 SOP、工具用法）；答不准你人工补一句即可。

**两个核心设计：**
- **长连接模式**：机器人主动连飞书，**不需要公网域名 / HTTPS / 服务器备案**，VPS 甚至自己电脑上 `node` 跑起来就行。
- **文档只维护一份**：你在飞书里改 SOP，机器人自动同步读到最新——**不用维护第二份**。

---

## 0. 你需要准备的三样东西

1. **一个飞书自建应用**（在你自己的飞书组织里建，你就是管理员）——用来当机器人。
2. **一个 AI 接口**（二选一）：
   - 国内 Claude **中转**（推荐，你已有）：中转的 `/v1/chat/completions` 地址 + key + 模型名。
   - 或**千问**：阿里云百炼的 `sk-` key。
3. **一台能常驻联网的机器**：上海 VPS / 云服务器 / 一台一直开着的电脑都行。

---

## 1. 飞书侧配置（一次性，在你自己组织里做）

1. 打开 [飞书开放平台](https://open.feishu.cn/) → **创建企业自建应用**。
2. **添加应用能力 → 机器人**。
3. **凭证与基础信息**：记下 **App ID / App Secret**（待会填进 `.env`）。
4. **权限管理** → 搜"消息"，开通：
   - `im:message:send_as_bot`（以机器人身份发消息）
   - `im:message.p2p_msg:readonly`（收私聊消息）
   - `im:message.group_at_msg:readonly`（收群里 @机器人）
5. **事件与回调 → 事件订阅**：
   - 接收方式选 **「使用长连接接收事件」**（不用填任何 URL）。
   - 添加事件：**接收消息 `im.message.receive_v1`**。
6. **版本管理与发布 → 创建版本 → 申请发布**（你是管理员，自己审批通过）。
7. 把机器人**拉进群**（外部群也行），群里 **@机器人** 或私聊提问。

---

## 2. 部署（在那台常驻机器上）

```bash
git clone https://github.com/vickyldr/roockie-lobby.git
cd roockie-lobby
npm install
cp .env.example .env      # 然后编辑 .env（见下一节）
```

填好 `.env` 后启动：

```bash
# 简单跑（关掉终端就停）：
node server.js

# 推荐用 pm2 常驻（开机自启、自动重启）：
npm i -g pm2
pm2 start server.js --name roockie-bot
pm2 save
```

看到 `feishu-bot 已启动（长连接模式）…` 就成功了。去群里 @它 试试。

---

## 3. 填 `.env`

最少只要这几行就能跑（飞书 + 一个 AI）：

```ini
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=feishu            # Lark 国际版填 lark

# —— 用 Claude 中转（推荐）——
RELAY_URL=https://你的中转域名/v1/chat/completions
RELAY_KEY=你的中转key
RELAY_MODEL=claude-sonnet-4-6   # 够聪明又快；要更强改 claude-opus-4-8

# —— 或者用千问（把上面三行删掉，用这三行）——
# QWEN_KEY=sk-xxx
# QWEN_BASE=https://dashscope.aliyuncs.com
# QWEN_MODEL=qwen-plus
```

> 填了 `RELAY_URL`+`RELAY_KEY` 就自动优先用中转。模型选 **Sonnet** 就够带教答疑，回得快；偶尔复杂问题答不好，把 `RELAY_MODEL` 改成 `claude-opus-4-8` 即可，零成本切换。

---

## 4. 让机器人实时读飞书文档（关键，不用维护第二份）

思路：**只留一份正本**——你在飞书改 SOP，机器人读同一份。

### 你的情况：文档是「互联网公开可见」的 ✅ 推荐

如果文档设成 **「互联网上获得链接的人可阅读」**，机器人就能像读普通网页一样直接读它，**不限组织、不需管理员、不需任何授权**。

```bash
npx playwright install chromium    # 装无头浏览器（抓公开网页正文用）
```

`.env` 里加上你**带教会用到、且会更新**的几篇文档的公开链接：

```ini
PUBLIC_DOC_URLS=https://xxx.feishu.cn/docx/aaa,https://xxx.feishu.cn/wiki/bbb
DOC_REFRESH_SECONDS=300
```

再起一个同步进程（和机器人分开跑，崩了不影响答疑）：

```bash
pm2 start sync-feishu.mjs --name roockie-sync
pm2 save
```

它每 5 分钟渲染这些链接、抓最新正文写进 `knowledge.feishu.md`，机器人 1 分钟内自动加载。

**机器人怎么知道读哪篇？** ——就读你 `PUBLIC_DOC_URLS` 里列的那几个链接，**你列什么它读什么**，不会自己去翻飞书。所以"哪些是带教文档"由你决定：把带教会用到的文档链接填进去，别的不填它就看不到。

> ⚠️ **多页知识库注意**：飞书知识库每个子页面是独立链接。只填首页**抓不到子页面**。
> 要么把每个子页面链接都列进 `PUBLIC_DOC_URLS`；要么找 Claude 给同步脚本加"自动抓子页面"。

### 备选：文档在你自己飞书里（同组织，应用授权读取）

文档在机器人所在的同一个飞书组织时，可走 API 直读：应用开 `docx:document:readonly` + `wiki:wiki:readonly`，把文档分享给机器人应用，`.env` 填 `FEISHU_WIKI_SPACE_ID` 或 `FEISHU_DOC_TOKENS`。详见 `.env.example`。
（公司组织的文档跨组织读不到，只能走上面的「公开链接」方式。）

---

## 5. 日常维护

| 想做的事 | 怎么做 | 多久生效 |
| --- | --- | --- |
| 改常变的 SOP | 直接在飞书改那篇文档 | ≤5 分钟自动同步 |
| 改固定内容（入职流程、工具用法、答疑口径） | 改 `knowledge.md` 推送/重拉 | ≤1 分钟 |
| 答错了 | 群里人工补一句；顺手把对应文档/`knowledge.md` 补上 | 即时 |
| 换 AI 模型 | 改 `.env` 的 `RELAY_MODEL`，`pm2 restart roockie-bot` | 即时 |

---

## 6. 行为说明

- 群里**只在被 @ 时**回答；私聊直接回答（避免刷屏）。
- 有人说「人工 / 转人工 / 找 TL」→ 回一句让其找 TL（`.env` 里 `HANDOFF_HINT` 可改）。
- 知识库没覆盖的，会说「不确定，建议找 TL」，不瞎编。
- 涉及金额/币种/合规/改条款，会提醒以 TL 最终确认为准。

---

## 文件一览

| 文件 | 作用 |
| --- | --- |
| `server.js` | 机器人主程序（长连接、收消息、调 AI、回复） |
| `sync-feishu.mjs` | 把公开飞书文档抓成 `knowledge.feishu.md` |
| `knowledge.md` | 手写的固定知识（入职流程、工具用法、答疑口径） |
| `.env.example` | 配置模板，复制成 `.env` 填 |
| `.gitignore` | 挡掉 `.env`、`node_modules`、同步缓存——**别把密钥提交上来** |

> ⚠️ **千万别把 `.env` 提交进 git**（里面有密钥）。`.gitignore` 已经挡掉了，照着用就行。
