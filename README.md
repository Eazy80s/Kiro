# 🎓 Studien-Tracker

Eine schlanke Studienverwaltung, die komplett im Browser läuft – keine Installation, kein Server, kein Konto nötig. Deine Daten werden lokal im Browser gespeichert.

## Funktionen

- **📅 Kalender** – **Monatsansicht** und **Wochenansicht als Stundenraster (Mo–So, 08–21 Uhr)**: Posten mit Von–Bis-Uhrzeit erscheinen als Blöcke im Raster, Posten ohne feste Zeit in einer Leiste darüber. **Suche** (hebt Treffer-Tage hervor), **ICS-Import/-Export**, **Feiertage** und **Drag & Drop** (Tag und Uhrzeit).
- **➕ Ein Hinzufügen-Formular** – zwei Arten: **Aufgabe** (einem Modul zugeordnet, mit Von–Bis-Zeit und Link) oder **Prüfung** (Kalendertermin mit Wiederholung/Farbe). Aufgaben erscheinen zugleich in der Modul-Checkliste, im Kalender und in „Fokus heute".
- **📚 Module** – pro Kurs ein Modul, gruppiert in **In Bearbeitung / Demnächst / Abgeschlossen**, ein-/ausklappbar, mit **Suche**.
- **✅ Checklisten & Teilaufgaben** – mit Fortschrittsanrechnung; Aufgaben können ein Datum bekommen.
- **🎥 Lernplan (Fernstudium)** – jede Aufgabe kann eine **Von–Bis-Uhrzeit** und einen eigenen **Link** zur Plattform/Aufzeichnung tragen (anklickbar, sichere http(s)-URL). Zeitlich variable Vorlesungen erfasst du so einfach als terminierte Aufgabe mit Uhrzeit und Link — sie erscheinen als Block im Wochen-Stundenraster.
- **📊 Fortschritt** – Gesamtfortschritt (aus abgeschlossenen Modulen, ECTS-gewichtet) und Fortschritt je Modul. Optionales **ECTS-Studienziel** (z. B. 180) mit Fortschrittsanzeige „erreicht / Ziel".
- **⚠️ Aufmerksamkeit** – überfällige Aufgaben **und** überfällige Prüfungen/Abgaben gebündelt im Dashboard.
- **🗄️ Modul-Archiv** – die Modul-Abschnitte (In Bearbeitung / Demnächst / Abgeschlossen) sind einklappbar; „Abgeschlossen" startet eingeklappt.
- **🎌 Feiertage** – bundesweite gesetzliche Feiertage werden im Kalender markiert (inkl. beweglicher wie Ostern/Pfingsten).
- **🎓 Noten** – deutsche Skala 1,0–5,0 (bestanden bis 4,0), **Wunschnote** je Modul, ECTS-gewichteter Durchschnitt.
- **⏱️ Pomodoro** – Fokus-Timer mit eigenen Zeiten, läuft auch im Hintergrund-Tab genau; **Lernzeit** täglich/wöchentlich/monatlich/jährlich und **je Modul**, mit einstellbaren **Zielen**.
- **🎯 Fokus heute** – zeigt die für heute geplanten Aufgaben inkl. Teilaufgaben, mit **Schnelleingabe** zum direkten Hinzufügen einer Aufgabe für heute.
- **📊 Noten je Semester** – Verlauf des ECTS-gewichteten Schnitts pro Semester mit Trend gegenüber dem Vorsemester (im Dashboard, ab zwei benoteten Semestern).
- **🔗 Modul-Weblinks im Dashboard** – bei einem angehefteten Modul werden eingetragene Weblinks als anklickbare Chips auch unter „Aktuell in Bearbeitung" angezeigt.
- **⏳ Prüfungs-Countdown** und **Demnächst**-Liste.
- **🌓 Theme** – hell / dunkel / automatisch.
- **🔔 Erinnerungen** – Browser-Benachrichtigung für heute anstehende Prüfungen/Abgaben.
- **🎓 Teilnoten** – Endnote je Modul aus gewichteten Komponenten (z. B. Klausur 70 % + Übung 30 %).
- **📈 Noten-Prognose** – benötigter Schnitt für ein Ziel + bester/schlechtester möglicher Endschnitt.
- **🗂️ Drag & Drop** – Module und Aufgaben per Ziehen umsortieren.
- **🎨 Eigene Terminfarben**, **🖨️ Druck-/PDF-Semesterübersicht**, **🔥 Lern-Serie (Streak)**.
- **☁️ Geräte-Sync** (Supabase) mit **Konflikt-Warnung**, lokaler Sicherung und **Online/Offline-Anzeige**.
- **💾 Daten** – Export/Import als `.json`, `.ics`-Kalenderexport, Zurücksetzen; **Löschen mit „Rückgängig“**; **Fehlerprotokoll**.
- **📱 Installierbar** (PWA) – auf dem iPhone „Zum Home-Bildschirm“, funktioniert offline (benötigt HTTPS-Hosting, siehe unten).

## Starten (lokal)

1. Repository herunterladen oder klonen.
2. **`index.html`** doppelklicken – öffnet sich im Standardbrowser.

Kein Build, keine Abhängigkeiten.

## Auf dem iPhone installieren (HTTPS-Hosting)

Zum Installieren als App braucht es eine **HTTPS-Adresse** (lokale Dateien reichen dafür nicht). Zwei einfache Wege:

- **Netlify Drop (kostenlos, ohne Konto):** Gehe auf <https://app.netlify.com/drop> und ziehe den **Projektordner** (mit `index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, `sw.js`, den Icons) in das Fenster. Du erhältst sofort eine HTTPS-URL. Diese in Safari öffnen → **Teilen → Zum Home-Bildschirm**.
- **GitHub Pages:** nur möglich, wenn das Repo **öffentlich** ist (oder mit bezahltem Plan für private Repos). Dann: Repo → Settings → Pages → Branch `main`, Ordner `/`.

## Geräte-Sync mit Supabase (optional)

Standardmäßig liegen die Daten nur lokal im Browser. Mit einem kostenlosen
Supabase-Projekt synchronisiert die App automatisch zwischen Mac und iPhone.
**Ohne Anmeldung** läuft alles wie bisher rein lokal weiter.

**Einmalige Einrichtung (~10 Min):**

1. Konto auf <https://supabase.com> anlegen → **New project** erstellen.
2. **SQL Editor** öffnen → Inhalt von [`supabase-setup.sql`](supabase-setup.sql) einfügen → **Run**.
   (Legt die Tabelle `app_state` an und schützt sie per Row-Level-Security.)
3. **Project Settings → API** öffnen und zwei Werte kopieren:
   - **Project URL**
   - **anon public** Key
4. Diese beiden Werte in [`supabase-config.js`](supabase-config.js) eintragen
   (die Platzhalter `DEINE_…` ersetzen) und die Änderung pushen/neu deployen.
   *(Der anon-Key ist für den Browser gedacht und darf öffentlich stehen — der
   Schutz kommt über Login + Row-Level-Security.)*

**Benutzung:** In der App **Einstellungen → Synchronisierung** → E-Mail eingeben →
Anmeldelink anfordern → Link **auf demselben Gerät** öffnen. Danach synct die App
automatisch; auf einem zweiten Gerät meldest du dich mit derselben E-Mail an.

- Konfliktstrategie: **zuletzt gespeichert gewinnt** (das zuletzt aktive Gerät setzt den Stand).
- Abgleich erfolgt beim Anmelden, beim Zurückkehren in den Tab und nach jeder Änderung.

## Daten (lokal)

Ohne Sync liegt alles im **localStorage** des jeweiligen Browsers:

- Tab schließen und später öffnen → Daten sind noch da.
- Gebunden an *diesen Browser auf diesem Gerät*. Für Übertragung ohne Sync: **Export/Import** nutzen.

## Tests

```bash
npm test              # Rechenlogik (gespiegelt) + Sicherheit/Migration (echte app.js)
npm run test:browser  # echter Headless-Chrome-Smoke-Test (überspringt, wenn kein Browser da ist)
npm run test:all      # alles
```

- `tests/logic.test.js` – Rechenlogik (Fortschritt, GPA, Teilnoten, Wiederholungen, Streak …).
- `tests/security.test.mjs` – lädt **die echte `app.js`** (per `node:vm` mit DOM-Stubs) und prüft `escapeHtml`, `sanitizeUrl`, `sanitizeHexColor` und `migrate` direkt am Produktionscode (kein Spiegeln → kein Drift).

Bei jedem Push laufen beide Tests automatisch über GitHub Actions.

## Projektstruktur

| Datei | Zweck |
|------|---------|
| `index.html` | Struktur & Layout |
| `styles.css` | Styling (hell/dunkel über CSS-Variablen) |
| `app.js` | Gesamte Logik (gekapselt in einem IIFE, in klar benannte Abschnitte gegliedert) |
| `manifest.webmanifest`, `sw.js`, `icon*` | PWA (installierbar/offline) |
| `supabase-config.js` | Deine Supabase-Zugangsdaten (Platzhalter — selbst ausfüllen) |
| `supabase-setup.sql` | Einmaliges SQL-Setup für dein Supabase-Projekt |
| `tests/logic.test.js` | Automatisierte Tests der Rechenlogik |
| `tests/security.test.mjs` | Sicherheits-/Migrationstests gegen die echte `app.js` |

## Lizenz

MIT – nutze es, wie du magst.
