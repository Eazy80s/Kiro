/* ============================================================
   Study Tracker — data persisted in localStorage
   Data model (v2):
     module: { id, name, ects, grade, completed, pinned, tasks: [task] }
     task:   { id, text, done, pinned }
     event:  { id, date (YYYY-MM-DD), title, type }
   ============================================================ */

const STORAGE_KEY = "study-tracker-v1";

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
  data.modules.forEach((m) => {
    if (typeof m.ects !== "number") m.ects = Number(m.ects) || 0;
    if (m.grade === undefined) m.grade = null;
    if (typeof m.completed !== "boolean") m.completed = false;
    if (typeof m.pinned !== "boolean") m.pinned = false;
    if (!Array.isArray(m.tasks)) m.tasks = [];
    m.tasks.forEach((t) => {
      if (typeof t.done !== "boolean") t.done = false;
      if (typeof t.pinned !== "boolean") t.pinned = false;
    });
  });
  return data;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------- Progress helpers ---------- */
function moduleProgress(module) {
  if (module.completed) return 100;
  if (!module.tasks.length) return 0;
  const done = module.tasks.filter((t) => t.done).length;
  return Math.round((done / module.tasks.length) * 100);
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

/* ---------- Date helpers ---------- */
function todayIso() { return new Date().toISOString().slice(0, 10); }
function isoOf(d) { return d.toISOString().slice(0, 10); }
function formatDate(iso) { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; }

// Whole-day difference between two YYYY-MM-DD strings (b - a), date-only.
function daysBetween(aIso, bIso) {
  const a = new Date(aIso + "T00:00:00");
  const b = new Date(bIso + "T00:00:00");
  return Math.round((b - a) / 86400000);
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
  });
});

/* ============================================================
   DASHBOARD
   ============================================================ */
function renderDashboard() {
  renderCountdown();

  const { pct, weighted } = overallProgress();
  document.getElementById("overall-percent").textContent = pct + "%";
  document.getElementById("overall-bar").style.width = pct + "%";
  document.getElementById("overall-mode").textContent = weighted ? "(ECTS-weighted)" : "";

  const completedCount = state.modules.filter((m) => m.completed).length;
  document.getElementById("overall-summary").textContent = state.modules.length
    ? `${completedCount} of ${state.modules.length} module(s) completed. (Progress reflects completed modules only.)`
    : "No modules yet — add one in the Modules tab to start tracking.";

  const gpa = computeGpa();
  document.getElementById("gpa-summary").textContent = gpa
    ? `Average grade: ${gpa.value.toFixed(2)} (from ${gpa.count} graded module${gpa.count > 1 ? "s" : ""}${gpa.weighted ? ", ECTS-weighted" : ""}).`
    : "No grades recorded yet.";

  renderPinnedModules();
  renderPinnedTasks();
  renderUpcoming();
}

function renderCountdown() {
  const card = document.getElementById("countdown-card");
  const today = todayIso();
  const nextExam = state.events
    .filter((e) => e.type === "exam" && e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  if (!nextExam) {
    card.className = "countdown-card none";
    card.innerHTML = `<span>🎯 No upcoming exams scheduled. Add one in the Calendar.</span>`;
    return;
  }
  const days = daysBetween(today, nextExam.date);
  const label = days === 0 ? "Today!" : days === 1 ? "1 day" : `${days} days`;
  card.className = "countdown-card";
  card.innerHTML = `
    <div><div class="cd-days">${label}</div><div class="muted">until next exam</div></div>
    <div class="cd-info">
      <div class="cd-title">${escapeHtml(nextExam.title)}</div>
      <div class="cd-date">${formatDate(nextExam.date)}</div>
    </div>`;
}

function renderPinnedModules() {
  const wrap = document.getElementById("pinned-modules");
  wrap.innerHTML = "";
  const pinned = state.modules.filter((m) => m.pinned);
  if (!pinned.length) {
    wrap.innerHTML = `<p class="empty-state">No modules pinned. Pin the ones you're working on from the Modules tab.</p>`;
    return;
  }
  pinned.forEach((m) => {
    const pct = moduleProgress(m);
    const bits = [];
    if (m.ects) bits.push(`${m.ects} ECTS`);
    if (typeof m.grade === "number") bits.push(`grade ${m.grade}`);
    if (m.completed) bits.push("✓ completed");
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
  const items = [];
  state.modules.forEach((m) => {
    m.tasks.forEach((t) => { if (t.pinned) items.push({ module: m, task: t }); });
  });
  if (!items.length) {
    list.innerHTML = `<p class="empty-state">No tasks pinned. Pin checklist items (📌) to focus on them today.</p>`;
    return;
  }
  items.forEach(({ module, task }) => {
    const li = document.createElement("li");
    const cbId = `focus-${task.id}`;
    li.innerHTML = `
      <input type="checkbox" id="${cbId}" ${task.done ? "checked" : ""} />
      <span class="focus-text ${task.done ? "done" : ""}">${escapeHtml(task.text)}</span>
      <span class="focus-mod">${escapeHtml(module.name)}</span>`;
    li.querySelector("input").addEventListener("change", (ev) => {
      task.done = ev.target.checked;
      saveState();
      renderDashboard();
    });
    list.appendChild(li);
  });
}

function renderUpcoming() {
  const list = document.getElementById("upcoming-events");
  list.innerHTML = "";
  const today = todayIso();
  const upcoming = state.events
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 6);
  if (!upcoming.length) {
    list.innerHTML = `<p class="empty-state">No upcoming entries.</p>`;
    return;
  }
  upcoming.forEach((e) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span>${escapeHtml(e.title)} <span class="tag ${e.type}">${e.type}</span></span>
      <span class="ev-date">${formatDate(e.date)}</span>`;
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

const MONTHS = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];

function renderCalendar() {
  if (calYear === undefined) initCalendarState();

  document.getElementById("calendar-title").textContent = `${MONTHS[calMonth]} ${calYear}`;
  document.getElementById("selected-day-label").textContent =
    selectedDate ? `Selected: ${formatDate(selectedDate)}` : "";

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

    state.events
      .filter((e) => e.date === dateStr)
      .slice(0, 3)
      .forEach((e) => {
        const ev = document.createElement("div");
        ev.className = `cal-event ${e.type}`;
        ev.textContent = e.title;
        ev.title = `${e.title} (${e.type})`;
        cell.appendChild(ev);
      });

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
  const dayEvents = state.events
    .filter((e) => e.date === selectedDate)
    .sort((a, b) => a.title.localeCompare(b.title));

  let html = `<h3>${formatDate(selectedDate)}</h3>`;
  if (!dayEvents.length) {
    html += `<p class="muted">No entries on this day. Use the form below (date is pre-filled).</p>`;
  } else {
    dayEvents.forEach((e) => {
      html += `
        <div class="d-event">
          <span class="d-left"><span class="tag ${e.type}">${e.type}</span> ${escapeHtml(e.title)}</span>
          <button class="del-btn" data-del-event="${e.id}" title="Delete">✕</button>
        </div>`;
    });
  }
  wrap.innerHTML = html;

  wrap.querySelectorAll("[data-del-event]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.events = state.events.filter((x) => x.id !== btn.dataset.delEvent);
      saveState();
      renderCalendar();
    });
  });

  // Pre-fill the add-entry date field with the selected day.
  document.getElementById("event-date").value = selectedDate;
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
  const title = document.getElementById("event-title").value.trim();
  const type = document.getElementById("event-type").value;
  if (!date || !title) return;
  state.events.push({ id: uid(), date, title, type });
  saveState();
  selectedDate = date;
  const d = new Date(date + "T00:00:00");
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  document.getElementById("event-title").value = "";
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
  state.modules.push({ id: uid(), name, ects, grade: null, completed: false, pinned: false, tasks: [] });
  saveState();
  e.target.reset();
  renderModules();
});

function renderModules() {
  const wrap = document.getElementById("modules-list");
  wrap.innerHTML = "";

  if (!state.modules.length) {
    wrap.innerHTML = `<p class="empty-state">No modules yet. Add your first one above.</p>`;
    return;
  }

  state.modules.forEach((m) => {
    const pct = moduleProgress(m);
    const done = m.tasks.filter((t) => t.done).length;
    const card = document.createElement("div");
    card.className = "module-card" + (m.completed ? " completed" : "");

    card.innerHTML = `
      <div class="module-head">
        <h3>
          ${escapeHtml(m.name)}
          ${m.ects ? `<span class="badge">${m.ects} ECTS</span>` : ""}
          ${m.completed ? `<span class="badge done">✓ done</span>` : ""}
        </h3>
        <div class="module-actions">
          <span class="pct">${done}/${m.tasks.length} · ${pct}%</span>
          <button class="pin-btn ${m.pinned ? "pinned" : ""}" data-pin-module title="Pin to dashboard">📌</button>
          <button class="del-btn" data-del-module title="Delete module">🗑</button>
        </div>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="module-controls">
        <label><input type="checkbox" data-complete ${m.completed ? "checked" : ""}/> Completed</label>
        <label>Grade: <input type="number" class="grade-input" data-grade step="0.1" placeholder="—" value="${m.grade ?? ""}"/></label>
        <label>ECTS: <input type="number" class="grade-input" data-ects step="0.5" min="0" placeholder="0" value="${m.ects || ""}"/></label>
      </div>
      <ul class="checklist"></ul>
      <form class="add-task-form"><input type="text" placeholder="New checklist item…" required /><button type="submit" class="primary-btn">Add</button></form>`;

    // Checklist items
    const ul = card.querySelector(".checklist");
    m.tasks.forEach((t) => {
      const li = document.createElement("li");
      const cbId = `t-${t.id}`;
      li.innerHTML = `
        <input type="checkbox" class="task-done" id="${cbId}" ${t.done ? "checked" : ""} />
        <label for="${cbId}" class="${t.done ? "done" : ""}">${escapeHtml(t.text)}</label>
        <button class="pin-btn ${t.pinned ? "pinned" : ""}" title="Pin to Today's Focus">📌</button>
        <button class="del-btn" title="Delete item">✕</button>`;
      li.querySelector(".task-done").addEventListener("change", (ev) => {
        t.done = ev.target.checked; saveState(); renderModules();
      });
      li.querySelector(".pin-btn").addEventListener("click", () => {
        t.pinned = !t.pinned; saveState(); renderModules();
      });
      li.querySelector(".del-btn").addEventListener("click", () => {
        m.tasks = m.tasks.filter((x) => x.id !== t.id); saveState(); renderModules();
      });
      ul.appendChild(li);
    });

    // Add task
    card.querySelector(".add-task-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const input = ev.target.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      m.tasks.push({ id: uid(), text, done: false, pinned: false });
      saveState(); renderModules();
    });

    // Completed toggle
    card.querySelector("[data-complete]").addEventListener("change", (ev) => {
      m.completed = ev.target.checked; saveState(); renderModules();
    });
    // Grade
    card.querySelector("[data-grade]").addEventListener("change", (ev) => {
      const v = parseFloat(ev.target.value);
      m.grade = isNaN(v) ? null : v; saveState();
    });
    // ECTS
    card.querySelector("[data-ects]").addEventListener("change", (ev) => {
      m.ects = parseFloat(ev.target.value) || 0; saveState(); renderModules();
    });
    // Pin module
    card.querySelector("[data-pin-module]").addEventListener("click", () => {
      m.pinned = !m.pinned; saveState(); renderModules();
    });
    // Delete module
    card.querySelector("[data-del-module]").addEventListener("click", () => {
      if (confirm(`Delete module "${m.name}" and all its tasks?`)) {
        state.modules = state.modules.filter((x) => x.id !== m.id);
        saveState(); renderModules();
      }
    });

    wrap.appendChild(card);
  });
}

/* ============================================================
   DATA: export / import / reset
   ============================================================ */
document.getElementById("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `study-tracker-backup-${todayIso()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus("Exported your data as a .json file.");
});

document.getElementById("import-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      if (!parsed || !Array.isArray(parsed.modules) || !Array.isArray(parsed.events)) {
        throw new Error("File doesn't look like a Study Tracker backup.");
      }
      if (!confirm("Importing will replace your current data. Continue?")) return;
      state = migrate(parsed);
      saveState();
      renderDashboard(); renderCalendar(); renderModules();
      setStatus("Import successful — your data has been restored.");
    } catch (err) {
      setStatus("Import failed: " + err.message, true);
    }
  };
  reader.readAsText(file);
  e.target.value = ""; // allow re-importing the same file
});

document.getElementById("reset-btn").addEventListener("click", () => {
  if (!confirm("Delete ALL data permanently? This cannot be undone.")) return;
  state = { modules: [], events: [] };
  saveState();
  renderDashboard(); renderCalendar(); renderModules();
  setStatus("All data deleted.");
});

function setStatus(msg, isError) {
  const el = document.getElementById("data-status");
  el.textContent = msg;
  el.style.color = isError ? "var(--danger)" : "var(--muted)";
}

/* ============================================================
   POMODORO TIMER
   ============================================================ */
const POMO_DURATIONS = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
const POMO_LABELS = { focus: "Focus", short: "Short break", long: "Long break" };
let pomoMode = "focus";
let pomoRemaining = POMO_DURATIONS[pomoMode];
let pomoTimerId = null;
let pomoSessions = 0;

function pomoFormat(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function pomoRender() {
  document.getElementById("pomo-time").textContent = pomoFormat(pomoRemaining);
  document.getElementById("pomo-count").textContent = `Completed focus sessions: ${pomoSessions}`;
  document.getElementById("pomo-start").textContent = pomoTimerId ? "Pause" : "Start";
  document.querySelectorAll("[data-pomo-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.pomoMode === pomoMode);
  });
  document.title = pomoTimerId
    ? `${pomoFormat(pomoRemaining)} · ${POMO_LABELS[pomoMode]} — Study Tracker`
    : "Study Tracker";
}

function pomoStop() {
  if (pomoTimerId) { clearInterval(pomoTimerId); pomoTimerId = null; }
}

function pomoStart() {
  if (pomoTimerId) { pomoStop(); pomoRender(); return; }  // toggle -> pause
  pomoTimerId = setInterval(() => {
    pomoRemaining--;
    if (pomoRemaining <= 0) {
      pomoStop();
      if (pomoMode === "focus") pomoSessions++;
      pomoRemaining = 0;
      pomoRender();
      try { // gentle beep; ignored if the browser blocks audio
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.connect(ctx.destination);
        osc.frequency.value = 660;
        osc.start();
        setTimeout(() => { osc.stop(); ctx.close(); }, 450);
      } catch (e) {}
      alert(`${POMO_LABELS[pomoMode]} finished!`);
      // Auto-suggest the next mode: focus -> short break -> focus ...
      pomoSetMode(pomoMode === "focus" ? "short" : "focus");
      return;
    }
    pomoRender();
  }, 1000);
  pomoRender();
}

function pomoSetMode(mode) {
  pomoMode = mode;
  pomoStop();
  pomoRemaining = POMO_DURATIONS[mode];
  pomoRender();
}

document.getElementById("pomo-start").addEventListener("click", pomoStart);
document.getElementById("pomo-reset").addEventListener("click", () => {
  pomoStop();
  pomoRemaining = POMO_DURATIONS[pomoMode];
  pomoRender();
});
document.querySelectorAll("[data-pomo-mode]").forEach((b) => {
  b.addEventListener("click", () => pomoSetMode(b.dataset.pomoMode));
});

/* ---------- Utilities ---------- */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ---------- Boot ---------- */
initCalendarState();
renderDashboard();
pomoRender();
