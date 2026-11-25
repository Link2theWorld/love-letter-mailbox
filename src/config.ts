// 设置 = wrangler.jsonc 里的 vars（默认值） + 管理页里保存到 KV 的覆盖值。
// 密钥（LLM_API_KEY / ADMIN_TOKEN）只从 secret 读，永远不进 KV、不回传给页面。

export type ScheduleMode = "auto" | "daily" | "random";
export type LlmProvider = "anthropic" | "openai" | "mock";

export interface Settings {
  senderEmail: string;
  senderName: string;
  recipientEmail: string;
  userName: string;
  userPersona: string;
  timezone: string;
  scheduleMode: ScheduleMode;
  dailyTime: string;
  randomWindow: string;
  autoMinHours: number;
  autoMaxHours: number;
  quietHours: string;
  replyDelayMinutes: string;
  letterLanguage: string;
  letterLength: string;
  togetherSince: string;
  specialDates: string;
  extraInstructions: string;
  historyInPrompt: number;
  requireDmarc: boolean;
  paused: boolean;
  llmProvider: LlmProvider;
  llmModel: string;
  llmBaseUrl: string;
  llmEffort: string;
  llmRefusalFallback: boolean;
  llmTemperature: number;
}

type FieldType = "string" | "text" | "number" | "bool" | "select";

export interface FieldDef {
  key: keyof Settings;
  env: string;
  label: string;
  type: FieldType;
  def: string | number | boolean;
  options?: string[];
  help?: string;
  group: "收发信" | "节奏" | "信的内容" | "模型";
  /** 改了这些字段要重新排期 */
  reschedule?: boolean;
}

export const FIELDS: FieldDef[] = [
  { key: "senderEmail", env: "SENDER_EMAIL", label: "发件地址", type: "string", def: "", group: "收发信", help: "必须在开了 Email Routing 的域名下" },
  { key: "senderName", env: "SENDER_NAME", label: "发件人名字", type: "string", def: "", group: "收发信", help: "留空则用角色名" },
  { key: "recipientEmail", env: "RECIPIENT_EMAIL", label: "收件地址", type: "string", def: "", group: "收发信", help: "必须是 Email Routing 里已验证的目标地址" },
  { key: "requireDmarc", env: "REQUIRE_DMARC", label: "回信需通过 DMARC", type: "bool", def: true, group: "收发信", help: "防止别人冒充你的邮箱回信" },
  { key: "userName", env: "USER_NAME", label: "角色怎么称呼你", type: "string", def: "", group: "信的内容", help: "替换角色卡里的 {{user}}" },
  { key: "userPersona", env: "USER_PERSONA", label: "关于你（给角色看的）", type: "text", def: "", group: "信的内容", help: "你的近况、喜好、你们的关系设定等" },
  { key: "letterLanguage", env: "LETTER_LANGUAGE", label: "写信语言", type: "string", def: "简体中文", group: "信的内容" },
  { key: "letterLength", env: "LETTER_LENGTH", label: "篇幅", type: "string", def: "400 到 800 字", group: "信的内容" },
  { key: "togetherSince", env: "TOGETHER_SINCE", label: "在一起的日子", type: "string", def: "", group: "信的内容", help: "YYYY-MM-DD，用来算“在一起第 N 天”" },
  { key: "specialDates", env: "SPECIAL_DATES", label: "特别的日子", type: "text", def: "", group: "信的内容", help: "每行一个：MM-DD 或 YYYY-MM-DD 加说明，例如 “03-14 我的生日”" },
  { key: "extraInstructions", env: "EXTRA_INSTRUCTIONS", label: "额外要求", type: "text", def: "", group: "信的内容" },
  { key: "historyInPrompt", env: "HISTORY_IN_PROMPT", label: "参考最近几封信", type: "number", def: 6, group: "信的内容" },
  { key: "timezone", env: "TIMEZONE", label: "时区", type: "string", def: "Asia/Shanghai", group: "节奏", reschedule: true },
  { key: "scheduleMode", env: "SCHEDULE_MODE", label: "写信节奏", type: "select", options: ["auto", "daily", "random"], def: "auto", group: "节奏", reschedule: true, help: "auto 角色自己决定 / daily 每天固定时间 / random 每天时间窗内随机" },
  { key: "dailyTime", env: "DAILY_TIME", label: "daily：几点写", type: "string", def: "21:30", group: "节奏", reschedule: true },
  { key: "randomWindow", env: "RANDOM_WINDOW", label: "random：时间窗", type: "string", def: "09:00-23:00", group: "节奏", reschedule: true },
  { key: "autoMinHours", env: "AUTO_MIN_HOURS", label: "auto：最短间隔（小时）", type: "number", def: 6, group: "节奏", reschedule: true },
  { key: "autoMaxHours", env: "AUTO_MAX_HOURS", label: "auto：最长间隔（小时）", type: "number", def: 72, group: "节奏", reschedule: true },
  { key: "quietHours", env: "QUIET_HOURS", label: "勿扰时段", type: "string", def: "01:00-07:30", group: "节奏", help: "auto 模式和回信不会在这段时间发；留空表示不限制" },
  { key: "replyDelayMinutes", env: "REPLY_DELAY_MINUTES", label: "收到回信后多久回（分钟）", type: "string", def: "30-180", group: "节奏", help: "填 off 表示只记住，下一封信再回应" },
  { key: "paused", env: "PAUSED", label: "暂停自动写信", type: "bool", def: false, group: "节奏" },
  { key: "llmProvider", env: "LLM_PROVIDER", label: "模型接口", type: "select", options: ["anthropic", "openai", "mock"], def: "anthropic", group: "模型", help: "openai = 任何 OpenAI 兼容接口；mock = 不调用模型的测试信" },
  { key: "llmModel", env: "LLM_MODEL", label: "模型", type: "string", def: "claude-opus-5-5", group: "模型" },
  { key: "llmBaseUrl", env: "LLM_BASE_URL", label: "Base URL", type: "string", def: "", group: "模型", help: "anthropic 留空即官方；openai 兼容接口填到 /v1 为止" },
  { key: "llmEffort", env: "LLM_EFFORT", label: "思考力度（Claude）", type: "select", options: ["low", "medium", "high", "xhigh", "max"], def: "high", group: "模型" },
  { key: "llmRefusalFallback", env: "LLM_REFUSAL_FALLBACK", label: "拒答时自动换模型重试（Claude）", type: "bool", def: true, group: "模型", help: "用第三方中转或旧模型报 400 时关掉" },
  { key: "llmTemperature", env: "LLM_TEMPERATURE", label: "temperature（仅 openai 兼容）", type: "number", def: 0.9, group: "模型" },
];

export type Overrides = Partial<Record<keyof Settings, unknown>>;

function coerce(field: FieldDef, raw: unknown): string | number | boolean {
  if (raw === undefined || raw === null || raw === "") {
    // 字符串类允许显式设为空；数字/布尔/选项退回默认值
    return field.type === "string" || field.type === "text" ? (raw === "" ? "" : field.def) : field.def;
  }
  switch (field.type) {
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : field.def;
    }
    case "bool":
      if (typeof raw === "boolean") return raw;
      return /^(1|true|yes|on)$/i.test(String(raw).trim());
    case "select": {
      const v = String(raw).trim();
      return field.options?.includes(v) ? v : field.def;
    }
    default:
      return String(raw);
  }
}

export function resolveSettings(env: Env, overrides: Overrides): Settings {
  const vars = env as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    const raw = f.key in overrides ? overrides[f.key] : vars[f.env];
    out[f.key] = coerce(f, raw);
  }
  const s = out as unknown as Settings;
  if (s.autoMaxHours < s.autoMinHours) s.autoMaxHours = s.autoMinHours;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone });
  } catch {
    s.timezone = "Asia/Shanghai";
  }
  return s;
}

/** 只保留认识的字段，过滤掉密钥之类的东西 */
export function sanitizeOverrides(input: Record<string, unknown>): Overrides {
  const out: Overrides = {};
  for (const f of FIELDS) {
    if (f.key in input) {
      const v = input[f.key];
      if (v === null) continue; // null = 恢复默认，不写入
      out[f.key] = coerce(f, v);
    }
  }
  return out;
}

export function secret(env: Env, name: "LLM_API_KEY" | "ADMIN_TOKEN"): string {
  const v = (env as unknown as Record<string, unknown>)[name];
  return typeof v === "string" ? v.trim() : "";
}
