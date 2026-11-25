// 发信（Cloudflare Email Service 的 send_email 绑定）和收回信（Email Routing → Worker）。

import PostalMime from "postal-mime";
import type { Settings } from "./config";
import { formatLocal } from "./time";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 信纸样式。邮件客户端对 <style> 支持不一，所以全部写成行内样式。 */
export function renderLetterHtml(subject: string, body: string, date: string): string {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 1.15em 0;line-height:1.95;text-indent:0;white-space:normal;">${esc(p).replace(/\n/g, "<br>")}</p>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#efe9df;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe9df;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fffdf8;border:1px solid #e4dccd;border-radius:6px;box-shadow:0 1px 3px rgba(80,60,30,.08);">
<tr><td style="padding:40px 36px 36px 36px;font-family:'Songti SC','STSong','Noto Serif SC','Source Han Serif SC',Georgia,serif;font-size:16px;color:#3b3329;">
<div style="font-size:13px;letter-spacing:.08em;color:#a0907a;margin-bottom:26px;">${esc(date)}</div>
${paragraphs}
</td></tr>
</table>
<div style="font-family:-apple-system,'PingFang SC',sans-serif;font-size:12px;color:#a89c8a;margin-top:14px;">直接回复这封邮件，TA 会收到。</div>
</td></tr>
</table>
</body></html>`;
}

export async function sendLetter(
  env: Env,
  cfg: Settings,
  charName: string,
  subject: string,
  body: string,
  now: Date,
  fromName?: string,
): Promise<string> {
  if (!cfg.senderEmail || !cfg.recipientEmail) throw new Error("还没有设置发件地址或收件地址");
  const date = formatLocal(now, cfg.timezone, false);
  const res = await env.EMAIL.send({
    from: { email: cfg.senderEmail, name: fromName || cfg.senderName || charName },
    to: cfg.recipientEmail,
    subject,
    text: `${date}\n\n${body}\n`,
    html: renderLetterHtml(subject, body, date),
  });
  return res.messageId;
}

export interface InboundReply {
  subject: string;
  text: string;
}

/**
 * 处理你回过来的信。只接受来自收件地址、并且通过 DMARC 的邮件，其他一律拒收。
 * 返回 null 表示已拒收。
 */
export async function readInbound(
  message: ForwardableEmailMessage,
  cfg: Settings,
): Promise<InboundReply | null> {
  const from = message.from.trim().toLowerCase();
  if (!cfg.recipientEmail || from !== cfg.recipientEmail.trim().toLowerCase()) {
    message.setReject("Unknown sender");
    return null;
  }

  const email = await PostalMime.parse(message.raw);

  if (cfg.requireDmarc) {
    // 只信任 Cloudflare 自己加在最上面的那条 Authentication-Results
    const auth = email.headers.find(
      (h) => h.key === "authentication-results" && /^\s*mx\.cloudflare\.net\b/i.test(h.value),
    );
    if (!auth || !/\bdmarc=pass\b/i.test(auth.value)) {
      message.setReject("DMARC check failed");
      return null;
    }
  }

  const raw = email.text ?? (email.html ? htmlToText(email.html) : "");
  return { subject: (email.subject ?? "").trim(), text: stripQuoted(raw).slice(0, 6000) };
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 去掉回复里引用的原信 */
export function stripQuoted(text: string): string {
  const markers = [
    /^On .+wrote:\s*$/i,
    /^在.+写道[:：]\s*$/,
    /^.+于.+写道[:：]\s*$/,
    /^-{2,}\s*(Original Message|原始邮件|回复的原邮件)\s*-{2,}/i,
    /^(From|发件人)[:：]\s/i,
    /^_{5,}\s*$/,
  ];
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (markers.some((m) => m.test(line.trim()))) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
