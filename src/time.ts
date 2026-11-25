// 时区工具：Workers 里没有本地时区，所有“几点几分”都按设置里的 TIMEZONE 换算。

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(date: Date, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 把“某时区的本地时间”换成真正的时刻。day 可以溢出（比如 day+1 表示明天）。 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = offsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = offsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

export function localDateKey(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function localMinutes(date: Date, tz: string): number {
  const p = localParts(date, tz);
  return p.hour * 60 + p.minute;
}

/** 给人看的中文时间，例如 “2026年11月25日 星期三 21:30” */
export function formatLocal(date: Date, tz: string, withTime = true): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  };
  if (withTime) Object.assign(opts, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return new Intl.DateTimeFormat("zh-CN", opts).format(date);
}

/** "21:30" → 1290（分钟）。格式不对返回 null。 */
export function parseHM(s: string): number | null {
  const m = /^\s*(\d{1,2})[:：](\d{2})\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** "09:00-23:00" → [540, 1380]。允许跨午夜，比如 "23:00-07:00"。 */
export function parseRange(s: string): [number, number] | null {
  const parts = s.split(/[-~～—–]/);
  if (parts.length !== 2) return null;
  const a = parseHM(parts[0]);
  const b = parseHM(parts[1]);
  if (a === null || b === null || a === b) return null;
  return [a, b];
}

export function inRange(min: number, range: [number, number]): boolean {
  const [a, b] = range;
  return a < b ? min >= a && min < b : min >= a || min < b;
}

export function randomBetween(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** “3 天 4 小时” 这种给模型看的间隔 */
export function humanGap(ms: number): string {
  const hours = Math.max(0, Math.round(ms / 3_600_000));
  if (hours < 1) return "不到一小时";
  if (hours < 24) return `${hours} 小时`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d} 天 ${h} 小时` : `${d} 天`;
}
