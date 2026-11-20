/* ============================================================
   PDF-Rendering über headless Chrome (CDP, ohne npm-Pakete).
   Exportiert renderPdfs(jobs) — jobs: [{ html, outPath, landscape, paper }]
   ============================================================ */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import http from "node:http";

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean);
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("Kein Chrome/Chromium gefunden. CHROME_BIN setzen.");
  return found;
}

const PORT = Number(process.env.CDP_PORT || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(path) {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: PORT, path, headers: { Connection: "close" } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}
async function waitForChrome() {
  for (let i = 0; i < 80; i++) { try { return await getJSON("/json/version"); } catch { await sleep(500); } }
  throw new Error("Chrome-DevTools-Endpoint nicht erreichbar");
}

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", (e) => rej(e.error || new Error("ws error")));
      this.ws.addEventListener("message", (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
        }
      });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

const A4 = { w: 8.27, h: 11.69 };
const A5 = { w: 5.83, h: 8.27 };

/* jobs: [{ html, outPath, landscape, paper: "a4"|"a5" }] */
export async function renderPdfs(jobs) {
  const CHROME = findChrome();
  const profile = "/tmp/st-pdf-profile-" + process.pid;
  rmSync(profile, { recursive: true, force: true });
  const child = spawn(CHROME, [
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env } });

  try {
    const ver = await waitForChrome();
    const browser = new CDP(ver.webSocketDebuggerUrl);
    await browser.open();

    for (const job of jobs) {
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
      await browser.send("Page.enable", {}, sessionId);
      // HTML direkt per data-URL laden, damit kein temporäres File nötig ist
      const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(job.html);
      await browser.send("Page.navigate", { url: dataUrl }, sessionId);
      await sleep(job.wait || 900);

      const dim = (job.paper === "a4") ? A4 : A5;
      const land = !!job.landscape;
      const res = await browser.send("Page.printToPDF", {
        printBackground: true,
        landscape: land,
        paperWidth: land ? dim.h : dim.w,
        paperHeight: land ? dim.w : dim.h,
        marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
        preferCSSPageSize: true,
      }, sessionId);
      mkdirSync(dirname(job.outPath), { recursive: true });
      writeFileSync(job.outPath, Buffer.from(res.data, "base64"));
      await browser.send("Target.closeTarget", { targetId });
      if (job.onDone) job.onDone(job.outPath);
    }
    browser.close();
  } finally {
    child.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  }
}
