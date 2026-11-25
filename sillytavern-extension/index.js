// 信箱 —— SillyTavern 扩展
// 让聊天里的角色可以通过函数调用，用情书 Worker 给你寄一封真正的邮件；
// 也可以把最近的聊天同步给 Worker，让定时寄来的信接得上你们聊过的事。

const MODULE = 'love_letter_mailbox';
const TOOL = 'send_letter_by_email';
const TOKEN_KEY = 'love_letter_mailbox_token'; // 口令只存在这个浏览器的 localStorage，不进酒馆的设置文件
const PROMPT_KEY = 'love_letter_mailbox';
const LOG = '[信箱]';

// setExtensionPrompt 的常量（SillyTavern script.js 里的 extension_prompt_types / roles）
const POSITION_IN_PROMPT = 0;
const ROLE_SYSTEM = 0;

const DEFAULTS = Object.freeze({
    enabled: true,
    workerUrl: '',
    mode: 'self', // self = 聊天里的 TA 亲手写；worker = 交给 Worker 里的 TA 慢慢写
    onlyCharacter: '',
    cooldownHours: 3,
    injectLetters: true,
    syncChat: false,
    syncCount: 20,
    lastToolLetterAt: 0,
});

const SYNC_INTERVAL_MS = 10 * 60_000;
const INJECT_TTL_MS = 5 * 60_000;

const ctx = () => SillyTavern.getContext();

function S() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(DEFAULTS);
    const s = extensionSettings[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) if (!Object.hasOwn(s, k)) s[k] = v;
    return s;
}

const save = () => ctx().saveSettingsDebounced();
const token = () => localStorage.getItem(TOKEN_KEY) || '';

/** 当前聊天是否应该启用（有地址、有口令、角色匹配） */
function active() {
    const s = S();
    if (!s.enabled || !s.workerUrl.trim() || !token()) return false;
    const only = s.onlyCharacter.trim();
    if (!only) return true;
    const c = ctx();
    if (c.groupId) return false;
    return String(c.name2 || '').trim() === only;
}

async function api(path, { method = 'GET', body } = {}) {
    const base = S().workerUrl.trim().replace(/\/+$/, '');
    if (!base) throw new Error('还没有填写 Worker 地址');
    if (!token()) throw new Error('还没有填写管理口令');
    let res;
    try {
        res = await fetch(base + path, {
            method,
            headers: {
                authorization: 'Bearer ' + token(),
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    } catch (e) {
        throw new Error('连不上 Worker（地址不对，或者网络不通）');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

// ---------- 聊天内容 ----------

function recentChat(n) {
    const { chat, name1, name2 } = ctx();
    return (chat || [])
        .filter((m) => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim())
        .slice(-n)
        .map((m) => ({
            name: m.is_user ? (name1 || m.name || '我') : (m.name || name2 || ''),
            isUser: Boolean(m.is_user),
            text: m.mes.trim().slice(0, 1200),
            at: m.send_date ? String(m.send_date) : undefined,
        }));
}

const chatAsText = (n) => recentChat(n).map((m) => `${m.name}：${m.text}`).join('\n');

// ---------- 函数调用工具 ----------

const WHEN = '适合用的时候：对方说想收到你的信；或者聊天里发生了值得郑重写下来的事，比如纪念日、对方难过需要安慰、你们要暂时分开、你有很多话想慢慢说。不要在普通闲聊里用，也不要频繁使用。';

const TOOL_SELF = {
    description:
        '把一封你亲手写的信，用电子邮件真正寄到对方的邮箱里（对方会在自己的邮箱收到）。' +
        WHEN +
        '信要用你自己的口吻写，像一封真正的信：有称呼、有分段、有署名，比聊天消息更完整、更认真。' +
        '寄出后，在聊天里自然地提一句寄了信就好，不要把信的内容再说一遍。',
    parameters: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            subject: { type: 'string', description: '信的标题，像这封信的名字，不超过 30 个字' },
            letter: { type: 'string', description: '信的完整正文。段落之间空一行，结尾署名。' },
        },
        required: ['subject', 'letter'],
    },
};

const TOOL_WORKER = {
    description:
        '给对方寄一封真正的电子邮件信件（对方会在自己的邮箱收到）。' +
        '信会在一个安静的时刻由你慢慢写好再寄出，这里只需要说明为什么现在想写、想在信里说些什么。' +
        WHEN +
        '寄出后，在聊天里自然地提一句寄了信就好。',
    parameters: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            reason: { type: 'string', description: '为什么现在想写这封信、想在信里说什么（一两句话）' },
        },
        required: ['reason'],
    },
};

async function sendFromTool(args) {
    const s = S();
    const hours = (Date.now() - (s.lastToolLetterAt || 0)) / 3_600_000;
    if (hours < s.cooldownHours) {
        return `没有寄出：距离上一封信才 ${hours.toFixed(1)} 小时，太频繁了。请在聊天里告诉对方，过一阵再给 TA 写。`;
    }
    const c = ctx();
    const body =
        s.mode === 'self'
            ? { subject: String(args?.subject ?? '').trim(), body: String(args?.letter ?? '').trim(), fromName: c.name2 }
            : { hint: String(args?.reason ?? '').trim(), context: chatAsText(20) };
    if (s.mode === 'self' && !body.body) return '没有寄出：信的正文是空的。';
    try {
        const r = await api('/api/letter', { method: 'POST', body });
        s.lastToolLetterAt = Date.now();
        save();
        toastr.success(`《${r.letter.subject}》已经寄出`, '信箱');
        refreshInjection(true);
        return s.mode === 'self'
            ? `信已经寄到对方的邮箱了，标题是《${r.letter.subject}》。现在用你的口吻在聊天里自然地提一句，不要复述信的内容。`
            : `信已经寄到对方的邮箱了，标题是《${r.letter.subject}》。下面是这封信的内容，只是让你知道自己写了什么，不要在聊天里复述：\n\n${r.letter.body}\n\n现在用你的口吻在聊天里自然地提一句寄了信。`;
    } catch (e) {
        toastr.error(String(e.message || e), '信箱：寄信失败');
        return `没有寄出：${e.message || e}。请在聊天里告诉对方信暂时没寄出去。`;
    }
}

function registerTool() {
    const c = ctx();
    if (typeof c.registerFunctionTool !== 'function') {
        console.warn(LOG, '这个版本的 SillyTavern 不支持函数调用工具');
        return;
    }
    try {
        c.unregisterFunctionTool(TOOL);
    } catch { /* 第一次注册时还不存在 */ }
    const def = S().mode === 'self' ? TOOL_SELF : TOOL_WORKER;
    c.registerFunctionTool({
        name: TOOL,
        displayName: '寄一封信',
        description: def.description,
        parameters: def.parameters,
        action: sendFromTool,
        formatMessage: () => '正在寄信…',
        shouldRegister: () => active(),
        stealth: false,
    });
}

// ---------- 让聊天里的 TA 知道最近的信 ----------

let injectCache = { at: 0, key: '', text: '' };

function fmt(iso, tz) {
    if (!iso) return '';
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            timeZone: tz || undefined, month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(new Date(iso));
    } catch {
        return new Date(iso).toLocaleString();
    }
}

const clip = (t, n) => (t.length > n ? t.slice(0, n).replace(/\s+/g, ' ') + '……' : t.replace(/\s+/g, ' '));

function buildInjection(status, hist) {
    const tz = status.settings?.timezone;
    const lines = ['[信箱] 除了聊天，你们之间还会通过电子邮件写信。'];
    if (hist.letters?.length) {
        lines.push('你最近寄出的信：');
        for (const l of hist.letters.slice(0, 3)) lines.push(`- ${fmt(l.at, tz)}《${l.subject}》：${clip(l.body, 120)}`);
    }
    const replies = (hist.replies || []).slice(0, 3);
    if (replies.length) {
        lines.push('对方最近的回信：');
        for (const r of replies) lines.push(`- ${fmt(r.at, tz)}：${clip(r.text, 160)}${r.answered ? '' : '（你还没在信里回应）'}`);
    }
    const st = status.state || {};
    if (st.nextAt && !status.settings?.paused) {
        lines.push(`下一封信你打算在 ${fmt(st.nextAt, tz)} 前后写${st.nextReason ? `（${st.nextReason}）` : ''}。`);
    }
    lines.push('聊到信的时候可以自然地提起，但不要整段复述信的内容。');
    return lines.join('\n');
}

async function refreshInjection(force = false) {
    const c = ctx();
    const s = S();
    if (!s.injectLetters || !active()) {
        c.setExtensionPrompt(PROMPT_KEY, '', POSITION_IN_PROMPT, 0, false, ROLE_SYSTEM);
        return;
    }
    const key = `${s.workerUrl}|${c.name2}`;
    if (!force && injectCache.key === key && Date.now() - injectCache.at < INJECT_TTL_MS) {
        c.setExtensionPrompt(PROMPT_KEY, injectCache.text, POSITION_IN_PROMPT, 0, false, ROLE_SYSTEM);
        return;
    }
    try {
        const [status, hist] = await Promise.all([api('/api/status'), api('/api/letters?limit=3')]);
        const text = buildInjection(status, hist);
        injectCache = { at: Date.now(), key, text };
        c.setExtensionPrompt(PROMPT_KEY, text, POSITION_IN_PROMPT, 0, false, ROLE_SYSTEM);
    } catch (e) {
        console.warn(LOG, '读取信件失败', e);
    }
}

// ---------- 把最近聊天同步给 Worker ----------

let syncTimer = null;
let lastSync = 0;

async function syncNow() {
    if (!active()) throw new Error('当前聊天没有启用信箱');
    const c = ctx();
    const messages = recentChat(S().syncCount);
    if (!messages.length) return 0;
    const r = await api('/api/chat-context', { method: 'PUT', body: { character: c.name2, messages } });
    lastSync = Date.now();
    return r.saved;
}

function scheduleSync() {
    if (!S().syncChat || !active() || syncTimer) return;
    // 至少等 15 秒，让角色的回复也写进聊天；两次同步之间至少隔 10 分钟
    const wait = Math.max(15_000, lastSync + SYNC_INTERVAL_MS - Date.now());
    syncTimer = setTimeout(async () => {
        syncTimer = null;
        if (!S().syncChat) return;
        try {
            await syncNow();
        } catch (e) {
            console.warn(LOG, '同步聊天失败', e);
        }
    }, wait);
}

// ---------- 手动操作 ----------

async function sendViaWorker(hint) {
    const r = await api('/api/letter', { method: 'POST', body: { hint: hint || undefined, context: chatAsText(20) } });
    toastr.success(`《${r.letter.subject}》已经寄出`, '信箱');
    refreshInjection(true);
    return r.letter;
}

async function askText(title, text) {
    const c = ctx();
    if (c.Popup?.show?.input) return c.Popup.show.input(title, text, '');
    return window.prompt(`${title}\n${text}`, '');
}

async function syncCharacter() {
    const c = ctx();
    const ch = c.characters?.[c.characterId];
    if (c.groupId || !ch) throw new Error('先打开一个单人角色的聊天');
    const data = Object.assign({}, ch.data || {}, {
        name: ch.name,
        description: ch.description,
        personality: ch.personality,
        scenario: ch.scenario,
        first_mes: ch.first_mes,
        mes_example: ch.mes_example,
    });
    const r = await api('/api/character', { method: 'POST', body: { spec: 'chara_card_v2', spec_version: '2.0', data } });
    const persona = c.powerUserSettings?.persona_description || '';
    await api('/api/settings', {
        method: 'PUT',
        body: { userName: c.name1 || '', ...(persona.trim() ? { userPersona: persona } : {}) },
    });
    return r;
}

// ---------- 设置面板 ----------

function settingsHtml() {
    return `
<div class="ll-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>信箱</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="ll_enabled"><span>启用</span></label>
      <div class="ll-field"><span>Worker 地址</span><input id="ll_url" class="text_pole" type="text" placeholder="https://love-letter.xxx.workers.dev"></div>
      <div class="ll-field"><span>管理口令（ADMIN_TOKEN）</span><input id="ll_token" class="text_pole" type="password" autocomplete="off"><small>只存在这个浏览器里，不会写进酒馆的设置文件。</small></div>
      <div class="ll-buttons"><div id="ll_test" class="menu_button">测试连接</div></div>
      <div id="ll_status" class="ll-status"></div>
      <hr>
      <div class="ll-field"><span>聊天里的 TA 寄信时</span>
        <select id="ll_mode" class="text_pole">
          <option value="self">在聊天里亲手写好，原样寄出</option>
          <option value="worker">只说想写什么，交给信箱里的 TA 慢慢写</option>
        </select>
      </div>
      <div class="ll-field"><span>只在和这个角色聊天时启用</span><input id="ll_only" class="text_pole" type="text" placeholder="留空表示所有角色"><small>填角色名，比如“林晚”。和信箱 Worker 里的角色对应。</small></div>
      <div class="ll-field"><span>两封信至少间隔（小时）</span><input id="ll_cooldown" class="text_pole" type="number" min="0" step="0.5"><small>只限制聊天里的 TA 主动寄信，不影响 Worker 的定时信。</small></div>
      <label class="checkbox_label"><input type="checkbox" id="ll_inject"><span>让聊天里的 TA 知道最近寄过的信和你的回信</span></label>
      <label class="checkbox_label"><input type="checkbox" id="ll_sync"><span>把最近的聊天同步给信箱（定时寄来的信会接上你们聊过的事）</span></label>
      <div class="ll-field"><span>同步最近几条消息</span><input id="ll_sync_count" class="text_pole" type="number" min="4" max="40" step="1"></div>
      <div class="ll-buttons">
        <div id="ll_send" class="menu_button">现在寄一封</div>
        <div id="ll_sync_now" class="menu_button">现在同步聊天</div>
        <div id="ll_card" class="menu_button">把当前角色卡同步到信箱</div>
      </div>
      <p class="ll-note">聊天里的 TA 要能自己寄信，需要用 Chat Completion 接口，并在“AI 回复配置”里打开 Enable function calling。也可以用 <code>/letter 想写什么</code> 让信箱里的 TA 现在写一封。</p>
    </div>
  </div>
</div>`;
}

function updateStatus(text, kind) {
    const el = document.getElementById('ll_status');
    if (!el) return;
    if (text !== undefined) {
        el.textContent = text;
        el.className = `ll-status ${kind || ''}`;
        return;
    }
    const c = ctx();
    const supported = typeof c.isToolCallingSupported === 'function' && c.isToolCallingSupported();
    el.textContent = supported
        ? '当前接口支持函数调用，聊天里的 TA 可以自己决定寄信。'
        : '当前接口不支持函数调用（或没打开 Enable function calling），聊天里的 TA 暂时不能自己寄信。';
    el.className = `ll-status ${supported ? 'ok' : 'warn'}`;
}

function bindSettings() {
    const s = S();
    const $id = (id) => document.getElementById(id);
    $id('ll_enabled').checked = s.enabled;
    $id('ll_url').value = s.workerUrl;
    $id('ll_token').value = token();
    $id('ll_mode').value = s.mode;
    $id('ll_only').value = s.onlyCharacter;
    $id('ll_cooldown').value = s.cooldownHours;
    $id('ll_inject').checked = s.injectLetters;
    $id('ll_sync').checked = s.syncChat;
    $id('ll_sync_count').value = s.syncCount;

    const changed = () => {
        injectCache.at = 0;
        refreshInjection(true);
    };
    $id('ll_enabled').addEventListener('change', (e) => { s.enabled = e.target.checked; save(); changed(); });
    $id('ll_url').addEventListener('change', (e) => { s.workerUrl = e.target.value.trim(); save(); changed(); });
    $id('ll_token').addEventListener('change', (e) => { localStorage.setItem(TOKEN_KEY, e.target.value.trim()); changed(); });
    $id('ll_mode').addEventListener('change', (e) => { s.mode = e.target.value; save(); registerTool(); });
    $id('ll_only').addEventListener('change', (e) => { s.onlyCharacter = e.target.value.trim(); save(); changed(); });
    $id('ll_cooldown').addEventListener('change', (e) => { s.cooldownHours = Math.max(0, Number(e.target.value) || 0); save(); });
    $id('ll_inject').addEventListener('change', (e) => { s.injectLetters = e.target.checked; save(); changed(); });
    $id('ll_sync').addEventListener('change', (e) => { s.syncChat = e.target.checked; save(); if (s.syncChat) scheduleSync(); });
    $id('ll_sync_count').addEventListener('change', (e) => { s.syncCount = Math.min(40, Math.max(4, Number(e.target.value) || 20)); save(); });

    $id('ll_test').addEventListener('click', async () => {
        updateStatus('连接中…');
        try {
            const st = await api('/api/status');
            const next = st.settings.paused ? '已暂停' : `下一封 ${fmt(st.state.nextAt, st.settings.timezone)}`;
            updateStatus(`连上了：信箱里是「${st.character.name}」，已寄 ${st.state.letterCount || 0} 封，${next}。`, 'ok');
            refreshInjection(true);
        } catch (e) {
            updateStatus(`连接失败：${e.message}`, 'warn');
        }
    });
    $id('ll_send').addEventListener('click', async () => {
        const hint = await askText('现在寄一封', '想让这封信写点什么？（可以留空）');
        if (hint === null || hint === false) return;
        try {
            toastr.info('信箱里的 TA 正在写信，可能要一两分钟…', '信箱');
            await sendViaWorker(String(hint || '').trim());
        } catch (e) {
            toastr.error(e.message, '信箱：寄信失败');
        }
    });
    $id('ll_sync_now').addEventListener('click', async () => {
        try {
            const n = await syncNow();
            toastr.success(`同步了 ${n} 条消息`, '信箱');
        } catch (e) {
            toastr.error(e.message, '信箱：同步失败');
        }
    });
    $id('ll_card').addEventListener('click', async () => {
        try {
            const r = await syncCharacter();
            toastr.success(`信箱里的角色换成了「${r.name}」，你的称呼和人设也同步了`, '信箱');
            refreshInjection(true);
        } catch (e) {
            toastr.error(e.message, '信箱：同步角色卡失败');
        }
    });
    updateStatus();
}

function registerSlashCommand() {
    const c = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = c;
    if (!SlashCommandParser || !SlashCommand) return;
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'letter',
            callback: async (_named, hint) => {
                try {
                    toastr.info('信箱里的 TA 正在写信…', '信箱');
                    const l = await sendViaWorker(String(hint ?? '').trim());
                    return l.subject;
                } catch (e) {
                    toastr.error(e.message, '信箱：寄信失败');
                    return '';
                }
            },
            unnamedArgumentList: SlashCommandArgument
                ? [SlashCommandArgument.fromProps({ description: '想让这封信写点什么（可选）', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })]
                : [],
            returns: '寄出的信的标题',
            helpString: '<div>让信箱里的 TA 现在写一封信，寄到你的邮箱。例如 <code>/letter 今天面试结束了</code></div>',
        }));
    } catch (e) {
        console.warn(LOG, '注册 /letter 失败', e);
    }
}

// ---------- 启动 ----------

let started = false;

async function init() {
    if (started) return;
    started = true;
    S();
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (container && !document.querySelector('.ll-settings')) {
        container.insertAdjacentHTML('beforeend', settingsHtml());
        bindSettings();
    }
    registerTool();
    registerSlashCommand();

    const c = ctx();
    const ev = c.eventTypes || c.event_types;
    c.eventSource.on(ev.CHAT_CHANGED, () => { refreshInjection(true); });
    c.eventSource.on(ev.MESSAGE_RECEIVED, () => { refreshInjection(false); scheduleSync(); });
    c.eventSource.on(ev.MESSAGE_SENT, () => { scheduleSync(); });
    for (const name of ['MAIN_API_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'SETTINGS_UPDATED']) {
        if (ev[name]) c.eventSource.on(ev[name], () => updateStatus());
    }
    refreshInjection(true);
}

(function start() {
    const c = ctx();
    const ev = c.eventTypes || c.event_types;
    // APP_READY 对晚注册的监听器也会再触发一次
    c.eventSource.on(ev.APP_READY, () => { init().catch((e) => console.error(LOG, e)); });
})();
