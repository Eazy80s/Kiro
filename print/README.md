# 🖨️ Druckvorlagen — analoge Version des Studien-Trackers

Druckbare Vorlagen, die die Funktionen der App auf Papier abbilden — im selben
Look wie die App. **Standardformat: A5** (kleiner, fürs Ringbuch/Notizbuch),
A4 optional. Alle Blätter lassen sich **leer** (zum Handausfüllen), **mit deinen
echten Daten** (aus dem JSON-Export) oder als **ausfüllbares Formular** erzeugen.

## Schnellstart

```bash
cd print
node generate.mjs                 # alle leeren A5-Vorlagen → print/pdf/
```

Fertige PDFs landen in [`pdf/`](pdf/). Zum Drucken einfach öffnen (im Druckdialog
**„Tatsächliche Größe/100 %“** und **Hintergrundgrafiken** aktivieren).

## Die zehn Blätter

| # | Blatt | Format | Zweck |
|---|-------|--------|-------|
| 01 | Semesterübersicht | A5 hoch | Ziele, Eckdaten, alle Module auf einen Blick |
| 02 | Monatskalender | A5 quer | Prüfung/Abgabe/Vorlesung/Sonstiges (datierbar) |
| 03 | Wochenplan | A5 quer | Stundenraster 08–20 Uhr |
| 04 | Modul-Übersicht | A5 hoch | In Bearbeitung / Demnächst / Abgeschlossen |
| 05 | Modul-Detailblatt | A5 hoch | Checkliste, Teilaufgaben, Fortschritt, Notizen |
| 06 | Noten-Tracker | A5 hoch | Skala 1,0–5,0, ECTS-gewichtet, Prognose |
| 07 | Teilnoten-Rechner | A5 hoch | Endnote aus gewichteten Komponenten |
| 08 | Lernzeit-/Pomodoro-Log | A5 hoch | tägliches Log + Ziel je Modul |
| 09 | Lern-Serie (Streak) | A5 hoch | Kalender zum Markieren |
| 10 | Fokus heute | A5 hoch | Top-3-Aufgaben, Pomodoros, Countdown |

## Optionen (alle kombinierbar)

```bash
node generate.mjs --paper a4            # in A4 statt A5
node generate.mjs --toner-save          # tintensparend (Graustufen, keine Flächen)
node generate.mjs --data backup.json    # mit deinen echten Daten füllen
node generate.mjs --month 3 --year 2026 # datierter Kalender (echte Tageszahlen)
node generate.mjs --booklet             # alles in EIN Heft-PDF (00-semester-heft.pdf)
node generate.mjs --batch-year 2026     # 12 Monatskalender auf einmal
node generate.mjs --fillable            # ausfüllbare HTML-Formulare (am PC tippen)
node generate.mjs --only noten          # nur bestimmte Blätter
node generate.mjs --html-only           # nur HTML, kein PDF
```

### Mit echten Daten (`--data`)

1. In der App: **Einstellungen → Sicherung & Daten → Exportieren (.json)**.
2. `node generate.mjs --data study-tracker-backup-….json`

Dann sind die Blätter kein Leerformular, sondern dein aktueller Stand:
Module mit Status/Note/Fortschritt, der ECTS-gewichtete Schnitt und die
Best-/Worst-Prognose, der datierte Kalender mit deinen Terminen, Lernzeit je
Modul und die aktuelle Lern-Serie. Mit Daten bekommt jedes Modul ein eigenes
Detailblatt (05) und jedes Modul mit Teilnoten ein Teilnoten-Blatt (07).

Eine [`beispiel-daten.json`](beispiel-daten.json) liegt zum Ausprobieren bei:

```bash
node generate.mjs --data beispiel-daten.json --booklet
```

### Ausfüllbar am Computer (`--fillable`)

Erzeugt HTML-Formulare in `print/fillable/`. Im Browser öffnen, in die Felder
tippen, dann **Strg/Cmd+P → „Als PDF speichern“**. Gut, wenn du mal digital,
mal analog arbeitest.

### Tintensparend (`--toner-save`)

Rein weiße/graue Variante ohne farbige Flächen — spart Tinte beim
Schwarzweißdruck. Dateien bekommen den Zusatz `-sparsam`.

## Direkt in der App drucken

Du musst nicht zwingend dieses Skript nutzen: In der App gibt es unter
**Einstellungen → Export & Druck** den Button **„Papierversion drucken“**.
Der erzeugt dieselbe Übersicht aus deinen Live-Daten direkt im Browser
(Druckdialog → „Als PDF sichern“). Die Skript-Vorlagen hier bieten zusätzlich
die leeren Blätter, Kalender, A5/Toner-Varianten und das gebündelte Heft.

## Anpassen

- **Inhalt/Felder:** Templates in [`lib/templates.mjs`](lib/templates.mjs).
- **Aussehen** (Farben, Rahmen, Zeilenhöhen, A5/A4, Toner-Save): [`print.css`](print.css).
- **Datenlogik** (Parsen des Exports, Berechnungen): [`lib/data.mjs`](lib/data.mjs).

## Technik

Reines Node.js + ein installiertes Chrome/Chromium, **keine npm-Abhängigkeiten**.
`generate.mjs` baut HTML aus den Templates und rendert daraus PDFs über headless
Chrome (CDP). Wird Chrome nicht automatisch gefunden, Pfad setzen:

```bash
CHROME_BIN="/pfad/zu/chrome" node generate.mjs
```

| Datei | Zweck |
|------|-------|
| `generate.mjs` | CLI — erzeugt HTML & PDF |
| `print.css` | gemeinsames Stylesheet (A5/A4, Toner-Save) |
| `lib/templates.mjs` | die zehn Blatt-Templates |
| `lib/data.mjs` | Export-Parser + Berechnungen (spiegelt app.js) |
| `lib/render-html.mjs` | HTML-Gerüst, Heft, ausfüllbare Variante |
| `lib/pdf.mjs` | PDF-Rendering über Chrome (CDP) |
| `pdf/` | fertige PDFs (leere A5-Vorlagen + Beispiel-Heft) |
| `fillable/` | ausfüllbare HTML-Formulare |
| `beispiel-daten.json` | Beispiel-Export zum Ausprobieren |
