// 调用大模型。默认用 Anthropic 官方 SDK；也支持任何 OpenAI 兼容接口；mock 用来本地测试不花钱。

import Anthropic from "@anthropic-ai/sdk";
import { secret, type Settings } from "./config";

export async function generate(env: Env, cfg: Settings, system: string, user: string): Promise<string> {
  switch (cfg.llmProvider) {
    case "anthropic":
      return callAnthropic(env, cfg, system, user);
    case "openai":
      return callOpenAICompatible(env, cfg, system, user);
    case "mock":
      return mockLetter(user);
  }
}

async function callAnthropic(env: Env, cfg: Settings, system: string, user: string): Promise<string> {
  const apiKey = secret(env, "LLM_API_KEY");
  if (!apiKey) throw new Error("没有设置 LLM_API_KEY（npx wrangler secret put LLM_API_KEY）");
  const client = new Anthropic({ apiKey, baseURL: cfg.llmBaseUrl || undefined });

  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: cfg.llmModel,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: cfg.llmEffort as "low" | "medium" | "high" | "xhigh" | "max" },
  };
  if (cfg.llmRefusalFallback) {
    // 万一安全分类器误拒（比如信里情绪很重），服务端会自动换一个模型接着写
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  const res = await client.beta.messages.create(params);
  if (res.stop_reason === "refusal") {
    throw new Error(`模型拒绝了这次写信请求（${res.stop_details?.category ?? "未知原因"}）`);
  }
  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  if (!text) throw new Error(`模型没有返回文字（stop_reason=${res.stop_reason}）`);
  return text;
}

async function callOpenAICompatible(env: Env, cfg: Settings, system: string, user: string): Promise<string> {
  const apiKey = secret(env, "LLM_API_KEY");
  if (!apiKey) throw new Error("没有设置 LLM_API_KEY（npx wrangler secret put LLM_API_KEY）");
  const base = (cfg.llmBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: cfg.llmModel,
      temperature: cfg.llmTemperature,
      max_tokens: 8000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`模型接口返回 ${res.status}：${bodyText.slice(0, 300)}`);
  const data = JSON.parse(bodyText) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`模型没有返回文字：${bodyText.slice(0, 300)}`);
  return text;
}

/** 不调用模型，生成一封固定格式的测试信，用来检查发信、排期、回信流程 */
function mockLetter(user: string): string {
  const now = /现在是 (.+?)（/.exec(user)?.[1] ?? "现在";
  const replied = user.includes("★还没回应");
  const hours = 6 + Math.floor(Math.random() * 30);
  return `<subject>测试信 · ${now}</subject>
<letter>
见字如面。

这是一封测试信，用来确认 Worker 的定时、发信和记忆都正常。写信的时间是 ${now}。${replied ? "\n\n我收到你的回信了，谢谢你。" : ""}

等你换上真正的模型，我就会好好给你写信了。

—— 测试
</letter>
<memory></memory>
<plan>下次换上真正的模型再写</plan>
<next hours="${hours}">测试：随便选了 ${hours} 小时</next>`;
}
