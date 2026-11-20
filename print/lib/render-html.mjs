/* Baut vollständige HTML-Dokumente aus Template-Fragmenten. */

const FORMAT_CLASS = {
  "a5-portrait": "fmt-a5-portrait",
  "a5-landscape": "fmt-a5-landscape",
  "a4-portrait": "fmt-a4-portrait",
  "a4-landscape": "fmt-a4-landscape",
};

// Ausfüllbare Variante: leere Schreibfelder werden am Bildschirm
// anklickbar/beschreibbar. Beim Drucken/Als-PDF-Speichern bleibt der
// getippte Text erhalten, die Hilfsrahmen verschwinden.
const FILLABLE_CSS = `
  @media screen {
    html.fillable [contenteditable] { outline: 1px dashed #c3c8d0; border-radius: 2px; min-height: 1em; cursor: text; }
    html.fillable [contenteditable]:focus { outline: 1.5px solid var(--accent); background: #f6f7ff; }
    html.fillable tbody td[contenteditable] { background: #fcfcfe; }
    html.fillable .fill-hint { position: fixed; top: 0; left: 0; right: 0; background: var(--accent); color: #fff; font-size: 11px; padding: 4px 8px; z-index: 99; text-align: center; }
    html.fillable body { padding-top: 24px; }
  }
  @media print { html.fillable [contenteditable] { outline: none !important; background: none !important; } html.fillable .fill-hint { display: none; } }
`;
const FILLABLE_JS = `
  (function () {
    // Leere Zellen, Schreiblinien und Meta-Linien beschreibbar machen.
    document.querySelectorAll('tbody td').forEach(function (td) {
      if (!td.children.length && !td.textContent.trim()) td.setAttribute('contenteditable', 'true');
    });
    document.querySelectorAll('.lines .ln').forEach(function (el) { el.setAttribute('contenteditable', 'true'); });
    document.querySelectorAll('.line').forEach(function (el) {
      var s = document.createElement('span');
      s.setAttribute('contenteditable', 'true');
      s.style.cssText = 'display:inline-block;min-width:' + (el.style.minWidth || '34mm') + ';border-bottom:1px solid #9aa1ab';
      el.replaceWith(s);
    });
    var hint = document.createElement('div');
    hint.className = 'fill-hint no-print';
    hint.textContent = 'Ausfüllbar: Felder anklicken und tippen. Danach drucken oder \\u201eAls PDF speichern\\u201c (Strg/Cmd+P).';
    document.body.insertBefore(hint, document.body.firstChild);
  })();
`;

// CSS-Pfad relativ (im print/-Ordner) oder eingebettet (fürs Heft)
export function pageHtml(fragment, { paper = "a5", tonerSave = false, cssHref = "print.css", inlineCss = null, fillable = false } = {}) {
  const orient = fragment.format === "landscape" ? "landscape" : "portrait";
  const fmt = FORMAT_CLASS[`${paper}-${orient}`];
  const cls = [fmt, tonerSave ? "toner-save" : "", fillable ? "fillable" : ""].filter(Boolean).join(" ");
  const style = inlineCss ? `<style>${inlineCss}</style>` : `<link rel="stylesheet" href="${cssHref}">`;
  // @page-Größe muss zur Ausrichtung passen
  const pageSize = `@page { size: ${paper.toUpperCase()} ${orient}; }`;
  return `<!doctype html>
<html lang="de" class="${cls}">
<head>
<meta charset="utf-8">
<title>${escape(fragment.title)}</title>
${style}
<style>${pageSize}${fillable ? FILLABLE_CSS : ""}</style>
</head>
<body>
${fragment.body}
${fillable ? `<script>${FILLABLE_JS}</script>` : ""}
</body>
</html>`;
}

// Mehrere Fragmente zu einem Heft (ein Dokument, Seitenumbrüche)
export function bookletHtml(fragments, { paper = "a5", tonerSave = false, inlineCss, falt = false } = {}) {
  const cls = tonerSave ? "toner-save" : "";

  // --- Falt-Heft: 2×A5 nebeneinander auf A4-quer (zum Falten/Broschüre) ---
  if (falt) return faltHtml(fragments, { tonerSave, inlineCss });

  // Jede Seite in einen Wrapper mit passender @page-Größe (named pages pro Ausrichtung).
  const pages = fragments.map((f, i) => {
    const orient = f.format === "landscape" ? "landscape" : "portrait";
    const last = i === fragments.length - 1;
    return `<section class="booklet-page page-${orient}${last ? "" : " page-break"}">${f.body}</section>`;
  }).join("\n");
  const namedPages = `
    @page portrait-page { size: ${paper.toUpperCase()} portrait; margin: 8mm 8mm 7mm 8mm; }
    @page landscape-page { size: ${paper.toUpperCase()} landscape; margin: 7mm 8mm; }
    .page-portrait { page: portrait-page; }
    .page-landscape { page: landscape-page; }
    /* Im Heft darf .sheet nicht per 100vh überlaufen (sonst Extra-Seiten). */
    html, body { height: auto; }
    .booklet-page { display: block; }
    .booklet-page > .sheet { min-height: 0; height: auto; }
    .page-break { break-after: page; page-break-after: always; }`;
  return `<!doctype html>
<html lang="de" class="fmt-${paper}-portrait ${cls}">
<head>
<meta charset="utf-8">
<title>Studien-Tracker — Semester-Heft</title>
<style>${inlineCss}</style>
<style>${namedPages}</style>
</head>
<body>
${pages}
</body>
</html>`;
}

/* Falt-Heft: je zwei A5-Blätter nebeneinander auf einem A4-Querblatt.
   Gemischte Ausrichtungen werden auf A5-Hochformat normiert (Querblätter
   werden in eine A5-Hochzelle skaliert), damit das 2-up-Raster passt. */
function faltHtml(fragments, { tonerSave = false, inlineCss } = {}) {
  const cls = tonerSave ? "toner-save" : "";
  // Zellen: jede Seite in eine A5-Hochzelle; Querblätter werden skaliert gedreht.
  const cells = fragments.map((f) => {
    const land = f.format === "landscape";
    // Querblätter als skalierte, gedrehte A5-Landscape-Fläche in die Hochzelle legen.
    const inner = land
      ? `<div class="rot"><div class="rot-inner fmt-a5-landscape">${f.body}</div></div>`
      : f.body;
    return `<div class="cell${land ? " cell-land" : ""}">${inner}</div>`;
  });
  // In Paare gruppieren (2 Zellen je A4-Querseite).
  let sheetsHtml = "";
  for (let i = 0; i < cells.length; i += 2) {
    const pair = cells.slice(i, i + 2);
    while (pair.length < 2) pair.push('<div class="cell"></div>');
    const last = i + 2 >= cells.length;
    sheetsHtml += `<section class="falt-sheet${last ? "" : " page-break"}">${pair.join("")}</section>`;
  }
  const faltCss = `
    @page { size: A4 landscape; margin: 6mm; }
    html, body { height: auto; }
    .falt-sheet { display: flex; gap: 6mm; height: 192mm; }
    .falt-sheet .cell {
      flex: 1 1 50%; width: 50%; border: 1px dashed var(--border);
      padding: 4mm; overflow: hidden; position: relative;
    }
    .falt-sheet .cell > .sheet { min-height: 100%; height: 100%; }
    /* Querblatt in A5-Hochzelle: 90° drehen und einpassen */
    .rot { position: absolute; inset: 4mm; }
    .rot-inner { width: 192mm; height: 128mm; transform: rotate(90deg) translateY(-128mm); transform-origin: top left; }
    .rot-inner > .sheet { min-height: 128mm; height: 128mm; }
    .page-break { break-after: page; page-break-after: always; }`;
  return `<!doctype html>
<html lang="de" class="fmt-a5-portrait ${cls}">
<head>
<meta charset="utf-8">
<title>Studien-Tracker — Faltheft</title>
<style>${inlineCss}</style>
<style>${faltCss}</style>
</head>
<body>
${sheetsHtml}
</body>
</html>`;
}

function escape(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
