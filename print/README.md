# 🖨️ Druckvorlagen — analoge Version des Studien-Trackers

Vier druckbare Vorlagen im Look der App, **auf A5 optimiert** (jedes Blatt füllt
die A5-Seite komplett). A4 optional. Jedes Blatt gibt es **leer** (zum
Handausfüllen), **mit deinen echten Daten** (aus dem JSON-Export) oder als
**ausfüllbares Formular**.

## Schnellstart

```bash
cd print
node generate.mjs                 # alle leeren A5-Vorlagen → print/pdf/
```

Fertige PDFs liegen in [`pdf/`](pdf/). Zum Drucken öffnen (im Druckdialog
**„Tatsächliche Größe/100 %“** und **Hintergrundgrafiken** aktivieren).

## Die vier Blätter

| # | Blatt | Format | Zweck |
|---|-------|--------|-------|
| 01 | Semesterübersicht | A5 hoch | Eckdaten, Termine, alle Module auf einen Blick |
| 02 | Monatskalender | A5 quer | Prüfung/Abgabe/Vorlesung/Sonstiges (datierbar) |
| 03 | Wochenplan | A5 quer | Stundenraster 08–20 Uhr |
| 04 | Modul-Detailblatt | A5 hoch | Checkliste, Teilaufgaben, Fortschritt, Notizen |

## Optionen (kombinierbar)

```bash
node generate.mjs --paper a4            # in A4 statt A5
node generate.mjs --toner-save          # tintensparend (Graustufen)
node generate.mjs --data backup.json    # mit deinen echten Daten füllen
node generate.mjs --fillable            # ausfüllbare HTML-Formulare (am PC tippen)
node generate.mjs --only kalender       # nur ein bestimmtes Blatt
node generate.mjs --html-only           # nur HTML, kein PDF
```

### Kalender

```bash
node generate.mjs --month 3 --year 2026  # datierter März-Kalender
node generate.mjs --monat aktuell        # laufender + nächster Monat datiert
node generate.mjs --todo                 # Mini-To-do-Spalte „Diesen Monat erledigen“
node generate.mjs --no-kw                # ohne Kalenderwochen-Spalte (standardmäßig an)
node generate.mjs --batch-year 2026      # 12 Monatskalender auf einmal
```

Die **KW-Spalte** (Kalenderwochen, ISO) ist standardmäßig links eingeblendet.

### Wochenplan-Zeitraster

```bash
node generate.mjs --von 7 --bis 22       # 07–22 Uhr statt 08–20
node generate.mjs --raster 30            # 30-Minuten-Takt (15/20/30/45/60/90/120)
node generate.mjs --von 8 --bis 20 --raster 90   # 90-Minuten-Blöcke
```

### Semesterübersicht

```bash
node generate.mjs --zeilen 16            # 16 Modulzeilen (Standard 12)
```

### Hefte

```bash
node generate.mjs --booklet              # alle Blätter in EIN Heft-PDF
node generate.mjs --booklet --deckblatt --name "…" --studiengang "…"   # Heft mit Deckblatt
node generate.mjs --modulheft --data b.json   # alle Modul-Detailblätter in EIN PDF
node generate.mjs --falt                 # Faltheft: 2×A5 auf A4-quer (Broschüre)
```

Das **Deckblatt** trägt Name, Studiengang, Semester und Zeitraum (Semester wird
aus `--data` übernommen, falls vorhanden). Das **Faltheft** legt je zwei A5-Seiten
nebeneinander auf ein A4-Querblatt mit Falz-/Schnittlinien — zum Falten und Heften.

### Mit echten Daten (`--data`)

1. In der App: **Einstellungen → Sicherung & Daten → Exportieren (.json)**.
2. `node generate.mjs --data study-tracker-backup-….json`

Dann zeigen die Blätter deinen Stand: Module mit Status/Note/Fortschritt, den
ECTS-gewichteten Schnitt, den datierten Kalender mit deinen Terminen. Mit Daten
bekommt jedes Modul ein eigenes Detailblatt (04). Eine
[`beispiel-daten.json`](beispiel-daten.json) liegt zum Ausprobieren bei:

```bash
node generate.mjs --data beispiel-daten.json
```

### Ausfüllbar am Computer (`--fillable`)

Erzeugt HTML-Formulare in `print/fillable/`. Im Browser öffnen, in die Felder
tippen, dann **Strg/Cmd+P → „Als PDF speichern“**.

### Tintensparend (`--toner-save`)

Reine Graustufen ohne farbige Flächen. Dateien bekommen den Zusatz `-sparsam`.

## Direkt in der App drucken

In der App gibt es unter **Einstellungen → Export & Druck** den Button
**„Papierversion drucken“** — erzeugt eine Übersicht aus deinen Live-Daten
direkt im Browser (Druckdialog → „Als PDF sichern“).

## Anpassen

- **Inhalt/Felder:** [`lib/templates.mjs`](lib/templates.mjs)
- **Aussehen** (A5/A4, Ränder, Zeilenhöhen, Toner-Save): [`print.css`](print.css)
- **Datenlogik** (Parsen des Exports, Berechnungen): [`lib/data.mjs`](lib/data.mjs)

## Technik

Reines Node.js + installiertes Chrome/Chromium, **keine npm-Abhängigkeiten**.
`generate.mjs` baut HTML aus den Templates und rendert daraus PDFs über headless
Chrome (CDP). Wird Chrome nicht gefunden, Pfad setzen:

```bash
CHROME_BIN="/pfad/zu/chrome" node generate.mjs
```

Jedes Blatt füllt die A5-Seite vertikal: `.sheet` ist eine Flex-Spalte über die
volle Seitenhöhe, die Haupttabelle (`.grow`) dehnt sich auf den Rest aus.

| Datei | Zweck |
|------|-------|
| `generate.mjs` | CLI — erzeugt HTML & PDF |
| `print.css` | gemeinsames Stylesheet (A5/A4, Toner-Save) |
| `lib/templates.mjs` | die vier Blatt-Templates |
| `lib/data.mjs` | Export-Parser + Berechnungen (spiegelt app.js) |
| `lib/render-html.mjs` | HTML-Gerüst, Heft, ausfüllbare Variante |
| `lib/pdf.mjs` | PDF-Rendering über Chrome (CDP) |
| `pdf/` | fertige PDFs (leere A5-Vorlagen + Heft) |
| `beispiel-daten.json` | Beispiel-Export zum Ausprobieren |
