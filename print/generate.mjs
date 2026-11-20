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
     node generate.mjs --booklet                # alles in ein Heft-PDF
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
  const o = { paper: "a5", tonerSave: false, data: null, month: null, year: null, booklet: false, batchYear: null, htmlOnly: false, fillable: false, only: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--paper") o.paper = (argv[++i] || "a5").toLowerCase();
    else if (a === "--toner-save") o.tonerSave = true;
    else if (a === "--data") o.data = argv[++i];
    else if (a === "--month") o.month = parseInt(argv[++i], 10);
    else if (a === "--year") o.year = parseInt(argv[++i], 10);
    else if (a === "--booklet") o.booklet = true;
    else if (a === "--batch-year") o.batchYear = parseInt(argv[++i], 10);
    else if (a === "--html-only") o.htmlOnly = true;
    else if (a === "--fillable") { o.fillable = true; o.htmlOnly = true; }
    else if (a === "--only") o.only = argv[++i];
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
  }
  if (o.paper !== "a4" && o.paper !== "a5") { console.error("--paper muss a4 oder a5 sein"); process.exit(1); }
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

// Monat/Jahr Default aus heute, wenn Daten da sind
const now = new Date();
const calYear = opts.year ?? now.getFullYear();
const calMonth = (opts.month != null ? opts.month - 1 : now.getMonth());

/* ---- Blätter zusammenstellen ---- */
// Jedes Element: { name, frag } wobei frag = Template-Ergebnis
function buildSheets() {
  const sheets = [];
  const add = (name, frag) => sheets.push({ name, frag });

  add("01-semesteruebersicht", T.semesteruebersicht(data));
  add("02-monatskalender", T.monatskalender(data, (opts.month != null || data) ? { year: calYear, month: calMonth } : {}));
  add("03-wochenplan", T.wochenplan());

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
    const bhtml = bookletHtml(sheets.map((s) => s.frag), { paper: opts.paper, tonerSave: opts.tonerSave, inlineCss: css });
    const bname = `00-semester-heft${suffix}`;
    writeFileSync(join(htmlDir, bname + ".html"), bhtml);
    // Portrait als Basis; einzelne Querseiten steuert @page im Dokument.
    jobs.length = 0; // beim --booklet nur das Heft rendern
    jobs.push({ html: bhtml, outPath: join(pdfDir, bname + ".pdf"), landscape: false, paper: opts.paper, wait: 1200, onDone: (p) => console.log("✓ " + p.split("/").pop()) });
  }

  console.log(`Erzeuge ${jobs.length} ${opts.booklet ? "Heft" : "Blätter"} (${opts.paper.toUpperCase()}${opts.tonerSave ? ", tintensparend" : ""}${data ? ", mit Daten" : ", leer"})…`);
  if (opts.htmlOnly) { console.log("Nur HTML erzeugt (--html-only)."); return; }
  await renderPdfs(jobs);
  console.log(`Fertig. PDFs in print/pdf/, HTML in print/html/.`);
}

main().catch((e) => { console.error("FEHLER:", e.message); process.exit(1); });
