// ── Config ──────────────────────────────────────────────────────────────────
const DATA_URL = '/api/data';
const AI_SUMMARY_URL = '/api/summary';
const AI_INSIGHTS_URL = '/api/insights';
const CALENDLY_URL = '/api/calendly';

let _calendlyMode = 'weekly';
let _calendlyCustomFrom = null;
let _calendlyCustomTo = null;

// ── Cache & Refresh ────────────────────────────────────────────────────────
const REFRESH_INTERVAL = 12 * 60 * 60 * 1000; // 12 ore
const CACHE_KEY = 'dashboard_cache';
const CACHE_TS_KEY = 'dashboard_cache_ts';

// Column indices (0-based)
const COL = {
  nome: 0,
  cognome: 1,
  email: 2,
  soddisfazione: 3,  // 0-10
  competenza: 4,     // 1-5
  chiarezza: 5,      // 1-5
  cortesia: 6,       // 1-5
  miglioramenti: 7,
  apprezzato: 8,
  data: 9,
};

// ── Theme Analysis Keywords (Italian) ──────────────────────────────────────
const THEMES = {
  velocita:       { label: 'Velocita',       icon: '&#9889;', keywords: ['veloce', 'rapido', 'attesa', 'lento', 'tempestivo', 'subito', 'pronto', 'immediato'] },
  competenza:     { label: 'Competenza',     icon: '&#127891;', keywords: ['preparato', 'esperto', 'competente', 'conosce', 'aggiornato', 'professionale', 'bravo', 'capace'] },
  comunicazione:  { label: 'Comunicazione',  icon: '&#128172;', keywords: ['spiegato', 'chiaro', 'confuso', 'semplice', 'linguaggio', 'comprensibile', 'dettagliato', 'spiegazione'] },
  pazienza:       { label: 'Pazienza',       icon: '&#128578;', keywords: ['paziente', 'calmo', 'fretta', 'disponibile', 'ascolto', 'cordiale', 'gentile', 'cortese'] },
  risoluzione:    { label: 'Risoluzione',    icon: '&#9989;', keywords: ['risolto', 'problema', 'soluzione', 'aiutato', 'risposta', 'efficace', 'risultato', 'funzionato'] },
};

// ── Performance Benchmarks ─────────────────────────────────────────────────
const BENCHMARKS = {
  ops:            { excellent: 82, good: 68, needsWork: 50 },
  soddisfazione:  { excellent: 8.5, good: 7.0, needsWork: 5.0, max: 10 },
  competenza:     { excellent: 4.5, good: 3.5, needsWork: 2.5, max: 5 },
  chiarezza:      { excellent: 4.5, good: 3.5, needsWork: 2.5, max: 5 },
  cortesia:       { excellent: 4.5, good: 3.5, needsWork: 2.5, max: 5 },
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function parseTs(d) {
  const str = String(d);
  if (str.includes('Date(')) return parseInt(str.match(/\d+/)[0]);
  const ms = new Date(str).getTime();
  return isNaN(ms) ? 0 : ms;
}

function formatDate(d) {
  const ts = parseTs(d);
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
}

function initials(name) {
  if (!name) return '?';
  return name.trim().split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function avg(rows, idx) {
  const vals = rows.slice(1).map(r => parseFloat(r[idx])).filter(v => !isNaN(v) && v > 0);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function stars(n) {
  const full = Math.round(Math.max(0, Math.min(5, n)));
  return '\u2605'.repeat(full) + '\u2606'.repeat(5 - full);
}

// ── OPS (Overall Performance Score) ────────────────────────────────────────
function calcOPS(satisfaction, competence, clarity, courtesy) {
  const s  = (satisfaction / 10) * 100;
  const co = ((competence - 1) / 4) * 100;
  const cl = ((clarity - 1) / 4) * 100;
  const cu = ((courtesy - 1) / 4) * 100;
  return 0.40 * s + 0.30 * co + 0.20 * cl + 0.10 * cu;
}

function opsStatus(score) {
  if (score >= 82) return { label: 'Eccellente', color: 'var(--success)' };
  if (score >= 68) return { label: 'Buono', color: 'var(--accent)' };
  if (score >= 50) return { label: 'Da migliorare', color: 'var(--warn)' };
  return { label: 'Critico', color: 'var(--danger)' };
}

function metricColor(value, benchmark) {
  if (value >= benchmark.excellent) return 'var(--success)';
  if (value >= benchmark.good) return 'var(--accent)';
  if (value >= benchmark.needsWork) return 'var(--warn)';
  return 'var(--danger)';
}

// ── Text Analysis ──────────────────────────────────────────────────────────
function categorizeText(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  return Object.entries(THEMES)
    .filter(([, t]) => t.keywords.some(kw => lower.includes(kw)))
    .map(([key]) => key);
}

function analyzeThemes(rows) {
  const strengths = {};
  const improvements = {};

  rows.slice(1).forEach(r => {
    const appThemes = categorizeText(r[COL.apprezzato]);
    appThemes.forEach(t => { strengths[t] = (strengths[t] || 0) + 1; });

    const migThemes = categorizeText(r[COL.miglioramenti]);
    migThemes.forEach(t => { improvements[t] = (improvements[t] || 0) + 1; });
  });

  const sort = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);
  return { strengths: sort(strengths), improvements: sort(improvements) };
}

// ── Trend Aggregation (weekly / monthly / custom) ─────────────────────────
let _trendMode = 'weekly';
let _customFrom = null;
let _customTo = null;

function getAggregatedData(rows, mode, fromTs, toTs) {
  const dataRows = rows.slice(1).filter(r => parseTs(r[COL.data]) > 0);
  if (!dataRows.length) return [];

  let filtered = [...dataRows].sort((a, b) => parseTs(a[COL.data]) - parseTs(b[COL.data]));

  // Apply custom date filter
  if (fromTs) filtered = filtered.filter(r => parseTs(r[COL.data]) >= fromTs);
  if (toTs) filtered = filtered.filter(r => parseTs(r[COL.data]) <= toTs);
  if (!filtered.length) return [];

  if (mode === 'monthly') {
    const months = {};
    filtered.forEach(r => {
      const d = new Date(parseTs(r[COL.data]));
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!months[key]) months[key] = { rows: [], start: new Date(d.getFullYear(), d.getMonth(), 1).getTime() };
      months[key].rows.push(r);
    });

    return Object.entries(months).sort((a, b) => a[1].start - b[1].start).map(([, m]) => {
      const avgSodd = m.rows.map(r => parseFloat(r[COL.soddisfazione])).filter(v => !isNaN(v) && v > 0);
      return {
        start: m.start,
        label: new Date(m.start).toLocaleDateString('it-IT', { month: 'short', year: '2-digit' }),
        count: m.rows.length,
        avgSatisfaction: avgSodd.length ? avgSodd.reduce((a, b) => a + b, 0) / avgSodd.length : 0,
      };
    });
  }

  if (mode === 'daily') {
    const days = {};
    filtered.forEach(r => {
      const d = new Date(parseTs(r[COL.data]));
      const key = d.toISOString().slice(0, 10);
      if (!days[key]) days[key] = { rows: [], start: new Date(key).getTime() };
      days[key].rows.push(r);
    });

    return Object.entries(days).sort((a, b) => a[1].start - b[1].start).map(([, m]) => {
      const avgSodd = m.rows.map(r => parseFloat(r[COL.soddisfazione])).filter(v => !isNaN(v) && v > 0);
      return {
        start: m.start,
        label: new Date(m.start).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' }),
        count: m.rows.length,
        avgSatisfaction: avgSodd.length ? avgSodd.reduce((a, b) => a + b, 0) / avgSodd.length : 0,
      };
    });
  }

  // Weekly (default)
  const MS_WEEK = 7 * 86400000;
  const startTs2 = parseTs(filtered[0][COL.data]);
  const endTs2 = parseTs(filtered[filtered.length - 1][COL.data]);

  const weeks = [];
  let weekStart = startTs2;
  while (weekStart <= endTs2 + MS_WEEK) {
    const weekEnd = weekStart + MS_WEEK;
    const weekRows = filtered.filter(r => {
      const ts = parseTs(r[COL.data]);
      return ts >= weekStart && ts < weekEnd;
    });

    if (weekRows.length > 0) {
      const avgSodd = weekRows.map(r => parseFloat(r[COL.soddisfazione])).filter(v => !isNaN(v) && v > 0);
      weeks.push({
        start: weekStart,
        label: new Date(weekStart).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' }),
        count: weekRows.length,
        avgSatisfaction: avgSodd.length ? avgSodd.reduce((a, b) => a + b, 0) / avgSodd.length : 0,
      });
    }
    weekStart = weekEnd;
  }
  return weeks;
}

function setTrendMode(mode) {
  _trendMode = mode;
  document.querySelectorAll('.trend-btn[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const datesEl = document.getElementById('trend-dates');
  if (mode === 'custom') {
    datesEl.style.display = 'flex';
  } else {
    datesEl.style.display = 'none';
    _customFrom = null;
    _customTo = null;
    refreshTrend();
  }
}

function applyCustomRange() {
  const from = document.getElementById('trend-from').value;
  const to = document.getElementById('trend-to').value;
  _customFrom = from ? new Date(from).getTime() : null;
  _customTo = to ? new Date(to + 'T23:59:59').getTime() : null;
  refreshTrend();
}

function refreshTrend() {
  if (!_currentRows) return;
  const data = getAggregatedData(_currentRows, _trendMode, _customFrom, _customTo);
  const titleEl = document.getElementById('trend-title');
  if (_trendMode === 'monthly') titleEl.textContent = 'Trend Soddisfazione (media mensile)';
  else if (_trendMode === 'daily') titleEl.textContent = 'Trend Soddisfazione (media giornaliera)';
  else if (_trendMode === 'custom') titleEl.textContent = 'Trend Soddisfazione (periodo personalizzato)';
  else titleEl.textContent = 'Trend Soddisfazione (media settimanale)';
  requestAnimationFrame(() => drawTrendChart('trend-chart', data));
}

// ── Canvas Chart: Trend Line ───────────────────────────────────────────────
function drawTrendChart(canvasId, weeklyData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !weeklyData.length) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 220 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '220px';
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = 220;
  const pad = { top: 20, right: 20, bottom: 40, left: 45 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  const values = weeklyData.map(w => w.avgSatisfaction);
  const minV = Math.max(0, Math.min(...values) - 1);
  const maxV = Math.min(10, Math.max(...values) + 1);
  const range = maxV - minV || 1;

  const xStep = chartW / Math.max(1, weeklyData.length - 1);

  // Grid lines
  ctx.strokeStyle = '#ffffff08';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();

    const val = maxV - (range / 4) * i;
    ctx.fillStyle = '#6b7084';
    ctx.font = '10px "Roboto Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(1), pad.left - 8, y + 4);
  }

  // Line
  ctx.beginPath();
  ctx.strokeStyle = '#ef7b10';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  weeklyData.forEach((w, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top + chartH - ((w.avgSatisfaction - minV) / range) * chartH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fill area under line
  const lastX = pad.left + (weeklyData.length - 1) * xStep;
  ctx.lineTo(lastX, pad.top + chartH);
  ctx.lineTo(pad.left, pad.top + chartH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
  grad.addColorStop(0, '#ef7b1020');
  grad.addColorStop(1, '#ef7b1000');
  ctx.fillStyle = grad;
  ctx.fill();

  // Dots & labels
  weeklyData.forEach((w, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top + chartH - ((w.avgSatisfaction - minV) / range) * chartH;

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ef7b10';
    ctx.fill();
    ctx.strokeStyle = '#1a1d27';
    ctx.lineWidth = 2;
    ctx.stroke();

    // X label (show every other if too many)
    if (weeklyData.length <= 12 || i % 2 === 0) {
      ctx.fillStyle = '#6b7084';
      ctx.font = '9px "Roboto Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(w.label, x, H - pad.bottom + 18);
    }
  });
}

// ── Canvas Chart: Volume Bars ──────────────────────────────────────────────
function drawVolumeChart(canvasId, weeklyData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !weeklyData.length) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 220 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '220px';
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = 220;
  const pad = { top: 20, right: 20, bottom: 40, left: 35 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  const maxCount = Math.max(...weeklyData.map(w => w.count), 1);
  const barW = Math.min(32, (chartW / weeklyData.length) * 0.6);
  const gap = chartW / weeklyData.length;

  // Grid
  ctx.strokeStyle = '#ffffff10';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();

    const val = Math.round(maxCount - (maxCount / 4) * i);
    ctx.fillStyle = '#666';
    ctx.font = '10px "DM Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(val, pad.left - 8, y + 4);
  }

  // Bars
  weeklyData.forEach((w, i) => {
    const x = pad.left + i * gap + (gap - barW) / 2;
    const barH = (w.count / maxCount) * chartH;
    const y = pad.top + chartH - barH;

    const grad = ctx.createLinearGradient(x, y, x, pad.top + chartH);
    grad.addColorStop(0, '#7c3aed');
    grad.addColorStop(1, '#7c3aed40');
    ctx.fillStyle = grad;

    // Rounded top
    const r = Math.min(4, barW / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, pad.top + chartH);
    ctx.lineTo(x, pad.top + chartH);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();

    // Count on top
    ctx.fillStyle = '#ccc';
    ctx.font = '10px "DM Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(w.count, x + barW / 2, y - 6);

    // X label
    if (weeklyData.length <= 12 || i % 2 === 0) {
      ctx.fillStyle = '#666';
      ctx.font = '9px "DM Mono", monospace';
      ctx.fillText(w.label, x + barW / 2, H - pad.bottom + 18);
    }
  });
}

// ── Canvas Chart: Radar ────────────────────────────────────────────────────
function drawRadarChart(canvasId, metrics) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const size = 280;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  ctx.scale(dpr, dpr);

  const cx = size / 2;
  const cy = size / 2;
  const R = 105;
  const n = metrics.length;
  const angleStep = (Math.PI * 2) / n;

  ctx.clearRect(0, 0, size, size);

  // Grid rings
  for (let ring = 1; ring <= 5; ring++) {
    const r = (ring / 5) * R;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const angle = i * angleStep - Math.PI / 2;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ffffff0a';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Axes
  metrics.forEach((_, i) => {
    const angle = i * angleStep - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angle), cy + R * Math.sin(angle));
    ctx.strokeStyle = '#ffffff08';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  // Data polygon
  ctx.beginPath();
  metrics.forEach((m, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const r = (m.normalized / 100) * R;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = '#c8ff0018';
  ctx.fill();
  ctx.strokeStyle = '#c8ff00';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Dots + labels
  metrics.forEach((m, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const r = (m.normalized / 100) * R;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#c8ff00';
    ctx.fill();

    // Label
    const lx = cx + (R + 22) * Math.cos(angle);
    const ly = cy + (R + 22) * Math.sin(angle);
    ctx.fillStyle = '#aaa';
    ctx.font = '10px "DM Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(m.label, lx, ly);

    // Value
    const vx = cx + (R + 35) * Math.cos(angle);
    const vy = cy + (R + 35) * Math.sin(angle);
    ctx.fillStyle = '#c8ff00';
    ctx.font = 'bold 11px "DM Mono", monospace';
    ctx.fillText(m.value, vx, vy);
  });
}

// ── Renderers ──────────────────────────────────────────────────────────────

function renderKPI(rows) {
  const dataRows = rows.slice(1).filter(r => r[COL.nome] || r[COL.soddisfazione]);
  const total = dataRows.length;

  const soddVals = dataRows.map(r => parseFloat(r[COL.soddisfazione])).filter(v => !isNaN(v) && v > 0);
  const avgSodd = soddVals.length ? soddVals.reduce((a, b) => a + b, 0) / soddVals.length : 0;
  const avgComp = avg(rows, COL.competenza);
  const avgClar = avg(rows, COL.chiarezza);
  const avgCort = avg(rows, COL.cortesia);

  // NPS
  const promotori = dataRows.filter(r => parseFloat(r[COL.soddisfazione]) >= 9).length;
  const detrattori = dataRows.filter(r => parseFloat(r[COL.soddisfazione]) <= 6).length;
  const passivi = total - promotori - detrattori;
  const nps = total ? Math.round(((promotori - detrattori) / total) * 100) : 0;
  const pctPromo = total ? Math.round((promotori / total) * 100) : 0;
  const pctPass  = total ? Math.round((passivi   / total) * 100) : 0;
  const pctDetr  = total ? Math.round((detrattori / total) * 100) : 0;
  const npsColor = nps >= 50 ? 'var(--success)' : nps >= 0 ? 'var(--accent)' : 'var(--danger)';

  const now = Date.now();
  const week = dataRows.filter(r => (now - parseTs(r[COL.data])) < 7 * 86400000).length;

  // OPS
  const ops = calcOPS(avgSodd, avgComp, avgClar, avgCort);
  const status = opsStatus(ops);

  // Period comparison (this month vs last month)
  const thisMonth = dataRows.filter(r => {
    const d = new Date(parseTs(r[COL.data]));
    const n = new Date();
    return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
  });
  const lastMonth = dataRows.filter(r => {
    const d = new Date(parseTs(r[COL.data]));
    const n = new Date();
    const lm = new Date(n.getFullYear(), n.getMonth() - 1, 1);
    return d.getMonth() === lm.getMonth() && d.getFullYear() === lm.getFullYear();
  });

  function monthAvg(arr, idx) {
    const vals = arr.map(r => parseFloat(r[idx])).filter(v => !isNaN(v) && v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }

  const soddDelta = monthAvg(thisMonth, COL.soddisfazione) - monthAvg(lastMonth, COL.soddisfazione);
  function deltaHtml(d) {
    if (Math.abs(d) < 0.05) return '<span class="delta-neutral">= stabile</span>';
    if (d > 0) return `<span class="delta-up"><span class="delta-arrow">\u25B2</span>+${d.toFixed(1)} vs mese prec.</span>`;
    return `<span class="delta-down"><span class="delta-arrow">\u25BC</span>${d.toFixed(1)} vs mese prec.</span>`;
  }

  // Build gauge SVG for OPS
  const circumference = 2 * Math.PI * 26;
  const dashOffset = circumference - (ops / 100) * circumference;

  const kpis = [
    {
      html: `
        <div class="kpi-card" style="--accent-color:${status.color}">
          <div class="kpi-label">Performance Score</div>
          <div class="ops-gauge">
            <div class="gauge-ring">
              <svg width="64" height="64" viewBox="0 0 64 64">
                <circle cx="32" cy="32" r="26" fill="none" stroke="#ffffff10" stroke-width="5"/>
                <circle cx="32" cy="32" r="26" fill="none" stroke="${status.color}" stroke-width="5"
                  stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
                  stroke-linecap="round"/>
              </svg>
              <div class="gauge-value">${Math.round(ops)}</div>
            </div>
            <div class="gauge-meta">
              <div class="gauge-status" style="color:${status.color}">${status.label}</div>
              <div class="kpi-sub">su 100</div>
            </div>
          </div>
        </div>`
    },
    {
      html: `
        <div class="kpi-card" style="--accent-color:var(--accent)">
          <div class="kpi-label">Totale risposte</div>
          <div class="kpi-value">${total}</div>
          <div class="kpi-sub">+${week} ultimi 7gg</div>
        </div>`
    },
    {
      html: `
        <div class="kpi-card" style="--accent-color:var(--warn)">
          <div class="kpi-label">Soddisfazione media</div>
          <div class="kpi-value" style="color:${metricColor(avgSodd, BENCHMARKS.soddisfazione)}">${avgSodd.toFixed(1)}<span style="font-size:0.9rem;font-weight:400;color:var(--muted)">/10</span></div>
          <div class="kpi-sub">${deltaHtml(soddDelta)}</div>
        </div>`
    },
    {
      html: `
        <div class="kpi-card" style="--accent-color:${npsColor}">
          <div class="kpi-label">NPS Score</div>
          <div class="kpi-value" style="color:${npsColor}">${nps > 0 ? '+' : ''}${nps}</div>
          <div class="nps-breakdown">
            <span class="nps-promo">&#9650; ${pctPromo}% promotori (9-10)</span>
            <span class="nps-pass">&#9644; ${pctPass}% passivi (7-8)</span>
            <span class="nps-detr">&#9660; ${pctDetr}% detrattori (0-6)</span>
          </div>
        </div>`
    },
  ];

  document.getElementById('kpi-grid').innerHTML = kpis.map(k => k.html).join('');
}

function renderBars(rows) {
  const metrics = [
    { label: 'Soddisfazione generale (0-10)', idx: COL.soddisfazione, max: 10, bench: BENCHMARKS.soddisfazione },
    { label: 'Competenza (1-5)', idx: COL.competenza, max: 5, bench: BENCHMARKS.competenza },
    { label: 'Chiarezza spiegazione (1-5)', idx: COL.chiarezza, max: 5, bench: BENCHMARKS.chiarezza },
    { label: 'Cortesia e professionalita (1-5)', idx: COL.cortesia, max: 5, bench: BENCHMARKS.cortesia },
  ];

  document.getElementById('bars-container').innerHTML = metrics.map(m => {
    const a = avg(rows, m.idx);
    const pct = (a / m.max) * 100;
    const color = metricColor(a, m.bench);
    return `
      <div class="bar-group">
        <div class="bar-label">
          <span>${m.label}</span>
          <span style="color:${color}">${a.toFixed(2)}/${m.max}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%;background:linear-gradient(90deg, var(--accent), ${color})"></div>
        </div>
      </div>`;
  }).join('');
}

function renderDist(rows) {
  const buckets = {};
  for (let i = 0; i <= 10; i++) buckets[i] = 0;

  rows.slice(1).forEach(r => {
    const v = Math.round(parseFloat(r[COL.soddisfazione]));
    if (isNaN(v) || v < 0 || v > 10) return;
    buckets[v]++;
  });

  const maxVal = Math.max(...Object.values(buckets), 1);

  function voteColor(v) {
    if (v <= 4) return 'var(--danger)';
    if (v <= 6) return 'var(--warn)';
    if (v <= 8) return 'var(--accent)';
    return 'var(--success)';
  }

  document.getElementById('dist-container').innerHTML = `
    <div class="dist-list">
      ${Object.entries(buckets).map(([k, v]) => {
        const pct = Math.round((v / maxVal) * 100);
        return `
          <div class="dist-row">
            <span class="dist-row-label">${k}/10</span>
            <div class="dist-row-track">
              <div class="dist-row-fill" style="width:${pct}%;background:${voteColor(Number(k))}"></div>
            </div>
            <span class="dist-row-count">${v}</span>
          </div>`;
      }).join('')}
    </div>`;
}

function renderRadar(rows) {
  const avgSodd = avg(rows, COL.soddisfazione);
  const avgComp = avg(rows, COL.competenza);
  const avgClar = avg(rows, COL.chiarezza);
  const avgCort = avg(rows, COL.cortesia);

  const metrics = [
    { label: 'Soddisf.', value: avgSodd.toFixed(1), normalized: (avgSodd / 10) * 100 },
    { label: 'Competenza', value: avgComp.toFixed(1), normalized: ((avgComp - 1) / 4) * 100 },
    { label: 'Chiarezza', value: avgClar.toFixed(1), normalized: ((avgClar - 1) / 4) * 100 },
    { label: 'Cortesia', value: avgCort.toFixed(1), normalized: ((avgCort - 1) / 4) * 100 },
  ];

  drawRadarChart('radar-chart', metrics);
}

function renderInsights(rows) {
  const { strengths, improvements } = analyzeThemes(rows);

  function renderList(items, color) {
    if (!items.length) return '<div class="no-data">Dati insufficienti</div>';
    const maxCount = items[0]?.[1] || 1;
    return items.slice(0, 5).map(([key, count]) => {
      const theme = THEMES[key];
      const pct = (count / maxCount) * 100;
      return `
        <div class="insight-item">
          <span>${theme.icon}</span>
          <span style="flex:1">${theme.label}</span>
          <div class="theme-bar" style="width:${Math.max(20, pct * 0.6)}px;background:${color}"></div>
          <span class="theme-count">${count}</span>
        </div>`;
    }).join('');
  }

  document.getElementById('insights-content').innerHTML = `
    <div class="insight-panel strengths">
      <h4>Punti di forza</h4>
      ${renderList(strengths, 'var(--success)')}
    </div>
    <div class="insight-panel improvements">
      <h4>Da migliorare</h4>
      ${renderList(improvements, 'var(--danger)')}
    </div>`;
}

function renderAlerts(rows) {
  const dataRows = rows.slice(1).filter(r => {
    const v = parseFloat(r[COL.soddisfazione]);
    return !isNaN(v) && v < 6;
  });

  const card = document.getElementById('alerts-card');
  if (!dataRows.length) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  document.getElementById('alerts-count').textContent = dataRows.length + ' segnalazioni';

  const recent = [...dataRows].sort((a, b) => parseTs(b[COL.data]) - parseTs(a[COL.data])).slice(0, 5);
  document.getElementById('alerts-list').innerHTML = recent.map(r => {
    const fullName = [r[COL.nome], r[COL.cognome]].filter(Boolean).join(' ');
    const note = r[COL.miglioramenti] ? ` — ${r[COL.miglioramenti]}` : '';
    return `
      <div class="alert-item">
        <span class="alert-score">${r[COL.soddisfazione]}/10</span>
        <span><span class="alert-name">${fullName || 'Anonimo'}</span>${note}</span>
        <span class="alert-date">${formatDate(r[COL.data])}</span>
      </div>`;
  }).join('');
}

function renderComments(rows) {
  const dataRows = rows.slice(1).filter(r => r[COL.nome] || r[COL.apprezzato] || r[COL.miglioramenti]);
  document.getElementById('comments-count').textContent = `${dataRows.length} risposte`;

  if (!dataRows.length) {
    document.getElementById('comments-list').innerHTML = '<div class="no-data">Nessun commento disponibile</div>';
    return;
  }

  const recent = [...dataRows].reverse().slice(0, 10);
  document.getElementById('comments-list').innerHTML = recent.map(r => {
    const fullName = [r[COL.nome], r[COL.cognome]].filter(Boolean).join(' ');
    return `
      <div class="comment-item">
        <div class="comment-avatar">${initials(fullName)}</div>
        <div class="comment-body">
          <div class="comment-meta">
            <span class="comment-name">${fullName || 'Anonimo'}</span>
            <span class="comment-date">${formatDate(r[COL.data])}</span>
            ${r[COL.soddisfazione] !== '' ? `<span class="comment-stars" style="color:var(--warn)">\u2605 ${r[COL.soddisfazione]}/10</span>` : ''}
          </div>
          ${r[COL.apprezzato] ? `<div class="comment-text">${r[COL.apprezzato]}</div>` : ''}
          ${r[COL.miglioramenti] ? `<div class="comment-note">${r[COL.miglioramenti]}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ── AI Summary ─────────────────────────────────────────────────────────────
let _currentRows = null;

async function requestAISummary() {
  if (!_currentRows) return;
  const btn = document.getElementById('ai-btn');
  const container = document.getElementById('ai-summary');
  btn.disabled = true;
  btn.textContent = 'Analisi in corso...';
  container.innerHTML = '<div class="skeleton"></div><div class="skeleton" style="margin-top:.5rem;width:80%"></div>';

  const dataRows = _currentRows.slice(1);
  const comments = dataRows.map(r => {
    const name = [r[COL.nome], r[COL.cognome]].filter(Boolean).join(' ');
    const parts = [];
    if (r[COL.apprezzato]) parts.push(`Apprezzato: ${r[COL.apprezzato]}`);
    if (r[COL.miglioramenti]) parts.push(`Da migliorare: ${r[COL.miglioramenti]}`);
    if (r[COL.soddisfazione]) parts.push(`Voto: ${r[COL.soddisfazione]}/10`);
    return `[${name || 'Anonimo'}] ${parts.join(' | ')}`;
  }).filter(c => c.length > 15).join('\n');

  try {
    const resp = await fetch(AI_SUMMARY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comments }),
    });
    const data = await resp.json();
    container.innerHTML = `<p>${data.summary || 'Nessun riassunto generato.'}</p>
      <div style="font-size:0.65rem;color:var(--muted);margin-top:0.6rem;font-family:'DM Mono',monospace">
        Generato: ${new Date().toLocaleTimeString('it-IT')}
      </div>`;
  } catch (err) {
    container.innerHTML = `<p class="muted-text">Errore nella generazione AI. Verifica che Ollama sia attivo sulla VPS.</p>`;
  }

  btn.disabled = false;
  btn.textContent = 'Genera analisi';
}

// ── Frequency Extraction (client-side) ────────────────────────────────────
const IT_STOPWORDS = new Set([
  'di','il','la','le','lo','i','gli','un','una','uno','del','della','delle',
  'dei','degli','al','alla','alle','allo','ai','dal','dalla','dalle','dai',
  'nel','nella','nelle','nei','sul','sulla','sulle','sui','con','per','tra',
  'fra','in','da','a','e','o','ma','che','non','si','mi','ti','ci','vi',
  'lo','la','li','ne','se','come','anche','piu','molto','sono','stato',
  'stata','essere','hanno','ha','ho','suo','sua','loro','questo','questa',
  'quello','quella','tutto','tutti','ogni','altri','altre','chi','cosa',
  'quando','dove','perche','era','fatto','fare','bene','poi','ancora',
]);

function extractFrequencies(rows, colIndex) {
  const texts = rows.slice(1)
    .map(r => String(r[colIndex] || '').trim())
    .filter(t => t.length > 2);

  if (!texts.length) return [];

  const wordCounts = {};
  const bigramCounts = {};

  texts.forEach(text => {
    const words = text.toLowerCase()
      .replace(/[.,!?;:()"""'']/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !IT_STOPWORDS.has(w));

    words.forEach(w => { wordCounts[w] = (wordCounts[w] || 0) + 1; });

    for (let i = 0; i < words.length - 1; i++) {
      const bg = words[i] + ' ' + words[i + 1];
      bigramCounts[bg] = (bigramCounts[bg] || 0) + 1;
    }
  });

  // Merge: bigrams with count >= 2, then single words
  const results = [];
  Object.entries(bigramCounts)
    .filter(([, c]) => c >= 2)
    .forEach(([phrase, count]) => results.push({ phrase, count }));

  Object.entries(wordCounts)
    .forEach(([phrase, count]) => results.push({ phrase, count }));

  results.sort((a, b) => b.count - a.count);
  return results.slice(0, 20);
}

// ── Insights Modal ────────────────────────────────────────────────────────
let _currentInsightsTab = 'apprezzato';

function openInsightsModal() {
  document.getElementById('insights-modal').classList.add('open');
  document.getElementById('modal-ai-results').innerHTML = '';
  switchInsightsTab('apprezzato');
}

function closeInsightsModal() {
  document.getElementById('insights-modal').classList.remove('open');
}

function switchInsightsTab(tab) {
  _currentInsightsTab = tab;
  document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  renderModalFrequencies(tab);
}

function renderModalFrequencies(tab) {
  if (!_currentRows) return;
  const colIndex = tab === 'apprezzato' ? COL.apprezzato : COL.miglioramenti;
  const freqs = extractFrequencies(_currentRows, colIndex);
  const body = document.getElementById('insights-modal-body');

  if (!freqs.length) {
    body.innerHTML = '<p class="muted-text">Dati insufficienti per l\'analisi.</p>';
    return;
  }

  const maxCount = freqs[0].count;
  body.innerHTML = `
    <div class="freq-list">
      ${freqs.slice(0, 12).map(f => {
        const pct = (f.count / maxCount) * 100;
        const color = tab === 'apprezzato' ? 'var(--success)' : 'var(--danger)';
        return `
          <div class="freq-item">
            <span class="freq-phrase">"${f.phrase}"</span>
            <div class="freq-bar-track">
              <div class="freq-bar-fill" style="width:${pct}%;background:${color}"></div>
            </div>
            <span class="freq-count">${f.count}</span>
          </div>`;
      }).join('')}
    </div>`;
}

async function requestModalAIInsights() {
  if (!_currentRows) return;
  const btn = document.getElementById('modal-ai-btn');
  const container = document.getElementById('modal-ai-results');
  btn.disabled = true;
  btn.textContent = 'Analisi AI in corso...';
  container.innerHTML = '<div class="skeleton"></div><div class="skeleton" style="margin-top:.5rem;width:80%"></div>';

  const colIndex = _currentInsightsTab === 'apprezzato' ? COL.apprezzato : COL.miglioramenti;
  const freqs = extractFrequencies(_currentRows, colIndex);
  const dataRows = _currentRows.slice(1);
  const sampleComments = dataRows
    .map(r => String(r[colIndex] || '').trim())
    .filter(t => t.length > 5)
    .slice(0, 10);

  try {
    const resp = await fetch(AI_INSIGHTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        column: _currentInsightsTab,
        totalResponses: dataRows.length,
        frequencies: freqs,
        sampleComments,
      }),
    });

    const data = await resp.json();
    let html = '';

    if (data.patterns && data.patterns.length) {
      html += '<div class="ai-patterns"><h4>Pattern identificati</h4>';
      data.patterns.forEach(p => {
        html += `
          <div class="pattern-card">
            <div class="pattern-header">
              <span class="pattern-theme">${p.theme}</span>
              <span class="pattern-pct">${p.percentage}%</span>
            </div>
            <div class="pattern-keywords">${(p.keywords || []).map(k => `<span class="keyword-tag">${k}</span>`).join('')}</div>
          </div>`;
      });
      html += '</div>';
    }

    if (data.redundancies && data.redundancies.length) {
      html += '<div class="ai-redundancies"><h4>Commenti ridondanti</h4>';
      data.redundancies.forEach(r => {
        html += `<div class="redundancy-item">${r}</div>`;
      });
      html += '</div>';
    }

    if (data.insight) {
      html += `<div class="ai-insight-box"><h4>Insight strategico</h4><p>${data.insight}</p></div>`;
    }

    container.innerHTML = html || '<p class="muted-text">Nessun insight generato.</p>';
  } catch (err) {
    container.innerHTML = '<p class="muted-text">Errore nella generazione AI. Verifica che Ollama sia attivo.</p>';
  }

  btn.disabled = false;
  btn.textContent = 'Analizza con AI';
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.id === 'insights-modal') closeInsightsModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeInsightsModal();
});

// ── Calendly ───────────────────────────────────────────────────────────────

function setCalendlyMode(mode) {
  _calendlyMode = mode;
  document.querySelectorAll('.trend-btn[data-cmode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cmode === mode);
  });
  const datesEl = document.getElementById('calendly-dates');
  if (mode === 'custom') {
    datesEl.style.display = 'flex';
  } else {
    datesEl.style.display = 'none';
    _calendlyCustomFrom = null;
    _calendlyCustomTo = null;
    loadCalendly(mode);
  }
}

function applyCalendlyRange() {
  const from = document.getElementById('calendly-from').value;
  const to = document.getElementById('calendly-to').value;
  _calendlyCustomFrom = from || null;
  _calendlyCustomTo = to || null;
  loadCalendly('custom', _calendlyCustomFrom, _calendlyCustomTo);
}

async function loadCalendly(mode, from, to, force) {
  mode = mode || _calendlyMode;

  const breakdown = document.getElementById('calendly-breakdown');
  const canvas = document.getElementById('calendly-chart');
  if (!breakdown || !canvas) return;

  breakdown.innerHTML = '<div class="skeleton"></div><div class="skeleton" style="margin-top:.7rem"></div>';
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const titleEl = document.getElementById('calendly-title');
  if (mode === 'monthly') titleEl.textContent = 'Riunioni Calendly (mensile)';
  else if (mode === 'daily') titleEl.textContent = 'Riunioni Calendly (giornaliero — ultimi 30gg)';
  else if (mode === 'custom') titleEl.textContent = 'Riunioni Calendly (periodo personalizzato)';
  else titleEl.textContent = 'Riunioni Calendly (settimanale)';

  let url = `${CALENDLY_URL}?mode=${mode}`;
  if (from) url += `&from=${from}`;
  if (to) url += `&to=${to}`;
  if (force) url += '&force=1';

  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      renderCalendlyError(err.error || `Errore ${resp.status}`);
      return;
    }
    const data = await resp.json();
    renderCalendly(data);
  } catch (err) {
    renderCalendlyError('Errore caricamento dati Calendly');
  }
}

function renderCalendlyError(msg) {
  document.getElementById('calendly-breakdown').innerHTML = `<div class="no-data">${msg}</div>`;
  const canvas = document.getElementById('calendly-chart');
  if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

function renderCalendly(data) {
  if (data.periods && data.periods.length) {
    requestAnimationFrame(() => drawVolumeChart('calendly-chart', data.periods));
  } else {
    const canvas = document.getElementById('calendly-chart');
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }
  renderCalendlyBreakdown(data.byType || [], data.total || 0);
}

function renderCalendlyBreakdown(byType, total) {
  const container = document.getElementById('calendly-breakdown');
  if (!byType.length) {
    container.innerHTML = '<div class="no-data">Nessuna riunione in questo periodo</div>';
    return;
  }
  const maxCount = byType[0].count;
  container.innerHTML = byType.map(t => {
    const pct = (t.count / maxCount) * 100;
    return `
      <div class="bar-group">
        <div class="bar-label">
          <span>${t.name}</span>
          <span style="color:var(--accent)">${t.count}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%;background:linear-gradient(90deg,#7c3aed,var(--accent))"></div>
        </div>
      </div>`;
  }).join('') + `<div class="calendly-total">Totale: ${total} riunioni</div>`;
}

// ── Render All ─────────────────────────────────────────────────────────────
function renderSheet(rows) {
  _currentRows = rows;
  renderKPI(rows);
  renderBars(rows);
  renderDist(rows);
  renderAlerts(rows);
  renderComments(rows);
  refreshTrend();
  loadCalendly('weekly');
}

// ── Load Data via backend proxy (fresh fetch) ──────────────────────────────
async function loadDataFresh(force = false) {
  updateLiveBadge('loading');

  try {
    const resp = await fetch(DATA_URL + (force ? '?force=1' : ''), {
      cache: 'no-store',
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();

    const rows = (json.data && json.data['Feedback Trading Concierge'])
      || json.trading
      || [];

    if (!rows || rows.length < 2) {
      document.getElementById('kpi-grid').innerHTML =
        '<div class="error-msg">Nessun dato trovato nel foglio.</div>';
      updateLiveBadge('cached');
      return;
    }

    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(rows));
      localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
    } catch (e) { /* quota exceeded — ignore */ }

    renderSheet(rows);
    updateRefreshStatus();
    updateLiveBadge('fresh');
  } catch (err) {
    console.error('Errore caricamento dati:', err);
    document.getElementById('kpi-grid').innerHTML =
      '<div class="error-msg">Errore nel caricamento dati.<br><small>' +
      (err.message || 'Backend non raggiungibile') + '</small></div>';
    updateLiveBadge('cached');
  }
}

function loadData() {
  const cachedTs = parseInt(localStorage.getItem(CACHE_TS_KEY) || '0');
  const cachedData = localStorage.getItem(CACHE_KEY);
  const age = Date.now() - cachedTs;

  if (cachedData && age < REFRESH_INTERVAL) {
    try {
      const rows = JSON.parse(cachedData);
      renderSheet(rows);
      updateRefreshStatus();
      updateLiveBadge('cached');
      return;
    } catch (e) { /* corrupted cache, fetch fresh */ }
  }

  loadDataFresh();
}

function forceRefresh() {
  localStorage.removeItem(CACHE_KEY);
  localStorage.removeItem(CACHE_TS_KEY);
  loadDataFresh(true);
  loadCalendly(_calendlyMode, _calendlyCustomFrom, _calendlyCustomTo, true);
}

// ── Refresh Status Display ────────────────────────────────────────────────
function updateRefreshStatus() {
  const el = document.getElementById('refresh-status');
  if (!el) return;

  const cachedTs = parseInt(localStorage.getItem(CACHE_TS_KEY) || '0');
  if (!cachedTs) {
    el.textContent = 'Caricamento...';
    return;
  }

  const lastDate = new Date(cachedTs);
  const nextDate = new Date(cachedTs + REFRESH_INTERVAL);
  const fmtOpts = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' };
  const last = lastDate.toLocaleDateString('it-IT', fmtOpts);
  const next = nextDate.toLocaleDateString('it-IT', fmtOpts);

  el.textContent = `Ultimo aggiornamento: ${last} — Prossimo: ${next}`;
}

function updateLiveBadge(state) {
  const badge = document.getElementById('live-badge');
  const dot = document.getElementById('live-dot');
  const label = document.getElementById('live-label');
  if (!badge || !dot || !label) return;

  if (state === 'loading') {
    dot.style.background = 'var(--warn)';
    label.textContent = 'AGGIORNAMENTO...';
  } else if (state === 'fresh') {
    dot.style.background = 'var(--accent)';
    label.textContent = 'AGGIORNATO';
    setTimeout(() => {
      dot.style.background = 'var(--accent)';
      label.textContent = 'LIVE';
    }, 3000);
  } else {
    dot.style.background = 'var(--muted)';
    label.textContent = 'CACHED';
  }
}

// ── Resize handling for canvas charts ──────────────────────────────────────
let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (_currentRows) refreshTrend();
  }, 250);
});

// ── Init ───────────────────────────────────────────────────────────────────
loadData();
// Check every 60s, fetch only if 12h expired
setInterval(() => {
  const cachedTs = parseInt(localStorage.getItem(CACHE_TS_KEY) || '0');
  if (Date.now() - cachedTs >= REFRESH_INTERVAL) {
    loadDataFresh();
  }
  updateRefreshStatus();
}, 60000);
