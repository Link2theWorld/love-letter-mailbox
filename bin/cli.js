#!/usr/bin/env node
// love-letter-mailbox 命令行：创建自己的情书 Worker 项目，或者把插件装进 SillyTavern。
// Copyright (C) 2026 love-letter-mailbox contributors
// SPDX-License-Identifier: GPL-3.0-only

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const TEMPLATE = ["src", "examples", "sillytavern-extension", "wrangler.jsonc", "tsconfig.json", ".dev.vars.example", "README.md", "LICENSE"];
const EXT_NAME = "love-letter";
const NPX = "npx github:Link2theWorld/love-letter-mailbox";

const GITIGNORE = `node_modules/
.wrangler/
.dev.vars*
!.dev.vars.example
.env*
worker-configuration.d.ts
`;

const HELP = `情书信箱 ${PKG.version}

用法：
  ${NPX} init [目录]
      创建一个情书 Worker 项目
  ${NPX} extension <酒馆目录>
      把信箱插件装进 SillyTavern
  ${NPX} help

init 选项：
  --sender <邮箱>       发件地址（开了 Email Routing 的域名下）
  --recipient <邮箱>    收件地址（Email Routing 里已验证的邮箱）
  --name <称呼>         角色怎么称呼你
  --timezone <时区>     默认 Asia/Shanghai
  -y, --yes             不提问，全部用参数或默认值
  --no-install          不自动运行 npm install

extension 选项：
  --user <用户名>       装到 data/<用户名>/extensions，默认 default-user
  --all-users           装到 public/scripts/extensions/third-party（所有用户可用）
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-y" || a === "--yes") out.flags.yes = true;
    else if (a === "--no-install") out.flags.noInstall = true;
    else if (a === "--all-users") out.flags.allUsers = true;
    else if (a === "-h" || a === "--help") out.flags.help = true;
    else if (a === "-v" || a === "--version") out.flags.version = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      out.flags[k] = inline ?? argv[++i];
    } else out._.push(a);
  }
  return out;
}

const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function ask(rl, question, def = "", validate) {
  for (;;) {
    const answer = (await rl.question(`${question}${def ? `（默认 ${def}）` : ""}：`)).trim() || def;
    if (!validate || validate(answer)) return answer;
    console.log("  格式不对，再试一次。");
  }
}

function setVar(text, key, value) {
  const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
  return text.replace(re, (_, p) => `${p}${JSON.stringify(value)}`);
}

function workerName(dir) {
  const n = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  return n || "love-letter";
}

async function init(args) {
  const f = args.flags;
  const interactive = process.stdin.isTTY && !f.yes;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  let dir = args._[1];
  let sender = f.sender ?? "";
  let recipient = f.recipient ?? "";
  let name = f.name ?? "";
  let timezone = f.timezone ?? "Asia/Shanghai";

  if (rl) {
    console.log("\n情书信箱 · 新建项目\n（这些之后都能在 wrangler.jsonc 或管理页里改）\n");
    dir ||= await ask(rl, "项目目录", "love-letter");
    sender ||= await ask(rl, "发件地址，必须在开了 Email Routing 的域名下", "", (s) => !s || isEmail(s));
    recipient ||= await ask(rl, "收件地址，必须是 Email Routing 里已验证的邮箱", "", (s) => !s || isEmail(s));
    name ||= await ask(rl, "角色怎么称呼你", "");
    timezone = await ask(rl, "时区", timezone);
    rl.close();
  }
  dir ||= "love-letter";

  const target = resolve(process.cwd(), dir);
  if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length > 0)) {
    fail(`${target} 已经存在且不是空目录`);
  }
  mkdirSync(target, { recursive: true });

  for (const item of TEMPLATE) {
    const from = join(ROOT, item);
    if (existsSync(from)) cpSync(from, join(target, item), { recursive: true });
  }

  const deps = PKG.devDependencies ?? {};
  const runtime = ["@anthropic-ai/sdk", "postal-mime"];
  const project = {
    name: workerName(target),
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "wrangler dev --test-scheduled",
      deploy: "wrangler deploy",
      types: "wrangler types",
      check: "wrangler types && tsc --noEmit",
    },
    dependencies: Object.fromEntries(runtime.filter((k) => deps[k]).map((k) => [k, deps[k]])),
    devDependencies: Object.fromEntries(Object.entries(deps).filter(([k]) => !runtime.includes(k))),
  };
  writeFileSync(join(target, "package.json"), JSON.stringify(project, null, 2) + "\n");
  writeFileSync(join(target, ".gitignore"), GITIGNORE);

  const wranglerPath = join(target, "wrangler.jsonc");
  let w = readFileSync(wranglerPath, "utf8");
  w = w.replace(/("name"\s*:\s*)"[^"]*"/, (_, p) => `${p}${JSON.stringify(workerName(target))}`);
  if (sender) w = setVar(w, "SENDER_EMAIL", sender);
  if (recipient) w = setVar(w, "RECIPIENT_EMAIL", recipient);
  if (name) w = setVar(w, "USER_NAME", name);
  if (timezone) w = setVar(w, "TIMEZONE", timezone);
  writeFileSync(wranglerPath, w);

  console.log(`\n✓ 项目建好了：${target}`);

  if (!f.noInstall) {
    console.log("\n正在安装依赖（npm install）…\n");
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install"], { cwd: target, stdio: "inherit" });
    if (r.status !== 0) console.log("\n依赖没装好，可以稍后进目录手动运行 npm install。");
  }

  const cd = dir.includes(" ") ? `"${dir}"` : dir;
  console.log(`
接下来：
  1. Cloudflare 控制台 → 你的域名 → Compute → Email Service → Email Routing：
     开启 Email Routing，在 Destination addresses 里添加并验证收件邮箱
  2. cd ${cd}
  3. npx wrangler login
  4. npx wrangler secret put ADMIN_TOKEN     （管理页口令，随便生成一串长的）
  5. npx wrangler secret put LLM_API_KEY     （模型的 API key）
  6. npm run deploy
  7. Email Routing → Routing rules：把发件地址路由到这个 Worker，这样你的回信 TA 才收得到
  8. 打开部署后的网址，输入 ADMIN_TOKEN，上传角色卡，先预览一封

想先在本地试：cp .dev.vars.example .dev.vars && npm run dev
详细说明见 README.md
`);
}

function looksLikeSillyTavern(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (String(pkg.name).toLowerCase() === "sillytavern") return true;
  } catch {
    /* 没有 package.json */
  }
  return existsSync(join(dir, "public", "scripts", "extensions"));
}

function installExtension(args) {
  const stDir = args._[1];
  if (!stDir) fail(`请给出 SillyTavern 的目录，例如：${NPX} extension ~/SillyTavern`);
  const st = resolve(process.cwd(), stDir.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  if (!looksLikeSillyTavern(st)) fail(`${st} 看起来不是 SillyTavern 的目录（没找到 public/scripts/extensions）`);

  const user = args.flags.user || "default-user";
  if (!args.flags.allUsers && /[\\/]|\.\./.test(user)) fail("用户名不合法");
  const dest = args.flags.allUsers
    ? join(st, "public", "scripts", "extensions", "third-party", EXT_NAME)
    : join(st, "data", user, "extensions", EXT_NAME);
  const updating = existsSync(dest);
  mkdirSync(dest, { recursive: true });
  cpSync(join(ROOT, "sillytavern-extension"), dest, { recursive: true });

  console.log(`
✓ 信箱插件${updating ? "已更新" : "已安装"}：${dest}

接下来：
  1. 刷新酒馆页面，在扩展面板里找到“信箱”
  2. 填 Worker 地址和 ADMIN_TOKEN，点“测试连接”
  3. 想让角色自己决定寄信：用 Chat Completion 接口，并在“AI 回复配置”里打开 Enable function calling
`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (args.flags.version) console.log(PKG.version);
else if (!cmd || cmd === "help" || args.flags.help) console.log(HELP);
else if (cmd === "init" || cmd === "create") await init(args);
else if (cmd === "extension" || cmd === "ext" || cmd === "st") installExtension(args);
else fail(`不认识的命令：${cmd}\n\n${HELP}`);
