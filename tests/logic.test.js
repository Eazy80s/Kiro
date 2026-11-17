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
  if (e.repeatUntil && dateStr > e.repeatUntil) return false;
  const base = new Date(e.date + "T00:00:00"), d = new Date(dateStr + "T00:00:00");
  if (e.repeat === "daily") return true;
  if (e.repeat === "weekly") return base.getDay() === d.getDay();
  if (e.repeat === "biweekly") {
    if (base.getDay() !== d.getDay()) return false;
    const weeks = Math.round((d - base) / (7 * 86400000));
    return weeks % 2 === 0;
  }
  if (e.repeat === "monthly") return base.getDate() === d.getDate();
  return false;
}
function daysBetween(aIso, bIso) {
  return Math.round((new Date(bIso + "T00:00:00") - new Date(aIso + "T00:00:00")) / 86400000);
}
function dueStatus(dateStr, todayStr) {
  const diff = daysBetween(todayStr, dateStr);
  if (diff < 0) return "overdue";
  if (diff === 0) return "due-today";
  if (diff <= 3) return "due-soon";
  return "due-later";
}
// Prognose (ECTS-gewichtet)
function gradeForecast(modules, targetAvg) {
  const graded = modules.filter((m) => typeof m.grade === "number" && (m.ects || 0) > 0);
  const remaining = modules.filter((m) => typeof m.grade !== "number" && (m.ects || 0) > 0);
  const remainingEcts = remaining.reduce((a, m) => a + m.ects, 0);
  if (remainingEcts === 0) return { done: true };
  const totalEcts = graded.reduce((a, m) => a + m.ects, 0) + remainingEcts;
  const gradedSum = graded.reduce((a, m) => a + m.grade * m.ects, 0);
  return { needed: (targetAvg * totalEcts - gradedSum) / remainingEcts, remainingEcts };
}
function icsEscape(s) { return String(s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n"); }
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

// Erweiterte Wiederholungen (Punkt 8)
eq(eventOccursOn({ date: "2026-11-09", repeat: "biweekly" }, "2026-11-23"), true, "Alle-2-Wochen: +14 Tage");
eq(eventOccursOn({ date: "2026-11-09", repeat: "biweekly" }, "2026-11-16"), false, "Alle-2-Wochen: +7 Tage nein");
eq(eventOccursOn({ date: "2026-11-09", repeat: "weekly", repeatUntil: "2026-11-20" }, "2026-11-23"), false, "Serie endet (nach repeatUntil)");
eq(eventOccursOn({ date: "2026-11-09", repeat: "weekly", repeatUntil: "2026-11-30" }, "2026-11-16"), true, "Serie läuft noch (vor repeatUntil)");

// Fälligkeits-Status (Punkt 5)
eq([dueStatus("2026-11-10","2026-11-12"), dueStatus("2026-11-12","2026-11-12"), dueStatus("2026-11-14","2026-11-12"), dueStatus("2026-11-20","2026-11-12")],
   ["overdue","due-today","due-soon","due-later"], "Fälligkeits-Status");

// Notenschnitt-Prognose (Punkt 7): benötigte Note in Restmodulen
// benotet: 2.0@6 ; offen: 6 ECTS ; Ziel 2.0 → needed = (2.0*12 - 12)/6 = 2.0
eq(Number(gradeForecast([{grade:2.0,ects:6},{grade:null,ects:6}], 2.0).needed.toFixed(2)), 2.0, "Prognose: benötigte Note = 2,0");
eq(gradeForecast([{grade:2.0,ects:6}], 2.0).done, true, "Prognose: nichts offen → done");

// ICS-Escaping (Punkt 3)
eq(icsEscape("A, B; C"), "A\\, B\\; C", "ICS-Escaping von Komma/Semikolon");

/* ---- Teilnoten → Endnote (Punkt 4) ---- */
function computeComponentGrade(m) {
  if (!m.gradeComponents || !m.gradeComponents.length) return null;
  const valid = m.gradeComponents.filter((c) => typeof c.grade === "number" && (c.weight || 0) > 0);
  if (!valid.length) return null;
  const wsum = valid.reduce((a, c) => a + c.weight, 0);
  if (wsum <= 0) return null;
  return valid.reduce((a, c) => a + c.grade * c.weight, 0) / wsum;
}
// Klausur 1,0 (70%) + Übung 3,0 (30%) = 0,7 + 0,9 = 1,6
eq(Number(computeComponentGrade({ gradeComponents: [{ grade: 1.0, weight: 70 }, { grade: 3.0, weight: 30 }] }).toFixed(2)), 1.6, "Teilnoten gewichtet = 1,6");
eq(computeComponentGrade({ gradeComponents: [{ grade: null, weight: 50 }] }), null, "Teilnoten ohne Note = null");
// ungleiche Gewichtssumme (anteilig): 2,0(50) + 4,0(50) = 3,0
eq(Number(computeComponentGrade({ gradeComponents: [{ grade: 2.0, weight: 50 }, { grade: 4.0, weight: 50 }] }).toFixed(2)), 3.0, "Teilnoten 50/50 = 3,0");

/* ---- Bester/schlechtester Endschnitt (Punkt 5) ---- */
function gradeRange(modules) {
  const w = modules.filter((m) => (m.ects || 0) > 0);
  const total = w.reduce((a, m) => a + m.ects, 0);
  if (!total) return null;
  const gradedSum = w.reduce((a, m) => a + (typeof m.grade === "number" ? m.grade * m.ects : 0), 0);
  const open = w.filter((m) => typeof m.grade !== "number").reduce((a, m) => a + m.ects, 0);
  return { best: (gradedSum + 1.0 * open) / total, worst: (gradedSum + 4.0 * open) / total };
}
// benotet 2,0@6 ; offen 6 → best (12+6)/12=1,5 ; worst (12+24)/12=3,0
{ const r = gradeRange([{ grade: 2.0, ects: 6 }, { grade: null, ects: 6 }]);
  eq([Number(r.best.toFixed(2)), Number(r.worst.toFixed(2))], [1.5, 3.0], "Endschnitt-Bereich best/worst"); }

/* ---- Lern-Serie / Streak (Punkt 7) ---- */
function studyStreak(daily, todayStr) {
  const iso = (d) => d.toISOString().slice(0, 10);
  let streak = 0; const d = new Date(todayStr + "T00:00:00");
  if (!(daily[iso(d)] > 0)) d.setDate(d.getDate() - 1);
  for (let i = 0; i < 1000; i++) { if (daily[iso(d)] > 0) { streak++; d.setDate(d.getDate() - 1); } else break; }
  return streak;
}
eq(studyStreak({ "2026-11-17": 60, "2026-11-16": 60, "2026-11-15": 60 }, "2026-11-17"), 3, "Streak = 3 Tage");
eq(studyStreak({ "2026-11-16": 60, "2026-11-15": 60 }, "2026-11-17"), 2, "Streak zählt ab gestern, wenn heute leer");
eq(studyStreak({ "2026-11-17": 60, "2026-11-15": 60 }, "2026-11-17"), 1, "Streak bricht bei Lücke ab");

/* ---- Erweiterte Wiederholung: biweekly mit repeatUntil ---- */
eq(eventOccursOn({ date: "2026-11-02", repeat: "biweekly", repeatUntil: "2026-12-01" }, "2026-11-30"), true, "biweekly innerhalb Serie");
eq(eventOccursOn({ date: "2026-11-02", repeat: "biweekly", repeatUntil: "2026-11-20" }, "2026-11-30"), false, "biweekly nach repeatUntil endet");

/* ---- Wochen-Agenda: Sortierung nach Datum+Zeit (Punkt 7) ---- */
{
  const items = [
    { iso: "2026-11-18", time: "14:00", text: "B" },
    { iso: "2026-11-18", time: null, text: "C" },
    { iso: "2026-11-17", time: "09:00", text: "A" },
  ];
  const order = items.slice().sort((a, b) => (a.iso + (a.time || "99:99")).localeCompare(b.iso + (b.time || "99:99"))).map((x) => x.text);
  eq(order, ["A", "B", "C"], "Agenda-Sortierung Datum+Zeit (ganztägig zuletzt am Tag)");
}

/* ---- Tagesziel erreicht: Auslöse-Schwelle (Punkt 9) ---- */
{
  const goalSec = 2 * 3600; // 2 Std.
  const crosses = (before, add) => before < goalSec && (before + add) >= goalSec;
  // (a) 1h→2h erreicht Ziel, (b) schon drüber bleibt drüber, (c) 1h50→1h55 noch drunter
  eq([crosses(3600, 3600), crosses(7200, 60), crosses(6600, 300)], [true, false, false], "Tagesziel-Schwelle nur beim Überschreiten");
}

/* ---- Drag & Drop: Datumsverschiebung (Kalender) ---- */
// Einmaliger Eintrag: neues Datum = Zieltag.
{
  const e = { date: "2026-11-10", repeat: null };
  const toDate = "2026-11-18";
  const newDate = e.repeat ? null : toDate;
  eq(newDate, "2026-11-18", "Einzeltermin: Verschiebung setzt Zieldatum");
}
// Wiederkehrende Serie: Verschiebung um die Differenz (toDate − fromDate) ggü. Startdatum.
{
  const e = { date: "2026-11-02", repeat: "weekly", repeatUntil: "2026-12-14" };
  const fromDate = "2026-11-16"; // ein Vorkommen
  const toDate = "2026-11-18";   // 2 Tage später abgelegt
  const delta = daysBetween(e.date, toDate) - daysBetween(e.date, fromDate); // = 2
  const base = new Date(e.date + "T00:00:00"); base.setDate(base.getDate() + delta);
  const ru = new Date(e.repeatUntil + "T00:00:00"); ru.setDate(ru.getDate() + delta);
  eq([isoOf(base), isoOf(ru), delta], ["2026-11-04", "2026-12-16", 2], "Serie: Start + Enddatum um Delta verschoben");
}

/* ---- Ergebnis ---- */
console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen.`);
process.exit(failed ? 1 : 0);
