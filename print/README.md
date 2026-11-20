# 🖨️ Druckvorlagen — analoge Version des Studien-Trackers

Zehn A4-Vorlagen zum Ausdrucken, die die Funktionen der App auf Papier abbilden.
Gleicher Look wie die App (Farben aus `styles.css`), fertige **PDFs** liegen in [`pdf/`](pdf/).

## Die Blätter

| # | Datei (PDF) | Ausrichtung | Zweck |
|---|-------------|-------------|-------|
| 01 | `01-semesteruebersicht.pdf` | Hoch | Semesterziele, Eckdaten, alle Module auf einen Blick |
| 02 | `02-monatskalender.pdf` | Quer | Monatskalender (Prüfung/Abgabe/Vorlesung/Sonstiges) |
| 03 | `03-wochenplan.pdf` | Quer | Wochenplan mit Stundenraster 08–20 Uhr |
| 04 | `04-modul-uebersicht.pdf` | Hoch | Module nach „In Bearbeitung / Demnächst / Abgeschlossen“ |
| 05 | `05-modul-detailblatt.pdf` | Hoch | Ein Blatt pro Modul: Checkliste, Teilaufgaben, Fortschritt, Notizen |
| 06 | `06-noten-tracker.pdf` | Hoch | Noten (1,0–5,0), ECTS-Gewichtung, Schnitt, Prognose |
| 07 | `07-teilnoten-rechner.pdf` | Hoch | Endnote je Modul aus gewichteten Komponenten |
| 08 | `08-lernzeit-pomodoro-log.pdf` | Hoch | Tägliches Lernzeit-/Pomodoro-Log + Ziel je Modul |
| 09 | `09-streak-tracker.pdf` | Hoch | Lern-Serie (Streak) zum Ausmalen |
| 10 | `10-fokus-heute.pdf` | Hoch | Fokus heute: Top-3-Aufgaben, Pomodoros, Countdown |

## Drucken

Die PDFs sind echtes **A4** (Hoch- bzw. Querformat je Blatt). Einfach die
Dateien in `pdf/` öffnen und drucken. Tipp: im Druckdialog **„Tatsächliche
Größe“ / „100 %“** und **Hintergrundgrafiken** aktivieren.

## PDFs neu erzeugen

Die PDFs werden aus den HTML-Vorlagen gerendert. Dafür braucht es nur
Node.js und ein installiertes Chrome/Chromium:

```bash
cd print
node render.mjs            # erzeugt alle PDFs in print/pdf/
# Falls Chrome nicht automatisch gefunden wird:
CHROME_BIN="/pfad/zu/chrome" node render.mjs
```

## Anpassen

- **Inhalt/Felder:** die jeweilige `NN-*.html` bearbeiten.
- **Aussehen** (Farben, Rahmen, Zeilenhöhen): zentral in `print.css`.

Danach `node render.mjs` erneut ausführen.
