const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3050;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const SCRIPT_URL = process.env.SCRIPT_URL
  || 'https://script.google.com/macros/s/AKfycbyljYap0vjqm6lkVPYXq6ORlGuQgOgjsVIl0MUcAAkubK40Q5CH6GhTRnWvkxmYHeSf/exec';

const CALENDLY_TOKEN = process.env.CALENDLY_TOKEN || '';
const CALENDLY_BASE = 'https://api.calendly.com';
let _calendlyOrgUri = null;
let _calendlyCache = {};
const CALENDLY_CACHE_TTL = 60 * 60 * 1000;

async function calendlyFetch(path) {
  const url = path.startsWith('http') ? path : `${CALENDLY_BASE}${path}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${CALENDLY_TOKEN}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const err = await r.text();
    throw Object.assign(new Error(`Calendly ${r.status}`), { status: r.status, body: err });
  }
  return r.json();
}

function getUserUri() {
  if (_calendlyOrgUri) return _calendlyOrgUri;
  try {
    const payload = JSON.parse(Buffer.from(CALENDLY_TOKEN.split('.')[1], 'base64url').toString());
    _calendlyOrgUri = `${CALENDLY_BASE}/users/${payload.user_uuid}`;
    return _calendlyOrgUri;
  } catch {
    throw Object.assign(new Error('Token Calendly non valido o malformato'), { status: 401 });
  }
}

async function fetchAllEvents(userUri, minStart, maxStart) {
  const events = [];
  const firstParams = new URLSearchParams({
    user: userUri,
    min_start_time: minStart,
    max_start_time: maxStart,
    status: 'active',
    count: '100',
  });
  let url = `/scheduled_events?${firstParams}`;
  do {
    const data = await calendlyFetch(url);
    events.push(...(data.collection || []));
    url = data.pagination?.next_page || null;
  } while (url);
  return events;
}

function aggregateEvents(events, mode) {
  const periods = {};
  const byType = {};

  events.forEach(ev => {
    const d = new Date(ev.start_time);

    let key, label;
    if (mode === 'monthly') {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      label = d.toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
    } else {
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

    const type = ev.name || 'Altro';
    byType[type] = (byType[type] || 0) + 1;
  });

  const sortedPeriods = Object.values(periods).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const sortedByType = Object.entries(byType)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { periods: sortedPeriods, byType: sortedByType };
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── GET /api/data ─────────────────────────────────────────────────────────
// Proxy verso Apps Script: evita JSONP cross-origin che fallisce su mobile
// (content blocker, Safari ITP, redirect a googleusercontent.com bloccato).
let _dataCache = { ts: 0, body: null };
app.get('/api/data', async (req, res) => {
  const force = req.query.force === '1';
  const MAX_AGE = 5 * 60 * 1000; // 5 min server-side cache
  if (!force && _dataCache.body && Date.now() - _dataCache.ts < MAX_AGE) {
    return res.json(_dataCache.body);
  }
  try {
    const r = await fetch(SCRIPT_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const body = await r.json();
    _dataCache = { ts: Date.now(), body };
    res.json(body);
  } catch (err) {
    console.error('Errore fetch Apps Script:', err.message);
    if (_dataCache.body) return res.json(_dataCache.body);
    res.status(502).json({ error: 'Apps Script non raggiungibile' });
  }
});

// ── GET /api/calendly ─────────────────────────────────────────────────────
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
    const userUri = getUserUri();
    const events = await fetchAllEvents(userUri, minStart, maxStart);
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

// ── POST /api/summary ─────────────────────────────────────────────────────
app.post('/api/summary', async (req, res) => {
  const { comments } = req.body;
  if (!comments) return res.status(400).json({ error: 'comments richiesto' });

  const prompt = `Sei un analista di customer experience per un servizio di Trading Concierge. Analizza questi feedback di clienti e produci un riassunto professionale in italiano di 3-4 frasi. Evidenzia: i punti di forza principali, le aree di miglioramento piu frequenti, e un consiglio strategico. Sii conciso e diretto.

Feedback:
${comments}`;

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mistral', prompt, stream: false }),
      signal: AbortSignal.timeout(120000),
    });

    const data = await response.json();
    res.json({ summary: data.response || 'Nessun riassunto generato.' });
  } catch (err) {
    console.error('Errore AI summary:', err.message);
    res.status(502).json({ error: 'Ollama non raggiungibile o timeout' });
  }
});

// ── POST /api/insights ────────────────────────────────────────────────────
app.post('/api/insights', async (req, res) => {
  const { column, totalResponses, frequencies, sampleComments } = req.body;
  if (!column || !frequencies) return res.status(400).json({ error: 'column e frequencies richiesti' });

  const freqText = frequencies.slice(0, 20).map(f => `"${f.phrase}" (${f.count} volte)`).join(', ');
  const samplesText = (sampleComments || []).slice(0, 10).join('\n- ');

  const columnLabel = column === 'apprezzato' ? 'cose apprezzate dai clienti' : 'aree di miglioramento segnalate';

  const prompt = `Sei un analista di customer experience per un servizio di Trading Concierge. Analizza queste ${columnLabel} estratte da ${totalResponses} feedback.

Le frasi piu frequenti sono: ${freqText}

Commenti di esempio:
- ${samplesText}

Rispondi SOLO con un oggetto JSON valido (senza markdown, senza backtick) con questa struttura:
{
  "patterns": [
    {"theme": "nome tema", "percentage": numero, "keywords": ["parola1", "parola2"]},
    {"theme": "nome tema", "percentage": numero, "keywords": ["parola1", "parola2"]},
    {"theme": "nome tema", "percentage": numero, "keywords": ["parola1", "parola2"]}
  ],
  "redundancies": ["frase che descrive sinonimi raggruppati"],
  "insight": "un consiglio strategico basato sui dati"
}

Identifica i 3 pattern principali con percentuale stimata, raggruppa parole sinonime/ridondanti, e dai un insight azionabile. Tutto in italiano.`;

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mistral', prompt, stream: false }),
      signal: AbortSignal.timeout(120000),
    });

    const data = await response.json();
    const raw = (data.response || '').trim();

    // Try to parse JSON from the response
    let parsed;
    try {
      // Extract JSON if wrapped in markdown code blocks
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      parsed = { patterns: [], redundancies: [], insight: raw };
    }

    res.json(parsed);
  } catch (err) {
    console.error('Errore AI insights:', err.message);
    res.status(502).json({ error: 'Ollama non raggiungibile o timeout' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Dashboard server running on port ${PORT}`);
});
