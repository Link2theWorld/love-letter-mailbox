// 核心流程：写信、寄信、定时检查、处理回信。

import defaultCard from "../examples/character.example.json";
import { resolveSettings, type Settings } from "./config";
import { parseCard, type Character } from "./character";
import { generate } from "./llm";
import { readInbound, sendLetter } from "./mail";
import { buildPrompt, parseOutput } from "./prompt";
import { planAfterReply, planNext, type NextPlan } from "./scheduler";
import { localDateKey } from "./time";
import { newId, store, type Composed, type Letter, type State, type Trigger } from "./store";

const LOCK_MS = 15 * 60_000;

export async function loadSettings(env: Env): Promise<Settings> {
  return resolveSettings(env, await store.getOverrides(env));
}

export async function loadCharacter(env: Env): Promise<Character> {
  return (await store.getCharacter(env)) ?? parseCard(defaultCard, "default");
}

export interface ComposeOptions {
  hint?: string;
  context?: string;
}

export async function compose(
  env: Env,
  cfg: Settings,
  now: Date,
  trigger: Trigger,
  opts: ComposeOptions = {},
): Promise<{ composed: Composed; char: Character; prompt: { system: string; user: string } }> {
  const [state, letters, replies, memories, char, chat] = await Promise.all([
    store.getState(env),
    store.getLetters(env),
    store.getReplies(env),
    store.getMemories(env),
    loadCharacter(env),
    store.getChatContext(env),
  ]);
  const prompt = buildPrompt({ cfg, char, now, state, letters, replies, memories, trigger, chat, ...opts });
  const raw = await generate(env, cfg, prompt.system, prompt.user);
  const composed = parseOutput(raw, `${char.name}的信`);
  return { composed, char, prompt };
}

async function deliver(
  env: Env,
  cfg: Settings,
  now: Date,
  char: Character,
  composed: Composed,
  trigger: Trigger,
  composedAt: string,
  nextReason?: string,
  fromName?: string,
): Promise<Letter> {
  const messageId = await sendLetter(env, cfg, char.name, composed.subject, composed.body, now, fromName);
  const letter: Letter = {
    id: newId(),
    at: now.toISOString(),
    subject: composed.subject,
    body: composed.body,
    trigger,
    messageId,
    nextReason,
  };
  await store.addLetter(env, letter);
  if (composed.memory) await store.addMemory(env, { at: letter.at, text: composed.memory });
  await store.markRepliesAnsweredBefore(env, composedAt);
  return letter;
}

function markSent(state: State, now: Date, composed: Composed): void {
  state.lastSentAt = now.toISOString();
  state.letterCount = (state.letterCount ?? 0) + 1;
  state.plan = composed.plan;
  state.pending = undefined;
  state.failures = 0;
  state.lastError = undefined;
  state.lastErrorAt = undefined;
}

function setNext(state: State, plan: { at: Date; reason: string; kind: Trigger }): void {
  state.nextAt = plan.at.toISOString();
  state.nextReason = plan.reason;
  state.nextKind = plan.kind;
}

/** cron 每 5 分钟调用一次。没到点就什么都不做（不调用模型、不写 KV）。 */
export async function tick(env: Env, now: Date): Promise<string> {
  const cfg = await loadSettings(env);
  if (cfg.paused) return "paused";
  const state = await store.getState(env);

  if (!state.nextAt) {
    setNext(state, planNext(cfg, now, state));
    await store.putState(env, state);
    return `scheduled ${state.nextAt}`;
  }
  if (now.getTime() < Date.parse(state.nextAt)) return "not yet";
  if (state.lockUntil && now.getTime() < Date.parse(state.lockUntil)) return "locked";

  state.lockUntil = new Date(now.getTime() + LOCK_MS).toISOString();
  await store.putState(env, state);

  const trigger: Trigger = state.pending?.trigger ?? state.nextKind ?? "schedule";
  try {
    const char = await loadCharacter(env);
    let composed: Composed;
    let composedAt: string;
    if (state.pending) {
      // 上次信写好了但没寄出去，直接重寄
      ({ composedAt, ...composed } = state.pending);
    } else {
      composedAt = now.toISOString();
      composed = (await compose(env, cfg, now, trigger)).composed;
      state.pending = { ...composed, trigger, composedAt };
      await store.putState(env, state);
    }

    const next = planNext(cfg, now, { ...state, lastSentAt: now.toISOString() }, {
      hours: composed.nextHours,
      reason: composed.nextReason,
    });
    const letter = await deliver(env, cfg, now, char, composed, trigger, composedAt, next.reason);

    markSent(state, now, composed);
    setNext(state, next);
    // 这封信是之前写好的，期间你又回了信：再安排一封回你
    const replies = await store.getReplies(env);
    if (replies.some((r) => !r.answered && r.at > composedAt)) {
      const again = planAfterReply(cfg, now, state);
      if (again) setNext(state, again);
    }
    state.lockUntil = undefined;
    await store.putState(env, state);
    return `sent ${letter.messageId}; next ${state.nextAt}`;
  } catch (err) {
    const msg = err instanceof Error ? `${(err as { code?: string }).code ?? ""} ${err.message}`.trim() : String(err);
    console.error("写信失败", msg);
    state.failures = (state.failures ?? 0) + 1;
    state.lastError = msg;
    state.lastErrorAt = now.toISOString();
    const delayMin = Math.min(30 * 2 ** (state.failures - 1), 360);
    state.nextAt = new Date(now.getTime() + delayMin * 60_000).toISOString();
    state.nextReason = `上次失败了，${delayMin} 分钟后重试`;
    state.lockUntil = undefined;
    await store.putState(env, state);
    return `failed: ${msg}`;
  }
}

/** 管理页 / API 手动写信。raw 给了就直接寄这封，不调用模型。 */
export async function sendNow(
  env: Env,
  now: Date,
  trigger: "manual" | "api",
  opts: ComposeOptions & { raw?: { subject: string; body: string }; fromName?: string } = {},
): Promise<Letter> {
  const cfg = await loadSettings(env);
  const composedAt = now.toISOString();
  let composed: Composed;
  let char: Character;
  if (opts.raw) {
    char = await loadCharacter(env);
    composed = { subject: opts.raw.subject, body: opts.raw.body };
  } else {
    ({ composed, char } = await compose(env, cfg, now, trigger, opts));
  }
  // 刚寄了一封，别让定时的那封紧跟着又来
  const before = await store.getState(env);
  const sent: State = { ...before, lastSentAt: composedAt };
  let next: NextPlan | undefined;
  if (cfg.scheduleMode === "auto") {
    if (composed.nextHours !== undefined) {
      next = planNext(cfg, now, sent, { hours: composed.nextHours, reason: composed.nextReason });
    } else if (!before.nextAt || Date.parse(before.nextAt) < now.getTime() + cfg.autoMinHours * 3_600_000) {
      next = planNext(cfg, now, sent);
    }
  } else if (cfg.scheduleMode === "random") {
    if (before.nextAt && localDateKey(new Date(before.nextAt), cfg.timezone) === localDateKey(now, cfg.timezone)) {
      next = planNext(cfg, now, sent); // 今天已经寄过了，随机那封挪到明天
    }
  }
  const letter = await deliver(env, cfg, now, char, composed, trigger, composedAt, next?.reason, opts.fromName);

  const state = await store.getState(env);
  const prevPlan = state.plan;
  markSent(state, now, composed);
  if (opts.raw) state.plan = prevPlan; // 外部写的信不覆盖角色自己的计划
  if (next) setNext(state, next);
  await store.putState(env, state);
  return letter;
}

/** 你回信了：存起来，按设置把下一封信提前 */
export async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const cfg = await loadSettings(env);
  const reply = await readInbound(message, cfg);
  if (!reply || !reply.text) return;
  const now = new Date();
  await store.addReply(env, { id: newId(), at: now.toISOString(), subject: reply.subject, text: reply.text, answered: false });
  if (cfg.paused) return;
  const state = await store.getState(env);
  const plan = planAfterReply(cfg, now, state);
  if (plan) {
    setNext(state, plan);
    await store.putState(env, state);
  }
}

/** 设置改了之后重新排期 */
export async function reschedule(env: Env, now: Date): Promise<State> {
  const cfg = await loadSettings(env);
  const state = await store.getState(env);
  setNext(state, planNext(cfg, now, state));
  state.lockUntil = undefined;
  await store.putState(env, state);
  return state;
}
