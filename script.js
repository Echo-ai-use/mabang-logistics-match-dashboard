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

// ===================== 静态快照模式 =====================
const SNAP = (typeof window !== 'undefined' && window.__SNAPSHOT__) || null;
const STATIC = !!(SNAP && Array.isArray(SNAP.items));

const SNAP_FIELDS = [
  'verdict', 'erpOrderId', 'platformOrderId', 'shopName', 'canSendText',
  'channelName', 'attrText', 'attrs', 'itemTitles', 'trackNumber',
  'countryNameCN', 'updateTime', 'logisticsName', 'buyerName',
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

function snapQuery({ scope, q, sort, page, pageSize }) {
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
        r.logisticsName, r.trackNumber, r.countryNameCN, r.attrText, ...(r.itemTitles || [])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(kw))
    );
  }
  const sorters = {
    anomaly_desc: (a, b) => (RANK[a.verdict] - RANK[b.verdict]) || String(b.updateTime).localeCompare(String(a.updateTime)),
    update_desc: (a, b) => String(b.updateTime || '').localeCompare(String(a.updateTime || '')),
    update_asc: (a, b) => String(a.updateTime || '').localeCompare(String(b.updateTime || '')),
    channel_asc: (a, b) => String(a.channelName || '').localeCompare(String(b.channelName || '')),
    shop_asc: (a, b) => String(a.shopName || '').localeCompare(String(b.shopName || '')),
    order_asc: (a, b) => String(a.erpOrderId).localeCompare(String(b.erpOrderId)),
  };
  list.sort(sorters[sort] || sorters.anomaly_desc);
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
    onClick: (r) => { S.q = r._shop; $('inpSearch').value = r._shop; S.scope = 'anomaly'; S.page = 1; renderStats(); loadOrders(); },
  });
}

// ===================== 渲染：表格 =====================
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
    <td><span class="badge ${VERDICT_CLASS[v]}">${escapeHtml(VERDICT_LABEL[v] || v)}</span></td>
    <td class="mono">${escapeHtml(r.erpOrderId || '')}</td>
    <td class="ellip" title="${escapeHtml(r.shopName || '')}">${escapeHtml(r.shopName || '')}</td>
    <td class="small ${r.canSend === '2' ? 'txt-danger' : 'muted'}">${escapeHtml(r.canSendText || '—')}</td>
    <td>${chanText}</td>
    <td>${attrs || '<span class="muted">—</span>'}</td>
    <td>${titleHtml}</td>
    <td class="mono">${escapeHtml(r.trackNumber || '')}</td>
    <td class="small">${escapeHtml(r.countryNameCN || r.countryCode || '')}</td>
    <td class="mono small">${escapeHtml((r.updateTime || '').slice(0, 16))}</td>
  </tr>`;
}

function renderTable(res) {
  const tbody = $('tbody');
  if (!res.items || !res.items.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:40px" class="muted">没有匹配的订单</td></tr>';
    return;
  }
  const start = (res.page - 1) * res.pageSize;
  tbody.innerHTML = res.items.map((r, i) => rowHtml(r, start + i + 1)).join('');
  const totalPages = Math.max(1, Math.ceil(res.total / res.pageSize));
  $('pageInfo').textContent = `第 ${res.page} / ${totalPages} 页 · 共 ${fmtNum(res.total)} 条`;
  $('btnPrev').disabled = res.page <= 1;
  $('btnNext').disabled = res.page >= totalPages;
  $('resultCount').textContent = `共 ${fmtNum(res.total)} 条`;
}

// ===================== 数据加载 =====================
function qs() {
  return `scope=${encodeURIComponent(S.scope)}&q=${encodeURIComponent(S.q)}&sort=${encodeURIComponent(S.sort)}&page=${S.page}&pageSize=${S.pageSize}`;
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
  $('ruleTable').innerHTML = attrs.map((a) => `<tr><td>${escapeHtml(a.label)}</td><td>${escapeHtml(a.hint || '')}</td></tr>`).join('')
    + `<tr><td>命中任意属性</td><td>→ 特殊属性订单</td></tr>`
    + `<tr><td>渠道名含「${escapeHtml((rule.generalKeywords || ['普货']).join(' / '))}」</td><td style="color:#e23b3b">→ 🔴 异常</td></tr>`
    + `<tr><td>渠道名不含普货</td><td style="color:#1f9d5b">→ ✅ 正常</td></tr>`;

  if (STATIC) {
    $('btnSync').hidden = true;
    $('cfgCreds').hidden = true;
    $('btnCfgSave').hidden = true;
  }
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
  $('btnPrev').addEventListener('click', () => { if (S.page > 1) { S.page--; loadOrders(); } });
  $('btnNext').addEventListener('click', () => { S.page++; loadOrders(); });
}

async function init() {
  bind();
  if (STATIC) {
    document.title = '马帮物流渠道匹配检查看板（快照版）';
    const b = document.createElement('div');
    b.className = 'banner';
    b.textContent = `📦 静态快照版 · 数据生成于 ${SNAP.generatedAt || '—'}，仅供查看。需要实时同步请使用云端/本地版。`;
    document.querySelector('.topbar').after(b);
  }
  await loadState();
  await loadOrders();
}

init();
