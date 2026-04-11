const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3050;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const SCRIPT_URL = process.env.SCRIPT_URL
  || 'https://script.google.com/macros/s/AKfycbyljYap0vjqm6lkVPYXq6ORlGuQgOgjsVIl0MUcAAkubK40Q5CH6GhTRnWvkxmYHeSf/exec';

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
