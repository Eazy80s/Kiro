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
export function bookletHtml(fragments, { paper = "a5", tonerSave = false, inlineCss } = {}) {
  const cls = tonerSave ? "toner-save" : "";
  // Jede Seite in einen Wrapper mit passender @page-Größe.
  // Da @page global ist, nutzen wir einheitliche Ausrichtung je Heft nicht —
  // stattdessen named pages pro Ausrichtung.
  const pages = fragments.map((f, i) => {
    const orient = f.format === "landscape" ? "landscape" : "portrait";
    const last = i === fragments.length - 1;
    return `<section class="booklet-page page-${orient}${last ? "" : " page-break"}">${f.body}</section>`;
  }).join("\n");
  const namedPages = `
    @page portrait-page { size: ${paper.toUpperCase()} portrait; margin: 10mm 9mm 9mm 9mm; }
    @page landscape-page { size: ${paper.toUpperCase()} landscape; margin: 9mm 9mm 9mm 9mm; }
    .page-portrait { page: portrait-page; }
    .page-landscape { page: landscape-page; }
    .booklet-page { }`;
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

function escape(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
