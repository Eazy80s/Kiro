/* ============================================================
   Study Tracker — data persisted in localStorage
   ============================================================ */

const STORAGE_KEY = "study-tracker-v1";

/** @type {{ modules: Module[], events: EventItem[] }} */
let state = loadState();

/* ---------- Persistence ---------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("Could not load saved data:", e);
  }
  return { modules: [], events: [] };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------- Progress helpers ---------- */
function moduleProgress(module) {
  if (!module.tasks.length) return 0;
  const done = module.tasks.filter((t) => t.done).length;
  return Math.round((done / module.tasks.length) * 100);
}

function overallProgress() {
  // Average across modules that have at least one task.
  const withTasks = state.modules.filter((m) => m.tasks.length > 0);
  if (!withTasks.length) return 0;
  const sum = withTasks.reduce((acc, m) => acc + moduleProgress(m), 0);
  return Math.round(sum / withTasks.length);
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
  const overall = overallProgress();
  document.getElementById("overall-percent").textContent = overall + "%";
  document.getElementById("overall-bar").style.width = overall + "%";

  const totalTasks = state.modules.reduce((a, m) => a + m.tasks.length, 0);
  const doneTasks = state.modules.reduce((a, m) => a + m.tasks.filter((t) => t.done).length, 0);
  document.getElementById("overall-summary").textContent =
    state.modules.length
      ? `${doneTasks} of ${totalTasks} tasks completed across ${state.modules.length} module(s).`
      : "No modules yet — add one in the Modules tab to start tracking.";

  // Per-module bars
  const wrap = document.getElementById("dashboard-modules");
  wrap.innerHTML = "";
  if (!state.modules.length) {
    wrap.innerHTML = `<p class="empty-state">No modules to show.</p>`;
  } else {
    state.modules.forEach((m) => {
      const pct = moduleProgress(m);
      const div = document.createElement("div");
      div.className = "module-progress-item";
      div.innerHTML = `
        <div class="progress-label"><span>${escapeHtml(m.name)}</span><span>${pct}%</span></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
      wrap.appendChild(div);
    });
  }

  // Upcoming events (today onward, sorted, max 6)
  const list = document.getElementById("upcoming-events");
  list.innerHTML = "";
  const todayStr = new Date().toISOString().slice(0, 10);
  const upcoming = state.events
    .filter((e) => e.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 6);

  if (!upcoming.length) {
    list.innerHTML = `<p class="empty-state">No upcoming entries.</p>`;
  } else {
    upcoming.forEach((e) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span>${escapeHtml(e.title)} <span class="tag ${e.type}">${e.type}</span></span>
        <span class="ev-date">${formatDate(e.date)}</span>`;
      list.appendChild(li);
    });
  }
}

/* ============================================================
   CALENDAR
   ============================================================ */
let calYear, calMonth; // currently viewed month

function initCalendarState() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
}

function renderCalendar() {
  if (calYear === undefined) initCalendarState();

  const monthNames = ["January","February","March","April","May","June",
    "July","August","September","October","November","December"];
  document.getElementById("calendar-title").textContent = `${monthNames[calMonth]} ${calYear}`;

  const grid = document.getElementById("calendar-grid");
  grid.innerHTML = "";

  const firstDay = new Date(calYear, calMonth, 1);
  // getDay(): 0=Sun..6=Sat -> convert so Monday is first (0=Mon..6=Sun)
  let startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < startOffset; i++) {
    const empty = document.createElement("div");
    empty.className = "cal-cell empty";
    grid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const cell = document.createElement("div");
    cell.className = "cal-cell" + (dateStr === todayStr ? " today" : "");
    cell.innerHTML = `<span class="day-num">${day}</span>`;

    state.events
      .filter((e) => e.date === dateStr)
      .forEach((e) => {
        const ev = document.createElement("div");
        ev.className = `cal-event ${e.type}`;
        ev.textContent = e.title;
        ev.title = `${e.title} (${e.type}) — click to delete`;
        ev.addEventListener("click", () => {
          if (confirm(`Delete "${e.title}"?`)) {
            state.events = state.events.filter((x) => x.id !== e.id);
            saveState();
            renderCalendar();
          }
        });
        cell.appendChild(ev);
      });

    grid.appendChild(cell);
  }
}

document.getElementById("prev-month").addEventListener("click", () => {
  if (calYear === undefined) initCalendarState();
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
});
document.getElementById("next-month").addEventListener("click", () => {
  if (calYear === undefined) initCalendarState();
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
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
  e.target.reset();
  renderCalendar();
});

/* ============================================================
   MODULES & CHECKLISTS
   ============================================================ */
document.getElementById("module-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("module-name").value.trim();
  if (!name) return;
  state.modules.push({ id: uid(), name, tasks: [] });
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
    const card = document.createElement("div");
    card.className = "module-card";

    const done = m.tasks.filter((t) => t.done).length;
    card.innerHTML = `
      <div class="module-head">
        <h3>${escapeHtml(m.name)}</h3>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="pct">${done}/${m.tasks.length} · ${pct}%</span>
          <button class="del-btn" title="Delete module" data-del-module="${m.id}">🗑</button>
        </div>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <ul class="checklist"></ul>
      <form class="add-task-form" data-module="${m.id}">
        <input type="text" placeholder="New checklist item…" required />
        <button type="submit" class="primary-btn">Add</button>
      </form>`;

    const ul = card.querySelector(".checklist");
    m.tasks.forEach((t) => {
      const li = document.createElement("li");
      const cbId = `t-${t.id}`;
      li.innerHTML = `
        <input type="checkbox" id="${cbId}" ${t.done ? "checked" : ""} />
        <label for="${cbId}" class="${t.done ? "done" : ""}">${escapeHtml(t.text)}</label>
        <button class="del-btn" title="Delete item">✕</button>`;

      li.querySelector("input").addEventListener("change", (ev) => {
        t.done = ev.target.checked;
        saveState();
        renderModules();
      });
      li.querySelector(".del-btn").addEventListener("click", () => {
        m.tasks = m.tasks.filter((x) => x.id !== t.id);
        saveState();
        renderModules();
      });
      ul.appendChild(li);
    });

    card.querySelector(".add-task-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const input = ev.target.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      m.tasks.push({ id: uid(), text, done: false });
      saveState();
      renderModules();
    });

    card.querySelector("[data-del-module]").addEventListener("click", () => {
      if (confirm(`Delete module "${m.name}" and all its tasks?`)) {
        state.modules = state.modules.filter((x) => x.id !== m.id);
        saveState();
        renderModules();
      }
    });

    wrap.appendChild(card);
  });
}

/* ---------- Utilities ---------- */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/* ---------- Boot ---------- */
initCalendarState();
renderDashboard();
