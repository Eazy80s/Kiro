/* ============================================================
   Tests für die Karteikarten-App (apps/flashcards/app.js)
   Ausführen:  node tests/flashcards.test.mjs
   Kein Framework nötig — reines Node (>=18).

   Lädt die ECHTE app.js (über ihren module.exports-Pfad, ohne UI) und prüft
   die reine Logik direkt am Produktionscode — kein Spiegeln, kein Drift.
   ============================================================ */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const app = require(path.join(here, "..", "apps", "flashcards", "app.js"));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`✗ ${label}`); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`✗ ${label}\n    erwartet: ${e}\n    erhalten: ${a}`); }
}

const DAY = 86400000;
const NOW = new Date("2026-06-15T09:00:00").getTime();

/* ---- escapeHtml ---- */
eq(app.escapeHtml('<b>"x" & \'y\'</b>'),
  "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;", "escapeHtml maskiert alle Sonderzeichen");

/* ---- clampInt ---- */
eq(app.clampInt(9999, 5, 500, 40), 500, "clampInt begrenzt nach oben");
eq(app.clampInt(-3, 0, 200, 15), 0, "clampInt begrenzt nach unten");
eq(app.clampInt("abc", 5, 500, 40), 40, "clampInt liefert Fallback bei Unsinn");

/* ---- schedule (SM-2) ---- */
const fresh = { reps: 0, ease: 2.5, interval: 0, due: 0 };

// „Nochmal" (q<3): reps zurück auf 0, kurzfristig heute wieder fällig.
const again = app.schedule(fresh, 0, NOW);
eq(again.reps, 0, "schedule: Nochmal setzt reps auf 0");
eq(again.interval, 0, "schedule: Nochmal setzt interval 0");
ok(again.due > NOW && again.due < NOW + DAY, "schedule: Nochmal ist noch heute fällig");

// Erste richtige Antwort „Gut": Intervall 1 Tag.
const r1 = app.schedule(fresh, 4, NOW);
eq(r1.reps, 1, "schedule: erste gute Antwort reps=1");
eq(r1.interval, 1, "schedule: erste gute Antwort interval=1 Tag");

// Zweite richtige Antwort: Intervall 6 Tage.
const r2 = app.schedule({ reps: 1, ease: 2.5, interval: 1, due: NOW }, 4, NOW);
eq(r2.reps, 2, "schedule: zweite gute Antwort reps=2");
eq(r2.interval, 6, "schedule: zweite gute Antwort interval=6 Tage");

// Dritte Antwort: interval * ease (6 * ~2.6).
const r3 = app.schedule({ reps: 2, ease: 2.6, interval: 6, due: NOW }, 4, NOW);
ok(r3.interval > 6, "schedule: drittes Intervall wächst über 6 Tage");

// Ease sinkt bei „Schwer", steigt nie unter 1.3.
const hard = app.schedule({ reps: 3, ease: 1.35, interval: 10, due: NOW }, 3, NOW);
ok(hard.ease >= 1.3, "schedule: Ease fällt nie unter 1.3");
ok(hard.ease < 1.35, "schedule: „Schwer“ senkt die Ease");

// „Einfach" liefert ein längeres Intervall als „Gut".
const good = app.schedule({ reps: 2, ease: 2.5, interval: 6, due: NOW }, 4, NOW);
const easy = app.schedule({ reps: 2, ease: 2.5, interval: 6, due: NOW }, 5, NOW);
ok(easy.interval >= good.interval, "schedule: „Einfach“ >= „Gut“ beim Intervall");

// due liegt nach gutem Review in der Zukunft (nächster fälliger Tag).
ok(r1.due > NOW, "schedule: gutes Review schiebt due in die Zukunft");

/* ---- previewInterval ---- */
eq(app.previewInterval(fresh, 0, NOW), "<10 Min.", "previewInterval: Nochmal zeigt Minuten");
eq(app.previewInterval(fresh, 4, NOW), "1 Tag", "previewInterval: erste gute Antwort = 1 Tag");

/* ---- formatInterval ---- */
eq(app.formatInterval(0), "<1 Tag", "formatInterval 0");
eq(app.formatInterval(1), "1 Tag", "formatInterval 1");
eq(app.formatInterval(10), "10 Tage", "formatInterval 10");
eq(app.formatInterval(60), "2 Mon.", "formatInterval ~2 Monate");

/* ---- isNew / isDue ---- */
ok(app.isNew({ reps: 0, lastReviewed: 0 }), "isNew: frische Karte");
ok(!app.isNew({ reps: 1, lastReviewed: NOW }), "isNew: gelernte Karte ist nicht neu");
ok(app.isDue({ due: NOW - 1000 }, NOW), "isDue: vergangenes due ist fällig");
ok(!app.isDue({ due: NOW + DAY }, NOW), "isDue: zukünftiges due ist nicht fällig");

/* ---- migrate: Robustheit ---- */
const empty = app.migrate(null);
eq(empty.decks, [], "migrate(null): leere Decks");
eq(empty.cards, [], "migrate(null): leere Cards");
eq(empty.settings.sessionLimit, 40, "migrate(null): Default sessionLimit");

// Karte mit unbekanntem deckId wird auf null gesetzt (verwaist, nicht gelöscht).
const m1 = app.migrate({
  decks: [{ id: "d1", name: "Deck 1" }],
  cards: [
    { id: "x1", deckId: "d1", front: "F", back: "B" },
    { id: "x2", deckId: "GHOST", front: "F2", back: "B2" },
    { front: "", back: "" }, // leer → verworfen
  ],
});
eq(m1.decks.length, 1, "migrate: ein Deck übernommen");
eq(m1.cards.length, 2, "migrate: leere Karte verworfen, zwei bleiben");
eq(m1.cards[0].deckId, "d1", "migrate: gültige deckId bleibt");
eq(m1.cards[1].deckId, null, "migrate: unbekannte deckId → null (verwaist)");
ok(m1.cards[0].ease === 2.5 && m1.cards[0].reps === 0, "migrate: SM-2 Defaults gesetzt");

// Kaputte Settings werden geklemmt.
const m2 = app.migrate({ settings: { sessionLimit: 99999, newPerDay: -5 } });
eq(m2.settings.sessionLimit, 500, "migrate: sessionLimit geklemmt");
eq(m2.settings.newPerDay, 0, "migrate: newPerDay geklemmt");

/* ---- normalizeCard: source-Feld bleibt zukunftsoffen erhalten ---- */
const nc = app.normalizeCard(
  { front: "F", back: "B", deckId: "d1", source: { kind: "pdf", page: 3 } },
  { d1: true }
);
eq(nc.source, { kind: "pdf", page: 3 }, "normalizeCard: source-Feld bleibt erhalten (KI-Stufe später)");

/* ---- Ergebnis ---- */
console.log(`\nKarteikarten-Tests: ${passed} ok, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
