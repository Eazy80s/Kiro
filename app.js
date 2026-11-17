/* ============================================================
   Studien-Tracker — Daten im localStorage
   Datenmodell (v4):
     module:  { id, name, ects, grade, targetGrade, completed, pinned, collapsed, tasks:[task] }
     task:    { id, text, done, date, subtasks:[subtask] }
     subtask: { id, text, done }
     event:   { id, date, time, title, type, repeat }
   Separate Keys: Pomodoro-Zeiten, Lernstatistik (inkl. Ziele & Lernzeit je Modul), Theme.

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
const SCHEMA_VERSION = 4;

let state = loadState();

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
function migrate(data) {
  if (!data || typeof data !== "object") data = {};
  if (!Array.isArray(data.modules)) data.modules = [];
  if (!Array.isArray(data.events)) data.events = [];
  // Events gain an optional time ("HH:MM" or null) and recurrence rule.
  data.events.forEach((e) => {
    if (e.time === undefined) e.time = null;
    // repeat: null | "daily" | "weekly" | "monthly" (recurs from e.date forward)
    if (e.repeat === undefined) e.repeat = null;
  });
  data.modules.forEach((m) => {
    if (typeof m.ects !== "number") m.ects = Number(m.ects) || 0;
    if (m.grade === undefined) m.grade = null;
    if (m.targetGrade === undefined) m.targetGrade = null; // Wunschnote
    if (typeof m.completed !== "boolean") m.completed = false;
    if (typeof m.pinned !== "boolean") m.pinned = false;
    if (typeof m.collapsed !== "boolean") m.collapsed = false;
    if (!Array.isArray(m.tasks)) m.tasks = [];
    m.tasks.forEach((t) => {
      if (typeof t.done !== "boolean") t.done = false;
      if (typeof t.pinned !== "boolean") t.pinned = false;
      // Scheduled date (YYYY-MM-DD) or null. Drives Calendar + Today's Focus.
      if (t.date === undefined) t.date = null;
      if (!Array.isArray(t.subtasks)) t.subtasks = [];
      t.subtasks.forEach((s) => { if (typeof s.done !== "boolean") s.done = false; });
    });
  });
  data.schemaVersion = SCHEMA_VERSION;
  return data;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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

/* ---------- Recurrence ---------- */
// Does a (possibly recurring) event fall on dateStr? Base date is the first
// occurrence; weekly repeats on the same weekday, monthly on the same day-of-month.
function eventOccursOn(e, dateStr) {
  if (e.date === dateStr) return true;
  if (!e.repeat || dateStr < e.date) return false;
  const base = new Date(e.date + "T00:00:00");
  const d = new Date(dateStr + "T00:00:00");
  if (e.repeat === "daily") return true;
  if (e.repeat === "weekly") return base.getDay() === d.getDay();
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
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "dashboard") renderDashboard();
    if (btn.dataset.tab === "calendar") renderCalendar();
    if (btn.dataset.tab === "modules") renderModules();
    if (btn.dataset.tab === "pomodoro") renderStudyStats();
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
  renderCountdown();

  const { pct, weighted } = overallProgress();
  document.getElementById("overall-percent").textContent = pct + "%";
  document.getElementById("overall-bar").style.width = pct + "%";
  document.getElementById("overall-mode").textContent = weighted ? "(ECTS-gewichtet)" : "";

  const completedCount = state.modules.filter((m) => m.completed).length;
  document.getElementById("overall-summary").textContent = state.modules.length
    ? `${completedCount} von ${state.modules.length} Modul(en) abgeschlossen. (Fortschritt zählt nur abgeschlossene Module.)`
    : "Noch keine Module — füge im Tab „Module“ eins hinzu, um zu starten.";

  const gpa = computeGpa();
  document.getElementById("gpa-summary").textContent = gpa
    ? `Notendurchschnitt: ${gpa.value.toFixed(2).replace(".", ",")} (Skala 1,0–5,0${gpa.weighted ? ", ECTS-gewichtet" : ""}; aus ${gpa.count} benoteten Modul${gpa.count > 1 ? "en" : ""}).`
    : "Noch keine Noten erfasst.";

  renderPinnedModules();
  renderPinnedTasks();
  renderUpcoming();
}

function renderCountdown() {
  const card = document.getElementById("countdown-card");
  const today = todayIso();
  // Consider recurring exams too: use each event's next occurrence from today.
  let nextExam = null, nextExamDate = null;
  state.events.filter((e) => e.type === "exam").forEach((e) => {
    const occ = nextOccurrence(e, today);
    if (occ && (!nextExamDate || occ < nextExamDate || (occ === nextExamDate && (e.time || "99:99") < (nextExam.time || "99:99")))) {
      nextExam = e; nextExamDate = occ;
    }
  });

  if (!nextExam) {
    card.className = "countdown-card none";
    card.innerHTML = `<span>🎯 Keine anstehenden Prüfungen. Füge im Kalender eine hinzu.</span>`;
    return;
  }
  const days = daysBetween(today, nextExamDate);
  const label = days === 0 ? "Heute!" : days === 1 ? "1 Tag" : `${days} Tage`;
  const timePart = nextExam.time ? ` · ${formatTime(nextExam.time)} Uhr` : "";
  card.className = "countdown-card";
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
    const div = document.createElement("div");
    div.className = "module-progress-item";
    div.innerHTML = `
      <div class="progress-label">
        <span>${escapeHtml(m.name)} ${bits.length ? `<span class="meta">· ${bits.join(" · ")}</span>` : ""}</span>
        <span>${pct}%</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
    wrap.appendChild(div);
  });
}

function renderPinnedTasks() {
  const list = document.getElementById("pinned-tasks");
  list.innerHTML = "";

  // Today's Focus = tasks scheduled for today, grouped per module.
  const today = todayIso();
  const groups = state.modules
    .map((m) => ({ module: m, tasks: m.tasks.filter((t) => t.date === today) }))
    .filter((g) => g.tasks.length > 0);

  if (!groups.length) {
    list.innerHTML = `<p class="empty-state">Heute keine Aufgaben geplant. Gib einer Aufgabe in „Module“ ein Datum oder plane sie im Kalender.</p>`;
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

      li.innerHTML = `
        <div class="focus-main">
          <input type="checkbox" id="${cbId}" ${task.done ? "checked" : ""} />
          <span class="focus-text ${task.done ? "done" : ""}">${escapeHtml(task.text)}${subLabel}</span>
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

function renderUpcoming() {
  const list = document.getElementById("upcoming-events");
  list.innerHTML = "";
  const today = todayIso();
  // Expand to each event's next occurrence (handles recurring events).
  const upcoming = state.events
    .map((e) => ({ e, date: nextOccurrence(e, today) }))
    .filter((x) => x.date)
    .sort((a, b) => (a.date + (a.e.time || "99:99")).localeCompare(b.date + (b.e.time || "99:99")))
    .slice(0, 6);
  if (!upcoming.length) {
    list.innerHTML = `<p class="empty-state">Keine anstehenden Einträge.</p>`;
    return;
  }
  upcoming.forEach(({ e, date }) => {
    const li = document.createElement("li");
    const when = e.time ? `${formatDate(date)} · ${formatTime(e.time)} Uhr` : formatDate(date);
    const rep = e.repeat ? " ↻" : "";
    li.innerHTML = `
      <span>${escapeHtml(e.title)} <span class="tag ${e.type}">${typeLabel(e.type)}</span>${rep}</span>
      <span class="ev-date">${when}</span>`;
    list.appendChild(li);
  });
}

/* ============================================================
   CALENDAR
   ============================================================ */
let calYear, calMonth;        // currently viewed month
let selectedDate = null;      // YYYY-MM-DD currently selected day

function initCalendarState() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  if (!selectedDate) selectedDate = todayIso();
}

const MONTHS = ["Januar","Februar","März","April","Mai","Juni",
  "Juli","August","September","Oktober","November","Dezember"];

// German labels for event types (stored values stay English for compatibility).
const TYPE_LABELS = { exam: "Prüfung", deadline: "Abgabe", lecture: "Vorlesung", other: "Sonstiges", task: "Aufgabe" };
function typeLabel(t) { return TYPE_LABELS[t] || t; }

function renderCalendar() {
  if (calYear === undefined) initCalendarState();

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
    const cell = document.createElement("div");
    cell.className = "cal-cell"
      + (dateStr === today ? " today" : "")
      + (dateStr === selectedDate ? " selected" : "");
    cell.innerHTML = `<span class="day-num">${day}</span>`;

    // Calendar events on this day (incl. recurring), timed first, ordered by time
    const dayItems = [];
    eventsOnDate(dateStr)
      .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"))
      .forEach((e) => {
        const prefix = e.time ? `${formatTime(e.time)} ` : "";
        const rep = e.repeat ? " ↻" : "";
        dayItems.push({ type: e.type, label: `${prefix}${e.title}${rep}` });
      });
    // Scheduled module tasks on this day
    tasksOnDate(dateStr).forEach(({ module, task }) => {
      dayItems.push({ type: "task", label: `${task.text} · ${module.name}` });
    });
    dayItems.slice(0, 3).forEach((it) => {
      const ev = document.createElement("div");
      ev.className = `cal-event ${it.type}`;
      ev.textContent = it.label;
      ev.title = it.label;
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

function renderDayDetail() {
  const wrap = document.getElementById("day-detail");
  if (!selectedDate) { wrap.innerHTML = ""; return; }
  const dayEvents = eventsOnDate(selectedDate)
    .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99") || a.title.localeCompare(b.title));

  const dayTasks = tasksOnDate(selectedDate);

  let html = `<h3>${formatDate(selectedDate)}</h3>`;

  if (!dayEvents.length && !dayTasks.length) {
    html += `<p class="muted">Nichts geplant. Füge unten einen Kalendereintrag hinzu oder plane eine Modulaufgabe für diesen Tag.</p>`;
  }

  // Calendar events (recurring shown with a repeat note)
  const REPEAT_LABELS = { daily: "täglich", weekly: "wöchentlich", monthly: "monatlich" };
  dayEvents.forEach((e) => {
    const timePart = e.time ? `<span class="d-time">${formatTime(e.time)} Uhr</span> ` : "";
    const repPart = e.repeat ? ` <span class="repeat-badge">↻ ${REPEAT_LABELS[e.repeat] || ""}</span>` : "";
    const delTitle = e.repeat ? "Serie löschen" : "Löschen";
    html += `
      <div class="d-event">
        <span class="d-left"><span class="tag ${e.type}">${typeLabel(e.type)}</span> ${timePart}${escapeHtml(e.title)}${repPart}</span>
        <button class="del-btn" data-del-event="${e.id}" title="${delTitle}">✕</button>
      </div>`;
  });

  // Scheduled module tasks (planned work)
  dayTasks.forEach(({ module, task }) => {
    html += `
      <div class="d-event d-task">
        <span class="d-left">
          <input type="checkbox" data-task-done="${task.id}" ${task.done ? "checked" : ""} />
          <span class="tag task">Aufgabe</span>
          <span class="${task.done ? "done" : ""}">${escapeHtml(task.text)} <span class="muted-inline">· ${escapeHtml(module.name)}</span></span>
        </span>
        <button class="del-btn" data-unplan="${task.id}" title="Von diesem Tag entfernen">✕</button>
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
  document.getElementById("event-date").value = selectedDate;
}

// Find a task object anywhere in the modules by id.
function findTaskById(id) {
  for (const m of state.modules) {
    const t = m.tasks.find((x) => x.id === id);
    if (t) return t;
  }
  return null;
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

document.getElementById("prev-day").addEventListener("click", () => shiftDay(-1));
document.getElementById("next-day").addEventListener("click", () => shiftDay(1));
document.getElementById("prev-month").addEventListener("click", () => shiftMonth(-1));
document.getElementById("next-month").addEventListener("click", () => shiftMonth(1));
document.getElementById("today-btn").addEventListener("click", () => {
  selectedDate = todayIso();
  initCalendarState();
  calYear = new Date().getFullYear();
  calMonth = new Date().getMonth();
  renderCalendar();
});

document.getElementById("event-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const date = document.getElementById("event-date").value;
  const time = document.getElementById("event-time").value || null;
  const title = document.getElementById("event-title").value.trim();
  const type = document.getElementById("event-type").value;
  const repeat = document.getElementById("event-repeat").value || null;
  if (!date || !title) return;
  state.events.push({ id: uid(), date, time, title, type, repeat });
  saveState();
  selectedDate = date;
  const d = new Date(date + "T00:00:00");
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  document.getElementById("event-title").value = "";
  document.getElementById("event-time").value = "";
  document.getElementById("event-repeat").value = "";
  renderCalendar();
});

/* ============================================================
   MODULES & CHECKLISTS
   ============================================================ */
document.getElementById("module-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("module-name").value.trim();
  const ects = parseFloat(document.getElementById("module-ects").value) || 0;
  if (!name) return;
  state.modules.push({ id: uid(), name, ects, grade: null, completed: false, pinned: false, collapsed: false, tasks: [] });
  saveState();
  e.target.reset();
  renderModules();
});

let moduleFilter = ""; // Suchbegriff (Punkt 7)

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

function renderModules() {
  fillPomoModuleSelect(); // Modul-Auswahl beim Timer aktuell halten

  const wrap = document.getElementById("modules-list");
  wrap.innerHTML = "";

  if (!state.modules.length) {
    wrap.innerHTML = `<p class="empty-state">Noch keine Module. Füge oben dein erstes hinzu.</p>`;
    return;
  }

  const q = moduleFilter.trim().toLowerCase();
  const visible = state.modules.filter((m) => moduleMatchesFilter(m, q));

  if (!visible.length) {
    wrap.innerHTML = `<p class="empty-state">Keine Module passen zu „${escapeHtml(moduleFilter)}“.</p>`;
    return;
  }

  // Drei Bereiche: In Bearbeitung (angeheftet), Demnächst (Rest), Abgeschlossen.
  const ongoing = visible.filter((m) => m.pinned && !m.completed);
  const upcoming = visible.filter((m) => !m.pinned && !m.completed);
  const finished = visible.filter((m) => m.completed);

  const sections = [
    { title: "In Bearbeitung", hint: "Angeheftete Module, an denen du arbeitest", items: ongoing },
    { title: "Demnächst", hint: "Nicht begonnen / nicht angeheftet", items: upcoming },
    { title: "Abgeschlossen", hint: "Fertige Module", items: finished },
  ];

  sections.forEach((sec) => {
    if (!sec.items.length) return;
    const header = document.createElement("div");
    header.className = "module-section-head";
    header.innerHTML = `<span>${sec.title} <span class="section-count">${sec.items.length}</span></span><span class="section-hint">${sec.hint}</span>`;
    wrap.appendChild(header);
    sec.items.forEach((m) => wrap.appendChild(renderModuleCard(m)));
  });
}

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

function renderModuleCard(m) {
  const pct = moduleProgress(m);
  const done = m.tasks.filter((t) => t.done).length;
  const card = document.createElement("div");
  card.className = "module-card" + (m.completed ? " completed" : "") + (m.collapsed ? " collapsed" : "");

  card.innerHTML = `
    <div class="module-head">
      <h3>
        <button class="collapse-btn" data-collapse title="${m.collapsed ? "Ausklappen" : "Einklappen"}">${m.collapsed ? "▸" : "▾"}</button>
        ${escapeHtml(m.name)}
        ${m.ects ? `<span class="badge">${m.ects} ECTS</span>` : ""}
        ${m.completed ? `<span class="badge done">✓ fertig</span>` : ""}
      </h3>
      <div class="module-actions">
        <span class="pct">${done}/${m.tasks.length} · ${pct}%</span>
        <button class="pin-btn ${m.pinned ? "pinned" : ""}" data-pin-module title="Als „In Bearbeitung“ markieren (anheften)">📌</button>
        <button class="del-btn" data-del-module title="Modul löschen">🗑</button>
      </div>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="module-body">
      <div class="module-controls">
        <label><input type="checkbox" data-complete ${m.completed ? "checked" : ""}/> Abgeschlossen</label>
        <label>Note: <input type="number" class="grade-input" data-grade step="0.1" min="1" max="5" placeholder="—" value="${m.grade ?? ""}"/></label>
        <label>Wunschnote: <input type="number" class="grade-input" data-target step="0.1" min="1" max="5" placeholder="—" value="${m.targetGrade ?? ""}"/></label>
        <label>ECTS: <input type="number" class="grade-input" data-ects step="0.5" min="0" placeholder="0" value="${m.ects || ""}"/></label>
      </div>
      ${gradeHint(m)}
      <ul class="checklist"></ul>
      <form class="add-task-form"><input type="text" placeholder="Neuer Checklisten-Eintrag …" required /><button type="submit" class="primary-btn">Hinzufügen</button></form>
    </div>`;

  // Collapse/expand toggle
  card.querySelector("[data-collapse]").addEventListener("click", () => {
    m.collapsed = !m.collapsed; saveState(); renderModules();
  });

  // Checklist items (each as a block: the task row + date + subtasks)
  const ul = card.querySelector(".checklist");
  m.tasks.forEach((t) => {
    const li = document.createElement("li");
    li.className = "task-block";
    const cbId = `t-${t.id}`;
    const subDone = t.subtasks.filter((s) => s.done).length;
    const subLabel = t.subtasks.length ? ` (${subDone}/${t.subtasks.length})` : "";

    li.innerHTML = `
      <div class="task-row">
        <input type="checkbox" class="task-done" id="${cbId}" ${t.done ? "checked" : ""} />
        <label for="${cbId}" class="${t.done ? "done" : ""}">${escapeHtml(t.text)}<span class="muted-inline">${subLabel}</span></label>
        <input type="date" class="task-date" data-date value="${t.date || ""}" title="Aufgabe terminieren (erscheint im Kalender & im Fokus heute)" />
        <button class="del-btn" data-del-task title="Eintrag löschen">✕</button>
      </div>
      <ul class="subtask-list"></ul>
      <form class="add-subtask-form"><input type="text" placeholder="Teilaufgabe hinzufügen …" required /><button type="submit" class="secondary-btn">+</button></form>`;

    // Subtasks
    const subUl = li.querySelector(".subtask-list");
    t.subtasks.forEach((s) => {
      const sli = document.createElement("li");
      const sId = `s-${s.id}`;
      sli.innerHTML = `
        <input type="checkbox" id="${sId}" ${s.done ? "checked" : ""} />
        <label for="${sId}" class="${s.done ? "done" : ""}">${escapeHtml(s.text)}</label>
        <button class="del-btn" title="Teilaufgabe löschen">✕</button>`;
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
    ul.appendChild(li);
  });

  // Add task
  card.querySelector(".add-task-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = ev.target.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    m.tasks.push({ id: uid(), text, done: false, date: null, subtasks: [] });
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
  card.querySelector("[data-pin-module]").addEventListener("click", () => {
    m.pinned = !m.pinned; saveState(); renderModules();
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

  return card;
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
  stats = { sessions: 0, daily: {}, perModule: {}, goals: { ...DEFAULT_GOALS } };
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
      if (!s.goals || typeof s.goals !== "object") s.goals = { ...DEFAULT_GOALS };
      return s;
    }
  } catch (e) {}
  // daily: { "YYYY-MM-DD": sec } · perModule: { moduleId: sec } · goals (hours)
  return { sessions: 0, daily: {}, perModule: {}, goals: { ...DEFAULT_GOALS } };
}
function saveStats() { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); }

// Add studied seconds to today's tally (and to the selected module, if any).
function addStudySeconds(sec) {
  if (sec <= 0) return;
  const d = todayIso();
  stats.daily[d] = (stats.daily[d] || 0) + sec;
  if (pomoModuleId) stats.perModule[pomoModuleId] = (stats.perModule[pomoModuleId] || 0) + sec;
  saveStats();
}

let pomoMode = "focus";
let pomoRemaining = pomoSeconds(pomoMode);
let pomoTimerId = null;
let pomoSessions = stats.sessions; // restored from storage
let pomoModuleId = "";             // optional: Modul, dem die Fokuszeit zugeordnet wird
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

// Modul-Auswahl für den Timer füllen (Punkt 6)
function fillPomoModuleSelect() {
  const sel = document.getElementById("pomo-module");
  if (!sel) return;
  const prev = pomoModuleId;
  sel.innerHTML = `<option value="">Ohne Modulzuordnung</option>` +
    state.modules.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  // keep selection if the module still exists
  sel.value = state.modules.some((m) => m.id === prev) ? prev : "";
  pomoModuleId = sel.value;
}
const pomoModuleSel = document.getElementById("pomo-module");
if (pomoModuleSel) {
  pomoModuleSel.addEventListener("change", (e) => { pomoModuleId = e.target.value; });
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

// Modul-Suche (Punkt 7)
const moduleSearch = document.getElementById("module-search");
if (moduleSearch) {
  moduleSearch.addEventListener("input", (e) => { moduleFilter = e.target.value; renderModules(); });
}

// Theme-Umschalter (Punkt 9)
document.querySelectorAll("[data-theme-btn]").forEach((b) => {
  b.addEventListener("click", () => setTheme(b.dataset.themeBtn));
});

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
    const when = e.time ? ` um ${formatTime(e.time)} Uhr` : "";
    try { new Notification(`Heute: ${typeLabel(e.type)}`, { body: `${e.title}${when}`, tag: e.id }); } catch (err) {}
  });
  markNotified(already.concat(due.map((e) => e.id)));
}
const notifyBtn = document.getElementById("notify-btn");
if (notifyBtn) {
  notifyBtn.addEventListener("click", () => {
    if (!("Notification" in window)) return;
    Notification.requestPermission().then(() => { updateNotifyButton(); checkReminders(); });
  });
}

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
  if (undoFn) {
    const btn = document.createElement("button");
    btn.className = "snack-undo";
    btn.textContent = "Rückgängig";
    btn.addEventListener("click", () => {
      clearTimeout(snackTimer);
      bar.classList.remove("show");
      undoFn();
    });
    bar.appendChild(btn);
  }
  bar.classList.add("show");
  snackTimer = setTimeout(() => bar.classList.remove("show"), 6000);
}

/* ---------- Utilities ---------- */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ---------- Boot ---------- */
setTheme(loadTheme());       // Theme anwenden (Punkt 9)
initCalendarState();
fillPomoModuleSelect();      // Modul-Auswahl beim Timer (Punkt 6)
fillGoalInputs();            // Lernzeit-Ziele (Punkt 10)
renderDashboard();
renderModules();             // damit Suche/Picker initial stimmen
pomoFillSettings();
pomoRender();
renderStudyStats();
updateNotifyButton();        // Status des Erinnerungs-Buttons (Punkt 8)
checkReminders();            // heute fällige Prüfungen/Abgaben melden

})(); // Ende IIFE
