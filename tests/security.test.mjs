/* ============================================================
   Sicherheits- & Migrations-Tests der ECHTEN app.js-Logik
   ------------------------------------------------------------
   Anders als logic.test.js spiegelt dieser Test die Logik NICHT,
   sondern lädt app.js im Original und ruft die exportierten
   Funktionen (sanitizeUrl, sanitizeHexColor, migrate, escapeHtml)
   direkt auf. So fällt echter Drift zwischen Test und App auf.

   app.js greift beim Laden auf Browser-APIs (document, window,
   localStorage, …) zu. Wir stellen dafür minimale Stubs bereit
   und führen die Datei in einem vm-Kontext aus. Kein Build nötig.

   Ausführen:  node tests/security.test.mjs
   ============================================================ */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(__dirname, "..", "apps", "study", "app.js");
const source = readFileSync(appPath, "utf8");

/* ---- Minimale Browser-Stubs ----
   Ein per Proxy erzeugtes „Element“, das jeden Methodenaufruf (addEventListener,
   querySelector, classList.toggle, …) verträgt und immer wieder ein Element
   zurückgibt. Das reicht, damit der Top-Level-Boot-Code von app.js ohne Fehler
   durchläuft; getestet werden danach nur die reinen Logik-Exporte. */
function makeEl() {
  const el = {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [], attributes: {},
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, append() {}, prepend() {}, remove() {}, insertAdjacentHTML() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    focus() {}, blur() {}, click() {}, closest() { return null; },
    // Audio-Element-Stubs (Fokus-Radio ruft diese beim Boot):
    play() { return Promise.resolve(); }, pause() {}, load() {},
    paused: true, volume: 1, dataset: {},
    // escapeHtml nutzt div.textContent = str; return div.innerHTML — hier echt nachbilden:
    set textContent(v) { this._text = String(v); this.innerHTML = htmlEscape(String(v)); },
    get textContent() { return this._text || ""; },
    innerHTML: "", value: "", checked: false, hidden: false, disabled: false,
    textContentRaw: "",
  };
  return el;
}
// Echte HTML-Maskierung (entspricht dem, was der Browser bei textContent→innerHTML tut).
function htmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const store = new Map();
const documentStub = {
  createElement: () => makeEl(),
  getElementById: () => makeEl(),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  documentElement: makeEl(),
  body: makeEl(),
  activeElement: null,
  hidden: false,
};
const windowStub = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
  addEventListener() {}, removeEventListener() {},
  location: { href: "https://example.test/", split: () => ["https://example.test/"] },
  SUPABASE_CONFIG: { url: "DEINE_URL", anonKey: "DEIN_KEY" },
  supabase: undefined,
};
const localStorageStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const navigatorStub = { onLine: true, serviceWorker: undefined };

const moduleShim = { exports: {} };
const sandbox = {
  document: documentStub,
  window: windowStub,
  localStorage: localStorageStub,
  navigator: navigatorStub,
  URL,                      // für sanitizeUrl
  CSS: { escape: (s) => String(s) },
  console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  Date, Math, JSON, parseInt, parseFloat, isNaN, Number, String, Array, Object,
  module: moduleShim,
};
sandbox.window.window = sandbox.window;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "app.js" });

const api = moduleShim.exports;

/* ---- Test-Harness ---- */
let passed = 0, failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`✗ ${label}\n    erwartet: ${e}\n    erhalten: ${a}`); }
}
function ok(cond, label) { if (cond) passed++; else { failed++; console.error(`✗ ${label}`); } }

/* ---- Exporte vorhanden? ---- */
["sanitizeUrl", "sanitizeHexColor", "migrate", "escapeHtml", "syncDecision"].forEach((name) => {
  ok(typeof api[name] === "function", `Export vorhanden: ${name}`);
});

/* ---- escapeHtml (die XSS-kritische Maskierung) ---- */
eq(api.escapeHtml('<img src=x onerror=alert(1)>'), "&lt;img src=x onerror=alert(1)&gt;", "escapeHtml maskiert <>");
eq(api.escapeHtml('a & b'), "a &amp; b", "escapeHtml maskiert &");

/* ---- sanitizeHexColor ---- */
eq(api.sanitizeHexColor("#4f46e5"), "#4f46e5", "gültige 6-stellige Hex-Farbe bleibt");
eq(api.sanitizeHexColor("#abc"), "#abc", "gültige 3-stellige Hex-Farbe bleibt");
eq(api.sanitizeHexColor('red" onmouseover="alert(1)'), null, "style-Ausbruch wird abgelehnt");
eq(api.sanitizeHexColor("red"), null, "Farbname ohne # abgelehnt");
eq(api.sanitizeHexColor("#12g"), null, "ungültiges Hex-Zeichen abgelehnt");
eq(api.sanitizeHexColor(null), null, "null → null");
eq(api.sanitizeHexColor(123), null, "Nicht-String → null");

/* ---- sanitizeUrl (echte App-Implementierung) ---- */
eq(api.sanitizeUrl("moodle.hs.de/kurs"), "https://moodle.hs.de/kurs", "URL ohne Schema → https ergänzt");
eq(api.sanitizeUrl("javascript:alert(1)"), null, "javascript: abgelehnt");
eq(api.sanitizeUrl("localhost"), null, "Host ohne Punkt abgelehnt");
eq(api.sanitizeUrl("   "), null, "leer → null");

/* ---- migrate härtet gefährliche Felder (Import/Sync-Pfad) ---- */
// Präparierte Daten, wie sie aus einem bösartigen JSON-Import/Sync kämen.
const dirty = {
  schemaVersion: 3,
  events: [
    { id: "e1", date: "2026-11-20", title: "X", type: "exam", color: 'red" onmouseover="alert(1)', url: "javascript:alert(1)" },
    { id: "e2", date: "2026-11-21", title: "Y", type: "other", color: "#00ff00", url: "zoom.us/j/123" },
  ],
  modules: [
    { id: "m1", name: "Mathe", ects: 6, links: [
      { id: "l1", label: "böse", url: "javascript:alert(1)" },
      { id: "l2", label: "gut", url: "https://ilias.uni-x.de/goto.php?id=42" },
      { id: "l3", label: "ohne Schema", url: "moodle.hs.de/kurs" },
    ] },
  ],
};
const clean = api.migrate(dirty);
eq(clean.events[0].color, null, "migrate: injizierte Event-Farbe wird verworfen");
eq(clean.events[1].color, "#00ff00", "migrate: gültige Event-Farbe bleibt");
eq(clean.events[0].url, "", "migrate: javascript:-Event-URL wird verworfen");
eq(clean.events[1].url, "https://zoom.us/j/123", "migrate: Event-URL ohne Schema wird zu https");
eq(clean.modules[0].links[0].url, "", "migrate: javascript:-Link-URL wird verworfen");
eq(clean.modules[0].links[1].url, "https://ilias.uni-x.de/goto.php?id=42", "migrate: gültige Link-URL bleibt");
eq(clean.modules[0].links[2].url, "https://moodle.hs.de/kurs", "migrate: Link ohne Schema wird zu https");
eq(clean.schemaVersion, api.SCHEMA_VERSION, "migrate: schemaVersion wird auf aktuelle Version gesetzt");

/* ---- migrate v9: Aufgaben-Zeiten/Link + Aufräumen alter Felder ---- */
{
  const d = api.migrate({
    schemaVersion: 8,
    modules: [{ id: "m", name: "M", ects: 5, tasks: [
      // Alt-Aufgabe mit entfernten Feldern kind/pinned + gültige Zeit + Link ohne Schema
      { id: "t1", text: "Vorlesung alt", kind: "lecture", pinned: true, startTime: "10:00", endTime: "11:30", url: "vhb.org/kurs" },
      // Ungültige Zeiten + böser Link
      { id: "t2", text: "Kaputt", startTime: "99:99", endTime: "abc", url: "javascript:alert(1)" },
    ] }],
  });
  const tasks = d.modules[0].tasks;
  eq(tasks[0].kind, undefined, "migrate v9: altes Feld 'kind' entfernt");
  eq(tasks[0].pinned, undefined, "migrate v9: altes Feld 'pinned' entfernt");
  eq([tasks[0].startTime, tasks[0].endTime], ["10:00", "11:30"], "migrate v9: gültige Von–Bis-Zeit bleibt");
  eq(tasks[0].url, "https://vhb.org/kurs", "migrate v9: Link ohne Schema → https");
  eq([tasks[1].startTime, tasks[1].endTime], [null, null], "migrate v9: ungültige Zeiten → null");
  eq(tasks[1].url, "", "migrate v9: javascript:-Link verworfen");
}

/* ---- migrate v9: Events Zeit-Migration + Event-Typ 'lecture' entfällt ---- */
{
  const d = api.migrate({
    events: [
      // altes Einzelfeld time → startTime; Typ lecture → other
      { id: "e1", date: "2026-11-20", time: "09:15", title: "Alt", type: "lecture" },
      { id: "e2", date: "2026-11-21", startTime: "08:00", endTime: "09:30", title: "Neu", type: "exam" },
    ],
  });
  eq([d.events[0].startTime, d.events[0].endTime], ["09:15", null], "migrate v9: event.time → startTime");
  eq(d.events[0].time, undefined, "migrate v9: altes event.time entfernt");
  eq(d.events[0].type, "other", "migrate v9: Event-Typ 'lecture' → 'other'");
  eq([d.events[1].startTime, d.events[1].endTime], ["08:00", "09:30"], "migrate v9: Von–Bis bleibt");
}

/* ---- migrate ist defensiv bei Müll-Eingaben ---- */
eq(api.migrate(null).modules, [], "migrate(null) → leere Module");
eq(api.migrate({}).events, [], "migrate({}) → leere Events");
eq(api.migrate(undefined).modules, [], "migrate(undefined) → leere Module");

/* ---- Sync-Entscheidung (Geräte-Sync, Konfliktauflösung) ----
   Signatur: syncDecision(localTs, remoteTs, lastSyncedRemoteTs, hasRemote)
   Diese Logik entscheidet, welcher Stand gewinnt — ein Fehler hier bedeutet
   echten Datenverlust über Geräte hinweg. Darum eng abgedeckt. */
const SD = api.syncDecision;
// Neue Signatur: syncDecision(localTs, remoteTs, lastSyncedRemoteTs, hasRemote, localHasData, remoteHasData)
// Substanz schlägt Zeitstempel: Ein leerer Stand darf einen Stand mit Daten
// NIE überschreiben (behebt den Datenverlust beim Anmelden eines leeren Geräts).

// --- Substanz-Regeln (unabhängig von den Zeitstempeln) ---
// Server noch leer → lokalen Stand hochladen.
eq(SD(100, 0, 0, false, true, false), "upload", "Sync: leerer Server → upload");
// Remote hat Daten, lokal LEER → immer übernehmen, selbst wenn lokal „neuer" ist.
// (Das ist der iPhone-Fall: frisch gebootetes, leeres Gerät zieht die Daten,
//  statt seinen leeren Stand hochzuladen und die vollen Serverdaten zu löschen.)
eq(SD(999, 100, 0, true, false, true), "apply", "Sync: lokal leer, Remote hat Daten → apply (kein Datenverlust)");
// Lokal hat Daten, Remote LEER → niemals den leeren Server übernehmen, lokal gewinnt.
eq(SD(100, 999, 0, true, true, false), "upload", "Sync: Remote leer, lokal hat Daten → upload (lokal gewinnt)");
// Beide leer → hochladen (egal, nichts zu verlieren).
eq(SD(100, 200, 0, true, false, false), "upload", "Sync: beide leer → upload");

// --- Zeitstempel-Regeln, wenn BEIDE Seiten Daten haben ---
// Remote älter/gleich → lokal ist aktuell, hochladen.
eq(SD(200, 100, 50, true, true, true), "upload", "Sync: Remote älter → upload");
eq(SD(200, 200, 50, true, true, true), "upload", "Sync: gleich alt → upload (kein Überschreiben)");
// Remote neuer, lokal seit letztem Sync NICHT geändert → Server gewinnt klar.
eq(SD(100, 200, 100, true, true, true), "apply", "Sync: Remote neuer, kein Lokal-Edit → apply");
// Remote neuer, lokal seit letztem Sync geändert → echter Konflikt (Rückfrage).
eq(SD(300, 400, 100, true, true, true), "conflict", "Sync: Remote neuer + Lokal-Edit → conflict");
// Erstabgleich mit Daten auf BEIDEN Seiten (lastSyncedRemoteTs=0): NICHT mehr stumm
// übernehmen, sondern Rückfrage — genau hier ging früher der Fortschritt verloren.
eq(SD(300, 400, 0, true, true, true), "conflict", "Sync: Erstabgleich, beide haben Daten → conflict (Rückfrage)");

/* ---- Noten je Semester (Dashboard-Verlauf) ---- */
const gbs = api.gradesBySemester;
{
  // SS26 (2,0@6 + 3,0@6 → gewichtet 2,5), WS26 (1,0@6), ohne Semester (4,0),
  // unbenotetes Modul wird ignoriert. Reihenfolge: SS26 vor WS26 vor „Ohne Semester".
  const rows = gbs([
    { grade: 2.0, ects: 6, semester: "SS26" },
    { grade: 3.0, ects: 6, semester: "SS26" },
    { grade: 1.0, ects: 6, semester: "WS26" },
    { grade: 4.0, ects: 0, semester: null },
    { grade: null, ects: 6, semester: "SS26" },
  ]);
  eq(rows.map((r) => r.semester), ["SS26", "WS26", "Ohne Semester"], "Semester-Noten: Reihenfolge SS→WS→ohne");
  eq(Number(rows[0].avg.toFixed(2)), 2.5, "Semester-Noten: SS26 gewichtet = 2,5");
  eq(rows[0].count, 2, "Semester-Noten: SS26 zählt 2 benotete Module");
  eq(gbs([{ grade: null, ects: 6, semester: "SS26" }]), [], "Semester-Noten: ohne Noten → leer");
}

/* ---- Kalender-Suche: Treffer an einem Tag ---- */
const dmq = api.dayMatchesQuery;
eq(dmq([{ title: "Mathe-Klausur" }], [], "klausur"), true, "Kalendersuche: Event-Titel trifft");
eq(dmq([], [{ task: { text: "Übungsblatt 2" }, module: { name: "Lineare Algebra" } }], "algebra"), true, "Kalendersuche: Modulname der Aufgabe trifft");
eq(dmq([{ title: "Vorlesung" }], [], "prüfung"), false, "Kalendersuche: kein Treffer");
eq(dmq([{ title: "X" }], [], ""), false, "Kalendersuche: leerer Begriff → kein Treffer");

/* ---- ICS-Import (Parser) ---- */
const parseIcs = api.parseIcs;
{
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:abc@uni", "SUMMARY:Analysis Vorlesung",
    "DTSTART;TZID=Europe/Berlin:20261124T101500",
    "RRULE:FREQ=WEEKLY;UNTIL=20270201T000000", "END:VEVENT",
    "BEGIN:VEVENT", "SUMMARY:Abgabe Blatt 1", "DTSTART;VALUE=DATE:20261130", "END:VEVENT",
    "BEGIN:VEVENT", "SUMMARY:Ohne Datum", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const ev = parseIcs(ics);
  eq(ev.length, 2, "ICS-Import: Events ohne DTSTART werden verworfen (2 von 3)");
  eq([ev[0].title, ev[0].date, ev[0].startTime], ["Analysis Vorlesung", "2026-11-24", "10:15"], "ICS-Import: Titel + Datum + Startzeit");
  eq([ev[0].repeat, ev[0].repeatUntil], ["weekly", "2027-02-01"], "ICS-Import: RRULE FREQ=WEEKLY + UNTIL");
  eq([ev[1].date, ev[1].startTime], ["2026-11-30", null], "ICS-Import: ganztägiges Datum ohne Zeit");
}
{
  // Zeilen-Folding (lange SUMMARY über zwei Zeilen) + INTERVAL=2 → biweekly.
  const ics = "BEGIN:VEVENT\r\nSUMMARY:Sehr langer\r\n  Titel\r\nDTSTART:20261201\r\nRRULE:FREQ=WEEKLY;INTERVAL=2\r\nEND:VEVENT";
  const ev = parseIcs(ics);
  eq(ev[0].title, "Sehr langer Titel", "ICS-Import: Zeilen-Folding entfaltet");
  eq(ev[0].repeat, "biweekly", "ICS-Import: INTERVAL=2 → biweekly");
}
eq(parseIcs("kein ics").length, 0, "ICS-Import: Nicht-ICS → leer");

/* ---- Uhrzeit-Helfer (Stundenraster-Wochenansicht) ---- */
const nt = api.normalizeTime, tRange = api.timeRange, mot = api.minutesOfTime;
eq(nt("9:05"), "09:05", "normalizeTime: führende Null ergänzt");
eq(nt("23:59"), "23:59", "normalizeTime: gültige Zeit bleibt");
eq(nt("24:00"), null, "normalizeTime: 24:00 ungültig");
eq(nt("12:60"), null, "normalizeTime: Minute 60 ungültig");
eq(nt("abc"), null, "normalizeTime: Unsinn → null");
eq(nt(null), null, "normalizeTime: null → null");
eq(tRange("09:00", "10:30"), "09:00–10:30", "timeRange: Von–Bis");
eq(tRange("09:00", null), "09:00", "timeRange: nur Start");
eq(tRange(null, "10:00"), "", "timeRange: ohne Start → leer");
eq(mot("08:30"), 510, "minutesOfTime: 08:30 = 510 Min.");
eq(mot(null), null, "minutesOfTime: null → null");

/* ---- itemSpan: Start/Ende mit Standard-Dauer ---- */
const span = api.itemSpan;
eq(span({ startTime: "09:00", endTime: "10:30" }, 60), { start: 540, end: 630 }, "itemSpan: Von–Bis");
eq(span({ startTime: "09:00", endTime: null }, 45), { start: 540, end: 585 }, "itemSpan: ohne Ende → Standard-Dauer 45");
eq(span({ startTime: "09:00", endTime: "08:00" }, 60), { start: 540, end: 600 }, "itemSpan: Ende ≤ Start → Standard-Dauer");
eq(span({ startTime: null }, 60), null, "itemSpan: ohne Start → null");

/* ---- layoutOverlaps: Spalten + Überschneidungsmarkierung ---- */
const lay = api.layoutOverlaps;
{
  // Zwei überlappende (09–10:30, 10–11) + ein separater (12–13).
  const r = lay([
    { id: "a", startTime: "09:00", endTime: "10:30" },
    { id: "b", startTime: "10:00", endTime: "11:00" },
    { id: "c", startTime: "12:00", endTime: "13:00" },
  ], 60);
  const byId = Object.fromEntries(r.map((x) => [x.it.id, x]));
  eq([byId.a.overlap, byId.b.overlap], [true, true], "layoutOverlaps: a & b überschneiden sich");
  eq(byId.c.overlap, false, "layoutOverlaps: c separat, keine Überschneidung");
  eq([byId.a.cols, byId.b.cols], [2, 2], "layoutOverlaps: Gruppe a/b hat 2 Spalten");
  eq([byId.a.col, byId.b.col], [0, 1], "layoutOverlaps: a in Spalte 0, b in Spalte 1");
  eq(byId.c.cols, 1, "layoutOverlaps: c allein → 1 Spalte");
}
{
  // Aneinandergrenzend (10–11, 11–12) gilt NICHT als Überschneidung.
  const r = lay([
    { id: "x", startTime: "10:00", endTime: "11:00" },
    { id: "y", startTime: "11:00", endTime: "12:00" },
  ], 60);
  eq(r.every((z) => !z.overlap), true, "layoutOverlaps: aneinandergrenzend ist keine Überschneidung");
}

/* ---- migrate v9: Wochenraster-Einstellungen ---- */
{
  const d1 = api.migrate({});
  eq(d1.weekGrid, { startHour: 8, endHour: 21, defaultDurationMin: 60 }, "migrate: Standard-Wochenraster");
  const d2 = api.migrate({ weekGrid: { startHour: 6, endHour: 22, defaultDurationMin: 90 } });
  eq(d2.weekGrid, { startHour: 6, endHour: 22, defaultDurationMin: 90 }, "migrate: gültiges Raster bleibt");
  const d3 = api.migrate({ weekGrid: { startHour: 20, endHour: 8, defaultDurationMin: 9999 } });
  eq(d3.weekGrid, { startHour: 8, endHour: 21, defaultDurationMin: 60 }, "migrate: ungültiges Raster → Standard");
}

/* ---- makeTask: zentrale Aufgaben-Factory (härtet Zeit & Link) ---- */
const mkt = api.makeTask;
{
  const t = mkt({ text: "  Kapitel 3  ", date: "2026-11-25", startTime: "9:00", endTime: "x", url: "moodle.hs.de/k" });
  eq(t.text, "Kapitel 3", "makeTask: Text getrimmt");
  eq(t.done, false, "makeTask: done=false");
  eq([t.startTime, t.endTime], ["09:00", null], "makeTask: Zeit normalisiert, ungültiges Ende → null");
  eq(t.url, "https://moodle.hs.de/k", "makeTask: Link gehärtet (https ergänzt)");
  eq(Array.isArray(t.subtasks) && t.subtasks.length === 0, true, "makeTask: leere Subtasks");
  const t2 = mkt({ text: "X", url: "javascript:alert(1)" });
  eq(t2.url, "", "makeTask: javascript:-Link verworfen");
  const t3 = mkt({ text: "Y" });
  eq([t3.date, t3.startTime, t3.endTime], [null, null, null], "makeTask: Defaults ohne Angaben");
}

/* ---- migrate: Dashboard-Spaltenlayout ---- */
eq(api.migrate({}).dashCols, 1, "migrate: Dashboard-Spalten Standard = 1");
eq(api.migrate({ dashCols: 2 }).dashCols, 2, "migrate: dashCols=2 bleibt");
eq(api.migrate({ dashCols: 5 }).dashCols, 1, "migrate: ungültige dashCols → 1");

/* ---- migrate: Fokus-Radio (URL gehärtet) ---- */
{
  const d = api.migrate({ radio: { url: "stream.dlf.de/live.mp3", label: "DLF", volume: 0.3 } });
  eq(d.radio.url, "https://stream.dlf.de/live.mp3", "migrate: Radio-URL gehärtet (https ergänzt)");
  eq(d.radio.volume, 0.3, "migrate: Radio-Lautstärke bleibt");
  eq(api.migrate({ radio: { url: "javascript:x", volume: 9 } }).radio.url, "", "migrate: böse Radio-URL verworfen");
  eq(api.migrate({}).radio, { url: "", label: "", volume: 0.6 }, "migrate: Radio-Default");
}

/* ---- nextModuleDue / dueStatusAt ---- */
const nmd = api.nextModuleDue, dsa = api.dueStatusAt;
{
  const mod = { tasks: [
    { done: false, date: "2026-11-28" },
    { done: false, date: "2026-11-25" },   // früheste offene → die zählt
    { done: true, date: "2026-11-20" },    // erledigt → ignoriert
    { done: false, date: null },           // ohne Datum → ignoriert
  ]};
  eq(nmd(mod, "2026-11-23").date, "2026-11-25", "nextModuleDue: früheste offene datierte Aufgabe");
  eq(nmd({ tasks: [{ done: true, date: "2026-11-25" }] }, "2026-11-23"), null, "nextModuleDue: nichts offen → null");
}
eq(dsa("2026-11-23", "2026-11-23").cls, "due-today", "dueStatusAt: heute");
eq(dsa("2026-11-24", "2026-11-23").cls, "due-soon", "dueStatusAt: morgen → due-soon");
eq(dsa("2026-11-20", "2026-11-23").cls, "overdue", "dueStatusAt: vergangen → overdue");

/* ---- buildHeatmap ---- */
{
  const hm = api.buildHeatmap({ "2026-11-20": 3600, "2026-11-23": 1800 }, "2026-11-23", 30);
  eq(hm.maxSec, 3600, "buildHeatmap: Maximum erkannt");
  const allCells = hm.weeks.reduce((a, w) => a + w.length, 0);
  eq(allCells >= 30, true, "buildHeatmap: deckt mindestens das Fenster ab");
  eq(Array.isArray(hm.weeks[0]), true, "buildHeatmap: Wochen sind Spalten-Arrays");
}

/* ---- ECTS-Studienziel ---- */
const ep = api.ectsProgress;
{
  const mods = [
    { ects: 6, completed: true }, { ects: 9, completed: true },
    { ects: 6, completed: false },
  ];
  eq(ep(mods, 180), { active: true, earned: 15, goal: 180, pct: 8, remaining: 165 }, "ECTS-Ziel: 15/180 erreicht");
  eq(ep(mods, 0).active, false, "ECTS-Ziel: kein Ziel gesetzt → inaktiv");
  eq(ep([{ ects: 100, completed: true }], 90).pct, 100, "ECTS-Ziel: Übererfüllung wird auf 100% gedeckelt");
}

/* ---- Feiertage (bundesweit) ---- */
const hol = api.holidayName;
// 2026: Ostersonntag = 5. April → Karfreitag 3.4., Ostermontag 6.4.
eq(api.easterSunday(2026).getMonth() + 1, 4, "Ostern 2026 im April");
eq(api.easterSunday(2026).getDate(), 5, "Ostersonntag 2026 = 5. April");
eq(hol("2026-04-03"), "Karfreitag", "Feiertag: Karfreitag 2026");
eq(hol("2026-04-06"), "Ostermontag", "Feiertag: Ostermontag 2026");
eq(hol("2026-01-01"), "Neujahr", "Feiertag: Neujahr");
eq(hol("2026-10-03"), "Tag der Deutschen Einheit", "Feiertag: 3. Oktober");
eq(hol("2026-05-14"), "Christi Himmelfahrt", "Feiertag: Christi Himmelfahrt 2026 (Ostern+39)");
eq(hol("2026-07-15"), null, "Normaler Tag → kein Feiertag");

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen.`);
process.exit(failed ? 1 : 0);
