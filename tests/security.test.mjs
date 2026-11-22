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
["sanitizeUrl", "sanitizeHexColor", "migrate", "escapeHtml", "syncDecision",
 "normalizeEstimate", "nextExamDaysAway", "planCandidates", "planDay", "whatNowReason"].forEach((name) => {
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

/* ---- Wiederkehrende Aufgaben (#4): Serie + Pro-Vorkommen-Status ---- */
{
  // makeTask härtet die neuen Felder.
  const t = api.makeTask({ text: "Übung", date: "2026-11-23", repeat: "weekly", repeatUntil: "2026-12-31" });
  eq([t.repeat, t.repeatUntil], ["weekly", "2026-12-31"], "makeTask: repeat/repeatUntil übernommen");
  eq(Array.isArray(t.doneDates) && t.doneDates.length === 0, true, "makeTask: doneDates leer");
  eq(api.makeTask({ text: "X", date: "2026-11-23", repeat: "bogus" }).repeat, null, "makeTask: ungültiges repeat → null");

  // normalizeRepeat
  eq([api.normalizeRepeat("weekly"), api.normalizeRepeat("monthly"), api.normalizeRepeat("x"), api.normalizeRepeat(null)],
     ["weekly", "monthly", null, null], "normalizeRepeat: nur erlaubte Muster");

  // taskOccursOn nutzt dieselben Regeln wie Events.
  const weekly = { date: "2026-11-23", repeat: "weekly", repeatUntil: null, doneDates: [] }; // Mo
  eq(api.taskOccursOn(weekly, "2026-11-23"), true, "taskOccursOn: Starttag");
  eq(api.taskOccursOn(weekly, "2026-11-30"), true, "taskOccursOn: +7 Tage (gleicher Wochentag)");
  eq(api.taskOccursOn(weekly, "2026-11-24"), false, "taskOccursOn: Dienstag nein");
  eq(api.taskOccursOn({ date: null, repeat: "weekly" }, "2026-11-23"), false, "taskOccursOn: ohne Datum nie");

  // nextTaskOccurrence ab fromIso.
  eq(api.nextTaskOccurrence(weekly, "2026-11-24"), "2026-11-30", "nextTaskOccurrence: nächster Montag");
  eq(api.nextTaskOccurrence({ date: "2026-11-23", repeat: null }, "2026-11-24"), null, "nextTaskOccurrence: einmalig, vergangen → null");

  // isTaskOccurrenceDone: einmalig über done, Serie über doneDates.
  eq(api.isTaskOccurrenceDone({ repeat: null, done: true }, "2026-11-23"), true, "isTaskOccurrenceDone: einmalig done");
  eq(api.isTaskOccurrenceDone({ repeat: "weekly", doneDates: ["2026-11-23"] }, "2026-11-23"), true, "isTaskOccurrenceDone: Serie, Vorkommen erledigt");
  eq(api.isTaskOccurrenceDone({ repeat: "weekly", doneDates: ["2026-11-23"] }, "2026-11-30"), false, "isTaskOccurrenceDone: anderes Vorkommen offen");

  // setTaskOccurrenceDone mutiert korrekt.
  const s1 = { repeat: "weekly", doneDates: [] };
  api.setTaskOccurrenceDone(s1, "2026-11-23", true);
  eq(s1.doneDates, ["2026-11-23"], "setTaskOccurrenceDone: Vorkommen eintragen");
  api.setTaskOccurrenceDone(s1, "2026-11-23", false);
  eq(s1.doneDates, [], "setTaskOccurrenceDone: Vorkommen entfernen");
  const o1 = { repeat: null, done: false };
  api.setTaskOccurrenceDone(o1, "2026-11-23", true);
  eq(o1.done, true, "setTaskOccurrenceDone: einmalige Aufgabe setzt done");

  // currentTaskOccurrence: maßgebliches Vorkommen ab heute.
  eq(api.currentTaskOccurrence(weekly, "2026-11-24"), { date: "2026-11-30", done: false }, "currentTaskOccurrence: nächstes offenes Vorkommen");
  eq(api.currentTaskOccurrence({ date: "2026-11-23", repeat: null, done: false }, "2026-11-24"), { date: "2026-11-23", done: false }, "currentTaskOccurrence: einmalig → eigenes Datum");
  eq(api.currentTaskOccurrence({ date: "2026-11-23", repeat: "weekly", repeatUntil: "2026-11-25", doneDates: [] }, "2026-12-01"), null, "currentTaskOccurrence: abgelaufene Serie → null");

  // taskCompletion (explizites „heute" → deterministisch): Serie zählt das nächste Vorkommen.
  eq(api.taskCompletion({ repeat: "weekly", date: "2026-11-23", doneDates: [], subtasks: [] }, "2026-11-24"), 0, "taskCompletion: Serie, nächstes Vorkommen offen → 0");
  eq(api.taskCompletion({ repeat: "weekly", date: "2026-11-23", doneDates: ["2026-11-30"], subtasks: [] }, "2026-11-24"), 1, "taskCompletion: Serie, nächstes Vorkommen erledigt → 1");
  eq(api.taskCompletion({ repeat: "weekly", date: "2026-11-23", repeatUntil: "2026-11-25", doneDates: [], subtasks: [] }, "2026-12-01"), 1, "taskCompletion: abgelaufene Serie → 1 (erledigt)");
  eq(api.taskCompletion({ repeat: null, done: true, subtasks: [] }, "2026-11-24"), 1, "taskCompletion: einmalig done → 1");
}

/* ---- migrate v10: Aufgaben-Wiederholung additiv + gehärtet ---- */
{
  const d = api.migrate({
    schemaVersion: 9,
    modules: [{ id: "m", name: "M", ects: 5, tasks: [
      // Gültige Serie + gemischte doneDates (ungültige/doppelte werden entfernt)
      { id: "t1", text: "Wöchentlich", date: "2026-11-23", repeat: "weekly", repeatUntil: "2026-12-31",
        doneDates: ["2026-11-23", "2026-11-23", "kaputt", 42] },
      // repeat ohne Datum → Serienfelder müssen zurückgesetzt werden
      { id: "t2", text: "Ohne Datum", date: null, repeat: "daily", repeatUntil: "2026-12-01", doneDates: ["2026-11-01"] },
      // ungültiges repeat → null; doneDates nur für Serien → geleert
      { id: "t3", text: "Krumm", date: "2026-11-24", repeat: "bogus", doneDates: ["2026-11-24"] },
    ] }],
  });
  const [t1, t2, t3] = d.modules[0].tasks;
  eq([t1.repeat, t1.repeatUntil], ["weekly", "2026-12-31"], "migrate v10: gültige Serie bleibt");
  eq(t1.doneDates, ["2026-11-23"], "migrate v10: doneDates dedupliziert + bereinigt");
  eq([t2.repeat, t2.repeatUntil, t2.doneDates.length], [null, null, 0], "migrate v10: repeat ohne Datum → zurückgesetzt");
  eq([t3.repeat, t3.doneDates.length], [null, 0], "migrate v10: ungültiges repeat → null, doneDates geleert");
  // Bestandsaufgaben ohne die neuen Felder bekommen saubere Defaults.
  const d2 = api.migrate({ modules: [{ id: "m", name: "M", ects: 3, tasks: [{ id: "x", text: "Alt", date: "2026-11-23" }] }] });
  const tx = d2.modules[0].tasks[0];
  eq([tx.repeat, tx.repeatUntil, Array.isArray(tx.doneDates)], [null, null, true], "migrate v10: Alt-Aufgabe additiv gedefaultet");
}

/* ---- nextModuleDue mit wiederkehrenden Aufgaben ---- */
{
  const mod = { tasks: [
    { text: "Serie Mo", date: "2026-11-23", repeat: "weekly", doneDates: [] },  // nächstes ab Di 24. → Mo 30.
    { text: "Einmalig Do", date: "2026-11-26", done: false, repeat: null },      // 26. < 30. → gewinnt
  ]};
  eq(api.nextModuleDue(mod, "2026-11-24").date, "2026-11-26", "nextModuleDue: früheste über einmalig + Serie");
  // Serie, deren maßgebliches (nächstes) Vorkommen offen ist → dieses Datum zählt.
  const mod2 = { tasks: [
    { text: "Serie offen", date: "2026-11-23", repeat: "weekly", doneDates: [] },
  ]};
  eq(api.nextModuleDue(mod2, "2026-11-24").date, "2026-11-30", "nextModuleDue: Serie, nächstes offenes Vorkommen");
  // Serie, deren maßgebliches Vorkommen bereits erledigt ist → nicht fällig.
  const mod3 = { tasks: [
    { text: "Serie erledigt", date: "2026-11-23", repeat: "weekly", doneDates: ["2026-11-30"] },
  ]};
  eq(api.nextModuleDue(mod3, "2026-11-24"), null, "nextModuleDue: Serie mit erledigtem nächsten Vorkommen → null");
}

/* ---- „Heute planen" (Tagesplan aus Zeitbudget) ---- */
{
  // normalizeEstimate
  eq([api.normalizeEstimate(45), api.normalizeEstimate("90"), api.normalizeEstimate(0), api.normalizeEstimate(2000), api.normalizeEstimate(null), api.normalizeEstimate("")],
     [45, 90, null, null, null, null], "normalizeEstimate: 1..1440 oder null");

  // nextExamDaysAway: zugeordnete Prüfung schlägt globale; ohne Zuordnung Fallback global.
  const events = [
    { id: "x1", type: "exam", date: "2026-11-27", moduleId: "mA" },     // in 5 Tagen (zugeordnet mA)
    { id: "x2", type: "exam", date: "2026-11-24", moduleId: null },     // in 2 Tagen (global am nächsten)
    { id: "x3", type: "other", date: "2026-11-23", moduleId: "mA" },    // kein exam → ignoriert
  ];
  eq(api.nextExamDaysAway(events, "mA", "2026-11-22"), 5, "nextExamDaysAway: zugeordnete Prüfung (mA) in 5 Tagen");
  eq(api.nextExamDaysAway(events, "mB", "2026-11-22"), 2, "nextExamDaysAway: ohne Zuordnung → global nächste (2 Tage)");
  eq(api.nextExamDaysAway([], "mA", "2026-11-22"), null, "nextExamDaysAway: keine Prüfung → null");

  // planCandidates: nur angeheftete, offene Module; Sortierung Prüfungsnähe→Fälligkeit→Rückstand.
  const modules = [
    { id: "mA", name: "Mathe", pinned: true, completed: false, tasks: [
      { id: "tA1", text: "Blatt 3", date: "2026-11-22", done: false, estimateMin: 90 },   // heute, mA (Prüfung in 5)
      { id: "tA2", text: "Blatt 4", date: "2026-11-20", done: false, estimateMin: 60 },   // überfällig, mA
    ] },
    { id: "mB", name: "Physik", pinned: true, completed: false, tasks: [
      { id: "tB1", text: "Übung 1", date: "2026-11-22", done: false, estimateMin: 30 },   // heute, mB (Prüfung in 2 via global)
    ] },
    { id: "mC", name: "Nicht angeheftet", pinned: false, completed: false, tasks: [
      { id: "tC1", text: "Ignoriert", date: "2026-11-22", done: false },
    ] },
  ];
  const cands = api.planCandidates(modules, events, { perTask: {} }, "2026-11-22", 45);
  // mB-Task zuerst (Prüfung in 2 Tagen < 5). Dann mA: überfällig vor heute.
  eq(cands.map((c) => c.taskId), ["tB1", "tA2", "tA1"], "planCandidates: Prüfungsnähe → Fälligkeit → Rückstand");
  eq(cands.every((c) => c.moduleId !== "mC"), true, "planCandidates: nicht angeheftete Module ausgeschlossen");
  // Default-Aufwand greift, wenn keine Schätzung gesetzt ist.
  const noEst = api.planCandidates(
    [{ id: "m", name: "M", pinned: true, completed: false, tasks: [{ id: "t", text: "X", date: "2026-11-22", done: false }] }],
    [], { perTask: {} }, "2026-11-22", 45);
  eq(noEst[0].remainingMin, 45, "planCandidates: ohne Schätzung → Default 45");
  // Bereits gelernte Zeit reduziert den Rückstand; voll abgearbeitet → raus.
  const withStudied = api.planCandidates(
    [{ id: "m", name: "M", pinned: true, completed: false, tasks: [
      { id: "t1", text: "Teilweise", date: "2026-11-22", done: false, estimateMin: 60 },
      { id: "t2", text: "Fertig-Aufwand", date: "2026-11-22", done: false, estimateMin: 30 },
    ] }],
    [], { perTask: { t1: 1800, t2: 1800 } }, "2026-11-22", 45); // t1: 30 Min gelernt, t2: 30 Min
  eq(withStudied.map((c) => c.taskId), ["t1"], "planCandidates: abgearbeiteter Aufwand (t2) fällt raus");
  eq(withStudied[0].remainingMin, 30, "planCandidates: Rückstand = Schätzung − gelernt");

  // planDay: Blockaufteilung mit Pausen; Pausen zählen NICHT gegen das Budget.
  const plan = api.planDay(
    [{ taskId: "t1", moduleId: "m", title: "A", remainingMin: 50, occDate: null }], // 50 Min Aufwand
    50, 25, 5, 15, 4);  // Budget 50, Fokus 25, kurze Pause 5
  const focus = plan.blocks.filter((b) => b.kind === "focus");
  const breaks = plan.blocks.filter((b) => b.kind !== "focus");
  eq(focus.length, 2, "planDay: 50 Min / 25 → 2 Fokusblöcke");
  eq(plan.focusPlannedMin, 50, "planDay: 50 Fokusminuten geplant");
  eq(breaks.length, 1, "planDay: eine Pause zwischen zwei Fokusblöcken");
  eq(breaks[0].kind, "short", "planDay: kurze Pause (unter longEvery)");
  // Reihenfolge + Zeitachse: Fokus(0) → Pause(25) → Fokus(30).
  eq([plan.blocks[0].kind, plan.blocks[0].startOffsetMin], ["focus", 0], "planDay: erster Block ab 0");
  eq([plan.blocks[1].kind, plan.blocks[1].startOffsetMin], ["short", 25], "planDay: Pause ab Minute 25");
  eq([plan.blocks[2].kind, plan.blocks[2].startOffsetMin], ["focus", 30], "planDay: zweiter Fokus ab Minute 30 (nach Pause)");

  // planDay: lange Pause nach je 4 Fokusblöcken.
  const plan2 = api.planDay(
    [{ taskId: "t", moduleId: "m", title: "Lang", remainingMin: 999, occDate: null }],
    125, 25, 5, 15, 4); // 125/25 = 5 Fokusblöcke
  eq(plan2.blocks.filter((b) => b.kind === "focus").length, 5, "planDay: 125/25 → 5 Fokusblöcke");
  eq(plan2.blocks.filter((b) => b.kind === "long").length, 1, "planDay: eine lange Pause nach 4 Blöcken");
  eq(plan2.blocks.filter((b) => b.kind === "short").length, 3, "planDay: drei kurze Pausen");

  // planDay: Budget kleiner als eine Fokuslänge → ein kurzer Block über das Budget.
  const plan3 = api.planDay([{ taskId: "t", moduleId: "m", title: "X", remainingMin: 999, occDate: null }], 10, 25, 5, 15, 4);
  eq(plan3.blocks.length === 1 && plan3.blocks[0].durationMin === 10, true, "planDay: Budget < Fokuslänge → ein 10-Min-Block");
  // planDay: leere Kandidaten → leerer Plan.
  eq(api.planDay([], 180, 25, 5, 15, 4).blocks.length, 0, "planDay: ohne Kandidaten → leer");

  // whatNowReason: Begründung für den Top-Kandidaten.
  const wn = api.whatNowReason(cands);
  eq(wn.taskId, "tB1", "whatNowReason: Top-Kandidat ist der erste");
  eq(typeof wn.text === "string" && wn.text.includes("Übung 1"), true, "whatNowReason: Text nennt die Aufgabe");
  eq(wn.reasons.some((r) => /Prüfung/.test(r)), true, "whatNowReason: nennt Prüfungsnähe");
  eq(wn.reasons.some((r) => /Aufwand noch/.test(r)), true, "whatNowReason: nennt Restaufwand");
  eq(api.whatNowReason([]), null, "whatNowReason: ohne Kandidaten → null");
}

/* ---- migrate v11: Aufwandsschätzung + Prüfungs-Modulzuordnung ---- */
{
  const d = api.migrate({
    schemaVersion: 10,
    modules: [{ id: "m1", name: "M", ects: 5, tasks: [
      { id: "t1", text: "Mit Schätzung", date: "2026-11-23", estimateMin: 90 },
      { id: "t2", text: "Krumme Schätzung", date: "2026-11-23", estimateMin: 99999 },
      { id: "t3", text: "Ohne Schätzung", date: "2026-11-23" },
    ] }],
    events: [
      { id: "e1", date: "2026-11-27", title: "Klausur", type: "exam", moduleId: "m1" },   // gültige Zuordnung
      { id: "e2", date: "2026-11-27", title: "Fremd", type: "exam", moduleId: "nope" },    // ungültige → null
      { id: "e3", date: "2026-11-27", title: "Ohne", type: "exam" },                       // fehlt → null
    ],
  });
  const [t1, t2, t3] = d.modules[0].tasks;
  eq(t1.estimateMin, 90, "migrate v11: gültige Schätzung bleibt");
  eq(t2.estimateMin, null, "migrate v11: unplausible Schätzung → null");
  eq(t3.estimateMin, null, "migrate v11: fehlende Schätzung → null (Default greift im Planer)");
  eq(d.events[0].moduleId, "m1", "migrate v11: gültige Prüfungs-Modulzuordnung bleibt");
  eq(d.events[1].moduleId, null, "migrate v11: unbekannte Modul-Id → null");
  eq(d.events[2].moduleId, null, "migrate v11: fehlende Modul-Id → null");
}

/* ---- dueSoonSummary: In-App-Fälligkeits-Hinweis beim Öffnen (#6) ----
   Bündelt überfällige + heute/morgen fällige Prüfungen, Abgaben und Aufgaben.
   Signatur: dueSoonSummary(events, modules, todayStr). */
const dss = api.dueSoonSummary;
{
  const events = [
    { id: "e1", date: "2026-11-20", title: "Alte Klausur", type: "exam" },      // überfällig (vor heute)
    { id: "e2", date: "2026-11-22", title: "Heute-Abgabe", type: "deadline" },   // heute
    { id: "e3", date: "2026-11-23", title: "Morgen-Prüfung", type: "exam" },     // morgen
    { id: "e4", date: "2026-11-30", title: "Später", type: "exam" },             // zu weit weg → ignoriert
    { id: "e5", date: "2026-11-22", title: "Kein Prüfungstyp", type: "other" },  // falscher Typ → ignoriert
  ];
  const modules = [
    { tasks: [
      { text: "Überfällige Aufgabe", date: "2026-11-19", done: false },          // überfällig
      { text: "Heute-Aufgabe", date: "2026-11-22", done: false },                // heute
      { text: "Schon erledigt", date: "2026-11-22", done: true },                // done → ignoriert
      { text: "Ohne Datum", date: null, done: false },                           // kein Datum → ignoriert
    ] },
  ];
  const s = dss(events, modules, "2026-11-22");
  eq([s.total, s.overdue, s.today, s.soon], [5, 2, 2, 1], "dueSoonSummary: Zählung überfällig/heute/morgen");
  // Reihenfolge: überfällige zuerst (nach Datum), dann heute, dann morgen.
  eq(s.items[0].when, "overdue", "dueSoonSummary: Überfälliges steht oben");
  eq(s.items[s.items.length - 1].when, "soon", "dueSoonSummary: Morgen steht unten");
  eq(s.items.every((it) => ["exam", "deadline", "task"].includes(it.kind)), true, "dueSoonSummary: nur erlaubte Arten");
}
{
  // Wiederkehrende Prüfung: zählt über ihr nächstes Vorkommen (nie „überfällig").
  const s = dss(
    [{ id: "r1", date: "2026-11-15", title: "Wöchentlich", type: "exam", repeat: "weekly" }],
    [], "2026-11-22"
  );
  // 2026-11-15 war ein Sonntag → nächstes Vorkommen am 2026-11-22 (heute).
  eq([s.total, s.today], [1, 1], "dueSoonSummary: wiederkehrende Prüfung über nächstes Vorkommen");
  eq(s.items[0].when, "today", "dueSoonSummary: Wiederholung heute fällig");
}
{
  // Wiederkehrende Aufgabe: zählt über ihr nächstes offenes Vorkommen.
  const modules = [{ tasks: [
    // wöchentlich ab Mo 2026-11-16; heute ist 2026-11-23 (Mo) → Vorkommen heute, offen.
    { text: "Wöchentliche Übung", date: "2026-11-16", repeat: "weekly", doneDates: [] },
    // dieselbe, aber heutiges Vorkommen schon erledigt → nicht melden.
    { text: "Schon erledigt heute", date: "2026-11-16", repeat: "weekly", doneDates: ["2026-11-23"] },
  ] }];
  const s = dss([], modules, "2026-11-23");
  eq([s.total, s.today], [1, 1], "dueSoonSummary: wiederkehrende Aufgabe über nächstes offenes Vorkommen");
  eq(s.items[0].kind, "task", "dueSoonSummary: wiederkehrende Aufgabe als task");
}
eq(dss([], [], "2026-11-22").total, 0, "dueSoonSummary: nichts fällig → leer");
eq(dss(null, null, "2026-11-22").total, 0, "dueSoonSummary: defensiv bei null-Eingaben");

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
