# Calendly Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere alla dashboard una sezione Calendly con trend riunioni (barre) e breakdown per tipo di evento, alimentata da un endpoint `/api/calendly` sul server Node.js.

**Architecture:** Il server Node.js espone `/api/calendly` che chiama l'API Calendly v2, aggrega i dati per periodo e tipo, e li restituisce in cache (1 ora). Il frontend renderizza il grafico a barre riusando `drawVolumeChart()` già esistente e il breakdown con le classi `.bar-group` già in uso.

**Tech Stack:** Node.js (https nativo), Express, HTML/CSS/JS vanilla, Canvas API (già presente)

---

## File Map

| File | Azione | Responsabilità |
|---|---|---|
| `server.js` | Modifica | Aggiungere `/api/calendly` endpoint con cache |
| `public/index.html` | Modifica | Aggiungere sezione HTML Calendly |
| `public/dashboard.js` | Modifica | Aggiungere funzioni Calendly (load, render, controlli) |
| `public/style.css` | Modifica | Aggiungere layout `.calendly-body` a due colonne |

---

## Task 1: Endpoint `/api/calendly` in server.js

**Files:**
- Modify: `server.js` (dopo la riga `let _dataCache = ...`, prima di `app.get('/api/data'...)`)

- [ ] **Step 1: Aggiungere costante e cache Calendly**

Aprire `server.js` e aggiungere dopo la riga `const SCRIPT_URL = ...`:

```js
const CALENDLY_TOKEN = process.env.CALENDLY_TOKEN || '';
const CALENDLY_BASE = 'https://api.calendly.com';
let _calendlyOrgUri = null;       // cached: non scade
let _calendlyCache = {};          // keyed by cacheKey, { ts, data }
const CALENDLY_CACHE_TTL = 60 * 60 * 1000; // 1 ora
```

- [ ] **Step 2: Aggiungere helper `calendlyFetch`**

Aggiungere dopo le costanti appena inserite:

```js
async function calendlyFetch(path) {
  const url = path.startsWith('http') ? path : `${CALENDLY_BASE}${path}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${CALENDLY_TOKEN}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const err = await r.text();
    throw Object.assign(new Error(`Calendly ${r.status}`), { status: r.status, body: err });
  }
  return r.json();
}
```

- [ ] **Step 3: Aggiungere helper `getOrgUri`**

```js
async function getOrgUri() {
  if (_calendlyOrgUri) return _calendlyOrgUri;
  const data = await calendlyFetch('/users/me');
  _calendlyOrgUri = data.resource.current_organization;
  return _calendlyOrgUri;
}
```

- [ ] **Step 4: Aggiungere helper `fetchAllEvents`**

Gestisce la paginazione automatica di Calendly (max 100 eventi per pagina):

```js
async function fetchAllEvents(orgUri, minStart, maxStart) {
  const events = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({
      organization: orgUri,
      min_start_time: minStart,
      max_start_time: maxStart,
      status: 'active',
      count: '100',
    });
    if (pageToken) params.set('page_token', pageToken);
    const data = await calendlyFetch(`/scheduled_events?${params}`);
    events.push(...(data.collection || []));
    pageToken = data.pagination?.next_page_token || null;
  } while (pageToken);
  return events;
}
```

- [ ] **Step 5: Aggiungere helper `aggregateEvents`**

```js
function aggregateEvents(events, mode) {
  const periods = {};
  const byType = {};

  events.forEach(ev => {
    const d = new Date(ev.start_time);

    // Period key
    let key, label;
    if (mode === 'monthly') {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      label = d.toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
    } else {
      // weekly: lunedì della settimana
      const day = d.getDay();
      const diff = (day === 0 ? -6 : 1 - day);
      const monday = new Date(d);
      monday.setDate(d.getDate() + diff);
      monday.setHours(0, 0, 0, 0);
      key = monday.toISOString().slice(0, 10);
      label = monday.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
    }

    if (!periods[key]) periods[key] = { label, count: 0, sortKey: key };
    periods[key].count++;

    // By type
    const type = ev.name || 'Altro';
    byType[type] = (byType[type] || 0) + 1;
  });

  const sortedPeriods = Object.values(periods).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const sortedByType = Object.entries(byType)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { periods: sortedPeriods, byType: sortedByType };
}
```

- [ ] **Step 6: Aggiungere endpoint `GET /api/calendly`**

Aggiungere dopo il blocco `/api/data` e prima di `/api/summary`:

```js
// ── GET /api/calendly ──────────────────────────────────────────────────────
app.get('/api/calendly', async (req, res) => {
  if (!CALENDLY_TOKEN) {
    return res.status(503).json({ error: 'CALENDLY_TOKEN non configurato' });
  }

  const force = req.query.force === '1';
  const mode = req.query.mode || 'weekly';
  const now = new Date();

  let minStart, maxStart;
  if (req.query.from && req.query.to) {
    minStart = new Date(req.query.from).toISOString();
    maxStart = new Date(req.query.to + 'T23:59:59').toISOString();
  } else if (mode === 'monthly') {
    const from = new Date(now);
    from.setDate(now.getDate() - 365);
    minStart = from.toISOString();
    maxStart = now.toISOString();
  } else {
    const from = new Date(now);
    from.setDate(now.getDate() - 90);
    minStart = from.toISOString();
    maxStart = now.toISOString();
  }

  const cacheKey = `${mode}|${minStart}|${maxStart}`;
  if (!force && _calendlyCache[cacheKey] && Date.now() - _calendlyCache[cacheKey].ts < CALENDLY_CACHE_TTL) {
    return res.json(_calendlyCache[cacheKey].data);
  }

  try {
    const orgUri = await getOrgUri();
    const events = await fetchAllEvents(orgUri, minStart, maxStart);
    const { periods, byType } = aggregateEvents(events, mode);

    const weekAgo = new Date(now);
    weekAgo.setDate(now.getDate() - 7);
    const thisWeek = events.filter(ev => new Date(ev.start_time) >= weekAgo).length;

    const responseData = { periods, byType, total: events.length, thisWeek };
    _calendlyCache[cacheKey] = { ts: Date.now(), data: responseData };
    res.json(responseData);
  } catch (err) {
    console.error('Errore Calendly:', err.message);
    if (err.status === 401) return res.status(401).json({ error: 'Token Calendly non valido' });
    res.status(502).json({ error: 'Calendly non raggiungibile' });
  }
});
```

- [ ] **Step 7: Verificare la sintassi di server.js**

```bash
node --check server.js
```
Output atteso: nessun output (nessun errore di sintassi).

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "feat: aggiunge endpoint /api/calendly con cache e aggregazione"
```

---

## Task 2: Sezione HTML Calendly in index.html

**Files:**
- Modify: `public/index.html` (dopo il div `.trend-card`, prima di `.metrics-row`)

- [ ] **Step 1: Aggiungere la sezione Calendly**

In `public/index.html`, dopo la chiusura del `<div class="card trend-card">...</div>` e prima di `<div class="metrics-row">`, inserire:

```html
  <!-- Calendly Meetings -->
  <div class="card calendly-card">
    <div class="card-title">
      <span id="calendly-title">Riunioni Calendly</span>
      <div class="trend-controls">
        <button class="trend-btn active" data-cmode="weekly" onclick="setCalendlyMode('weekly')">Settimana</button>
        <button class="trend-btn" data-cmode="monthly" onclick="setCalendlyMode('monthly')">Mese</button>
        <button class="trend-btn" data-cmode="custom" onclick="setCalendlyMode('custom')">Personalizzato</button>
        <div class="trend-dates" id="calendly-dates" style="display:none">
          <input type="date" id="calendly-from">
          <span>-</span>
          <input type="date" id="calendly-to">
          <button class="trend-btn" onclick="applyCalendlyRange()">Applica</button>
        </div>
      </div>
    </div>
    <div class="calendly-body">
      <div class="calendly-chart-wrap">
        <canvas id="calendly-chart" height="200"></canvas>
      </div>
      <div id="calendly-breakdown">
        <div class="skeleton"></div>
        <div class="skeleton" style="margin-top:.7rem"></div>
        <div class="skeleton" style="margin-top:.7rem;width:70%"></div>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: aggiunge sezione HTML Calendly in dashboard"
```

---

## Task 3: CSS layout Calendly in style.css

**Files:**
- Modify: `public/style.css` (aggiungere in fondo al file)

- [ ] **Step 1: Aggiungere stili Calendly**

In fondo a `public/style.css`, aggiungere:

```css
/* ── Calendly Section ── */
.calendly-card { margin-bottom: 1.5rem; }
.calendly-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
  align-items: start;
}
.calendly-chart-wrap canvas { width: 100% !important; }
@media (max-width: 768px) { .calendly-body { grid-template-columns: 1fr; } }

.calendly-total {
  font-size: 0.72rem;
  color: var(--muted);
  font-family: 'Roboto Mono', monospace;
  margin-top: 0.8rem;
}
```

- [ ] **Step 2: Commit**

```bash
git add public/style.css
git commit -m "feat: aggiunge CSS layout sezione Calendly"
```

---

## Task 4: Logica JavaScript Calendly in dashboard.js

**Files:**
- Modify: `public/dashboard.js`

- [ ] **Step 1: Aggiungere costante e variabili di stato**

In cima a `dashboard.js`, dopo le costanti `DATA_URL`, `AI_SUMMARY_URL`, `AI_INSIGHTS_URL`, aggiungere:

```js
const CALENDLY_URL = '/api/calendly';
let _calendlyMode = 'weekly';
let _calendlyCustomFrom = null;
let _calendlyCustomTo = null;
```

- [ ] **Step 2: Aggiungere `setCalendlyMode`**

Aggiungere dopo la funzione `applyCustomRange()` esistente:

```js
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
```

- [ ] **Step 3: Aggiungere `applyCalendlyRange`**

```js
function applyCalendlyRange() {
  const from = document.getElementById('calendly-from').value;
  const to = document.getElementById('calendly-to').value;
  _calendlyCustomFrom = from || null;
  _calendlyCustomTo = to || null;
  loadCalendly('custom', _calendlyCustomFrom, _calendlyCustomTo);
}
```

- [ ] **Step 4: Aggiungere `loadCalendly`**

```js
async function loadCalendly(mode, from, to, force) {
  mode = mode || _calendlyMode;

  // Skeleton
  const breakdown = document.getElementById('calendly-breakdown');
  const canvas = document.getElementById('calendly-chart');
  breakdown.innerHTML = '<div class="skeleton"></div><div class="skeleton" style="margin-top:.7rem"></div>';
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Title
  const titleEl = document.getElementById('calendly-title');
  if (mode === 'monthly') titleEl.textContent = 'Riunioni Calendly (mensile)';
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
```

- [ ] **Step 5: Aggiungere `renderCalendlyError`**

```js
function renderCalendlyError(msg) {
  document.getElementById('calendly-breakdown').innerHTML =
    `<div class="no-data">${msg}</div>`;
  const canvas = document.getElementById('calendly-chart');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}
```

- [ ] **Step 6: Aggiungere `renderCalendly`**

```js
function renderCalendly(data) {
  // Grafico barre — riusa drawVolumeChart esistente
  if (data.periods && data.periods.length) {
    requestAnimationFrame(() => drawVolumeChart('calendly-chart', data.periods));
  } else {
    const canvas = document.getElementById('calendly-chart');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // Breakdown per tipo
  renderCalendlyBreakdown(data.byType || [], data.total || 0);
}
```

- [ ] **Step 7: Aggiungere `renderCalendlyBreakdown`**

```js
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
```

- [ ] **Step 8: Agganciare `loadCalendly` al caricamento pagina**

Nella funzione `renderSheet(rows)` esistente, aggiungere `loadCalendly('weekly')` alla fine:

```js
function renderSheet(rows) {
  _currentRows = rows;
  renderKPI(rows);
  renderBars(rows);
  renderDist(rows);
  renderAlerts(rows);
  renderComments(rows);
  refreshTrend();
  loadCalendly('weekly');   // ← aggiungere questa riga
}
```

- [ ] **Step 9: Agganciare `loadCalendly` al forceRefresh**

Nella funzione `forceRefresh()` esistente, aggiungere la chiamata a `loadCalendly`:

```js
function forceRefresh() {
  localStorage.removeItem(CACHE_KEY);
  localStorage.removeItem(CACHE_TS_KEY);
  loadDataFresh(true);
  loadCalendly(_calendlyMode, _calendlyCustomFrom, _calendlyCustomTo, true);  // ← aggiungere
}
```

- [ ] **Step 10: Commit**

```bash
git add public/dashboard.js
git commit -m "feat: aggiunge logica JavaScript sezione Calendly"
```

---

## Task 5: Push e deploy su VPS con token

**Files:** nessuno — operazioni su git e VPS

- [ ] **Step 1: Push su GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Pull e rebuild container sulla VPS con CALENDLY_TOKEN**

```bash
ssh -i "C:\Users\Giacomo Bertuso\.ssh\vps_deploy" root@144.91.90.41 \
  "cd /var/www/concierge && git pull origin main && docker build -t concierge-dashboard . 2>&1 | tail -5 && docker stop concierge && docker rm concierge && docker run -d --name concierge --restart unless-stopped -p 3050:3050 -e CALENDLY_TOKEN=<TOKEN> concierge-dashboard"
```

Sostituire `<TOKEN>` con il valore effettivo del Personal Access Token Calendly.

- [ ] **Step 3: Verificare che il container sia up**

```bash
ssh -i "C:\Users\Giacomo Bertuso\.ssh\vps_deploy" root@144.91.90.41 \
  "docker ps --filter name=concierge --format 'table {{.Names}}\t{{.Status}}'"
```

Output atteso: `concierge   Up X seconds`

- [ ] **Step 4: Verificare l'endpoint `/api/calendly`**

```bash
curl https://concierge.mistergiack.dev/api/calendly?mode=weekly
```

Output atteso: JSON con `periods`, `byType`, `total`, `thisWeek` (non un errore 503/401).

- [ ] **Step 5: Verifica visiva**

Aprire `https://concierge.mistergiack.dev` e verificare:
- La sezione "Riunioni Calendly" appare tra il trend chart e le Metriche di qualità
- Il grafico a barre mostra i periodi
- Il breakdown per tipo mostra le tipologie di riunioni
- I bottoni Settimana/Mese/Personalizzato funzionano
- Il bottone "Aggiorna ora" ricarica anche i dati Calendly
