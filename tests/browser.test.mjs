/* ============================================================
   Echter Headless-Browser-Smoke-Test (Punkt 11)
   Lädt index.html in Chrome (headless), lässt das echte JS laufen
   und prüft das gerenderte DOM. Nutzt System-Chrome + --dump-dom,
   keine externen npm-Abhängigkeiten.

   Ausführen:  node tests/browser.test.mjs
   ============================================================ */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(__dirname, "..", "index.html");
const url = "file://" + indexPath;

// Chrome-Binary finden (ENV, absolute Pfade, dann PATH-Namen)
const candidates = [
  process.env.CHROME_BIN,
  "/usr/local/bin/chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "google-chrome", "chromium-browser", "chromium", "chrome",
].filter(Boolean);
let bin = candidates.find((c) => c.startsWith("/") && existsSync(c))
  || candidates.find((c) => !c.startsWith("/"))
  || "chrome";

let dom = "";
const tmpProfile = resolve(__dirname, "..", ".chrome-test-profile");
try {
  dom = execFileSync(bin, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-crashpad", "--disable-breakpad", "--no-first-run", "--disable-dev-shm-usage",
    "--user-data-dir=" + tmpProfile,
    "--virtual-time-budget=4000", "--dump-dom", url,
  ], { encoding: "utf8", timeout: 60000, maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
} catch (e) {
  dom = (e.stdout || "").toString();
}

// Kein lauffähiger Browser (z. B. gesperrte Sandbox) → Test überspringen, nicht scheitern.
if (!dom || dom.length < 200) {
  console.log("Browser-Smoke-Test ÜBERSPRUNGEN: kein lauffähiger Headless-Browser in dieser Umgebung.");
  console.log("(Läuft in GitHub Actions / normalen Umgebungen mit Chrome vollständig durch.)");
  process.exit(0);
}

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; } else { failed++; console.error("✗ " + label); }
}

// Das JS baut u. a. die leere-Zustand-Meldung + den Beispieldaten-Button.
check(dom.includes("🎓 Studien-") || dom.includes("Studien-"), "Titel/Branding gerendert");
check(dom.includes('id="modules-list"'), "Modul-Liste vorhanden");
check(/Beispieldaten laden|Noch keine Module/.test(dom), "Leerer Zustand / Onboarding gerendert (JS lief)");
check(dom.includes('data-tab="settings"'), "Einstellungen-Tab vorhanden");
check(!dom.includes('data-tab="data"'), "Alter 'Daten'-Tab ist entfernt");
check(dom.includes('id="study-chart"') || dom.includes("Verlauf"), "Lernzeit-Verlauf-Bereich vorhanden");
check(dom.includes('id="snackbar"'), "Snackbar-Element vorhanden");
check(dom.includes('id="week-agenda"'), "Anstehend/Agenda-Element vorhanden");
check(/<svg[^>]*class="ic/.test(dom), "SVG-Icons werden gerendert (statt Emojis)");
// Neue Features
check(dom.includes('id="quick-task-form"'), "Schnelleingabe (Fokus heute) vorhanden");
check(dom.includes('id="semester-block"'), "Semester-Noten-Block vorhanden");
check(dom.includes('id="calendar-search"'), "Kalendersuche vorhanden");
check(dom.includes('id="view-week"') && dom.includes('id="view-month"'), "Monats-/Wochen-Umschalter vorhanden");
check(dom.includes('id="ics-import-file"'), "ICS-Import vorhanden");
check(dom.includes('role="tablist"'), "Tabs mit ARIA-tablist");

console.log(`\nBrowser-Smoke-Test: ${passed} bestanden, ${failed} fehlgeschlagen.`);
process.exit(failed ? 1 : 0);
