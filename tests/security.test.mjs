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
const appPath = resolve(__dirname, "..", "app.js");
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
    { id: "e1", date: "2026-11-20", title: "X", type: "exam", color: 'red" onmouseover="alert(1)' },
    { id: "e2", date: "2026-11-21", title: "Y", type: "other", color: "#00ff00" },
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
eq(clean.modules[0].links[0].url, "", "migrate: javascript:-Link-URL wird verworfen");
eq(clean.modules[0].links[1].url, "https://ilias.uni-x.de/goto.php?id=42", "migrate: gültige Link-URL bleibt");
eq(clean.modules[0].links[2].url, "https://moodle.hs.de/kurs", "migrate: Link ohne Schema wird zu https");
eq(clean.schemaVersion, api.SCHEMA_VERSION, "migrate: schemaVersion wird auf aktuelle Version gesetzt");

/* ---- migrate ist defensiv bei Müll-Eingaben ---- */
eq(api.migrate(null).modules, [], "migrate(null) → leere Module");
eq(api.migrate({}).events, [], "migrate({}) → leere Events");
eq(api.migrate(undefined).modules, [], "migrate(undefined) → leere Module");

/* ---- Sync-Entscheidung (Geräte-Sync, Konfliktauflösung) ----
   Signatur: syncDecision(localTs, remoteTs, lastSyncedRemoteTs, hasRemote)
   Diese Logik entscheidet, welcher Stand gewinnt — ein Fehler hier bedeutet
   echten Datenverlust über Geräte hinweg. Darum eng abgedeckt. */
const SD = api.syncDecision;
// Server noch leer → lokalen Stand hochladen (egal welche Zeitstempel).
eq(SD(100, 0, 0, false), "upload", "Sync: leerer Server → upload");
// Remote älter/gleich → lokal ist aktuell, hochladen.
eq(SD(200, 100, 50, true), "upload", "Sync: Remote älter → upload");
eq(SD(200, 200, 50, true), "upload", "Sync: gleich alt → upload (kein Überschreiben)");
// Remote neuer, lokal seit letztem Sync NICHT geändert → Server gewinnt klar.
eq(SD(100, 200, 100, true), "apply", "Sync: Remote neuer, kein Lokal-Edit → apply");
// Remote neuer, lokal seit letztem Sync geändert → echter Konflikt (Rückfrage).
eq(SD(300, 400, 100, true), "conflict", "Sync: Remote neuer + Lokal-Edit → conflict");
// Erststart ohne je gesyncten Stand (lastSyncedRemoteTs=0): kein „Konflikt",
// sondern Server übernehmen — sonst würde jeder Erstabgleich fälschlich fragen.
eq(SD(300, 400, 0, true), "apply", "Sync: Remote neuer, noch nie gesynct → apply (kein Fehlalarm)");

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen.`);
process.exit(failed ? 1 : 0);
