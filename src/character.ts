// 读取酒馆（SillyTavern）角色卡：支持 V1 / V2 / V3 的 JSON，以及把 JSON 藏在 PNG 里的卡。

export interface Character {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  lore: string[];
  source: "default" | "json" | "png";
  importedAt: string;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const LORE_BUDGET = 6000; // 世界书最多塞多少字，避免把 prompt 撑爆

export function parseCard(input: unknown, source: Character["source"]): Character {
  if (!input || typeof input !== "object") throw new Error("角色卡不是 JSON 对象");
  const root = input as Json;
  // V2/V3：真正的字段在 data 里；V1：在顶层
  const d = (root.data && typeof root.data === "object" ? root.data : root) as Json;
  const name = str(d.name).trim() || str(root.name).trim();
  if (!name) throw new Error("角色卡里没有 name 字段");

  const lore: string[] = [];
  const book = d.character_book as Json | undefined;
  const entries = Array.isArray(book?.entries) ? (book!.entries as Json[]) : [];
  // 常驻条目优先，其余按顺序，超出预算就停
  const sorted = [...entries]
    .filter((e) => e && e.enabled !== false && str(e.content).trim())
    .sort((a, b) => Number(Boolean(b.constant)) - Number(Boolean(a.constant)));
  let used = 0;
  for (const e of sorted) {
    const c = str(e.content).trim();
    if (used + c.length > LORE_BUDGET) break;
    lore.push(c);
    used += c.length;
  }

  return {
    name,
    description: str(d.description),
    personality: str(d.personality),
    scenario: str(d.scenario),
    firstMes: str(d.first_mes),
    mesExample: str(d.mes_example),
    systemPrompt: str(d.system_prompt),
    postHistoryInstructions: str(d.post_history_instructions),
    lore,
    source,
    importedAt: new Date().toISOString(),
  };
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** PNG 文本块是 Latin-1；base64 本身是 ASCII，所以逐字节转字符就够了 */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

/** 从 PNG 的 tEXt / iTXt 块里找 ccv3（V3）或 chara（V2）字段 */
export function extractPngCard(buf: ArrayBuffer): unknown {
  const bytes = new Uint8Array(buf);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || sig.some((b, i) => bytes[i] !== b)) throw new Error("不是 PNG 文件");
  const view = new DataView(buf);
  const found: Record<string, string> = {};
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = latin1(bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "tEXt" || type === "iTXt") {
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = latin1(data.subarray(0, nul)).toLowerCase();
        if (keyword === "chara" || keyword === "ccv3") {
          if (type === "tEXt") {
            found[keyword] = latin1(data.subarray(nul + 1));
          } else {
            // iTXt: keyword\0 flag method lang\0 translated\0 text（只支持未压缩）
            const compressed = data[nul + 1] === 1;
            let p = nul + 3;
            p = data.indexOf(0, p) + 1;
            p = data.indexOf(0, p) + 1;
            if (!compressed && p > 0) found[keyword] = new TextDecoder().decode(data.subarray(p));
          }
        }
      }
    }
    if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = found.ccv3 ?? found.chara;
  if (!raw) throw new Error("这张 PNG 里没有找到角色卡数据（chara / ccv3）");
  return JSON.parse(base64ToUtf8(raw));
}

/** 替换酒馆常用宏 */
export function applyMacros(text: string, charName: string, userName: string): string {
  return text
    .replace(/\{\{char\}\}|<BOT>/gi, charName)
    .replace(/\{\{user\}\}|<USER>/gi, userName)
    .replace(/\{\{original\}\}/gi, "")
    .trim();
}
