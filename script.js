'use strict';

/**
 * 前端脚本 · 双模式
 *  - 本地/云端版（默认）：所有数据走 /api/*
 *  - 静态快照版：页面预置 window.__SNAPSHOT__，全部在浏览器内过滤/排序/分页，不需要任何后端
 */

const $ = (id) => document.getElementById(id);

// ===================== 常量 =====================
const VERDICT_LABEL = { anomaly: '异常', ok: '正常', pending: '待分配渠道', na: '不适用' };
const VERDICT_CLASS = { anomaly: 'anomaly', ok: 'ok', pending: 'pending', na: 'na' };

const DEFAULT_ATTRS = [
  { key: 'battery', label: '电池' },
  { key: 'liquid', label: '液体' },
  { key: 'cosmetic', label: '化妆品' },
  { key: 'paste', label: '膏体' },
  { key: 'knife', label: '刀具' },
  { key: 'powder', label: '粉末' },
  { key: 'magnetic', label: '磁性' },
  { key: 'flammable', label: '易燃品' },
];

const DEFAULT_STATUS_OPTIONS = [
  { value: '6', label: '所有未发货（待处理 + 配货中）· 推荐' },
  { value: '1', label: '待处理' },
  { value: '2', label: '配货中' },
  { value: '1,2', label: '待处理 + 配货中' },
  { value: '3', label: '已发货' },
  { value: '7', label: '所有非未发货' },
];
const DEFAULT_CANSEND_OPTIONS = [
  { value: '3', label: '全部订单（含异常/待审核）· 推荐' },
  { value: '1', label: '仅正常订单' },
  { value: '2', label: '仅异常订单（待审核）' },
];

// ===================== 异常原因分类（人工填写） =====================
/** 特殊属性 key → 业务口径叫法（用户说法：电池叫「带电」） */
const ATTR_TO_CARGO = {
  battery: '带电', liquid: '液体', cosmetic: '化妆品', paste: '膏体',
  knife: '刀具', powder: '粉末', magnetic: '磁性', flammable: '易燃品',
};

/** 「原因分类」下拉候选（也可自由输入） */
const REASON_PRESETS = [
  '带电发成普货', '磁性发成普货', '液体发成普货', '化妆品发成普货', '膏体发成普货',
  '粉末发成普货', '刀具发成普货', '易燃品发成普货',
  '普货发成带电', '普货发成特货', '普货发成化妆品',
  '美国单缺「-美国」后缀',
  '已改正', '非误判（可正常发）', '待确认',
];

const REASON_STORE_KEY = 'mbm.anomalyReasons.v1';

/** 人工原因：{ [erpOrderId]: { text, at } }，存 localStorage（看板是纯静态，没有后端） */
let MANUAL_REASONS = {};
try {
  const raw = localStorage.getItem(REASON_STORE_KEY);
  MANUAL_REASONS = raw ? JSON.parse(raw) : {};
  if (!MANUAL_REASONS || typeof MANUAL_REASONS !== 'object') MANUAL_REASONS = {};
} catch (e) { MANUAL_REASONS = {}; }

let _saveReasonTimer = null;
let _reasonSelTimer = null;
function persistReasons() {
  clearTimeout(_saveReasonTimer);
  _saveReasonTimer = setTimeout(() => {
    try { localStorage.setItem(REASON_STORE_KEY, JSON.stringify(MANUAL_REASONS)); }
    catch (e) { toast('本地保存失败（浏览器存储空间不足或被禁用）'); }
  }, 300);
}

/** 取某单的人工原因（没有则返回 ''） */
function manualReasonOf(id) {
  const rec = MANUAL_REASONS[String(id)];
  return rec && rec.text ? rec.text : '';
}

/** 写入/清除人工原因 */
function setManualReason(id, text) {
  const key = String(id);
  const v = String(text || '').trim();
  if (v) MANUAL_REASONS[key] = { text: v, at: new Date().toISOString() };
  else delete MANUAL_REASONS[key];
  persistReasons();
}

/**
 * 依据系统判定自动「建议」一个原因分类，作为默认值。
 *  - 特殊属性订单走了普货渠道 → 「带电发成普货」/「磁性发成普货」…
 *  - 普货订单走了特殊渠道     → 「普货发成带电」/「普货发成特货」/「普货发成化妆品」
 */
function suggestReason(r) {
  if (!r || r.verdict !== 'anomaly') return '';
  const chan = String(r.channelName || '');
  const rsn = String(r.reason || '');
  // 规则3：美国订单经递四方(新)，线路名缺「-美国」后缀
  if (rsn.includes('-美国')) return '美国单缺「-美国」后缀';
  const attrs = (r.attrs || []);
  if (attrs.length) {
    const labels = attrs.map((k) => ATTR_TO_CARGO[k] || k);
    return `${labels.join('/')}发成普货`;
  }
  const hits = [];
  if (chan.includes('带电')) hits.push('带电');
  if (chan.includes('特货')) hits.push('特货');
  if (chan.includes('化妆品')) hits.push('化妆品');
  return hits.length ? `普货发成${hits.join('/')}` : '待确认';
}

/** 该单最终采用的原因分类：人工填写的优先，否则用系统建议 */
function effectiveReason(r) {
  const m = manualReasonOf(r.erpOrderId || r.platformOrderId);
  return m || suggestReason(r);
}

// ===================== 静态快照模式 =====================
const SNAP = (typeof window !== 'undefined' && window.__SNAPSHOT__) || null;
const STATIC = !!(SNAP && Array.isArray(SNAP.items));

const SNAP_FIELDS = [
  'verdict', 'erpOrderId', 'platformOrderId', 'shopName', 'canSendText',
  'channelName', 'attrText', 'attrs', 'itemTitles', 'trackNumber',
  'countryNameCN', 'updateTime', 'logisticsName', 'buyerName', 'reason',
];

let SNAP_ITEMS = null;
function snapItems() {
  if (SNAP_ITEMS) return SNAP_ITEMS;
  SNAP_ITEMS = (SNAP.items || []).map((r) => {
    const it = {};
    for (let i = 0; i < SNAP_FIELDS.length; i++) it[SNAP_FIELDS[i]] = r[i];
    it.attrs = it.attrs || [];
    it.itemTitles = it.itemTitles || [];
    it.hasSpecial = (it.attrs || []).length > 0;
    it.isGeneralCargo = String(it.channelName || '').includes('普货');
    return it;
  });
  return SNAP_ITEMS;
}

const RANK = { anomaly: 0, pending: 1, ok: 2, na: 3 };

/** 按 scope / 搜索 / 店铺 / 原因分类 过滤 + 排序，返回【全部】命中记录（不分页）。导出功能也复用它。 */
function snapFiltered({ scope, q, shop, reason, sort } = {}) {
  let list = snapItems();
  switch (scope) {
    case 'anomaly': list = list.filter((r) => r.verdict === 'anomaly'); break;
    case 'ok': list = list.filter((r) => r.verdict === 'ok'); break;
    case 'special': list = list.filter((r) => r.hasSpecial); break;
    case 'pending': list = list.filter((r) => r.verdict === 'pending'); break;
    default: break;
  }
  const kw = String(q || '').trim().toLowerCase();
  if (kw) {
    list = list.filter((r) =>
      [r.erpOrderId, r.platformOrderId, r.shopName, r.buyerName, r.channelName,
        r.logisticsName, r.trackNumber, r.countryNameCN, r.attrText,
        effectiveReason(r), r.reason, ...(r.itemTitles || [])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(kw))
    );
  }
  if (shop) list = list.filter((r) => r.shopName === shop);
  if (reason) list = list.filter((r) => effectiveReason(r) === reason);
  const sorters = {
    anomaly_desc: (a, b) => (RANK[a.verdict] - RANK[b.verdict]) || String(b.updateTime).localeCompare(String(a.updateTime)),
    update_desc: (a, b) => String(b.updateTime || '').localeCompare(String(a.updateTime || '')),
    update_asc: (a, b) => String(a.updateTime || '').localeCompare(String(b.updateTime || '')),
    channel_asc: (a, b) => String(a.channelName || '').localeCompare(String(b.channelName || '')),
    shop_asc: (a, b) => String(a.shopName || '').localeCompare(String(b.shopName || '')),
    order_asc: (a, b) => String(a.platformOrderId || a.erpOrderId || '').localeCompare(String(b.platformOrderId || b.erpOrderId || '')),
  };
  list.sort(sorters[sort] || sorters.anomaly_desc);
  return list;
}

function snapQuery({ scope, q, shop, reason, sort, page, pageSize }) {
  const list = snapFiltered({ scope, q, shop, reason, sort });
  const total = list.length;
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(Math.max(1, Number(pageSize) || 100), 1000);
  return { total, page: p, pageSize: ps, items: list.slice((p - 1) * ps, p * ps) };
}

function snapState() {
  const items = snapItems();
  return {
    config: { windowDays: (SNAP.config && SNAP.config.windowDays) || 1, attrs: null, generalKeywords: null, appkey: '', appsecret: '' },
    options: { status: DEFAULT_STATUS_OPTIONS, canSend: DEFAULT_CANSEND_OPTIONS },
    hasCredentials: true,
    rule: SNAP.rule || { attrs: DEFAULT_ATTRS, generalKeywords: ['普货'] },
    stats: SNAP.stats || {},
    meta: SNAP.meta || {},
    storedAt: SNAP.generatedAt || null,
    isStatic: true,
  };
}

// ===================== 状态 =====================
const S = {
  state: null,
  scope: 'all',
  q: '',
  shop: '',
  reason: '',
  sort: 'anomaly_desc',
  page: 1,
  pageSize: 100,
  loading: false,
};

// ===================== 工具 =====================
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-CN');
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ===================== 渲染：统计 =====================
function renderStats() {
  const st = (S.state && S.state.stats) || {};
  $('statTotal').textContent = fmtNum(st.total);
  $('statSpecial').textContent = fmtNum(st.special);
  $('statAnomaly').textContent = fmtNum(st.anomaly);
  $('statOk').textContent = fmtNum(st.ok);
  $('statPending').textContent = fmtNum(st.pending);

  const rate = st.anomalyRate != null ? st.anomalyRate : 0;
  $('statAnomalySub').textContent = st.special
    ? `占特殊属性订单 ${rate}% · 占全部 ${st.anomalyRateOfAll != null ? st.anomalyRateOfAll : 0}%`
    : '需要改物流渠道';
  $('statSpecialSub').textContent = st.total
    ? `占全部订单 ${st.total ? ((st.special / st.total) * 100).toFixed(1) : 0}%`
    : '含电池/液体/膏体等';
  $('statOkSub').textContent = st.special ? `占特殊属性订单 ${(100 - rate).toFixed(2)}%` : '已匹配正确';
  $('statPendingSub').textContent = '有特殊属性但渠道为空';

  // 顶部卡片选中态
  document.querySelectorAll('.card.clickable').forEach((c) => {
    c.classList.toggle('active', c.dataset.scope === S.scope);
  });
  document.querySelectorAll('#scopeTabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.scope === S.scope);
  });
}

// ===================== 渲染：分布面板 =====================
function renderBars(containerId, rows, { onClick, emptyText } = {}) {
  const box = $(containerId);
  box.innerHTML = '';
  if (!rows || !rows.length) {
    box.innerHTML = `<div class="bar-empty">${escapeHtml(emptyText || '暂无数据')}</div>`;
    return;
  }
  const max = Math.max(...rows.map((r) => r.total || 0), 1);
  for (const r of rows) {
    const total = r.total || 0;
    const bad = r.anomaly || 0;
    const good = Math.max(0, total - bad);
    const wTotal = (total / max) * 100;
    const wBad = total ? (bad / total) * wTotal : 0;
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML =
      `<div class="bar-name">${escapeHtml(r.name)}</div>` +
      `<div class="bar-num">${bad ? `<b style="color:#e23b3b">${fmtNum(bad)}</b> / ` : ''}${fmtNum(total)}</div>` +
      `<div class="bar-track" style="width:${wTotal}%">` +
      (wTotal > 0 ? `<div class="bar-fill bad" style="width:${(wBad / wTotal) * 100}%"></div><div class="bar-fill" style="flex:1"></div>` : '') +
      `</div>`;
    if (onClick) { row.title = '点击筛选'; row.addEventListener('click', () => onClick(r)); }
    box.appendChild(row);
  }
}

function renderPanels() {
  const st = (S.state && S.state.stats) || {};

  renderBars('attrBars', (st.attrStats || []).filter((a) => a.total > 0).map((a) => ({
    name: a.label, total: a.total, anomaly: a.anomaly, key: a.key,
  })), {
    emptyText: '本次窗口内没有特殊属性订单',
  });

  renderBars('channelBars', (st.channelStats || []).slice(0, 15).map((c) => ({
    name: c.name, total: c.total, anomaly: c.total, _channel: c.name,
  })), {
    emptyText: '🎉 当前窗口内没有「特殊属性 × 普货渠道」的异常订单',
    onClick: (r) => { S.q = r._channel; $('inpSearch').value = r._channel; S.scope = 'anomaly'; S.page = 1; renderStats(); loadOrders(); },
  });

  renderBars('shopBars', (st.shopStats || []).slice(0, 15).map((c) => ({
    name: c.name, total: c.total, anomaly: c.total, _shop: c.name,
  })), {
    emptyText: '暂无异常店铺',
    onClick: (r) => {
      S.shop = r._shop; S.q = ''; S.reason = ''; $('inpSearch').value = ''; $('selShop').value = r._shop;
      $('selReason').value = '';
      S.scope = 'anomaly'; S.page = 1; renderStats(); loadOrders();
    },
  });
}

// ===================== 渲染：表格 =====================
/** 「原因分类」单元格：下拉候选 + 可自由输入；已人工改过的用琥珀色边框标记 */
function reasonCellHtml(r, v) {
  if (v !== 'anomaly') return '<span class="muted small">—</span>';
  const id = String(r.erpOrderId || r.platformOrderId || '');
  const manual = manualReasonOf(id);
  const sug = suggestReason(r);
  const val = manual || sug;
  const edited = !!manual && manual !== sug;
  return `<input class="reason-input${edited ? ' edited' : ''}" list="reasonList" data-id="${escapeHtml(id)}" `
    + `data-sug="${escapeHtml(sug)}" value="${escapeHtml(val)}" placeholder="填写原因…" `
    + `title="可下拉选择，也可直接输入；自动保存在本机浏览器，导出 CSV 会带上" />`;
}

function rowHtml(r, idx) {
  const v = r.verdict || 'na';
  const attrs = (r.attrs || []).map((k) => {
    const def = DEFAULT_ATTRS.find((a) => a.key === k);
    return `<span class="attr-chip">${escapeHtml(def ? def.label : k)}</span>`;
  }).join('');

  const chanCls = v === 'anomaly' ? 'chan-bad' : v === 'ok' ? 'chan-ok' : 'muted';
  const chanText = r.channelName
    ? `<span class="${chanCls}">${escapeHtml(r.channelName)}</span>`
    : '<span class="muted">（未分配）</span>';

  const titles = (r.itemTitles || []).filter(Boolean);
  const titleHtml = titles.length
    ? `<div class="small ellip" title="${escapeHtml(titles.join(' / '))}">${escapeHtml(titles.join(' / '))}</div>`
    : '<span class="muted small">—</span>';

  return `<tr class="${VERDICT_CLASS[v] || ''}">
    <td class="muted small">${idx}</td>
    <td><span class="badge ${VERDICT_CLASS[v]}" title="${escapeHtml(r.reason || '')}">${escapeHtml(VERDICT_LABEL[v] || v)}</span></td>
    <td class="reason-cell">${reasonCellHtml(r, v)}</td>
    <td class="mono" title="内部单号：${escapeHtml(r.erpOrderId || '')}">${escapeHtml(r.platformOrderId || r.erpOrderId || '')}</td>
    <td class="ellip" title="${escapeHtml(r.shopName || '')}">${escapeHtml(r.shopName || '')}</td>
    <td class="small ${r.canSend === '2' ? 'txt-danger' : 'muted'}">${escapeHtml(r.canSendText || '—')}</td>
    <td>${chanText}</td>
    <td>${attrs || '<span class="muted">—</span>'}</td>
    <td>${titleHtml}</td>
    <td class="mono">${escapeHtml(r.trackNumber || '')}</td>
    <td class="small">${escapeHtml(r.countryNameCN || r.countryCode || '')}</td>
    <td class="mono small">${escapeHtml((r.updateTime || '').slice(0, 16))}</td>
    <td class="small ${v === 'anomaly' && r.reason ? 'txt-danger' : 'muted'}">${escapeHtml(r.reason || (v === 'anomaly' ? '—' : ''))}</td>
  </tr>`;
}

function renderTable(res) {
  const tbody = $('tbody');
  if (res.items && res.items.length) {
    const start = (res.page - 1) * res.pageSize;
    tbody.innerHTML = res.items.map((r, i) => rowHtml(r, start + i + 1)).join('');
  } else {
    tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;padding:40px" class="muted">没有匹配的订单</td></tr>';
  }
  // 计数/分页必须无条件更新，否则「筛选后 0 条」时会显示上一次的旧数字
  const totalPages = Math.max(1, Math.ceil(res.total / res.pageSize));
  $('pageInfo').textContent = `第 ${res.page} / ${totalPages} 页 · 共 ${fmtNum(res.total)} 条`;
  $('btnPrev').disabled = res.page <= 1;
  $('btnNext').disabled = res.page >= totalPages;
  $('resultCount').textContent = `共 ${fmtNum(res.total)} 条`;
}

// ===================== 导出 CSV =====================
const SCOPE_LABEL = { all: '全部', anomaly: '仅异常', ok: '仅正常', special: '仅特殊属性', pending: '待分配渠道' };

function csvCell(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 取当前筛选条件下的【全部】记录（导出用，不分页） */
async function collectAll() {
  if (STATIC) return snapFiltered(S);
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const r = await fetch(`/api/orders?${qs({ page, pageSize: 1000 })}`);
    const res = await r.json();
    if (res.error) throw new Error(res.error);
    const items = res.items || [];
    out.push(...items);
    if (!items.length || out.length >= (res.total || 0)) break;
  }
  return out;
}

async function exportCsv() {
  const btn = $('btnExport');
  btn.disabled = true;
  btn.textContent = '⤓ 导出中…';
  try {
    const list = await collectAll();
    if (!list.length) { toast('当前筛选结果为空，没有可导出的数据'); return; }

    const head = [
      '序号', '判定', '订单编号', '内部单号', '店铺', '订单类型', '物流渠道名称', '物流商',
      '特殊属性', '命中商品', '运单号', '目的国', '更新时间', '异常原因（系统判定）', '原因分类', '原因来源',
    ];
    const rows = list.map((r, i) => {
      const v = r.verdict || 'na';
      const id = String(r.erpOrderId || r.platformOrderId || '');
      const manual = manualReasonOf(id);
      const attrs = (r.attrs || []).map((k) => {
        const d = DEFAULT_ATTRS.find((a) => a.key === k);
        return d ? d.label : k;
      }).join('、');
      return [
        i + 1, VERDICT_LABEL[v] || v, r.platformOrderId || '', r.erpOrderId || '', r.shopName || '',
        r.canSendText || '', r.channelName || '', r.logisticsName || '', attrs,
        (r.itemTitles || []).filter(Boolean).join(' / '), r.trackNumber || '',
        r.countryNameCN || r.countryCode || '', r.updateTime || '', r.reason || '',
        manual || (v === 'anomaly' ? suggestReason(r) : ''),
        manual ? '人工填写' : (v === 'anomaly' ? '系统建议' : ''),
      ];
    });

    const csv = '\ufeff' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
    const name = `物流匹配异常_${SCOPE_LABEL[S.scope] || '全部'}${S.reason ? '_' + S.reason : ''}_${stamp}.csv`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`已导出 ${list.length} 条（含「原因分类」列）`);
  } catch (e) {
    toast('导出失败：' + e.message, 5200);
  } finally {
    btn.disabled = false;
    btn.textContent = '⤓ 导出 CSV';
  }
}

// ===================== 原因分类：下拉候选 & 填写进度 =====================
function fillReasonDatalist() {
  const el = $('reasonList');
  if (!el) return;
  const set = new Set(REASON_PRESETS);
  if (STATIC) {
    for (const r of snapItems()) {
      if (r.verdict !== 'anomaly') continue;
      const s = suggestReason(r);
      if (s) set.add(s);
    }
  }
  for (const k of Object.keys(MANUAL_REASONS)) {
    const t = MANUAL_REASONS[k] && MANUAL_REASONS[k].text;
    if (t) set.add(t);
  }
  el.innerHTML = [...set].map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
}

function updateReasonProgress() {
  const el = $('reasonProgress');
  if (!el || !STATIC) return;
  let total = 0;
  let filled = 0;
  for (const r of snapItems()) {
    if (r.verdict !== 'anomaly') continue;
    total++;
    if (manualReasonOf(r.erpOrderId || r.platformOrderId)) filled++;
  }
  el.textContent = total ? `原因已填 ${filled} / ${total}` : '';
}

// ===================== 数据加载 =====================
function qs(o = {}) {
  const v = { scope: S.scope, q: S.q, shop: S.shop, reason: S.reason, sort: S.sort, page: S.page, pageSize: S.pageSize, ...o };
  return `scope=${encodeURIComponent(v.scope)}&q=${encodeURIComponent(v.q)}&shop=${encodeURIComponent(v.shop)}&reason=${encodeURIComponent(v.reason)}&sort=${encodeURIComponent(v.sort)}&page=${v.page}&pageSize=${v.pageSize}`;
}

async function loadOrders() {
  if (S.loading) return;
  S.loading = true;
  try {
    let res;
    if (STATIC) {
      res = snapQuery(S);
    } else {
      const r = await fetch(`/api/orders?${qs()}`);
      res = await r.json();
      if (res.error) throw new Error(res.error);
    }
    renderTable(res);
    updateReasonProgress();
  } catch (e) {
    toast('加载订单失败：' + e.message);
  } finally {
    S.loading = false;
  }
}

async function loadState() {
  try {
    const st = STATIC ? snapState() : await (await fetch('/api/state')).json();
    if (st.error) throw new Error(st.error);
    S.state = st;
    renderStats();
    renderPanels();
    renderSyncInfo();
    fillSettings();
    fillShopSelect();
    fillReasonSelect();
    return st;
  } catch (e) {
    toast('加载状态失败：' + e.message);
    return null;
  }
}

function renderSyncInfo() {
  const st = S.state || {};
  const meta = st.meta || {};
  const parts = [];
  if (st.isStatic) parts.push('📦 静态快照版');
  if (meta.lastSyncAt) parts.push(`同步于 ${fmtTime(meta.lastSyncAt)}`);
  if (meta.windowDays != null) parts.push(`窗口 ${meta.windowDays} 天`);
  if (meta.orderStatusText) parts.push(`状态：${meta.orderStatusText}`);
  if (meta.canSendText) parts.push(`类型：${meta.canSendText}`);
  if (meta.total != null) parts.push(`快照 ${fmtNum(meta.total)} 单`);
  $('syncInfo').innerHTML = parts.map(escapeHtml).join(' · ');
}

// ===================== 设置 =====================
function fillSettings() {
  const cfg = (S.state && S.state.config) || {};
  const opts = (S.state && S.state.options) || {};

  // 下拉选项
  const stOpts = opts.status || DEFAULT_STATUS_OPTIONS;
  $('cfgStatus').innerHTML = stOpts.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
  const csOpts = opts.canSend || DEFAULT_CANSEND_OPTIONS;
  $('cfgCanSend').innerHTML = csOpts.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');

  if (cfg.appkey) $('cfgAppkey').value = cfg.appkey;
  if (cfg.windowDays) $('cfgWindow').value = cfg.windowDays;
  if (cfg.orderStatus) $('cfgStatus').value = cfg.orderStatus;
  if (cfg.canSend) $('cfgCanSend').value = cfg.canSend;
  if (cfg.generalKeywords) $('cfgKeywords').value = cfg.generalKeywords.join(',');

  // 属性勾选
  const enabled = new Set(cfg.attrs && cfg.attrs.length ? cfg.attrs : DEFAULT_ATTRS.map((a) => a.key));
  $('attrChips').innerHTML = DEFAULT_ATTRS.map((a) => `
    <label class="chip ${enabled.has(a.key) ? 'on' : ''}">
      <input type="checkbox" value="${a.key}" ${enabled.has(a.key) ? 'checked' : ''} />
      <span>${escapeHtml(a.label)}</span>
    </label>`).join('');
  $('attrChips').querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => cb.closest('.chip').classList.toggle('on', cb.checked));
  });

  // 规则表
  const rule = (S.state && S.state.rule) || {};
  const attrs = rule.attrs || DEFAULT_ATTRS;
  const ex = rule.exceptions || {};
  $('ruleTable').innerHTML = attrs.map((a) => `<tr><td>${escapeHtml(a.label)}</td><td>${escapeHtml(a.hint || '')}</td></tr>`).join('')
    + `<tr><td>命中任意属性</td><td>→ 特殊属性订单</td></tr>`
    + `<tr><td>渠道名含「${escapeHtml((rule.generalKeywords || ['普货']).join(' / '))}」</td><td style="color:#e23b3b">→ 🔴 异常</td></tr>`
    + `<tr><td>渠道名不含普货</td><td style="color:#1f9d5b">→ ✅ 正常</td></tr>`
    + (ex.generalChannels && ex.generalChannels.length
      ? `<tr><td>例外线路 ${escapeHtml(ex.generalChannels.join('、'))}</td><td>虽含普货、实为带电专用 → 不判异常</td></tr>` : '')
    + (ex.magneticOkShops && ex.magneticOkShops.length
      ? `<tr><td>例外·磁性 × 店铺 ${escapeHtml(ex.magneticOkShops.join('、'))} × 物流商 ${escapeHtml((ex.magneticOkLogistics || []).join('、'))}</td><td>普货正常</td></tr>` : '')
    + (ex.anyAttrOkShops && ex.anyAttrOkShops.length
      ? `<tr><td>例外·任意属性 × 店铺 ${escapeHtml(ex.anyAttrOkShops.join('、'))} × 物流商 ${escapeHtml((ex.anyAttrOkLogistics || []).join('、'))}</td><td>普货正常</td></tr>` : '')
    + (ex.magneticAnyLogisticsShops && ex.magneticAnyLogisticsShops.length
      ? `<tr><td>例外·磁性 × 店铺 ${escapeHtml(ex.magneticAnyLogisticsShops.join('、'))}（不限物流商）</td><td>普货正常</td></tr>` : '')
    + (ex.usSuffixLogistics && ex.usSuffixLogistics.length
      ? `<tr><td>美国订单 × 物流商 ${escapeHtml(ex.usSuffixLogistics.join('、'))}</td><td>线路名须<b>包含</b>「${escapeHtml(ex.usSuffix || '-美国')}」，否则 🔴 异常</td></tr>` : '')
    + (ex.specialCargoKeywords && ex.specialCargoKeywords.length
      ? `<tr><td>无任何特殊属性的普货订单 × 渠道名含「${escapeHtml(ex.specialCargoKeywords.join(' / '))}」</td><td style="color:#e23b3b">→ 🔴 异常（普货误走特殊渠道）</td></tr>` : '');

  if (STATIC) {
    $('btnSync').hidden = true;
    $('cfgCreds').hidden = true;
    $('btnCfgSave').hidden = true;
  }
}

// 店铺筛选下拉：列出所有含异常订单的店铺（按异常数降序），供「按店铺筛选异常」使用
function fillShopSelect() {
  const sel = $('selShop');
  if (!sel) return;
  const items = snapItems();
  const counts = {};
  for (const r of items) {
    if (r.shopName && r.verdict === 'anomaly') counts[r.shopName] = (counts[r.shopName] || 0) + 1;
  }
  const totalAnomaly = Object.values(counts).reduce((s, n) => s + n, 0);
  const shops = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  const cur = S.shop;
  let html = `<option value="">🏬 全部店铺（异常 ${totalAnomaly}）</option>`;
  if (!counts[cur] && cur) html += `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}（${counts[cur] || 0}）</option>`;
  for (const s of shops) {
    html += `<option value="${escapeHtml(s)}"${s === cur ? ' selected' : ''}>${escapeHtml(s)}（${counts[s]}）</option>`;
  }
  sel.innerHTML = html;
}

// 原因分类筛选下拉：列出所有异常的原因分类（含系统建议 + 人工填写），按数量降序
function fillReasonSelect() {
  const sel = $('selReason');
  if (!sel) return;
  const counts = {};
  if (STATIC) {
    for (const r of snapItems()) {
      if (r.verdict !== 'anomaly') continue;
      const k = effectiveReason(r);
      if (k) counts[k] = (counts[k] || 0) + 1;
    }
  }
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const cur = S.reason;
  let html = `<option value="">🏷 全部原因分类（异常 ${total}）</option>`;
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  if (cur && !counts[cur]) html += `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}（0）</option>`;
  for (const k of keys) {
    html += `<option value="${escapeHtml(k)}"${k === cur ? ' selected' : ''}>${escapeHtml(k)}（${counts[k]}）</option>`;
  }
  sel.innerHTML = html;
}

let _syncRunning = false;
async function doSync() {
  if (STATIC) { toast('静态快照版无法同步，请在本地/云端版操作'); return; }
  if (_syncRunning) return;
  _syncRunning = true;
  const btn = $('btnSync');
  btn.disabled = true;
  btn.textContent = '⟳ 同步中…';
  try {
    const r = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await r.json();
    if (res.error) throw new Error(res.error);
    await loadState();
    S.page = 1;
    await loadOrders();
    const m = res.meta || {};
    toast(`同步完成：${fmtNum(m.pulled)} 条 · 特殊属性 ${fmtNum(m.special)} · 异常 ${fmtNum(m.anomaly)}`);
  } catch (e) {
    toast('同步失败：' + e.message, 5200);
  } finally {
    _syncRunning = false;
    btn.disabled = false;
    btn.textContent = '⟳ 同步数据';
  }
}

async function saveSettings() {
  if (STATIC) return;
  const attrs = [...$('attrChips').querySelectorAll('input:checked')].map((c) => c.value);
  const body = {
    appkey: $('cfgAppkey').value.trim() || undefined,
    windowDays: Number($('cfgWindow').value) || 1,
    orderStatus: $('cfgStatus').value,
    canSend: $('cfgCanSend').value,
    attrs,
    generalKeywords: $('cfgKeywords').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
  };
  const secret = $('cfgAppsecret').value.trim();
  if (secret) body.appsecret = secret;

  const msg = $('cfgMsg');
  msg.textContent = '保存中…';
  msg.className = 'cfg-msg';
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await r.json();
    if (res.error) throw new Error(res.error);
    msg.textContent = '✅ 已保存。口径变更后请点「⟳ 同步数据」重新拉取。';
    msg.className = 'cfg-msg ok';
    $('cfgAppsecret').value = '';
    await loadState();
    await loadOrders();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.className = 'cfg-msg err';
  }
}

// ===================== 事件绑定 =====================
function openModal() { $('settingsModal').hidden = false; }
function closeModal() { $('settingsModal').hidden = true; $('cfgMsg').textContent = ''; }

function bind() {
  $('btnSync').addEventListener('click', doSync);
  $('btnSettings').addEventListener('click', openModal);
  $('btnCfgCancel').addEventListener('click', closeModal);
  $('btnCfgSave').addEventListener('click', saveSettings);
  $('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settingsModal').hidden) closeModal(); });

  // 统计卡 → 筛选
  document.querySelectorAll('.card.clickable').forEach((c) => {
    c.addEventListener('click', () => {
      S.scope = c.dataset.scope;
      S.page = 1;
      renderStats();
      loadOrders();
    });
  });

  // 顶部 tab
  document.querySelectorAll('#scopeTabs .tab').forEach((t) => {
    t.addEventListener('click', () => {
      S.scope = t.dataset.scope;
      S.page = 1;
      renderStats();
      loadOrders();
    });
  });

  // 搜索（防抖）
  let searchTimer;
  $('inpSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      S.q = e.target.value;
      S.page = 1;
      loadOrders();
    }, 320);
  });

  $('selSort').addEventListener('change', (e) => { S.sort = e.target.value; S.page = 1; loadOrders(); });
  $('selPageSize').addEventListener('change', (e) => { S.pageSize = Number(e.target.value); S.page = 1; loadOrders(); });
  $('selShop').addEventListener('change', (e) => { S.shop = e.target.value; S.page = 1; loadOrders(); });
  $('selReason').addEventListener('change', (e) => { S.reason = e.target.value; S.page = 1; loadOrders(); });
  $('btnPrev').addEventListener('click', () => { if (S.page > 1) { S.page--; loadOrders(); } });
  $('btnNext').addEventListener('click', () => { S.page++; loadOrders(); });

  // 导出 CSV（当前筛选条件下的全部记录）
  $('btnExport').addEventListener('click', exportCsv);

  // 「原因分类」填写：事件委托（表格是整块重绘的，不能逐个绑）
  $('tbody').addEventListener('input', (e) => {
    const el = e.target.closest ? e.target.closest('.reason-input') : null;
    if (!el) return;
    setManualReason(el.dataset.id, el.value);
    el.classList.toggle('edited', !!el.value.trim() && el.value.trim() !== el.dataset.sug);
    updateReasonProgress();
    // 原因改了 → 下拉里的分类与数量要跟着变（防抖，避免边打字边重建）
    clearTimeout(_reasonSelTimer);
    _reasonSelTimer = setTimeout(fillReasonSelect, 600);
  });
  // 失焦时若为空，回填系统建议，避免出现空白的分类
  $('tbody').addEventListener('blur', (e) => {
    const el = e.target.closest ? e.target.closest('.reason-input') : null;
    if (!el || el.value.trim()) return;
    el.value = el.dataset.sug || '待确认';
    setManualReason(el.dataset.id, '');
    el.classList.remove('edited');
    updateReasonProgress();
    clearTimeout(_reasonSelTimer);
    _reasonSelTimer = setTimeout(fillReasonSelect, 300);
  }, true);
}

async function init() {
  bind();
  if (STATIC) {
    document.title = '马帮物流渠道匹配检查看板（快照版）';
    const b = document.createElement('div');
    b.className = 'banner';
    b.textContent = `📦 静态快照版 · 数据生成于 ${SNAP.generatedAt || '—'}，仅供查看。「原因分类」列可直接下拉选择或手输，自动保存在本机浏览器；点「⤓ 导出 CSV」可把当前筛选结果连原因一起导出。`;
    document.querySelector('.topbar').after(b);
  }
  await loadState();
  fillReasonDatalist();
  await loadOrders();
}

init();
