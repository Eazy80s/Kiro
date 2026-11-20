/* ============================================================
   Templates für alle Druckblätter.
   Jede Funktion gibt { title, kicker, format, body, meta } zurück.
   - format: "portrait" | "landscape"
   - data (optional): aus parseExport(); ist es null, wird ein
     leeres Blatt zum Handausfüllen erzeugt.
   ============================================================ */
import {
  TYPE_LABELS, MONTHS, commaNum, formatDate, formatDuration,
  monthMatrix, isPassing,
} from "./data.mjs";

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const box = (checked) => `<span class="box${checked ? " checked" : ""}"></span>`;
const line = (min = 34) => `<span class="line" style="min-width:${min}mm"></span>`;

// Fortschrittsbalken (Prozent) — als Boxen (10) oder gefüllter Balken
function barBoxes(pct) {
  const on = Math.round((pct || 0) / 10);
  let s = '<div class="bar-boxes">';
  for (let i = 0; i < 10; i++) s += `<i class="${i < on ? "on" : ""}"></i>`;
  return s + "</div>";
}

/* Leere Tabellenzeilen erzeugen */
function emptyRows(cols, n) {
  let s = "";
  for (let i = 0; i < n; i++) s += "<tr>" + cols.map((c) => `<td${c || ""}></td>`).join("") + "</tr>";
  return s;
}

const footer = (left, right = "") => `<div class="footer"><span>${esc(left)}</span><span>${esc(right)}</span></div>`;

/* ============================================================
   01 — Semesterübersicht (Hoch)
   ============================================================ */
export function semesteruebersicht(data) {
  const sem = data ? (data.modules.find((m) => m.semester)?.semester || "") : "";
  let modRows;
  if (data && data.modules.length) {
    modRows = data.modules.map((m, i) => `<tr>
      <td class="c-num">${i + 1}</td>
      <td>${esc(m.name)}</td>
      <td class="c-ects ctr">${m.ects || ""}</td>
      <td class="c-mid">${esc(m._status)}</td>
      <td class="c-note ctr">${m._grade != null ? commaNum(m._grade) : ""}</td>
      <td class="c-mid">${barBoxes(m._progress)}</td>
    </tr>`).join("");
  } else {
    modRows = emptyRows(['class="c-num"', "", 'class="c-ects"', 'class="c-mid"', 'class="c-note"', 'class="c-mid"'], 8)
      .replace(/<td class="c-num"><\/td>/g, (() => { let n = 0; return () => `<td class="c-num">${++n}</td>`; })());
  }
  const eck = data ? `
      <tr><td class="c-mid">ECTS geplant</td><td>${data.totalEcts || ""}</td></tr>
      <tr><td>Module gesamt</td><td>${data.modules.length}</td></tr>
      <tr><td>Ø Schnitt</td><td>${data.gpa != null ? commaNum(data.gpa, 2) : ""}</td></tr>
      <tr><td>Fortschritt</td><td>${data.overallPct}%</td></tr>` : `
      <tr><td class="c-mid">ECTS geplant</td><td></td></tr>
      <tr><td>Module gesamt</td><td></td></tr>
      <tr><td>Wunsch-Schnitt</td><td></td></tr>
      <tr><td>Wöchentl. Lernziel</td><td></td></tr>`;
  const termine = data && data.upcomingList.length
    ? data.upcomingList.slice(0, 6).map((e) => `<tr><td>${formatDate(e._iso)}</td><td>${esc(TYPE_LABELS[e.type] || e.type)}: ${esc(e.title)}</td></tr>`).join("")
    : emptyRows(["", ""], 5);

  const body = `
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker</small>Semesterübersicht</div>
    <div class="meta"><div>Semester ${sem ? esc(sem) : line()}</div><div style="margin-top:3px">Zeitraum ${line()}</div></div>
  </div>
  <div class="section-label">Ziele dieses Semesters</div>
  <div class="lines"><div class="ln"></div>${data ? "" : '<div class="ln"></div>'}</div>
  <div class="row" style="margin-top:8px">
    <div class="col"><div class="section-label">Eckdaten</div><table>${eck}</table></div>
    <div class="col"><div class="section-label">Wichtige Termine</div><table><thead><tr><th class="c-date">Datum</th><th>Ereignis</th></tr></thead><tbody>${termine}</tbody></table></div>
  </div>
  <div class="section-label">Module im Überblick</div>
  <table class="${data ? "data" : ""}"><thead><tr><th class="c-num">#</th><th>Modul / Kurs</th><th class="c-ects">ECTS</th><th class="c-mid">Status</th><th class="c-note">Note</th><th class="c-mid">Fortschritt</th></tr></thead><tbody>${modRows}</tbody></table>
  ${data ? "" : '<div class="legend"><span>'+box()+' In Bearbeitung</span><span>'+box()+' Demnächst</span><span>'+box()+' Abgeschlossen</span></div>'}
  ${footer("Studien-Tracker · Semesterübersicht", data ? "Stand: " + formatDate(data.today) : "")}`;
  return { title: "Semesterübersicht", format: "portrait", body };
}

/* ============================================================
   02 — Monatskalender (Quer). Mit Jahr/Monat → echter Kalender.
   opts: { year, month } (month 0-based) für datierten Kalender.
   ============================================================ */
export function monatskalender(data, opts = {}) {
  const hasDate = Number.isInteger(opts.year) && Number.isInteger(opts.month);
  const events = data ? data.events : [];
  const weeks = hasDate ? monthMatrix(opts.year, opts.month, events) : null;
  const today = data ? data.today : null;

  const head = `
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · 📅 Kalender</small>${hasDate ? esc(MONTHS[opts.month]) : "Monat " + line(40)}</div>
    <div class="meta"><div>${hasDate ? opts.year : "Jahr " + line(20)}</div></div>
  </div>
  <div class="legend">
    <span><span class="dot exam"></span> Prüfung</span>
    <span><span class="dot deadline"></span> Abgabe</span>
    <span><span class="dot lecture"></span> Vorlesung</span>
    <span><span class="dot other"></span> Sonstiges</span>
  </div>`;

  let rows;
  if (weeks) {
    rows = weeks.map((wk) => "<tr>" + wk.map((c, i) => {
      const we = i >= 5 ? " we" : "";
      if (!c) return `<td class="empty${we}"></td>`;
      const t = c.iso === today ? " today" : "";
      const evs = c.events.slice(0, 3).map((e) => `<div class="ev ${e.type}">${esc(e.label)}</div>`).join("");
      const more = c.events.length > 3 ? `<div class="hint">+${c.events.length - 3} mehr</div>` : "";
      return `<td class="${we}${t}"><span class="dn">${c.day}</span>${evs}${more}</td>`;
    }).join("") + "</tr>").join("");
  } else {
    let r = "";
    for (let w = 0; w < 6; w++) {
      r += "<tr>";
      for (let i = 0; i < 7; i++) r += `<td class="${i >= 5 ? "we" : ""}"><span class="dn"></span></td>`;
      r += "</tr>";
    }
    rows = r;
  }

  const body = `${head}
  <table class="cal"><thead><tr><th>Mo</th><th>Di</th><th>Mi</th><th>Do</th><th>Fr</th><th>Sa</th><th>So</th></tr></thead><tbody>${rows}</tbody></table>`;
  return { title: "Monatskalender", format: "landscape", body };
}

/* ============================================================
   03 — Wochenplan (Quer), Stundenraster
   ============================================================ */
export function wochenplan() {
  const days = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  let rows = "";
  for (let h = 8; h <= 20; h++) {
    rows += `<tr><td class="time">${String(h).padStart(2, "0")}:00</td>` +
      days.map((_, i) => `<td class="${i >= 5 ? "we" : ""}"></td>`).join("") + "</tr>";
  }
  const body = `
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · 📅 Wochenplan</small>Woche ${line(40)}</div>
    <div class="meta"><div>KW ${line(16)}</div></div>
  </div>
  <table class="cal"><thead><tr><th style="width:14mm">Zeit</th>${days.map((d) => `<th>${d}</th>`).join("")}</tr></thead>
  <tbody>${rows}</tbody></table>
  <style>
    .cal td.time { background: var(--stripe); font-weight:700; color:var(--muted); text-align:center; vertical-align:middle; height:9mm; }
    .cal td { height: 9mm; }
  </style>`;
  return { title: "Wochenplan", format: "landscape", body };
}

/* ============================================================
   04 — Modul-Übersicht (Hoch): nach Status gruppiert
   ============================================================ */
export function modulUebersicht(data) {
  function group(status, cols, header, n) {
    let rows;
    if (data) {
      const list = data.modules.filter((m) => m._status === status);
      rows = list.length ? list.map(cols).join("") : emptyRows(new Array(header.length).fill(""), 1);
    } else {
      rows = emptyRows(new Array(header.length).fill(""), n);
    }
    return `<thead><tr>${header.map((h) => `<th${h.w ? ` class="${h.w}"` : ""}>${h.t}</th>`).join("")}</tr></thead><tbody>${rows}</tbody>`;
  }
  const inProg = group("In Bearbeitung",
    (m) => `<tr><td>${esc(m.name)}</td><td class="c-ects ctr">${m.ects || ""}</td><td class="c-date"></td><td class="c-mid">${barBoxes(m._progress)}</td><td class="c-note ctr">${m._grade != null ? commaNum(m._grade) : ""}</td></tr>`,
    [{ t: "Modul / Kurs" }, { t: "ECTS", w: "c-ects" }, { t: "Nächste Abgabe", w: "c-date" }, { t: "Fortschritt", w: "c-mid" }, { t: "Note", w: "c-note" }], 4);
  const soon = group("Demnächst",
    (m) => `<tr><td>${esc(m.name)}</td><td class="c-ects ctr">${m.ects || ""}</td><td class="c-date"></td><td></td></tr>`,
    [{ t: "Modul / Kurs" }, { t: "ECTS", w: "c-ects" }, { t: "Start", w: "c-date" }, { t: "Notiz" }], 3);
  const done = group("Abgeschlossen",
    (m) => `<tr><td>${esc(m.name)}</td><td class="c-ects ctr">${m.ects || ""}</td><td class="c-date"></td><td class="c-note ctr">${m._grade != null ? commaNum(m._grade) : ""}</td></tr>`,
    [{ t: "Modul / Kurs" }, { t: "ECTS", w: "c-ects" }, { t: "Abgeschlossen am", w: "c-date" }, { t: "Note", w: "c-note" }], 3);

  const body = `
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · 📚 Module</small>Modul-Übersicht</div>
    <div class="meta"><div>Semester ${line()}</div></div>
  </div>
  <div class="section-label">In Bearbeitung</div><table class="${data ? "data" : ""}">${inProg}</table>
  <div class="section-label">Demnächst</div><table class="${data ? "data" : ""}">${soon}</table>
  <div class="section-label">Abgeschlossen</div><table class="${data ? "data" : ""}">${done}</table>
  ${footer("Studien-Tracker · Modul-Übersicht", data ? "Stand: " + formatDate(data.today) : "")}`;
  return { title: "Modul-Übersicht", format: "portrait", body };
}

/* ============================================================
   05 — Modul-Detailblatt (Hoch). Mit Daten: ein Blatt je Modul.
   ============================================================ */
export function modulDetailblatt(mod) {
  const kvLine = (label, val) => `<div class="f"><label>${label}</label>${val != null && val !== "" ? `<div class="line" style="border:none;font-weight:600">${esc(val)}</div>` : '<span class="line"></span>'}</div>`;
  const tasks = mod && mod.tasks ? mod.tasks : null;
  let taskRows;
  if (tasks && tasks.length) {
    taskRows = tasks.map((t) => {
      const sub = (t.subtasks || []).map((s) => `<div style="padding-left:6mm">${box(s.done)} ${esc(s.text)}</div>`).join("");
      return `<tr><td class="ctr">${box(t.done)}</td><td>${esc(t.text)}${sub}</td><td class="c-date">${t.date ? formatDate(t.date) : ""}</td><td class="c-mid">${t.done ? '<span class="pill done">erledigt</span>' : ""}</td></tr>`;
    }).join("");
  } else {
    taskRows = emptyRows(['class="ctr"', "", 'class="c-date"', 'class="c-mid"'], 10)
      .replace(/<td class="ctr"><\/td>/g, `<td class="ctr">${box(false)}</td>`);
  }
  const comps = mod && mod.gradeComponents && mod.gradeComponents.length
    ? `<div class="section-label">Teilnoten</div><table class="data"><thead><tr><th>Komponente</th><th class="c-ects">Gewicht %</th><th class="c-note">Note</th></tr></thead><tbody>${mod.gradeComponents.map((c) => `<tr><td>${esc(c.label)}</td><td class="ctr">${c.weight || ""}</td><td class="ctr">${c.grade != null ? commaNum(c.grade) : ""}</td></tr>`).join("")}</tbody></table>` : "";

  const pct = mod ? mod._progress : null;
  const body = `
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · ✅ Modul</small>${mod ? esc(mod.name) : "Modul-Detailblatt"}</div>
    <div class="meta"><div>${mod && mod.semester ? esc(mod.semester) : "Blatt-Nr. " + line(16)}</div></div>
  </div>
  <div class="kv">
    ${mod ? "" : kvLine("Modul / Kurs", "")}
    ${kvLine("ECTS", mod ? mod.ects : "")}
    ${kvLine("Status", mod ? mod._status : "")}
    ${kvLine("Note", mod && mod._grade != null ? commaNum(mod._grade) + (isPassing(mod._grade) ? " (bestanden)" : " (nicht bestanden)") : "")}
    ${kvLine("Wunschnote", mod && mod.targetGrade != null ? commaNum(mod.targetGrade) : "")}
  </div>
  <div class="section-label">Checkliste & Teilaufgaben</div>
  <table class="${mod ? "data" : ""}"><thead><tr><th style="width:8mm">✓</th><th>Aufgabe</th><th class="c-date">Fällig am</th><th class="c-mid">Status</th></tr></thead><tbody>${taskRows}</tbody></table>
  <div class="section-label">Fortschritt${pct != null ? " — " + pct + "%" : ""}</div>
  ${pct != null ? barBoxes(pct) : barBoxes(0)}
  <div class="hint">10 Kästchen = 100 %.${pct == null ? " Ausmalen, wie weit du bist." : ""}</div>
  ${comps}
  <div class="section-label">Notizen</div>
  <div class="lines"><div class="ln"></div><div class="ln"></div>${mod ? "" : '<div class="ln"></div>'}</div>
  <style>.kv{display:flex;gap:8px;flex-wrap:wrap}.kv .f{flex:1;min-width:30mm}.kv .f label{font-size:7pt;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);display:block}.kv .f .line{display:block;border-bottom:1px solid var(--border-strong);height:6mm}</style>
  ${footer("Studien-Tracker · Modul-Detailblatt", mod ? "" : "Ein Blatt pro Modul")}`;
  return { title: mod ? "Modul: " + mod.name : "Modul-Detailblatt", format: "portrait", body };
}

/* ============================================================
   06 — Noten-Tracker (Hoch)
   ============================================================ */
export function notenTracker(data) {
  let rows, sumRow;
  if (data && data.modules.length) {
    rows = data.modules.map((m) => `<tr>
      <td>${esc(m.name)}</td>
      <td class="c-ects ctr">${m.ects || ""}</td>
      <td class="c-note ctr">${m.targetGrade != null ? commaNum(m.targetGrade) : ""}</td>
      <td class="c-note ctr">${m._grade != null ? commaNum(m._grade) : ""}</td>
      <td class="c-mid num">${m._grade != null && m.ects ? commaNum(m._grade * m.ects, 1) : ""}</td>
      <td class="ctr">${m._grade != null ? box(isPassing(m._grade)) : box(false)}</td>
    </tr>`).join("");
    const sumNE = data.modules.reduce((a, m) => a + (m._grade != null ? m._grade * (m.ects || 0) : 0), 0);
    sumRow = `<tr style="font-weight:700"><td>Summe / Schnitt</td><td class="c-ects ctr">${data.totalEcts}</td><td></td><td class="ctr">${data.gpa != null ? commaNum(data.gpa, 2) : ""}</td><td class="num">${commaNum(sumNE, 1)}</td><td></td></tr>`;
  } else {
    rows = emptyRows(["", 'class="c-ects"', 'class="c-note"', 'class="c-note"', 'class="c-mid"', 'class="ctr"'], 10)
      .replace(/<td class="ctr"><\/td>/g, `<td class="ctr">${box(false)}</td>`);
    sumRow = `<tr style="font-weight:700"><td>Summe / Schnitt</td><td></td><td></td><td></td><td></td><td></td></tr>`;
  }
  const calc = data ? `
      <tr><td class="c-mid">Summe Note×ECTS</td><td class="num">${commaNum(data.modules.reduce((a, m) => a + (m._grade != null ? m._grade * (m.ects || 0) : 0), 0), 1)}</td></tr>
      <tr><td>Summe ECTS (benotet)</td><td>${data.modules.filter((m) => m._grade != null).reduce((a, m) => a + (m.ects || 0), 0)}</td></tr>
      <tr><td>Ø Schnitt</td><td>${data.gpa != null ? commaNum(data.gpa, 2) : "—"}</td></tr>` : `
      <tr><td class="c-mid">Summe Note×ECTS</td><td></td></tr>
      <tr><td>Summe ECTS</td><td></td></tr>
      <tr><td>Ø Schnitt</td><td></td></tr>
      <tr><td>Wunsch-Schnitt</td><td></td></tr>`;
  const prog = data && data.gradeRange ? `
      <tr><td class="c-mid">Noch offene ECTS</td><td>${data.gradeRange.openEcts}</td></tr>
      <tr><td>Bester mögl. Endschnitt</td><td>${commaNum(data.gradeRange.best, 2)}</td></tr>
      <tr><td>Schlechtester Endschnitt</td><td>${commaNum(data.gradeRange.worst, 2)}</td></tr>` : `
      <tr><td class="c-mid">Noch offene ECTS</td><td></td></tr>
      <tr><td>Benötigter Ø dafür</td><td></td></tr>
      <tr><td>Bester mögl. Endschnitt</td><td></td></tr>
      <tr><td>Schlechtester Endschnitt</td><td></td></tr>`;

  const body = `
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · 🎓 Noten</small>Noten-Tracker</div>
    <div class="meta"><div>Semester ${line()}</div></div>
  </div>
  <div class="hint">Skala: <strong>1,0 = sehr gut</strong> … <strong>4,0 = bestanden</strong> … <strong>5,0 = nicht bestanden</strong>. Schnitt ECTS-gewichtet.</div>
  <div class="grade-scale"><div>1,0</div><div>1,3</div><div>1,7</div><div>2,0</div><div>2,3</div><div>2,7</div><div>3,0</div><div>3,3</div><div>3,7</div><div>4,0</div><div>5,0</div></div>
  <div class="section-label">Module & Noten</div>
  <table class="${data ? "data" : ""}"><thead><tr><th>Modul / Kurs</th><th class="c-ects">ECTS</th><th class="c-note">Wunsch</th><th class="c-note">Note</th><th class="c-mid">Note×ECTS</th><th class="c-note">best.</th></tr></thead><tbody>${rows}${sumRow}</tbody></table>
  <div class="row" style="margin-top:8px">
    <div class="col"><div class="section-label">Durchschnitt</div><div class="hint">Ø = Σ(Note×ECTS) ÷ Σ(ECTS)</div><table style="margin-top:3px">${calc}</table></div>
    <div class="col"><div class="section-label">Noten-Prognose</div><table style="margin-top:3px">${prog}</table></div>
  </div>
  ${footer("Studien-Tracker · Noten-Tracker", "ECTS-gewichteter Durchschnitt")}`;
  return { title: "Noten-Tracker", format: "portrait", body };
}

/* ============================================================
   07 — Teilnoten-Rechner (Hoch)
   ============================================================ */
export function teilnotenRechner(mod) {
  let rows, sumRow;
  if (mod && mod.gradeComponents && mod.gradeComponents.length) {
    rows = mod.gradeComponents.map((c, i) => `<tr><td class="c-num">${i + 1}</td><td>${esc(c.label)}</td><td class="c-ects ctr">${c.weight || ""}</td><td class="c-note ctr">${c.grade != null ? commaNum(c.grade) : ""}</td><td class="c-mid num">${c.grade != null ? commaNum(c.grade * (c.weight || 0), 1) : ""}</td></tr>`).join("");
    const w = mod.gradeComponents.reduce((a, c) => a + (c.weight || 0), 0);
    const ng = mod.gradeComponents.reduce((a, c) => a + (c.grade != null ? c.grade * (c.weight || 0) : 0), 0);
    sumRow = `<tr style="font-weight:700"><td></td><td>Summe</td><td class="ctr">${w}&nbsp;%</td><td>—</td><td class="num">${commaNum(ng, 1)}</td></tr>`;
  } else {
    rows = emptyRows(['class="c-num"', "", 'class="c-ects"', 'class="c-note"', 'class="c-mid"'], 5)
      .replace(/<td class="c-num"><\/td>/g, (() => { let n = 0; return () => `<td class="c-num">${++n}</td>`; })());
    sumRow = `<tr style="font-weight:700"><td></td><td>Summe</td><td class="ctr">100&nbsp;%</td><td>—</td><td></td></tr>`;
  }
  const endnote = mod && mod._grade != null ? commaNum(mod._grade) : "";
  const body = `
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · 🎓 Teilnoten</small>Teilnoten-Rechner</div>
    <div class="meta"><div>Modul ${mod ? esc(mod.name) : line()}</div></div>
  </div>
  <div class="hint">Endnote aus gewichteten Komponenten, z.&nbsp;B. Klausur 70&nbsp;% + Übung 30&nbsp;%. Gewichte in Summe 100&nbsp;%.</div>
  <div class="section-label">Komponenten</div>
  <table class="${mod ? "data" : ""}"><thead><tr><th class="c-num">#</th><th>Komponente</th><th class="c-ects">Gewicht&nbsp;%</th><th class="c-note">Note</th><th class="c-mid">Note×Gew.</th></tr></thead><tbody>${rows}${sumRow}</tbody></table>
  <div class="row" style="margin-top:8px">
    <div class="col"><div class="section-label">Endnote</div><div class="hint">= Σ(Note×Gewicht) ÷ 100</div><table style="margin-top:3px"><tr style="font-weight:700"><td>Endnote Modul</td><td>${endnote}</td></tr></table></div>
    <div class="col"><div class="section-label">Was fehlt?</div><table style="margin-top:3px"><tr><td class="c-mid">Zielnote</td><td>${mod && mod.targetGrade != null ? commaNum(mod.targetGrade) : ""}</td></tr><tr><td>Offene Komponente</td><td></td></tr><tr><td>Dort nötige Note</td><td></td></tr></table></div>
  </div>
  ${footer("Studien-Tracker · Teilnoten-Rechner", "Gewichte in Summe = 100 %")}`;
  return { title: "Teilnoten-Rechner", format: "portrait", body };
}

/* ============================================================
   08 — Lernzeit- & Pomodoro-Log (Hoch)
   ============================================================ */
export function lernzeitLog(data) {
  const pomoBoxes = (n = 8) => { let s = ""; for (let i = 0; i < n; i++) s += box(false); return s; };
  const days = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const focusMin = data ? data.pomodoro.focus : 25;
  const rows = days.map((d) => `<tr><td>${d}</td><td></td><td class="pomo-cell">${pomoBoxes()}</td><td></td></tr>`).join("");
  const modRows = data && data.modules.length
    ? data.modules.filter((m) => m._studySec > 0).map((m) => `<tr><td>${esc(m.name)}</td><td></td><td class="num">${formatDuration(m._studySec)}</td><td></td></tr>`).join() || emptyRows(["", "", "", ""], 4)
    : emptyRows(["", "", "", ""], 4);
  const body = `
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · ⏱️ Lernzeit</small>Lernzeit- &amp; Pomodoro-Log</div>
    <div class="meta"><div>Woche ${line(20)}</div><div style="margin-top:3px">Ziel/Woche ${data ? (data.goals.week + " h") : line(18)}</div></div>
  </div>
  <div class="hint">Ein Pomodoro = eine Fokus-Einheit (${focusMin}&nbsp;Min). Pro Einheit ein Kästchen ausmalen.</div>
  <div class="section-label">Tägliches Log</div>
  <table><thead><tr><th class="c-date">Tag</th><th>Modul / Thema</th><th style="width:44mm">Pomodoros</th><th class="c-mid">Minuten</th></tr></thead><tbody>${rows}<tr style="font-weight:700"><td>Summe</td><td></td><td></td><td></td></tr></tbody></table>
  <div class="section-label">Lernzeit je Modul${data ? " (gesamt)" : " (diese Woche)"}</div>
  <table class="${data ? "data" : ""}"><thead><tr><th>Modul</th><th class="c-mid">Ziel</th><th class="c-mid">Erreicht</th><th class="c-mid">Differenz</th></tr></thead><tbody>${modRows}</tbody></table>
  <style>.pomo-cell{letter-spacing:1.2mm;font-size:10pt}</style>
  ${footer("Studien-Tracker · Lernzeit-Log", data ? `Gesamt: ${formatDuration(data.totalStudySec)} · ${data.sessions} Einheiten` : "täglich / wöchentlich")}`;
  return { title: "Lernzeit- & Pomodoro-Log", format: "portrait", body };
}

/* ============================================================
   09 — Lern-Serie / Streak (Hoch)
   ============================================================ */
export function streakTracker(data, opts = {}) {
  const hasDate = Number.isInteger(opts.year) && Number.isInteger(opts.month);
  const weeks = hasDate ? monthMatrix(opts.year, opts.month, []) : null;
  const daily = data ? data.daily : {};
  let rows;
  if (weeks) {
    rows = weeks.map((wk) => "<tr>" + wk.map((c) => {
      if (!c) return "<td></td>";
      const learned = (daily[c.iso] || 0) > 0;
      return `<td style="${learned ? "background:var(--accent);color:#fff" : ""}"><span style="font-size:7pt">${c.day}</span>${learned ? '<div style="font-size:9pt">🔥</div>' : ""}</td>`;
    }).join("") + "</tr>").join("");
  } else {
    rows = emptyRows(new Array(7).fill(""), 6);
  }
  const body = `
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · 🔥 Streak</small>Lern-Serie</div>
    <div class="meta"><div>${hasDate ? esc(MONTHS[opts.month]) + " " + opts.year : "Monat " + line()}</div></div>
  </div>
  <div class="hint">Jeden Tag mit Lernzeit ein Feld markieren. Ziel: eine lange Kette ohne Lücke.</div>
  <div class="row" style="margin-top:6px">
    <div class="col"><div class="section-label">Aktuelle Serie</div><div class="hero" style="padding:8px"><span class="big">${data ? data.streak : "&nbsp;"}</span><span>${data ? "Tage" : ""}</span></div></div>
    <div class="col"><div class="section-label">Lerntage gesamt</div><div class="hero" style="padding:8px;background:var(--accent-2)"><span class="big">${data ? data.studyDays : "&nbsp;"}</span><span></span></div></div>
    <div class="col"><div class="section-label">Lernzeit gesamt</div><div style="border:1px solid var(--border-strong);height:12mm;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700">${data ? formatDuration(data.totalStudySec) : ""}</div></div>
  </div>
  <div class="section-label">${hasDate ? "Monat" : "Kalender zum Markieren"}</div>
  <table class="cal"><thead><tr><th>Mo</th><th>Di</th><th>Mi</th><th>Do</th><th>Fr</th><th>Sa</th><th>So</th></tr></thead><tbody>${rows}</tbody></table>
  <style>.cal td{height:13mm;text-align:center;vertical-align:middle}</style>
  ${footer("Studien-Tracker · Lern-Serie", "Dranbleiben zählt")}`;
  return { title: "Lern-Serie", format: "portrait", body };
}

/* ============================================================
   10 — Fokus heute (Hoch). Mit Daten: heutige Aufgaben + Countdown.
   ============================================================ */
export function fokusHeute(data, opts = {}) {
  const dateIso = opts.date || (data ? data.today : null);
  const todays = data && dateIso ? data.scheduledTasks.filter((t) => t.date === dateIso && !t.done) : [];
  const top3 = [0, 1, 2].map((i) => {
    const t = todays[i];
    return `<tr><td class="ctr"><span class="box big"></span></td><td style="font-size:11pt">${i + 1}. ${t ? esc(t.task) + ' <span class="hint">· ' + esc(t.module) + "</span>" : ""}</td></tr>`;
  }).join("");
  const rest = todays.slice(3);
  const restRows = rest.length
    ? rest.map((t) => `<tr><td class="ctr">${box(false)}</td><td>${esc(t.task)}</td><td class="c-mid">${esc(t.module)}</td></tr>`).join("")
    : emptyRows(['class="ctr"', "", 'class="c-mid"'], 8).replace(/<td class="ctr"><\/td>/g, `<td class="ctr">${box(false)}</td>`);
  const cd = data && data.countdown;
  const body = `
  <div class="sheet-head">
    <div class="title"><small>🎓 Studien-Tracker · 🎯 Fokus</small>Fokus heute</div>
    <div class="meta"><div>Datum ${dateIso ? formatDate(dateIso) : line()}</div></div>
  </div>
  <div class="section-label">Die 3 wichtigsten Aufgaben</div>
  <table><tbody>${top3}</tbody></table>
  <div class="row" style="margin-top:8px">
    <div class="col">
      <div class="section-label">Weitere Aufgaben</div>
      <table><thead><tr><th style="width:8mm">✓</th><th>Aufgabe</th><th class="c-mid">Modul</th></tr></thead><tbody>${restRows}</tbody></table>
    </div>
    <div class="col" style="flex:0 0 46mm">
      <div class="section-label">Pomodoros heute</div>
      <div style="border:1px solid var(--grid);padding:5px;min-height:20mm"><div style="font-size:11pt;letter-spacing:1.6mm">${box()}${box()}${box()}${box()}${box()}</div><div style="font-size:11pt;letter-spacing:1.6mm;margin-top:3mm">${box()}${box()}${box()}${box()}${box()}</div></div>
      <div class="section-label">Prüfungs-Countdown</div>
      <table><tr><td class="c-mid">Nächste</td><td>${cd ? esc(cd.title) : ""}</td></tr><tr><td>Noch Tage</td><td>${cd ? cd.days : ""}</td></tr></table>
    </div>
  </div>
  <div class="section-label">Notizen</div>
  <div class="lines"><div class="ln"></div><div class="ln"></div></div>
  <style>.box.big{width:5mm;height:5mm}</style>
  ${footer("Studien-Tracker · Fokus heute", "Ein Blatt pro Tag")}`;
  return { title: "Fokus heute", format: "portrait", body };
}
