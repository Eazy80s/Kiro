/* ============================================================
   Automatisierte Tests der Rechenlogik (Punkt 14)
   Ausführen:  node tests/logic.test.js
   Kein Framework nötig — reines Node (>=18).

   Hinweis: Diese Funktionen spiegeln die Kernlogik aus app.js wider.
   app.js kapselt seine Logik in einem IIFE (für den Browser, ohne Build),
   daher werden die Algorithmen hier zu Testzwecken gespiegelt. Bei Änderungen
   an der Logik in app.js bitte hier mitziehen.
   ============================================================ */

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`✗ ${label}\n    erwartet: ${e}\n    erhalten: ${a}`); }
}

/* ---- gespiegelte Logik ---- */
function isoOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function taskCompletion(t) {
  if (t.subtasks && t.subtasks.length) return t.subtasks.filter((s) => s.done).length / t.subtasks.length;
  return t.done ? 1 : 0;
}
function moduleProgress(m) {
  if (m.completed) return 100;
  if (!m.tasks.length) return 0;
  const sum = m.tasks.reduce((a, t) => a + taskCompletion(t), 0);
  return Math.round((sum / m.tasks.length) * 100);
}
function overallProgress(modules) {
  if (!modules.length) return { pct: 0, weighted: false };
  const totalEcts = modules.reduce((a, m) => a + (m.ects || 0), 0);
  if (totalEcts > 0) {
    const doneEcts = modules.reduce((a, m) => a + (m.completed ? (m.ects || 0) : 0), 0);
    return { pct: Math.round((doneEcts / totalEcts) * 100), weighted: true };
  }
  const done = modules.filter((m) => m.completed).length;
  return { pct: Math.round((done / modules.length) * 100), weighted: false };
}
function computeGpa(modules) {
  const graded = modules.filter((m) => typeof m.grade === "number" && !isNaN(m.grade));
  if (!graded.length) return null;
  const totalEcts = graded.reduce((a, m) => a + (m.ects || 0), 0);
  if (totalEcts > 0) {
    const sum = graded.reduce((a, m) => a + m.grade * (m.ects || 0), 0);
    return { value: sum / totalEcts, weighted: true };
  }
  return { value: graded.reduce((a, m) => a + m.grade, 0) / graded.length, weighted: false };
}
function isPassingGrade(g) { return typeof g === "number" && g <= 4.0; }
function formatDuration(sec) {
  const tm = Math.round(sec / 60), h = Math.floor(tm / 60), m = tm % 60;
  return h > 0 ? `${h} Std. ${m} Min.` : `${m} Min.`;
}
function eventOccursOn(e, dateStr) {
  if (e.date === dateStr) return true;
  if (!e.repeat || dateStr < e.date) return false;
  const base = new Date(e.date + "T00:00:00"), d = new Date(dateStr + "T00:00:00");
  if (e.repeat === "daily") return true;
  if (e.repeat === "weekly") return base.getDay() === d.getDay();
  if (e.repeat === "monthly") return base.getDate() === d.getDate();
  return false;
}
function nextOccurrence(e, fromIso) {
  if (!e.repeat) return e.date >= fromIso ? e.date : null;
  if (e.date >= fromIso) return e.date;
  let d = new Date(fromIso + "T00:00:00");
  for (let i = 0; i < 740; i++) { const iso = isoOf(d); if (eventOccursOn(e, iso)) return iso; d.setDate(d.getDate() + 1); }
  return null;
}

/* ---- Tests ---- */
// Modulfortschritt (inkl. Teilaufgaben)
eq(moduleProgress({ completed: false, tasks: [{ done: false, subtasks: [{ done: true }, { done: true }, { done: false }, { done: false }] }, { done: true, subtasks: [] }] }), 75, "Modulfortschritt mit Teilaufgaben = 75%");
eq(moduleProgress({ completed: true, tasks: [] }), 100, "Abgeschlossenes Modul = 100%");
eq(moduleProgress({ completed: false, tasks: [] }), 0, "Modul ohne Aufgaben = 0%");

// Gesamtfortschritt (nur abgeschlossene Module, ECTS-gewichtet)
eq(overallProgress([{ ects: 6, completed: false, tasks: [{ done: true }] }, { ects: 9, completed: true, tasks: [] }, { ects: 3, completed: false, tasks: [] }]), { pct: 50, weighted: true }, "Gesamtfortschritt ECTS-gewichtet = 50%");
eq(overallProgress([{ ects: 0, completed: true, tasks: [] }, { ects: 0, completed: false, tasks: [] }, { ects: 0, completed: false, tasks: [] }]), { pct: 33, weighted: false }, "Gesamtfortschritt nach Anzahl = 33%");
eq(overallProgress([]), { pct: 0, weighted: false }, "Gesamtfortschritt ohne Module = 0%");

// GPA (ECTS-gewichtet)
eq(Number(computeGpa([{ grade: 2.0, ects: 6 }, { grade: 1.3, ects: 9 }, { grade: null, ects: 3 }]).value.toFixed(2)), 1.58, "GPA ECTS-gewichtet = 1,58");
eq(computeGpa([{ grade: null }]), null, "GPA ohne Noten = null");

// Notenskala
eq([isPassingGrade(1.0), isPassingGrade(4.0), isPassingGrade(4.1), isPassingGrade(5.0)], [true, true, false, false], "Bestehensgrenze 4,0");

// Dauer (deutsches Format)
eq([formatDuration(3725), formatDuration(1500), formatDuration(0), formatDuration(59)], ["1 Std. 2 Min.", "25 Min.", "0 Min.", "1 Min."], "Dauer-Formatierung deutsch");

// Wiederholungen
eq(eventOccursOn({ date: "2026-11-09", repeat: "weekly" }, "2026-11-16"), true, "Wöchentlich: nächster Montag");
eq(eventOccursOn({ date: "2026-11-09", repeat: "weekly" }, "2026-11-17"), false, "Wöchentlich: Dienstag nein");
eq(eventOccursOn({ date: "2026-11-12", repeat: "monthly" }, "2026-12-12"), true, "Monatlich: gleicher Tag");
eq(eventOccursOn({ date: "2026-11-10", repeat: "daily" }, "2026-11-30"), true, "Täglich: jeder Folgetag");
eq(eventOccursOn({ date: "2026-11-09", repeat: "weekly" }, "2026-11-02"), false, "Vor Startdatum: nein");
eq(nextOccurrence({ date: "2026-11-09", repeat: "weekly" }, "2026-11-12"), "2026-11-16", "nextOccurrence wöchentlich");
eq(nextOccurrence({ date: "2026-01-01", repeat: null }, "2026-11-12"), null, "nextOccurrence einmalig vergangen = null");

/* ---- Ergebnis ---- */
console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen.`);
process.exit(failed ? 1 : 0);
