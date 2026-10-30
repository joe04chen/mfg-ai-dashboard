/* ==========================================================================
   MFG AI Agent Command Center — app.js
   - 資料：優先走 Cloudflare Pages Function (/api/data，邊緣快取)，失敗才直連 Apps Script
   - 欄位：自動容忍「(⚠️模擬)」「(⚠️AI推算)」「(👁️未顯示)」後綴與空白差異
   - 語系：繁中 / English（?lang=en 可直接分享英文版連結）
   ========================================================================== */
'use strict';

const CONFIG = {
    API_PRIMARY: '',          // Cloudflare Drop 為純靜態託管，不支援 Functions，直接讀 Apps Script
    // Cloudflare Function 正常運作後，可把這行改成 '' 以完全隱藏 Apps Script 網址
    API_FALLBACK: 'https://script.google.com/macros/s/AKfycbxwBgMPQbNKtysHOjzA9tKRERQVczWc53z3nffOYoeZPBX_sslki2YL9kg7DYqcpQkK/exec',
    REFRESH_MS: 60_000,        // 輪詢間隔（原 10 秒會很快吃光 Apps Script 配額）
    STD_UNIT: 'min',          // 「标准工时」欄的單位：'H' 小時/件、'min' 分鐘/件、's' 秒/件
    EFF_MAX: 200,             // 效率超過此值視為單位設定錯誤，不顯示數字
    SHIFT_HOURS: 10,           // 無「时段计划产出」欄時，用來把整班計劃攤到各時段
    LATE_AFTER: '08:00:00',    // 打卡晚於此時間視為遲到
    // 全站統一燈號門檻 [正常下限, 預警下限]：≥正常下限=綠、介於中間=橘、低於預警下限=紅
    THRESHOLDS: {
        progress: [90, 60],      // 進度達成率（也用於每小時實際 vs 計劃）
        efficiency: [85, 70],
        yield: [98, 95],
        attendance: [95, 90],
        fulfil: [98, 90],        // 排程人力滿足率
        cert: [98, 90],          // 資質匹配率
        availability: [85, 60],  // 設備稼動率
        oee: [85, 60]
    },
    TABLE_LIMIT: 300
};

/* -------------------------------------------------------------------------- */
/* 基本工具                                                                    */
/* -------------------------------------------------------------------------- */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uniq = arr => [...new Set(arr.filter(v => v !== null && v !== undefined && v !== ''))];
const sumBy = (arr, fn) => arr.reduce((s, x) => s + (fn(x) || 0), 0);
const pct = (a, b) => (b > 0 && a !== null && a !== undefined) ? (a / b) * 100 : null;
const str = v => (v === null || v === undefined) ? '' : String(v).trim();
const cmpNat = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const n = parseFloat(String(v).replace(/[,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
}

const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 隱私模式 */ } }
};

/* 欄位讀取：去掉「(⚠️…)」「(👁️…)」後綴與空白後比對，可傳多個候選名 */
const KEY_INDEX = new WeakMap();
function normKey(k) {
    return String(k)
        .replace(/\s*[（(]\s*(?:⚠|👁)[^)）]*[)）]\s*/g, '')
        .replace(/\s+/g, '')
        .toLowerCase();
}
function F(row, ...names) {
    if (!row || typeof row !== 'object') return undefined;
    let idx = KEY_INDEX.get(row);
    if (!idx) {
        idx = {};
        for (const k of Object.keys(row)) (idx[normKey(k)] ||= []).push(k);
        KEY_INDEX.set(row, idx);
    }
    for (const n of names) {
        for (const k of idx[normKey(n)] || []) {
            const v = row[k];
            if (v !== '' && v !== null && v !== undefined) return v;
        }
    }
    return undefined;
}

/* 日期 / 時間正規化（Apps Script 傳回 Date 物件時會變成 UTC ISO 字串） */
const pad = n => String(n).padStart(2, '0');
function normDate(v) {
    const s = str(v);
    if (!s) return '';
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
        const d = new Date(s);
        if (!isNaN(d)) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : s;
}
function clockOf(v) {
    const s = str(v);
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}T.*Z$/.test(s)) {
        const d = new Date(s);
        if (!isNaN(d)) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    const all = s.match(/\d{1,2}:\d{2}(?::\d{2})?/g);
    if (!all) return '';
    const [h, m, sec = '00'] = all[all.length - 1].split(':');
    return `${pad(h)}:${m}:${sec}`;
}
function parseSlot(v) {
    const m = str(v).match(/(\d{1,2}):(\d{2})\s*[-~–—至到]\s*(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const start = (+m[1]) * 60 + (+m[2]);
    let end = (+m[3]) * 60 + (+m[4]);
    if (end <= start) end += 24 * 60;
    return { start, hours: (end - start) / 60 };
}

/* -------------------------------------------------------------------------- */
/* 語系                                                                        */
/* -------------------------------------------------------------------------- */
function t(key, params) {
    const dict = window.I18N[state.lang] || window.I18N.zh;
    let s = dict[key] ?? window.I18N.zh[key] ?? key;
    if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''));
    return s;
}

const TERM_CACHE = new Map();
let TERM_LIST = null;
function translateData(text) {
    const s = str(text);
    if (!s || state.lang === 'zh' || !/[㐀-鿿：，。；（）、]/.test(s)) return s;
    if (TERM_CACHE.has(s)) return TERM_CACHE.get(s);
    TERM_LIST ||= Object.keys(window.DATA_TERMS_EN || {}).sort((a, b) => b.length - a.length);
    let out = s;
    const hits = [];
    for (const term of TERM_LIST) if (out.includes(term)) { hits.push(window.DATA_TERMS_EN[term]); out = out.split(term).join(`\u0001${hits.length - 1}\u0002`); }
    for (const [p, r] of Object.entries(window.DATA_PUNCT_EN || {})) out = out.split(p).join(r);
    // 只在英文詞彙與相鄰的字母/數字/詞彙之間補空白，保留原本的 - / _ 等連接符號（例：EQ-贴片机-102 → EQ-SMT placement-102）
    out = out.replace(/\u0001(\d+)\u0002/g, (m, i, off, src) => {
        const prev = src[off - 1], next = src[off + m.length];
        const sp = c => c && /[A-Za-z0-9\u0001\u0002\u3400-\u9fff]/.test(c) ? ' ' : '';
        return sp(prev) + hits[i] + (next === '\u0001' ? ' ' : sp(next));
    });
    out = out.replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/\(\s+/g, '(').trim();
    out = out.charAt(0).toUpperCase() + out.slice(1);
    TERM_CACHE.set(s, out);
    return out;
}
/* 英文模式：優先使用試算表的「_EN」欄（建議由 AI Agent 直接產出雙語），否則詞彙對照 */
const tx = (zh, en) => (state.lang === 'en' ? (str(en) || translateData(zh)) : str(zh));

const fmt = {
    n(v, d = 0) { return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString(state.lang === 'en' ? 'en-US' : 'zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }); },
    p(v, d = 1) { return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}%`; },
    dateLabel(d) { return d === 'ALL' ? t('date.all') : d; }
};

/* -------------------------------------------------------------------------- */
/* 狀態判定與歸因                                                              */
/* -------------------------------------------------------------------------- */
const LEVEL_ORDER = { Normal: 0, Warning: 1, Critical: 2 };

/* 若試算表提供「状态等级」欄（Normal/Warning/Critical），直接採用 AI 的判斷；
   否則才退回文字關鍵字判斷。 */
function levelOf(explicit, text) {
    const e = str(explicit).toLowerCase();
    if (e) {
        if (/crit|异常|異常|严重|嚴重|红|紅|触发|觸發|停机/.test(e)) return 'Critical';
        if (/warn|预警|預警|黄|黃|注意/.test(e)) return 'Warning';
        if (/normal|正常|绿|綠|ok/.test(e)) return 'Normal';
    }
    const s = str(text);
    if (!s) return 'Normal';
    if (/异常|異常|Critical|触发|觸發|早退|缺勤|停机|停機|旷工|曠工|无证|無證|缺员|缺員|故障/.test(s)) return 'Critical';
    if (/预警|預警|Warning|迟到|遲到|漂移|堆积|堆積|不符|请假|請假|微偏|下降/.test(s)) return 'Warning';
    return 'Normal';
}

const CAUSES = ['manpower', 'equipment', 'material', 'quality', 'other', 'unspecified'];
// 歸因是「類別」不是「好壞」，刻意避開燈號用的綠 / 橘 / 紅
const CAUSE_COLORS = { manpower: '#6366f1', equipment: '#0ea5e9', material: '#ec4899', quality: '#a855f7', other: '#94a3b8', unspecified: '#475569' };

/* 全站唯一的燈號定義：綠=正常、橘=預警、紅=異常、灰=參考值（不判定） */
const TONE_COLOR = { ok: '#10b981', warn: '#f59e0b', crit: '#ef4444', ref: '#94a3b8', none: '#94a3b8' };
const TONE_LEVEL = { ok: 'Normal', warn: 'Warning', crit: 'Critical' };
function toneOf(metric, v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return 'none';
    const [ok, warn] = CONFIG.THRESHOLDS[metric];
    return v >= ok ? 'ok' : v >= warn ? 'warn' : 'crit';
}
const toneColor = tone => TONE_COLOR[tone] || TONE_COLOR.none;
const thHint = metric => { const [ok, w] = CONFIG.THRESHOLDS[metric]; return t('th.hint', { ok, w }); };
/* 圖例：主指標依門檻上色時顯示三色＋門檻；refs 為灰色參考系列；extra 為固定色系列 */
function colorKey() {
    return `<div class="legend"><span class="lg-title">${esc(t('lg.title'))}</span>` +
        ['ok', 'warn', 'crit'].map(k => `<span><i class="dot ${k}"></i>${esc(t('st.' + TONE_LEVEL[k]))}</span>`).join('') +
        `<span><i class="dot ref"></i>${esc(t('lg.ref'))}</span></div>`;
}
/* 長條圖圖例：依長條由左到右的順序列出每一根代表什麼；
   status=true 的系列用三色色票，並在後面寫出顏色門檻 */
function barLegend(series, metric) {
    const [ok, w] = CONFIG.THRESHOLDS[metric];
    const items = series.map((sr, i) => {
        const sw = sr.status ? `<i class="sw sw-status"></i>` : `<i class="sw" style="background:${sr.color}"></i>`;
        const rule = sr.status ? `<span class="bl-rule">${esc(t('bl.rule', { m: sr.ratio }))}
            <b class="tone-ok">● ≥${ok}%</b><b class="tone-warn">● ${w}–${ok}%</b><b class="tone-crit">● &lt;${w}%</b></span>` : '';
        return `<div class="bl-item"><span class="bl-pos">${esc(t('bl.pos', { n: i + 1 }))}</span>${sw}<b>${esc(sr.label)}</b>${rule}</div>`;
    });
    return `<div class="bar-legend">${items.join('')}</div>`;
}
function legendHtml({ metric, label, refs = [], extra = [] } = {}) {
    let items = [];
    if (metric) {
        const [ok, w] = CONFIG.THRESHOLDS[metric];
        if (label) items.push(`<span class="lg-title">${esc(label)}</span>`);
        items.push(`<span><i class="dot ok"></i>${esc(t('lg.ok', { v: ok }))}</span>`,
            `<span><i class="dot warn"></i>${esc(t('lg.warn', { a: w, b: ok }))}</span>`,
            `<span><i class="dot crit"></i>${esc(t('lg.crit', { v: w }))}</span>`);
    }
    refs.forEach(r => items.push(`<span><i class="dot ref"></i>${esc(r)}</span>`));
    extra.forEach(([color, text]) => items.push(`<span><i class="dot" style="background:${color}"></i>${esc(text)}</span>`));
    return `<div class="legend">${items.join('')}</div>`;
}
/* 歸因優先採用 AI Agent 寫入的「异常归因」欄；沒有該欄才從狀態說明文字推測。
   文字裡沒有寫出原因時標為「未註明原因」，不硬猜（例如「零产出」只是結果，不是原因）。 */
const CAUSE_PATTERNS = {
    manpower: /人力|考勤|请假|請假|旷工|曠工|缺勤|迟到|遲到|缺员|缺員|manpower|labor/i,
    equipment: /设备|設備|停机|停機|维修|維修|故障|稼动|稼動|equipment|machine|downtime/i,
    material: /物料|换线|換線|等待|堆积|堆積|待料|material|changeover/i,
    quality: /品质|品質|不良|超差|良率|quality|defect/i
};
/* 「异常归因」欄的規定值（AI Agent 只能輸出這五個之一，繁簡皆可） */
const CAUSE_ENUM = {
    '人力': 'manpower', '設備': 'equipment', '设备': 'equipment', '物料': 'material',
    '品質': 'quality', '品质': 'quality', '其他': 'other',
    manpower: 'manpower', equipment: 'equipment', material: 'material', quality: 'quality', other: 'other'
};
function causeOf(explicit, text) {
    const e = str(explicit);
    if (e) {
        const k = CAUSE_ENUM[e] || CAUSE_ENUM[e.toLowerCase()];
        // 欄位有值但不是規定值：不靠關鍵字猜，標成未註明並記錄為格式錯誤
        return k ? { cause: k, src: 'column' } : { cause: 'unspecified', src: 'invalid', raw: e };
    }
    const s = str(text);
    for (const [k, re] of Object.entries(CAUSE_PATTERNS)) if (re.test(s)) return { cause: k, src: 'text' };
    return { cause: 'unspecified', src: 'text' };
}

/* -------------------------------------------------------------------------- */
/* 資料模型：一次把三張表正規化，畫面只讀這份                                  */
/* -------------------------------------------------------------------------- */
let M = { prod: [], att: [], oee: [], alerts: [], demand: new Map(), lineFactory: {} };

function pickSheet(raw, ...names) {
    for (const n of names) if (Array.isArray(raw?.[n])) return raw[n];
    return [];
}

function buildModel(raw) {
    const lineFactory = {};

    const prod = pickSheet(raw, '产线工时与品质', '產線工時與品質').map(r => {
        const slot = parseSlot(F(r, '时间段', '时段'));
        const statusText = str(F(r, '状态说明'));
        const rec = {
            raw: r,
            date: normDate(F(r, '日期')),
            factory: str(F(r, '工厂', '工廠')),
            line: str(F(r, '产线', '產線')),
            order: str(F(r, '生产订单', '生產訂單')),
            model: str(F(r, '机种', '機種')),
            material: str(F(r, '物料编码', '物料編碼')),
            slotText: str(F(r, '时间段', '时段')),
            slotStart: slot ? slot.start : null,
            slotHours: slot ? slot.hours : null,
            output: num(F(r, '当前时段产出', '时段产出', '实际产出')),
            test: num(F(r, '测试数')),
            ng: num(F(r, '不良数')),
            wip: num(F(r, 'WIP数量', 'WIP')),
            manpower: num(F(r, '投入人力')),
            plan: num(F(r, '本班计划数量')),
            slotPlan: num(F(r, '时段计划产出')),
            std: num(F(r, '标准工时(H)', '标准工时', '单位标准工时(H)')),
            statusText,
            statusEn: str(F(r, '状态说明_EN', '状态说明(EN)', 'Status_EN'))
        };
        rec.level = levelOf(F(r, '状态等级', 'Status Level'), statusText);
        if (rec.level !== 'Normal') {
            const c = causeOf(F(r, '异常归因', '归因类别', 'Cause'), statusText);
            rec.cause = c.cause; rec.causeSrc = c.src; rec.causeRaw = c.raw;
        } else rec.cause = null;
        if (rec.line && rec.factory) lineFactory[rec.line] = rec.factory;
        return rec;
    });

    // 生管排程需求：同一天、同一產線各工單的「投入人力」加總
    const demand = new Map();
    const seenOrder = new Set();
    prod.forEach(r => {
        if (r.manpower === null) return;
        const k = `${r.date}|${r.line}|${r.order}`;
        if (seenOrder.has(k)) return;
        seenOrder.add(k);
        const dk = `${r.date}|${r.line}`;
        demand.set(dk, (demand.get(dk) || 0) + r.manpower);
    });

    const oee = pickSheet(raw, '设备OEE与利用率', '设备OEE', '設備OEE').map(r => {
        const planH = num(F(r, '计划生产时长(H)', '计划生产时长'));
        const runH = num(F(r, '实际运行时长(H)', '实际运行时长'));
        const total = num(F(r, '检查总数'));
        const pass = num(F(r, 'PASS数'));
        let perf = num(F(r, '性能稼动率', '性能效率', 'Performance'));
        if (perf !== null && perf <= 1.5) perf *= 100;
        let ut = num(F(r, 'U.T. (设备利用率%)', 'U.T.', '设备利用率'));
        const availability = (planH > 0 && runH !== null) ? (runH / planH) * 100 : null;
        const fpy = (total > 0 && pass !== null) ? (pass / total) * 100 : null;
        const oeeVal = availability === null ? null : availability * ((perf ?? 100) / 100) * ((fpy ?? 100) / 100);
        const evalText = str(F(r, '设备OEE评估', 'OEE评估'));
        const line = str(F(r, '产线', '產線'));
        const factory = str(F(r, '工厂', 'Indicator (厂别指标)', '厂别指标'));
        if (line && factory && !lineFactory[line]) lineFactory[line] = factory;
        const rec = {
            raw: r, date: normDate(F(r, '日期')), factory, line,
            location: str(F(r, 'Location (车间位置)', '车间位置')),
            asset: str(F(r, '设备编号', 'Asset#')),
            type: str(F(r, '设备类型')),
            planH, runH, total, pass, perf, ut: ut ?? availability, availability, fpy, oee: oeeVal,
            param: str(F(r, '当前核心参数状态', '核心参数状态')),
            paramEn: str(F(r, '当前核心参数状态_EN')),
            evalText, evalEn: str(F(r, '设备OEE评估_EN')),
            flags: []
        };
        rec.level = levelOf(F(r, '状态等级', '运行状态等级'), evalText || F(r, '运行状态'));
        if (rec.level === 'Normal' && availability !== null && availability < 50) rec.flags.push('evalConflict');
        return rec;
    });

    const att = pickSheet(raw, '员工考勤', '員工考勤').map(r => {
        const status = str(F(r, '上岗状态'));
        const onTimeRaw = F(r, '上岗时间', '打卡时间');
        const clock = clockOf(onTimeRaw);
        const att10Text = str(F(r, '10点出勤状态'));
        let attCat;
        if (att10Text) {
            if (/旷工|曠工|未打卡|缺勤/.test(att10Text)) attCat = 'absent';
            else if (/请假|請假|假/.test(att10Text)) attCat = 'leave';
            else if (/迟到|遲到/.test(att10Text)) attCat = 'late';
            else attCat = 'present';
        } else if (status === '上班' || status === '完工') {
            attCat = clock && clock > CONFIG.LATE_AFTER ? 'late' : 'present';
        } else if (/请假|請假/.test(status)) attCat = 'leave';
        else attCat = 'absent';

        const reqCert = str(F(r, '岗位所需资质'));
        const heldCert = str(F(r, '员工持有资质'));
        const certText = str(F(r, '资质匹配评估'));
        let certCat;
        if (certText) certCat = /不符|不匹配|跨站/.test(certText) ? 'mismatch' : (/无证|無證|无资质|違規|违规/.test(certText) ? 'none' : 'match');
        else if (heldCert === '无资质' || str(F(r, '是否持有上岗证')) === '否') certCat = 'none';
        else if (reqCert && heldCert && reqCert !== heldCert) certCat = 'mismatch';
        else certCat = 'match';

        const schedText = str(F(r, '10点排程满足评估'));
        let schedCat;
        if (schedText) schedCat = /缺员|缺員/.test(schedText) ? 'short' : (/不符/.test(schedText) ? 'cert' : 'ok');
        else schedCat = attCat === 'absent' || attCat === 'leave' ? 'short' : (certCat !== 'match' ? 'cert' : 'ok');

        const line = str(F(r, '产线', '產線'));
        const rec = {
            raw: r, date: normDate(F(r, '日期')), line,
            factory: str(F(r, '工厂', '工廠')) || lineFactory[line] || '',
            empId: str(F(r, '员工工号', '工号')), name: str(F(r, '真实姓名', '姓名')),
            process: str(F(r, '工序')), cycle: str(F(r, '单工站标准工时(s)', '单工站标准工时')),
            status, clock, attCat, reqCert, heldCert, certCat, schedCat, flags: []
        };
        if (attCat === 'absent' && clock) rec.flags.push('punchConflict');
        rec.level = (attCat === 'absent' || certCat === 'none' || schedCat === 'short') ? 'Critical'
            : (attCat === 'late' || attCat === 'leave' || certCat === 'mismatch' || schedCat === 'cert') ? 'Warning' : 'Normal';
        return rec;
    });

    // 生產表沒有工廠欄時，用 OEE 的廠別回填
    prod.forEach(r => { if (!r.factory) r.factory = lineFactory[r.line] || ''; });
    oee.forEach(r => { if (!r.factory) r.factory = lineFactory[r.line] || ''; });

    const alerts = pickSheet(raw, '预警配置', '預警配置').map(r => {
        const status = str(F(r, '当前状态'));
        return {
            raw: r, status, level: levelOf(F(r, '状态等级'), status),
            name: str(F(r, '预警指标名称')), nameEn: str(F(r, '预警指标名称_EN')),
            dim: str(F(r, '监控维度')), threshold: str(F(r, '阈值条件')), thresholdEn: str(F(r, '阈值条件_EN')),
            logic: str(F(r, '计算逻辑')), logicEn: str(F(r, '计算逻辑_EN')),
            advice: str(F(r, '处理建议(AI Agent 辅助决策)', '处理建议')), adviceEn: str(F(r, '处理建议_EN'))
        };
    });

    return { prod, att, oee, alerts, demand, lineFactory };
}

/* -------------------------------------------------------------------------- */
/* 狀態                                                                        */
/* -------------------------------------------------------------------------- */
const urlLang = new URLSearchParams(location.search).get('lang');
const state = {
    tab: ['production', 'attendance', 'oee'].includes(store.get('mfg_tab')) ? store.get('mfg_tab') : 'production',
    lang: (urlLang === 'en' || urlLang === 'zh') ? urlLang : (store.get('mfg_lang', 'zh') === 'en' ? 'en' : 'zh'),
    theme: document.documentElement.getAttribute('data-theme') || 'light',
    search: '',
    filters: {
        production: { date: 'LATEST', factory: 'ALL', line: 'ALL', order: 'ALL', status: 'ALL' },
        attendance: { date: 'LATEST', factory: 'ALL', line: 'ALL', status: 'ALL' },
        oee: { date: 'LATEST', factory: 'ALL', line: 'ALL', status: 'ALL' }
    },
    loaded: false, lastText: '', source: null, lastOk: null, error: null, inflight: false
};

/* -------------------------------------------------------------------------- */
/* 共用 UI 片段                                                                */
/* -------------------------------------------------------------------------- */
function sortedDates(rows) { return uniq(rows.map(r => r.date)).sort().reverse(); }
function resolveDate(sel, dates) {
    if (sel === 'ALL') return 'ALL';
    if (sel === 'LATEST' || !dates.includes(sel)) return dates[0] || 'ALL';
    return sel;
}
function opts(values, selected, { allLabel } = {}) {
    return `<option value="ALL">${esc(allLabel || t('opt.all'))}</option>` +
        values.map(v => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');
}
function dateOpts(dates, selected) {
    if (!dates.length) return `<option value="ALL">${esc(t('opt.allDates'))}</option>`;
    return dates.map((d, i) => i === 0
        ? `<option value="LATEST"${selected === 'LATEST' ? ' selected' : ''}>${esc(t('opt.latest', { d }))}</option>`
        : `<option value="${esc(d)}"${d === selected ? ' selected' : ''}>${esc(d)}</option>`).join('') +
        `<option value="ALL"${selected === 'ALL' ? ' selected' : ''}>${esc(t('opt.allDates'))}</option>`;
}
function statusOpts(selected) {
    return ['ALL', 'Normal', 'Warning', 'Critical'].map(v =>
        `<option value="${v}"${v === selected ? ' selected' : ''}>${esc(v === 'ALL' ? t('opt.all') : t('st.' + v))}</option>`).join('');
}
function filterBar(tab, fields) {
    return `<div class="filter-bar">` + fields.map(f => `
        <label class="field">
            <span class="field-label">${f.icon ? `<i class="${f.icon}"></i>` : ''}${esc(f.label)}</span>
            <select class="select" data-filter-tab="${tab}" data-filter-key="${f.key}">${f.options}</select>
        </label>`).join('') + `</div>`;
}
function pill(level, text) {
    const cls = { Normal: 'ok', Warning: 'warn', Critical: 'crit' }[level] || 'none';
    return `<span class="pill ${cls}">${esc(text ?? t('st.' + level))}</span>`;
}
function flagIcon(flags) {
    if (!flags || !flags.length) return '';
    const tip = flags.map(f => t('flag.' + f)).join('\n');
    return ` <i class="ri-error-warning-fill flag" title="${esc(tip)}" aria-label="${esc(tip)}"></i>`;
}
function notes(list) {
    const items = list.filter(Boolean);
    return items.length ? `<div class="notes">${items.map(n => `<div class="note"><i class="ri-information-line"></i><span>${esc(n)}</span></div>`).join('')}</div>` : '';
}
function tableBlock(headers, rows, rowHtml) {
    const shown = rows.slice(0, CONFIG.TABLE_LIMIT);
    const body = shown.length
        ? shown.map(rowHtml).join('')
        : `<tr><td colspan="${headers.length}" class="empty">${esc(t('table.empty'))}</td></tr>`;
    const limit = rows.length > CONFIG.TABLE_LIMIT
        ? `<div class="table-foot">${esc(t('table.limit', { n: CONFIG.TABLE_LIMIT, total: rows.length }))}</div>` : '';
    return `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map(h =>
        `<th${h.num ? ' class="num"' : ''}>${esc(h.label)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>${limit}`;
}
/* metric 為 null 時視為參考值（灰色、不判定燈號） */
function gauge(value, label, sub, metric) {
    const v = value === null || !Number.isFinite(value) ? null : value;
    const deg = v === null ? 0 : Math.max(0, Math.min(100, v)) * 3.6;
    const tone = metric ? toneOf(metric, v) : 'ref';
    const status = tone === 'ref' ? t('lg.refShort') : tone === 'none' ? '—' : t('st.' + TONE_LEVEL[tone]);
    const hint = metric ? thHint(metric) : t('lg.refHint');
    return `<div class="gauge-card">
        <div class="gauge" style="--deg:${deg}deg; --gauge-color:${toneColor(tone)};">
            <div class="gauge-inner"><span class="gauge-value">${fmt.p(v)}</span></div>
        </div>
        <div class="gauge-text">
            <div class="gauge-label">${esc(label)}</div>
            <div class="gauge-sub">${esc(sub)}</div>
            <div class="gauge-status ${tone}"><i class="dot ${tone}"></i>${esc(status)}<span>${esc(hint)}</span></div>
        </div>
    </div>`;
}
function stat(label, value, cls = '') {
    return `<div class="stat"><span class="stat-label">${esc(label)}</span><span class="stat-value ${cls}">${value}</span></div>`;
}
function renderKPIs(list) {
    $('#kpi-grid').innerHTML = list.map(k => `
        <div class="kpi ${k.tone || 'ref'}"${k.metric ? ` title="${esc(thHint(k.metric))}"` : ''}>
            <div class="kpi-head"><span class="kpi-title">${esc(k.title)}</span><i class="${k.icon || 'ri-dashboard-3-line'}"></i></div>
            <div class="kpi-value">${k.value}${k.unit ? `<span class="kpi-unit">${esc(k.unit)}</span>` : ''}</div>
            <div class="kpi-sub" title="${esc(k.sub)}">${esc(k.sub)}</div>
        </div>`).join('');
}
function setBanner(title, text) {
    $('#banner-title').textContent = title;
    $('#banner-text').textContent = text;
}
function setPanel(title, count) {
    $('#panel-title').textContent = title;
    $('#panel-count').textContent = count;
}
function matchSearch(rec, extra = '') {
    if (!state.search) return true;
    if (!rec._hay) rec._hay = JSON.stringify(rec.raw).toLowerCase();
    return rec._hay.includes(state.search) || extra.toLowerCase().includes(state.search);
}
/* 依工廠串聯的產線清單，並把已不存在的選項重設為 ALL */
function cascade(f, rows) {
    const factories = uniq(rows.map(r => r.factory)).sort(cmpNat);
    if (f.factory !== 'ALL' && !factories.includes(f.factory)) f.factory = 'ALL';
    const lines = uniq(rows.filter(r => f.factory === 'ALL' || r.factory === f.factory).map(r => r.line)).sort(cmpNat);
    if (f.line !== 'ALL' && !lines.includes(f.line)) f.line = 'ALL';
    return { factories, lines };
}
const inScope = (f, date) => r =>
    (date === 'ALL' || r.date === date) &&
    (f.factory === 'ALL' || r.factory === f.factory) &&
    (f.line === 'ALL' || r.line === f.line);

/* -------------------------------------------------------------------------- */
/* 圖表                                                                        */
/* -------------------------------------------------------------------------- */
const charts = {};
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function whenChart(cb, tries = 0) {
    if (typeof Chart !== 'undefined') return cb();
    if (tries < 60) setTimeout(() => whenChart(cb, tries + 1), 100);
}
function drawChart(id, config) {
    whenChart(() => {
        const el = document.getElementById(id);
        if (charts[id]) { charts[id].destroy(); delete charts[id]; }
        if (!el) return;
        charts[id] = new Chart(el, config);
    });
}
function destroyCharts() { Object.keys(charts).forEach(id => { charts[id].destroy(); delete charts[id]; }); }
function baseChartOptions({ percent = false, legend = true } = {}) {
    const axis = cssVar('--chart-axis'), grid = cssVar('--chart-grid');
    return {
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: legend, position: 'top', align: 'end', labels: { color: axis, usePointStyle: true, boxWidth: 8, font: { size: 12, weight: '600' } } },
            tooltip: { callbacks: percent ? { label: c => `${c.dataset.label}: ${c.parsed.y === null ? '—' : c.parsed.y.toFixed(1) + '%'}` } : {} }
        },
        scales: {
            x: { grid: { display: false }, ticks: { color: axis, font: { size: 11, weight: '600' }, autoSkip: true, maxRotation: 45 } },
            y: { beginAtZero: true, grid: { color: grid }, ticks: { color: axis, font: { size: 11 }, callback: percent ? v => v + '%' : undefined } }
        }
    };
}
/* 在長條圖畫出 100% / 目標虛線 */
const targetLinePlugin = value => ({
    id: 'targetLine',
    afterDatasetsDraw(chart) {
        const y = chart.scales.y; if (!y) return;
        const py = y.getPixelForValue(value); const { left, right } = chart.chartArea;
        const ctx = chart.ctx; ctx.save();
        ctx.strokeStyle = cssVar('--text-3'); ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke();
        ctx.fillStyle = cssVar('--text-3'); ctx.font = '600 10px sans-serif'; ctx.textAlign = 'right';
        ctx.fillText(`${value}%`, right, py - 4); ctx.restore();
    }
});
function doughnutConfig(labels, data, colors) {
    const axis = cssVar('--chart-axis');
    return {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: cssVar('--surface'), borderWidth: 2 }] },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '62%',
            plugins: { legend: { position: 'bottom', labels: { color: axis, usePointStyle: true, boxWidth: 8, padding: 12, font: { size: 12, weight: '600' } } } }
        }
    };
}

/* -------------------------------------------------------------------------- */
/* 01 工時 / 效率                                                              */
/* -------------------------------------------------------------------------- */
const STD_TO_HOURS = () => ({ H: 1, h: 1, min: 1 / 60, s: 1 / 3600 }[CONFIG.STD_UNIT] ?? 1);
function aggregateProd(rows) {
    const orders = new Map();
    rows.forEach(r => {
        const k = `${r.date}|${r.line}|${r.order}`;
        let o = orders.get(k);
        if (!o) { o = { plan: null, manpower: null, std: null, actual: 0, hours: 0, rows: [] }; orders.set(k, o); }
        if (o.plan === null) o.plan = r.plan;
        if (o.manpower === null) o.manpower = r.manpower;
        if (o.std === null) o.std = r.std;
        o.actual += r.output || 0;
        o.hours += r.slotHours || 0;
        o.rows.push(r);
    });
    let plan = 0, actual = 0, manpower = 0, earned = 0, worked = 0, planToDate = 0, stdKnown = false, slotPlanDerived = false;
    orders.forEach(o => {
        plan += o.plan || 0; actual += o.actual; manpower += o.manpower || 0;
        if (o.std !== null) { stdKnown = true; earned += o.actual * o.std * STD_TO_HOURS(); worked += (o.manpower || 0) * o.hours; }
        o.rows.forEach(r => {
            let sp = r.slotPlan;
            if (sp === null && o.plan !== null) { sp = o.plan * (r.slotHours ?? 1) / CONFIG.SHIFT_HOURS; slotPlanDerived = true; }
            r._slotPlan = sp;
            planToDate += sp || 0;
        });
    });
    const effRaw = stdKnown && worked > 0 ? (earned / worked) * 100 : null;
    const test = sumBy(rows, r => r.test), ng = sumBy(rows, r => r.ng);
    // 目前 WIP：每條線最新時段的 WIP 加總（不是把所有時段相加）
    const latestByLine = new Map();
    rows.forEach(r => {
        const key = `${r.date}|${String(r.slotStart ?? -1).padStart(5, '0')}`;
        const cur = latestByLine.get(r.line);
        if (!cur || key > cur.key) latestByLine.set(r.line, { key, wip: r.wip });
    });
    const wipVals = [...latestByLine.values()].map(v => v.wip).filter(v => v !== null);
    return {
        orders, plan, actual, manpower, test, ng, planToDate, stdKnown, slotPlanDerived,
        earned: stdKnown ? earned : null,
        wip: wipVals.length ? wipVals.reduce((a, b) => a + b, 0) : null,
        ach: pct(actual, plan),
        progress: pct(actual, planToDate),
        eff: effRaw !== null && effRaw <= CONFIG.EFF_MAX ? effRaw : null,
        effSuspect: effRaw !== null && effRaw > CONFIG.EFF_MAX,
        yield: test > 0 ? ((test - ng) / test) * 100 : (actual > 0 ? ((actual - ng) / actual) * 100 : null)
    };
}

function renderProduction() {
    const f = state.filters.production;
    const all = M.prod;
    const dates = sortedDates(all);
    const date = resolveDate(f.date, dates);
    const { factories, lines } = cascade(f, all);
    const orderList = uniq(all.filter(r => (f.factory === 'ALL' || r.factory === f.factory) && (f.line === 'ALL' || r.line === f.line)).map(r => r.order)).sort(cmpNat);
    if (f.order !== 'ALL' && !orderList.includes(f.order)) f.order = 'ALL';

    const scope = all.filter(r => inScope(f, date)(r) && (f.order === 'ALL' || r.order === f.order));
    const agg = aggregateProd(scope);
    const isGlobal = f.line === 'ALL';

    // 各產線表現
    const lineRows = new Map();
    scope.forEach(r => { if (!lineRows.has(r.line)) lineRows.set(r.line, []); lineRows.get(r.line).push(r); });
    const perLine = [...lineRows.entries()].map(([line, rows]) => ({ line, ...aggregateProd(rows) })).sort((a, b) => cmpNat(a.line, b.line));
    const behind = perLine.filter(l => l.progress !== null && l.progress < CONFIG.THRESHOLDS.progress[0]);
    const worst = perLine.filter(l => l.progress !== null).sort((a, b) => a.progress - b.progress)[0];

    // 異常歸因
    const causeCount = Object.fromEntries(CAUSES.map(c => [c, 0]));
    scope.forEach(r => { if (r.cause) causeCount[r.cause]++; });
    const anomalies = sumBy(CAUSES, c => causeCount[c]);
    const topCause = CAUSES.slice().sort((a, b) => causeCount[b] - causeCount[a])[0];
    const anomRows = scope.filter(r => r.cause);
    const srcCount = { column: 0, text: 0, invalid: 0 };
    anomRows.forEach(r => srcCount[r.causeSrc]++);
    const invalidVals = uniq(anomRows.filter(r => r.causeSrc === 'invalid').map(r => r.causeRaw));
    const srcLabel = srcCount.text === 0 && srcCount.invalid === 0 ? t('p.reasons.col')
        : srcCount.column === 0 && srcCount.invalid === 0 ? t('p.reasons.txt')
        : t('p.reasons.mix', { a: srcCount.column, b: srcCount.text + srcCount.invalid });
    // 依 AI 原文分組，讓使用者看得到每一類背後實際寫了什麼
    const reasonMap = new Map();
    anomRows.forEach(r => {
        const key = `${r.statusText || '—'}|${r.cause}`;  // 同一句說明可能被歸到不同類，分開計數
        const o = reasonMap.get(key) || { text: tx(r.statusText, r.statusEn) || '—', cause: r.cause, n: 0 };
        o.n++; reasonMap.set(key, o);
    });
    const reasons = [...reasonMap.values()].sort((a, b) => b.n - a.n);

    // 人力 KPI 改用考勤表（不再用 投入人力×0.9 估算）
    const attScope = M.att.filter(inScope(f, date));
    const attPresent = attScope.filter(r => r.attCat === 'present' || r.attCat === 'late').length;
    const attRate = pct(attPresent, attScope.length);

    // Banner
    const dateLabel = fmt.dateLabel(date);
    const anomText = anomalies ? t('p.banner.anom', { n: anomalies, cause: t('cause.' + topCause) }) : t('p.banner.noAnom');
    setBanner(t('p.banner.title'), !scope.length ? t('p.banner.empty')
        : isGlobal ? t('p.banner.global', { date: dateLabel, lines: perLine.length, orders: agg.orders.size, worst: worst ? worst.line : '—', p: worst ? worst.progress.toFixed(1) : '—', anom: anomText })
            : t('p.banner.single', { line: f.line, date: dateLabel, p: agg.progress === null ? '—' : agg.progress.toFixed(1), a: agg.ach === null ? '—' : agg.ach.toFixed(1), anom: anomText }));

    renderKPIs([
        { title: t('p.kpi.headcount'), icon: 'ri-team-line', tone: 'ref',
            value: attScope.length ? `${fmt.n(attScope.length)} / ${fmt.n(attPresent)}` : '—', unit: attScope.length ? t('unit.people') : '',
            sub: attScope.length ? t('p.kpi.headcount.sub', { n: attScope.length }) : t('p.noAtt') },
        { title: t('p.kpi.attRate'), icon: 'ri-user-follow-line', tone: toneOf('attendance', attRate), metric: 'attendance',
            value: fmt.p(attRate), sub: attScope.length ? t('p.kpi.attRate.sub') : t('p.noAtt') },
        { title: t('p.kpi.ach'), icon: 'ri-flag-2-line', tone: toneOf('progress', agg.progress), metric: 'progress',
            value: fmt.p(agg.ach), sub: t('p.kpi.ach.sub', { a: fmt.n(agg.actual), p: fmt.n(agg.plan) }) },
        { title: t('p.kpi.warnLines'), icon: 'ri-alarm-warning-line', tone: behind.length ? 'warn' : 'ok',
            value: fmt.n(behind.length), unit: t('unit.lines'),
            sub: behind.length ? t('p.kpi.warnLines.sub', { t: CONFIG.THRESHOLDS.progress[0], list: behind.map(l => l.line).join(', ') }) : t('p.kpi.warnLines.none') },
        { title: t('p.kpi.yield'), icon: 'ri-shield-check-line', tone: toneOf('yield', agg.yield), metric: 'yield',
            value: fmt.p(agg.yield, 2), sub: t('p.kpi.yield.sub', { n: fmt.n(agg.ng), t: fmt.n(agg.test) }) }
    ]);

    // 明細表
    const tableRows = scope
        .filter(r => (f.status === 'ALL' || r.level === f.status) && matchSearch(r, tx(r.statusText, r.statusEn)))
        .sort((a, b) => (b.date.localeCompare(a.date)) || cmpNat(a.line, b.line) || ((a.slotStart ?? 0) - (b.slotStart ?? 0)));
    setPanel(t('p.title'), t('count', { n: tableRows.length }));

    const first = scope[0] || {};
    const meta = [
        [t('f.factory'), f.factory !== 'ALL' ? f.factory : (!isGlobal && uniq(scope.map(r => r.factory)).join(', ')) || t('opt.all')],
        [t('f.line'), isGlobal ? t('opt.all') : f.line],
        [t('f.order'), f.order === 'ALL' ? t('opt.all') : f.order],
        [t('p.meta.material'), (!isGlobal && first.material) || t('opt.all')],
        [t('p.meta.model'), (!isGlobal && first.model) || t('opt.all')]
    ];

    let html = filterBar('production', [
        { key: 'factory', label: t('f.factory'), options: opts(factories, f.factory) },
        { key: 'line', label: t('f.line'), options: opts(lines, f.line) },
        { key: 'order', label: t('f.order'), options: opts(orderList, f.order) },
        { key: 'status', label: t('f.status'), options: statusOpts(f.status) },
        { key: 'date', label: t('f.date'), icon: 'ri-calendar-line', options: dateOpts(dates, f.date) }
    ]);

    html += `
    <section class="board">
        <div class="board-head">
            <div class="board-title"><span class="tag">MES</span>${esc(isGlobal ? t('p.macro') : t('p.micro'))}</div>
            <div class="board-date mono">${esc(dateLabel)}</div>
        </div>
        <div class="chips">${meta.map(([k, v]) => `<span class="chip"><b>${esc(k)}</b>${esc(v)}</span>`).join('')}</div>
        <div class="stat-grid">
            ${stat(t('p.stat.plan'), fmt.n(agg.plan))}
            ${stat(t('p.stat.actual'), fmt.n(agg.actual), 'accent')}
            ${stat(t('p.stat.manpower'), fmt.n(agg.manpower))}
            ${stat(t('p.stat.earned'), fmt.n(agg.earned, 1))}
            ${stat(t('p.stat.test'), fmt.n(agg.test))}
            ${stat(t('p.stat.ng'), fmt.n(agg.ng), agg.ng > 0 ? 'crit' : '')}
            ${stat(t('p.stat.wip'), fmt.n(agg.wip))}
        </div>
        <div class="color-key">${colorKey()}</div>
        <div class="gauge-grid">
            ${gauge(agg.ach, t('p.g.ach'), t('p.g.ach.sub'), null)}
            ${gauge(agg.progress, t('p.g.prog'), t('p.g.prog.sub'), 'progress')}
            ${gauge(agg.eff, t('p.g.eff'), t('p.g.eff.sub'), 'efficiency')}
            ${gauge(agg.yield, t('p.g.yield'), t('p.g.yield.sub'), 'yield')}
        </div>
        <div class="chart-grid">
            <div class="card">
                <div class="card-head"><h4>${esc(isGlobal ? t('p.chart.lines') : t('p.chart.hourly'))}</h4>
                </div>
                ${isGlobal
                    ? barLegend([{ label: t('p.ds.prog'), status: true, ratio: t('bl.ratio.prog') }, { label: t('lg.refOf', { s: t('p.ds.ach') }), color: cssVar('--chart-muted') }], 'progress')
                    : barLegend([{ label: t('p.ds.actual'), status: true, ratio: t('bl.ratio.hour') }, { label: t('lg.refOf', { s: t('p.ds.plan') }), color: cssVar('--chart-muted') }, { label: t('p.ds.ng'), color: '#a855f7' }], 'progress')}
                <div class="chart-box"><canvas id="prodMainChart"></canvas></div>
            </div>
            <div class="card">
                <div class="card-head"><h4>${esc(t('p.chart.cause'))}</h4><span class="muted">${esc(isGlobal ? t('opt.all') : f.line)}</span></div>
                <div class="chart-box cause-box"><canvas id="prodCauseChart"></canvas></div>
                ${reasons.length ? `<div class="reasons"><div class="reasons-title">${esc(t('p.reasons', { src: srcLabel }))}</div>
                    ${reasons.slice(0, 6).map(x => `<div class="reason"><i class="dot" style="background:${CAUSE_COLORS[x.cause]}"></i><span class="reason-text" title="${esc(x.text)}">${esc(x.text)}</span><b>${x.n}</b></div>`).join('')}
                    ${reasons.length > 6 ? `<div class="muted small">${esc(t('p.reasons.more', { n: reasons.length - 6 }))}</div>` : ''}</div>` : ''}
            </div>
        </div>
        ${notes([srcCount.invalid ? t('note.badCause', { n: srcCount.invalid, v: invalidVals.slice(0, 5).join('、') }) : '', causeCount.unspecified && srcCount.text && !srcCount.column ? t('note.noCause', { n: causeCount.unspecified }) : '', agg.actual === 0 && agg.test > 0 ? t('note.zeroOutput', { t: fmt.n(agg.test) }) : '', !agg.stdKnown && scope.length ? t('note.noStd') : '', agg.effSuspect ? t('note.effSuspect', { max: CONFIG.EFF_MAX, u: CONFIG.STD_UNIT }) : '', agg.slotPlanDerived ? t('note.slotPlanDerived', { h: CONFIG.SHIFT_HOURS }) : ''])}
    </section>
    <h3 class="section-title">${esc(t('p.detail'))}</h3>`;

    html += tableBlock([
        { label: t('p.col.date') }, { label: t('p.col.slot') }, { label: t('p.col.line') }, { label: t('p.col.order') },
        { label: t('p.col.status') }, { label: t('p.col.out'), num: true }, { label: t('p.col.ng'), num: true },
        { label: t('p.col.wip'), num: true }, { label: t('p.col.mp'), num: true }, { label: t('p.col.std'), num: true }, { label: t('p.col.ai') }
    ], tableRows, r => `<tr>
        <td class="mono nowrap">${esc(r.date)}</td>
        <td class="mono nowrap">${esc(r.slotText)}</td>
        <td><b>${esc(r.line)}</b></td>
        <td>${esc(r.order)}<span class="sub">${esc(r.model)}</span></td>
        <td>${pill(r.level)}</td>
        <td class="num mono"><b>${fmt.n(r.output)}</b> / ${fmt.n(r._slotPlan)}</td>
        <td class="num mono ${r.ng > 0 ? 'text-crit' : ''}">${fmt.n(r.ng)}</td>
        <td class="num mono ${r.wip > 50 ? 'text-warn' : ''}">${fmt.n(r.wip)}</td>
        <td class="num mono">${fmt.n(r.manpower)}</td>
        <td class="num mono">${r.std === null ? '—' : fmt.n(r.std, 2)}</td>
        <td class="ai-text">${r.cause ? `<span class="cause-tag" style="--c:${CAUSE_COLORS[r.cause]}" title="${esc(t('p.causeSrc.' + r.causeSrc))}">${esc(t('cause.' + r.cause))}${r.causeSrc === 'column' ? '' : ' *'}</span>` : ''}${esc(tx(r.statusText, r.statusEn))}</td>
    </tr>`);

    $('#content').innerHTML = html;

    // 主圖
    if (isGlobal) {
        const cfg = {
            type: 'bar',
            data: {
                labels: perLine.map(l => l.line),
                datasets: [
                    { label: t('p.ds.prog'), data: perLine.map(l => l.progress === null ? null : +l.progress.toFixed(1)), backgroundColor: perLine.map(l => toneColor(toneOf('progress', l.progress))), maxBarThickness: 46 },
                    { label: t('p.ds.ach'), data: perLine.map(l => l.ach === null ? null : +l.ach.toFixed(1)), backgroundColor: cssVar('--chart-muted'), maxBarThickness: 46 }
                ]
            },
            options: baseChartOptions({ percent: true, legend: false }),
            plugins: [targetLinePlugin(100)]
        };
        drawChart('prodMainChart', cfg);
    } else {
        const starts = scope.map(r => r.slotStart).filter(v => v !== null);
        const minH = Math.min(8, ...starts.map(s => Math.floor(s / 60)));
        const maxH = Math.max(19, ...starts.map(s => Math.floor(s / 60)));
        const hours = []; for (let h = minH; h <= maxH; h++) hours.push(h);
        const bucket = h => scope.filter(r => r.slotStart !== null && Math.floor(r.slotStart / 60) === h);
        const series = hours.map(h => {
            const rows = bucket(h);
            return { plan: rows.length ? sumBy(rows, r => r._slotPlan) : null, act: rows.length ? sumBy(rows, r => r.output) : null, ng: rows.length ? sumBy(rows, r => r.ng) : null };
        });
        drawChart('prodMainChart', {
            type: 'bar',
            data: {
                labels: hours.map(h => `${pad(h)}:00`),
                datasets: [
                    { label: t('p.ds.actual'), data: series.map(s => s.act), backgroundColor: series.map(s => toneColor(toneOf('progress', pct(s.act, s.plan)))), minBarLength: 3 },
                    { label: t('lg.refOf', { s: t('p.ds.plan') }), data: series.map(s => s.plan === null ? null : Math.round(s.plan)), backgroundColor: cssVar('--chart-muted') },
                    { label: t('p.ds.ng'), data: series.map(s => s.ng), backgroundColor: '#a855f7' }
                ]
            },
            options: (() => {
                const o = baseChartOptions({ legend: false });
                o.scales.y.title = { display: true, text: t('bl.axis.pcs'), color: cssVar('--chart-axis'), font: { size: 11 } };
                o.plugins.tooltip.callbacks.afterBody = items => {
                    const s = series[items[0].dataIndex];
                    const r = pct(s.act, s.plan);
                    return r === null ? '' : t('bl.tip.ratio', { r: r.toFixed(1) });
                };
                return o;
            })()
        });
    }

    // 歸因圖
    if (anomalies === 0) {
        drawChart('prodCauseChart', doughnutConfig([t('cause.none')], [1], ['#10b981']));
    } else {
        const used = CAUSES.filter(c => causeCount[c] > 0);
        drawChart('prodCauseChart', doughnutConfig(used.map(c => `${t('cause.' + c)} (${causeCount[c]})`), used.map(c => causeCount[c]), used.map(c => CAUSE_COLORS[c])));
    }
}

/* -------------------------------------------------------------------------- */
/* 02 人力 / 考勤                                                              */
/* -------------------------------------------------------------------------- */
function renderAttendance() {
    const f = state.filters.attendance;
    const all = M.att;
    const dates = sortedDates(all);
    const date = resolveDate(f.date, dates);
    const { factories, lines } = cascade(f, all);
    const scope = all.filter(inScope(f, date));

    const c = { present: 0, late: 0, leave: 0, absent: 0, match: 0, mismatch: 0, none: 0 };
    scope.forEach(r => {
        c[r.attCat]++;
        if (r.attCat === 'present' || r.attCat === 'late') c[r.certCat]++;
    });
    const present = c.present + c.late;
    const attRate = pct(present, scope.length);
    const certRate = pct(c.match, present);

    // 產線矩陣：實到 vs 需求（需求來自生產表同日同線的投入人力，絕不預設數字）
    const byLine = new Map();
    scope.forEach(r => {
        if (!byLine.has(r.line)) byLine.set(r.line, { line: r.line, actual: 0, dates: new Set() });
        const o = byLine.get(r.line);
        o.dates.add(r.date);
        if (r.attCat === 'present' || r.attCat === 'late') o.actual++;
    });
    const cards = [...byLine.values()].map(o => {
        let demand = null;
        o.dates.forEach(d => { const v = M.demand.get(`${d}|${o.line}`); if (v !== undefined) demand = (demand || 0) + v; });
        const gap = demand === null ? null : o.actual - demand;
        const tone = demand === null ? 'none' : toneOf('fulfil', pct(o.actual, demand));
        return { ...o, demand, gap, tone };
    }).sort((a, b) => cmpNat(a.line, b.line));

    // 有排程需求、但沒有任何考勤紀錄的產線（另外列出，不計入滿足率）
    const scopeLineSet = new Set(cards.map(x => x.line));
    const missing = uniq([...M.demand.keys()].map(k => {
        const [d, line] = k.split('|');
        if (date !== 'ALL' && d !== date) return null;
        if (f.line !== 'ALL' && line !== f.line) return null;
        if (f.factory !== 'ALL' && (M.lineFactory[line] || '') !== f.factory) return null;
        return scopeLineSet.has(line) ? null : line;
    })).sort(cmpNat);

    const comparable = cards.filter(x => x.demand !== null);
    const totDemand = sumBy(comparable, x => x.demand);
    const totActual = sumBy(comparable, x => x.actual);
    const fulfil = pct(totActual, totDemand);
    const shortLines = comparable.filter(x => x.gap < 0);
    const shortage = sumBy(shortLines, x => -x.gap);

    // 跨線調配建議（有富餘人力的線 → 缺員線）
    const surplus = comparable.filter(x => x.gap > 0).map(x => ({ line: x.line, n: x.gap }));
    const suggestions = [];
    shortLines.slice().sort((a, b) => a.gap - b.gap).forEach(s => {
        let need = -s.gap;
        for (const sp of surplus) {
            if (!need) break;
            if (!sp.n) continue;
            const mv = Math.min(sp.n, need);
            suggestions.push(t('a.suggest.move', { n: mv, from: sp.line, to: s.line }));
            sp.n -= mv; need -= mv;
        }
        if (need) suggestions.push(t('a.suggest.pool', { to: s.line, n: need }));
    });

    const dateLabel = fmt.dateLabel(date);
    setBanner(t('a.banner.title'), t('a.banner.text', {
        date: dateLabel, exp: scope.length, pre: present, rate: attRate === null ? '—' : attRate.toFixed(1),
        abs: c.absent, leave: c.leave, late: c.late,
        sched: comparable.length ? t('a.banner.sched', { n: comparable.length, r: fulfil.toFixed(1), gap: shortage }) : t('a.banner.noSched')
    }));

    renderKPIs([
        { title: t('a.kpi.att'), icon: 'ri-user-follow-line', tone: toneOf('attendance', attRate), metric: 'attendance',
            value: fmt.p(attRate), sub: t('a.kpi.att.sub', { p: present, e: scope.length }) },
        { title: t('a.kpi.sched'), icon: 'ri-calendar-check-line', tone: toneOf('fulfil', fulfil), metric: 'fulfil',
            value: fmt.p(fulfil), sub: t('a.kpi.sched.sub', { d: fmt.n(totDemand), g: fmt.n(shortage) }) },
        { title: t('a.kpi.abs'), icon: 'ri-user-unfollow-line', tone: c.absent ? 'crit' : (c.leave || c.late) ? 'warn' : 'ok',
            value: `${c.absent} / ${c.leave} / ${c.late}`, sub: t('a.kpi.abs.sub', { n: c.absent + c.leave }) },
        { title: t('a.kpi.cert'), icon: 'ri-award-line', tone: toneOf('cert', certRate), metric: 'cert',
            value: fmt.p(certRate), sub: t('a.kpi.cert.sub', { m: c.mismatch, n: c.none }) },
        { title: t('a.kpi.short'), icon: 'ri-error-warning-line', tone: shortLines.length ? 'crit' : 'ok',
            value: fmt.n(shortLines.length), unit: t('unit.lines'), sub: t('a.kpi.short.sub', { n: shortage }) }
    ]);

    const tableRows = scope
        .filter(r => (f.status === 'ALL' || r.level === f.status) && matchSearch(r))
        .sort((a, b) => b.date.localeCompare(a.date) || cmpNat(a.line, b.line) || cmpNat(a.empId, b.empId));
    setPanel(t('a.title'), t('count', { n: tableRows.length }));

    let html = filterBar('attendance', [
        { key: 'factory', label: t('f.factory'), options: opts(factories, f.factory) },
        { key: 'line', label: t('f.line'), options: opts(lines, f.line) },
        { key: 'status', label: t('f.status'), options: statusOpts(f.status) },
        { key: 'date', label: t('f.date'), icon: 'ri-calendar-line', options: dateOpts(dates, f.date) }
    ]);

    html += `<div class="two-col">
        <section class="card">
            <div class="card-head">
                <h4><i class="ri-user-settings-line"></i>${esc(t('a.matrix'))}</h4>
                ${legendHtml({ metric: 'fulfil', label: t('a.legend.rate'), refs: [t('a.legend.none')] })}
            </div>
            <div class="matrix">${cards.length ? cards.map(x => {
                const rate = pct(x.actual, x.demand);
                const gapTxt = x.demand === null ? t('a.card.nodemand') : x.gap === 0 ? t('a.card.ok') : x.gap < 0 ? t('a.card.short', { n: -x.gap }) : t('a.card.surplus', { n: x.gap });
                return `<div class="line-card ${x.tone}">
                    <div class="lc-head"><b>${esc(x.line)}</b><span>${esc(gapTxt)}</span></div>
                    <div class="lc-value mono">${x.actual}<small> / ${x.demand === null ? '—' : x.demand}</small></div>
                    <div class="lc-bar"><span style="width:${Math.min(100, rate ?? 0)}%"></span></div>
                    <div class="lc-foot">${x.demand === null ? '&nbsp;' : esc(t('a.card.rate', { r: rate.toFixed(0) }))}</div>
                </div>`;
            }).join('') : `<div class="empty">${esc(t('table.empty'))}</div>`}</div>
            ${missing.length ? `<div class="missing"><span>${esc(t('a.missing'))}</span><div class="chips">${missing.map(l => `<span class="chip ghost">${esc(l)}</span>`).join('')}</div></div>` : ''}
        </section>
        <section class="card">
            <div class="card-head"><h4><i class="ri-route-line"></i>${esc(t('a.suggest'))}</h4></div>
            ${suggestions.length
                ? `<ul class="suggest">${suggestions.slice(0, 10).map(s => `<li><i class="ri-arrow-right-circle-line"></i>${esc(s)}</li>`).join('')}</ul><p class="muted small">${esc(t('a.suggest.note'))}</p>`
                : `<p class="muted">${esc(t('a.suggest.none'))}</p>`}
        </section>
    </div>`;

    const attPill = r => ({
        present: pill('Normal', t('att.present')), late: pill('Warning', t('att.late')),
        leave: pill('Warning', t('att.leave')), absent: pill('Critical', t('att.absent'))
    }[r.attCat]);
    const certTxt = { match: ['ok', t('cert.match')], mismatch: ['warn', t('cert.mismatch')], none: ['crit', t('cert.none')] };
    const schedTxt = { ok: ['ok', t('sched.ok')], short: ['crit', t('sched.short')], cert: ['warn', t('sched.cert')] };

    html += tableBlock([
        { label: t('a.col.date') }, { label: t('a.col.id') }, { label: t('a.col.name') }, { label: t('a.col.line') },
        { label: t('a.col.proc') }, { label: t('a.col.cycle') }, { label: t('a.col.att') }, { label: t('a.col.clock') },
        { label: t('a.col.req') }, { label: t('a.col.held') }, { label: t('a.col.cert') }, { label: t('a.col.sched') }
    ], tableRows, r => `<tr>
        <td class="mono nowrap">${esc(r.date)}</td>
        <td class="mono">${esc(r.empId)}</td>
        <td><b>${esc(r.name)}</b></td>
        <td><b>${esc(r.line)}</b></td>
        <td>${esc(translateData(r.process))}</td>
        <td class="mono">${esc(r.cycle || '—')}</td>
        <td class="nowrap">${attPill(r)}${flagIcon(r.flags)}</td>
        <td class="mono">${esc(r.clock || '—')}</td>
        <td class="muted small">${esc(translateData(r.reqCert))}</td>
        <td class="small"><b>${esc(translateData(r.heldCert) || '—')}</b></td>
        <td><span class="txt ${certTxt[r.certCat][0]}">${esc(certTxt[r.certCat][1])}</span></td>
        <td><span class="txt ${schedTxt[r.schedCat][0]}">${esc(schedTxt[r.schedCat][1])}</span></td>
    </tr>`);

    $('#content').innerHTML = html;
}

/* -------------------------------------------------------------------------- */
/* 03 設備 OEE / 預警                                                          */
/* -------------------------------------------------------------------------- */
const listShort = arr => arr.slice(0, 3).map(translateData).join(', ') + (arr.length > 3 ? '…' : '');
function renderOEE() {
    const f = state.filters.oee;
    const all = M.oee;
    const dates = sortedDates(all);
    const date = resolveDate(f.date, dates);
    const { factories, lines } = cascade(f, all);
    const scope = all.filter(inScope(f, date));

    // KPI 以「範圍」計算，不受狀態篩選影響
    const cnt = { Normal: 0, Warning: 0, Critical: 0 };
    scope.forEach(r => cnt[r.level]++);
    const withA = scope.filter(r => r.availability !== null);
    const avgA = withA.length ? sumBy(withA, r => r.availability) / withA.length : null;
    const avgOEE = withA.length ? sumBy(withA, r => r.oee) / withA.length : null;
    const hasPerf = scope.some(r => r.perf !== null);
    const conflicts = scope.filter(r => r.flags.length);
    const alertCnt = { Normal: 0, Warning: 0, Critical: 0 };
    M.alerts.forEach(a => alertCnt[a.level]++);

    const critAssets = scope.filter(r => r.level === 'Critical').map(r => r.asset).filter(Boolean);
    setBanner(t('o.banner.title'), t('o.banner.text', {
        date: fmt.dateLabel(date), n: scope.length, oee: fmt.p(avgOEE), t: CONFIG.THRESHOLDS.oee[0],
        c: cnt.Critical, assets: critAssets.length ? (state.lang === 'en' ? ` (${listShort(critAssets)})` : `（${listShort(critAssets)}）`) : '',
        w: cnt.Warning, ac: alertCnt.Critical,
        conflict: conflicts.length ? t('o.banner.conflict', { n: conflicts.length }) : ''
    }));

    renderKPIs([
        { title: t('o.kpi.oee'), icon: 'ri-speed-up-line', tone: toneOf('oee', avgOEE), metric: 'oee',
            value: fmt.p(avgOEE), sub: t('o.kpi.oee.sub', { t: CONFIG.THRESHOLDS.oee[0], f: hasPerf ? t('o.f.full') : t('o.f.aq') }) },
        { title: t('o.kpi.avail'), icon: 'ri-timer-line', tone: toneOf('availability', avgA), metric: 'availability',
            value: fmt.p(avgA), sub: t('o.kpi.avail.sub') },
        { title: t('o.kpi.crit'), icon: 'ri-tools-line', tone: cnt.Critical ? 'crit' : 'ok', value: fmt.n(cnt.Critical), unit: t('unit.units'), sub: t('o.kpi.crit.sub') },
        { title: t('o.kpi.warn'), icon: 'ri-alert-line', tone: cnt.Warning ? 'warn' : 'ok', value: fmt.n(cnt.Warning), unit: t('unit.units'), sub: t('o.kpi.warn.sub') },
        { title: t('o.kpi.alerts'), icon: 'ri-shield-flash-line', tone: alertCnt.Critical ? 'crit' : alertCnt.Warning ? 'warn' : 'ok',
            value: fmt.n(alertCnt.Critical + alertCnt.Warning), sub: t('o.kpi.alerts.sub', { c: alertCnt.Critical, w: alertCnt.Warning }) }
    ]);

    const oeeRows = scope
        .filter(r => (f.status === 'ALL' || r.level === f.status) && matchSearch(r, tx(r.evalText, r.evalEn)))
        .sort((a, b) => (LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]) || cmpNat(a.line, b.line) || cmpNat(a.asset, b.asset));
    const alertRows = M.alerts
        .filter(a => (f.status === 'ALL' || a.level === f.status) && matchSearch(a))
        .sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
    setPanel(t('o.title'), t('count.oee', { a: oeeRows.length, b: alertRows.length }));

    let html = filterBar('oee', [
        { key: 'factory', label: t('f.factory'), options: opts(factories, f.factory) },
        { key: 'line', label: t('f.line'), options: opts(lines, f.line) },
        { key: 'status', label: t('f.status'), options: statusOpts(f.status) },
        { key: 'date', label: t('f.date'), icon: 'ri-calendar-line', options: dateOpts(dates, f.date) }
    ]);

    html += `<div class="chart-grid">
        <div class="card"><div class="card-head"><h4>${esc(t('o.chart.avail'))}</h4></div>${barLegend([{ label: t('o.ds.avail'), status: true, ratio: t('bl.ratio.avail') }, { label: t('lg.refOf', { s: t('o.ds.fpy') }), color: cssVar('--chart-muted') }], 'availability')}<div class="chart-box"><canvas id="oeeLineChart"></canvas></div></div>
        <div class="card"><div class="card-head"><h4>${esc(t('o.chart.status'))}</h4></div><div class="chart-box"><canvas id="oeeStatusChart"></canvas></div></div>
    </div>
    ${notes([scope.length && !withA.length ? t('note.noRun') : ''])}
    <h3 class="section-title"><i class="ri-macbook-line"></i>${esc(t('o.list'))}</h3>`;

    html += tableBlock([
        { label: t('o.col.date') }, { label: t('o.col.plant') }, { label: t('o.col.line') }, { label: t('o.col.asset') },
        { label: t('o.col.type') }, { label: t('o.col.status') }, { label: t('o.col.avail'), num: true }, { label: t('o.col.ut'), num: true },
        { label: t('o.col.fpy'), num: true }, { label: t('o.col.oee'), num: true }, { label: t('o.col.param') }, { label: t('o.col.ai') }
    ], oeeRows, r => `<tr>
        <td class="mono nowrap">${esc(r.date)}</td>
        <td><span class="badge">${esc(r.factory || '—')}</span></td>
        <td><b>${esc(r.line)}</b><span class="sub">${esc(translateData(r.location))}</span></td>
        <td class="mono nowrap">${esc(translateData(r.asset))}</td>
        <td><b>${esc(translateData(r.type))}</b></td>
        <td class="nowrap">${pill(r.level)}${flagIcon(r.flags)}</td>
        <td class="num mono"><b class="tone-${toneOf('availability', r.availability)}">${fmt.p(r.availability)}</b><span class="sub">${r.runH === null ? '—' : fmt.n(r.runH, 1)}H / ${r.planH === null ? '—' : fmt.n(r.planH, 1)}H</span></td>
        <td class="num mono">${fmt.p(r.ut)}</td>
        <td class="num mono">${fmt.p(r.fpy)}<span class="sub">${r.total === null ? '' : `${fmt.n(r.pass)}/${fmt.n(r.total)}`}</span></td>
        <td class="num mono"><b class="tone-${toneOf('oee', r.oee)}">${fmt.p(r.oee)}</b></td>
        <td class="${/正常|normal/i.test(r.param) ? 'text-ok' : r.param ? 'text-crit' : ''}">${esc(tx(r.param, r.paramEn) || '—')}</td>
        <td class="ai-text">${esc(tx(r.evalText, r.evalEn))}</td>
    </tr>`);

    html += `<h3 class="section-title"><i class="ri-shield-flash-line"></i>${esc(t('o.alerts'))}<span class="muted small">${esc(t('o.alerts.hint'))}</span></h3>`;
    html += tableBlock([
        { label: t('o.acol.name') }, { label: t('o.acol.dim') }, { label: t('o.acol.trigger') },
        { label: t('o.acol.status') }, { label: t('o.acol.logic') }, { label: t('o.acol.ai') }
    ], alertRows, a => `<tr>
        <td><b>${esc(tx(a.name, a.nameEn))}</b></td>
        <td><span class="badge">${esc(translateData(a.dim) || '—')}</span></td>
        <td class="mono text-crit">${esc(tx(a.threshold, a.thresholdEn) || '—')}</td>
        <td class="nowrap">${pill(a.level, a.level === 'Critical' ? t('o.alert.triggered') : undefined)}</td>
        <td class="mono small">${esc(tx(a.logic, a.logicEn) || '—')}</td>
        <td class="ai-text">${esc(tx(a.advice, a.adviceEn) || '—')}</td>
    </tr>`);

    $('#content').innerHTML = html;

    // 圖表
    const byLine = new Map();
    scope.forEach(r => { if (!byLine.has(r.line)) byLine.set(r.line, []); byLine.get(r.line).push(r); });
    const lineStats = [...byLine.entries()].sort((a, b) => cmpNat(a[0], b[0])).map(([line, rows]) => {
        const a = rows.filter(r => r.availability !== null), q = rows.filter(r => r.fpy !== null);
        return { line, a: a.length ? sumBy(a, r => r.availability) / a.length : null, q: q.length ? sumBy(q, r => r.fpy) / q.length : null };
    });
    drawChart('oeeLineChart', {
        type: 'bar',
        data: {
            labels: lineStats.map(s => s.line),
            datasets: [
                { label: t('o.ds.avail'), data: lineStats.map(s => s.a === null ? null : +s.a.toFixed(1)), backgroundColor: lineStats.map(s => toneColor(toneOf('availability', s.a))), maxBarThickness: 36 },
                { label: t('o.ds.fpy'), data: lineStats.map(s => s.q === null ? null : +s.q.toFixed(1)), backgroundColor: cssVar('--chart-muted'), maxBarThickness: 36 }
            ]
        },
        options: (() => { const o = baseChartOptions({ percent: true, legend: false }); o.scales.y.max = 100; return o; })(),
        plugins: [targetLinePlugin(CONFIG.THRESHOLDS.availability[0])]
    });
    const lv = ['Normal', 'Warning', 'Critical'].filter(l => cnt[l] > 0);
    drawChart('oeeStatusChart', doughnutConfig(
        lv.map(l => `${t('st.' + l)} (${cnt[l]})`), lv.map(l => cnt[l]),
        lv.map(l => ({ Normal: '#10b981', Warning: '#f59e0b', Critical: '#ef4444' }[l]))));
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */
function render() {
    document.querySelectorAll('.tab').forEach(b => {
        const on = b.dataset.tab === state.tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on);
    });
    if (!state.loaded) return;
    destroyCharts();
    try {
        if (state.tab === 'production') renderProduction();
        else if (state.tab === 'attendance') renderAttendance();
        else renderOEE();
    } catch (e) {
        console.error(e);
        $('#content').innerHTML = `<div class="note error"><i class="ri-bug-line"></i><span>Render error: ${esc(e.message)}</span></div>`;
    }
}

function applyStaticI18n() {
    document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-TW';
    document.title = t('app.title');
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    updateThemeButton();
    updateConn();
}

function updateThemeButton() {
    const dark = state.theme === 'dark';
    $('#theme-icon').className = dark ? 'ri-sun-line' : 'ri-moon-clear-line';
    $('#theme-text').textContent = dark ? t('btn.light') : t('btn.dark');
}

function updateConn() {
    const el = $('#conn');
    const st = state.inflight && !state.loaded ? 'loading' : state.error ? 'error' : state.loaded ? 'live' : 'loading';
    el.dataset.state = st;
    $('#conn-label').textContent = t('conn.' + st);
    const ts = state.lastOk ? state.lastOk.toLocaleString(state.lang === 'en' ? 'en-US' : 'zh-TW', { hour12: false }) : '—';
    $('#updated-text').textContent = state.error && state.lastOk ? t('conn.failedAt', { t: ts }) : t('conn.updated', { t: ts });
    $('#footer-source').textContent = state.source ? t(state.source === CONFIG.API_PRIMARY ? 'src.proxy' : 'src.direct') : '';
    $('#refresh-btn').classList.toggle('spinning', state.inflight);
}

async function fetchData({ force = false } = {}) {
    if (state.inflight) return;
    state.inflight = true; updateConn();
    const candidates = uniq([state.source, CONFIG.API_PRIMARY, CONFIG.API_FALLBACK]);
    let lastErr = null;
    for (const base of candidates) {
        try {
            const u = new URL(base, location.href);
            if (base === CONFIG.API_PRIMARY && force) u.searchParams.set('force', '1');
            if (base !== CONFIG.API_PRIMARY) u.searchParams.set('t', Date.now());
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 25_000);
            const res = await fetch(u, { cache: 'no-store', signal: ctrl.signal });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            const data = JSON.parse(text);
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Unexpected payload');
            if (data.error) throw new Error(String(data.error));
            state.source = base; state.lastOk = new Date(); state.error = null;
            if (text !== state.lastText || !state.loaded) {
                state.lastText = text;
                M = buildModel(data);
                state.loaded = true;
                render();
            }
            lastErr = null;
            break;
        } catch (e) {
            lastErr = e;
            console.warn(`[data] ${base} 失敗：`, e.message);
            if (state.source === base) state.source = null;
        }
    }
    if (lastErr) {
        state.error = lastErr.name === 'AbortError' ? 'timeout' : lastErr.message;
        if (!state.loaded) setBanner('AI Agent', t('banner.error', { e: state.error }));
    }
    state.inflight = false;
    updateConn();
}

function initEvents() {
    document.querySelector('.tabs').addEventListener('click', e => {
        const btn = e.target.closest('.tab'); if (!btn) return;
        state.tab = btn.dataset.tab; store.set('mfg_tab', state.tab);
        render();
    });
    $('#content').addEventListener('change', e => {
        const sel = e.target.closest('select[data-filter-tab]'); if (!sel) return;
        const fl = state.filters[sel.dataset.filterTab];
        fl[sel.dataset.filterKey] = sel.value;
        if (sel.dataset.filterKey === 'factory') { fl.line = 'ALL'; if ('order' in fl) fl.order = 'ALL'; }
        if (sel.dataset.filterKey === 'line' && 'order' in fl) fl.order = 'ALL';
        render();
    });
    let timer;
    $('#search-input').addEventListener('input', e => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.search = e.target.value.toLowerCase().trim(); render(); }, 250);
    });
    $('#refresh-btn').addEventListener('click', () => fetchData({ force: true }));
    $('#lang-btn').addEventListener('click', () => {
        state.lang = state.lang === 'en' ? 'zh' : 'en';
        store.set('mfg_lang', state.lang);
        const url = new URL(location.href); url.searchParams.set('lang', state.lang); history.replaceState(null, '', url);
        applyStaticI18n(); render();
    });
    $('#theme-btn').addEventListener('click', () => {
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', state.theme);
        store.set('mfg_theme', state.theme);
        updateThemeButton(); render();
    });
    $('#fs-btn').addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else document.documentElement.requestFullscreen?.();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchData(); });
    setInterval(() => { if (!document.hidden) fetchData(); }, CONFIG.REFRESH_MS);
    setInterval(updateConn, 30_000);
}

document.addEventListener('DOMContentLoaded', () => {
    applyStaticI18n();
    initEvents();
    render();
    fetchData();
});
