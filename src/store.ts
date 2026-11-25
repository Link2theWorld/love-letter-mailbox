// KV 里只放几个 JSON：state / letters / replies / memories / settings / character。
// 写得很少（每封信 3~4 次），Free 计划每天 1000 次写入绰绰有余。

import type { Overrides } from "./config";
import type { Character } from "./character";

export type Trigger = "schedule" | "reply" | "manual" | "api" | "first";

export interface Composed {
  subject: string;
  body: string;
  memory?: string;
  plan?: string;
  nextHours?: number;
  nextReason?: string;
}

export interface State {
  nextAt?: string;
  nextReason?: string;
  nextKind?: Trigger;
  lastSentAt?: string;
  letterCount: number;
  failures: number;
  lastError?: string;
  lastErrorAt?: string;
  lockUntil?: string;
  plan?: string;
  /** 模型已经写好、但邮件没发出去的信，下次直接重发，不再花钱重写 */
  pending?: Composed & { trigger: Trigger; composedAt: string };
}

export interface Letter {
  id: string;
  at: string;
  subject: string;
  body: string;
  trigger: Trigger;
  messageId?: string;
  nextReason?: string;
}

export interface Reply {
  id: string;
  at: string;
  subject: string;
  text: string;
  answered: boolean;
}

export interface ChatLine {
  name: string;
  isUser: boolean;
  text: string;
  at?: string;
}

/** 酒馆插件同步过来的最近聊天，写信时当作背景 */
export interface ChatContext {
  updatedAt: string;
  character?: string;
  messages: ChatLine[];
}

export interface Memory {
  at: string;
  text: string;
}

const MAX_LETTERS = 200;
const MAX_REPLIES = 100;
const MAX_MEMORIES = 60;

async function getJSON<T>(env: Env, key: string, fallback: T): Promise<T> {
  const v = await env.STORE.get<T>(key, "json");
  return v ?? fallback;
}

async function putJSON(env: Env, key: string, value: unknown): Promise<void> {
  await env.STORE.put(key, JSON.stringify(value));
}

export const store = {
  getState: (env: Env) => getJSON<State>(env, "state", { letterCount: 0, failures: 0 }),
  putState: (env: Env, s: State) => putJSON(env, "state", s),

  getLetters: (env: Env) => getJSON<Letter[]>(env, "letters", []),
  async addLetter(env: Env, l: Letter) {
    const all = await store.getLetters(env);
    all.push(l);
    await putJSON(env, "letters", all.slice(-MAX_LETTERS));
  },

  getReplies: (env: Env) => getJSON<Reply[]>(env, "replies", []),
  async addReply(env: Env, r: Reply) {
    const all = await store.getReplies(env);
    all.push(r);
    await putJSON(env, "replies", all.slice(-MAX_REPLIES));
  },
  /** 写信时已经看到的回信，都算回应过了 */
  async markRepliesAnsweredBefore(env: Env, iso: string) {
    const all = await store.getReplies(env);
    let changed = false;
    for (const r of all) {
      if (!r.answered && r.at <= iso) {
        r.answered = true;
        changed = true;
      }
    }
    if (changed) await putJSON(env, "replies", all);
  },

  getMemories: (env: Env) => getJSON<Memory[]>(env, "memories", []),
  async addMemory(env: Env, m: Memory) {
    const all = await store.getMemories(env);
    all.push(m);
    await putJSON(env, "memories", all.slice(-MAX_MEMORIES));
  },
  putMemories: (env: Env, m: Memory[]) => putJSON(env, "memories", m.slice(-MAX_MEMORIES)),

  getOverrides: (env: Env) => getJSON<Overrides>(env, "settings", {}),
  putOverrides: (env: Env, o: Overrides) => putJSON(env, "settings", o),

  getCharacter: (env: Env) => getJSON<Character | null>(env, "character", null),
  putCharacter: (env: Env, c: Character) => putJSON(env, "character", c),
  deleteCharacter: (env: Env) => env.STORE.delete("character"),

  getChatContext: (env: Env) => getJSON<ChatContext | null>(env, "chatContext", null),
  putChatContext: (env: Env, c: ChatContext) => putJSON(env, "chatContext", c),
};

export function newId(): string {
  return crypto.randomUUID();
}
