/* ============================================================
   Rendert alle HTML-Druckvorlagen zu PDF.
   Startet den gebündelten Chromium headless mit CDP und nutzt
   Page.printToPDF über die DevTools-WebSocket (ohne npm-Pakete).
   ============================================================ */
import { spawn } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Chrome/Chromium finden: ENV zuerst, dann übliche System-Pfade.
function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean);
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      "Kein Chrome/Chromium gefunden. Pfad über Umgebungsvariable CHROME_BIN setzen,\n" +
      "z. B.: CHROME_BIN=\"/pfad/zu/chrome\" node render.mjs"
    );
  }
  return found;
}
const CHROME = findChrome();
const PORT = 9333;
const outDir = resolve(__dirname, "pdf");
mkdirSync(outDir, { recursive: true });

// Querformat-Blätter (Kalender/Wochenplan)
const landscape = new Set(["02-monatskalender", "03-wochenplan"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(path) {
  return new Promise((resolveP, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolveP(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try { return await getJSON("/json/version"); }
    catch { await sleep(500); }
  }
  throw new Error("Chrome-DevTools-Endpoint nicht erreichbar");
}

// Minimaler CDP-Client über WebSocket (Node 22 hat globales WebSocket)
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", (e) => rej(e.error || new Error("ws error")));
      this.ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

async function main() {
  const profile = "/tmp/pdf-render-profile";
  const crashDb = "/tmp/pdf-crashpad";
  mkdirSync(crashDb, { recursive: true });
  const child = spawn(CHROME, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-breakpad", "--disable-crash-reporter",
    "--crash-dumps-dir=" + crashDb,
    "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + profile,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env } });

  try {
    const ver = await waitForChrome();
    // Browser-weite CDP-Verbindung
    const browser = new CDP(ver.webSocketDebuggerUrl);
    await browser.open();

    const files = readdirSync(__dirname).filter((f) => /^\d\d-.*\.html$/.test(f)).sort();
    for (const f of files) {
      const name = basename(f, ".html");
      const url = "file://" + join(__dirname, f);

      // Neues Tab/Target erstellen und daran attachen
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });

      // Session-gebundenes send
      const sessionSend = (method, params = {}) => {
        const id = ++browser.id;
        return new Promise((res, rej) => {
          browser.pending.set(id, { res, rej });
          browser.ws.send(JSON.stringify({ id, method, params, sessionId }));
        });
      };

      await sessionSend("Page.enable");
      await sessionSend("Page.navigate", { url });
      await sleep(1100); // CSS/Fonts settle

      const isLand = landscape.has(name);
      const res = await sessionSend("Page.printToPDF", {
        printBackground: true,
        landscape: isLand,
        paperWidth: isLand ? 11.69 : 8.27,   // A4 in Zoll
        paperHeight: isLand ? 8.27 : 11.69,
        marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
        preferCSSPageSize: true,
      });
      writeFileSync(join(outDir, name + ".pdf"), Buffer.from(res.data, "base64"));
      console.log("\u2713 " + name + ".pdf");
      await browser.send("Target.closeTarget", { targetId });
    }
    browser.close();
    console.log("\nFertig: " + files.length + " PDFs in print/pdf/");
  } finally {
    child.kill("SIGKILL");
  }
}

main().catch((e) => { console.error("FEHLER:", e.message); process.exit(1); });
