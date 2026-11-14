/* AI tone (tankgtone fork of UltraRig).
 *
 * Describe a tone in words; the tankgtone AI tone generator builds an UltraRig chain from the effects, captures and cab IRs that are
 * on THIS pedal and returns it as a standard "ultrarig-preset" document. The page loads it straight away with its own importer
 * (pioImport: every value clamped to the pedal's ranges, blocks that don't fit in CPU stay off), so the new sound plays at once. It
 * stays unsaved until you save it to a slot, like an imported preset: your saved presets are never touched.
 *
 * Runs after the main script and uses its globals: S, DEMO, T, toast, lookOf, plabel, pioImport, pioLib, PIO_LIBEND, PIO_DEMO_LIBS,
 * pioSendLive, pioSaveFile, pioFileName, edCount, bleRo, BLE_RO_NOTE, APP.
 *
 * The AI runs in tankgtone (it holds the API key; the page never sees it):
 *   python -m tankgtone ui          then open http://127.0.0.1:8765/ultrarig/
 * Opened from disk (web/tankg.html) the page calls http://127.0.0.1:8765 instead (changeable under "AI server").
 */
(function () {
  "use strict";
  if (typeof S === "undefined" || typeof pioImport !== "function") return;   /* (a page without the preset importer: nothing to hook into) */

  const SRV_KEY = "ultrarig.aiServer", OPT_KEY = "ultrarig.aiOpts", DEF_SRV = "http://127.0.0.1:8765", TIMEOUT_MS = 480000;   /* (free models think slowly and may be retried one after another) */
  const sameOrigin = /^https?:$/.test(location.protocol) && /^\/ultrarig(\/|$)/.test(location.pathname);
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window: only for this visit */ } } };
  const server = () => sameOrigin ? "" : (store.get(SRV_KEY, DEF_SRV) || DEF_SRV).replace(/\/+$/, "");
  const opts = (() => { try { return Object.assign({ auto: true, cur: false }, JSON.parse(store.get(OPT_KEY, "{}"))); } catch (e) { return { auto: true, cur: false }; } })();
  const saveOpts = () => store.set(OPT_KEY, JSON.stringify(opts));
  const tr = (s, v) => (typeof T === "function" ? T(s, v) : s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $id = id => document.getElementById(id);

  const EXAMPLES = ["Warm 70s blues lead, light spring reverb", "Tight modern metal rhythm, no effects", "Edge of breakup with a slapback delay",
    "Shimmery ambient clean pad", "Fuzzy stoner doom", "Funky clean with auto-wah"];
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Zm6.5 10l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1ZM6 15l.7 1.6 1.6.7-1.6.7L6 19.6l-.7-1.6-1.6-.7 1.6-.7L6 15Z" fill="currentColor"/></svg>';

  /* ---------- the button and the panel ---------- */
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "aiBtn"; btn.id = "aiBtn"; btn.title = tr("Describe a tone and let AI build it"); btn.setAttribute("aria-haspopup", "dialog");
  btn.innerHTML = ICON + '<span class="tx">AI TONE</span>';
  const anchor = $id("fswBtn") || $id("tunerBtn");
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor); else return;

  const m = document.createElement("div");
  m.className = "modal"; m.id = "aim"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-labelledby", "aiT");
  m.innerHTML = `<div class="box">
  <div class="aihd"><div><h2 id="aiT">AI Tone <span class="tag">Beta</span></h2><div class="sub">Describe a sound. AI builds it from the effects, captures and IRs on your pedal, and it plays straight away. Save it to a slot to keep it.</div></div>
    <span class="grow"></span><button class="btn ico" id="aiX" title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>
  <label class="sr-only" for="aiPrompt">Describe the tone</label>
  <textarea id="aiPrompt" maxlength="2000" placeholder="e.g. Early Van Halen brown sound, a touch of plate reverb"></textarea>
  <div class="aiex" id="aiEx" role="group" aria-label="Examples"></div>
  <div class="aiopts">
    <label title="Off: show the result first and load it with a click"><input type="checkbox" id="aiAuto"> Load it on the pedal right away</label>
    <label title="The AI changes the chain that is playing instead of starting from scratch (e.g. &quot;less gain, more delay&quot;)"><input type="checkbox" id="aiCur"> Adjust what's playing</label>
  </div>
  <div class="aiwork" id="aiWork" role="status" aria-live="polite"><span id="aiWorkTx">Building your tone…</span><span class="bar"><i></i></span></div>
  <div class="aierr" id="aiErr" role="alert"></div>
  <div class="aires" id="aiRes" aria-live="polite"></div>
  <div class="aifoot"><span class="ainote" id="aiNote"></span><span class="grow"></span><button class="btn" id="aiCancel">Close</button><button class="btn primary" id="aiGo">Generate</button></div>
  <details class="aisrv" id="aiSrv"><summary>AI server</summary><div id="aiSrvBody"></div></details>
</div>`;
  document.body.appendChild(m);
  if (typeof i18nApply === "function") { try { i18nApply(m); i18nApply(btn); } catch (e) { /* English stays */ } }

  const ex = $id("aiEx");
  for (const s of EXAMPLES) { const b = document.createElement("button"); b.type = "button"; b.textContent = s; b.onclick = () => { $id("aiPrompt").value = s; $id("aiPrompt").focus(); }; ex.appendChild(b); }
  $id("aiAuto").checked = !!opts.auto; $id("aiCur").checked = !!opts.cur;
  $id("aiAuto").onchange = e => { opts.auto = e.target.checked; saveOpts(); };
  $id("aiCur").onchange = e => { opts.cur = e.target.checked; saveOpts(); };

  let open = false, busyNow = false, ctl = null, last = null, back = null;
  function openPanel() {
    if (open) return;
    open = true; back = document.activeElement; m.classList.add("on");
    renderSrv(); setTimeout(() => $id("aiPrompt").focus(), 0);
  }
  function closePanel() {
    if (!open) return;
    if (ctl) { ctl.abort(); ctl = null; }
    open = false; m.classList.remove("on");
    if (back && back.focus) back.focus();
  }
  btn.onclick = openPanel;
  $id("aiX").onclick = closePanel; $id("aiCancel").onclick = closePanel;
  m.addEventListener("click", e => { if (e.target === m && !busyNow) closePanel(); });
  document.addEventListener("keydown", e => {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closePanel(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); }
    if (e.key === "Tab") {                                                         /* keep the focus inside the panel */
      const f = [...m.querySelectorAll("button, textarea, input, summary, [tabindex]:not([tabindex='-1'])")].filter(x => !x.disabled && x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  }, true);
  $id("aiGo").onclick = () => generate();

  /* ---------- the server ---------- */
  function renderSrv() {
    const body = $id("aiSrvBody");
    if (sameOrigin) {
      body.innerHTML = `<p>${esc(tr("This page is served by tankgtone, which runs the AI. Nothing to set."))}</p><div class="row"><span id="aiPing"></span></div>`;
    } else {
      body.innerHTML = `<div class="row"><input type="text" id="aiUrl" spellcheck="false" aria-label="AI server address"><button class="btn mini" id="aiTest">Test</button></div><span id="aiPing"></span>
        <p>${esc(tr("Start it on this computer:"))} <code>python -m tankgtone ui</code>. ${esc(tr("It needs OPENROUTER_API_KEY (free models) or ANTHROPIC_API_KEY."))}</p>`;
      $id("aiUrl").value = server();
      $id("aiUrl").onchange = e => { store.set(SRV_KEY, e.target.value.trim() || DEF_SRV); ping(); };
      $id("aiTest").onclick = () => { store.set(SRV_KEY, $id("aiUrl").value.trim() || DEF_SRV); ping(); };
    }
    ping();
  }
  async function ping() {
    const p = $id("aiPing"); if (!p) return;
    p.className = ""; p.textContent = tr("Checking…");
    try {
      const r = await fetch(server() + "/api/status", { cache: "no-store" });
      const d = await r.json();
      const who = d.ultrarig_ai !== undefined ? d.ultrarig_ai : (d.ai ? "anthropic" : null);
      if (!who) { p.className = "no"; p.textContent = tr("tankgtone is running, but has no AI key: set OPENROUTER_API_KEY (free) or ANTHROPIC_API_KEY and restart it."); return; }
      p.className = "ok"; p.textContent = tr(who === "openrouter" ? "Connected to tankgtone. AI ready (OpenRouter free model)." : "Connected to tankgtone. AI ready (Claude).");
    } catch (e) { p.className = "no"; p.textContent = tr("tankgtone isn't running at this address."); }
  }

  /* ---------- what this pedal has ---------- */
  async function libs() {
    if (DEMO) return { caps: { list: PIO_DEMO_LIBS.caps, cur: 2 }, irs: { list: PIO_DEMO_LIBS.irs, cur: 0 } };
    const caps = pioLib(await pioSendLive("CLIST", PIO_LIBEND("CLIST"), 3000), true);
    const irs = pioLib(await pioSendLive("ILIST", PIO_LIBEND("ILIST"), 3000), false);
    return { caps, irs };
  }
  const nameAt = (lib, slot) => { const x = lib && slot >= 0 ? lib.list.find(e => e.slot === slot) : null; return x ? x.name : ""; };
  function catalogue() {
    const out = {};
    for (const [name, t] of Object.entries(S.types || {})) {
      if (!t || !Array.isArray(t.params)) continue;
      out[name] = { label: lookOf(name).name, cost: t.cost || 0,
        params: t.params.filter(q => q.name).map(q => ({ name: q.name, label: plabel(q.name).lab, min: q.min, max: q.max, def: q.def })) };
    }
    return out;
  }
  const AEQ = ["volume", "bass", "mid", "treble", "presence", "drive"];
  function current(L) {                                         /* the chain that is playing, by name (parallel branches flattened, in order) */
    const blk = it => { const t = S.types[it.type], p = {}; if (t) for (const q of t.params) if (q.name && q.name !== "ir_slot" && q.name !== "os_n" && it.p && it.p[q.idx] != null) p[q.name] = it.p[q.idx];
      return { type: it.type, on: !!it.on, params: p }; };
    const tone = {}; (S.aeq || []).forEach((v, i) => { if (i < AEQ.length) tone[AEQ[i]] = v; });
    return { pre_amp: (S.chain.P || []).map(blk), amp: { on: !!S.amp, present: !!S.ampPresent, capture: nameAt(L.caps, L.caps.cur), tone }, cab_ir: nameAt(L.irs, L.irs.cur), post_amp: (S.chain.Q || []).map(blk) };
  }

  /* ---------- generate ---------- */
  function setBusy(on, txt) {
    busyNow = on; btn.classList.toggle("busy", on);
    $id("aiWork").classList.toggle("on", on); if (txt) $id("aiWorkTx").textContent = tr(txt);
    $id("aiGo").disabled = on; $id("aiPrompt").disabled = on;
  }
  function showErr(msg) { const e = $id("aiErr"); e.textContent = msg || ""; e.classList.toggle("on", !!msg); }

  async function generate() {
    if (busyNow) return;
    const prompt = $id("aiPrompt").value.trim();
    if (!prompt) { showErr(tr("Describe the tone you want first.")); $id("aiPrompt").focus(); return; }
    if (!DEMO && !S.connected) { showErr(tr("Connect the pedal first.")); return; }
    if (typeof bleRo === "function" && bleRo()) { showErr(tr(typeof BLE_RO_NOTE === "string" ? BLE_RO_NOTE : "The pedal is read-only over this Bluetooth link.")); return; }
    if (!S.types || !Object.keys(S.types).length) { showErr(tr("The pedal hasn't sent its effect list yet. Try again in a moment.")); return; }
    showErr(""); setBusy(true, "Reading your pedal…");
    let L;
    try { L = await libs(); } catch (e) { setBusy(false); showErr(tr("Pedal not connected.")); return; }
    const rig = { types: catalogue(), captures: L.caps.list.map(x => x.name), irs: L.irs.list.map(x => x.name),
      capture_now: nameAt(L.caps, L.caps.cur), ir_now: nameAt(L.irs, L.irs.cur), amp_tone_bands: S.aeqOk || DEMO ? (S.aeqDrv || DEMO ? 6 : 5) : 0 };
    const body = { prompt, rig, current: opts.cur ? current(L) : null };
    setBusy(true, (opts.cur ? "Adjusting your tone…" : "Building your tone…") + " " + tr("Free AI models can take a minute or two."));
    ctl = new AbortController();
    const timer = setTimeout(() => ctl && ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      const r = await fetch(server() + "/api/ultrarig/tone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : tr("The AI server answered with an error ({n}).", { n: r.status }));
      res = d;
    } catch (e) {
      clearTimeout(timer); ctl = null; setBusy(false);
      if (e && e.name === "AbortError") { if (open) showErr(tr("It took too long. Try again.")); return; }
      const net = e instanceof TypeError;
      showErr(net ? tr("Can't reach tankgtone at {url}. Start it with: python -m tankgtone ui", { url: server() || location.origin }) : String(e.message || e));
      if (net) $id("aiSrv").open = true;
      return;
    }
    clearTimeout(timer); ctl = null; setBusy(false);
    last = res;
    renderResult(res, false);
    if (opts.auto) await load(res);
  }

  async function load(res) {
    setBusy(true, "Loading it on the pedal…");
    let ok = false;
    try { ok = await pioImport(JSON.stringify(res.doc), { auto: true }); } finally { setBusy(false); }
    renderResult(res, ok);                                                   /* (pioImport already says "loaded. Save it to a slot.") */
  }

  /* ---------- the result ---------- */
  function renderResult(res, loaded) {
    const box = $id("aiRes"), blocks = res.blocks || [], amp = res.amp || {};
    const pd = b => `<span class="pd${b.on ? "" : " off"}" style="--c:${esc(lookOf(b.type).c)}" title="${esc(b.label)}"><b>${esc(b.label)}</b></span>`;
    const ampTitle = amp.capture || tr("Capture loaded now");
    const chain = [...blocks.filter(b => b.where === "pre").map(pd), `<span class="pd aiamp${amp.on ? "" : " off"}" title="${esc(ampTitle)}"><b>AMP</b></span>`, ...blocks.filter(b => b.where === "post").map(pd)]
      .join('<span class="w" aria-hidden="true"></span>');
    const kv = b => Object.entries(b.params || {}).map(([k, v]) => `${esc(plabel(k).lab)} ${esc(v)}`).join(" · ");
    const toneTxt = Object.entries(amp.tone || {}).filter(([, v]) => v).map(([k, v]) => `${esc(k)} ${v > 0 ? "+" : ""}${(v / 10).toFixed(1)} dB`).join(" · ");
    const why = [`<li><i style="--c:var(--gold)"></i><div><b>AMP</b><span>${esc(amp.reason || "")}</span><span class="kv">${esc(ampTitle)}${amp.cab_ir ? " · " + esc(tr("Cab IR")) + ": " + esc(amp.cab_ir) : ""}${toneTxt ? " · " + toneTxt : ""}</span></div></li>`,
      ...blocks.map(b => `<li><i style="--c:${esc(lookOf(b.type).c)}"></i><div><b>${esc(b.label)}</b><span>${esc(b.reason)}</span>${kv(b) ? `<span class="kv">${kv(b)}</span>` : ""}</div></li>`)].join("");
    const warns = (res.warnings || []).map(w => `<li>${esc(tr(w))}</li>`).join("");
    const state = loaded ? `<span class="rstate">${esc(tr("Playing · not saved yet"))}</span>` : `<span class="rstate warn">${esc(tr("Not loaded"))}</span>`;
    box.innerHTML = `<div class="rhd"><span class="rname">${esc(res.name)}</span>${state}</div>
      ${res.summary ? `<div class="rsum">${esc(res.summary)}</div>` : ""}
      <div class="aichain" role="img" aria-label="${esc(tr("The chain"))}">${chain}</div>
      ${warns ? `<ul class="aiwarn">${warns}</ul>` : ""}
      <ul class="aiwhy">${why}</ul>
      <div class="aiacts">${loaded ? "" : `<button class="btn primary" id="aiLoad">${esc(tr("Load on the pedal"))}</button>`}<button class="btn" id="aiFile">${esc(tr("Download preset file"))}</button><button class="btn" id="aiAgain">${esc(tr("Try another"))}</button></div>`;
    box.classList.add("on");
    $id("aiNote").textContent = loaded ? tr("Values were checked against your pedal's ranges.") : "";
    const lb = $id("aiLoad"); if (lb) lb.onclick = () => load(res);
    $id("aiFile").onclick = () => pioSaveFile(pioFileName(res.name), JSON.stringify(res.doc, null, 1));
    $id("aiAgain").onclick = () => generate();
  }
})();
