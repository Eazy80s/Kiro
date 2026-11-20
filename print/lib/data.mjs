/* ============================================================
   Parst einen Studien-Tracker JSON-Export in eine bequeme Form
   für die Druckvorlagen. Alle Berechnungen (Fortschritt, GPA,
   Teilnoten, Prognose, Streak) spiegeln app.js wider.
   ============================================================ */

export const TYPE_LABELS = { exam: "Prüfung", deadline: "Abgabe", lecture: "Vorlesung", other: "Sonstiges", task: "Aufgabe" };
export const REPEAT_LABELS = { daily: "täglich", weekly: "wöchentlich", biweekly: "14-täglich", monthly: "monatlich" };
export const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

export function commaNum(n, digits = 1) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(digits).replace(".", ",");
}
export function isPassing(g) { return typeof g === "number" && g <= 4.0; }

export function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysBetween(aIso, bIso) {
  return Math.round((new Date(bIso + "T00:00:00") - new Date(aIso + "T00:00:00")) / 86400000);
}
export function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

/* ---- Einzel-Berechnungen (aus app.js) ---- */
function taskCompletion(t) {
  if (t.subtasks && t.subtasks.length) return t.subtasks.filter((s) => s.done).length / t.subtasks.length;
  return t.done ? 1 : 0;
}
export function moduleProgress(m) {
  if (m.completed) return 100;
  if (!m.tasks || !m.tasks.length) return 0;
  const sum = m.tasks.reduce((a, t) => a + taskCompletion(t), 0);
  return Math.round((sum / m.tasks.length) * 100);
}
export function computeComponentGrade(m) {
  if (!m.gradeComponents || !m.gradeComponents.length) return null;
  const valid = m.gradeComponents.filter((c) => typeof c.grade === "number" && (c.weight || 0) > 0);
  if (!valid.length) return null;
  const wsum = valid.reduce((a, c) => a + c.weight, 0);
  if (wsum <= 0) return null;
  return valid.reduce((a, c) => a + c.grade * c.weight, 0) / wsum;
}

export function moduleStatus(m) {
  if (m.completed) return "Abgeschlossen";
  if (m.pinned) return "In Bearbeitung";
  return "Demnächst";
}

/* ---- Event-Expansion (Wiederholungen) ---- */
export function eventOccursOn(e, dateStr) {
  if (e.date === dateStr) return true;
  if (!e.repeat || dateStr < e.date) return false;
  if (e.repeatUntil && dateStr > e.repeatUntil) return false;
  const base = new Date(e.date + "T00:00:00");
  const d = new Date(dateStr + "T00:00:00");
  if (e.repeat === "daily") return true;
  if (e.repeat === "weekly") return base.getDay() === d.getDay();
  if (e.repeat === "biweekly") {
    if (base.getDay() !== d.getDay()) return false;
    return Math.round((d - base) / (7 * 86400000)) % 2 === 0;
  }
  if (e.repeat === "monthly") return base.getDate() === d.getDate();
  return false;
}

/* ============================================================
   Haupt-Parser: nimmt das rohe Export-JSON, liefert ein
   angereichertes Objekt für die Templates.
   ============================================================ */
export function parseExport(raw) {
  const modules = Array.isArray(raw.modules) ? raw.modules : [];
  const events = Array.isArray(raw.events) ? raw.events : [];
  const stats = raw._stats && typeof raw._stats === "object" ? raw._stats : { sessions: 0, daily: {}, perModule: {}, goals: {} };
  const pomodoro = raw._pomodoro && typeof raw._pomodoro === "object" ? raw._pomodoro : { focus: 25, short: 5, long: 15 };

  // Module anreichern
  const mods = modules.map((m) => {
    const derived = computeComponentGrade(m);
    const grade = (m.gradeComponents && m.gradeComponents.length && derived != null)
      ? Math.round(derived * 10) / 10 : m.grade;
    return {
      ...m,
      _grade: typeof grade === "number" ? grade : null,
      _progress: moduleProgress(m),
      _status: moduleStatus(m),
      _studySec: (stats.perModule && stats.perModule[m.id]) || 0,
    };
  });

  // GPA (ECTS-gewichtet)
  const graded = mods.filter((m) => typeof m._grade === "number");
  const gpaEcts = graded.reduce((a, m) => a + (m.ects || 0), 0);
  let gpa = null;
  if (graded.length) {
    gpa = gpaEcts > 0
      ? graded.reduce((a, m) => a + m._grade * (m.ects || 0), 0) / gpaEcts
      : graded.reduce((a, m) => a + m._grade, 0) / graded.length;
  }

  // Overall Fortschritt (abgeschlossene ECTS)
  const totalEcts = mods.reduce((a, m) => a + (m.ects || 0), 0);
  const doneEcts = mods.reduce((a, m) => a + (m.completed ? (m.ects || 0) : 0), 0);
  const overallPct = totalEcts > 0 ? Math.round((doneEcts / totalEcts) * 100)
    : (mods.length ? Math.round(mods.filter((m) => m.completed).length / mods.length * 100) : 0);

  // Best/Worst Prognose
  const withEcts = mods.filter((m) => (m.ects || 0) > 0);
  const sumGraded = withEcts.reduce((a, m) => a + (typeof m._grade === "number" ? m._grade * m.ects : 0), 0);
  const openEcts = withEcts.filter((m) => typeof m._grade !== "number").reduce((a, m) => a + m.ects, 0);
  const rangeTotal = withEcts.reduce((a, m) => a + m.ects, 0);
  const gradeRange = rangeTotal > 0 ? {
    best: (sumGraded + 1.0 * openEcts) / rangeTotal,
    worst: (sumGraded + 4.0 * openEcts) / rangeTotal,
    openEcts,
  } : null;

  // Prüfungs-Countdown: nächster exam-Event ab heute
  const today = todayIso();
  const upcoming = [];
  // Horizont: 180 Tage, um Serien aufzulösen
  for (let i = 0; i <= 180; i++) {
    const d = new Date(today + "T00:00:00");
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    events.forEach((e) => { if (eventOccursOn(e, iso)) upcoming.push({ ...e, _iso: iso }); });
  }
  const nextExam = upcoming.find((e) => e.type === "exam");
  const countdown = nextExam ? { title: nextExam.title, date: nextExam._iso, days: daysBetween(today, nextExam._iso) } : null;

  // Terminliste (sortiert, nächste 12)
  const upcomingList = upcoming
    .filter((e) => e.type !== "task")
    .sort((a, b) => (a._iso + (a.time || "")).localeCompare(b._iso + (b.time || "")))
    .slice(0, 20);

  // Aufgaben mit Datum (Fokus / fällig)
  const scheduledTasks = [];
  mods.forEach((m) => (m.tasks || []).forEach((t) => {
    if (t.date) scheduledTasks.push({ module: m.name, task: t.text, done: t.done, date: t.date });
  }));
  scheduledTasks.sort((a, b) => a.date.localeCompare(b.date));

  // Streak aus daily
  const daily = stats.daily || {};
  let streak = 0;
  {
    const d = new Date();
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    if (!(daily[iso(d)] > 0)) d.setDate(d.getDate() - 1);
    for (let i = 0; i < 1000; i++) {
      if (daily[iso(d)] > 0) { streak++; d.setDate(d.getDate() - 1); } else break;
    }
  }
  const totalStudySec = Object.values(daily).reduce((a, s) => a + (Number(s) || 0), 0);
  const studyDays = Object.values(daily).filter((s) => Number(s) > 0).length;

  return {
    raw, modules: mods, events,
    stats, pomodoro, daily,
    gpa, gpaWeighted: gpaEcts > 0, overallPct, totalEcts, doneEcts,
    gradeRange, countdown, upcomingList, scheduledTasks,
    streak, totalStudySec, studyDays,
    sessions: stats.sessions || 0,
    goals: stats.goals || { day: 8, week: 40, month: 160, year: 1000 },
    today,
  };
}

/* ---- Kalender: Wochen eines Monats (Montag-first), mit Events ---- */
export function monthMatrix(year, month /* 0-based */, events = []) {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const evs = events
      .filter((e) => eventOccursOn(e, iso))
      .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"))
      .map((e) => ({ type: e.type, label: (e.time ? e.time + " " : "") + e.title + (e.repeat ? " ↻" : "") }));
    cells.push({ day, iso, events: evs });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
