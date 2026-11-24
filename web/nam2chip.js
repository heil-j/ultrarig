/* nam2chip.js - conversor de .nam (NAM A2, WaveNet) al binario 'A2L1' del motor del pedal, en el navegador (sin Python ni torch).
 *
 * Port fiel del camino A2 de analisis/ann/scripts/nam2chip.py (pick_submodel + check_supported + calibración en flotante +
 * build/qweight/qint + pack). Misma matemática, mismo orden de pesos, mismo binario (little-endian, CRC32). Sin dependencias.
 *
 * Qué hace, paso a paso:
 *   1. parse   : JSON del .nam; si es un SlimmableContainer elige la red LITE (3 canales); rechaza lo que el motor no corre
 *                (A1, LSTM, otras frecuencias de muestreo, canales != 3, gating, FiLM...) con un mensaje claro.
 *   2. pesos   : el vector plano 'weights' se reparte por módulo (el mismo orden que nam/models/wavenet: rechannel, por capa
 *                [conv + bias, input_mixer, layer1x1 + bias], head_rechannel + bias, head_scale). torch los lee como float32:
 *                aquí también (Math.fround) para que el resultado sea idéntico.
 *   3. calibra : pasada en FLOTANTE (Float64) del WaveNet sobre una señal de calibración; se guarda el máximo |.| de cada etapa
 *                (rechannel, z y x3 de cada capa, head, salida). Esos rangos fijan el formato Q (bits fraccionales) de cada etapa.
 *   4. cuantiza: pesos int16 con Q por tensor (F máximo que no desborda); activaciones int32 con Q por etapa, rango x2;
 *                biases en int64 al formato del acumulador; head_scale plegado en los pesos de la cabeza.
 *   5. empaqueta: cabecera 'A2L1' + capas + CRC32; se vuelve a leer y se valida con las mismas reglas de desplazamiento que
 *                el parse() del firmware (a2l_block.c), para no mandar al pedal algo que va a rechazar con rc=-4.
 *
 * Señal de calibración: nam2chip.py usa 60 s de la señal NAM v3 (27 MB, no se puede embeber) + ruido + barrido. Aquí hay una
 * señal SINTÉTICA corta (~8 s: barrido, ruido, acordes tipo guitarra, ráfagas graves) y una opción 'signals' para pasar la
 * original (así lo usa la prueba nam2chip_js_test.js para demostrar que el port es idéntico byte a byte). Ver ANALISIS_NAM_NATIVO.md.
 *
 * Uso (navegador): Nam2Chip.convertAsync(texto, {name, onProgress}) -> Promise<{blob, name, stats}> (Web Worker si se puede).
 * Uso (node)     : const N = require('./nam2chip.js'); N.convert(texto, {name}) -> {blob, name, stats}.
 */
(function (root) {
  'use strict';

  const MAGIC = 'A2L1', VERSION = 1, LSHIFT = 24, FS = 48000;
  /* Margen sobre los rangos medidos con la señal sintética (x1,5 = +3,5 dB): con ella los máximos salen hasta 3,1 dB por debajo
   * de los de la señal original de nam2chip.py; el margen cubre eso y deja SIEMPRE >= los bits de holgura de la original. */
  const EMBEDDED_GUARD = 1.5;
  const MAX_SHIFT = 62;               /* A2L_MAX_SHIFT de a2l_block.c */

  class NamError extends Error {}     /* error "del usuario": el archivo no se puede usar; el mensaje va tal cual a la pantalla */
  const bad = msg => { throw new NamError(msg); };

  /* ------------------------------------------------------------------------------------------- CRC32 */
  let CRC_T = null;
  function crc32(u8) {
    if (!CRC_T) { CRC_T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ------------------------------------------------------------------------------------------- carga y validación */
  /* pick_submodel + check_supported. Devuelve {sub, d, info}. 'smallest' = la red de menor max_value (Lite, 3 canales). */
  function pickSubmodel(d) {
    const arch = d.architecture;
    if (arch === 'SlimmableContainer') {
      const subs = ((d.config || {}).submodels || []).slice().sort((a, b) => a.max_value - b.max_value);
      if (!subs.length) bad('This .nam has no sub-models (broken SlimmableContainer).');
      return subs[0].model;
    }
    return d;
  }

  function describeOther(d) {
    const arch = d.architecture, cfg = d.config || {};
    if (arch === 'WaveNet' && Array.isArray(cfg.layers) && cfg.layers.length === 2) {
      const chans = cfg.layers.map(l => l.channels).join('/');
      const kind = { '16/8': 'standard', '12/6': 'lite', '8/4': 'feather', '4/2': 'nano' }[chans] || chans;
      return 'This capture is NAM A1: download it again from TONE3000, it now comes in A2.';   /* 2026-11-12: una oración (antes, el detalle: ${kind}) */
    }
    if (arch === 'LSTM') return 'This capture is NAM LSTM: download its A2 version from TONE3000.';
    if (arch === 'ConvNet' || arch === 'Linear' || arch === 'Sequential') return `This is a NAM "${arch}" model. The pedal only runs NAM A2 (WaveNet) captures.`;
    return null;
  }

  function checkSupported(sub) {
    const errs = [];
    if (sub.architecture !== 'WaveNet') errs.push(`architecture ${sub.architecture} (only WaveNet A2)`);
    const cfg = sub.config || {};
    const layers = cfg.layers || [];
    if (layers.length !== 1) errs.push(`${layers.length} layer arrays (only 1)`);
    if (cfg.head != null) errs.push('global head (only the array head_rechannel)');
    if (cfg.condition_dsp) errs.push('condition_dsp');
    if (errs.length) bad('Model not supported: ' + errs.join('; ') + '.');
    const L = layers[0];
    if (!Array.isArray(L.kernel_sizes) || !Array.isArray(L.dilations) || L.kernel_sizes.length !== L.dilations.length || !L.kernel_sizes.length ||
        L.channels == null || !L.activation || !Array.isArray(sub.weights))
      bad('Model not supported: the file is missing fields (kernel_sizes, dilations, channels, activation or weights).');
    const n = L.kernel_sizes.length;
    const get = (o, k, def) => (o && o[k] != null ? o[k] : def);
    if (get(L, 'input_size', 1) !== 1 || get(L, 'condition_size', 1) !== 1) errs.push('input/condition size != 1');
    if (get(L.head1x1, 'active', false)) errs.push('head1x1 active');
    if (!get(L.layer1x1, 'active', false) || get(L.layer1x1, 'groups', 1) !== 1) errs.push('layer1x1 inactive or grouped');
    if (get(L, 'bottleneck', L.channels) !== L.channels) errs.push('bottleneck != channels');
    for (const k of ['groups_input', 'groups_input_mixin']) if (get(L, k, 1) !== 1) errs.push(k + ' != 1');
    for (const k of Object.keys(L)) if (k.endsWith('_film') && L[k] && typeof L[k] === 'object' && L[k].active) errs.push('FiLM active: ' + k);
    const arr = v => (Array.isArray(v) ? v : [v]);
    if (arr(get(L, 'gating_mode', 'none')).some(g => g !== 'none' && g != null)) errs.push('gating');
    if (arr(get(L, 'secondary_activation', null)).some(s => s != null)) errs.push('secondary_activation');
    const acts = Array.isArray(L.activation) ? L.activation : new Array(n).fill(L.activation);
    if (acts.some(a => !a || a.type !== 'LeakyReLU')) errs.push('activations that are not LeakyReLU: ' + [...new Set(acts.map(a => (a && a.type) || '?'))].sort().join(','));
    if (get(L.head, 'out_channels', 1) !== 1) errs.push('head with more than 1 output');
    if (errs.length) bad('Model not supported: ' + errs.join('; ') + '.');
    if (L.channels !== 3) bad(`This network has ${L.channels} channels; the pedal engine runs the 3-channel A2-Lite network.`);
    const hk = get(L.head, 'kernel_size', 0);
    if (!(hk >= 1 && hk <= 64)) bad('Model not supported: head kernel size ' + hk + '.');
    for (let i = 0; i < n; i++) {
      if (!(L.kernel_sizes[i] >= 1 && L.kernel_sizes[i] <= 15) || !(L.dilations[i] >= 1 && L.dilations[i] <= 65535)) bad('Model not supported: kernel/dilation out of range in layer ' + (i + 1) + '.');
    }
  }

  /* Reparte el vector plano de pesos por módulo (orden de nam/models/wavenet: _layer_array.import_weights + _wavenet.import_weights).
   * Todo en float32 -> float64, como torch.Tensor(list).double(). Devuelve el motor flotante `e`. */
  function buildEngine(sub) {
    const cfg = sub.config, L = cfg.layers[0], C = L.channels, n = L.kernel_sizes.length;
    const hk = L.head.kernel_size, hbias = L.head.bias !== false;
    const w = Float64Array.from(Float32Array.from(sub.weights));
    for (let i = 0; i < w.length; i++) if (!Number.isFinite(w[i])) bad('The weights contain NaN or infinite values.');
    let need = C;                                        /* rechannel (C,1,1) */
    for (let i = 0; i < n; i++) need += C * C * L.kernel_sizes[i] + C + C + C * C + C;
    need += C * hk + (hbias ? 1 : 0) + 1;                /* head_rechannel + bias + head_scale final */
    if (w.length !== need) bad(`Unexpected number of weights: the file has ${w.length}, an A2-Lite network with these settings needs ${need}.`);
    let o = 0;
    const take = k => { const a = w.slice(o, o + k); o += k; return a; };
    const e = { C, hk, layers: [], headScale: cfg.head_scale != null ? +cfg.head_scale : 1.0 };
    e.rech = take(C);
    const acts = Array.isArray(L.activation) ? L.activation : new Array(n).fill(L.activation);
    for (let i = 0; i < n; i++) {
      const K = L.kernel_sizes[i];
      const ly = { K, dil: L.dilations[i], slope: acts[i].negative_slope != null ? +acts[i].negative_slope : 0.01 };
      ly.convW = take(C * C * K); ly.convB = take(C);   /* convW[(co*C+ci)*K+k] */
      ly.mixW = take(C);
      ly.l1W = take(C * C); ly.l1B = take(C);
      e.layers.push(ly);
    }
    e.hW = take(C * hk);                                  /* hW[ci*hk+k] */
    e.hB = hbias ? take(1)[0] : 0.0;
    return e;
  }

  const receptiveField = e => { let rf = 1; for (const ly of e.layers) rf += (ly.K - 1) * ly.dil; return rf + e.hk - 1; };

  /* ------------------------------------------------------------------------------------------- pasada en flotante (measure) */
  /* Igual que measure() de nam2chip.py: devuelve el max |.| de cada etapa para la señal x1 (con rf-1 ceros delante).
   * Los rangos de z son del valor antes de la activación; x3 el residual después de cada capa; head la suma de activaciones;
   * out la salida final (con head_scale). Es el forward de a2lite_engine.py, a mano sobre Float64Array. */
  function measure(e, x1, onFrac) {
    const C = e.C;
    if (C !== 3) throw new Error('internal: measure() is specialised for 3 channels');
    const rf = receptiveField(e), pad = rf - 1, N = pad + x1.length;
    const xin = new Float64Array(N); xin.set(x1, pad);
    let x3 = [], cur = N;
    const r = { rech: 0, z: [], x3: [], head: 0, out: 0 };
    for (let c = 0; c < C; c++) {
      const a = new Float64Array(N), w = e.rech[c];
      let m = 0;
      for (let t = 0; t < N; t++) { const v = w * xin[t]; a[t] = v; const av = v < 0 ? -v : v; if (av > m) m = av; }
      x3.push(a); if (m > r.rech) r.rech = m;
    }
    let head = null;
    const nl = e.layers.length;
    for (let li = 0; li < nl; li++) {
      const ly = e.layers[li], K = ly.K, d = ly.dil, Lout = cur - d * (K - 1), off = cur - Lout, slope = ly.slope;
      const z = [new Float64Array(Lout), new Float64Array(Lout), new Float64Array(Lout)], a = [new Float64Array(Lout), new Float64Array(Lout), new Float64Array(Lout)];
      const x0 = x3[0], x1c = x3[1], x2 = x3[2];
      let zmax = 0;
      for (let co = 0; co < 3; co++) {
        /* z = bias + sum_k (W[:,:,k] @ x[k*d: k*d+Lout]) + mixer(xin)[-Lout:]; el mismo orden de sumas que a2lite_engine.dilated_conv_valid */
        const zc = z[co], ac = a[co], mw = ly.mixW[co];
        zc.fill(ly.convB[co]);
        for (let k = 0; k < K; k++) {
          const sh = k * d, w0 = ly.convW[(co * 3) * K + k], w1 = ly.convW[(co * 3 + 1) * K + k], w2 = ly.convW[(co * 3 + 2) * K + k];
          for (let t = 0; t < Lout; t++) zc[t] += w0 * x0[sh + t] + w1 * x1c[sh + t] + w2 * x2[sh + t];
        }
        const xo = N - Lout;                              /* el mixer se alinea a la derecha */
        let m = 0;
        for (let t = 0; t < Lout; t++) {
          const v = zc[t] + mw * xin[xo + t];
          zc[t] = v; ac[t] = v >= 0 ? v : slope * v;
          const av = v < 0 ? -v : v; if (av > m) m = av;
        }
        if (m > zmax) zmax = m;
      }
      r.z.push(zmax);
      /* x3 = x3[-Lout:] + (layer1x1 @ a + bias) */
      const nx = []; let xmax = 0;
      const a0 = a[0], a1 = a[1], a2 = a[2];
      for (let co = 0; co < 3; co++) {
        const o = new Float64Array(Lout), src = x3[co], b = ly.l1B[co];
        const w0 = ly.l1W[co * 3], w1 = ly.l1W[co * 3 + 1], w2 = ly.l1W[co * 3 + 2];
        let m = 0;
        for (let t = 0; t < Lout; t++) {
          const v = src[off + t] + (w0 * a0[t] + w1 * a1[t] + w2 * a2[t] + b); o[t] = v;
          const av = v < 0 ? -v : v; if (av > m) m = av;
        }
        nx.push(o); if (m > xmax) xmax = m;
      }
      r.x3.push(xmax);
      x3 = nx;
      if (head !== null) for (let c = 0; c < 3; c++) { const h = head[c], ac = a[c], ho = h.length - Lout; for (let t = 0; t < Lout; t++) ac[t] += h[ho + t]; }
      head = a;
      cur = Lout;
      if (onFrac) onFrac((li + 1) / nl);
    }
    let hm = 0;
    for (let c = 0; c < 3; c++) { const h = head[c]; for (let t = 0; t < h.length; t++) { const av = h[t] < 0 ? -h[t] : h[t]; if (av > hm) hm = av; } }
    r.head = hm;
    /* cabeza: conv de kernel hk, 3 -> 1 (+ bias), por head_scale */
    const hk = e.hk, Lo = cur - hk + 1, h0 = head[0], h1 = head[1], h2 = head[2];
    let om = 0;
    for (let t = 0; t < Lo; t++) {
      let y = e.hB;
      for (let k = 0; k < hk; k++) y += e.hW[k] * h0[t + k] + e.hW[hk + k] * h1[t + k] + e.hW[2 * hk + k] * h2[t + k];
      y *= e.headScale;
      const av = y < 0 ? -y : y; if (av > om) om = av;
    }
    r.out = om;
    return r;
  }

  function mergeRanges(rs) {
    const o = { rech: 0, head: 0, out: 0, z: [], x3: [] };
    for (const k of ['rech', 'head', 'out']) o[k] = Math.max(...rs.map(r => r[k]));
    for (let i = 0; i < rs[0].z.length; i++) { o.z.push(Math.max(...rs.map(r => r.z[i]))); o.x3.push(Math.max(...rs.map(r => r.x3[i]))); }
    return o;
  }

  /* ------------------------------------------------------------------------------------------- señal de calibración */
  /* Barrido logarítmico 20 Hz -> fs/2 a plena escala (misma fórmula que nam2chip.py). */
  function sweepSignal(fs, secs) {
    const n = Math.floor(secs * fs), x = new Float64Array(n), T = (n - 1) / fs, r = fs / 2 / 20, lr = Math.log(r);
    for (let i = 0; i < n; i++) { const t = i / fs; x[i] = Math.sin(2 * Math.PI * 20 * (Math.pow(r, t / T) - 1) * T / lr); }
    return x;
  }
  /* PRNG propio (mulberry32) + Box-Muller: determinista y portable (no igual al numpy de la original; solo importa el máximo). */
  function rng(seed) {
    let s = seed >>> 0;
    const u = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const g = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
    return { u, g };
  }
  /* Cuerda pulsada (Karplus-Strong) de f Hz, `n` muestras, con ataque de ruido. */
  function pluck(fs, f, n, R, decay) {
    const N = Math.max(2, Math.round(fs / f)), line = new Float64Array(N), y = new Float64Array(n);
    for (let i = 0; i < N; i++) line[i] = R.u() * 2 - 1;
    let p = 0;
    for (let i = 0; i < n; i++) { const a = line[p], b = line[(p + 1) % N]; y[i] = a; line[p] = decay * 0.5 * (a + b); p = (p + 1) % N; }
    return y;
  }
  /* Acorde rasgueado: cuerdas con retardo de 12 ms entre sí, normalizado a `peak`. */
  function strum(fs, freqs, secs, peak, R, decay) {
    const n = Math.floor(secs * fs), y = new Float64Array(n);
    freqs.forEach((f, i) => { const off = Math.floor(i * 0.012 * fs), s = pluck(fs, f, n - off, R, decay); for (let t = 0; t < s.length; t++) y[off + t] += s[t]; });
    let m = 0; for (let t = 0; t < n; t++) m = Math.max(m, Math.abs(y[t]));
    for (let t = 0; t < n; t++) y[t] *= peak / m;
    return y;
  }
  /* Señal sintética de calibración corta. Devuelve una lista de segmentos (cada uno se mide aparte y se toma el máximo). */
  function embeddedSignals(fs) {
    const R = rng(12345), out = [];
    out.push(sweepSignal(fs, 2));                                                               /* barrido a plena escala */
    const nz = new Float64Array(Math.floor(2 * fs));                                           /* ruido gaussiano sigma 0,5, recortado */
    for (let i = 0; i < nz.length; i++) nz[i] = Math.max(-1, Math.min(1, R.g() * 0.5));
    out.push(nz);
    const E = [82.41, 123.47, 164.81, 207.65, 246.94, 329.63], A = [110, 164.81, 220, 277.18, 329.63, 440], D = [73.42, 110, 146.83, 220, 293.66, 369.99];
    out.push(strum(fs, E, 2, 0.99, R, 0.9985));                                                 /* acordes calientes (pico 0,99) */
    out.push(strum(fs, A, 1.5, 0.99, R, 0.9985));
    out.push(strum(fs, D, 1.5, 0.99, R, 0.9985));
    return out;
  }

  /* ------------------------------------------------------------------------------------------- cuantización */
  const log2 = Math.log2;
  function fbits(maxabs, bits) {
    if (maxabs <= 0) return bits - 1;
    const ib = Math.floor(log2(maxabs)) + 1;
    return bits - 1 - ib;
  }
  function rhe(x) {                                   /* np.round: mitad al par */
    const f = Math.floor(x), d = x - f;
    return d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1);
  }
  function qint(v, F, bits) {                         /* devuelve Number (bits<=32) o BigInt (bits=64) por elemento */
    const s = Math.pow(2, F);
    const out = new Array(v.length);
    if (bits === 64) {
      const hi = 9223372036854775807n, lo = -9223372036854775808n;
      for (let i = 0; i < v.length; i++) { let b = BigInt(rhe(v[i] * s)); if (b > hi) b = hi; if (b < lo) b = lo; out[i] = b; }
    } else {
      const lim = Math.pow(2, bits - 1);
      for (let i = 0; i < v.length; i++) { let q = rhe(v[i] * s); if (q > lim - 1) q = lim - 1; if (q < -lim) q = -lim; out[i] = q; }
    }
    return out;
  }
  const maxAbs = a => { let m = 0; for (let i = 0; i < a.length; i++) { const v = a[i] < 0 ? -a[i] : a[i]; if (v > m) m = v; } return m; };
  function qweight(W, wbits, Fmax) {
    let F = fbits(maxAbs(W), wbits);
    if (Fmax != null && F > Fmax) F = Fmax;
    return [F, qint(W, F, wbits)];
  }

  function build(e, ranges, abits, wbits, fs, name) {
    const C = e.C, hk = e.hk;
    const m = { wbits, abits, fs: fs | 0, C, head_K: hk, name,
      Fin: fbits(1.0, abits), Fx3_0: fbits(ranges.rech * 2, abits), Fh: fbits(ranges.head * 2, abits), Fout: fbits(ranges.out * 2, abits) };
    [m.rech_F, m.rech_W] = qweight(e.rech, wbits, m.Fx3_0 - m.Fin + 31);
    m.layers = [];
    let Fx3_prev = m.Fx3_0;
    for (let i = 0; i < e.layers.length; i++) {
      const ly = e.layers[i];
      const Fz = fbits(ranges.z[i] * 2, abits), Fx3 = fbits(ranges.x3[i] * 2, abits);
      const [cF, cW] = qweight(ly.convW, wbits, Fz - Fx3_prev + 31);
      const [mF, mW] = qweight(ly.mixW, wbits, Fz - m.Fin + 31);
      const [lF, lW] = qweight(ly.l1W, wbits, Fx3 - Fz + 31);
      m.layers.push({ K: ly.K, dil: ly.dil, Fz, Fx3, lmul: Math.round(ly.slope * (1 << LSHIFT)),
        cF, cW, cB: qint(ly.convB, cF + Fx3_prev, 64), mF, mW, lF, lW, lB: qint(ly.l1B, lF + Fz, 64) });
      Fx3_prev = Fx3;
    }
    /* s_head = Fz - Fh >= 1 en todas las capas (Jcm800 y SATAN Off Center daban 0 en la última y el pedal las rechazaba) */
    m.Fh = Math.min(m.Fh, Math.min(...m.layers.map(l => l.Fz)) - 1);
    const hW = Float64Array.from(e.hW, v => v * e.headScale), hb = e.hB * e.headScale;
    [m.hF, m.hW] = qweight(hW, wbits, m.Fout - m.Fh + 31);
    m.hB = qint([hb], m.hF + m.Fh, 64)[0];
    return m;
  }

  /* ------------------------------------------------------------------------------------------- binario */
  function pack(m) {
    const C = m.C, hk = m.head_K, nL = m.layers.length;
    let size = 36 + 1 + 2 * C + 4 + 1 + 2 * C * hk + 8;
    for (const ly of m.layers) size += 9 + 1 + 2 * C * C * ly.K + 8 * C + 1 + 2 * C + 1 + 2 * C * C + 8 * C;
    const buf = new ArrayBuffer(size), dv = new DataView(buf), u8 = new Uint8Array(buf);
    let o = 0;
    const b = v => { dv.setInt8(o, v); o += 1; };
    const B = v => { dv.setUint8(o, v); o += 1; };
    const H = v => { dv.setUint16(o, v, true); o += 2; };
    const h = a => { for (const v of a) { dv.setInt16(o, v, true); o += 2; } };
    const q = a => { for (const v of a) { dv.setBigInt64(o, v, true); o += 8; } };
    for (let i = 0; i < 4; i++) B(MAGIC.charCodeAt(i));
    H(VERSION); B(m.wbits); B(m.abits); dv.setUint32(o, m.fs, true); o += 4; H(nL); B(C); B(hk);
    b(m.Fin); b(m.Fx3_0); b(m.Fh); b(m.Fout);
    const nm = new TextEncoder().encode(m.name).slice(0, 16);
    u8.set(nm, o); o += 16;
    b(m.rech_F); h(m.rech_W);
    for (const ly of m.layers) {
      B(ly.K); H(ly.dil); b(ly.Fz); b(ly.Fx3); dv.setInt32(o, ly.lmul, true); o += 4;
      b(ly.cF); h(ly.cW); q(ly.cB);
      b(ly.mF); h(ly.mW);
      b(ly.lF); h(ly.lW); q(ly.lB);
    }
    b(m.hF); h(m.hW); q([m.hB]);
    dv.setUint32(o, crc32(u8.subarray(0, o)), true); o += 4;
    if (o !== size) throw new Error('internal: blob size ' + o + ' != ' + size);
    return u8;
  }

  /* Relee el binario y aplica las reglas del parse() del firmware (a2l_block.c): si algo no cierra, falla aquí con un mensaje. */
  function validateBlob(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = u8.length;
    if (n < 44) bad('internal: blob too short.');
    if (crc32(u8.subarray(0, n - 4)) !== dv.getUint32(n - 4, true)) bad('internal: CRC mismatch.');
    let o = 6;
    const wb = dv.getUint8(o++), ab = dv.getUint8(o++); o += 4;
    const nL = dv.getUint16(o, true); o += 2;
    const C = dv.getUint8(o++), hk = dv.getUint8(o++);
    const Fin = dv.getInt8(o++), Fx30 = dv.getInt8(o++), Fh = dv.getInt8(o++), Fout = dv.getInt8(o++); o += 16;
    const sh = (s, what) => { if (s < -MAX_SHIFT || s > MAX_SHIFT) bad(`This model needs a shift of ${s} bits in ${what} (the engine allows +-${MAX_SHIFT}): its weights/levels are too extreme for the pedal.`); };
    if (wb !== 16 || (ab !== 16 && ab !== 32) || !C || C > 16 || !hk || hk > 64 || !nL) bad('internal: bad header.');
    const rF = dv.getInt8(o); o += 1 + 2 * C;
    sh(rF + Fin - Fx30, 'the input rechannel');
    let Fprev = Fx30;
    for (let i = 0; i < nL; i++) {
      const K = dv.getUint8(o), Fz = dv.getInt8(o + 3), Fx3 = dv.getInt8(o + 4); o += 9;
      const cF = dv.getInt8(o); o += 1 + 2 * C * C * K + 8 * C;
      const mF = dv.getInt8(o); o += 1 + 2 * C;
      const lF = dv.getInt8(o); o += 1 + 2 * C * C + 8 * C;
      const where = ' (layer ' + (i + 1) + ')';
      sh(cF + Fprev - Fz, 'conv' + where); sh(mF + Fin - Fz, 'mixer' + where); sh(lF + Fz - Fx3, '1x1' + where); sh(Fprev - Fx3, 'residual' + where); sh(Fz - Fh, 'head sum' + where);
      if (cF + Fprev - Fz > 31 || cF + Fprev - Fz < 0) bad('This model needs a conv shift of ' + (cF + Fprev - Fz) + ' bits' + where + ' (the engine allows 0..31).');
      Fprev = Fx3;
    }
    const hF = dv.getInt8(o); o += 1 + 2 * C * hk + 8;
    const so = hF + Fh - Fout;
    if (so > 31 || so < 0) bad('This model needs an output shift of ' + so + ' bits (the engine allows 0..31).');
    if (o + 4 !== n) bad('internal: blob layout mismatch.');
    return true;
  }

  /* ------------------------------------------------------------------------------------------- conversión completa */
  /* opts: {name, signals: [Float64Array...] (por defecto la sintética), onProgress(frac, text)}. Síncrono. */
  function convert(text, opts) {
    opts = opts || {};
    const prog = opts.onProgress || (() => {});
    const t0 = Date.now();
    let d;
    try { d = JSON.parse(text); } catch (err) { bad('This file is not valid JSON, so it is not a .nam capture.'); }
    if (!d || typeof d !== 'object' || d.architecture == null || d.config == null) bad('This does not look like a NAM capture (no "architecture"/"config").');
    const other = describeOther(d);
    if (other) bad(other);
    const sub = pickSubmodel(d);
    checkSupported(sub);
    const fs = sub.sample_rate || d.sample_rate || FS;
    if (fs !== FS) bad(`This capture is ${fs} Hz; the pedal runs at 48 kHz. Download the 48 kHz version.`);
    prog(0.02, 'Reading the network');
    const e = buildEngine(sub);
    const C = e.C, nLayers = e.layers.length;
    let macs = C;
    for (const ly of e.layers) macs += ly.convW.length + ly.mixW.length + ly.l1W.length;
    macs += e.hW.length;
    const sigs = opts.signals || embeddedSignals(fs);
    let total = 0; for (const s of sigs) total += s.length;
    let done = 0;
    const rs = [];
    for (const s of sigs) {
      const base = done;
      rs.push(measure(e, s, f => prog(0.05 + 0.85 * (base + f * s.length) / total, 'Calibrating levels')));
      done += s.length;
    }
    const ranges = mergeRanges(rs);
    const guard = opts.guard != null ? opts.guard : (opts.signals ? 1 : EMBEDDED_GUARD);   /* margen extra sobre los rangos medidos (1 = igual que nam2chip.py) */
    if (guard !== 1) { for (const k of ['rech', 'head', 'out']) ranges[k] *= guard; ranges.z = ranges.z.map(v => v * guard); ranges.x3 = ranges.x3.map(v => v * guard); }
    prog(0.92, 'Quantizing');
    const meta = d.metadata || {};
    const name = opts.name != null ? opts.name : (typeof meta.name === 'string' && meta.name ? meta.name : 'NAM');
    const m = build(e, ranges, 32, 16, fs, name);
    prog(0.96, 'Packing');
    const blob = pack(m);
    validateBlob(blob);
    prog(1, 'Done');
    return { blob, name, ranges,
      stats: { layers: nLayers, channels: C, macs, headK: e.hk, receptiveField: receptiveField(e), sampleRate: fs, bytes: blob.length,
               calibSamples: total, calibPeak: Math.max(ranges.out, 0), ms: Date.now() - t0, headScale: e.headScale,
               meta: { name: meta.name, modeledBy: meta.modeled_by, gear: meta.gear_model || meta.gear_make, tone: meta.tone_type, gearType: typeof meta.gear_type === 'string' ? meta.gear_type : null,
                       inputLevelDbu: typeof meta.input_level_dbu === 'number' && isFinite(meta.input_level_dbu) ? meta.input_level_dbu : null } } };
  }

  /* ------------------------------------------------------------------------------------------- navegador: Web Worker */
  /* URL de este mismo script (document.currentScript solo existe mientras se carga): el Worker se crea con ella. */
  const SELF_SRC = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || 'nam2chip.js';
  /* Convierte en un Worker (el hilo de la página no se bloquea); si el navegador no deja crearlo (p. ej. file://), lo hace en el hilo principal. */
  function convertAsync(text, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const direct = () => {
        setTimeout(() => { try { resolve(convert(text, { name: opts.name, onProgress: opts.onProgress })); } catch (err) { reject(err); } }, 30);
      };
      let w = null;
      try { w = new Worker(SELF_SRC); } catch (err) { direct(); return; }
      w.onmessage = ev => {
        const m = ev.data;
        if (m.t === 'p') { if (opts.onProgress) opts.onProgress(m.f, m.s); }
        else if (m.t === 'ok') { w.terminate(); resolve(m.r); }
        else { w.terminate(); const er = new Error(m.msg); er.user = m.user; reject(er); }
      };
      w.onerror = () => { w.terminate(); direct(); };      /* el Worker no arrancó: hilo principal */
      w.postMessage({ text, name: opts.name });
    });
  }

  const API = { convert, convertAsync, crc32, embeddedSignals, sweepSignal, rng, pluck, strum, measure, buildEngine, checkSupported, pickSubmodel, mergeRanges, build, pack, validateBlob, fbits, NamError };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.Nam2Chip = API;

  /* Dentro de un Worker: el mismo archivo responde a los mensajes. */
  if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
    self.onmessage = ev => {
      try {
        const r = convert(ev.data.text, { name: ev.data.name, onProgress: (f, s) => self.postMessage({ t: 'p', f, s }) });
        self.postMessage({ t: 'ok', r }, [r.blob.buffer]);
      } catch (err) { self.postMessage({ t: 'err', msg: err.message, user: err instanceof NamError }); }
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
