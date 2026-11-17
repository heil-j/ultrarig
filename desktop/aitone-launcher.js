"use strict";
/* AI Tone (tankgtone fork): start tankgtone with the UltraRig Editor, stop it when the editor closes.
 *
 * Loaded by one line at the top of main.js (desktop/patch_editor.py adds it). Settings come from aitone-launcher.json next to this
 * file, written by the patch script: { python, cwd, port }. If tankgtone already answers on that port (you started it yourself),
 * nothing is started and nothing is stopped. Its output goes to <userData>/tankgtone.log. Not in UR_SELFTEST runs unless
 * AITONE_LAUNCH=1, so the editor's own self-test stays as it was. */
const { app } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "aitone-launcher.json"), "utf8")); } catch { cfg = null; }

function answering(port) {
  return new Promise(resolve => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/status", timeout: 1500 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

let child = null;

async function start() {
  if (!cfg || !cfg.python || !cfg.cwd) return;
  const port = Number(cfg.port) || 8765;
  if (await answering(port)) return;                                  /* already running: leave it to whoever started it */
  if (!fs.existsSync(cfg.python) || !fs.existsSync(cfg.cwd)) return;
  let log = "ignore";
  try { log = fs.openSync(path.join(app.getPath("userData"), "tankgtone.log"), "a"); } catch { /* no log, still start */ }
  const env = { ...process.env, PYTHONUNBUFFERED: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    child = spawn(cfg.python, ["-m", "tankgtone", "ui", "--port", String(port)], {
      cwd: cfg.cwd, env, windowsHide: true, stdio: ["ignore", log, log],
    });
    child.on("exit", () => { child = null; });
    child.on("error", () => { child = null; });
  } catch { child = null; }
}

function stop() {
  if (!child) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill();
  } catch { /* already gone */ }
  child = null;
}

if (process.env.UR_SELFTEST !== "1" || process.env.AITONE_LAUNCH === "1") {
  app.whenReady().then(start);
  app.on("will-quit", stop);
}
