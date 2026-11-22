/* ============================================================
   Studien-Tracker — Daten im localStorage
   Datenmodell (v7):
     module:   { id, name, ects, grade, targetGrade, semester, completed, pinned,
                 collapsed, gradeComponents:[comp], links:[link], tasks:[task] }
     comp:     { id, label, grade, weight }        // Teilnote (gewichtet)
     link:     { id, label, url }                  // url immer http(s) (sanitizeUrl)
     task:     { id, text, done, date, startTime, endTime, url, subtasks:[subtask] }
                 // startTime/endTime: "HH:MM" oder null; url: http(s) oder ""
     subtask:  { id, text, done }
     event:    { id, date, startTime, endTime, title, type, repeat, repeatUntil, color }
                 // type: "exam" | "deadline" | "other"; color: null oder Hex (sanitizeHexColor)
   Separate Keys: Pomodoro-Zeiten, Lernstatistik (inkl. Ziele & Lernzeit je Modul), Theme.

   Sicherheit: Nutzerdaten werden beim Rendern mit escapeHtml maskiert; die
   per innerHTML eingesetzten Sonderfälle (Farbe, Link-URL) werden zusätzlich
   zentral in migrate() gehärtet, damit auch Import/Sync die Zusicherungen erfüllen.

   Aufbau dieser Datei (in einem IIFE gekapselt, kein globaler Namensraum):
     1) Persistenz & Migration      2) Fortschritt/Noten-Helfer
     3) Datums-/Wiederhol-Helfer    4) Navigation & Theme
     5) Dashboard                   6) Kalender
     7) Module & Checklisten        8) Daten (Export/Import/Reset)
     9) Pomodoro & Lernzeit        10) Snackbar & Utilities & Boot
   ============================================================ */
(function () {
"use strict";

const STORAGE_KEY = "study-tracker-v1";

// Current data schema version. Bump when the shape changes so migrations stay explicit.
const SCHEMA_VERSION = 9;

let state = loadState();

/* ---------- Eingabe-Härtung (Sicherheit) ----------
   Diese Helfer stellen sicher, dass potenziell gefährliche Felder (Farbe, URL)
   unabhängig vom Eingangsweg sauber sind — also auch nach JSON-Import und
   Geräte-Sync, nicht nur beim Tippen im Editor. */

// Nur echte #rrggbb/#rgb-Hex-Farben zulassen; sonst null (→ Typ-Standardfarbe).
// Verhindert Ausbruch aus inline-style-Attributen (z. B. aus importierten Daten).
function sanitizeHexColor(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : null;
}

// Nur gültige "HH:MM" (24h) durchlassen, sonst null. Robust gegen Import/Sync.
function normalizeTime(raw) {
  if (typeof raw !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return String(h).padStart(2, "0") + ":" + m[2];
}

/* ---------- Persistence & migration ---------- */
function loadState() {
  let data = { modules: [], events: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) data = JSON.parse(raw);
  } catch (e) {
    console.warn("Could not load saved data:", e);
  }
  return migrate(data);
}

// Bring older saved records up to the current shape so nothing breaks.
//
// Strategie: Die Defaults unten sind idempotent und rein additiv — sie füllen
// nur fehlende Felder und härten gefährliche Werte (Farbe/URL). Das deckt jeden
// bisherigen Schemastand (bis v7) ab, ohne pro Version eigene Zweige zu brauchen.
// WICHTIG: Sobald eine Änderung NICHT mehr additiv ist (Feld umbenennen/entfernen,
// Werte umrechnen), gehört die Umwandlung in den versionierten Block unten —
// VOR den Default-Füller —, sonst gehen Daten still verloren.
function migrate(data) {
  if (!data || typeof data !== "object") data = {};
  if (!Array.isArray(data.modules)) data.modules = [];
  if (!Array.isArray(data.events)) data.events = [];
  // Studienziel in ECTS (z. B. 180). 0/leer = kein Ziel gesetzt.
  data.ectsTarget = Number(data.ectsTarget) > 0 ? Number(data.ectsTarget) : 0;
  // Dashboard-Spalten: 1 (Standard, ruhig) oder 2 (kompakt, nebeneinander).
  data.dashCols = (Number(data.dashCols) === 2) ? 2 : 1;
  // Fokus-Radio: Stream-URL (http(s), gehärtet) oder "". Lautstärke 0..1.
  if (!data.radio || typeof data.radio !== "object") data.radio = {};
  data.radio = {
    url: sanitizeUrl(data.radio.url) || "",
    label: String(data.radio.label || "").slice(0, 80),
    volume: (typeof data.radio.volume === "number" && data.radio.volume >= 0 && data.radio.volume <= 1) ? data.radio.volume : 0.6,
  };
  // Einstellungen des Wochen-Stundenrasters: Fenster (Start/Ende-Stunde) und
  // Standard-Dauer neuer/zeitlich gesetzter Blöcke in Minuten.
  if (!data.weekGrid || typeof data.weekGrid !== "object") data.weekGrid = {};
  {
    let s = Math.round(Number(data.weekGrid.startHour));
    let e = Math.round(Number(data.weekGrid.endHour));
    let dur = Math.round(Number(data.weekGrid.defaultDurationMin));
    if (!(s >= 0 && s <= 23)) s = 8;
    if (!(e >= 1 && e <= 24)) e = 21;
    if (e <= s) { s = 8; e = 21; }           // ungültiges Fenster → Standard
    if (!(dur >= 15 && dur <= 480)) dur = 60; // 15 min … 8 h, sonst 60
    data.weekGrid = { startHour: s, endHour: e, defaultDurationMin: dur };
  }

  // --- Versionierte, nicht-additive Umwandlungen (von alt nach neu) ---
  const from = Number(data.schemaVersion) || 0;
  // Beispiel für die Zukunft:
  //   if (from < 8) { data.modules.forEach((m) => { m.neuerName = m.alterName; delete m.alterName; }); }
  void from; // aktuell keine nicht-additiven Schritte nötig
  // Events: Von–Bis-Uhrzeit (startTime/endTime, je "HH:MM" oder null) + Wiederholung.
  data.events.forEach((e) => {
    // Migration altes Einzelfeld `time` → startTime; endTime bleibt zunächst leer.
    if (e.startTime === undefined) e.startTime = normalizeTime(e.time) || null;
    if (e.endTime === undefined) e.endTime = null;
    delete e.time;
    e.startTime = normalizeTime(e.startTime);
    e.endTime = normalizeTime(e.endTime);
    // Event-Typ „lecture" (alter Vorlesungs-Termin) entfällt → als „other" führen.
    // Erlaubte Typen jetzt nur noch: exam | deadline | other.
    if (e.type === "lecture") e.type = "other";
    if (e.type !== "exam" && e.type !== "deadline" && e.type !== "other") e.type = "other";
    // repeat: null | "daily" | "weekly" | "biweekly" | "monthly" (ab e.date vorwärts)
    if (e.repeat === undefined) e.repeat = null;
    // optionales Enddatum einer Serie ("YYYY-MM-DD" oder null)
    if (e.repeatUntil === undefined) e.repeatUntil = null;
    // optionale eigene Farbe (Hex) — überschreibt die Typ-Standardfarbe.
    // Immer härten: nur echte Hex-Farben überleben (schützt vor style-Injection
    // aus importierten/gesyncten Daten, die später per innerHTML gerendert werden).
    e.color = sanitizeHexColor(e.color);
  });
  data.modules.forEach((m) => {
    if (typeof m.ects !== "number") m.ects = Number(m.ects) || 0;
    if (m.grade === undefined) m.grade = null;
    if (m.targetGrade === undefined) m.targetGrade = null; // Wunschnote
    if (m.semester === undefined) m.semester = null;       // z. B. "WS 2026/27"
    // Teilnoten (Punkt 4): [{ id, label, grade, weight }]. Endnote = gewichteter Schnitt.
    if (!Array.isArray(m.gradeComponents)) m.gradeComponents = [];
    // Weblinks zur Hochschul-Plattform: [{ id, label, url }]. URLs immer
    // re-validieren (nur http(s)), damit die Zusicherung auch für Import/Sync gilt.
    if (!Array.isArray(m.links)) m.links = [];
    m.links.forEach((l) => { if (l) l.url = sanitizeUrl(l.url) || ""; });
    if (typeof m.completed !== "boolean") m.completed = false;
    if (typeof m.pinned !== "boolean") m.pinned = false;
    if (typeof m.collapsed !== "boolean") m.collapsed = false;
    if (!Array.isArray(m.tasks)) m.tasks = [];
    m.tasks.forEach((t) => {
      if (typeof t.done !== "boolean") t.done = false;
      // Scheduled date (YYYY-MM-DD) or null. Drives Calendar + Today's Focus.
      if (t.date === undefined) t.date = null;
      // Optionale Von–Bis-Uhrzeit (für den Stundenraster der Wochenansicht).
      t.startTime = normalizeTime(t.startTime);
      t.endTime = normalizeTime(t.endTime);
      // Optionaler eigener Link (z. B. zur Plattform-Aufzeichnung). Immer
      // härten: nur http(s) (schützt Import/Sync), sonst leer.
      t.url = sanitizeUrl(t.url) || "";
      // Entfernte Felder aufräumen (v9): kind (Vorlesungs-Typ) und pinned (ungenutzt).
      delete t.kind;
      delete t.pinned;
      if (!Array.isArray(t.subtasks)) t.subtasks = [];
      t.subtasks.forEach((s) => { if (typeof s.done !== "boolean") s.done = false; });
    });
  });
  data.schemaVersion = SCHEMA_VERSION;
  return data;
}

function saveState() {
  // Zeitstempel für "zuletzt gespeichert gewinnt" beim Geräte-Sync.
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // z. B. Speicher voll (QuotaExceededError) — Nutzer informieren statt still scheitern.
    if (typeof showSnackbar === "function") showSnackbar("Speichern fehlgeschlagen (Browserspeicher voll?).");
    console.warn("saveState fehlgeschlagen:", e);
  }
  if (typeof scheduleSyncUpload === "function") scheduleSyncUpload();
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Zentrale Factory für eine Checklisten-Aufgabe. EINZIGE Stelle, die das
// Task-Objekt aufbaut — so können die verschiedenen Eingabepfade (Modulkarte,
// Schnelleingabe „Fokus heute", Kalender-„Hinzufügen") nicht auseinanderlaufen
// (z. B. ein Feld vergessen). Felder werden gehärtet wie in migrate().
function makeTask(fields) {
  const f = fields || {};
  return {
    id: uid(),
    text: String(f.text || "").trim(),
    done: false,
    date: f.date || null,
    startTime: normalizeTime(f.startTime),
    endTime: normalizeTime(f.endTime),
    url: sanitizeUrl(f.url) || "",
    subtasks: [],
  };
}

/* ---------- Progress helpers ---------- */
// A task with subtasks contributes fractionally (share of its subtasks done);
// a task without subtasks contributes 1 when done, 0 otherwise. The module
// percentage is the average completion across all its tasks.
function taskCompletion(t) {
  if (t.subtasks && t.subtasks.length) {
    const done = t.subtasks.filter((s) => s.done).length;
    return done / t.subtasks.length;
  }
  return t.done ? 1 : 0;
}

function moduleProgress(module) {
  if (module.completed) return 100;
  if (!module.tasks.length) return 0;
  const sum = module.tasks.reduce((a, t) => a + taskCompletion(t), 0);
  return Math.round((sum / module.tasks.length) * 100);
}

// Overall study progress is driven ONLY by completed modules — checklist tasks
// do not affect it. A module counts as 100% when marked completed, else 0%.
// ECTS-weighted when any credits are set, otherwise a plain count of modules.
function overallProgress() {
  const all = state.modules;
  if (!all.length) return { pct: 0, weighted: false };

  const totalEcts = all.reduce((a, m) => a + (m.ects || 0), 0);
  if (totalEcts > 0) {
    const doneEcts = all.reduce((a, m) => a + (m.completed ? (m.ects || 0) : 0), 0);
    return { pct: Math.round((doneEcts / totalEcts) * 100), weighted: true };
  }
  const done = all.filter((m) => m.completed).length;
  return { pct: Math.round((done / all.length) * 100), weighted: false };
}

// Fortschritt gegenüber einem ECTS-Studienziel. ECTS gelten als erreicht, wenn
// das Modul abgeschlossen ist. Reine Funktion → testbar. target<=0 ⇒ kein Ziel.
function ectsProgress(modules, target) {
  const goal = Number(target) || 0;
  const earned = modules.reduce((a, m) => a + (m.completed ? (m.ects || 0) : 0), 0);
  if (goal <= 0) return { active: false, earned, goal: 0, pct: 0, remaining: 0 };
  const pct = Math.min(100, Math.round((earned / goal) * 100));
  return { active: true, earned, goal, pct, remaining: Math.max(0, goal - earned) };
}

// GPA = ECTS-weighted average of recorded grades (ignores modules with no grade).
function computeGpa() {
  const graded = state.modules.filter((m) => typeof m.grade === "number" && !isNaN(m.grade));
  if (!graded.length) return null;
  const totalEcts = graded.reduce((a, m) => a + (m.ects || 0), 0);
  if (totalEcts > 0) {
    const sum = graded.reduce((a, m) => a + m.grade * (m.ects || 0), 0);
    return { value: sum / totalEcts, count: graded.length, weighted: true };
  }
  const sum = graded.reduce((a, m) => a + m.grade, 0);
  return { value: sum / graded.length, count: graded.length, weighted: false };
}

// Noten je Semester: liefert pro Semester den ECTS-gewichteten Schnitt der
// benoteten Module, chronologisch sortiert (SS vor WS, Jahr aufsteigend).
// Reine Funktion (nimmt die Module als Argument) → gut testbar.
// Rückgabe: [{ semester, avg, count, ects }], Module ohne Semester als "Ohne Semester".
function gradesBySemester(modules) {
  const groups = new Map();
  modules.forEach((m) => {
    if (typeof m.grade !== "number" || isNaN(m.grade)) return;
    const key = m.semester || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });
  const out = [];
  groups.forEach((mods, key) => {
    const totalEcts = mods.reduce((a, m) => a + (m.ects || 0), 0);
    let avg;
    if (totalEcts > 0) avg = mods.reduce((a, m) => a + m.grade * (m.ects || 0), 0) / totalEcts;
    else avg = mods.reduce((a, m) => a + m.grade, 0) / mods.length;
    out.push({ semester: key || "Ohne Semester", semKey: key, avg, count: mods.length, ects: totalEcts });
  });
  out.sort((a, b) => semesterSortKey(a.semKey) - semesterSortKey(b.semKey));
  return out;
}

/* ---------- Date helpers ----------
   Use LOCAL date components (not toISOString(), which is UTC) so day math
   never drifts by a day in timezones behind/ahead of UTC. */
function isoOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayIso() { return isoOf(new Date()); }
function formatDate(iso) { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; }
// Normalize a stored time to "HH:MM" or empty string.
function formatTime(t) { return t ? t : ""; }
// Sortier-/Positions-Key eines Postens: Startzeit oder "99:99" (ohne Zeit → ans Ende).
function timeKey(item) { return item && item.startTime ? item.startTime : "99:99"; }
// Anzeige der Von–Bis-Zeit: "09:00–10:30", "09:00" oder "" (keine Zeit).
function timeRange(startTime, endTime) {
  if (!startTime) return "";
  return endTime ? `${startTime}–${endTime}` : startTime;
}

// Whole-day difference between two YYYY-MM-DD strings (b - a), date-only.
function daysBetween(aIso, bIso) {
  const a = new Date(aIso + "T00:00:00");
  const b = new Date(bIso + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

// All module tasks scheduled on a given date, as { module, task } pairs.
// Includes recurring calendar events expanded onto `dateStr` is handled elsewhere;
// this only covers module tasks.
function tasksOnDate(dateStr) {
  const out = [];
  state.modules.forEach((m) => {
    m.tasks.forEach((t) => { if (t.date === dateStr) out.push({ module: m, task: t }); });
  });
  return out;
}

/* ---------- Feiertage (bundesweit, Deutschland) ----------
   Reine Berechnung, keine Daten-Datei. Bewegliche Feiertage über die
   Gauß'sche Osterformel. Nur die bundeseinheitlichen gesetzlichen Feiertage
   (regionale wie Fronleichnam/Reformationstag bewusst ausgelassen, da je
   Bundesland verschieden). Rückgabe für ein Jahr: { "YYYY-MM-DD": "Name" }. */
function easterSunday(year) {
  // Anonyme Gauß-Osterformel (gregorianisch).
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mm + 114) / 31);     // 3=März, 4=April
  const day = ((h + l - 7 * mm + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}
const _holidayCache = {};
function germanHolidays(year) {
  if (_holidayCache[year]) return _holidayCache[year];
  const iso = (d) => isoOf(d);
  const addDays = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
  const easter = easterSunday(year);
  const h = {};
  h[`${year}-01-01`] = "Neujahr";
  h[`${year}-05-01`] = "Tag der Arbeit";
  h[`${year}-10-03`] = "Tag der Deutschen Einheit";
  h[`${year}-12-25`] = "1. Weihnachtstag";
  h[`${year}-12-26`] = "2. Weihnachtstag";
  h[iso(addDays(easter, -2))] = "Karfreitag";
  h[iso(addDays(easter, 1))] = "Ostermontag";
  h[iso(addDays(easter, 39))] = "Christi Himmelfahrt";
  h[iso(addDays(easter, 50))] = "Pfingstmontag";
  _holidayCache[year] = h;
  return h;
}
// Name des Feiertags an einem Datum (oder null).
function holidayName(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  if (!year) return null;
  return germanHolidays(year)[dateStr] || null;
}

/* ---------- Recurrence ---------- */
// Does a (possibly recurring) event fall on dateStr? Base date is the first
// occurrence; weekly repeats on the same weekday, monthly on the same day-of-month.
function eventOccursOn(e, dateStr) {
  if (e.date === dateStr) return true;
  if (!e.repeat || dateStr < e.date) return false;
  if (e.repeatUntil && dateStr > e.repeatUntil) return false; // Serie endet
  const base = new Date(e.date + "T00:00:00");
  const d = new Date(dateStr + "T00:00:00");
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

// All calendar events occurring on a date (expands recurring ones).
function eventsOnDate(dateStr) {
  return state.events.filter((e) => eventOccursOn(e, dateStr));
}

// Next occurrence date (YYYY-MM-DD) of an event on/after `fromIso`.
function nextOccurrence(e, fromIso) {
  if (!e.repeat) return e.date >= fromIso ? e.date : null;
  if (e.date >= fromIso) return e.date;
  // Walk forward up to ~2 years to find the next matching day.
  let d = new Date(fromIso + "T00:00:00");
  for (let i = 0; i < 740; i++) {
    const iso = isoOf(d);
    if (eventOccursOn(e, iso)) return iso;
    d.setDate(d.getDate() + 1);
  }
  return null;
}

/* ---------- German grade helpers (scale 1.0–5.0; passed if ≤ 4.0) ---------- */
function isPassingGrade(g) { return typeof g === "number" && g <= 4.0; }
function gradeLabel(g) {
  if (typeof g !== "number") return "—";
  return `${g.toFixed(1).replace(".", ",")} (${isPassingGrade(g) ? "bestanden" : "nicht bestanden"})`;
}
function commaNum(n, digits) { return Number(n).toFixed(digits == null ? 1 : digits).replace(".", ","); }

/* ---------- Teilnoten → Endnote (Punkt 4) ----------
   Hat ein Modul Teilnoten mit Gewichten, ist die Endnote der gewichtete
   Schnitt der benoteten Komponenten. m.grade wird daraus abgeleitet. */
function computeComponentGrade(m) {
  if (!m.gradeComponents || !m.gradeComponents.length) return null;
  const valid = m.gradeComponents.filter((c) => typeof c.grade === "number" && (c.weight || 0) > 0);
  if (!valid.length) return null;
  const wsum = valid.reduce((a, c) => a + c.weight, 0);
  if (wsum <= 0) return null;
  return valid.reduce((a, c) => a + c.grade * c.weight, 0) / wsum;
}
// Endnote aus Teilnoten in m.grade spiegeln (auf 1 Nachkommastelle gerundet).
function syncComponentGrade(m) {
  if (m.gradeComponents && m.gradeComponents.length) {
    const g = computeComponentGrade(m);
    m.grade = g == null ? null : Math.round(g * 10) / 10;
  }
}

/* ---------- Notenschnitt-Prognose (Punkt 7) ----------
   Welchen Durchschnitt brauche ich in den noch unbenoteten (ECTS-tragenden)
   Modulen, um ein Gesamtziel zu erreichen? ECTS-gewichtet, Skala 1,0–5,0. */
function gradeForecast(targetAvg) {
  const graded = state.modules.filter((m) => typeof m.grade === "number" && (m.ects || 0) > 0);
  const remaining = state.modules.filter((m) => typeof m.grade !== "number" && (m.ects || 0) > 0);
  const gradedEcts = graded.reduce((a, m) => a + m.ects, 0);
  const remainingEcts = remaining.reduce((a, m) => a + m.ects, 0);
  if (remainingEcts === 0) return { impossible: false, done: true, remainingEcts, needed: null };
  const totalEcts = gradedEcts + remainingEcts;
  const gradedSum = graded.reduce((a, m) => a + m.grade * m.ects, 0);
  // targetAvg*total = gradedSum + needed*remainingEcts
  const needed = (targetAvg * totalEcts - gradedSum) / remainingEcts;
  return {
    done: false,
    remainingEcts,
    gradedEcts,
    needed,
    // Note muss zwischen 1,0 und 5,0 liegen; >4,0 wäre nicht bestanden
    impossible: needed < 1.0,
    tooEasy: needed > 5.0,
  };
}

// Bester/schlechtester möglicher ECTS-gewichteter Endschnitt (Punkt 5).
// Unbenotete ECTS-Module werden mit 1,0 (best) bzw. 4,0 (worst, noch bestanden) angesetzt.
function gradeRange() {
  const withEcts = state.modules.filter((m) => (m.ects || 0) > 0);
  const totalEcts = withEcts.reduce((a, m) => a + m.ects, 0);
  if (totalEcts === 0) return null;
  const gradedSum = withEcts.reduce((a, m) => a + (typeof m.grade === "number" ? m.grade * m.ects : 0), 0);
  const openEcts = withEcts.filter((m) => typeof m.grade !== "number").reduce((a, m) => a + m.ects, 0);
  const best = (gradedSum + 1.0 * openEcts) / totalEcts;
  const worst = (gradedSum + 4.0 * openEcts) / totalEcts;
  const current = (() => { const g = computeGpa(); return g ? g.value : null; })();
  return { best, worst, current, openEcts };
}

/* ---------- Fälligkeits-Status einer Aufgabe (Punkt 5) ---------- */
// Gibt { cls, label } zurück, basierend auf t.date relativ zu heute.
function dueStatus(dateStr) {
  return dueStatusAt(dateStr, todayIso());
}
// Nächste anstehende (offene, terminierte) Aufgabe eines Moduls ab heute.
// Rückgabe: { date, status } oder null. Reine Funktion → testbar.
function nextModuleDue(module, todayStr) {
  const open = (module.tasks || [])
    .filter((t) => !t.done && t.date && t.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!open.length) return null;
  return { date: open[0].date, status: dueStatusAt(open[0].date, todayStr) };
}
// Wie dueStatus, aber mit explizitem „heute" (testbar, ohne globale Zeit).
function dueStatusAt(dateStr, todayStr) {
  if (!dateStr) return null;
  const diff = daysBetween(todayStr, dateStr);
  if (diff < 0) return { cls: "overdue", label: `überfällig (${Math.abs(diff)} ${Math.abs(diff) === 1 ? "Tag" : "Tage"})` };
  if (diff === 0) return { cls: "due-today", label: "heute fällig" };
  if (diff <= 3) return { cls: "due-soon", label: diff === 1 ? "morgen fällig" : `in ${diff} Tagen` };
  return { cls: "due-later", label: `in ${diff} Tagen` };
}

// Alle offenen, terminierten Aufgaben mit Fälligkeitsinfo (für Dashboard-Sektion).
function tasksByDue() {
  const out = [];
  state.modules.forEach((m) => {
    m.tasks.forEach((t) => {
      if (t.date && !t.done) out.push({ module: m, task: t, status: dueStatus(t.date) });
    });
  });
  return out.sort((a, b) => a.task.date.localeCompare(b.task.date));
}

/* ---------- ICS-Export des Kalenders (Punkt 3) ---------- */
function icsEscape(s) { return String(s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n"); }
function icsDate(iso, time) {
  const d = iso.replace(/-/g, "");
  if (time) return `${d}T${time.replace(":", "")}00`;
  return d; // ganztägig (VALUE=DATE)
}
const ICS_FREQ = { daily: "DAILY", weekly: "WEEKLY", biweekly: "WEEKLY", monthly: "MONTHLY" };
function buildIcs() {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Studien-Tracker//DE", "CALSCALE:GREGORIAN",
  ];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  // 1) Kalendereinträge (inkl. Wiederholung als RRULE)
  // Schreibt DTSTART/DTEND passend zur Von–Bis-Zeit (oder ganztägig).
  const pushWhen = (date, startTime, endTime) => {
    if (startTime) {
      lines.push(`DTSTART:${icsDate(date, startTime)}`);
      if (endTime && endTime > startTime) lines.push(`DTEND:${icsDate(date, endTime)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(date)}`);
    }
  };
  state.events.forEach((e) => {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${e.id}@studien-tracker`);
    lines.push(`DTSTAMP:${stamp}`);
    pushWhen(e.date, e.startTime, e.endTime);
    if (e.repeat && ICS_FREQ[e.repeat]) {
      let rule = `RRULE:FREQ=${ICS_FREQ[e.repeat]}`;
      if (e.repeat === "biweekly") rule += ";INTERVAL=2";
      if (e.repeatUntil) rule += `;UNTIL=${icsDate(e.repeatUntil)}`;
      lines.push(rule);
    }
    lines.push(`SUMMARY:${icsEscape(typeLabel(e.type) + ": " + e.title)}`);
    lines.push("END:VEVENT");
  });
  // 2) terminierte Modulaufgaben (mit Von–Bis-Zeit, falls gesetzt; sonst ganztägig)
  state.modules.forEach((m) => {
    m.tasks.forEach((t) => {
      if (!t.date) return;
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:task-${t.id}@studien-tracker`);
      lines.push(`DTSTAMP:${stamp}`);
      pushWhen(t.date, t.startTime, t.endTime);
      lines.push(`SUMMARY:${icsEscape("Aufgabe: " + t.text + " (" + m.name + ")")}`);
      lines.push("END:VEVENT");
    });
  });
  lines.push("END:VCALENDAR");
  // RFC 5545: Zeilen mit CRLF trennen
  return lines.join("\r\n");
}

/* ---------- ICS-Import (Punkt: Termine aus Uni-Kalender einlesen) ---------- */
// Entfaltet RFC-5545-Zeilenfortsetzungen (Folding): Folgezeilen, die mit einem
// Leerzeichen/Tab beginnen, gehören an die vorige Zeile.
function icsUnfold(text) {
  const raw = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = [];
  raw.forEach((line) => {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  });
  return out;
}
// Macht aus ICS-Escapes wieder normalen Text.
function icsUnescape(s) {
  return String(s).replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}
// Wandelt ein ICS-DTSTART (DATE oder DATE-TIME) in { date:"YYYY-MM-DD", time:"HH:MM"|null }.
function icsParseWhen(value) {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/.exec(value.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const time = m[4] ? `${m[4]}:${m[5]}` : null;
  return { date, time };
}
// Parst ICS-Text zu Event-Objekten im App-Format. Reine Funktion → testbar.
// Unterstützt: SUMMARY, DTSTART (Datum/Zeit), einfache RRULE (FREQ + UNTIL + INTERVAL=2).
// UID wird NICHT übernommen (wir vergeben eigene), Typ = "other".
const ICS_FREQ_REV = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly" };
function parseIcs(text) {
  const lines = icsUnfold(text);
  const events = [];
  let cur = null;
  lines.forEach((line) => {
    const u = line.toUpperCase();
    if (u === "BEGIN:VEVENT") { cur = { title: "", date: null, startTime: null, endTime: null, repeat: null, repeatUntil: null }; return; }
    if (u === "END:VEVENT") {
      if (cur && cur.date) events.push(cur);
      cur = null; return;
    }
    if (!cur) return;
    const ci = line.indexOf(":");
    if (ci < 0) return;
    const rawKey = line.slice(0, ci);       // z. B. "DTSTART;VALUE=DATE"
    const key = rawKey.split(";")[0].toUpperCase();
    const val = line.slice(ci + 1);
    if (key === "SUMMARY") cur.title = icsUnescape(val).replace(/\n/g, " ").trim();
    else if (key === "DTSTART") { const w = icsParseWhen(val); if (w) { cur.date = w.date; cur.startTime = w.time; } }
    else if (key === "DTEND") { const w = icsParseWhen(val); if (w && w.time) cur.endTime = w.time; }
    else if (key === "RRULE") {
      const parts = {};
      val.split(";").forEach((p) => { const [k, v] = p.split("="); if (k) parts[k.toUpperCase()] = (v || "").toUpperCase(); });
      const freq = ICS_FREQ_REV[parts.FREQ];
      if (freq) {
        cur.repeat = (freq === "weekly" && parts.INTERVAL === "2") ? "biweekly" : freq;
        if (parts.UNTIL) { const w = icsParseWhen(parts.UNTIL); if (w) cur.repeatUntil = w.date; }
      }
    }
  });
  return events;
}

/* ---------- German study-time formatting ---------- */
// e.g. 3725s -> "1 Std. 2 Min." ; under a minute -> "0 Min."
function formatDuration(sec) {
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h} Std. ${m} Min.`;
  return `${m} Min.`;
}

/* ---------- Tab navigation ---------- */
const TAB_BTNS = Array.from(document.querySelectorAll(".tab-btn"));
TAB_BTNS.forEach((btn) => {
  btn.addEventListener("click", () => {
    TAB_BTNS.forEach((b) => {
      const on = b === btn;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "dashboard") renderDashboard();
    if (btn.dataset.tab === "calendar") renderCalendar();
    if (btn.dataset.tab === "modules") renderModules();
    if (btn.dataset.tab === "pomodoro") renderStudyStats();
    if (btn.dataset.tab === "settings") { renderStudyChart(); }
  });
  // Pfeiltasten-Navigation innerhalb der Tableiste (übliches ARIA-Tablist-Verhalten).
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = TAB_BTNS.indexOf(btn);
    const next = e.key === "ArrowRight"
      ? TAB_BTNS[(i + 1) % TAB_BTNS.length]
      : TAB_BTNS[(i - 1 + TAB_BTNS.length) % TAB_BTNS.length];
    next.focus();
    next.click();
  });
});

/* ============================================================
   THEME (hell / dunkel / automatisch)  — Punkt 9
   ============================================================ */
const THEME_KEY = "study-tracker-theme";
function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) || "auto"; } catch (e) { return "auto"; }
}
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "auto") {
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", dark ? "dark" : "light");
  } else {
    root.setAttribute("data-theme", mode);
  }
}
function setTheme(mode) {
  try { localStorage.setItem(THEME_KEY, mode); } catch (e) {}
  applyTheme(mode);
  // reflect active state on buttons if present
  document.querySelectorAll("[data-theme-btn]").forEach((b) => {
    b.classList.toggle("active", b.dataset.themeBtn === mode);
  });
}
// React to OS theme changes while in "auto".
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (loadTheme() === "auto") applyTheme("auto");
  });
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function renderDashboard() {
  // Leere App (keine Module & keine Termine) → einladendes Onboarding statt
  // mehrerer „Noch nichts da"-Platzhalter.
  const onbox = document.getElementById("dash-onboarding");
  const grid = document.getElementById("dash-grid");
  const cdCard = document.getElementById("countdown-card");
  const empty = state.modules.length === 0 && state.events.length === 0;
  if (onbox) {
    onbox.hidden = !empty;
    if (grid) grid.hidden = empty;
    if (cdCard) cdCard.hidden = empty;
    if (empty) {
      onbox.innerHTML = `
        <div class="onb-icon">🎓</div>
        <h2 class="onb-title">Willkommen im Studien-Tracker</h2>
        <p class="onb-text">Lege dein erstes Modul an, um loszulegen — Fortschritt, Noten, Aufgaben und Kalender bauen darauf auf.</p>
        <div class="onb-actions">
          <button id="onb-new-module" class="primary-btn">Erstes Modul anlegen</button>
          <button id="onb-sample" class="secondary-btn">Beispieldaten laden</button>
        </div>`;
      const nm = document.getElementById("onb-new-module");
      if (nm) nm.addEventListener("click", () => { switchTab("modules"); const el = document.getElementById("module-name"); if (el) el.focus(); });
      const sm = document.getElementById("onb-sample");
      if (sm) sm.addEventListener("click", loadSampleData);
      return; // restliche Blöcke überspringen — sie wären alle leer
    }
  }

  renderCountdown();

  const { pct, weighted } = overallProgress();
  document.getElementById("overall-percent").textContent = pct + "%";
  document.getElementById("overall-bar").style.width = pct + "%";

  const completedCount = state.modules.filter((m) => m.completed).length;
  document.getElementById("overall-summary").textContent = state.modules.length
    ? `${completedCount} von ${state.modules.length} Modul(en) abgeschlossen.`
    : "Noch keine Module — füge im Tab „Module“ eins hinzu, um zu starten.";

  const gpa = computeGpa();
  document.getElementById("gpa-summary").textContent = gpa
    ? `Notendurchschnitt: ${gpa.value.toFixed(2).replace(".", ",")}`
    : "Noch keine Noten erfasst.";

  // ECTS-Studienziel (nur anzeigen, wenn eins gesetzt ist).
  const eg = ectsProgress(state.modules, state.ectsTarget);
  const egBox = document.getElementById("ects-goal");
  if (egBox) {
    if (!eg.active) { egBox.hidden = true; }
    else {
      egBox.hidden = false;
      const fmt = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ",");
      document.getElementById("ects-goal-label").textContent = "ECTS-Ziel";
      document.getElementById("ects-goal-count").textContent =
        `${fmt(eg.earned)} / ${fmt(eg.goal)} ECTS · noch ${fmt(eg.remaining)}`;
      document.getElementById("ects-goal-bar").style.width = eg.pct + "%";
    }
  }

  applyDashCols();
  renderPinnedModules();
  renderOverdue();
  renderPinnedTasks();
  renderAgenda();
  renderSemesterStats();
}

// Spaltenlayout der Übersicht anwenden (1 oder 2) und die Umschalt-Buttons spiegeln.
function applyDashCols() {
  const grid = document.getElementById("dash-grid");
  const cols = state.dashCols === 2 ? 2 : 1;
  if (grid) grid.setAttribute("data-cols", String(cols));
  const b1 = document.getElementById("dash-col-1");
  const b2 = document.getElementById("dash-col-2");
  if (b1) b1.setAttribute("aria-pressed", cols === 1 ? "true" : "false");
  if (b2) b2.setAttribute("aria-pressed", cols === 2 ? "true" : "false");
}

// Noten-Verlauf je Semester (Dashboard). Zeigt pro Semester den gewichteten
// Schnitt als Balken (dt. Skala 1,0 best … 5,0) plus Trend ggü. Vorsemester.
function renderSemesterStats() {
  const wrap = document.getElementById("semester-stats");
  const block = document.getElementById("semester-block");
  if (!wrap || !block) return;
  const rows = gradesBySemester(state.modules);
  // Erst ab zwei benoteten Semestern ist ein „Verlauf“ aussagekräftig.
  if (rows.length < 2) { wrap.innerHTML = ""; block.hidden = true; return; }
  block.hidden = false;

  // Balkenbreite: 1,0 = voll, 5,0 = kurz (bessere Note = längerer, grünerer Balken).
  const widthFor = (g) => Math.max(6, Math.round((5 - g) / 4 * 100));
  const fmt = (g) => g.toFixed(2).replace(".", ",");

  wrap.innerHTML = rows.map((r, i) => {
    let trend = "";
    if (i > 0) {
      const diff = r.avg - rows[i - 1].avg; // kleiner = besser
      if (Math.abs(diff) < 0.05) trend = `<span class="sem-trend flat" title="unverändert">→</span>`;
      else if (diff < 0) trend = `<span class="sem-trend up" title="besser als Vorsemester">▲ ${fmt(Math.abs(diff))}</span>`;
      else trend = `<span class="sem-trend down" title="schlechter als Vorsemester">▼ ${fmt(Math.abs(diff))}</span>`;
    }
    const cls = r.avg <= 1.5 ? "excellent" : r.avg <= 2.5 ? "good" : r.avg <= 3.5 ? "ok" : "weak";
    return `
      <div class="sem-row">
        <div class="sem-head">
          <span class="sem-name">${escapeHtml(r.semester)}</span>
          <span class="sem-avg">Ø ${fmt(r.avg)} <span class="sem-meta">· ${r.count} Modul(e)${r.ects ? ` · ${r.ects} ECTS` : ""}</span> ${trend}</span>
        </div>
        <div class="sem-bar"><div class="sem-fill ${cls}" style="width:${widthFor(r.avg)}%"></div></div>
      </div>`;
  }).join("");
}

// Merkt die im Countdown gezeigte Prüfung (Id + Datum), damit „Anstehend" sie
// nicht doppelt listet. Wird von renderCountdown gesetzt.
let countdownShownExam = null;

function renderCountdown() {
  const card = document.getElementById("countdown-card");
  const today = todayIso();
  // Consider recurring exams too: use each event's next occurrence from today.
  let nextExam = null, nextExamDate = null;
  state.events.filter((e) => e.type === "exam").forEach((e) => {
    const occ = nextOccurrence(e, today);
    if (occ && (!nextExamDate || occ < nextExamDate || (occ === nextExamDate && timeKey(e) < timeKey(nextExam)))) {
      nextExam = e; nextExamDate = occ;
    }
  });
  countdownShownExam = nextExam ? { id: nextExam.id, date: nextExamDate } : null;

  if (!nextExam) {
    card.className = "countdown-card none";
    card.innerHTML = `<span>🎯 Keine anstehenden Prüfungen. Füge im Kalender eine hinzu.</span>`;
    return;
  }
  const days = daysBetween(today, nextExamDate);
  const label = days === 0 ? "Heute!" : days === 1 ? "1 Tag" : `${days} Tage`;
  const tr = timeRange(nextExam.startTime, nextExam.endTime);
  const timePart = tr ? ` · ${tr} Uhr` : "";
  // ≤ 3 Tage → dringende, warme Darstellung
  card.className = "countdown-card" + (days <= 3 ? " urgent" : "");
  card.innerHTML = `
    <div><div class="cd-days">${label}</div><div class="muted">bis zur nächsten Prüfung</div></div>
    <div class="cd-info">
      <div class="cd-title">${escapeHtml(nextExam.title)}</div>
      <div class="cd-date">${formatDate(nextExamDate)}${timePart}</div>
    </div>`;
}

function renderPinnedModules() {
  const wrap = document.getElementById("pinned-modules");
  wrap.innerHTML = "";
  const pinned = state.modules.filter((m) => m.pinned);
  if (!pinned.length) {
    wrap.innerHTML = `<p class="empty-state">Keine Module angeheftet. Hefte im Tab „Module“ die an, an denen du arbeitest.</p>`;
    return;
  }
  pinned.forEach((m) => {
    const pct = moduleProgress(m);
    const bits = [];
    if (m.ects) bits.push(`${m.ects} ECTS`);
    if (typeof m.grade === "number") bits.push(`Note ${m.grade}`);
    if (m.completed) bits.push("✓ abgeschlossen");
    // Eingetragene Weblinks des Moduls als anklickbare Chips anzeigen (sichere
    // http(s)-URLs, in migrate() bereits gehärtet). Ohne Links kein Zusatz.
    const links = Array.isArray(m.links) ? m.links.filter((l) => l && l.url) : [];
    const linksHtml = links.length
      ? `<div class="pinned-links">` + links.map((l) =>
          `<a class="mod-link" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(l.url)}">${icon("link")} ${escapeHtml(l.label || l.url)}</a>`
        ).join("") + `</div>`
      : "";
    const div = document.createElement("div");
    div.className = "module-progress-item";
    div.innerHTML = `
      <div class="progress-label">
        <span>${escapeHtml(m.name)} ${bits.length ? `<span class="meta">· ${bits.join(" · ")}</span>` : ""}</span>
        <span>${pct}%</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      ${linksHtml}`;
    wrap.appendChild(div);
  });
}

// Überfällige, offene Aufgaben (Punkt 5)
function renderOverdue() {
  const wrap = document.getElementById("overdue-list");
  const block = document.getElementById("overdue-block");
  if (!wrap) return;
  const today = todayIso();

  // (1) Überfällige, offene Aufgaben (abhakbar).
  const overdueTasks = tasksByDue().filter((x) => x.task.date < today);
  // (2) Überfällige einmalige Prüfungen/Abgaben aus dem Kalender (nicht wiederkehrend).
  const overdueEvents = state.events
    .filter((e) => (e.type === "exam" || e.type === "deadline") && !e.repeat && e.date < today)
    .sort((a, b) => b.date.localeCompare(a.date)); // jüngstes zuerst

  const count = overdueTasks.length + overdueEvents.length;
  if (!count) { wrap.innerHTML = ""; if (block) block.hidden = true; return; }
  if (block) block.hidden = false;

  const head = `<h2 class="overdue-head">⚠️ ${count} ${count === 1 ? "Sache braucht" : "Dinge brauchen"} Aufmerksamkeit</h2>`;

  const taskItems = overdueTasks.map(({ module, task, status }) => {
    const cbId = `ov-${task.id}`;
    return `<li class="focus-item">
      <div class="focus-main">
        <input type="checkbox" id="${cbId}" data-overdue-done="${task.id}" />
        <span class="focus-text">${escapeHtml(task.text)}
          <span class="due-badge ${status.cls}">${status.label}</span></span>
        <span class="focus-mod">${escapeHtml(module.name)}</span>
      </div></li>`;
  }).join("");

  const eventItems = overdueEvents.map((e) => {
    const diff = daysBetween(e.date, today);
    const label = diff === 1 ? "seit gestern" : `seit ${diff} Tagen`;
    return `<li class="focus-item">
      <div class="focus-main">
        <span class="tag ${e.type}">${typeLabel(e.type)}</span>
        <span class="focus-text">${escapeHtml(e.title)}
          <span class="due-badge overdue">${label}</span></span>
        <span class="focus-mod">${formatDate(e.date)}</span>
      </div></li>`;
  }).join("");

  wrap.innerHTML = head + `<ul class="focus-list">` + taskItems + eventItems + `</ul>`;

  wrap.querySelectorAll("[data-overdue-done]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const t = findTaskById(cb.dataset.overdueDone);
      if (t) { t.done = cb.checked; t.subtasks.forEach((s) => (s.done = cb.checked)); saveState(); renderDashboard(); }
    });
  });
}

// Modul-Auswahl der Schnelleingabe aktuell halten (Auswahl nach Möglichkeit erhalten).
function fillQuickTaskModule() {
  const sel = document.getElementById("quick-task-module");
  if (!sel) return;
  const prev = sel.value;
  if (!state.modules.length) {
    sel.innerHTML = `<option value="">Kein Modul — erst eins anlegen</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  // Angeheftete/offene Module zuerst, dann der Rest — die wahrscheinlichsten Ziele oben.
  const ordered = state.modules.slice().sort((a, b) =>
    (b.pinned - a.pinned) || (a.completed - b.completed));
  sel.innerHTML = ordered.map((m) =>
    `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  if (ordered.some((m) => m.id === prev)) sel.value = prev;
}

function renderPinnedTasks() {
  const list = document.getElementById("pinned-tasks");
  list.innerHTML = "";
  fillQuickTaskModule();

  // Today's Focus = tasks scheduled for today, grouped per module.
  const today = todayIso();
  const groups = state.modules
    .map((m) => ({ module: m, tasks: m.tasks.filter((t) => t.date === today) }))
    .filter((g) => g.tasks.length > 0);

  if (!groups.length) {
    list.innerHTML = `<p class="empty-state illustrated">Heute keine Aufgaben geplant. Gib einer Aufgabe in „Module“ ein Datum oder plane sie im Kalender.</p>`;
    return;
  }

  groups.forEach((group, gi) => {
    const label = document.createElement("div");
    label.className = "focus-group-label" + (gi > 0 ? " spaced" : "");
    label.textContent = group.module.name;
    list.appendChild(label);

    group.tasks.forEach((task) => {
      const li = document.createElement("li");
      li.className = "focus-item";
      const cbId = `focus-${task.id}`;
      const subDone = task.subtasks.filter((s) => s.done).length;
      const subLabel = task.subtasks.length ? ` <span class="focus-sub-count">(${subDone}/${task.subtasks.length})</span>` : "";

      const tr = timeRange(task.startTime, task.endTime);
      const timeBadge = tr ? `<span class="time-badge">${icon("clock")} ${tr}</span>` : "";
      const linkChip = task.url
        ? `<a class="task-link mod-link" href="${escapeHtml(task.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(task.url)}">${icon("link")} Öffnen</a>`
        : "";
      li.innerHTML = `
        <div class="focus-main">
          <input type="checkbox" id="${cbId}" ${task.done ? "checked" : ""} />
          <span class="focus-text ${task.done ? "done" : ""}">${escapeHtml(task.text)}${subLabel}</span>
          ${timeBadge}
          ${linkChip}
        </div>
        <ul class="focus-subtasks"></ul>`;

      // Parent toggle cascades to subtasks (same rule as the Modules view).
      li.querySelector(`#${CSS.escape(cbId)}`).addEventListener("change", (ev) => {
        task.done = ev.target.checked;
        task.subtasks.forEach((s) => { s.done = ev.target.checked; });
        saveState();
        renderDashboard();
      });

      // Render this task's subtasks beneath it.
      const subUl = li.querySelector(".focus-subtasks");
      task.subtasks.forEach((s) => {
        const sli = document.createElement("li");
        const sId = `focus-${task.id}-${s.id}`;
        sli.innerHTML = `
          <input type="checkbox" id="${sId}" ${s.done ? "checked" : ""} />
          <label for="${sId}" class="${s.done ? "done" : ""}">${escapeHtml(s.text)}</label>`;
        sli.querySelector("input").addEventListener("change", (ev) => {
          s.done = ev.target.checked;
          // All subtasks done -> complete parent; untick one -> reopen parent.
          if (task.subtasks.length && task.subtasks.every((x) => x.done)) task.done = true;
          else if (!ev.target.checked) task.done = false;
          saveState();
          renderDashboard();
        });
        subUl.appendChild(sli);
      });

      list.appendChild(li);
    });
  });
}

/* ============================================================
   CALENDAR
   ============================================================ */
let calYear, calMonth;        // currently viewed month
let selectedDate = null;      // YYYY-MM-DD currently selected day
let calendarFilter = "";      // Suchbegriff für die Kalender-Treffermarkierung
let calView = "month";        // "month" | "week"

// Montag der Woche, in der `iso` liegt (ISO-Woche, Montag-first).
function mondayOf(iso) {
  const d = new Date(iso + "T00:00:00");
  const off = (d.getDay() + 6) % 7; // Mo=0 … So=6
  d.setDate(d.getDate() - off);
  return isoOf(d);
}

// Trifft der an einem Tag vorhandene Inhalt auf den Suchbegriff? Prüft
// Event-Titel und die Texte der an dem Tag geplanten Modulaufgaben (inkl.
// Modulname). Reine Funktion (Arrays als Argumente) → testbar.
function dayMatchesQuery(events, tasks, q) {
  if (!q) return false;
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  const hay = [
    ...events.map((e) => e.title || ""),
    ...tasks.map(({ module, task }) => `${task.text} ${module ? module.name : ""}`),
  ].join(" ").toLowerCase();
  return hay.includes(needle);
}

function initCalendarState() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  if (!selectedDate) selectedDate = todayIso();
}

const MONTHS = ["Januar","Februar","März","April","Mai","Juni",
  "Juli","August","September","Oktober","November","Dezember"];

// German labels for event types (stored values stay English for compatibility).
const TYPE_LABELS = { exam: "Prüfung", deadline: "Abgabe", other: "Sonstiges", task: "Aufgabe" };
function typeLabel(t) { return TYPE_LABELS[t] || t; }

function renderCalendar() {
  if (calYear === undefined) initCalendarState();

  // Umschalter-Zustand und Container-Sichtbarkeit spiegeln.
  const monthGrid = document.getElementById("calendar-grid");
  const weekWrap = document.getElementById("calendar-week");
  const weekdays = document.getElementById("calendar-weekdays");
  const btnMonth = document.getElementById("view-month");
  const btnWeek = document.getElementById("view-week");
  if (btnMonth && btnWeek) {
    btnMonth.classList.toggle("active", calView === "month");
    btnWeek.classList.toggle("active", calView === "week");
    btnMonth.setAttribute("aria-pressed", calView === "month" ? "true" : "false");
    btnWeek.setAttribute("aria-pressed", calView === "week" ? "true" : "false");
  }
  if (calView === "week") {
    if (monthGrid) monthGrid.hidden = true;
    if (weekdays) weekdays.hidden = true;
    if (weekWrap) weekWrap.hidden = false;
    renderWeek();
    return;
  }
  if (monthGrid) monthGrid.hidden = false;
  if (weekdays) weekdays.hidden = false;
  if (weekWrap) weekWrap.hidden = true;

  document.getElementById("calendar-title").textContent = `${MONTHS[calMonth]} ${calYear}`;
  document.getElementById("selected-day-label").textContent =
    selectedDate ? `Ausgewählt: ${formatDate(selectedDate)}` : "";

  const grid = document.getElementById("calendar-grid");
  grid.innerHTML = "";

  const firstDay = new Date(calYear, calMonth, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const today = todayIso();

  for (let i = 0; i < startOffset; i++) {
    const empty = document.createElement("div");
    empty.className = "cal-cell empty";
    grid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dayEventsForMatch = eventsOnDate(dateStr);
    const dayTasksForMatch = tasksOnDate(dateStr);
    const isMatch = calendarFilter && dayMatchesQuery(dayEventsForMatch, dayTasksForMatch, calendarFilter);
    const isDimmed = calendarFilter && !isMatch;
    const holiday = holidayName(dateStr);
    const cell = document.createElement("div");
    cell.className = "cal-cell"
      + (dateStr === today ? " today" : "")
      + (dateStr === selectedDate ? " selected" : "")
      + (isMatch ? " search-hit" : "")
      + (isDimmed ? " search-dim" : "")
      + (holiday ? " holiday" : "");
    cell.dataset.date = dateStr; // Drop-Ziel (Drag & Drop)
    if (holiday) cell.title = holiday;
    cell.innerHTML = `<span class="day-num">${day}</span>`
      + (holiday ? `<span class="holiday-dot" aria-label="Feiertag: ${escapeHtml(holiday)}">★</span>` : "");

    // Calendar events on this day (incl. recurring), timed first, ordered by time.
    // itemRef trägt die Herkunft, damit ein Eintrag per Drag umterminiert werden kann.
    const dayItems = [];
    eventsOnDate(dateStr)
      .sort((a, b) => timeKey(a).localeCompare(timeKey(b)))
      .forEach((e) => {
        const tr = timeRange(e.startTime, e.endTime);
        const prefix = tr ? `${tr} ` : "";
        const rep = e.repeat ? " ↻" : "";
        dayItems.push({ type: e.type, label: `${prefix}${e.title}${rep}`, color: e.color || null, drag: { kind: "event", id: e.id } });
      });
    // Scheduled module tasks on this day (nach Startzeit, dann ohne Zeit)
    tasksOnDate(dateStr).sort((a, b) => timeKey(a.task).localeCompare(timeKey(b.task))).forEach(({ module, task }) => {
      const tr = timeRange(task.startTime, task.endTime);
      const prefix = tr ? `${tr} ` : "";
      dayItems.push({ type: "task", label: `${prefix}${task.text} · ${module.name}`, color: null, drag: { kind: "task", id: task.id } });
    });
    dayItems.slice(0, 3).forEach((it) => {
      const ev = document.createElement("div");
      ev.className = `cal-event ${it.type}`;
      if (it.color) ev.style.background = it.color;
      ev.textContent = it.label;
      ev.title = it.label + " — gedrückt halten und auf einen anderen Tag ziehen";
      ev.dataset.dragKind = it.drag.kind;
      ev.dataset.dragId = it.drag.id;
      ev.dataset.fromDate = dateStr;
      makeDraggableCalEvent(ev);
      cell.appendChild(ev);
    });
    if (dayItems.length > 3) {
      const more = document.createElement("div");
      more.className = "cal-more";
      more.textContent = `+${dayItems.length - 3} weitere`;
      cell.appendChild(more);
    }

    cell.addEventListener("click", () => {
      selectedDate = dateStr;
      renderCalendar();
    });
    grid.appendChild(cell);
  }

  renderDayDetail();
}

// Stundenraster der Wochenansicht — Fenster & Standard-Dauer aus state.weekGrid
// (in den Einstellungen anpassbar). WEEK_ROW_PX = Höhe einer Stundenzeile.
const WEEK_ROW_PX = 44;
function weekStartHour() { return (state.weekGrid && state.weekGrid.startHour) || 8; }
function weekEndHour() { return (state.weekGrid && state.weekGrid.endHour) || 21; }
function weekHours() { return weekEndHour() - weekStartHour() + 1; }
function defaultDurationMin() { return (state.weekGrid && state.weekGrid.defaultDurationMin) || 60; }

// "HH:MM" → Minuten seit Mitternacht (oder null).
function minutesOfTime(t) {
  const n = normalizeTime(t);
  if (!n) return null;
  const [h, m] = n.split(":").map(Number);
  return h * 60 + m;
}

// Start/Ende (Minuten) eines Postens; ohne Endzeit Standard-Dauer. Reine Funktion.
function itemSpan(it, defMin) {
  const start = minutesOfTime(it.startTime);
  if (start == null) return null;
  let end = minutesOfTime(it.endTime);
  if (end == null || end <= start) end = start + (defMin || 60);
  return { start, end };
}

// Überschneidungs-Layout für zeitlich platzierte Posten eines Tages.
// Bestimmt pro Posten eine Spalte (col) und die Spaltenanzahl der Überlappungs-
// gruppe (cols), sowie ob er sich mit einem anderen überschneidet (overlap).
// Reine Funktion (nimmt Items mit startTime/endTime) → testbar.
function layoutOverlaps(items, defMin) {
  const spans = items
    .map((it) => ({ it, ...(itemSpan(it, defMin) || {}) }))
    .filter((x) => x.start != null)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const result = [];
  let cluster = [];          // aktuelle Gruppe sich (transitiv) überlappender Blöcke
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    // Greedy-Spaltenzuweisung innerhalb der Gruppe.
    const colEnds = []; // Endzeit je Spalte
    cluster.forEach((x) => {
      let col = colEnds.findIndex((end) => end <= x.start);
      if (col === -1) { col = colEnds.length; colEnds.push(x.end); }
      else colEnds[col] = x.end;
      x.col = col;
    });
    const cols = colEnds.length;
    cluster.forEach((x) => result.push({
      it: x.it, start: x.start, end: x.end, col: x.col, cols,
      overlap: cols > 1,
    }));
    cluster = []; clusterEnd = -1;
  };

  spans.forEach((x) => {
    if (cluster.length && x.start >= clusterEnd) flush();
    cluster.push(x);
    clusterEnd = Math.max(clusterEnd, x.end);
  });
  flush();
  return result;
}

// Hybride Wochenansicht (Mo–So): oben eine „ohne feste Zeit"-Leiste, darunter ein
// Stundenraster 08–21 Uhr. Posten MIT Uhrzeit werden als Von–Bis-Blöcke ins Raster
// positioniert; Posten OHNE Uhrzeit landen in der Leiste. Events (Prüfungen/Sonstiges)
// und geplante Modulaufgaben werden gleichermaßen angezeigt. Richtet sich nach `selectedDate`.
function renderWeek() {
  const wrap = document.getElementById("calendar-week");
  if (!wrap) return;
  const base = selectedDate || todayIso();
  const start = mondayOf(base);
  const startD = new Date(start + "T00:00:00");
  const endD = new Date(start + "T00:00:00"); endD.setDate(endD.getDate() + 6);
  const today = todayIso();
  const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const fmtShort = (d) => `${d.getDate()}.${d.getMonth() + 1}.`;
  document.getElementById("calendar-title").textContent = `Woche ${fmtShort(startD)} – ${fmtShort(endD)} ${endD.getFullYear()}`;
  document.getElementById("selected-day-label").textContent =
    selectedDate ? `Ausgewählt: ${formatDate(selectedDate)}` : "";

  // Auf schmalen Screens (iPhone Hochformat) nur EINEN Tag zeigen — ein
  // 7-Spalten-Raster ist dort unlesbar. Der gezeigte Tag ist `selectedDate`;
  // Navigation über die vorhandenen Tag-Pfeile ‹ ›.
  const singleDay = typeof window !== "undefined" && window.matchMedia
    && window.matchMedia("(max-width: 560px)").matches;

  // Pro Tag die Posten einsammeln und in „mit Zeit" / „ohne Zeit" aufteilen.
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start + "T00:00:00"); d.setDate(d.getDate() + i);
    const iso = isoOf(d);
    // Einzeltag-Modus: nur den ausgewählten Tag aufbauen.
    if (singleDay && iso !== (selectedDate || today)) continue;
    const items = [];
    eventsOnDate(iso).forEach((e) => items.push({
      kind: "event", id: e.id, type: e.type, title: e.title,
      startTime: e.startTime, endTime: e.endTime, color: sanitizeHexColor(e.color),
      repeat: e.repeat, done: false,
    }));
    tasksOnDate(iso).forEach(({ module, task }) => items.push({
      kind: "task", id: task.id, type: "task", title: `${task.text} · ${module.name}`,
      startTime: task.startTime, endTime: task.endTime, color: null, repeat: null, done: task.done,
    }));
    const isMatch = calendarFilter && dayMatchesQuery(eventsOnDate(iso), tasksOnDate(iso), calendarFilter);
    days.push({ iso, d, items, isMatch, isDimmed: calendarFilter && !isMatch });
  }

  // Im Einzeltag-Modus den Titel auf den Tag setzen (statt Wochenbereich).
  if (singleDay && days[0]) {
    const WDlong = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
    document.getElementById("calendar-title").textContent = `${WDlong[days[0].d.getDay()]} ${fmtShort(days[0].d)}`;
  }

  // Einfacher Block für die „ohne Zeit"-Leiste (keine Rasterposition).
  const buildBlock = (it, iso) => {
    const ev = document.createElement("div");
    ev.className = `cal-event ${it.type}` + (it.done ? " done" : "");
    if (it.color) ev.style.background = it.color;
    const tr = timeRange(it.startTime, it.endTime);
    ev.textContent = (tr ? tr + " " : "") + it.title + (it.repeat ? " ↻" : "");
    ev.title = (tr ? tr + " · " : "") + it.title + " — gedrückt halten und auf einen anderen Tag/Slot ziehen";
    ev.dataset.dragKind = it.kind; ev.dataset.dragId = it.id; ev.dataset.fromDate = iso;
    makeDraggableCalEvent(ev);
    return ev;
  };

  const startH = weekStartHour(), endH = weekEndHour(), rows = weekHours();
  const windowStartMin = startH * 60, windowEndMin = (endH + 1) * 60;

  // --- Aufbau: Kopfzeile, Ganztags-Leiste, Stundenraster ---
  wrap.innerHTML = "";
  wrap.classList.toggle("single-day", singleDay);
  wrap.style.setProperty("--wk-days", String(days.length)); // 1 (mobil) oder 7
  const colClass = (day) => "wk-col"
    + (day.iso === today ? " today" : "")
    + (day.iso === selectedDate ? " selected" : "")
    + (day.isMatch ? " search-hit" : "")
    + (day.isDimmed ? " search-dim" : "");

  // Kopfzeile: Eck-Spalte (leer) + 7 Tagesköpfe.
  const header = document.createElement("div");
  header.className = "wk-grid-head";
  header.appendChild(document.createElement("div")); // Eck-Zelle über der Zeitachse
  days.forEach((day) => {
    const h = document.createElement("div");
    h.className = colClass(day) + " wk-colhead";
    h.innerHTML = `<span class="wk-wd">${WD[day.d.getDay() === 0 ? 6 : day.d.getDay() - 1]}</span><span class="wk-num">${fmtShort(day.d)}</span>`;
    h.addEventListener("click", () => { selectedDate = day.iso; renderCalendar(); });
    header.appendChild(h);
  });
  wrap.appendChild(header);

  // Ganztags-/„ohne Zeit"-Leiste: Eck-Label + 7 Tageszellen (Drop-Ziel = ganzer Tag).
  const allday = document.createElement("div");
  allday.className = "wk-allday";
  const adLabel = document.createElement("div");
  adLabel.className = "wk-allday-label";
  adLabel.textContent = "ohne Zeit";
  allday.appendChild(adLabel);
  days.forEach((day) => {
    const cell = document.createElement("div");
    cell.className = colClass(day) + " wk-allday-cell";
    cell.dataset.date = day.iso; // Drop ohne Uhrzeit
    day.items.filter((it) => !it.startTime).forEach((it) => cell.appendChild(buildBlock(it, day.iso)));
    allday.appendChild(cell);
  });
  wrap.appendChild(allday);

  // Stundenraster: Zeitachse links + 7 Tagesspalten mit absoluten Blöcken.
  const grid = document.createElement("div");
  grid.className = "wk-grid";
  grid.style.setProperty("--wk-rows", String(rows));
  grid.style.setProperty("--wk-row-px", WEEK_ROW_PX + "px");

  const axis = document.createElement("div");
  axis.className = "wk-axis";
  for (let hh = startH; hh <= endH; hh++) {
    const lab = document.createElement("div");
    lab.className = "wk-hour-label";
    lab.textContent = String(hh).padStart(2, "0") + ":00";
    axis.appendChild(lab);
  }
  grid.appendChild(axis);

  // „Jetzt"-Linie (Punkt 2): nur wenn heute in der sichtbaren Woche liegt und die
  // aktuelle Uhrzeit ins Fenster fällt.
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayInWeek = days.some((day) => day.iso === today);
  const showNow = todayInWeek && nowMin >= windowStartMin && nowMin <= windowEndMin;

  days.forEach((day) => {
    const col = document.createElement("div");
    col.className = colClass(day) + " wk-daycol";
    col.dataset.date = day.iso;
    col.dataset.slotted = "1"; // markiert Spalten mit Uhrzeit-Drop
    // Stundenlinien (Drop-Ziele für Uhrzeit)
    for (let r = 0; r < rows; r++) {
      const line = document.createElement("div");
      line.className = "wk-hour-line";
      line.dataset.date = day.iso;
      line.dataset.hour = String(startH + r);
      col.appendChild(line);
    }

    // „Jetzt"-Linie in die heutige Spalte zeichnen.
    if (showNow && day.iso === today) {
      const nl = document.createElement("div");
      nl.className = "wk-now-line";
      nl.style.top = ((nowMin - windowStartMin) / 60) * WEEK_ROW_PX + "px";
      nl.setAttribute("aria-hidden", "true");
      col.appendChild(nl);
    }

    // Positionierte Blöcke mit Überschneidungs-Layout (Punkt 1).
    const timed = day.items.filter((it) => it.startTime);
    const laid = layoutOverlaps(timed, defaultDurationMin());
    laid.forEach(({ it, start, end, col: c, cols, overlap }) => {
      const ev = document.createElement("div");
      ev.className = `cal-event ${it.type} wk-block` + (it.done ? " done" : "") + (overlap ? " overlap" : "");
      if (it.color) ev.style.background = it.color;
      const tr = timeRange(it.startTime, it.endTime);
      // Position: oben/höhe aus Minuten; ans Fenster klemmen, falls außerhalb.
      const clampedStart = Math.max(start, windowStartMin);
      const clampedEnd = Math.min(end, windowEndMin);
      const top = ((clampedStart - windowStartMin) / 60) * WEEK_ROW_PX;
      const height = Math.max(20, ((clampedEnd - clampedStart) / 60) * WEEK_ROW_PX - 2);
      ev.style.top = Math.max(0, top) + "px";
      ev.style.height = height + "px";
      // Breite/links nach Spalte (bei Überschneidung nebeneinander).
      const widthPct = 100 / cols;
      ev.style.left = `calc(${c * widthPct}% + 2px)`;
      ev.style.width = `calc(${widthPct}% - 4px)`;
      const warn = overlap ? ` <span class="wk-clash" title="überschneidet sich zeitlich">⚠</span>` : "";
      ev.innerHTML = `<span class="wk-block-time">${escapeHtml(tr)}</span> ${escapeHtml(it.title)}${it.repeat ? " ↻" : ""}${warn}`;
      ev.title = (tr ? tr + " · " : "") + it.title + (overlap ? " — überschneidet sich mit einem anderen Eintrag" : "") + " — gedrückt halten und auf einen anderen Tag/Slot ziehen";
      ev.dataset.dragKind = it.kind; ev.dataset.dragId = it.id; ev.dataset.fromDate = day.iso;
      makeDraggableCalEvent(ev);
      col.appendChild(ev);
    });
    grid.appendChild(col);
  });
  wrap.appendChild(grid);

  renderDayDetail();
}

function renderDayDetail() {
  const wrap = document.getElementById("day-detail");
  if (!selectedDate) { wrap.innerHTML = ""; return; }
  const dayEvents = eventsOnDate(selectedDate)
    .sort((a, b) => timeKey(a).localeCompare(timeKey(b)) || a.title.localeCompare(b.title));

  const dayTasks = tasksOnDate(selectedDate)
    .sort((a, b) => timeKey(a.task).localeCompare(timeKey(b.task)));

  let html = `<h3>${formatDate(selectedDate)}</h3>`;

  const holiday = holidayName(selectedDate);
  if (holiday) html += `<p class="holiday-note">★ Feiertag: ${escapeHtml(holiday)} <span class="muted">(bundesweit)</span></p>`;

  if (!dayEvents.length && !dayTasks.length) {
    html += `<p class="muted">Nichts geplant. Füge unten etwas hinzu oder plane eine Modulaufgabe für diesen Tag.</p>`;
  }

  // Calendar events (recurring shown with a repeat note)
  const REPEAT_LABELS = { daily: "täglich", weekly: "wöchentlich", biweekly: "alle 2 Wochen", monthly: "monatlich" };
  dayEvents.forEach((e) => {
    const tr = timeRange(e.startTime, e.endTime);
    const timePart = tr ? `<span class="d-time">${tr} Uhr</span> ` : "";
    const repPart = e.repeat ? ` <span class="repeat-badge">↻ ${REPEAT_LABELS[e.repeat] || ""}</span>` : "";
    const delTitle = e.repeat ? "Serie löschen" : "Löschen";
    // Farbe defensiv härten (Defense-in-Depth): nur echte Hex-Farben landen im
    // style-Attribut, selbst falls doch mal ein ungeprüfter Wert durchkäme.
    const safeColor = sanitizeHexColor(e.color);
    const colorStyle = safeColor ? ` style="background:${safeColor};color:#fff"` : "";
    html += `
      <div class="d-event">
        <span class="d-left"><span class="tag ${e.type}"${colorStyle}>${typeLabel(e.type)}</span> ${timePart}${escapeHtml(e.title)}${repPart}</span>
        <button class="del-btn" data-del-event="${e.id}" title="${delTitle}" aria-label="${delTitle}">${icon("close")}</button>
      </div>`;
  });

  // Scheduled module tasks (planned work)
  dayTasks.forEach(({ module, task }) => {
    const tr = timeRange(task.startTime, task.endTime);
    const timePart = tr ? `<span class="d-time">${tr} Uhr</span> ` : "";
    const linkChip = task.url
      ? ` <a class="task-link mod-link" href="${escapeHtml(task.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(task.url)}">${icon("link")} Öffnen</a>`
      : "";
    html += `
      <div class="d-event d-task">
        <span class="d-left">
          <input type="checkbox" data-task-done="${task.id}" ${task.done ? "checked" : ""} />
          <span class="tag task">Aufgabe</span>
          ${timePart}<span class="${task.done ? "done" : ""}">${escapeHtml(task.text)} <span class="muted-inline">· ${escapeHtml(module.name)}</span></span>${linkChip}
        </span>
        <button class="del-btn" data-unplan="${task.id}" title="Von diesem Tag entfernen" aria-label="Von diesem Tag entfernen">${icon("close")}</button>
      </div>`;
  });

  // "Aufgabe planen" — Auswahl nicht terminierter Aufgaben für diesen Tag.
  const unscheduled = [];
  state.modules.forEach((m) => {
    m.tasks.forEach((t) => { if (t.date !== selectedDate) unscheduled.push({ m, t }); });
  });
  if (unscheduled.length) {
    html += `
      <form class="plan-task-form">
        <select data-plan-select>
          <option value="">Modulaufgabe für diesen Tag planen …</option>
          ${unscheduled.map(({ m, t }) =>
            `<option value="${t.id}">${escapeHtml(m.name)} — ${escapeHtml(t.text)}</option>`).join("")}
        </select>
        <button type="submit" class="secondary-btn">Planen</button>
      </form>`;
  }

  wrap.innerHTML = html;

  wrap.querySelectorAll("[data-del-event]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ev = state.events.find((x) => x.id === btn.dataset.delEvent);
      const idx = state.events.indexOf(ev);
      state.events = state.events.filter((x) => x.id !== btn.dataset.delEvent);
      saveState();
      renderCalendar();
      if (ev) showSnackbar(`Eintrag „${ev.title}“ gelöscht.`, () => {
        state.events.splice(Math.min(idx, state.events.length), 0, ev);
        saveState(); renderCalendar();
      });
    });
  });

  // Toggle a scheduled task's done state from the calendar
  wrap.querySelectorAll("[data-task-done]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const task = findTaskById(cb.dataset.taskDone);
      if (task) {
        task.done = cb.checked;
        task.subtasks.forEach((s) => { s.done = cb.checked; });
        saveState(); renderCalendar();
      }
    });
  });

  // Unplan (clear a task's date)
  wrap.querySelectorAll("[data-unplan]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const task = findTaskById(btn.dataset.unplan);
      if (task) { task.date = null; saveState(); renderCalendar(); }
    });
  });

  // Plan a task onto this day
  const planForm = wrap.querySelector(".plan-task-form");
  if (planForm) {
    planForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const id = planForm.querySelector("[data-plan-select]").value;
      if (!id) return;
      const task = findTaskById(id);
      if (task) { task.date = selectedDate; saveState(); renderCalendar(); }
    });
  }

  // Pre-fill the add-entry date field with the selected day.
  const entryDate = document.getElementById("entry-date");
  if (entryDate) entryDate.value = selectedDate;
}

// Find a task object anywhere in the modules by id.
function findTaskById(id) {
  for (const m of state.modules) {
    const t = m.tasks.find((x) => x.id === id);
    if (t) return t;
  }
  return null;
}

/* ============================================================
   LONG-PRESS DRAG-ENGINE (Maus + Touch)
   Gemeinsame Basis: Element nach ~400 ms Gedrückthalten „aufnehmen“,
   per Finger/Maus bewegen, über einem Drop-Ziel ablegen. Funktioniert
   auf dem iPhone (Touch) genauso wie am Mac (Zeiger).
   ============================================================ */
const LONG_PRESS_MS = 400;
const MOVE_CANCEL_PX = 10; // Bewegung vor Long-Press-Ablauf = Scrollen, kein Drag

// opts: { onDrop(targetEl), dropSelector, ghostText() }
function attachLongPressDrag(el, opts) {
  let timer = null, dragging = false, ghost = null, startX = 0, startY = 0, lastTarget = null;

  function pointFromEvent(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    return { x: t.clientX, y: t.clientY };
  }
  function elementAt(x, y) {
    if (ghost) ghost.style.display = "none";
    const under = document.elementFromPoint(x, y);
    if (ghost) ghost.style.display = "";
    return under ? under.closest(opts.dropSelector) : null;
  }
  function startDrag(p) {
    dragging = true;
    document.body.classList.add("dragging-active");
    el.classList.add("drag-source");
    ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = opts.ghostText ? opts.ghostText() : el.textContent;
    document.body.appendChild(ghost);
    moveGhost(p);
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) {} }
  }
  function moveGhost(p) {
    if (ghost) { ghost.style.left = p.x + "px"; ghost.style.top = p.y + "px"; }
    const target = elementAt(p.x, p.y);
    if (target !== lastTarget) {
      if (lastTarget) lastTarget.classList.remove("drop-target");
      if (target) target.classList.add("drop-target");
      lastTarget = target;
    }
  }
  function cleanup() {
    clearTimeout(timer); timer = null;
    document.body.classList.remove("dragging-active");
    el.classList.remove("drag-source");
    if (ghost) { ghost.remove(); ghost = null; }
    if (lastTarget) lastTarget.classList.remove("drop-target");
    lastTarget = null;
  }
  function onDown(e) {
    // Nur primärer Zeiger/erste Berührung
    if (e.button != null && e.button !== 0) return;
    const p = pointFromEvent(e);
    startX = p.x; startY = p.y;
    timer = setTimeout(() => { startDrag(p); }, LONG_PRESS_MS);
    window.addEventListener("mousemove", onMove, { passive: false });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
    window.addEventListener("touchcancel", onUp);
  }
  function onMove(e) {
    const p = pointFromEvent(e);
    if (!dragging) {
      // Vor Long-Press-Ablauf: zu viel Bewegung → als Scrollen werten, abbrechen
      if (Math.abs(p.x - startX) > MOVE_CANCEL_PX || Math.abs(p.y - startY) > MOVE_CANCEL_PX) {
        clearTimeout(timer); timer = null;
      }
      return;
    }
    e.preventDefault(); // Scrollen während Drag unterbinden
    moveGhost(p);
  }
  function onUp(e) {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchend", onUp);
    window.removeEventListener("touchcancel", onUp);
    if (dragging) {
      const p = pointFromEvent(e);
      const target = elementAt(p.x, p.y);
      dragging = false;
      cleanup();
      if (target) { if (e.cancelable) e.preventDefault(); opts.onDrop(target); }
    } else {
      cleanup();
    }
  }
  el.addEventListener("mousedown", onDown);
  el.addEventListener("touchstart", onDown, { passive: true });
}

// Kalendereintrag per Drag umterminieren (Event oder geplante Aufgabe).
function makeDraggableCalEvent(ev) {
  attachLongPressDrag(ev, {
    // Drop-Ziele: Monatszellen, Wochen-Tagesköpfe/Ganztagszellen (nur Datum) und
    // Stundenlinien im Wochenraster (Datum + Uhrzeit).
    dropSelector: ".cal-cell[data-date], .wk-allday-cell[data-date], .wk-colhead[data-date], .wk-hour-line[data-hour]",
    ghostText: () => ev.textContent,
    onDrop: (target) => {
      const toDate = target.dataset.date;
      const fromDate = ev.dataset.fromDate;
      // Drop auf eine Stundenlinie → Datum UND Startzeit setzen.
      const toHour = target.dataset.hour != null ? Number(target.dataset.hour) : null;
      if (!toDate) return;
      if (toDate === fromDate && toHour == null) return;
      moveCalItem(ev.dataset.dragKind, ev.dataset.dragId, fromDate, toDate, toHour);
    },
  });
}

// Verschiebt einen Kalendereintrag auf ein neues Datum (und optional Startstunde).
// Bei gesetzter Stunde wird die bisherige Dauer (Von–Bis) beibehalten.
function moveCalItem(kind, id, fromDate, toDate, toHour) {
  const applyHour = (obj) => {
    if (toHour == null) return;
    const oldStart = minutesOfTime(obj.startTime);
    const oldEnd = minutesOfTime(obj.endTime);
    const dur = (oldStart != null && oldEnd != null && oldEnd > oldStart) ? (oldEnd - oldStart) : defaultDurationMin();
    obj.startTime = String(toHour).padStart(2, "0") + ":00";
    const endMin = Math.min(24 * 60, toHour * 60 + dur);
    const eh = Math.floor(endMin / 60), em = endMin % 60;
    obj.endTime = String(eh).padStart(2, "0") + ":" + String(em).padStart(2, "0");
  };
  if (kind === "task") {
    const t = findTaskById(id);
    if (t) { t.date = toDate; applyHour(t); saveState(); renderCalendar();
      showSnackbar(`Aufgabe auf ${formatDate(toDate)}${toHour != null ? " " + t.startTime + " Uhr" : ""} verschoben.`); }
    return;
  }
  const e = state.events.find((x) => x.id === id);
  if (!e) return;
  if (toHour != null && !e.repeat) applyHour(e);
  if (e.repeat) {
    // Wiederkehrende Einträge: ganze Serie verschieben (Startdatum), mit Rückfrage.
    const delta = daysBetween(e.date, toDate) - daysBetween(e.date, fromDate);
    const ok = confirm(
      `„${e.title}“ ist eine wiederkehrende Serie.\n\n` +
      `OK: ganze Serie um ${delta > 0 ? "+" : ""}${delta} Tag(e) verschieben.\n` +
      `Abbrechen: nichts ändern.`
    );
    if (!ok) { renderCalendar(); return; }
    const base = new Date(e.date + "T00:00:00");
    base.setDate(base.getDate() + delta);
    e.date = isoOf(base);
    if (e.repeatUntil) {
      const ru = new Date(e.repeatUntil + "T00:00:00");
      ru.setDate(ru.getDate() + delta);
      e.repeatUntil = isoOf(ru);
    }
    saveState(); renderCalendar();
    showSnackbar(`Serie „${e.title}“ verschoben.`);
  } else {
    e.date = toDate;
    saveState(); renderCalendar();
    showSnackbar(`„${e.title}“ auf ${formatDate(toDate)} verschoben.`);
  }
}

function shiftDay(delta) {
  if (!selectedDate) selectedDate = todayIso();
  const d = new Date(selectedDate + "T00:00:00");
  d.setDate(d.getDate() + delta);
  selectedDate = isoOf(d);
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  renderCalendar();
}

function shiftMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

const calSearchEl = document.getElementById("calendar-search");
if (calSearchEl) {
  calSearchEl.addEventListener("input", (e) => {
    calendarFilter = e.target.value || "";
    renderCalendar();
  });
}

// Monats-/Wochenansicht umschalten
const viewMonthBtn = document.getElementById("view-month");
const viewWeekBtn = document.getElementById("view-week");
if (viewMonthBtn) viewMonthBtn.addEventListener("click", () => { calView = "month"; renderCalendar(); });
if (viewWeekBtn) viewWeekBtn.addEventListener("click", () => {
  calView = "week";
  if (!selectedDate) selectedDate = todayIso();
  renderCalendar();
});

// In der Wochenansicht verschieben die Pfeile ganze Wochen (sonst Tage/Monate).
function shiftWeek(delta) {
  const base = selectedDate || todayIso();
  const d = new Date(base + "T00:00:00");
  d.setDate(d.getDate() + delta * 7);
  selectedDate = isoOf(d);
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  renderCalendar();
}

// In der Wochenansicht springen die inneren Pfeile tageweise, die äußeren
// wochenweise; in der Monatsansicht wie bisher (Tag bzw. Monat).
document.getElementById("prev-day").addEventListener("click", () => shiftDay(-1));
document.getElementById("next-day").addEventListener("click", () => shiftDay(1));
document.getElementById("prev-month").addEventListener("click", () => calView === "week" ? shiftWeek(-1) : shiftMonth(-1));
document.getElementById("next-month").addEventListener("click", () => calView === "week" ? shiftWeek(1) : shiftMonth(1));
document.getElementById("today-btn").addEventListener("click", () => {
  selectedDate = todayIso();
  initCalendarState();
  calYear = new Date().getFullYear();
  calMonth = new Date().getMonth();
  renderCalendar();
});

// Spaltenlayout-Umschalter der Übersicht (1 ⇄ 2 Spalten; Wahl wird gespeichert).
const dashCol1 = document.getElementById("dash-col-1");
const dashCol2 = document.getElementById("dash-col-2");
function setDashCols(n) {
  state.dashCols = n === 2 ? 2 : 1;
  saveState();
  applyDashCols();
}
if (dashCol1) dashCol1.addEventListener("click", () => setDashCols(1));
if (dashCol2) dashCol2.addEventListener("click", () => setDashCols(2));

// Schnelleingabe im Dashboard: Aufgabe für HEUTE direkt anlegen (Fokus heute).
const quickTaskForm = document.getElementById("quick-task-form");
if (quickTaskForm) {
  quickTaskForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const textEl = document.getElementById("quick-task-text");
    const modSel = document.getElementById("quick-task-module");
    const text = (textEl.value || "").trim();
    const mod = state.modules.find((m) => m.id === modSel.value);
    if (!text || !mod) { if (!state.modules.length) showSnackbar("Lege zuerst ein Modul an, dann kannst du Aufgaben hinzufügen."); return; }
    mod.tasks.push(makeTask({ text, date: todayIso() }));
    saveState();
    textEl.value = "";
    // Fokus im Feld lassen → mehrere Aufgaben schnell nacheinander eingeben.
    setTimeout(() => { const el = document.getElementById("quick-task-text"); if (el) el.focus(); }, 0);
    renderDashboard();
    renderModules(); // Modul-Tab konsistent halten
    showSnackbar(`Aufgabe „${text}“ für heute zu „${mod.name}“ hinzugefügt.`);
  });
}

// Vereinheitlichtes Hinzufügen: ein Formular, zwei Arten (Aufgabe | Prüfung).
// Aufgabe → Modul-Aufgabe (mit optionaler Von–Bis-Zeit, Link, Modulzuordnung).
// Prüfung → Kalender-Event (mit Wiederholung, Serienende, Farbe).
const entryKindSel = document.getElementById("entry-kind");
function fillEntryModuleSelect() {
  const sel = document.getElementById("entry-module");
  if (!sel) return;
  const prev = sel.value;
  if (!state.modules.length) {
    sel.innerHTML = `<option value="">Kein Modul — erst eins anlegen</option>`;
  } else {
    const ordered = state.modules.slice().sort((a, b) => (b.pinned - a.pinned) || (a.completed - b.completed));
    sel.innerHTML = ordered.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
    if (ordered.some((m) => m.id === prev)) sel.value = prev;
  }
}
// Felder je nach Art ein-/ausblenden.
function updateEntryFormMode() {
  const kind = entryKindSel ? entryKindSel.value : "task";
  const isTask = kind === "task";
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
  show("entry-module", isTask);
  show("entry-repeat", !isTask);
  show("entry-repeat-until", !isTask);
  show("entry-color-label", !isTask);
  const title = document.getElementById("entry-title");
  if (title) title.placeholder = isTask ? "z. B. Vorlesung 3 ansehen" : "z. B. Mathe-Klausur";
  const hint = document.getElementById("entry-hint");
  if (hint) hint.textContent = isTask
    ? "Aufgaben erscheinen in der Checkliste des Moduls, im Kalender und in „Fokus heute“."
    : "Prüfungen sind Kalendertermine (mit optionaler Wiederholung & Farbe).";
}
if (entryKindSel) entryKindSel.addEventListener("change", updateEntryFormMode);

const entryForm = document.getElementById("entry-form");
if (entryForm) entryForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const kind = document.getElementById("entry-kind").value;
  const title = document.getElementById("entry-title").value.trim();
  const date = document.getElementById("entry-date").value;
  const startTime = normalizeTime(document.getElementById("entry-start").value);
  let endTime = normalizeTime(document.getElementById("entry-end").value);
  if (startTime && endTime && endTime <= startTime) endTime = null; // Bis vor Von → verwerfen
  const urlRaw = document.getElementById("entry-url").value;
  const url = sanitizeUrl(urlRaw) || "";
  if (urlRaw.trim() && !url) { showSnackbar("Ungültiger Link — bitte eine gültige Web-URL eingeben."); return; }
  if (!title || !date) return;

  if (kind === "task") {
    const modSel = document.getElementById("entry-module");
    const mod = state.modules.find((m) => m.id === modSel.value);
    if (!mod) { showSnackbar("Bitte ein Modul wählen (oder zuerst eins anlegen)."); return; }
    mod.tasks.push(makeTask({ text: title, date, startTime, endTime, url }));
  } else {
    const repeat = document.getElementById("entry-repeat").value || null;
    const repeatUntil = (repeat ? document.getElementById("entry-repeat-until").value : "") || null;
    const colorOn = document.getElementById("entry-color-on").checked;
    const color = colorOn ? sanitizeHexColor(document.getElementById("entry-color").value) : null;
    state.events.push({ id: uid(), date, startTime, endTime, title, type: "exam", repeat, repeatUntil, color });
  }
  saveState();
  selectedDate = date;
  const d = new Date(date + "T00:00:00");
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  // Formular zurücksetzen (Art + Datum behalten für schnelle Mehrfacheingabe).
  document.getElementById("entry-title").value = "";
  document.getElementById("entry-start").value = "";
  document.getElementById("entry-end").value = "";
  document.getElementById("entry-url").value = "";
  document.getElementById("entry-repeat").value = "";
  document.getElementById("entry-repeat-until").value = "";
  document.getElementById("entry-color-on").checked = false;
  renderCalendar();
  renderModules();
  renderDashboard();
});

/* ============================================================
   MODULES & CHECKLISTS
   ============================================================ */
document.getElementById("module-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("module-name").value.trim();
  const ects = parseFloat(document.getElementById("module-ects").value) || 0;
  const semester = document.getElementById("module-semester").value.trim() || null;
  if (!name) return;
  state.modules.push({ id: uid(), name, ects, grade: null, targetGrade: null, semester, gradeComponents: [], links: [], completed: false, pinned: false, collapsed: false, tasks: [] });
  saveState();
  e.target.reset();
  renderModules();
});

let moduleFilter = "";    // Suchbegriff (Punkt 7)
let semesterFilter = "";  // Semesterfilter (Punkt 6)

/* ---------- Semester: Optionen & Sortierung ----------
   Format "SS26" / "WS26". Reihenfolge: Jahr aufsteigend, innerhalb eines
   Jahres SS vor WS. Ohne Semester → ganz ans Ende. */
// Liste auswählbarer Semester (einige Jahre ab aktuellem Studienjahr).
function semesterOptions() {
  const now = new Date();
  // Studienjahr beginnt grob im Herbst; wir starten ein Jahr vor jetzt für Rückwärts-Fälle.
  const startYear = (now.getFullYear() % 100) - 1;
  const out = [];
  for (let i = 0; i < 7; i++) {
    const yy = startYear + i;
    out.push("SS" + String(yy).padStart(2, "0"));
    out.push("WS" + String(yy).padStart(2, "0"));
  }
  return out;
}
// Sortierschlüssel: kleiner = früher. Ungültige/leere → Infinity (ans Ende).
function semesterSortKey(sem) {
  if (!sem) return Infinity;
  const m = /^(SS|WS)\s*'?(\d{2})$/i.exec(String(sem).trim());
  if (!m) return Infinity;
  const term = m[1].toUpperCase() === "SS" ? 0 : 1; // SS vor WS
  const year = parseInt(m[2], 10);
  return year * 2 + term;
}
// Baut die <option>s für ein Semester-Select; `current` wird vorausgewählt
// (auch wenn es nicht in der Standardliste ist).
function semesterOptionsHtml(current) {
  const opts = semesterOptions();
  if (current && !opts.includes(current)) opts.unshift(current);
  return [`<option value="">— kein Semester —</option>`]
    .concat(opts.map((s) => `<option value="${escapeHtml(s)}"${s === current ? " selected" : ""}>${escapeHtml(s)}</option>`))
    .join("");
}
// Füllt das Dropdown im „Modul hinzufügen“-Formular.
function fillCreateSemester() {
  const sel = document.getElementById("module-semester");
  if (sel) sel.innerHTML = semesterOptionsHtml("");
}

// Trifft ein Modul auf den Suchbegriff zu? Prüft Modulname, Aufgaben, Teilaufgaben.
function moduleMatchesFilter(m, q) {
  if (!q) return true;
  const hay = [
    m.name,
    ...m.tasks.map((t) => t.text),
    ...m.tasks.flatMap((t) => t.subtasks.map((s) => s.text)),
  ].join(" ").toLowerCase();
  return hay.includes(q);
}

// Alle vorkommenden Semester (für das Filter-Dropdown).
function allSemesters() {
  const set = new Set();
  state.modules.forEach((m) => { if (m.semester) set.add(m.semester); });
  return Array.from(set).sort();
}
function fillSemesterFilter() {
  const sel = document.getElementById("semester-filter");
  if (!sel) return;
  const prev = semesterFilter;
  sel.innerHTML = `<option value="">Alle Semester</option>` +
    allSemesters().map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  sel.value = allSemesters().includes(prev) ? prev : "";
  semesterFilter = sel.value;
}

// Merkt sich das fokussierte Bedienelement innerhalb der Modulliste, führt den
// (vollständigen) Neuaufbau aus und stellt den Tastaturfokus danach wieder her.
// Ohne das springt der Fokus bei jeder Checkbox/Eingabe an den Seitenanfang.
function renderModules() {
  const active = document.activeElement;
  let restore = null;
  const list = document.getElementById("modules-list");
  if (active && list && list.contains(active)) {
    const id = active.id || null;
    // Stabiler Pfad über die nächstgelegene Daten-ID (Task/Subtask/Link/Teilnote).
    const holder = active.closest("[data-task-id],[data-lk],[data-gc],[data-module-id]");
    let scopeAttr = null, scopeVal = null, innerSel = null;
    if (holder) {
      for (const a of ["data-task-id", "data-lk", "data-gc", "data-module-id"]) {
        if (holder.hasAttribute(a)) { scopeAttr = a; scopeVal = holder.getAttribute(a); break; }
      }
      // Eindeutiges Merkmal des Feldes innerhalb seines Containers.
      const cls = (active.className || "").split(/\s+/).find(Boolean);
      innerSel = active.dataset && Object.keys(active.dataset)[0]
        ? `[data-${Object.keys(active.dataset)[0].replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}]`
        : (cls ? "." + cls : active.tagName.toLowerCase());
    }
    const selStart = (typeof active.selectionStart === "number") ? active.selectionStart : null;
    restore = { id, scopeAttr, scopeVal, innerSel, selStart };
  }

  renderModulesRaw();

  if (restore) {
    let el = null;
    if (restore.id) el = document.getElementById(restore.id);
    if (!el && restore.scopeAttr) {
      const holder = document.querySelector(`[${restore.scopeAttr}="${CSS && CSS.escape ? CSS.escape(restore.scopeVal) : restore.scopeVal}"]`);
      if (holder) el = holder.querySelector(restore.innerSel);
    }
    if (el) {
      try {
        el.focus();
        if (restore.selStart != null && typeof el.setSelectionRange === "function") {
          el.setSelectionRange(restore.selStart, restore.selStart);
        }
      } catch (e) {}
    }
  }
}

function renderModulesRaw() {
  fillPomoModuleSelect();   // Modul-Auswahl beim Timer aktuell halten
  fillEntryModuleSelect();  // Modul-Auswahl im Hinzufügen-Formular aktuell halten
  fillSemesterFilter();     // Semesterfilter aktuell halten

  const wrap = document.getElementById("modules-list");
  wrap.innerHTML = "";

  if (!state.modules.length) {
    wrap.innerHTML = `<p class="empty-state illustrated">Noch keine Module. Füge oben dein erstes hinzu — oder <button id="load-sample" class="link-btn">Beispieldaten laden</button>, um die App auszuprobieren.</p>`;
    const sampleBtn = document.getElementById("load-sample");
    if (sampleBtn) sampleBtn.addEventListener("click", loadSampleData);
    return;
  }

  const q = moduleFilter.trim().toLowerCase();
  const visible = state.modules
    .filter((m) => moduleMatchesFilter(m, q))
    .filter((m) => !semesterFilter || m.semester === semesterFilter);

  if (!visible.length) {
    wrap.innerHTML = `<p class="empty-state">Keine Module passen zu den aktuellen Filtern.</p>`;
    return;
  }

  // Drei Bereiche: In Bearbeitung (angeheftet), Demnächst (Rest), Abgeschlossen.
  // Nach Semester sortieren (Jahr ↑, SS vor WS, ohne Semester ans Ende).
  const bySemester = (a, b) => semesterSortKey(a.semester) - semesterSortKey(b.semester);
  const ongoing = visible.filter((m) => m.pinned && !m.completed).sort(bySemester);
  const upcoming = visible.filter((m) => !m.pinned && !m.completed).sort(bySemester);
  const finished = visible.filter((m) => m.completed).sort(bySemester);

  const sections = [
    { key: "ongoing", title: "In Bearbeitung", hint: "Angeheftete Module, an denen du arbeitest", items: ongoing },
    { key: "upcoming", title: "Demnächst", hint: "Nicht begonnen / nicht angeheftet", items: upcoming },
    { key: "finished", title: "Abgeschlossen", hint: "Fertige Module — eingeklappt als Archiv", items: finished },
  ];

  sections.forEach((sec) => {
    if (!sec.items.length) return;
    // Beim Suchen/Filtern nichts einklappen (sonst wirkt ein Treffer „verschwunden“).
    const collapsed = !q && !semesterFilter && sectionCollapsed[sec.key];
    const header = document.createElement("div");
    header.className = "module-section-head collapsible" + (collapsed ? " collapsed" : "");
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-expanded", collapsed ? "false" : "true");
    header.innerHTML =
      `<span class="section-toggle">${icon(collapsed ? "chevronRight" : "chevronDown")}</span>` +
      `<span>${sec.title} <span class="section-count">${sec.items.length}</span></span>` +
      `<span class="section-hint">${sec.hint}</span>`;
    const toggle = () => { sectionCollapsed[sec.key] = !sectionCollapsed[sec.key]; renderModules(); };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    wrap.appendChild(header);
    if (!collapsed) sec.items.forEach((m) => wrap.appendChild(renderModuleCard(m)));
  });
}

// Einklapp-Zustand der Modul-Abschnitte (reine Ansichtssache, nicht persistiert).
// „Abgeschlossen“ startet eingeklappt → wirkt als Semester-/Modul-Archiv.
const sectionCollapsed = { ongoing: false, upcoming: false, finished: true };

// Kleiner Hinweis unter den Modul-Noten: Status ggü. Wunschnote (Skala 1,0–5,0).
function gradeHint(m) {
  if (typeof m.grade !== "number") {
    if (typeof m.targetGrade === "number")
      return `<p class="grade-hint muted">Wunschnote: ${m.targetGrade.toFixed(1).replace(".", ",")} · noch keine Note erfasst.</p>`;
    return "";
  }
  const passed = isPassingGrade(m.grade);
  let cls = passed ? "ok" : "bad";
  let text = `Note ${m.grade.toFixed(1).replace(".", ",")} — ${passed ? "bestanden" : "nicht bestanden"}`;
  if (typeof m.targetGrade === "number") {
    const met = m.grade <= m.targetGrade;
    cls = met ? "ok" : "warn";
    text += ` · Ziel ${m.targetGrade.toFixed(1).replace(".", ",")} ${met ? "erreicht ✓" : "verfehlt"}`;
  }
  return `<p class="grade-hint ${cls}">${text}</p>`;
}

// Nur sichere Weblinks zulassen. Ergänzt fehlendes https:// und lässt nur
// http(s) durch (keine javascript:/data:-URLs). Rückgabe: saubere URL oder null.
function sanitizeUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s; // bequem: ohne Schema eingeben erlaubt
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Plausibler Host: enthält einen Punkt und keine ungültigen Zeichen.
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    return u.href;
  } catch (e) { return null; }
}

// Chips mit anklickbaren Modul-Links (Anzeige in der Modulkarte).
function renderModuleLinks(wrap, m) {
  const links = Array.isArray(m.links) ? m.links : [];
  if (!links.length) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = links.map((l) =>
    `<a class="mod-link" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(l.url)}">${icon("link")} ${escapeHtml(l.label || l.url)}</a>`
  ).join("");
}

// Editor für die Modul-Links (im Bearbeiten-/Body-Bereich).
function renderLinkEditor(wrap, m) {
  if (!Array.isArray(m.links)) m.links = [];
  const rows = m.links.map((l) => `
    <div class="lk-row" data-lk="${l.id}">
      <input type="text" class="lk-label" data-lk-label placeholder="z. B. Modulseite" value="${escapeHtml(l.label || "")}" aria-label="Bezeichnung des Links" />
      <input type="url" class="lk-url" data-lk-url placeholder="https://…" value="${escapeHtml(l.url || "")}" aria-label="Webadresse" />
      <button class="del-btn" data-lk-del title="Link löschen" aria-label="Link löschen">${icon("close")}</button>
    </div>`).join("");
  wrap.innerHTML = `
    ${m.links.length ? `<div class="lk-head">Links zur Hochschul-Plattform</div>` : ""}
    ${rows}
    <button class="link-btn" data-lk-add>${icon("plus")} Link hinzufügen</button>`;

  wrap.querySelector("[data-lk-add]").addEventListener("click", () => {
    m.links.push({ id: uid(), label: "", url: "" });
    saveState(); renderModules();
  });
  wrap.querySelectorAll(".lk-row").forEach((row) => {
    const id = row.dataset.lk;
    const l = m.links.find((x) => x.id === id);
    if (!l) return;
    row.querySelector("[data-lk-label]").addEventListener("change", (ev) => {
      l.label = ev.target.value.trim(); saveState(); renderModules();
    });
    row.querySelector("[data-lk-url]").addEventListener("change", (ev) => {
      const clean = sanitizeUrl(ev.target.value);
      if (ev.target.value.trim() && !clean) {
        showSnackbar("Ungültige Adresse — bitte eine gültige Web-URL eingeben.");
      }
      l.url = clean || ""; saveState(); renderModules();
    });
    row.querySelector("[data-lk-del]").addEventListener("click", () => {
      m.links = m.links.filter((x) => x.id !== id); saveState(); renderModules();
    });
  });
}

// Teilnoten-Editor für ein Modul (Punkt 4)
function renderGradeComponents(wrap, m) {
  const comps = m.gradeComponents || [];
  const totalW = comps.reduce((a, c) => a + (c.weight || 0), 0);
  const rows = comps.map((c) => `
    <div class="gc-row" data-gc="${c.id}">
      <input type="text" class="gc-label" data-gc-label placeholder="z. B. Klausur" value="${escapeHtml(c.label || "")}" aria-label="Bezeichnung der Teilnote" />
      <input type="number" class="gc-grade" data-gc-grade step="0.1" min="1" max="5" placeholder="Note" value="${c.grade ?? ""}" aria-label="Note der Teilnote" />
      <input type="number" class="gc-weight" data-gc-weight min="0" step="5" placeholder="Gewicht %" value="${c.weight ?? ""}" aria-label="Gewicht in Prozent" />
      <button class="del-btn" data-gc-del title="Teilnote löschen" aria-label="Teilnote löschen">${icon("close")}</button>
    </div>`).join("");

  const warn = (comps.length && totalW !== 100)
    ? `<p class="gc-warn">Summe der Gewichte: ${totalW}% (empfohlen: 100%). Die Endnote wird anteilig berechnet.</p>` : "";

  wrap.innerHTML = `
    ${comps.length ? `<div class="gc-head">Teilnoten (Endnote wird gewichtet berechnet)</div>` : ""}
    ${rows}
    ${warn}
    <button class="link-btn" data-gc-add>${icon("plus")} Teilnote hinzufügen</button>`;

  wrap.querySelector("[data-gc-add]").addEventListener("click", () => {
    if (!Array.isArray(m.gradeComponents)) m.gradeComponents = [];
    m.gradeComponents.push({ id: uid(), label: "", grade: null, weight: 0 });
    syncComponentGrade(m); saveState(); renderModules();
  });
  wrap.querySelectorAll(".gc-row").forEach((row) => {
    const id = row.dataset.gc;
    const c = m.gradeComponents.find((x) => x.id === id);
    if (!c) return;
    row.querySelector("[data-gc-label]").addEventListener("change", (ev) => {
      c.label = ev.target.value.trim(); saveState();
    });
    row.querySelector("[data-gc-grade]").addEventListener("change", (ev) => {
      const v = parseFloat(String(ev.target.value).replace(",", "."));
      c.grade = isNaN(v) ? null : v; syncComponentGrade(m); saveState(); renderModules();
    });
    row.querySelector("[data-gc-weight]").addEventListener("change", (ev) => {
      c.weight = parseFloat(ev.target.value) || 0; syncComponentGrade(m); saveState(); renderModules();
    });
    row.querySelector("[data-gc-del]").addEventListener("click", () => {
      m.gradeComponents = m.gradeComponents.filter((x) => x.id !== id);
      syncComponentGrade(m); saveState(); renderModules();
    });
  });
}

function renderModuleCard(m) {
  const pct = moduleProgress(m);
  const done = m.tasks.filter((t) => t.done).length;
  const hasComponents = m.gradeComponents && m.gradeComponents.length > 0;
  // Nächste anstehende Fälligkeit (nur bei offenen Modulen relevant).
  const nd = m.completed ? null : nextModuleDue(m, todayIso());
  const dueBadgeHead = nd ? `<span class="due-badge ${nd.status.cls} mod-due">${nd.status.label}</span>` : "";
  const card = document.createElement("div");
  card.className = "module-card" + (m.completed ? " completed" : "") + (m.collapsed ? " collapsed" : "");
  card.draggable = true;
  card.dataset.moduleId = m.id;

  card.innerHTML = `
    <div class="module-head">
      <h3>
        <button class="collapse-btn" data-collapse title="${m.collapsed ? "Ausklappen" : "Einklappen"}" aria-label="${m.collapsed ? "Modul ausklappen" : "Modul einklappen"}" aria-expanded="${!m.collapsed}">${icon(m.collapsed ? "chevronRight" : "chevronDown")}</button>
        ${escapeHtml(m.name)}
        ${m.ects ? `<span class="badge">${m.ects} ECTS</span>` : ""}
        ${m.semester ? `<span class="badge sem">${escapeHtml(m.semester)}</span>` : ""}
        ${m.completed ? `<span class="badge done">✓ fertig</span>` : ""}
        ${dueBadgeHead}
      </h3>
      <div class="module-actions">
        <span class="pct">${done}/${m.tasks.length} · ${pct}%</span>
        <button class="pin-btn" data-edit-module title="Modulname bearbeiten" aria-label="Modulname bearbeiten">${icon("edit")}</button>
        <button class="pin-btn ${m.pinned ? "pinned" : ""}" data-pin-module title="Als „In Bearbeitung“ markieren (anheften)" aria-label="Modul anheften/lösen" aria-pressed="${m.pinned}">${icon("pin")}</button>
        <button class="del-btn" data-del-module title="Modul löschen" aria-label="Modul löschen">${icon("trash")}</button>
      </div>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="mod-links"></div>
    <div class="module-body">
      <div class="module-controls">
        <label><input type="checkbox" data-complete ${m.completed ? "checked" : ""}/> Abgeschlossen</label>
        <label>Note: <input type="number" class="grade-input" data-grade step="0.1" min="1" max="5" placeholder="—" value="${m.grade ?? ""}" ${hasComponents ? "disabled title='Wird aus Teilnoten berechnet'" : ""}/></label>
        <label>Wunschnote: <input type="number" class="grade-input" data-target step="0.1" min="1" max="5" placeholder="—" value="${m.targetGrade ?? ""}"/></label>
        <label>ECTS: <input type="number" class="grade-input" data-ects step="0.5" min="0" placeholder="0" value="${m.ects || ""}"/></label>
        <label>Semester: <select class="semester-edit" data-semester>${semesterOptionsHtml(m.semester || "")}</select></label>
      </div>
      ${gradeHint(m)}
      <div class="grade-components"></div>
      <div class="link-editor"></div>
      <ul class="checklist"></ul>
      <form class="add-task-form"><input type="text" id="add-task-${m.id}" placeholder="Neuer Checklisten-Eintrag …" required /><button type="submit" class="primary-btn">Hinzufügen</button></form>
    </div>`;

  // Collapse/expand toggle
  card.querySelector("[data-collapse]").addEventListener("click", () => {
    m.collapsed = !m.collapsed; saveState(); renderModules();
  });

  // Teilnoten-Editor (Punkt 4)
  const gc = card.querySelector(".grade-components");
  renderGradeComponents(gc, m);

  // Modul-Links: anklickbare Chips + Editor
  renderModuleLinks(card.querySelector(".mod-links"), m);
  renderLinkEditor(card.querySelector(".link-editor"), m);

  // Checklist items (each as a block: the task row + date + subtasks)
  const ul = card.querySelector(".checklist");
  m.tasks.forEach((t) => {
    const li = document.createElement("li");
    li.className = "task-block";
    li.draggable = true;
    li.dataset.taskId = t.id;
    const cbId = `t-${t.id}`;
    const subDone = t.subtasks.filter((s) => s.done).length;
    const subLabel = t.subtasks.length ? ` (${subDone}/${t.subtasks.length})` : "";
    const ds = (t.date && !t.done) ? dueStatus(t.date) : null;
    const dueBadge = ds ? `<span class="due-badge ${ds.cls}">${ds.label}</span>` : "";
    // Uhrzeit-Badge (Von–Bis), falls gesetzt.
    const tr = timeRange(t.startTime, t.endTime);
    const timeBadge = tr ? `<span class="time-badge">${icon("clock")} ${tr}</span>` : "";
    // Anklickbarer Link-Chip, falls ein Link hinterlegt ist (öffnet die Plattform).
    const linkChip = t.url
      ? `<a class="task-link mod-link" href="${escapeHtml(t.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t.url)}">${icon("link")} Öffnen</a>`
      : "";

    li.innerHTML = `
      <div class="task-row">
        <input type="checkbox" class="task-done" id="${cbId}" ${t.done ? "checked" : ""} />
        <label for="${cbId}" class="${t.done ? "done" : ""}">${escapeHtml(t.text)}<span class="muted-inline">${subLabel}</span></label>
        ${timeBadge}
        ${dueBadge}
        ${linkChip}
        <input type="date" class="task-date" data-date value="${t.date || ""}" title="Terminieren (erscheint im Kalender & im Fokus heute)" aria-label="Datum von ${escapeHtml(t.text)}" />
        <button class="icon-btn task-opts-btn" data-task-opts title="Uhrzeit & Link bearbeiten" aria-label="Uhrzeit und Link von ${escapeHtml(t.text)} bearbeiten">${icon("edit")}</button>
        <button class="icon-btn task-dup-btn" data-dup-task title="Aufgabe duplizieren" aria-label="${escapeHtml(t.text)} duplizieren">${icon("copy")}</button>
        <button class="del-btn" data-del-task title="Eintrag löschen" aria-label="${escapeHtml(t.text)} löschen">${icon("close")}</button>
      </div>
      <div class="task-opts" hidden>
        <label class="task-opt">Von <input type="time" data-task-start value="${t.startTime || ""}" aria-label="Startzeit von ${escapeHtml(t.text)}" /></label>
        <label class="task-opt">Bis <input type="time" data-task-end value="${t.endTime || ""}" aria-label="Endzeit von ${escapeHtml(t.text)}" /></label>
        <label class="task-opt task-opt-url">Link:
          <input type="url" data-task-url placeholder="https://… (Plattform/Aufzeichnung)" value="${escapeHtml(t.url || "")}" aria-label="Link von ${escapeHtml(t.text)}" />
        </label>
      </div>
      <ul class="subtask-list"></ul>
      <form class="add-subtask-form"><input type="text" id="add-subtask-${t.id}" placeholder="Teilaufgabe hinzufügen …" required /><button type="submit" class="secondary-btn">+</button></form>`;

    // Subtasks
    const subUl = li.querySelector(".subtask-list");
    t.subtasks.forEach((s) => {
      const sli = document.createElement("li");
      const sId = `s-${s.id}`;
      sli.innerHTML = `
        <input type="checkbox" id="${sId}" ${s.done ? "checked" : ""} />
        <label for="${sId}" class="${s.done ? "done" : ""}">${escapeHtml(s.text)}</label>
        <button class="del-btn" title="Teilaufgabe löschen" aria-label="Teilaufgabe ${escapeHtml(s.text)} löschen">${icon("close")}</button>`;
      sli.querySelector("input").addEventListener("change", (ev) => {
        s.done = ev.target.checked;
        if (t.subtasks.length && t.subtasks.every((x) => x.done)) t.done = true;
        else if (!ev.target.checked) t.done = false;
        saveState(); renderModules();
      });
      sli.querySelector(".del-btn").addEventListener("click", () => {
        const idx = t.subtasks.indexOf(s);
        t.subtasks = t.subtasks.filter((x) => x.id !== s.id); saveState(); renderModules();
        showSnackbar(`Teilaufgabe „${s.text}“ gelöscht.`, () => {
          t.subtasks.splice(Math.min(idx, t.subtasks.length), 0, s);
          saveState(); renderModules();
        });
      });
      subUl.appendChild(sli);
    });

    // Add subtask
    li.querySelector(".add-subtask-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const input = ev.target.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      t.subtasks.push({ id: uid(), text, done: false });
      saveState(); renderModules();
    });

    li.querySelector(".task-done").addEventListener("change", (ev) => {
      t.done = ev.target.checked;
      t.subtasks.forEach((s) => { s.done = ev.target.checked; });
      saveState(); renderModules();
    });
    // Schedule date -> drives Calendar + Today's Focus
    li.querySelector("[data-date]").addEventListener("change", (ev) => {
      t.date = ev.target.value || null;
      saveState();
      renderModules();
    });
    li.querySelector("[data-del-task]").addEventListener("click", () => {
      const idx = m.tasks.indexOf(t);
      m.tasks = m.tasks.filter((x) => x.id !== t.id);
      saveState(); renderModules();
      showSnackbar(`Aufgabe „${t.text}“ gelöscht.`, () => {
        m.tasks.splice(Math.min(idx, m.tasks.length), 0, t);
        saveState(); renderModules();
      });
    });

    // Aufgabe duplizieren (direkt darunter einfügen). Datum wird NICHT übernommen,
    // damit die Kopie bewusst neu terminiert wird; Zeit/Link/Teilaufgaben bleiben.
    li.querySelector("[data-dup-task]").addEventListener("click", () => {
      const copy = {
        id: uid(), text: t.text, done: false, date: null,
        startTime: t.startTime, endTime: t.endTime, url: t.url,
        subtasks: (t.subtasks || []).map((s) => ({ id: uid(), text: s.text, done: false })),
      };
      const idx = m.tasks.indexOf(t);
      m.tasks.splice(idx + 1, 0, copy);
      saveState(); renderModules();
      showSnackbar(`Aufgabe „${t.text}“ dupliziert.`);
    });

    // Uhrzeit & Link ein-/ausblenden (kleiner Editor pro Aufgabe).
    const optsBox = li.querySelector(".task-opts");
    li.querySelector("[data-task-opts]").addEventListener("click", () => {
      optsBox.hidden = !optsBox.hidden;
      if (!optsBox.hidden) { const u = optsBox.querySelector("[data-task-start]"); if (u) u.focus(); }
    });
    // Von–Bis-Uhrzeit setzen (für den Stundenraster der Wochenansicht).
    li.querySelector("[data-task-start]").addEventListener("change", (ev) => {
      t.startTime = normalizeTime(ev.target.value);
      saveState(); renderModules();
    });
    li.querySelector("[data-task-end]").addEventListener("change", (ev) => {
      t.endTime = normalizeTime(ev.target.value);
      saveState(); renderModules();
    });
    // Link setzen/entfernen — nur sichere http(s)-URLs (wie bei den Modul-Links).
    li.querySelector("[data-task-url]").addEventListener("change", (ev) => {
      const clean = sanitizeUrl(ev.target.value);
      if (ev.target.value.trim() && !clean) {
        showSnackbar("Ungültige Adresse — bitte eine gültige Web-URL eingeben.");
      }
      t.url = clean || "";
      saveState(); renderModules();
    });

    // Drag & Drop der Aufgaben innerhalb des Moduls (Punkt 6)
    li.addEventListener("dragstart", (e) => {
      e.stopPropagation(); dragTaskId = t.id; li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragend", (e) => { e.stopPropagation(); dragTaskId = null; li.classList.remove("dragging"); });
    li.addEventListener("dragover", (e) => {
      if (!dragTaskId || dragTaskId === t.id) return;
      e.preventDefault(); e.stopPropagation(); li.classList.add("drop-target");
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
    li.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation(); li.classList.remove("drop-target");
      reorderTask(m, dragTaskId, t.id);
    });
    // Touch-tauglich (iPhone): Long-Press zum Umsortieren der Aufgabe
    li.dataset.taskId = t.id;
    attachLongPressDrag(li, {
      dropSelector: ".task-block[data-task-id]",
      ghostText: () => t.text,
      onDrop: (target) => {
        const toId = target.dataset.taskId;
        if (toId && toId !== t.id) reorderTask(m, t.id, toId);
      },
    });

    ul.appendChild(li);
  });

  // Add task
  card.querySelector(".add-task-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = ev.target.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    m.tasks.push(makeTask({ text }));
    saveState(); renderModules();
  });

  // Completed toggle (moving a module between sections re-renders)
  card.querySelector("[data-complete]").addEventListener("change", (ev) => {
    m.completed = ev.target.checked; saveState(); renderModules();
  });
  card.querySelector("[data-grade]").addEventListener("change", (ev) => {
    const v = parseFloat(ev.target.value);
    m.grade = isNaN(v) ? null : v; saveState(); renderModules();
  });
  card.querySelector("[data-target]").addEventListener("change", (ev) => {
    const v = parseFloat(ev.target.value);
    m.targetGrade = isNaN(v) ? null : v; saveState(); renderModules();
  });
  card.querySelector("[data-ects]").addEventListener("change", (ev) => {
    m.ects = parseFloat(ev.target.value) || 0; saveState(); renderModules();
  });
  card.querySelector("[data-semester]").addEventListener("change", (ev) => {
    m.semester = ev.target.value.trim() || null; saveState(); renderModules();
  });
  card.querySelector("[data-pin-module]").addEventListener("click", () => {
    m.pinned = !m.pinned; saveState(); renderModules();
  });
  card.querySelector("[data-edit-module]").addEventListener("click", () => {
    const neu = prompt("Modulname bearbeiten:", m.name);
    if (neu === null) return;              // abgebrochen
    const name = neu.trim();
    if (!name) return;                     // leer nicht übernehmen
    m.name = name; saveState(); renderModules(); renderDashboard();
  });
  card.querySelector("[data-del-module]").addEventListener("click", () => {
    const idx = state.modules.indexOf(m);
    state.modules = state.modules.filter((x) => x.id !== m.id);
    saveState(); renderModules(); renderDashboard();
    showSnackbar(`Modul „${m.name}“ gelöscht.`, () => {
      state.modules.splice(Math.min(idx, state.modules.length), 0, m);
      saveState(); renderModules(); renderDashboard();
    });
  });

  // Drag & Drop zum Umsortieren der Module (Punkt 6)
  card.addEventListener("dragstart", (e) => {
    dragModuleId = m.id; card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => { dragModuleId = null; card.classList.remove("dragging"); });
  card.addEventListener("dragover", (e) => {
    if (!dragModuleId || dragModuleId === m.id) return;
    e.preventDefault(); card.classList.add("drop-target");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
  card.addEventListener("drop", (e) => {
    e.preventDefault(); card.classList.remove("drop-target");
    reorderModule(dragModuleId, m.id);
  });
  // Touch-tauglich (iPhone): Long-Press auf der Modul-Überschrift sortiert um
  const head = card.querySelector(".module-head h3");
  if (head) {
    head.classList.add("drag-handle");
    attachLongPressDrag(head, {
      dropSelector: ".module-card[data-module-id]",
      ghostText: () => m.name,
      onDrop: (target) => {
        const toId = target.dataset.moduleId;
        if (toId && toId !== m.id) reorderModule(m.id, toId);
      },
    });
  }

  return card;
}

let dragModuleId = null;
let dragTaskId = null;
// Verschiebt das Modul mit `fromId` direkt vor das Modul mit `toId`.
function reorderModule(fromId, toId) {
  if (!fromId || fromId === toId) return;
  const arr = state.modules;
  const from = arr.findIndex((x) => x.id === fromId);
  const to = arr.findIndex((x) => x.id === toId);
  if (from < 0 || to < 0) return;
  const [moved] = arr.splice(from, 1);
  const newTo = arr.findIndex((x) => x.id === toId);
  arr.splice(newTo, 0, moved);
  saveState(); renderModules();
}
// Verschiebt eine Aufgabe innerhalb ihres Moduls vor die Ziel-Aufgabe.
function reorderTask(m, fromId, toId) {
  if (!fromId || fromId === toId) return;
  const arr = m.tasks;
  const from = arr.findIndex((x) => x.id === fromId);
  const to = arr.findIndex((x) => x.id === toId);
  if (from < 0 || to < 0) return;
  const [moved] = arr.splice(from, 1);
  const newTo = arr.findIndex((x) => x.id === toId);
  arr.splice(newTo, 0, moved);
  saveState(); renderModules();
}

/* ============================================================
   DATA: export / import / reset
   ============================================================ */
document.getElementById("export-btn").addEventListener("click", () => {
  // Bundle everything so a backup also carries study time + timer settings.
  const payload = { ...state, _stats: stats, _pomodoro: pomoMinutes };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `study-tracker-backup-${todayIso()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus("Daten als .json-Datei exportiert.");
});

document.getElementById("import-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      if (!parsed || !Array.isArray(parsed.modules) || !Array.isArray(parsed.events)) {
        throw new Error("Die Datei sieht nicht wie eine Studien-Tracker-Sicherung aus.");
      }
      if (!confirm("Beim Import werden deine aktuellen Daten ersetzt. Fortfahren?")) return;
      state = migrate(parsed);
      saveState();
      // Restore study stats and timer settings if present in the backup.
      if (parsed._stats && typeof parsed._stats === "object") {
        const ps = parsed._stats;
        stats = {
          sessions: Number(ps.sessions) || 0,
          daily: (ps.daily && typeof ps.daily === "object") ? ps.daily : {},
          perModule: (ps.perModule && typeof ps.perModule === "object") ? ps.perModule : {},
          perTask: (ps.perTask && typeof ps.perTask === "object") ? ps.perTask : {},
          goals: (ps.goals && typeof ps.goals === "object") ? { ...DEFAULT_GOALS, ...ps.goals } : { ...DEFAULT_GOALS },
        };
        pomoSessions = stats.sessions;
        saveStats();
      }
      if (parsed._pomodoro && typeof parsed._pomodoro === "object") {
        pomoMinutes = {
          focus: clampMin(parsed._pomodoro.focus, POMO_DEFAULTS.focus),
          short: clampMin(parsed._pomodoro.short, POMO_DEFAULTS.short),
          long: clampMin(parsed._pomodoro.long, POMO_DEFAULTS.long),
        };
        savePomoMinutes();
        pomoFillSettings();
      }
      renderDashboard(); renderCalendar(); renderModules();
      renderStudyStats(); pomoRender();
      setStatus("Import erfolgreich — deine Daten wurden wiederhergestellt.");
    } catch (err) {
      setStatus("Import fehlgeschlagen: " + err.message, true);
    }
  };
  reader.readAsText(file);
  e.target.value = ""; // allow re-importing the same file
});

document.getElementById("reset-btn").addEventListener("click", () => {
  if (!confirm("ALLE Daten dauerhaft löschen? Das kann nicht rückgängig gemacht werden.")) return;
  state = migrate({ modules: [], events: [] });
  saveState();
  stats = { sessions: 0, daily: {}, perModule: {}, perTask: {}, goals: { ...DEFAULT_GOALS } };
  pomoSessions = 0;
  saveStats();
  renderDashboard(); renderCalendar(); renderModules();
  renderStudyStats(); pomoRender();
  setStatus("Alle Daten gelöscht.");
});

function setStatus(msg, isError) {
  const el = document.getElementById("data-status");
  el.textContent = msg;
  el.style.color = isError ? "var(--danger)" : "var(--muted)";
}

/* ============================================================
   POMODORO TIMER (with custom, persisted durations)
   ============================================================ */
const POMO_KEY = "study-tracker-pomodoro";
const POMO_DEFAULTS = { focus: 25, short: 5, long: 15 }; // minutes
const POMO_LABELS = { focus: "Fokus", short: "Kurze Pause", long: "Lange Pause" };

// Durations persist across reloads; values are in minutes.
let pomoMinutes = loadPomoMinutes();
function loadPomoMinutes() {
  try {
    const raw = localStorage.getItem(POMO_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        focus: clampMin(p.focus, POMO_DEFAULTS.focus),
        short: clampMin(p.short, POMO_DEFAULTS.short),
        long: clampMin(p.long, POMO_DEFAULTS.long),
      };
    }
  } catch (e) {}
  return { ...POMO_DEFAULTS };
}
function clampMin(v, fallback) {
  const n = Math.round(Number(v));
  return (!n || n < 1 || n > 180) ? fallback : n;
}
function savePomoMinutes() { localStorage.setItem(POMO_KEY, JSON.stringify(pomoMinutes)); }
function pomoSeconds(mode) { return pomoMinutes[mode] * 60; }

/* ----- Persisted study stats: session count + per-day study seconds ----- */
const STATS_KEY = "study-tracker-stats";
// Default study-time goals in hours (used as the bar reference maxima).
// Must be declared BEFORE loadStats() runs below (it references DEFAULT_GOALS).
const DEFAULT_GOALS = { day: 8, week: 40, month: 160, year: 1000 };
let stats = loadStats();
function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (typeof s.sessions !== "number") s.sessions = 0;
      if (!s.daily || typeof s.daily !== "object") s.daily = {};
      if (!s.perModule || typeof s.perModule !== "object") s.perModule = {};
      if (!s.perTask || typeof s.perTask !== "object") s.perTask = {};
      if (!s.goals || typeof s.goals !== "object") s.goals = { ...DEFAULT_GOALS };
      return s;
    }
  } catch (e) {}
  // daily: { "YYYY-MM-DD": sec } · perModule: { moduleId: sec } · perTask: { taskId: sec } · goals (hours)
  return { sessions: 0, daily: {}, perModule: {}, perTask: {}, goals: { ...DEFAULT_GOALS } };
}
function saveStats() { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); }

// Add studied seconds to today's tally (and to the selected module, if any).
function addStudySeconds(sec) {
  if (sec <= 0) return;
  const d = todayIso();
  const before = stats.daily[d] || 0;
  stats.daily[d] = before + sec;
  if (pomoModuleId) stats.perModule[pomoModuleId] = (stats.perModule[pomoModuleId] || 0) + sec;
  if (pomoTaskId) { if (!stats.perTask) stats.perTask = {}; stats.perTask[pomoTaskId] = (stats.perTask[pomoTaskId] || 0) + sec; }
  saveStats();
  // Tagesziel erreicht? Einmal pro Tag feiern (Punkt 9).
  const goalSec = ((stats.goals && stats.goals.day) || DEFAULT_GOALS.day) * 3600;
  if (before < goalSec && stats.daily[d] >= goalSec) celebrateDailyGoal();
}

// Feiert das Erreichen des Tages-Lernziels (einmal täglich).
function celebrateDailyGoal() {
  let last = null;
  try { last = localStorage.getItem("study-tracker-goal-celebrated"); } catch (e) {}
  if (last === todayIso()) return;
  try { localStorage.setItem("study-tracker-goal-celebrated", todayIso()); } catch (e) {}
  showSnackbar("🎉 Tagesziel erreicht — stark! Weiter so.");
}

let pomoMode = "focus";
let pomoRemaining = pomoSeconds(pomoMode);
let pomoTimerId = null;
let pomoSessions = stats.sessions; // restored from storage
let pomoModuleId = "";             // optional: Modul, dem die Fokuszeit zugeordnet wird
let pomoTaskId = "";               // optional: konkrete Aufgabe im gewählten Modul
let pomoEndTime = null;            // absolute ms timestamp the period ends
let pomoLastTick = null;           // last wall-clock sample (for study accrual)
let studyCarry = 0;                // sub-second focus time carried between ticks

function pomoFormat(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function pomoRender() {
  document.getElementById("pomo-time").textContent = pomoFormat(pomoRemaining);
  document.getElementById("pomo-count").textContent = `Abgeschlossene Fokus-Einheiten: ${pomoSessions}`;
  document.getElementById("pomo-start").textContent = pomoTimerId ? "Pause" : "Start";
  document.querySelectorAll("[data-pomo-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.pomoMode === pomoMode);
  });
  document.title = pomoTimerId
    ? `${pomoFormat(pomoRemaining)} · ${POMO_LABELS[pomoMode]} — Studien-Tracker`
    : "Studien-Tracker";
}

function pomoStop() {
  if (pomoTimerId) { clearInterval(pomoTimerId); pomoTimerId = null; }
  pomoEndTime = null;
  pomoLastTick = null;
  studyCarry = 0;
}

// One timer tick. Driven by the real clock (Date.now), so background-tab
// throttling never slows the countdown — we recompute from timestamps.
function pomoTick() {
  const now = Date.now();

  // Accrue focus study-time from the real elapsed interval (handles throttling
  // and tabs waking up after being suspended).
  if (pomoMode === "focus" && pomoLastTick != null) {
    studyCarry += (now - pomoLastTick) / 1000;
    const whole = Math.floor(studyCarry);
    if (whole > 0) {
      // Don't count time past the period end.
      const remainingToEnd = Math.max(0, Math.ceil((pomoEndTime - pomoLastTick) / 1000));
      const credited = Math.min(whole, remainingToEnd);
      if (credited > 0) { addStudySeconds(credited); renderStudyToday(); }
      studyCarry -= whole;
    }
  }
  pomoLastTick = now;

  pomoRemaining = Math.max(0, Math.round((pomoEndTime - now) / 1000));

  if (pomoRemaining <= 0) {
    pomoStop();
    if (pomoMode === "focus") { pomoSessions++; stats.sessions = pomoSessions; saveStats(); }
    renderStudyStats();
    pomoRender();
    try { // gentle beep; ignored if the browser blocks audio
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      osc.connect(ctx.destination);
      osc.frequency.value = 660;
      osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); }, 450);
    } catch (e) {}
    alert(`${POMO_LABELS[pomoMode]} beendet!`);
    pomoSetMode(pomoMode === "focus" ? "short" : "focus");
    return;
  }
  pomoRender();
}

function pomoStart() {
  if (pomoTimerId) { pomoStop(); pomoRender(); return; }  // toggle -> pause
  pomoEndTime = Date.now() + pomoRemaining * 1000;
  pomoLastTick = Date.now();
  studyCarry = 0;
  pomoTimerId = setInterval(pomoTick, 250); // sub-second cadence keeps it smooth
  pomoRender();
}

function pomoSetMode(mode) {
  pomoMode = mode;
  pomoStop();
  pomoEndTime = null;
  pomoLastTick = null;
  studyCarry = 0;
  pomoRemaining = pomoSeconds(mode);
  pomoRender();
}

// When a throttled/suspended tab becomes visible again, resync immediately
// instead of waiting for the next slow tick.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pomoTimerId) pomoTick();
});

document.getElementById("pomo-start").addEventListener("click", pomoStart);
document.getElementById("pomo-reset").addEventListener("click", () => {
  pomoStop();
  pomoRemaining = pomoSeconds(pomoMode);
  pomoRender();
});

// Keep the timer accurate while the tab is in the background: alarm fallback.
// (Primary accuracy comes from timestamp math in pomoTick.)
document.querySelectorAll("[data-pomo-mode]").forEach((b) => {
  b.addEventListener("click", () => pomoSetMode(b.dataset.pomoMode));
});

/* ----- Study-time stats: daily / weekly / monthly / yearly bars ----- */
// Sum studied seconds whose date (YYYY-MM-DD) passes the predicate.
function sumStudy(pred) {
  let total = 0;
  for (const [date, sec] of Object.entries(stats.daily)) {
    if (pred(date)) total += sec;
  }
  return total;
}

// The study-time bars are shown relative to a reference date you can cycle
// through. Day = that date; week/month/year = the periods containing it.
let statsRefDate = todayIso();

function renderStudyToday() {
  // "Heute gelernt" reflects the real current day (live counter target).
  document.getElementById("study-today").textContent = formatDuration(stats.daily[todayIso()] || 0);
  renderStreak();
}

// Lern-Serie: aufeinanderfolgende Tage mit Lernzeit, bis einschließlich heute (Punkt 7).
function studyStreak() {
  let streak = 0;
  const d = new Date();
  // Heute zählt nur, wenn schon gelernt; sonst ab gestern rückwärts zählen.
  if (!(stats.daily[isoOf(d)] > 0)) d.setDate(d.getDate() - 1);
  for (let i = 0; i < 1000; i++) {
    if (stats.daily[isoOf(d)] > 0) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}
function renderStreak() {
  const el = document.getElementById("study-streak");
  if (!el) return;
  const s = studyStreak();
  el.textContent = s > 0 ? `🔥 ${s} ${s === 1 ? "Tag" : "Tage"} in Folge` : "Noch keine aktuelle Lern-Serie";
}

// Kurzes Label für den Bezugstag, z. B. "Heute" oder "12.11.2026".
function refDayLabel() {
  if (statsRefDate === todayIso()) return "Heute";
  return formatDate(statsRefDate);
}

function renderStudyStats() {
  renderStudyToday();

  const ref = new Date(statsRefDate + "T00:00:00");
  const refIso = statsRefDate;

  // Start of ISO week (Monday) containing the reference date.
  const weekStart = new Date(ref);
  const dow = (ref.getDay() + 6) % 7; // 0 = Monday
  weekStart.setDate(ref.getDate() - dow);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const weekStartIso = isoOf(weekStart);
  const weekEndIso = isoOf(weekEnd);

  const month = refIso.slice(0, 7);  // YYYY-MM
  const year = refIso.slice(0, 4);   // YYYY
  const monthName = MONTHS[ref.getMonth()];

  const daySec = stats.daily[refIso] || 0;
  const weekSec = sumStudy((d) => d >= weekStartIso && d <= weekEndIso);
  const monthSec = sumStudy((d) => d.startsWith(month));
  const yearSec = sumStudy((d) => d.startsWith(year));

  // Bar maxima come from the user's goals (hours). Caps at 100%.
  const g = stats.goals || DEFAULT_GOALS;
  const rows = [
    { label: "Tag", sub: refDayLabel(), sec: daySec, max: (g.day || DEFAULT_GOALS.day) * 3600, cls: "" },
    { label: "Woche", sub: `${formatDate(weekStartIso)} – ${formatDate(weekEndIso)}`, sec: weekSec, max: (g.week || DEFAULT_GOALS.week) * 3600, cls: "week" },
    { label: "Monat", sub: `${monthName} ${year}`, sec: monthSec, max: (g.month || DEFAULT_GOALS.month) * 3600, cls: "month" },
    { label: "Jahr", sub: year, sec: yearSec, max: (g.year || DEFAULT_GOALS.year) * 3600, cls: "year" },
  ];

  document.getElementById("stats-ref-label").textContent = refDayLabel();

  const wrap = document.getElementById("study-stats");
  wrap.innerHTML = rows.map((r) => {
    const pct = Math.min(100, Math.round((r.sec / r.max) * 100));
    return `
      <div class="stat-row">
        <div class="stat-label">
          <span>${r.label} <span class="stat-sub">${r.sub}</span></span>
          <span class="stat-hours">${formatDuration(r.sec)}</span>
        </div>
        <div class="stat-bar"><div class="stat-fill ${r.cls}" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");

  renderPerModuleStudy();
  if (typeof renderStudyChart === "function") renderStudyChart();
}

// Lernzeit je Modul (Punkt 6)
function renderPerModuleStudy() {
  const wrap = document.getElementById("study-per-module");
  if (!wrap) return;
  const entries = state.modules
    .map((m) => ({ m, sec: stats.perModule[m.id] || 0 }))
    .filter((x) => x.sec > 0)
    .sort((a, b) => b.sec - a.sec);
  if (!entries.length) {
    wrap.innerHTML = `<p class="empty-state">Noch keine modulbezogene Lernzeit. Wähle unten beim Timer ein Modul.</p>`;
    return;
  }
  const maxSec = entries[0].sec || 1;
  wrap.innerHTML = entries.map(({ m, sec }) => {
    const pct = Math.round((sec / maxSec) * 100);
    return `
      <div class="stat-row">
        <div class="stat-label"><span>${escapeHtml(m.name)}</span><span class="stat-hours">${formatDuration(sec)}</span></div>
        <div class="stat-bar"><div class="stat-fill month" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");
}

function shiftStatsDay(delta) {
  const d = new Date(statsRefDate + "T00:00:00");
  d.setDate(d.getDate() + delta);
  // Don't allow browsing into the future.
  if (isoOf(d) > todayIso()) return;
  statsRefDate = isoOf(d);
  renderStudyStats();
}

// Study-time day navigation
document.getElementById("stats-prev").addEventListener("click", () => shiftStatsDay(-1));
document.getElementById("stats-next").addEventListener("click", () => shiftStatsDay(1));
document.getElementById("stats-today").addEventListener("click", () => {
  statsRefDate = todayIso();
  renderStudyStats();
});

// Modul-Auswahl für den Timer füllen (Punkt 6).
// Nur Module „In Bearbeitung" (angeheftet & nicht abgeschlossen) — also genau die,
// die im Dashboard unter „Aktuell in Bearbeitung" erscheinen.
function fillPomoModuleSelect() {
  const sel = document.getElementById("pomo-module");
  if (!sel) return;
  const prev = pomoModuleId;
  const active = state.modules.filter((m) => m.pinned && !m.completed);
  const placeholder = active.length ? "Ohne Modulzuordnung" : "Kein Modul „In Bearbeitung“";
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    active.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  // Auswahl behalten, solange das Modul weiterhin „In Bearbeitung" ist.
  sel.value = active.some((m) => m.id === prev) ? prev : "";
  pomoModuleId = sel.value;
  fillPomoTaskSelect();
}
// Aufgaben-Dropdown passend zum gewählten Modul (Punkt 7). Nur offene Aufgaben,
// damit die Liste kurz bleibt. Verschwindet, wenn kein Modul gewählt ist.
function fillPomoTaskSelect() {
  const sel = document.getElementById("pomo-task");
  if (!sel) return;
  const mod = state.modules.find((m) => m.id === pomoModuleId);
  if (!mod) { sel.hidden = true; sel.innerHTML = `<option value="">Ganzes Modul</option>`; pomoTaskId = ""; return; }
  const open = mod.tasks.filter((t) => !t.done);
  if (!open.length) { sel.hidden = true; pomoTaskId = ""; return; }
  const prev = pomoTaskId;
  sel.hidden = false;
  sel.innerHTML = `<option value="">Ganzes Modul</option>` +
    open.map((t) => `<option value="${t.id}">${escapeHtml(t.text)}</option>`).join("");
  sel.value = open.some((t) => t.id === prev) ? prev : "";
  pomoTaskId = sel.value;
}
const pomoModuleSel = document.getElementById("pomo-module");
if (pomoModuleSel) {
  pomoModuleSel.addEventListener("change", (e) => { pomoModuleId = e.target.value; pomoTaskId = ""; fillPomoTaskSelect(); });
}
const pomoTaskSel = document.getElementById("pomo-task");
if (pomoTaskSel) {
  pomoTaskSel.addEventListener("change", (e) => { pomoTaskId = e.target.value; });
}

// Lernzeit-Ziele (Punkt 10)
function fillGoalInputs() {
  const g = stats.goals || DEFAULT_GOALS;
  const map = { "goal-day": g.day, "goal-week": g.week, "goal-month": g.month, "goal-year": g.year };
  Object.entries(map).forEach(([id, v]) => { const el = document.getElementById(id); if (el) el.value = v; });
}
const goalsForm = document.getElementById("goals-form");
if (goalsForm) {
  goalsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const num = (id, fb) => { const v = parseFloat(document.getElementById(id).value); return (!v || v <= 0) ? fb : v; };
    stats.goals = {
      day: num("goal-day", DEFAULT_GOALS.day),
      week: num("goal-week", DEFAULT_GOALS.week),
      month: num("goal-month", DEFAULT_GOALS.month),
      year: num("goal-year", DEFAULT_GOALS.year),
    };
    saveStats();
    fillGoalInputs();
    renderStudyStats();
    const el = document.getElementById("goals-status");
    if (el) el.textContent = "Ziele gespeichert.";
  });
}

// Studienziel (ECTS)
function fillEctsTarget() {
  const el = document.getElementById("ects-target");
  if (el) el.value = state.ectsTarget > 0 ? state.ectsTarget : "";
}

// Wochenraster-Einstellungen (Fenster + Standard-Dauer)
function fillWeekGridInputs() {
  const g = state.weekGrid || {};
  const s = document.getElementById("weekgrid-start");
  const e = document.getElementById("weekgrid-end");
  const d = document.getElementById("weekgrid-dur");
  if (s) s.value = g.startHour != null ? g.startHour : 8;
  if (e) e.value = g.endHour != null ? g.endHour : 21;
  if (d) d.value = g.defaultDurationMin != null ? g.defaultDurationMin : 60;
}
const weekGridForm = document.getElementById("weekgrid-form");
if (weekGridForm) {
  weekGridForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    let s = parseInt(document.getElementById("weekgrid-start").value, 10);
    let e = parseInt(document.getElementById("weekgrid-end").value, 10);
    let d = parseInt(document.getElementById("weekgrid-dur").value, 10);
    const status = document.getElementById("weekgrid-status");
    if (!(s >= 0 && s <= 23) || !(e >= 1 && e <= 24) || e <= s) {
      if (status) status.textContent = "Ungültiges Fenster — „Bis“ muss nach „Von“ liegen (0–24 Uhr).";
      return;
    }
    if (!(d >= 15 && d <= 480)) d = 60;
    state.weekGrid = { startHour: s, endHour: e, defaultDurationMin: d };
    saveState();
    fillWeekGridInputs();
    renderCalendar();
    if (status) status.textContent = `Gespeichert: ${String(s).padStart(2,"0")}–${String(e).padStart(2,"0")} Uhr, Standard ${d} Min.`;
  });
}
const ectsGoalForm = document.getElementById("ects-goal-form");
if (ectsGoalForm) {
  ectsGoalForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = parseInt(document.getElementById("ects-target").value, 10);
    state.ectsTarget = (!v || v <= 0) ? 0 : v;
    saveState();
    fillEctsTarget();
    renderDashboard();
    const el = document.getElementById("ects-goal-status");
    if (el) el.textContent = state.ectsTarget ? `Ziel gesetzt: ${state.ectsTarget} ECTS.` : "Kein ECTS-Ziel gesetzt.";
  });
}

// Modul-Suche + Semesterfilter (Punkte 7 & 6)
const moduleSearch = document.getElementById("module-search");
if (moduleSearch) {
  moduleSearch.addEventListener("input", (e) => { moduleFilter = e.target.value; renderModules(); });
}
const semesterFilterSel = document.getElementById("semester-filter");
if (semesterFilterSel) {
  semesterFilterSel.addEventListener("change", (e) => { semesterFilter = e.target.value; renderModules(); });
}

// Theme-Umschalter (Punkt 9)
document.querySelectorAll("[data-theme-btn]").forEach((b) => {
  b.addEventListener("click", () => setTheme(b.dataset.themeBtn));
});

/* ----- Lernzeit-Verlauf als SVG-Balkendiagramm (Punkt 2) ----- */
function renderStudyChart() {
  const wrap = document.getElementById("study-chart");
  if (!wrap) return;
  const days = 14;
  const today = new Date();
  const data = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const iso = isoOf(d);
    data.push({ iso, sec: stats.daily[iso] || 0, dow: d.getDay(), dom: d.getDate() });
  }
  const maxSec = Math.max(1, ...data.map((x) => x.sec));
  const W = 320, H = 120, pad = 18, bw = (W - pad * 2) / days;
  const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  let bars = "";
  data.forEach((x, i) => {
    const h = Math.round((x.sec / maxSec) * (H - pad * 2));
    const bx = pad + i * bw, by = H - pad - h;
    const fill = x.sec > 0 ? "var(--accent)" : "var(--surface-2)";
    bars += `<rect x="${bx + 2}" y="${by}" width="${bw - 4}" height="${Math.max(h, 2)}" rx="2" fill="${fill}">
      <title>${formatDate(x.iso)}: ${formatDuration(x.sec)}</title></rect>`;
    if (i % 2 === 0) bars += `<text x="${bx + bw / 2}" y="${H - 5}" text-anchor="middle" class="chart-label">${x.dom}.</text>`;
  });
  const total = data.reduce((a, x) => a + x.sec, 0);
  wrap.innerHTML = total === 0
    ? `<p class="empty-state">Noch keine Lernzeit in den letzten 14 Tagen.</p>`
    : `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Lernzeit der letzten 14 Tage">${bars}</svg>
       <p class="muted" style="text-align:center;margin-top:6px;">Gesamt: ${formatDuration(total)} in 14 Tagen</p>`;
  renderStudyHeatmap();
}

// Baut die Wochen-Spalten (Mo-first) für eine Jahres-Heatmap der Lernzeit.
// Reine Funktion → testbar. Gibt { weeks:[[{iso,sec,empty}]], maxSec } zurück.
// `daily` = { "YYYY-MM-DD": sekunden }, `todayIso` = heutiger Tag, `days` = Fenster.
function buildHeatmap(daily, todayStr, days) {
  const span = days || 365;
  const today = new Date(todayStr + "T00:00:00");
  const start = new Date(today); start.setDate(start.getDate() - (span - 1));
  // Auf Wochenbeginn (Montag) zurückrücken, damit die erste Spalte voll ist.
  const startOff = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - startOff);
  const weeks = [];
  let cur = [];
  let maxSec = 0;
  const d = new Date(start);
  while (d <= today) {
    const iso = isoOf(d);
    const inRange = new Date(iso + "T00:00:00") >= new Date(todayStr + "T00:00:00") || true; // alle bis heute
    const sec = daily[iso] || 0;
    if (sec > maxSec) maxSec = sec;
    cur.push({ iso, sec, dow: (d.getDay() + 6) % 7 });
    if ((d.getDay() + 6) % 7 === 6) { weeks.push(cur); cur = []; }
    d.setDate(d.getDate() + 1);
    void inRange;
  }
  if (cur.length) weeks.push(cur);
  return { weeks, maxSec };
}

// Jahres-Heatmap (GitHub-Stil): ein Feld pro Tag, Farbintensität = Lernzeit.
function renderStudyHeatmap() {
  const wrap = document.getElementById("study-heatmap");
  if (!wrap) return;
  const { weeks, maxSec } = buildHeatmap(stats.daily || {}, todayIso(), 365);
  if (maxSec === 0) { wrap.innerHTML = `<p class="empty-state">Noch keine Lernzeit im letzten Jahr.</p>`; return; }
  // 4 Intensitätsstufen relativ zum Maximum.
  const level = (sec) => {
    if (!sec) return 0;
    const r = sec / maxSec;
    return r > 0.66 ? 4 : r > 0.33 ? 3 : r > 0 ? 2 : 1;
  };
  const cells = weeks.map((wk) => {
    const col = wk.map((day) =>
      `<div class="hm-cell hm-l${level(day.sec)}" title="${formatDate(day.iso)}: ${formatDuration(day.sec)}"></div>`
    ).join("");
    return `<div class="hm-col">${col}</div>`;
  }).join("");
  const totalSec = Object.values(stats.daily || {}).reduce((a, s) => a + (Number(s) || 0), 0);
  wrap.innerHTML =
    `<div class="hm-grid" role="img" aria-label="Lernzeit-Heatmap des letzten Jahres">${cells}</div>
     <div class="hm-legend"><span class="muted">weniger</span>
       <span class="hm-cell hm-l0"></span><span class="hm-cell hm-l1"></span><span class="hm-cell hm-l2"></span><span class="hm-cell hm-l3"></span><span class="hm-cell hm-l4"></span>
       <span class="muted">mehr</span></div>`;
}

/* Hinweis: gradeForecast() und gradeRange() bleiben erhalten — sie werden
   für die Druck-/Papierversion (buildPrintView) weiterhin verwendet. Die
   frühere Prognose-UI in den Einstellungen wurde entfernt. */

/* ----- ICS-Export (Punkt 3) ----- */
const icsBtn = document.getElementById("ics-btn");
if (icsBtn) {
  icsBtn.addEventListener("click", () => {
    const blob = new Blob([buildIcs()], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `studien-tracker-kalender-${todayIso()}.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });
}

/* ----- ICS-Import: Termine aus einem Uni-/Fremdkalender einlesen ----- */
const icsImportEl = document.getElementById("ics-import-file");
if (icsImportEl) {
  icsImportEl.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseIcs(reader.result);
        if (!parsed.length) { setStatus("Keine Termine in der .ics-Datei gefunden.", true); return; }
        let added = 0;
        parsed.forEach((p) => {
          state.events.push({
            id: uid(), date: p.date, startTime: p.startTime || null, endTime: p.endTime || null,
            title: p.title || "(ohne Titel)", type: "other",
            repeat: p.repeat || null, repeatUntil: p.repeatUntil || null, color: null,
          });
          added++;
        });
        saveState();
        renderCalendar();
        renderDashboard();
        setStatus(`${added} Termin(e) aus der .ics-Datei importiert.`);
        showSnackbar(`${added} Termin(e) importiert.`);
      } catch (err) {
        setStatus("Import fehlgeschlagen: Datei konnte nicht gelesen werden.", true);
      } finally {
        e.target.value = ""; // erneuter Import derselben Datei möglich
      }
    };
    reader.onerror = () => setStatus("Datei konnte nicht gelesen werden.", true);
    reader.readAsText(file);
  });
}

/* ----- Druck-/PDF-Ansicht: Papierversion aus den Live-Daten (Punkt 9) -----
   Erzeugt eine mehrteilige, im App-Look gestaltete Übersicht:
   Semesterübersicht + Noten (ECTS-gewichtet, Prognose) + Fortschritt +
   Lernzeit & Lern-Serie. Passend zu den Druckvorlagen im Ordner print/. */
function moduleStatusLabel(m) {
  if (m.completed) return "Abgeschlossen";
  if (m.pinned) return "In Bearbeitung";
  return "Demnächst";
}
function printProgressBar(pct) {
  return `<span class="pv-bar"><span style="width:${Math.max(0, Math.min(100, pct || 0))}%"></span></span>`;
}
// Druckbarer Wochenplan der aktuell gewählten Woche: eine Zeile je Tag mit den
// chronologisch sortierten Posten (Von–Bis-Zeit, Titel, Typ). Tabelle statt
// Pixelraster, damit es zuverlässig druckt.
function buildPrintWeek() {
  const base = selectedDate || todayIso();
  const start = mondayOf(base);
  const WD = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  let rows = "";
  let any = false;
  for (let i = 0; i < 7; i++) {
    const d = new Date(start + "T00:00:00"); d.setDate(d.getDate() + i);
    const iso = isoOf(d);
    const posts = [];
    eventsOnDate(iso).forEach((e) => posts.push({ t: e.startTime, text: e.title, type: typeLabel(e.type), s: e.startTime, e: e.endTime }));
    tasksOnDate(iso).forEach(({ module, task }) => posts.push({ t: task.startTime, text: `${task.text} · ${module.name}`, type: "Aufgabe", s: task.startTime, e: task.endTime }));
    posts.sort((a, b) => (a.t || "99:99").localeCompare(b.t || "99:99"));
    if (posts.length) any = true;
    const cells = posts.length
      ? posts.map((p) => {
          const tr = timeRange(p.s, p.e);
          return `<div class="pv-wk-item"><span class="pv-wk-time">${tr || "—"}</span> ${escapeHtml(p.text)} <span class="pv-wk-type">(${p.type})</span></div>`;
        }).join("")
      : `<span class="pv-meta">—</span>`;
    rows += `<tr><td class="pv-wk-day">${WD[i]}<br><span class="pv-meta">${d.getDate()}.${d.getMonth() + 1}.</span></td><td>${cells}</td></tr>`;
  }
  if (!any) return ""; // leere Woche → Abschnitt weglassen
  const sD = new Date(start + "T00:00:00");
  const eD = new Date(start + "T00:00:00"); eD.setDate(eD.getDate() + 6);
  const fmt = (x) => `${x.getDate()}.${x.getMonth() + 1}.`;
  return `<h2>Wochenplan ${fmt(sD)} – ${fmt(eD)}</h2>
    <table class="pv-table pv-week"><tbody>${rows}</tbody></table>`;
}

// Druckbarer Monatsüberblick (der aktuell im Kalender gewählte Monat) als
// 7-Spalten-Raster mit kompakten Tageszellen. Zeigt Titel der Posten (gekürzt).
function buildPrintMonth() {
  const y = (typeof calYear === "number") ? calYear : new Date().getFullYear();
  const mo = (typeof calMonth === "number") ? calMonth : new Date().getMonth();
  const first = new Date(y, mo, 1);
  const startOff = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const WD = ["Mo","Di","Mi","Do","Fr","Sa","So"];
  let cells = "";
  for (let i = 0; i < startOff; i++) cells += `<td class="pv-mo-empty"></td>`;
  let col = startOff;
  let any = false;
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${y}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const posts = [];
    eventsOnDate(iso).forEach((e) => posts.push(e.title));
    tasksOnDate(iso).forEach(({ module, task }) => posts.push(task.text));
    if (posts.length) any = true;
    const items = posts.slice(0, 3).map((p) => `<div class="pv-mo-item">${escapeHtml(p)}</div>`).join("")
      + (posts.length > 3 ? `<div class="pv-mo-more">+${posts.length - 3}</div>` : "");
    cells += `<td class="pv-mo-cell"><span class="pv-mo-num">${day}</span>${items}</td>`;
    col++;
    if (col === 7) { col = 0; cells = cells; } // Zeilen bildet die Tabelle via colgroup-freier Umbruch
  }
  if (!any) return "";
  // In 7er-Zeilen gruppieren.
  // (Wir bauen die <tr> aus den gesammelten <td> neu, 7 pro Reihe.)
  const tmp = document.createElement("tbody");
  tmp.innerHTML = cells;
  const tds = Array.from(tmp.children);
  let rows = "";
  for (let i = 0; i < tds.length; i += 7) {
    rows += "<tr>" + tds.slice(i, i + 7).map((td) => td.outerHTML).join("") + "</tr>";
  }
  const MONTHS_L = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
  return `<h2>Monatsüberblick ${MONTHS_L[mo]} ${y}</h2>
    <table class="pv-table pv-month"><thead><tr>${WD.map((w) => `<th>${w}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function buildPrintView() {
  const pv = document.getElementById("print-view");
  if (!pv) return;

  const gpa = computeGpa();
  const totalEcts = state.modules.reduce((a, m) => a + (m.ects || 0), 0);
  const doneEcts = state.modules.filter((m) => m.completed).reduce((a, m) => a + (m.ects || 0), 0);
  const overallPct = totalEcts > 0 ? Math.round((doneEcts / totalEcts) * 100)
    : (state.modules.length ? Math.round(state.modules.filter((m) => m.completed).length / state.modules.length * 100) : 0);
  const range = (typeof gradeRange === "function") ? gradeRange() : null;
  const streak = (typeof studyStreak === "function") ? studyStreak() : 0;
  const totalStudySec = Object.values(stats.daily || {}).reduce((a, s) => a + (Number(s) || 0), 0);
  const studyDays = Object.values(stats.daily || {}).filter((s) => Number(s) > 0).length;

  let html = `
    <div class="pv-head">
      <div class="pv-title"><small>🎓 Studien-Tracker</small>Meine Studienübersicht</div>
      <div class="pv-head-meta">Stand: ${formatDate(todayIso())}</div>
    </div>
    <div class="pv-cards">
      <div class="pv-card"><div class="pv-card-num">${overallPct}%</div><div class="pv-card-lbl">Fortschritt</div></div>
      <div class="pv-card"><div class="pv-card-num">${gpa ? commaNum(gpa.value, 2) : "—"}</div><div class="pv-card-lbl">Ø Note</div></div>
      <div class="pv-card"><div class="pv-card-num">${doneEcts}/${totalEcts || "—"}</div><div class="pv-card-lbl">ECTS</div></div>
      <div class="pv-card"><div class="pv-card-num">${streak}</div><div class="pv-card-lbl">Tage Serie</div></div>
    </div>`;

  // Module nach Semester gruppiert
  const groups = {};
  state.modules.forEach((m) => { const key = m.semester || "Ohne Semester"; (groups[key] = groups[key] || []).push(m); });
  const keys = Object.keys(groups).sort((a, b) => (a === "Ohne Semester") - (b === "Ohne Semester") || a.localeCompare(b));
  keys.forEach((k) => {
    html += `<h2>${escapeHtml(k)}</h2>
      <table class="pv-table"><thead><tr><th>Modul</th><th>ECTS</th><th>Note</th><th>Status</th><th>Fortschritt</th></tr></thead><tbody>`;
    groups[k].forEach((m) => {
      const g = (m.gradeComponents && m.gradeComponents.length) ? computeComponentGrade(m) : m.grade;
      html += `<tr>
        <td>${escapeHtml(m.name)}</td>
        <td class="pv-c">${m.ects || "—"}</td>
        <td class="pv-c">${typeof g === "number" ? commaNum(g) : "—"}</td>
        <td>${moduleStatusLabel(m)}</td>
        <td>${printProgressBar(moduleProgress(m))}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  });

  // Noten-Prognose
  if (range) {
    html += `<h2>Noten-Prognose</h2>
      <table class="pv-table"><tbody>
        <tr><td>Noch offene ECTS</td><td class="pv-c">${range.openEcts}</td></tr>
        <tr><td>Bester möglicher Endschnitt</td><td class="pv-c">${commaNum(range.best, 2)}</td></tr>
        <tr><td>Schlechtester Endschnitt (noch bestanden)</td><td class="pv-c">${commaNum(range.worst, 2)}</td></tr>
      </tbody></table>`;
  }

  // Monatsüberblick + Wochenplan — druckfreundliche Tabellen.
  html += buildPrintMonth();
  html += buildPrintWeek();

  // Lernzeit & Serie
  html += `<h2>Lernzeit &amp; Lern-Serie</h2>
    <table class="pv-table"><tbody>
      <tr><td>Lernzeit gesamt</td><td class="pv-c">${formatDuration(totalStudySec)}</td></tr>
      <tr><td>Lerntage gesamt</td><td class="pv-c">${studyDays}</td></tr>
      <tr><td>Aktuelle Lern-Serie</td><td class="pv-c">${streak} ${streak === 1 ? "Tag" : "Tage"}</td></tr>
      <tr><td>Abgeschlossene Fokus-Einheiten</td><td class="pv-c">${stats.sessions || 0}</td></tr>
    </tbody></table>`;

  // Lernzeit je Modul (nur Module mit erfasster Zeit)
  const perMod = state.modules
    .map((m) => ({ name: m.name, sec: (stats.perModule && stats.perModule[m.id]) || 0 }))
    .filter((x) => x.sec > 0)
    .sort((a, b) => b.sec - a.sec);
  if (perMod.length) {
    html += `<table class="pv-table"><thead><tr><th>Modul</th><th>Lernzeit</th></tr></thead><tbody>`;
    perMod.forEach((x) => { html += `<tr><td>${escapeHtml(x.name)}</td><td class="pv-c">${formatDuration(x.sec)}</td></tr>`; });
    html += `</tbody></table>`;
  }

  if (!state.modules.length) {
    html += `<p class="pv-meta">Noch keine Module angelegt — lege welche an, dann erscheinen sie hier.</p>`;
  }

  pv.innerHTML = html;
}
const printBtn = document.getElementById("print-btn");
if (printBtn) {
  printBtn.addEventListener("click", () => { buildPrintView(); window.print(); });
}


/* ============================================================
   ERINNERUNGEN / BENACHRICHTIGUNGEN (Punkt 8)
   Browser-Benachrichtigungen für heute anstehende Prüfungen/Abgaben.
   ============================================================ */
const NOTIFY_KEY = "study-tracker-notified"; // merkt, was heute schon gemeldet wurde
function notifiedToday() {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTIFY_KEY) || "{}");
    return raw.date === todayIso() ? (raw.ids || []) : [];
  } catch (e) { return []; }
}
function markNotified(ids) {
  localStorage.setItem(NOTIFY_KEY, JSON.stringify({ date: todayIso(), ids }));
}
function updateNotifyButton() {
  const btn = document.getElementById("notify-btn");
  if (!btn) return;
  if (!("Notification" in window)) {
    btn.textContent = "Von diesem Browser nicht unterstützt";
    btn.disabled = true;
    return;
  }
  const p = Notification.permission;
  btn.textContent = p === "granted" ? "✓ Erinnerungen aktiv"
    : p === "denied" ? "Im Browser blockiert" : "Erinnerungen aktivieren";
  btn.disabled = (p === "denied");
}
function checkReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const today = todayIso();
  const already = notifiedToday();
  const due = [];
  state.events.forEach((e) => {
    if ((e.type === "exam" || e.type === "deadline") && eventOccursOn(e, today) && !already.includes(e.id)) {
      due.push(e);
    }
  });
  if (!due.length) return;
  due.forEach((e) => {
    const tr = timeRange(e.startTime, e.endTime);
    const when = tr ? ` um ${tr} Uhr` : "";
    showAppNotification(`Heute: ${typeLabel(e.type)}`, `${e.title}${when}`, e.id);
  });
  markNotified(already.concat(due.map((e) => e.id)));
}

// Benachrichtigung bevorzugt über den Service Worker ausgeben
// (registration.showNotification), weil `new Notification()` auf vielen mobilen
// Browsern nicht funktioniert. Fällt auf `new Notification()` zurück, wenn kein
// SW verfügbar ist. Die SW-Notification ist klickbar und öffnet die App.
function showAppNotification(title, body, tag) {
  const opts = { body, tag, icon: "icon-192.png", badge: "icon-192.png", data: { url: "./" } };
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready
        .then((reg) => reg.showNotification(title, opts))
        .catch(() => { try { new Notification(title, opts); } catch (e) {} });
      return;
    }
  } catch (e) {}
  try { new Notification(title, opts); } catch (e) {}
}
const notifyBtn = document.getElementById("notify-btn");
if (notifyBtn) {
  notifyBtn.addEventListener("click", () => {
    if (!("Notification" in window)) return;
    Notification.requestPermission().then(() => { updateNotifyButton(); checkReminders(); });
  });
}

// Erinnerungen auch dann ausliefern, wenn die App länger offen bleibt (z. B. über
// einen Tageswechsel): beim Zurückkehren in den Tab und stündlich prüfen.
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkReminders(); });
setInterval(() => { checkReminders(); }, 60 * 60 * 1000);

// Custom-duration settings form
function pomoFillSettings() {
  document.getElementById("dur-focus").value = pomoMinutes.focus;
  document.getElementById("dur-short").value = pomoMinutes.short;
  document.getElementById("dur-long").value = pomoMinutes.long;
}
document.getElementById("pomo-settings").addEventListener("submit", (e) => {
  e.preventDefault();
  pomoMinutes = {
    focus: clampMin(document.getElementById("dur-focus").value, POMO_DEFAULTS.focus),
    short: clampMin(document.getElementById("dur-short").value, POMO_DEFAULTS.short),
    long: clampMin(document.getElementById("dur-long").value, POMO_DEFAULTS.long),
  };
  savePomoMinutes();
  pomoFillSettings();          // reflect any clamped values
  pomoStop();
  pomoRemaining = pomoSeconds(pomoMode); // apply to the current mode immediately
  pomoRender();
  const el = document.getElementById("pomo-status");
  el.textContent = `Gespeichert — Fokus ${pomoMinutes.focus} Min., kurze Pause ${pomoMinutes.short} Min., lange Pause ${pomoMinutes.long} Min.`;
});

/* ============================================================
   SNACKBAR mit „Rückgängig“ (Punkt 3)
   ============================================================ */
let snackTimer = null;
// Zeigt eine Meldung; optional mit Rückgängig-Aktion und automatischer Ausführung
// der „commit“-Aktion, falls nicht rückgängig gemacht.
function showSnackbar(message, undoFn) {
  const bar = document.getElementById("snackbar");
  if (!bar) { if (undoFn) {/* nichts zu tun */} return; }
  clearTimeout(snackTimer);
  bar.innerHTML = `<span>${escapeHtml(message)}</span>`;
  // Mit Rückgängig-Aktion länger stehen lassen, damit Tastatur-/Screenreader-
  // Nutzer die Schaltfläche erreichen, bevor sie verschwindet.
  let hideAfter = 6000;
  if (undoFn) {
    hideAfter = 10000;
    const btn = document.createElement("button");
    btn.className = "snack-undo";
    btn.type = "button";
    btn.textContent = "Rückgängig";
    btn.addEventListener("click", () => {
      clearTimeout(snackTimer);
      bar.classList.remove("show");
      undoFn();
    });
    bar.appendChild(btn);
    // Fokus auf die Aktion legen, sobald die Snackbar sichtbar ist.
    requestAnimationFrame(() => { try { btn.focus(); } catch (e) {} });
  }
  bar.classList.add("show");
  snackTimer = setTimeout(() => bar.classList.remove("show"), hideAfter);
}

/* ---------- SVG-Icons (Punkt 1) — einheitlich statt Emojis ---------- */
// Schlanke Inline-SVGs (currentColor), 1em groß, dekorativ (aria-hidden).
const ICONS = {
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/><path d="M10 11v6M14 11v6"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  upload: '<path d="M12 21V9m0 0 4 4m-4-4-4 4"/><path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  print: '<path d="M6 9V2h12v7"/><rect x="6" y="14" width="12" height="8"/><path d="M6 18H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2"/>',
  cap: '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1 2.7 3 6 3s6-2 6-3v-5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
};
function icon(name, cls) {
  const p = ICONS[name] || "";
  return `<svg class="ic ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/* ---------- Utilities ---------- */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Beispieldaten laden (Punkt 10 – Onboarding)
function loadSampleData() {
  const t = todayIso();
  const inDays = (n) => { const d = new Date(t + "T00:00:00"); d.setDate(d.getDate() + n); return isoOf(d); };
  state = migrate({
    modules: [
      { id: uid(), name: "Lineare Algebra", ects: 9, grade: null, targetGrade: 2.0, semester: "WS 2026/27", pinned: true, tasks: [
        { id: uid(), text: "Vorlesung 1 ansehen", done: true, url: "https://www.example.com/vorlesung-1", subtasks: [] },
        { id: uid(), text: "Vorlesung 2 ansehen", done: false, date: inDays(1), startTime: "10:00", endTime: "11:30", url: "https://www.example.com/vorlesung-2", subtasks: [] },
        { id: uid(), text: "Übungsblatt 2", done: false, date: inDays(2), subtasks: [
          { id: uid(), text: "Aufgabe 1", done: false }, { id: uid(), text: "Aufgabe 2", done: false } ] },
      ] },
      { id: uid(), name: "Programmierung", ects: 6, grade: 1.7, targetGrade: 2.0, semester: "WS 2026/27", completed: true, tasks: [] },
      { id: uid(), name: "Statistik", ects: 6, grade: null, targetGrade: 2.5, semester: "WS 2026/27", tasks: [
        { id: uid(), text: "Kapitel 1 lesen", done: false, date: inDays(-1), subtasks: [] } ] },
    ],
    events: [
      { id: uid(), date: inDays(7), startTime: "09:00", endTime: "11:00", title: "LA-Klausur", type: "exam", repeat: null, repeatUntil: null },
      { id: uid(), date: inDays(3), startTime: null, endTime: null, title: "Abgabe Übungsblatt", type: "deadline", repeat: null, repeatUntil: null },
    ],
  });
  saveState();
  renderAll();
  showSnackbar("Beispieldaten geladen. Zum Entfernen: Einstellungen → Alle Daten löschen.");
}

// Alles neu zeichnen (nach einem Sync, der den gesamten Zustand ersetzt).
function renderAll() {
  renderDashboard();
  renderCalendar();
  renderModules();
  renderStudyStats();
  pomoRender();
}

/* ============================================================
   GERÄTE-SYNC über Supabase (Punkt 1)
   - optional: ohne Login läuft alles rein lokal weiter
   - ein Dokument pro Nutzer (Tabelle app_state), JSON = kompletter Zustand
   - Konfliktstrategie: "zuletzt gespeichert gewinnt" via updatedAt
   ============================================================ */
let sb = null;            // Supabase-Client (oder null, wenn nicht konfiguriert)
let syncUser = null;      // angemeldeter Nutzer (oder null)
let syncUploadTimer = null;
let syncApplying = false;  // true, während Remote-Daten eingespielt werden (kein Re-Upload)

function syncConfigured() {
  const c = window.SUPABASE_CONFIG;
  return !!(c && c.url && c.anonKey &&
    c.url.indexOf("DEINE_") !== 0 && c.anonKey.indexOf("DEIN_") !== 0 &&
    window.supabase && typeof window.supabase.createClient === "function");
}

function setSyncStatus(msg) {
  const el = document.getElementById("sync-status");
  if (el) el.textContent = msg || "";
}

function renderSyncUI() {
  const out = document.getElementById("sync-logged-out");
  const inn = document.getElementById("sync-logged-in");
  if (!out || !inn) return;
  if (!syncConfigured()) {
    out.hidden = true; inn.hidden = true;
    setSyncStatus("Sync nicht eingerichtet. Trage deine Supabase-Daten in apps/shared/supabase-config.js ein (Anleitung im README).");
    return;
  }
  if (syncUser) {
    out.hidden = true; inn.hidden = false;
    const em = document.getElementById("sync-user-email");
    if (em) em.textContent = syncUser.email || "";
  } else {
    out.hidden = false; inn.hidden = true;
  }
  renderConnBadge();
}

// Online/Offline-Anzeige (Punkt 3)
function renderConnBadge() {
  const el = document.getElementById("conn-badge");
  if (!el) return;
  const online = navigator.onLine !== false;
  el.className = "conn-badge " + (online ? "online" : "offline");
  el.textContent = online
    ? (syncUser ? "● Online · Sync aktiv" : "● Online")
    : "● Offline · Änderungen werden lokal gespeichert";
}
window.addEventListener("online", () => { renderConnBadge(); if (syncUser) pullAndMerge(); });
window.addEventListener("offline", renderConnBadge);

// Zustand als reines Datenpaket (ohne Laufzeit-Krempel) für den Upload.
function syncPayload() {
  return { ...state, _stats: stats, _pomodoro: pomoMinutes, updatedAt: state.updatedAt || Date.now() };
}

// Remote-Daten in die App übernehmen (ersetzt den lokalen Zustand komplett).
function applyRemote(doc) {
  if (!doc || typeof doc !== "object") return;
  syncApplying = true;
  try {
    state = migrate(doc);
    saveStateLocalOnly();
    if (doc._stats && typeof doc._stats === "object") {
      const ps = doc._stats;
      stats = {
        sessions: Number(ps.sessions) || 0,
        daily: (ps.daily && typeof ps.daily === "object") ? ps.daily : {},
        perModule: (ps.perModule && typeof ps.perModule === "object") ? ps.perModule : {},
        goals: (ps.goals && typeof ps.goals === "object") ? { ...DEFAULT_GOALS, ...ps.goals } : { ...DEFAULT_GOALS },
      };
      pomoSessions = stats.sessions;
      saveStats();
    }
    if (doc._pomodoro && typeof doc._pomodoro === "object") {
      pomoMinutes = {
        focus: clampMin(doc._pomodoro.focus, POMO_DEFAULTS.focus),
        short: clampMin(doc._pomodoro.short, POMO_DEFAULTS.short),
        long: clampMin(doc._pomodoro.long, POMO_DEFAULTS.long),
      };
      savePomoMinutes();
      pomoFillSettings();
    }
    fillGoalInputs();
    fillEctsTarget();
    fillWeekGridInputs();
    fillRadioSettings();
    renderRadioPlayer();
    renderAll();
  } finally {
    syncApplying = false;
  }
}

// Nur lokal speichern, ohne erneuten Sync-Upload auszulösen.
function saveStateLocalOnly() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
}

// Erst nach dem ersten erfolgreichen Abgleich (pullAndMerge) nach dem Login
// darf hochgeladen werden. Sonst könnte ein frisch gebootetes, LEERES Gerät
// durch ein beiläufiges saveState() beim Start seinen leeren Stand hochladen,
// BEVOR der Pull die Serverdaten holt — und so die vollen Daten überschreiben.
let initialPullDone = false;

// Debounced Upload nach jeder Änderung.
function scheduleSyncUpload() {
  if (!sb || !syncUser || syncApplying || !initialPullDone) return;
  clearTimeout(syncUploadTimer);
  syncUploadTimer = setTimeout(uploadState, 1200);
}

async function uploadState() {
  if (!sb || !syncUser) return;
  try {
    setSyncStatus("Synchronisiere …");
    const { error } = await sb.from("app_state").upsert({
      user_id: syncUser.id,
      data: syncPayload(),
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    setSyncStatus("Zuletzt synchronisiert: " + new Date().toLocaleTimeString("de-DE"));
  } catch (e) {
    setSyncStatus("Sync-Fehler: " + (e.message || e));
  }
}

// Remote laden und bei Bedarf einspielen (neuere Daten gewinnen), sonst hochladen.
// Merkt den zuletzt gesehenen Remote-Stand, um echte Konflikte zu erkennen.
let lastSyncedRemoteTs = 0;
const SYNC_BACKUP_KEY = "study-tracker-sync-backup";

// Sicherungs-Snapshot des aktuellen lokalen Stands, bevor Remote überschreibt (Punkt 2).
function backupBeforeOverwrite() {
  try {
    localStorage.setItem(SYNC_BACKUP_KEY, JSON.stringify({
      at: Date.now(), data: syncPayload(),
    }));
  } catch (e) {}
}

// Reine Entscheidungslogik des Sync-Abgleichs (ohne Netz/DOM), damit sie
// isoliert testbar ist. Liefert, WAS zu tun ist — pullAndMerge führt es aus.
//
// WICHTIG: Substanz schlägt Zeitstempel. Ein frisch gebootetes, LEERES Gerät
// bekommt beim ersten saveState() einen sehr aktuellen updatedAt-Zeitstempel,
// obwohl es keine echten Daten hat. Würde nur „neuer gewinnt" gelten, könnte
// dieses leere Gerät die vollen Serverdaten überschreiben (Datenverlust beim
// Anmelden auf einem neuen Gerät). Darum zuerst die Datenlage prüfen:
//   remote hat Daten, lokal leer      → "apply"  (Daten holen, nie leer hochladen)
//   lokal hat Daten, remote leer      → "upload" (vollen Stand behalten)
//   beide leer / Server leer          → "upload"
// Erst wenn BEIDE Seiten Daten haben, zählen die Zeitstempel:
//   remoteTs <= localTs               → "upload"   (lokal ist aktuell/neuer)
//   remoteTs  > localTs, kein Lokal-Edit, schon mal gesynct → "apply"
//   sonst (Lokal-Edit ODER Erstabgleich mit Daten beidseits) → "conflict"
function syncDecision(localTs, remoteTs, lastSyncedRemoteTs, hasRemote, localHasData, remoteHasData) {
  if (!hasRemote || !remoteHasData) return "upload"; // Server leer/ohne Daten → lokal hochladen
  if (!localHasData) return "apply";                  // lokal leer, Remote hat Daten → immer übernehmen
  // Ab hier: beide Seiten haben echte Daten.
  if (!(remoteTs > localTs)) return "upload";
  const localChangedSinceSync = localTs > lastSyncedRemoteTs && lastSyncedRemoteTs > 0;
  const firstSyncWithData = lastSyncedRemoteTs === 0; // Erstabgleich → sicherheitshalber fragen
  return (localChangedSinceSync || firstSyncWithData) ? "conflict" : "apply";
}

// Hat ein Zustand echten Nutzerinhalt? (Module oder Termine). Lernzeit/Pomodoro
// zählen bewusst NICHT — sie allein sollen keinen leeren Stand „voll" erscheinen
// lassen und so den Schutz gegen Überschreiben aushebeln.
function stateHasData(s) {
  if (!s || typeof s !== "object") return false;
  const mods = Array.isArray(s.modules) ? s.modules.length : 0;
  const evs = Array.isArray(s.events) ? s.events.length : 0;
  return (mods + evs) > 0;
}

let syncInFlight = false;
async function pullAndMerge() {
  if (!sb || !syncUser || syncInFlight) return; // kein paralleler Abgleich (sonst doppelte Konflikt-Dialoge)
  syncInFlight = true;
  try {
    setSyncStatus("Lade Daten …");
    const { data, error } = await sb.from("app_state").select("data, updated_at").eq("user_id", syncUser.id).maybeSingle();
    if (error) throw error;
    const localTs = state.updatedAt || 0;
    const hasRemote = !!(data && data.data);
    const remote = hasRemote ? data.data : null;
    const remoteTs = hasRemote ? (remote.updatedAt || new Date(data.updated_at).getTime() || 0) : 0;
    const localHasData = stateHasData(state);
    const remoteHasData = stateHasData(remote);

    const decision = syncDecision(localTs, remoteTs, lastSyncedRemoteTs, hasRemote, localHasData, remoteHasData);

    if (decision === "conflict") {
      backupBeforeOverwrite();
      const countOf = (s) => {
        const m = (s && Array.isArray(s.modules)) ? s.modules.length : 0;
        const e = (s && Array.isArray(s.events)) ? s.events.length : 0;
        return `${m} Module, ${e} Termine`;
      };
      const ok = confirm(
        "Konflikt erkannt: lokaler Stand und Server-Stand unterscheiden sich.\n\n" +
        `• Server:  ${countOf(remote)}\n` +
        `• Dieses Gerät:  ${countOf(state)}\n\n` +
        "• OK: Server-Stand übernehmen (dein lokaler Stand wird als Sicherung behalten).\n" +
        "• Abbrechen: deinen lokalen Stand behalten und hochladen."
      );
      if (ok) { applyRemote(remote); lastSyncedRemoteTs = remoteTs; setSyncStatus("Server-Stand übernommen · lokale Sicherung erstellt."); }
      else { await uploadState(); lastSyncedRemoteTs = state.updatedAt || Date.now(); setSyncStatus("Lokalen Stand behalten und hochgeladen."); }
    } else if (decision === "apply") {
      backupBeforeOverwrite();
      applyRemote(remote);
      lastSyncedRemoteTs = remoteTs;
      setSyncStatus("Aktualisiert vom Server (neuere Daten übernommen).");
    } else { // "upload"
      await uploadState();
      lastSyncedRemoteTs = state.updatedAt || Date.now();
    }
    initialPullDone = true; // ab jetzt sind Uploads sicher
  } catch (e) {
    setSyncStatus("Sync-Fehler: " + (e.message || e));
  } finally {
    syncInFlight = false;
  }
}

// Lokale Sicherung (vor letztem Überschreiben) wiederherstellen.
function restoreSyncBackup() {
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(SYNC_BACKUP_KEY) || "null"); } catch (e) {}
  if (!snap || !snap.data) { setSyncStatus("Keine Sicherung vorhanden."); return; }
  if (!confirm(`Lokale Sicherung vom ${new Date(snap.at).toLocaleString("de-DE")} wiederherstellen? Der aktuelle Stand wird ersetzt.`)) return;
  applyRemote(snap.data);
  saveState(); // als neuesten Stand markieren → wird beim nächsten Sync hochgeladen
  setSyncStatus("Lokale Sicherung wiederhergestellt.");
}

async function initSync() {
  renderSyncUI();
  if (!syncConfigured()) return;
  try {
    sb = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);
  } catch (e) {
    setSyncStatus("Sync-Client konnte nicht gestartet werden: " + (e.message || e));
    return;
  }

  // Bestehende Sitzung (z. B. nach Magic-Link-Rückkehr) prüfen.
  try {
    const { data } = await sb.auth.getSession();
    syncUser = data && data.session ? data.session.user : null;
  } catch (e) {}
  renderSyncUI();
  if (syncUser) { pullAndMerge(); }

  // Auf Login/Logout reagieren (auch nach Klick auf den E-Mail-Link).
  sb.auth.onAuthStateChange((_event, session) => {
    syncUser = session ? session.user : null;
    renderSyncUI();
    if (syncUser) pullAndMerge();
  });

  // Beim Zurückkehren in den Tab erneut abgleichen (einfacher "Realtime"-Ersatz).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && syncUser) pullAndMerge();
  });
}

// Login per Magic Link
/* ============================================================
   FOKUS-RADIO (kompakter Player im Pomodoro)
   Spielt einen hinterlegten Internet-Radio-Stream per <audio>. Stream-URL &
   Lautstärke stehen in state.radio (synct mit). Keine Hintergrund-Wiedergabe
   auf iOS bei gesperrtem Bildschirm — das kann eine Web-App nicht leisten.
   ============================================================ */
// Vorschläge: nur Sender mit (nach bestem Wissen) stabilem Direkt-Stream.
// Lofi-Streams wechseln oft ihre Endpunkte → besser eigene URL eintragen.
const RADIO_PRESETS = [
  { label: "Deutschlandfunk", url: "https://st01.sslstream.dlf.de/dlf/01/128/mp3/stream.mp3" },
  { label: "Lofi (laut.fm)", url: "https://stream.laut.fm/lofi" },
];
function fillRadioSettings() {
  const presetSel = document.getElementById("radio-preset");
  const urlInput = document.getElementById("radio-url");
  if (presetSel) {
    presetSel.innerHTML = `<option value="">— eigene URL —</option>` +
      RADIO_PRESETS.map((p) => `<option value="${escapeHtml(p.url)}">${escapeHtml(p.label)}</option>`).join("");
    const cur = (state.radio && state.radio.url) || "";
    presetSel.value = RADIO_PRESETS.some((p) => p.url === cur) ? cur : "";
  }
  if (urlInput) urlInput.value = (state.radio && state.radio.url) || "";
}
const radioPresetSel = document.getElementById("radio-preset");
if (radioPresetSel) radioPresetSel.addEventListener("change", (e) => {
  const u = e.target.value;
  const urlInput = document.getElementById("radio-url");
  if (u && urlInput) urlInput.value = u;
});
const radioForm = document.getElementById("radio-form");
if (radioForm) radioForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = document.getElementById("radio-url").value;
  const clean = sanitizeUrl(raw);
  const status = document.getElementById("radio-status");
  if (raw.trim() && !clean) { if (status) status.textContent = "Ungültige Stream-URL — bitte eine gültige http(s)-Adresse."; return; }
  const presetSel = document.getElementById("radio-preset");
  const label = (presetSel && presetSel.selectedOptions[0] && presetSel.value) ? presetSel.selectedOptions[0].textContent : "";
  state.radio = { url: clean || "", label, volume: (state.radio && state.radio.volume) || 0.6 };
  saveState();
  renderRadioPlayer();
  if (status) status.textContent = clean ? "Gespeichert." : "Kein Sender gesetzt.";
});
const radioClearBtn = document.getElementById("radio-clear");
if (radioClearBtn) radioClearBtn.addEventListener("click", () => {
  state.radio = { url: "", label: "", volume: (state.radio && state.radio.volume) || 0.6 };
  saveState();
  const u = document.getElementById("radio-url"); if (u) u.value = "";
  const p = document.getElementById("radio-preset"); if (p) p.value = "";
  renderRadioPlayer();
  const status = document.getElementById("radio-status"); if (status) status.textContent = "Sender entfernt.";
});

// Player im Pomodoro aufbauen/aktualisieren.
function renderRadioPlayer() {
  const box = document.getElementById("radio-player");
  const audio = document.getElementById("radio-audio");
  const label = document.getElementById("radio-label");
  const vol = document.getElementById("radio-volume");
  if (!box || !audio) return;
  const url = (state.radio && state.radio.url) || "";
  if (!url) { box.hidden = true; audio.pause(); audio.removeAttribute("src"); return; }
  box.hidden = false;
  if (label) label.textContent = (state.radio && state.radio.label) || "Fokus-Radio";
  if (vol) { vol.value = (state.radio && state.radio.volume) != null ? state.radio.volume : 0.6; audio.volume = Number(vol.value); }
  // Quelle nur neu setzen, wenn sie sich geändert hat (sonst stoppt die Wiedergabe).
  if (audio.dataset.src !== url) { audio.src = url; audio.dataset.src = url; }
}
const radioToggle = document.getElementById("radio-toggle");
const radioAudio = document.getElementById("radio-audio");
if (radioToggle && radioAudio) {
  radioToggle.addEventListener("click", () => {
    if (radioAudio.paused) {
      radioAudio.play().then(() => { radioToggle.textContent = "⏸"; radioToggle.title = "Pause"; })
        .catch(() => { const s = document.getElementById("radio-status"); showSnackbar("Stream konnte nicht gestartet werden (URL erreichbar?)."); });
    } else {
      radioAudio.pause(); radioToggle.textContent = "▶"; radioToggle.title = "Wiedergabe";
    }
  });
  radioAudio.addEventListener("pause", () => { radioToggle.textContent = "▶"; });
  radioAudio.addEventListener("play", () => { radioToggle.textContent = "⏸"; });
}
const radioVol = document.getElementById("radio-volume");
if (radioVol && radioAudio) {
  radioVol.addEventListener("input", (e) => {
    const v = Number(e.target.value);
    radioAudio.volume = v;
    if (state.radio) { state.radio.volume = v; saveState(); }
  });
}

// Login per E-Mail + Passwort (primär — kein Mail-Zugriff nötig).
const syncPwForm = document.getElementById("sync-pw-form");
if (syncPwForm) {
  // „Anmelden" (bestehendes Konto).
  syncPwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!syncConfigured()) { renderSyncUI(); return; }
    const email = document.getElementById("sync-email").value.trim();
    const password = document.getElementById("sync-password").value;
    if (!email || !password) return;
    const btn = syncPwForm.querySelector("button[type=submit]");
    try {
      if (btn) btn.disabled = true;
      setSyncStatus("Anmeldung läuft …");
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      // onAuthStateChange übernimmt renderSyncUI + pullAndMerge.
    } catch (e2) {
      const msg = (e2 && (e2.message || e2.error_description)) || String(e2);
      if (/invalid login|invalid_credentials|credentials/i.test(msg)) {
        setSyncStatus("E-Mail oder Passwort falsch. Noch kein Konto? Auf „Registrieren“ tippen.");
      } else {
        setSyncStatus("Anmeldung fehlgeschlagen: " + msg);
      }
    } finally {
      if (btn) setTimeout(() => { btn.disabled = false; }, 1500);
    }
  });
  // „Registrieren" (neues Konto mit Passwort anlegen).
  const regBtn = document.getElementById("sync-register-btn");
  if (regBtn) regBtn.addEventListener("click", async () => {
    if (!syncConfigured()) { renderSyncUI(); return; }
    const email = document.getElementById("sync-email").value.trim();
    const password = document.getElementById("sync-password").value;
    if (!email || !password) { setSyncStatus("Bitte E-Mail und ein Passwort (min. 6 Zeichen) eingeben."); return; }
    if (password.length < 6) { setSyncStatus("Das Passwort muss mindestens 6 Zeichen haben."); return; }
    try {
      regBtn.disabled = true;
      setSyncStatus("Konto wird erstellt …");
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      // Je nach Supabase-Einstellung: sofort angemeldet ODER Bestätigungsmail nötig.
      if (data && data.session) {
        setSyncStatus("Konto erstellt und angemeldet.");
      } else {
        setSyncStatus("Konto erstellt. Falls eine Bestätigungsmail kommt: einmal bestätigen, danach meldest du dich künftig direkt mit E-Mail + Passwort an.");
      }
    } catch (e2) {
      const msg = (e2 && (e2.message || e2.error_description)) || String(e2);
      if (/already registered|already exists|user_already/i.test(msg)) {
        setSyncStatus("Für diese E-Mail gibt es schon ein Konto — bitte einfach „Anmelden“.");
      } else {
        setSyncStatus("Registrierung fehlgeschlagen: " + msg);
      }
    } finally {
      setTimeout(() => { regBtn.disabled = false; }, 1500);
    }
  });
}

// Login per Magic Link (Alternative).
const syncLoginForm = document.getElementById("sync-login-form");
let loginCooldownUntil = 0; // verhindert zu häufiges Anfordern (Rate-Limit vorbeugen)
if (syncLoginForm) {
  syncLoginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!syncConfigured()) { renderSyncUI(); return; }
    const email = document.getElementById("sync-magic-email").value.trim();
    if (!email) return;

    // Lokale Sperre: höchstens alle 60 s einen Link anfordern.
    const now = Date.now();
    if (now < loginCooldownUntil) {
      const secs = Math.ceil((loginCooldownUntil - now) / 1000);
      setSyncStatus(`Bitte kurz warten (${secs} s), bevor du erneut einen Link anforderst.`);
      return;
    }

    const btn = syncLoginForm.querySelector("button[type=submit]");
    try {
      if (btn) btn.disabled = true;
      setSyncStatus("Sende Anmeldelink …");
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.href.split("#")[0] },
      });
      if (error) throw error;
      loginCooldownUntil = Date.now() + 60000;
      setSyncStatus("Anmeldelink gesendet. Prüfe deine E-Mails (auch Spam) und öffne den Link auf diesem Gerät. Der Link kann 1–2 Minuten brauchen.");
    } catch (e2) {
      const msg = (e2 && (e2.message || e2.error_description)) || String(e2);
      if (/rate limit|rate_limit|too many/i.test(msg)) {
        loginCooldownUntil = Date.now() + 120000;
        setSyncStatus("E-Mail-Limit erreicht: Supabase hat in kurzer Zeit zu viele Anmelde-Mails verschickt. Warte ca. 1 Stunde und fordere dann erneut einen Link an — oder nutze in Supabase einen eigenen E-Mail-Dienst (SMTP). Falls bereits eine Mail kam, öffne einfach deren Link.");
      } else {
        setSyncStatus("Konnte Link nicht senden: " + msg);
      }
    } finally {
      if (btn) setTimeout(() => { btn.disabled = false; }, 2000);
    }
  });
}
const syncNowBtn = document.getElementById("sync-now-btn");
if (syncNowBtn) syncNowBtn.addEventListener("click", () => pullAndMerge());
const syncRestoreBtn = document.getElementById("sync-restore-btn");
if (syncRestoreBtn) syncRestoreBtn.addEventListener("click", () => restoreSyncBackup());
const syncLogoutBtn = document.getElementById("sync-logout-btn");
if (syncLogoutBtn) {
  syncLogoutBtn.addEventListener("click", async () => {
    if (!sb) return;
    await sb.auth.signOut();
    syncUser = null;
    initialPullDone = false;   // nächster Login muss erst wieder pullen
    lastSyncedRemoteTs = 0;
    renderSyncUI();
    setSyncStatus("Abgemeldet. Die App läuft weiterhin lokal.");
  });
}

/* ============================================================
   FEHLER-LOGGING (Punkt 12, leichtgewichtig & ohne externen Dienst)
   Fängt unerwartete Fehler, zeigt einen Hinweis und speichert die
   letzten Einträge lokal (Einstellungen zeigt sie optional an).
   ============================================================ */
const ERRLOG_KEY = "study-tracker-errors";
function logError(kind, msg, extra) {
  try {
    const log = JSON.parse(localStorage.getItem(ERRLOG_KEY) || "[]");
    log.unshift({ at: new Date().toISOString(), kind, msg: String(msg).slice(0, 300), extra: extra ? String(extra).slice(0, 300) : null });
    localStorage.setItem(ERRLOG_KEY, JSON.stringify(log.slice(0, 20))); // nur die letzten 20
  } catch (e) {}
}
window.addEventListener("error", (e) => {
  logError("error", e.message, e.filename + ":" + e.lineno);
  if (typeof showSnackbar === "function") showSnackbar("Ein unerwarteter Fehler ist aufgetreten (lokal protokolliert).");
});
window.addEventListener("unhandledrejection", (e) => {
  logError("promise", (e.reason && e.reason.message) || e.reason);
});
// Button in den Einstellungen zum Ansehen/Leeren des Fehlerprotokolls.
const errShowBtn = document.getElementById("err-show-btn");
if (errShowBtn) {
  errShowBtn.addEventListener("click", () => {
    const box = document.getElementById("err-log");
    if (!box) return;
    let log = [];
    try { log = JSON.parse(localStorage.getItem(ERRLOG_KEY) || "[]"); } catch (e) {}
    box.hidden = false;
    box.textContent = log.length
      ? log.map((l) => `${new Date(l.at).toLocaleString("de-DE")} — [${l.kind}] ${l.msg}`).join("\n")
      : "Keine Fehler protokolliert. 🎉";
  });
}
const errClearBtn = document.getElementById("err-clear-btn");
if (errClearBtn) {
  errClearBtn.addEventListener("click", () => {
    try { localStorage.removeItem(ERRLOG_KEY); } catch (e) {}
    const box = document.getElementById("err-log");
    if (box) { box.hidden = false; box.textContent = "Fehlerprotokoll geleert."; }
  });
}

/* ============================================================
   PWA-UPDATE-HINWEIS (Punkt 5)
   Von der SW-Registrierung in index.html aufgerufen.
   ============================================================ */
/* ============================================================
   TASTENKÜRZEL (Punkt 6) — nur am Desktop sinnvoll
   N = neues Modul · / = Suche · 1–5 = Tabs wechseln
   ============================================================ */
const TAB_ORDER = ["dashboard", "calendar", "modules", "pomodoro", "settings"];
function switchTab(name) {
  const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (btn) btn.click();
}
document.addEventListener("keydown", (e) => {
  // In Eingabefeldern keine Kürzel abfangen
  const t = e.target;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (typing) {
    if (e.key === "Escape") t.blur();
    return;
  }
  if (e.key >= "1" && e.key <= "5") { switchTab(TAB_ORDER[Number(e.key) - 1]); }
  else if (e.key.toLowerCase() === "n") { switchTab("modules"); const el = document.getElementById("module-name"); if (el) { e.preventDefault(); el.focus(); } }
  else if (e.key === "/") { switchTab("modules"); const el = document.getElementById("module-search"); if (el) { e.preventDefault(); el.focus(); } }
});

/* ============================================================
   ANSTEHEND — zusammengeführte Agenda (ersetzt „Diese Woche“ + „Demnächst“)
   Teil 1: die nächsten 7 Tage im Detail (Events + geplante Aufgaben).
   Teil 2: eine kompakte Vorschau auf spätere Termine, damit nichts
           Fernes (z. B. eine Prüfung in 3 Wochen) verloren geht.
   ============================================================ */
function renderAgenda() {
  const wrap = document.getElementById("week-agenda");
  if (!wrap) return;
  const today = todayIso();
  const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const fmtWhen = (iso, time) => {
    const dt = new Date(iso + "T00:00:00");
    return `${WD[dt.getDay()]} ${dt.getDate()}.${dt.getMonth() + 1}.` + (time ? ` ${time}` : "");
  };
  const row = (iso, time, kind, text, cls) =>
    `<li class="agenda-item${cls || ""}">
      <span class="agenda-when">${fmtWhen(iso, time)}</span>
      <span class="agenda-tag tag ${kind}">${typeLabel(kind)}</span>
      <span class="agenda-text">${escapeHtml(text)}</span>
    </li>`;

  // Teil 1: nächste 7 Tage
  const week = [];
  const horizon = new Date(today + "T00:00:00"); horizon.setDate(horizon.getDate() + 6);
  const horizonIso = isoOf(horizon);
  let d = new Date(today + "T00:00:00");
  for (let i = 0; i < 7; i++) {
    const iso = isoOf(d);
    eventsOnDate(iso).forEach((e) => {
      // Die vom Countdown gezeigte Prüfung hier NICHT doppeln.
      if (countdownShownExam && e.id === countdownShownExam.id && iso === countdownShownExam.date) return;
      week.push({ iso, time: e.startTime, kind: e.type, text: e.title });
    });
    tasksOnDate(iso).forEach(({ module, task }) => {
      // Heute geplante Aufgaben stehen bereits in „Fokus heute" → hier auslassen.
      if (iso === today) return;
      if (!task.done) week.push({ iso, time: task.startTime, kind: "task", text: `${task.text} · ${module.name}` });
    });
    d.setDate(d.getDate() + 1);
  }
  week.sort((a, b) => (a.iso + (a.time || "99:99")).localeCompare(b.iso + (b.time || "99:99")));

  // Teil 2: spätere Termine (> 7 Tage). Tag nach dem Wochen-Horizont als Startpunkt.
  const afterHorizon = new Date(horizon); afterHorizon.setDate(afterHorizon.getDate() + 1);
  const afterHorizonIso = isoOf(afterHorizon);
  const later = [];
  state.events.forEach((e) => {
    const date = nextOccurrence(e, afterHorizonIso);
    if (date && date > horizonIso) later.push({ e, date });
  });
  state.modules.forEach((m) => m.tasks.forEach((t) => {
    if (t.date && !t.done && t.date > horizonIso) later.push({ e: { type: "task", title: `${t.text} · ${m.name}`, startTime: t.startTime }, date: t.date });
  }));
  later.sort((a, b) => (a.date + (a.e.startTime || "99:99")).localeCompare(b.date + (b.e.startTime || "99:99")));
  const laterTop = later.slice(0, 5);

  let html = "";
  if (!week.length && !laterTop.length) {
    wrap.innerHTML = `<p class="empty-state">Nichts geplant. 🌤️</p>`;
    return;
  }
  if (week.length) {
    html += `<li class="agenda-section">Diese Woche</li>`;
    html += week.map((it) => row(it.iso, it.time, it.kind, it.text, it.iso === today ? " agenda-today" : "")).join("");
  }
  if (laterTop.length) {
    html += `<li class="agenda-section">Später</li>`;
    html += laterTop.map(({ e, date }) => row(date, e.startTime, e.type, e.title)).join("");
  }
  wrap.innerHTML = html;
}

/* ---------- Boot ---------- */
setTheme(loadTheme());       // Theme anwenden (Punkt 9)
initCalendarState();
fillPomoModuleSelect();      // Modul-Auswahl beim Timer (Punkt 6)
fillGoalInputs();            // Lernzeit-Ziele (Punkt 10)
fillEctsTarget();            // Studienziel (ECTS)
fillWeekGridInputs();        // Wochenraster-Einstellungen
fillRadioSettings();         // Fokus-Radio (Einstellungen)
renderRadioPlayer();         // Fokus-Radio (Player im Pomodoro)
fillCreateSemester();        // Semester-Dropdown im „Modul hinzufügen“-Formular
fillEntryModuleSelect();     // Modul-Auswahl im vereinheitlichten Hinzufügen-Formular
updateEntryFormMode();       // Felder je nach Art (Aufgabe/Prüfung) ein-/ausblenden
renderDashboard();
renderModules();             // damit Suche/Picker initial stimmen
pomoFillSettings();
pomoRender();
renderStudyStats();
renderStudyChart();          // Lernzeit-Verlauf (Punkt 2)
updateNotifyButton();        // Status des Erinnerungs-Buttons (Punkt 8)
checkReminders();            // heute fällige Prüfungen/Abgaben melden
initSync();                  // Geräte-Sync initialisieren (Punkt 1)

/* ============================================================
   TEST-EXPORT (nur unter Node) — kein Build, kein Effekt im Browser.
   Erlaubt den automatisierten Tests, DIE ECHTE Logik zu importieren,
   statt sie zu spiegeln (verhindert Drift zwischen Test und App).
   ============================================================ */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    taskCompletion, moduleProgress, overallProgress, computeGpa,
    isPassingGrade, formatDuration, escapeHtml, sanitizeUrl, sanitizeHexColor,
    migrate, SCHEMA_VERSION, syncDecision, gradesBySemester, dayMatchesQuery,
    parseIcs, buildIcs, ectsProgress, easterSunday,
    germanHolidays, holidayName, normalizeTime, timeRange, minutesOfTime,
    itemSpan, layoutOverlaps, makeTask, buildHeatmap, nextModuleDue, dueStatusAt,
  };
}

})(); // Ende IIFE
