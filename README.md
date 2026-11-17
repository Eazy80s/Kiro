# 🎓 Studien-Tracker

Eine schlanke Studienverwaltung, die komplett im Browser läuft – keine Installation, kein Server, kein Konto nötig. Deine Daten werden lokal im Browser gespeichert.

## Funktionen

- **📅 Kalender** – Einträge (Prüfung, Abgabe, Vorlesung, Sonstiges) mit optionaler **Uhrzeit** und **Wiederholung** (täglich/wöchentlich/monatlich). Modulaufgaben lassen sich auf Tage planen.
- **📚 Module** – pro Kurs ein Modul, gruppiert in **In Bearbeitung / Demnächst / Abgeschlossen**, ein-/ausklappbar, mit **Suche**.
- **✅ Checklisten & Teilaufgaben** – mit Fortschrittsanrechnung; Aufgaben können ein Datum bekommen.
- **📊 Fortschritt** – Gesamtfortschritt (aus abgeschlossenen Modulen, ECTS-gewichtet) und Fortschritt je Modul.
- **🎓 Noten** – deutsche Skala 1,0–5,0 (bestanden bis 4,0), **Wunschnote** je Modul, ECTS-gewichteter Durchschnitt.
- **⏱️ Pomodoro** – Fokus-Timer mit eigenen Zeiten, läuft auch im Hintergrund-Tab genau; **Lernzeit** täglich/wöchentlich/monatlich/jährlich und **je Modul**, mit einstellbaren **Zielen**.
- **🎯 Fokus heute** – zeigt die für heute geplanten Aufgaben inkl. Teilaufgaben.
- **⏳ Prüfungs-Countdown** und **Demnächst**-Liste.
- **🌓 Theme** – hell / dunkel / automatisch.
- **🔔 Erinnerungen** – Browser-Benachrichtigung für heute anstehende Prüfungen/Abgaben.
- **💾 Daten** – Export/Import als `.json`, Zurücksetzen; **Löschen mit „Rückgängig“**.
- **📱 Installierbar** (PWA) – auf dem iPhone „Zum Home-Bildschirm“, funktioniert offline (benötigt HTTPS-Hosting, siehe unten).

## Starten (lokal)

1. Repository herunterladen oder klonen.
2. **`index.html`** doppelklicken – öffnet sich im Standardbrowser.

Kein Build, keine Abhängigkeiten.

## Auf dem iPhone installieren (HTTPS-Hosting)

Zum Installieren als App braucht es eine **HTTPS-Adresse** (lokale Dateien reichen dafür nicht). Zwei einfache Wege:

- **Netlify Drop (kostenlos, ohne Konto):** Gehe auf <https://app.netlify.com/drop> und ziehe den **Projektordner** (mit `index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, `sw.js`, den Icons) in das Fenster. Du erhältst sofort eine HTTPS-URL. Diese in Safari öffnen → **Teilen → Zum Home-Bildschirm**.
- **GitHub Pages:** nur möglich, wenn das Repo **öffentlich** ist (oder mit bezahltem Plan für private Repos). Dann: Repo → Settings → Pages → Branch `main`, Ordner `/`.

## Daten

Alles liegt im **localStorage** des jeweiligen Browsers:

- Tab schließen und später öffnen → Daten sind noch da.
- Gebunden an *diesen Browser auf diesem Gerät*. Für Übertragung: **Export/Import** nutzen (z. B. über iCloud Drive).

## Tests

Automatisierte Tests der Rechenlogik (Fortschritt, GPA, Dauer, Wiederholungen):

```bash
npm test      # oder: node tests/logic.test.js
```

## Projektstruktur

| Datei | Zweck |
|------|---------|
| `index.html` | Struktur & Layout |
| `styles.css` | Styling (hell/dunkel über CSS-Variablen) |
| `app.js` | Gesamte Logik (gekapselt in einem IIFE, in klar benannte Abschnitte gegliedert) |
| `manifest.webmanifest`, `sw.js`, `icon*` | PWA (installierbar/offline) |
| `tests/logic.test.js` | Automatisierte Tests |

## Lizenz

MIT – nutze es, wie du magst.
