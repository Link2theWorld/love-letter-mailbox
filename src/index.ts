import adminHtml from "./admin.html";
import { FIELDS, sanitizeOverrides, secret } from "./config";
import { extractPngCard, parseCard } from "./character";
import { compose, handleInbound, loadCharacter, loadSettings, reschedule, sendNow, tick } from "./letters";
import { store } from "./store";

// 酒馆插件跑在浏览器里、和 Worker 不同源，所以 API 要允许跨域。
// 所有接口都要 Bearer 口令，不靠 cookie，放开来源不会让别人绕过鉴权。
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-from-admin",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });

const fail = (status: number, error: string) => json({ error }, status);

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

async function authorized(req: Request, env: Env): Promise<boolean> {
  const token = secret(env, "ADMIN_TOKEN");
  if (!token) return false; // 没设置 ADMIN_TOKEN 就关闭所有管理接口
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!given) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(token)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

async function api(req: Request, env: Env, path: string): Promise<Response> {
  const now = new Date();
  const method = req.method;

  if (path === "/api/status" && method === "GET") {
    const [cfg, overrides, state, char, letters, replies, memories, chat] = await Promise.all([
      loadSettings(env),
      store.getOverrides(env),
      store.getState(env),
      loadCharacter(env),
      store.getLetters(env),
      store.getReplies(env),
      store.getMemories(env),
      store.getChatContext(env),
    ]);
    const { pending, ...publicState } = state;
    return json({
      settings: cfg,
      overrides,
      fields: FIELDS,
      state: { ...publicState, pendingSubject: pending?.subject },
      character: { name: char.name, source: char.source, importedAt: char.importedAt },
      counts: { letters: letters.length, replies: replies.length, unanswered: replies.filter((r) => !r.answered).length, memories: memories.length },
      hasLlmKey: Boolean(secret(env, "LLM_API_KEY")),
      chat: chat ? { updatedAt: chat.updatedAt, character: chat.character, count: chat.messages.length } : null,
    });
  }

  if (path === "/api/settings" && method === "PUT") {
    const body = (await req.json()) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...(await store.getOverrides(env)) };
    for (const [k, v] of Object.entries(body)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    await store.putOverrides(env, sanitizeOverrides(merged));
    if (FIELDS.some((f) => f.reschedule && f.key in body)) await reschedule(env, now);
    return json({ ok: true, settings: await loadSettings(env) });
  }

  if (path === "/api/character" && method === "POST") {
    const type = req.headers.get("content-type") ?? "";
    const buf = await req.arrayBuffer();
    let card: unknown;
    let source: "json" | "png";
    if (type.includes("png") || new Uint8Array(buf.slice(0, 4)).join() === "137,80,78,71") {
      card = extractPngCard(buf);
      source = "png";
    } else {
      card = JSON.parse(new TextDecoder().decode(buf));
      source = "json";
    }
    const char = parseCard(card, source);
    await store.putCharacter(env, char);
    return json({ ok: true, name: char.name, loreEntries: char.lore.length });
  }

  if (path === "/api/character" && method === "DELETE") {
    await store.deleteCharacter(env);
    return json({ ok: true });
  }

  if (path === "/api/letters" && method === "GET") {
    const limit = Number(new URL(req.url).searchParams.get("limit")) || 1000;
    const [letters, replies, memories] = await Promise.all([store.getLetters(env), store.getReplies(env), store.getMemories(env)]);
    return json({
      letters: letters.reverse().slice(0, limit),
      replies: replies.reverse().slice(0, limit),
      memories: memories.reverse().slice(0, limit),
    });
  }

  // 酒馆插件同步最近的聊天，定时写信时当背景
  if (path === "/api/chat-context" && method === "PUT") {
    const body = (await req.json()) as { character?: unknown; messages?: unknown };
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
      .map((m) => ({
        name: String(m.name ?? "").slice(0, 60),
        isUser: Boolean(m.isUser),
        text: String(m.text ?? "").trim().slice(0, 1200),
        at: m.at ? String(m.at).slice(0, 60) : undefined,
      }))
      .filter((m) => m.text)
      .slice(-40);
    await store.putChatContext(env, {
      updatedAt: now.toISOString(),
      character: typeof body.character === "string" ? body.character.slice(0, 60) : undefined,
      messages,
    });
    return json({ ok: true, saved: messages.length });
  }

  if (path === "/api/chat-context" && method === "DELETE") {
    await env.STORE.delete("chatContext");
    return json({ ok: true });
  }

  if (path === "/api/memories" && method === "PUT") {
    const body = (await req.json()) as { memories?: { at: string; text: string }[] };
    await store.putMemories(env, (body.memories ?? []).filter((m) => m && typeof m.text === "string" && m.text.trim()));
    return json({ ok: true });
  }

  if (path === "/api/preview" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { hint?: string; context?: string };
    const cfg = await loadSettings(env);
    const { composed, prompt } = await compose(env, cfg, now, "manual", { hint: body.hint, context: body.context });
    return json({ composed, prompt });
  }

  // 现在写一封寄出去。body 里给了 subject+body 就直接寄（给酒馆插件 / 别的 AI 用），否则让模型写。
  if (path === "/api/letter" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      hint?: string;
      context?: string;
      subject?: string;
      body?: string;
      fromName?: string;
    };
    const raw =
      typeof body.body === "string" && body.body.trim()
        ? { subject: (body.subject ?? "").trim() || `${(await loadCharacter(env)).name}的信`, body: body.body.trim() }
        : undefined;
    const fromAdmin = req.headers.get("x-from-admin") === "1";
    const fromName = typeof body.fromName === "string" ? body.fromName.trim().slice(0, 60) || undefined : undefined;
    const letter = await sendNow(env, now, fromAdmin ? "manual" : "api", { hint: body.hint, context: body.context, raw, fromName });
    return json({ ok: true, letter });
  }

  if (path === "/api/reschedule" && method === "POST") {
    return json({ ok: true, state: await reschedule(env, now) });
  }

  if (path === "/api/tick" && method === "POST") {
    return json({ ok: true, result: await tick(env, now) });
  }

  return fail(404, "not found");
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(adminHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
        },
      });
    }
    if (!url.pathname.startsWith("/api/")) return fail(404, "not found");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!(await authorized(req, env))) return fail(401, "ADMIN_TOKEN 不对，或者还没有设置 ADMIN_TOKEN");
    try {
      return await api(req, env, url.pathname);
    } catch (err) {
      console.error(err);
      return fail(500, errMessage(err));
    }
  },

  async scheduled(controller, env): Promise<void> {
    const result = await tick(env, new Date(controller.scheduledTime));
    if (result !== "not yet") console.log("tick:", result);
  },

  async email(message, env): Promise<void> {
    await handleInbound(message, env);
  },
} satisfies ExportedHandler<Env>;
