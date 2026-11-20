#!/usr/bin/env node
/* ============================================================
   Studien-Tracker — Druckvorlagen-Generator
   Erzeugt HTML + PDF für alle Blätter. Standardformat: A5.

   Beispiele:
     node generate.mjs                          # leere A5-Vorlagen (alle)
     node generate.mjs --paper a4               # in A4
     node generate.mjs --toner-save             # tintensparend
     node generate.mjs --data backup.json       # mit echten Daten füllen
     node generate.mjs --month 3 --year 2026    # datierter März-Kalender
     node generate.mjs --monat aktuell          # laufender + nächster Monat datiert
     node generate.mjs --von 7 --bis 22 --raster 30   # Wochenplan 7–22 Uhr, 30-Min-Takt
     node generate.mjs --todo                   # Kalender mit Mini-To-do-Spalte
     node generate.mjs --no-kw                  # Kalender ohne KW-Spalte
     node generate.mjs --zeilen 16              # Semesterübersicht mit 16 Modulzeilen
     node generate.mjs --booklet                # alle Blätter in ein Heft-PDF
     node generate.mjs --booklet --deckblatt --name "…" --studiengang "…"  # Heft mit Deckblatt
     node generate.mjs --falt                   # Faltheft: 2×A5 auf A4 (Broschüre)
     node generate.mjs --modulheft --data b.json  # alle Modulblätter in ein PDF
     node generate.mjs --batch-year 2026        # 12 Monatskalender auf einmal
     node generate.mjs --html-only              # nur HTML, kein PDF
   ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as T from "./lib/templates.mjs";
import { parseExport, MONTHS } from "./lib/data.mjs";
import { pageHtml, bookletHtml } from "./lib/render-html.mjs";
import { renderPdfs } from "./lib/pdf.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ---- Argumente parsen ---- */
function parseArgs(argv) {
  const o = {
    paper: "a5", tonerSave: false, data: null, month: null, year: null,
    booklet: false, batchYear: null, htmlOnly: false, fillable: false, only: null,
    // Wochenplan-Raster
    von: null, bis: null, raster: null,
    // Kalender
    kw: true, todo: false,
    // Semesterübersicht
    rows: null,
    // Modulheft (alle Modulblätter in ein PDF)
    modulheft: false,
    // Falt-Heft (2×A5 auf A4) + Deckblatt
    falt: false, deckblatt: false, name: null, studiengang: null,
    // laufender + nächster Monat datiert
    monatAktuell: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--paper") o.paper = (argv[++i] || "a5").toLowerCase();
    else if (a === "--toner-save") o.tonerSave = true;
    else if (a === "--data") o.data = argv[++i];
    else if (a === "--month" || a === "--monat") {
      const v = argv[++i];
      if (v === "aktuell" || v === "current") o.monatAktuell = true;  // laufender + nächster
      else o.month = parseInt(v, 10);
    }
    else if (a === "--year" || a === "--jahr") o.year = parseInt(argv[++i], 10);
    else if (a === "--booklet" || a === "--heft") o.booklet = true;
    else if (a === "--batch-year") o.batchYear = parseInt(argv[++i], 10);
    else if (a === "--html-only") o.htmlOnly = true;
    else if (a === "--fillable") { o.fillable = true; o.htmlOnly = true; }
    else if (a === "--only") o.only = argv[++i];
    else if (a === "--von") o.von = parseInt(argv[++i], 10);
    else if (a === "--bis") o.bis = parseInt(argv[++i], 10);
    else if (a === "--raster") o.raster = parseInt(argv[++i], 10);
    else if (a === "--no-kw") o.kw = false;
    else if (a === "--kw") o.kw = true;
    else if (a === "--todo") o.todo = true;
    else if (a === "--zeilen") o.rows = parseInt(argv[++i], 10);
    else if (a === "--modulheft") o.modulheft = true;
    else if (a === "--falt") o.falt = true;
    else if (a === "--deckblatt") o.deckblatt = true;
    else if (a === "--name") o.name = argv[++i];
    else if (a === "--studiengang") o.studiengang = argv[++i];
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
  }
  if (o.paper !== "a4" && o.paper !== "a5") { console.error("--paper muss a4 oder a5 sein"); process.exit(1); }
  if (o.falt) o.booklet = true;   // Falt-Heft ist eine Heft-Variante
  return o;
}
function printHelp() {
  console.log(readFileSync(resolve(__dirname, "generate.mjs"), "utf8").split("*/")[0].replace(/^[\s\S]*?Beispiele:/, "Beispiele:"));
}

const opts = parseArgs(process.argv);
const css = readFileSync(resolve(__dirname, "print.css"), "utf8");

// Optional: Daten laden
let data = null;
if (opts.data) {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), opts.data), "utf8"));
  data = parseExport(raw);
  console.log(`Daten geladen: ${data.modules.length} Module, ${data.events.length} Termine.`);
}

// Monat/Jahr Default aus heute.
const now = new Date();
const calYear = opts.year ?? now.getFullYear();
const calMonth = (opts.month != null ? opts.month - 1 : now.getMonth());
// Wann soll der Kalender datiert werden?
const datedCal = (opts.month != null || opts.year != null || opts.monatAktuell || data != null);
// Wochenplan-/Kalender-Optionen bündeln
const weekOpts = { von: opts.von, bis: opts.bis, raster: opts.raster };
const calOpts = (y, m) => ({ year: y, month: m, kw: opts.kw, todo: opts.todo });

/* ---- Blätter zusammenstellen ---- */
// Jedes Element: { name, frag } wobei frag = Template-Ergebnis
function buildSheets() {
  const sheets = [];
  const add = (name, frag) => sheets.push({ name, frag });

  add("01-semesteruebersicht", T.semesteruebersicht(data, { rows: opts.rows }));

  // Kalender: datiert bei explizitem Monat/Jahr oder Daten; sonst leer.
  // Ohne expliziten Monat, aber mit Datierungswunsch: laufender + nächster Monat.
  if (datedCal) {
    if (opts.month == null && opts.year == null) {
      const m2 = (calMonth + 1) % 12;
      const y2 = calMonth === 11 ? calYear + 1 : calYear;
      add("02-monatskalender", T.monatskalender(data, calOpts(calYear, calMonth)));
      add("02-monatskalender-naechster", T.monatskalender(data, calOpts(y2, m2)));
    } else {
      add("02-monatskalender", T.monatskalender(data, calOpts(calYear, calMonth)));
    }
  } else {
    add("02-monatskalender", T.monatskalender(data, { kw: opts.kw, todo: opts.todo }));
  }

  add("03-wochenplan", T.wochenplan(weekOpts));

  // Modul-Detailblatt: mit Daten je Modul ein Blatt, sonst ein leeres
  if (data && data.modules.length) {
    data.modules.forEach((m, i) => add(`04-modul-${String(i + 1).padStart(2, "0")}`, T.modulDetailblatt(m)));
  } else {
    add("04-modul-detailblatt", T.modulDetailblatt(null));
  }

  return opts.only ? sheets.filter((s) => s.name.includes(opts.only)) : sheets;
}

async function main() {
  const suffix = opts.tonerSave ? "-sparsam" : "";
  const htmlDir = resolve(__dirname, "html");
  const pdfDir = resolve(__dirname, "pdf");
  mkdirSync(htmlDir, { recursive: true });
  mkdirSync(pdfDir, { recursive: true });

  // --- Batch: 12 Monatskalender eines Jahres ---
  if (opts.batchYear != null) {
    const jobs = [];
    for (let m = 0; m < 12; m++) {
      const frag = T.monatskalender(data, { year: opts.batchYear, month: m });
      const html = pageHtml(frag, { paper: opts.paper, tonerSave: opts.tonerSave, inlineCss: css });
      const base = `kalender-${opts.batchYear}-${String(m + 1).padStart(2, "0")}-${MONTHS[m].toLowerCase()}${suffix}`;
      writeFileSync(join(htmlDir, base + ".html"), html);
      jobs.push({ html, outPath: join(pdfDir, base + ".pdf"), landscape: true, paper: opts.paper, onDone: (p) => console.log("✓ " + p.split("/").pop()) });
    }
    console.log(`Erzeuge 12 Monatskalender für ${opts.batchYear} (${opts.paper.toUpperCase()})…`);
    if (!opts.htmlOnly) await renderPdfs(jobs);
    console.log("Fertig.");
    return;
  }

  // --- Modulheft: alle Modul-Detailblätter in EIN PDF ---
  if (opts.modulheft) {
    const mods = (data && data.modules.length)
      ? data.modules.map((m) => T.modulDetailblatt(m))
      : [T.modulDetailblatt(null)];
    const bhtml = bookletHtml(mods, { paper: opts.paper, tonerSave: opts.tonerSave, inlineCss: css });
    const bname = `00-modulheft${suffix}`;
    writeFileSync(join(htmlDir, bname + ".html"), bhtml);
    console.log(`Erzeuge Modulheft mit ${mods.length} Blättern (${opts.paper.toUpperCase()})…`);
    if (opts.htmlOnly) { console.log("Nur HTML erzeugt (--html-only)."); return; }
    await renderPdfs([{ html: bhtml, outPath: join(pdfDir, bname + ".pdf"), landscape: false, paper: opts.paper, wait: 1200, onDone: (p) => console.log("✓ " + p.split("/").pop()) }]);
    console.log("Fertig.");
    return;
  }

  const sheets = buildSheets();

  // --- Ausfüllbare HTML-Formulare (--fillable): nur HTML, kein PDF ---
  if (opts.fillable) {
    const fillDir = resolve(__dirname, "fillable");
    mkdirSync(fillDir, { recursive: true });
    for (const s of sheets) {
      const html = pageHtml(s.frag, { paper: opts.paper, tonerSave: opts.tonerSave, inlineCss: css, fillable: true });
      writeFileSync(join(fillDir, s.name + ".html"), html);
      console.log("✓ fillable/" + s.name + ".html");
    }
    console.log(`\nFertig. ${sheets.length} ausfüllbare Formulare in print/fillable/.\nIm Browser öffnen, Felder ausfüllen, dann „Als PDF speichern“ (Strg/Cmd+P).`);
    return;
  }

  // --- HTML schreiben (einzeln) ---
  const jobs = [];
  for (const s of sheets) {
    const html = pageHtml(s.frag, { paper: opts.paper, tonerSave: opts.tonerSave, inlineCss: css });
    const base = s.name + suffix;
    writeFileSync(join(htmlDir, base + ".html"), html);
    jobs.push({ html, outPath: join(pdfDir, base + ".pdf"), landscape: s.frag.format === "landscape", paper: opts.paper, onDone: (p) => console.log("✓ " + p.split("/").pop()) });
  }

  // --- Booklet (ein Dokument) ---
  if (opts.booklet) {
    let frags = sheets.map((s) => s.frag);
    // Deckblatt voranstellen
    if (opts.deckblatt) {
      const sem = data ? (data.modules.find((m) => m.semester)?.semester || null) : null;
      frags = [T.deckblatt({ name: opts.name, studiengang: opts.studiengang, semester: sem }), ...frags];
    }
    const bhtml = bookletHtml(frags, { paper: opts.paper, tonerSave: opts.tonerSave, inlineCss: css, falt: opts.falt });
    const bname = `00-semester-heft${opts.falt ? "-falt" : ""}${suffix}`;
    writeFileSync(join(htmlDir, bname + ".html"), bhtml);
    jobs.length = 0; // beim --booklet nur das Heft rendern
    // Falt-Heft wird auf A4 gedruckt (2×A5 pro Blatt); sonst A5 wie gewählt.
    jobs.push({ html: bhtml, outPath: join(pdfDir, bname + ".pdf"), landscape: opts.falt, paper: opts.falt ? "a4" : opts.paper, wait: 1300, onDone: (p) => console.log("✓ " + p.split("/").pop()) });
  }

  console.log(`Erzeuge ${jobs.length} ${opts.booklet ? "Heft" : "Blätter"} (${opts.paper.toUpperCase()}${opts.tonerSave ? ", tintensparend" : ""}${data ? ", mit Daten" : ", leer"})…`);
  if (opts.htmlOnly) { console.log("Nur HTML erzeugt (--html-only)."); return; }
  await renderPdfs(jobs);
  console.log(`Fertig. PDFs in print/pdf/, HTML in print/html/.`);
}

main().catch((e) => { console.error("FEHLER:", e.message); process.exit(1); });
