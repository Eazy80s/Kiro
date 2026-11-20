/* ============================================================
   Templates für die Druckblätter (auf A5 optimiert).
   Vier Blätter: Semesterübersicht, Monatskalender, Wochenplan,
   Modul-Detailblatt.
   Jede Funktion gibt { title, format, body } zurück.
   - format: "portrait" | "landscape"
   - data (optional): aus parseExport(); ist es null, wird ein
     leeres Blatt zum Handausfüllen erzeugt.
   Die Blätter füllen die A5-Seite vertikal (Flex-Spalte in .sheet);
   der mit .grow markierte Bereich dehnt sich auf den Rest aus.
   ============================================================ */
import {
  TYPE_LABELS, MONTHS, commaNum, formatDate, isPassing,
  monthMatrix,
} from "./data.mjs";

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const box = (checked) => `<span class="box${checked ? " checked" : ""}"></span>`;
const line = (min = 30) => `<span class="line" style="min-width:${min}mm"></span>`;

// Fortschritt als gefüllter Balken
function bar(pct) {
  return `<span class="bar"><span style="width:${Math.max(0, Math.min(100, pct || 0))}%"></span></span>`;
}

function emptyRows(cols, n) {
  let s = "";
  for (let i = 0; i < n; i++) s += "<tr>" + cols.map((c) => `<td${c || ""}></td>`).join("") + "</tr>";
  return s;
}

const footer = (left, right = "") => `<div class="footer"><span>${esc(left)}</span><span>${esc(right)}</span></div>`;

// Rahmen: Blatt als Flex-Spalte über die volle Seitenhöhe
function sheet(inner) { return `<div class="sheet">${inner}</div>`; }

/* ============================================================
   01 — Semesterübersicht (A5 hoch)
   Kopf · Eckdaten+Termine · Modultabelle (füllt) · Ziele/Notizen
   ============================================================ */
export function semesteruebersicht(data, opts = {}) {
  const sem = data ? (data.modules.find((m) => m.semester)?.semester || "") : "";
  // Gewünschte Gesamtzeilenzahl (steuerbar via --zeilen); Standard 12.
  const targetRows = Math.max(1, opts.rows || 12);

  // Modultabelle füllt die Seite: genug Zeilen, damit kein leerer Unterteil bleibt.
  let modRows;
  if (data && data.modules.length) {
    modRows = data.modules.map((m, i) => `<tr>
      <td class="c-num">${i + 1}</td>
      <td>${esc(m.name)}</td>
      <td class="c-ects ctr">${m.ects || ""}</td>
      <td class="c-mid">${esc(m._status)}</td>
      <td class="c-note ctr">${m._grade != null ? commaNum(m._grade) : ""}</td>
      <td class="c-bar">${bar(m._progress)}</td>
    </tr>`).join("");
    const fill = Math.max(0, targetRows - data.modules.length);
    modRows += emptyRows(['class="c-num"', "", 'class="c-ects"', 'class="c-mid"', 'class="c-note"', 'class="c-bar"'], fill)
      .replace(/<td class="c-num"><\/td>/g, (() => { let n = data.modules.length; return () => `<td class="c-num">${++n}</td>`; })());
  } else {
    modRows = emptyRows(['class="c-num"', "", 'class="c-ects"', 'class="c-mid"', 'class="c-note"', 'class="c-bar"'], targetRows)
      .replace(/<td class="c-num"><\/td>/g, (() => { let n = 0; return () => `<td class="c-num">${++n}</td>`; })());
  }

  const eck = data ? `
      <tr><td>ECTS geplant</td><td class="ctr">${data.totalEcts || ""}</td></tr>
      <tr><td>Module gesamt</td><td class="ctr">${data.modules.length}</td></tr>
      <tr><td>Ø Schnitt</td><td class="ctr">${data.gpa != null ? commaNum(data.gpa, 2) : ""}</td></tr>
      <tr><td>Fortschritt</td><td class="ctr">${data.overallPct}%</td></tr>` : `
      <tr><td>ECTS geplant</td><td></td></tr>
      <tr><td>Module gesamt</td><td></td></tr>
      <tr><td>Wunsch-Schnitt</td><td></td></tr>
      <tr><td>Lernziel / Woche</td><td></td></tr>`;
  const termine = data && data.upcomingList.length
    ? data.upcomingList.slice(0, 4).map((e) => `<tr><td class="c-date">${formatDate(e._iso)}</td><td>${esc(TYPE_LABELS[e.type] || e.type)}: ${esc(e.title)}</td></tr>`).join("")
      + emptyRows(['class="c-date"', ""], Math.max(0, 4 - data.upcomingList.length))
    : emptyRows(['class="c-date"', ""], 4);

  const body = sheet(`
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker</small>Semesterübersicht</div>
    <div class="meta"><div>Semester ${sem ? esc(sem) : line(24)}</div><div>Zeitraum ${line(24)}</div></div>
  </div>
  <div class="row cols-2">
    <div class="col"><div class="section-label">Eckdaten</div><table class="kv">${eck}</table></div>
    <div class="col"><div class="section-label">Wichtige Termine</div><table class="kv"><tbody>${termine}</tbody></table></div>
  </div>
  <div class="section-label">Module im Überblick</div>
  <table class="grow ${data ? "data" : ""}"><thead><tr><th class="c-num">#</th><th>Modul / Kurs</th><th class="c-ects">ECTS</th><th class="c-mid">Status</th><th class="c-note">Note</th><th class="c-bar">Fortschritt</th></tr></thead><tbody>${modRows}</tbody></table>
  <div class="section-label">Ziele / Notizen</div>
  <div class="lines"><div class="ln"></div><div class="ln"></div></div>
  ${footer("Studien-Tracker · Semesterübersicht", data ? "Stand: " + formatDate(data.today) : "")}`);
  return { title: "Semesterübersicht", format: "portrait", body };
}

/* ============================================================
   02 — Monatskalender (A5 quer). Mit Jahr/Monat → echter Kalender.
   Das Kalendergitter füllt die Seite (Zeilen strecken sich).
   ============================================================ */
export function monatskalender(data, opts = {}) {
  const hasDate = Number.isInteger(opts.year) && Number.isInteger(opts.month);
  const events = data ? data.events : [];
  const weeks = hasDate ? monthMatrix(opts.year, opts.month, events) : null;
  const today = data ? data.today : null;
  const showKw = opts.kw !== false;     // KW-Spalte standardmäßig an
  const showTodo = !!opts.todo;         // Mini-To-do-Spalte optional

  const head = `
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · 📅 Kalender</small>${hasDate ? esc(MONTHS[opts.month]) : "Monat " + line(34)}</div>
    <div class="meta">
      <div>${hasDate ? opts.year : "Jahr " + line(18)}</div>
      <div class="legend">
        <span><span class="dot exam"></span> Prüfung</span>
        <span><span class="dot deadline"></span> Abgabe</span>
        <span><span class="dot lecture"></span> Vorlesung</span>
        <span><span class="dot other"></span> Sonstiges</span>
      </div>
    </div>
  </div>`;

  const kwTh = showKw ? `<th class="c-kw">KW</th>` : "";
  const todoTh = showTodo ? `<th class="c-todo">Diesen Monat erledigen</th>` : "";

  let rows;
  if (weeks) {
    rows = weeks.map((wk, wi) => {
      const kwTd = showKw ? `<td class="c-kw kw">${wk.kw ?? ""}</td>` : "";
      // To-do-Spalte nur in der ersten Zeile öffnen und über alle Wochen spannen.
      const todoTd = (showTodo && wi === 0)
        ? `<td class="c-todo todo" rowspan="${weeks.length}"><div class="todo-lines">${Array.from({ length: 10 }, () => '<div class="tln">' + box(false) + "</div>").join("")}</div></td>`
        : "";
      const dayTds = wk.days.map((c, i) => {
        const we = i >= 5 ? " we" : "";
        if (!c) return `<td class="empty${we}"></td>`;
        const t = c.iso === today ? " today" : "";
        const evs = c.events.slice(0, 3).map((e) => `<div class="ev ${e.type}">${esc(e.label)}</div>`).join("");
        const more = c.events.length > 3 ? `<div class="hint">+${c.events.length - 3} mehr</div>` : "";
        return `<td class="${we}${t}"><span class="dn">${c.day}</span>${evs}${more}</td>`;
      }).join("");
      return `<tr>${kwTd}${dayTds}${todoTd}</tr>`;
    }).join("");
  } else {
    let r = "";
    for (let w = 0; w < 6; w++) {
      const kwTd = showKw ? `<td class="c-kw kw"></td>` : "";
      const todoTd = (showTodo && w === 0)
        ? `<td class="c-todo todo" rowspan="6"><div class="todo-lines">${Array.from({ length: 10 }, () => '<div class="tln">' + box(false) + "</div>").join("")}</div></td>`
        : "";
      r += `<tr>${kwTd}`;
      for (let i = 0; i < 7; i++) r += `<td class="${i >= 5 ? "we" : ""}"><span class="dn"></span></td>`;
      r += `${todoTd}</tr>`;
    }
    rows = r;
  }

  const body = sheet(`${head}
  <table class="cal grow"><thead><tr>${kwTh}<th>Mo</th><th>Di</th><th>Mi</th><th>Do</th><th>Fr</th><th>Sa</th><th>So</th>${todoTh}</tr></thead><tbody>${rows}</tbody></table>`);
  return { title: "Monatskalender", format: "landscape", body };
}

/* ============================================================
   03 — Wochenplan (A5 quer), Stundenraster. Füllt die Seite.
   ============================================================ */
export function wochenplan(opts = {}) {
  const days = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  // Zeitraster: von–bis (Stunden), Schrittweite in Minuten.
  const von = Math.max(0, Math.min(23, opts.von ?? 8));
  const bis = Math.max(von + 1, Math.min(24, opts.bis ?? 20));
  const step = [15, 20, 30, 45, 60, 90, 120].includes(opts.raster) ? opts.raster : 60;

  const slots = [];
  for (let min = von * 60; min < bis * 60; min += step) {
    const h = Math.floor(min / 60), m = min % 60;
    slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  const rows = slots.map((label) =>
    `<tr><td class="time">${label}</td>` +
    days.map((_, i) => `<td class="${i >= 5 ? "we" : ""}"></td>`).join("") + "</tr>"
  ).join("");

  const body = sheet(`
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · 📅 Wochenplan</small>Woche ${line(34)}</div>
    <div class="meta"><div>KW ${line(14)}</div></div>
  </div>
  <table class="cal week grow"><thead><tr><th class="time">Zeit</th>${days.map((d) => `<th>${d}</th>`).join("")}</tr></thead>
  <tbody>${rows}</tbody></table>`);
  return { title: "Wochenplan", format: "landscape", body };
}

/* ============================================================
   Deckblatt fürs Heft (A5 hoch).
   opts: { name, studiengang, semester }
   ============================================================ */
export function deckblatt(opts = {}) {
  const field = (label, val) => `<div class="cover-field"><div class="cover-label">${label}</div><div class="cover-val">${val ? esc(val) : ""}</div></div>`;
  const body = sheet(`
  <div class="cover">
    <div class="cover-top"><small>🎓 Studien-Tracker</small><h1>Semester-Heft</h1></div>
    <div class="cover-fields">
      ${field("Name", opts.name)}
      ${field("Studiengang", opts.studiengang)}
      ${field("Semester", opts.semester)}
      ${field("Zeitraum", opts.zeitraum)}
    </div>
    <div class="cover-foot">Semesterübersicht · Monatskalender · Wochenplan · Modul-Detailblätter</div>
  </div>
  <style>
    .cover { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; gap: 14mm; padding: 6mm 2mm; }
    .cover-top small { display:block; font-size:9pt; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:var(--accent); }
    .cover-top h1 { font-size:30pt; font-weight:800; letter-spacing:-0.02em; border-bottom:3px solid var(--accent); padding-bottom:6px; }
    .cover-fields { display:flex; flex-direction:column; gap:9mm; }
    .cover-field .cover-label { font-size:7.5pt; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); }
    .cover-field .cover-val { min-height:7mm; border-bottom:1px solid var(--border-strong); font-weight:600; font-size:12pt; }
    .cover-foot { font-size:8pt; color:var(--muted); text-align:center; margin-top:auto; }
  </style>`);
  return { title: "Semester-Heft", format: "portrait", body };
}

/* ============================================================
   04 — Modul-Detailblatt (A5 hoch). Mit Daten: ein Blatt je Modul.
   Checkliste füllt die Seite; darunter Fortschritt + Notizen.
   ============================================================ */
export function modulDetailblatt(mod) {
  const kvLine = (label, val) => `<div class="f"><label>${label}</label>${val != null && val !== "" ? `<div class="fval">${esc(val)}</div>` : '<span class="fline"></span>'}</div>`;
  const tasks = mod && mod.tasks ? mod.tasks : null;
  let taskRows;
  if (tasks && tasks.length) {
    taskRows = tasks.map((t) => {
      const sub = (t.subtasks || []).map((s) => `<div class="sub">${box(s.done)} ${esc(s.text)}</div>`).join("");
      return `<tr><td class="ctr">${box(t.done)}</td><td>${esc(t.text)}${sub}</td><td class="c-date">${t.date ? formatDate(t.date) : ""}</td><td class="c-mid">${t.done ? '<span class="pill done">erledigt</span>' : ""}</td></tr>`;
    }).join("");
    const fill = Math.max(0, 11 - tasks.length);
    taskRows += emptyRows(['class="ctr"', "", 'class="c-date"', 'class="c-mid"'], fill)
      .replace(/<td class="ctr"><\/td>/g, `<td class="ctr">${box(false)}</td>`);
  } else {
    taskRows = emptyRows(['class="ctr"', "", 'class="c-date"', 'class="c-mid"'], 13)
      .replace(/<td class="ctr"><\/td>/g, `<td class="ctr">${box(false)}</td>`);
  }
  const comps = mod && mod.gradeComponents && mod.gradeComponents.length
    ? `<div class="section-label">Teilnoten</div><table class="data"><thead><tr><th>Komponente</th><th class="c-ects">Gewicht %</th><th class="c-note">Note</th></tr></thead><tbody>${mod.gradeComponents.map((c) => `<tr><td>${esc(c.label)}</td><td class="ctr">${c.weight || ""}</td><td class="ctr">${c.grade != null ? commaNum(c.grade) : ""}</td></tr>`).join("")}</tbody></table>` : "";

  const pct = mod ? mod._progress : null;
  const body = sheet(`
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · ✅ Modul</small>${mod ? esc(mod.name) : "Modul-Detailblatt"}</div>
    <div class="meta"><div>${mod && mod.semester ? esc(mod.semester) : "Blatt-Nr. " + line(14)}</div></div>
  </div>
  <div class="kv-grid">
    ${mod ? "" : kvLine("Modul / Kurs", "")}
    ${kvLine("ECTS", mod ? mod.ects : "")}
    ${kvLine("Status", mod ? mod._status : "")}
    ${kvLine("Note", mod && mod._grade != null ? commaNum(mod._grade) + (isPassing(mod._grade) ? " (bestanden)" : " (nicht best.)") : "")}
    ${kvLine("Wunschnote", mod && mod.targetGrade != null ? commaNum(mod.targetGrade) : "")}
  </div>
  <div class="section-label">Checkliste &amp; Teilaufgaben</div>
  <table class="grow ${mod ? "data" : ""}"><thead><tr><th style="width:8mm">✓</th><th>Aufgabe</th><th class="c-date">Fällig am</th><th class="c-mid">Status</th></tr></thead><tbody>${taskRows}</tbody></table>
  ${comps}
  <div class="section-label">Fortschritt${pct != null ? " — " + pct + "%" : ""}</div>
  ${bar(pct || 0)}
  <div class="section-label">Notizen</div>
  <div class="lines"><div class="ln"></div><div class="ln"></div></div>
  ${footer("Studien-Tracker · Modul-Detailblatt", mod ? "" : "Ein Blatt pro Modul")}`);
  return { title: mod ? "Modul: " + mod.name : "Modul-Detailblatt", format: "portrait", body };
}
