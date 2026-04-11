// ────────────────────────────────────────────────────────────────
//  Incolla questo codice in Estensioni → Apps Script del tuo foglio
//  poi ridistribuisci come App Web (Chiunque può accedere)
// ────────────────────────────────────────────────────────────────
function doGet(e) {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const trading   = ss.getSheetByName("Feedback trading");
  const concierge = ss.getSheetByName("Concierge");

  const result = {
    trading:   trading   ? trading.getDataRange().getValues()   : [],
    concierge: concierge ? concierge.getDataRange().getValues() : [],
  };

  const json     = JSON.stringify(result);
  const callback = e.parameter.callback;

  // Se arriva un parametro callback → risposta JSONP (nessun errore CORS)
  // Altrimenti → risposta JSON normale
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
