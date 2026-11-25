# 情书信箱 · love-letter-mailbox

[![npm](https://img.shields.io/npm/v/love-letter-mailbox)](https://www.npmjs.com/package/love-letter-mailbox) [![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

> **English:** A Cloudflare Worker that lets an AI companion (any SillyTavern character card) write you love letters by email — on a daily schedule, at random times, or whenever the character decides to. Reply to the email and the character reads it, remembers it, and writes back. Sending to your own verified address is free on the Workers Free plan via Cloudflare Email Service. Includes a SillyTavern extension so the character in your chat can decide to mail you a letter through function calling. GPL-3.0.

一个跑在 Cloudflare Workers 上的“会写信的角色”。导入酒馆（SillyTavern）角色卡，TA 会按你设定的节奏（或者自己决定什么时候）给你的邮箱寄信。你直接回复邮件，TA 能收到、记住，并在之后回你。

- **三种节奏**：`auto` 由角色每写完一封信就自己决定下一封隔多久写（附带理由）；`daily` 每天固定时间；`random` 每天在时间窗里挑一个随机时刻。
- **能收回信**：回复 TA 的邮件后，回信会被存起来，TA 会在 30～180 分钟后（可调）回你，并在信里回应你说的每件事。
- **有记忆**：最近几封信、你的回信、TA 主动记下的事、TA 给自己留的“下次想写什么”，都会带进下一次写信。
- **角色卡**：支持 V1 / V2 / V3 的 JSON 卡和 PNG 卡，世界书里启用的条目也会读进来。
- **管理页**：在 Worker 的网址上打开，可以预览、立即寄出、换角色卡、改设置、看历史。
- **对外接口**：酒馆插件或其他 AI 可以调 `POST /api/letter` 让 TA 立刻写一封，或者直接寄一封写好的信。

## 免费在哪里

用的是 Cloudflare Email Service（2026 年 4 月进入公开 Beta）的 `send_email` 绑定：

| | Workers Free | Workers Paid |
|---|---|---|
| 发给 Email Routing 里**已验证的目标地址** | 免费，不占额度 | 免费，不占额度 |
| 发给任意地址 | 不行 | 每月 3000 封，之后 $0.35 / 千封 |
| 收信（Email Routing） | 免费不限量 | 免费不限量 |

所以“只寄给你自己”完全免费：把你的邮箱加成已验证的目标地址就行。Cron、KV 用量也都在 Free 额度内（每 5 分钟检查一次；只有真的写信时才写 KV）。**要花钱的只有大模型**，按 Claude Opus 5.5 估算，一封信大约几美分。

## 快速开始

需要：一个 DNS 托管在 Cloudflare 上的域名、Node.js 20+。

```bash
npx love-letter-mailbox init my-letters
```

它会问你发件地址、收件地址和称呼，建好项目并装好依赖，最后列出剩下的步骤（就是下面的第 2、4～7 步）。

也可以直接克隆这个仓库：

```bash
git clone https://github.com/Link2theWorld/love-letter-mailbox.git
```

```bash
cd love-letter-mailbox && npm install
```

## 部署

### 1. 装依赖

用 `npx love-letter-mailbox init` 建的项目已经装好了，跳过这步。克隆仓库的话运行 `npm install`。

### 2. 在 Cloudflare 控制台开邮件

1. 进入你的域名 → **Compute → Email Service → Email Routing**，按提示开启（会自动加 MX / SPF / DKIM 记录）。
2. **Destination addresses** 里添加你要收信的邮箱，去邮箱里点验证链接。没验证的地址发不出去。

### 3. 改配置

打开 [wrangler.jsonc](wrangler.jsonc)，至少改这三个：

- `SENDER_EMAIL`：发件地址，必须在上面那个域名下，比如 `letters@你的域名`
- `RECIPIENT_EMAIL`：你刚才验证过的邮箱
- `USER_NAME`：角色怎么称呼你

其他设置部署后都可以在管理页改。

### 4. 登录并设置密钥

```bash
npx wrangler login
```

```bash
npx wrangler secret put ADMIN_TOKEN
```

```bash
npx wrangler secret put LLM_API_KEY
```

`ADMIN_TOKEN` 是管理页和 API 的口令，随便生成一串长的；没设置的话所有管理接口都会拒绝访问。

### 5. 部署

```bash
npm run deploy
```

第一次部署时 wrangler 会自动创建 KV（如果你的 wrangler 版本不支持，先跑 `npx wrangler kv namespace create STORE`，把输出的 `id` 填进 `kv_namespaces`）。完成后会打印 Worker 的网址，形如 `https://love-letter.<你的子域>.workers.dev`。

### 6. 让回信能送到 TA 手里

**Email Routing → Routing rules → Create address**：自定义地址填 `SENDER_EMAIL` 的前缀（比如 `letters`），动作选 **Send to a Worker**，选 `love-letter`。

这一步不做也能收信，只是你回的邮件 TA 收不到。

### 7. 打开管理页

浏览器打开 Worker 的网址，输入 `ADMIN_TOKEN`：

1. **角色卡**：上传你的酒馆角色卡（不传就用自带的示例角色“林晚”）。
2. **先预览，不寄出**：看看 TA 写得怎么样，展开还能看到这次的完整提示词。
3. **写好就寄出**：寄一封到邮箱，确认能收到。第一封如果进了垃圾箱，标记一下“不是垃圾邮件”。

之后就不用管了，TA 会按节奏自己写。

## 节奏怎么定

| 设置 | 说明 |
|---|---|
| `auto` | TA 每写完一封，会在信末（你看不到的部分）写下“下一封想在多少小时后写，为什么”。范围由“最短/最长间隔”限定，勿扰时段会自动避开。 |
| `daily` | 每天 `DAILY_TIME` 寄一封（按 `TIMEZONE`）。 |
| `random` | 每天在 `RANDOM_WINDOW` 里随机挑一个时刻。 |
| 回信 | 不管哪种节奏，收到你的回信后都会在 `REPLY_DELAY_MINUTES` 分钟内回你；填 `off` 就只记住，留到下一封再回应。 |

“特别的日子”每行写一个，比如 `03-14 我的生日` 或 `2024-05-20 在一起纪念日`，两周内的会提醒 TA。

## 换模型

默认用 Anthropic 官方 SDK 调 `claude-opus-5-5`，开启了服务端拒答回退（万一安全分类器误拒，会自动换模型接着写）。在管理页的“模型”一栏可以改：

- **其他 Claude 模型**：改“模型”即可。如果用第三方中转或较旧的模型报 400，把“拒答时自动换模型重试”关掉。
- **OpenAI 兼容接口**（DeepSeek、OpenRouter、Gemini、各种中转等）：接口选 `openai`，Base URL 填到 `/v1`（或平台文档给的兼容地址），模型名填平台上的名字，`LLM_API_KEY` 换成那家的 key。
- **mock**：不调用模型，只寄固定格式的测试信，用来检查流程。

## 酒馆插件：让聊天里的 TA 自己决定寄信

[sillytavern-extension/](sillytavern-extension/) 是一个 SillyTavern 扩展。装上之后：

- **聊天里的 TA 可以自己决定寄信**：插件给模型注册了一个“寄一封信”的函数工具。聊到纪念日、你说想收到信、你难过需要安慰时，TA 可能会主动调用它，把信寄到你的邮箱，然后在聊天里提一句。
- **两种写法**：默认是 TA 在聊天里亲手写好、原样寄出（署名用当前角色名）；也可以改成 TA 只说想写什么，交给信箱 Worker 里的 TA 结合记忆慢慢写。
- **聊天里的 TA 知道寄过什么信**：最近寄出的信、你的邮件回信、下一封打算什么时候写，会作为背景放进聊天提示词里。
- **定时寄来的信接得上聊天**（可选）：把最近的聊天同步给 Worker，定时信会自然地接上你们聊过的事。默认关闭，需要你自己打开。
- **其他**：一键把当前角色卡和你的人设同步到信箱；`/letter 想写什么` 让信箱里的 TA 现在写一封；冷却时间防止 TA 寄得太勤；可以只对某一个角色启用。

### 安装

一条命令装进酒馆（后面是你的 SillyTavern 目录）：

```bash
npx love-letter-mailbox extension ~/SillyTavern
```

默认装到 `data/default-user/extensions/love-letter`。多用户的话加 `--user 用户名`，想给所有用户用就加 `--all-users`。再运行一次就是更新。

也可以手动把 `sillytavern-extension` 文件夹复制到 `SillyTavern/data/<你的用户名>/extensions/love-letter`。装好后刷新酒馆页面。

### 设置

在酒馆的扩展面板里找到“信箱”：

1. 填 Worker 地址和 `ADMIN_TOKEN`，点“测试连接”。口令只存在当前浏览器里，不会写进酒馆的设置文件。
2. 打开和角色的聊天，点“把当前角色卡同步到信箱”，让信箱里的 TA 和聊天里的是同一个人。
3. 要让 TA 自己寄信：API 要用 **Chat Completion**，并在“AI 回复配置”里打开 **Enable function calling**。面板里会显示当前接口是否支持。

模型不一定每次都会用工具，这取决于模型本身。不想等它主动寄的话，直接用 `/letter`。

## 给酒馆插件 / 其他 AI 用的接口

所有接口都要带 `Authorization: Bearer <ADMIN_TOKEN>`。

让 TA 现在写一封（可以带提示和最近的聊天内容）：

```bash
curl -X POST https://love-letter.xxx.workers.dev/api/letter \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"hint": "今天聊到了看海", "context": "（最近几条聊天记录）"}'
```

直接寄一封已经写好的信（不调用模型）：

```bash
curl -X POST https://love-letter.xxx.workers.dev/api/letter \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"subject": "晚安", "body": "信的正文……"}'
```

寄写好的信时可以加 `"fromName": "角色名"` 指定发件人名字。

同步最近的聊天（定时写信时当背景，一周内有效）：

```bash
curl -X PUT https://love-letter.xxx.workers.dev/api/chat-context \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"character": "林晚", "messages": [{"name": "小满", "isUser": true, "text": "周末想去看海"}]}'
```

其他：`GET /api/status`、`GET /api/letters?limit=N`、`POST /api/preview`、`PUT /api/settings`、`POST /api/character`、`POST /api/reschedule`、`POST /api/tick`、`DELETE /api/chat-context`。

接口允许跨域（插件在浏览器里直接调用），但每个请求都要带口令。

## 本地测试

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run dev
```

本地发信是模拟的，不会真的寄出，邮件内容会存到 `.wrangler/tmp/email/` 下。手动触发一次定时检查：

```bash
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

模拟你回了一封信（本地没有 DMARC，所以要手动带上那一行）：

```bash
printf 'From: you@example.com\r\nTo: letters@example.com\r\nAuthentication-Results: mx.cloudflare.net; dmarc=pass\r\nSubject: Re\r\nMessage-ID: <t1@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n今天好累，想你了。\r\n' \
  | curl -X POST --data-binary @- "http://localhost:8787/cdn-cgi/handler/email?from=you@example.com&to=letters@example.com"
```

## 常见问题

- **管理页显示“上次出错”**：失败后会按 30 分钟、1 小时、2 小时……（最多 6 小时）重试。如果是模型写好了但邮件没发出去，下次会直接重寄那封，不会重复花钱。
- **`E_RECIPIENT_NOT_ALLOWED` / `E_RECIPIENT_PLAN_RESTRICTED`**：收件地址没在 Email Routing 里验证，或者 Free 计划下填了没验证的地址。
- **`E_SENDER_DOMAIN_NOT_CONFIGURED` / `E_SENDER_NOT_VERIFIED`**：发件地址的域名没开 Email Routing。
- **Email Routing 概览里显示 dropped**：Cloudflare 文档说明，Worker 主动发出的信在那里会显示为 dropped，实际已送达，以邮箱为准。
- **回信被拒**：只接受来自 `RECIPIENT_EMAIL`、并且通过 DMARC 的邮件，防止别人冒充你。用的邮箱不支持 DMARC 的话，可以在管理页关掉“回信需通过 DMARC”。

## 文件

```
src/index.ts      路由：管理页、API、cron、收信
src/letters.ts    写信、寄信、定时检查、处理回信
src/scheduler.ts  三种节奏 + 勿扰时段
src/prompt.ts     拼提示词、解析模型输出
src/llm.ts        Anthropic SDK / OpenAI 兼容 / mock
src/mail.ts       信纸 HTML、发信、读回信
src/character.ts  酒馆角色卡（JSON / PNG）
src/config.ts     设置项定义
src/store.ts      KV 存取
src/admin.html    管理页
examples/character.example.json  示例角色
sillytavern-extension/            酒馆插件（manifest.json / index.js / style.css）
bin/cli.js                        npx 命令行（init / extension）
```

## 许可证

[GPL-3.0](LICENSE)。你可以自由使用、修改和再分发，但基于它发布的修改版也要以 GPL-3.0 开源。
