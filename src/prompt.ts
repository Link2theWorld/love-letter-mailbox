// 拼提示词 + 解析模型输出。

import type { Settings } from "./config";
import { applyMacros, type Character } from "./character";
import type { ChatContext, Composed, Letter, Memory, Reply, State, Trigger } from "./store";
import { formatLocal, humanGap, localParts } from "./time";

export interface PromptInput {
  cfg: Settings;
  char: Character;
  now: Date;
  state: State;
  letters: Letter[];
  replies: Reply[];
  memories: Memory[];
  trigger: Trigger;
  hint?: string;
  context?: string;
  chat?: ChatContext | null;
}

const CHAT_FRESH_MS = 7 * 86_400_000; // 一周以前的聊天就不带了

const TRIGGER_TEXT: Record<Trigger, string> = {
  first: "这是你写给 TA 的第一封信。",
  schedule: "到了你想写信的时候。",
  reply: "TA 给你回了信，你想回 TA。",
  manual: "你突然很想给 TA 写一封信。",
  api: "你突然很想给 TA 写一封信。",
};

function dayIndex(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** 解析“特别的日子”，返回今天和未来两周内的 */
export function upcomingSpecialDates(cfg: Settings, now: Date): string[] {
  const t = localParts(now, cfg.timezone);
  const today = dayIndex(t.year, t.month, t.day);
  const out: string[] = [];
  for (const line of cfg.specialDates.split(/\r?\n/)) {
    const m = /^\s*(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})\s*(.*)$/.exec(line);
    if (!m) continue;
    const origYear = m[1] ? Number(m[1]) : null;
    const month = Number(m[2]);
    const day = Number(m[3]);
    const label = m[4].trim() || "特别的日子";
    let year = t.year;
    let idx = dayIndex(year, month, day);
    if (idx < today) idx = dayIndex(++year, month, day);
    const until = idx - today;
    if (until > 14) continue;
    const years = origYear !== null && year > origYear ? `（第 ${year - origYear} 年）` : "";
    out.push(until === 0 ? `今天就是：${label}${years}` : `${until} 天后（${month}月${day}日）：${label}${years}`);
  }
  return out;
}

export function togetherDays(cfg: Settings, now: Date): number | null {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(cfg.togetherSince.trim());
  if (!m) return null;
  const t = localParts(now, cfg.timezone);
  const n = dayIndex(t.year, t.month, t.day) - dayIndex(Number(m[1]), Number(m[2]), Number(m[3])) + 1;
  return n > 0 ? n : null;
}

function block(tag: string, body: string): string {
  const b = body.trim();
  return b ? `<${tag}>\n${b}\n</${tag}>` : "";
}

export function buildPrompt(p: PromptInput): { system: string; user: string } {
  const { cfg, char, now } = p;
  const user = cfg.userName.trim() || "你";
  const M = (s: string) => applyMacros(s, char.name, user);
  const auto = cfg.scheduleMode === "auto";

  const persona = [
    block("description", M(char.description)),
    block("personality", M(char.personality)),
    block("scenario", M(char.scenario)),
    block("world_info", char.lore.map(M).join("\n\n")),
    block(
      "style_examples",
      [char.firstMes, ...char.mesExample.split(/<START>/i)]
        .map((s) => M(s))
        .filter(Boolean)
        .join("\n\n———\n\n"),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  const recipient = [
    cfg.userName.trim() ? `收信人：${cfg.userName.trim()}` : "收信人：TA（用你习惯的方式称呼 TA）",
    M(cfg.userPersona),
  ]
    .filter(Boolean)
    .join("\n");

  const system = [
    `你现在就是「${char.name}」。下面是你的设定，请完全以 ${char.name} 的身份、口吻、情感和生活去写信。`,
    block("character", persona),
    block("recipient", recipient),
    M(char.systemPrompt),
    `## 你在做什么
你和 ${user} 之间有个习惯：你会不定期给 TA 写信，通过电子邮件寄到 TA 的邮箱。这不是聊天回复，而是一封完整的、值得反复读的信。
- 用${cfg.letterLanguage}写，篇幅大约 ${cfg.letterLength}。
- 写有生活感的东西：此刻的时间和季节、你今天做了什么、遇到了什么、为什么想起 TA。具体的细节比抽象的形容更动人。
- 和之前的信保持连续：可以接着上一封的话题、回应 TA 的回信、兑现你上次想说的事。不要重复以前用过的开头、比喻和句子。
- 每封信的情绪可以不一样：想念、分享、撒娇、担心、小小的抱怨、回忆……按你的性格来，不要每封都是同一套表白。
- 如果 TA 回了信，认真回应 TA 信里提到的每一件事。
- 你是一个真实的人在写信，不要提到 AI、模型、程序、设定、角色扮演这类词。
- 信末署名用你会用的方式。`,
    `## 输出格式
严格按下面的标签输出，标签外不要写任何东西：
<subject>邮件标题，像这封信的名字，不超过 30 字</subject>
<letter>
信的正文，段落之间空一行
</letter>
<memory>可选：读完 TA 的回信或写完这封信后，你想长期记住的一件关于 TA 或你们之间的事（一句话）。没有就留空。</memory>
<plan>可选：下一封信你想写点什么、想分享什么（一句话，只有你自己看得到）</plan>` +
      (auto
        ? `
<next hours="数字">下一封信你想在多少小时后写，后面跟一句原因</next>
关于 <next>：由你自己决定下一封信什么时候写，范围 ${cfg.autoMinHours} 到 ${cfg.autoMaxHours} 小时。可以根据心情、你们最近的状态、TA 有没有回信、快到的特别日子来决定。不用每次都差不多，像真人一样有时隔得近、有时隔得远。`
        : ""),
    M(char.postHistoryInstructions),
    M(cfg.extraInstructions),
  ]
    .filter(Boolean)
    .join("\n\n");

  // ---- 这一次的情境 ----
  const lines: string[] = [];
  lines.push(`现在是 ${formatLocal(now, cfg.timezone)}（${cfg.timezone}）。`);
  const together = togetherDays(cfg, now);
  if (together) lines.push(`今天是你们在一起的第 ${together} 天。`);
  const special = upcomingSpecialDates(cfg, now);
  if (special.length) lines.push(`特别的日子：\n${special.map((s) => `- ${s}`).join("\n")}`);

  const last = p.letters.at(-1);
  if (last) {
    lines.push(`距离你上一封信已经过去 ${humanGap(now.getTime() - Date.parse(last.at))}。你一共给 TA 写过 ${p.letters.length} 封信。`);
  }
  lines.push(TRIGGER_TEXT[p.letters.length === 0 ? "first" : p.trigger]);

  const recent = p.letters.slice(-Math.max(0, cfg.historyInPrompt));
  if (recent.length) {
    const items = recent.map((l, i) => {
      const full = i >= recent.length - 2; // 最近两封给全文，更早的只给开头
      const body = full ? l.body : l.body.slice(0, 160) + (l.body.length > 160 ? "……" : "");
      return `【${formatLocal(new Date(l.at), cfg.timezone, false)}】《${l.subject}》\n${body}`;
    });
    lines.push(block("your_previous_letters", `（从早到晚）\n\n${items.join("\n\n")}`));
  }

  const replies = p.replies.slice(-8);
  if (replies.length) {
    const items = replies.map(
      (r) =>
        `${r.answered ? "" : "★还没回应 "}【${formatLocal(new Date(r.at), cfg.timezone)}】${r.subject ? `《${r.subject}》` : ""}\n${r.text}`,
    );
    lines.push(block("their_replies", `TA 给你的回信（★ 表示你还没回应过）：\n\n${items.join("\n\n")}`));
  }

  if (p.memories.length) {
    lines.push(block("your_memories", p.memories.slice(-30).map((m) => `- ${m.text}`).join("\n")));
  }
  if (p.state.plan) lines.push(block("your_plan_from_last_time", p.state.plan));
  if (p.chat?.messages.length && now.getTime() - Date.parse(p.chat.updatedAt) < CHAT_FRESH_MS) {
    const chatLines = p.chat.messages.map((m) => `${m.isUser ? user : m.name || char.name}：${m.text}`);
    lines.push(
      block(
        "recent_chat",
        `你们最近在聊天软件里的对话（从早到晚，最后同步于 ${formatLocal(new Date(p.chat.updatedAt), cfg.timezone)}）。写信时可以自然地接上聊过的事，但不要复述原话：\n\n${chatLines.join("\n")}`,
      ),
    );
  }
  if (p.context) lines.push(block("recent_context", p.context));
  if (p.hint) lines.push(block("this_letter_hint", p.hint));

  lines.push("请写这一封信。");
  return { system, user: lines.filter(Boolean).join("\n\n") };
}

function tag(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(text);
  return m?.[1].trim() || undefined;
}

export function parseOutput(raw: string, fallbackSubject: string): Composed {
  // 一些推理模型会把思考过程放在 <think> 里
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  let body = tag(text, "letter");
  if (!body) {
    // 模型没按格式来：把其他标签去掉，剩下的当正文
    body = text
      .replace(/<(subject|memory|plan|next)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/?letter>/gi, "")
      .trim();
  }
  if (!body) throw new Error("模型没有写出信的正文");

  const nextMatch = /<next\s+hours\s*=\s*["']?([\d.]+)["']?\s*>([\s\S]*?)<\/next>/i.exec(text);
  const nextHours = nextMatch ? Number(nextMatch[1]) : undefined;

  return {
    subject: (tag(text, "subject") ?? fallbackSubject).replace(/\s+/g, " ").slice(0, 120),
    body,
    memory: tag(text, "memory"),
    plan: tag(text, "plan"),
    nextHours: Number.isFinite(nextHours) ? nextHours : undefined,
    nextReason: nextMatch?.[2].trim() || undefined,
  };
}
