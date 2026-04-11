// ────────────────────────────────────────────────────────────────
//  STEP 1 — Incolla questo, ridistribuisci, e apri l'URL nel browser
//  per vedere i nomi ESATTI delle tue schede
// ────────────────────────────────────────────────────────────────
function doGet(e) {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets().map(s => s.getName());

  // Prova a leggere tutte le schede disponibili
  const allSheets = {};
  ss.getSheets().forEach(s => {
    allSheets[s.getName()] = s.getDataRange().getValues();
  });

  const result = {
    sheetNames: sheets,       // <-- qui vedrai i nomi esatti
    data: allSheets
  };

  const json     = JSON.stringify(result);
  const callback = e.parameter.callback;

  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
