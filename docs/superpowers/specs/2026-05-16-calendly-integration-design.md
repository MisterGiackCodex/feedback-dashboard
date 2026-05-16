# Calendly Integration — Design Spec
_Data: 2026-05-16_

## Obiettivo

Aggiungere alla dashboard una sezione dedicata che mostri i dati delle riunioni Calendly: trend nel tempo e breakdown per tipo di evento. I controlli temporali (Settimana/Mese/Personalizzato) sono indipendenti da quelli del trend feedback ma hanno lo stesso stile.

---

## Architettura e flusso dati

```
Browser → GET /api/calendly?mode=weekly|monthly|custom&from=&to=
              ↓
          server.js
            - legge CALENDLY_TOKEN da process.env
            - chiama Calendly API v2:
                GET /users/me → ricava organization URI
                GET /scheduled_events (con min/max_start_time, paginazione)
            - aggrega per periodo (settimana o mese) e per event_type
            - cache in memoria 1 ora (invalidata da ?force=1)
              ↓
          JSON response → dashboard.js
```

**Struttura JSON risposta:**
```json
{
  "periods": [
    { "label": "12 mag", "count": 3 },
    { "label": "19 mag", "count": 5 }
  ],
  "byType": [
    { "name": "Call 30min", "count": 8 },
    { "name": "Consulenza", "count": 4 }
  ],
  "total": 12,
  "thisWeek": 3
}
```

---

## Backend — `server.js`

### Nuovo endpoint: `GET /api/calendly`

**Query params:**
| Param | Tipo | Default | Descrizione |
|---|---|---|---|
| `mode` | `weekly\|monthly\|custom` | `weekly` | Aggregazione del trend |
| `from` | ISO date string | calcolato da mode | Inizio range: weekly=90gg fa, monthly=365gg fa, custom=libero |
| `to` | ISO date string | oggi | Fine range |
| `force` | `1` | — | Invalida la cache |

**Flusso:**
1. Se `CALENDLY_TOKEN` assente → risponde `503 { error: "CALENDLY_TOKEN non configurato" }`
2. Se cache valida (< 1 ora) e `force` assente → restituisce dati cached
3. Chiama `GET /users/me` per ricavare l'`organization` URI (cached separatamente, non scade)
4. Chiama `GET /scheduled_events` con filtri date e paginazione (`next_page_token`)
5. Aggrega eventi per periodo (settimanale o mensile) e per `event_type.name`
6. Salva in cache e restituisce JSON

**Cache:** oggetto in-memory `{ data, fetchedAt }` per ogni combinazione `mode+from+to`. Reset globale su `?force=1`.

**Errori gestiti:**
- `401` da Calendly → `401 { error: "Token Calendly non valido" }`
- Timeout / rete → `502 { error: "Calendly non raggiungibile" }`

---

## Frontend — `dashboard.js` + `index.html` + `style.css`

### Nuova sezione HTML (in `index.html`)

Posizione: **tra il trend chart e le Metriche di qualità**.

```html
<div class="card calendly-card">
  <div class="card-title">
    <span id="calendly-title">Riunioni Calendly</span>
    <div class="trend-controls">
      <button class="trend-btn active" data-cmode="weekly">Settimana</button>
      <button class="trend-btn" data-cmode="monthly">Mese</button>
      <button class="trend-btn" data-cmode="custom">Personalizzato</button>
      <div class="trend-dates" id="calendly-dates" style="display:none">
        <input type="date" id="calendly-from">
        <span>-</span>
        <input type="date" id="calendly-to">
        <button class="trend-btn" onclick="applyCalendlyRange()">Applica</button>
      </div>
    </div>
  </div>
  <div class="calendly-body">
    <canvas id="calendly-chart" height="200"></canvas>
    <div id="calendly-breakdown"></div>
  </div>
</div>
```

### Nuove funzioni in `dashboard.js`

| Funzione | Responsabilità |
|---|---|
| `loadCalendly(mode, from, to)` | Fetch `/api/calendly`, gestisce loading/errori |
| `setCalendlyMode(mode)` | Aggiorna bottoni attivi, mostra/nasconde date picker |
| `applyCalendlyRange()` | Legge date picker e chiama `loadCalendly('custom', ...)` |
| `renderCalendly(data)` | Chiama `drawVolumeChart()` + renderizza breakdown |
| `renderCalendlyBreakdown(byType)` | Genera HTML con le `.bar-group` esistenti |

`loadCalendly()` viene chiamata:
- Al primo caricamento della pagina (mode=weekly)
- Quando si cambia modalità con i bottoni
- Quando l'utente clicca "Aggiorna ora" (forceRefresh)

### Stili (`style.css`)

```css
.calendly-card { margin-bottom: 1.5rem; }
.calendly-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
  align-items: start;
}
@media (max-width: 768px) { .calendly-body { grid-template-columns: 1fr; } }
```

Tutti gli altri stili riusano classi esistenti (`.bar-group`, `.bar-fill`, `.bar-label`, `.trend-btn`, `.skeleton`).

### Stati UI

| Stato | Comportamento |
|---|---|
| Loading | Skeleton loader nel canvas e nel breakdown |
| Token assente | Messaggio "Calendly non configurato — imposta CALENDLY_TOKEN" |
| Nessuna riunione | Messaggio "Nessuna riunione in questo periodo" |
| Errore rete | Messaggio "Errore caricamento dati Calendly" |

---

## Deploy

### Configurazione token sulla VPS

Al restart del container, aggiungere `--env`:

```bash
docker run -d --name concierge --restart unless-stopped \
  -p 3050:3050 \
  -e CALENDLY_TOKEN=your_token_here \
  concierge-dashboard
```

Il token si ottiene da: `app.calendly.com` → Integrations → API & Webhooks → Personal Access Token.

---

## Vincoli e scelte

- **Nessuna nuova dipendenza npm** — le chiamate HTTP a Calendly usano `https` nativo di Node.js (già usato nel progetto)
- **Nessun nuovo engine canvas** — `drawVolumeChart()` è già implementata e riusata
- **Nessun nuovo stile** — massimo 5 righe CSS per il layout a due colonne
- **Cache separata** da quella dei feedback — i due dataset hanno frequenze di aggiornamento diverse
