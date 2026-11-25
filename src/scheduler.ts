// 决定“下一封信什么时候写”。

import type { Settings } from "./config";
import type { State, Trigger } from "./store";
import {
  inRange,
  localDateKey,
  localMinutes,
  localParts,
  parseHM,
  parseRange,
  randomBetween,
  zonedToUtc,
} from "./time";

export interface NextPlan {
  at: Date;
  reason: string;
  kind: Trigger;
}

const HOUR = 3_600_000;
const MIN = 60_000;

/** 如果落在勿扰时段里，就推到勿扰结束后的 0~45 分钟 */
export function avoidQuiet(at: Date, cfg: Settings): Date {
  const range = parseRange(cfg.quietHours);
  if (!range) return at;
  const tz = cfg.timezone;
  const mins = localMinutes(at, tz);
  if (!inRange(mins, range)) return at;
  const [start, end] = range;
  const p = localParts(at, tz);
  const dayOffset = start > end && mins >= start ? 1 : 0; // 跨午夜的勿扰时段，晚上那段要推到明天
  const endAt = zonedToUtc(p.year, p.month, p.day + dayOffset, Math.floor(end / 60), end % 60, tz);
  return new Date(endAt.getTime() + randomBetween(0, 45) * MIN);
}

function atLocal(now: Date, cfg: Settings, dayOffset: number, minutes: number): Date {
  const p = localParts(now, cfg.timezone);
  return zonedToUtc(p.year, p.month, p.day + dayOffset, Math.floor(minutes / 60), minutes % 60, cfg.timezone);
}

export function planNext(
  cfg: Settings,
  now: Date,
  state: State,
  ai?: { hours?: number; reason?: string },
): NextPlan {
  const tz = cfg.timezone;

  if (cfg.scheduleMode === "daily") {
    const m = parseHM(cfg.dailyTime) ?? 21 * 60 + 30;
    let at = atLocal(now, cfg, 0, m);
    if (at.getTime() <= now.getTime() + MIN) at = atLocal(now, cfg, 1, m);
    return { at, reason: `每天 ${cfg.dailyTime} 的信`, kind: "schedule" };
  }

  if (cfg.scheduleMode === "random") {
    let [ws, we] = parseRange(cfg.randomWindow) ?? [9 * 60, 23 * 60];
    if (ws > we) [ws, we] = [0, 24 * 60 - 1]; // 随机窗口不支持跨午夜，退回全天
    const sentToday = state.lastSentAt && localDateKey(new Date(state.lastSentAt), tz) === localDateKey(now, tz);
    const nowMin = localMinutes(now, tz);
    const from = Math.max(ws, nowMin + 10);
    if (!sentToday && from < we) {
      return { at: atLocal(now, cfg, 0, Math.floor(randomBetween(from, we))), reason: "今天的随机时刻", kind: "schedule" };
    }
    return { at: atLocal(now, cfg, 1, Math.floor(randomBetween(ws, we))), reason: "明天的随机时刻", kind: "schedule" };
  }

  // auto：角色自己决定
  const min = Math.max(0.5, cfg.autoMinHours);
  const max = Math.max(min, cfg.autoMaxHours);
  if (!state.lastSentAt && !ai) {
    const at = avoidQuiet(new Date(now.getTime() + randomBetween(0.5, 2) * HOUR), cfg);
    return { at, reason: "第一封信", kind: "first" };
  }
  let hours: number;
  let reason: string;
  if (ai?.hours !== undefined && Number.isFinite(ai.hours)) {
    hours = Math.min(max, Math.max(min, ai.hours));
    reason = ai.reason || `TA 想过 ${Math.round(hours)} 小时再写`;
  } else {
    hours = randomBetween(min, Math.min(max, min + (max - min) / 2));
    reason = "随心";
  }
  const at = avoidQuiet(new Date(now.getTime() + hours * HOUR), cfg);
  return { at, reason, kind: "schedule" };
}

/** 收到回信后，把下一封信提前。返回 null 表示不提前。 */
export function planAfterReply(cfg: Settings, now: Date, state: State): NextPlan | null {
  if (/^\s*off\s*$/i.test(cfg.replyDelayMinutes)) return null;
  const m = /^\s*(\d+)\s*(?:[-~～]\s*(\d+))?\s*$/.exec(cfg.replyDelayMinutes);
  const a = m ? Number(m[1]) : 30;
  const b = m?.[2] ? Number(m[2]) : a;
  const at = avoidQuiet(new Date(now.getTime() + randomBetween(Math.min(a, b), Math.max(a, b)) * MIN), cfg);
  if (state.nextAt && Date.parse(state.nextAt) <= at.getTime()) return null; // 本来就会更早写
  return { at, reason: "收到了你的回信", kind: "reply" };
}
