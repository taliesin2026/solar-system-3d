/* 复刻 gasSurface 的混色模型，用来离线设计/核对配色。
   为什么需要它：贴图的字节值经过「sRGB 空间逐带 lerp → 噪声 k → 截断」才落到 canvas，
   再被 three 解码成线性反射率、乘标定增益、过光照与 ACES。
   肉眼在字节空间看着"对比很强"的配色，线性空间可能只有 1.5:1；
   而字节空间"看着平"的配色，线性空间反而可能有 3:1。标定与截断都只认线性值，
   所以配色必须在**线性反射率**空间设计，字节只是载体。 */
const s2l = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
/* 页面里 base 写的是 0xe0cead 这种**数字字面量**，带色写的是 '#c9a37a'，
   两种都得认 —— 只按十六进制解析数字字符串会把 14732973 当 hex 读，
   颜色整个读飞（均值 0.46 被算成 0.32，然后所有结论都错）。 */
const hex = h => {
  const n = typeof h === 'number' ? h : parseInt(String(h).replace('#', ''), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};
const LUMA = [0.2126, 0.7152, 0.0722];

/* 带剖面里"平顶"占半宽的比值。必须与 index.html 的 gasSurface 一致 ——
   改一边就得改另一边，verify.js 里有断言把两边钉在一起。
   为什么不用三角形 (1-dd/bw)：真实云带的边界是**锐变**（zone/belt 交界是
   喷流剪切的不连续面），而三角剖面永远是"正弦纹"，读不出"一条一条"的带。
   按真实纬度排的带（NEB 11° 宽、EZ 15° 宽）在 ±20° 窗口里首尾相接，
   三角剖面下整个窗口全是斜坡 → 贴图上根本没有平顶可言。 */
const PLATEAU = 0.55;
/* 盘面留白只看中央这一条带（球面投影 y=sinφ，±20° 已占掉盘面一半高度）。
   ⚠ 必须等于页面里的 ALBEDO_CEN —— verify.js 第 8 节当场比对这两个数。 */
const DISK_CEN = 20 / 180;

/* 与页面同序：base 起色，逐带 sRGB 空间 lerp */
function rowColor(base, bands, t, plateau) {
  const pl = plateau == null ? PLATEAU : plateau;
  const c = base.slice();
  for (const [pos, col, bw, bi] of bands) {
    const dd = Math.abs(t - pos);
    if (dd < bw) {
      const w = (dd < bw * pl ? 1 : 1 - (dd - bw * pl) / (bw * (1 - pl))) * bi;
      for (let k = 0; k < 3; k++) c[k] += (col[k] - c[k]) * w;
    }
  }
  return c;
}

/** 按**线性亮度**反推 hex：给定色相（rgb 比例），解出线性 luma = target 的那个颜色。
    配色注释与统计都必须写线性值 —— 标定、8 位截断、色调映射三件事只认线性，
    而 sRGB 字节空间"看着差很多"的两个颜色，线性空间可能只差 1.4 倍。 */
function hexForLuma(hue, target) {
  const h = hex(hue);                       // 只取比例，绝对值无所谓
  const scale = Math.max(...h) >= 1 ? 1 : 255 / Math.max(...h);
  let lo = 0, hi = 1;
  const lumaAt = x => {
    const v = h.map(c => Math.min(1, c * scale * x));
    return LUMA[0] * s2l(v[0]) + LUMA[1] * s2l(v[1]) + LUMA[2] * s2l(v[2]);
  };
  if (lumaAt(1) < target) return null;      // 这个色相再怎么提亮也到不了
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (lumaAt(m) < target) lo = m; else hi = m;
  }
  const v = h.map(c => Math.round(255 * Math.min(1, c * scale * hi)));
  return '#' + v.map(x => x.toString(16).padStart(2, '0')).join('');
}

/** 采样整张贴图，返回线性口径下的统计。
 *  噪声必须按**分布**积分，不能取单个最坏值：
 *    k = 1 + n·turb·1.6 + m·turb·1.1，n、m ∈ [-0.5, 0.5]
 *    → k ∈ [1 − 1.35·turb, 1 + 1.35·turb]
 *  取单点会把均值整体抬高（s2l 是凸函数），而真实噪声在亮带一侧被 255 截断、
 *  暗带一侧把值拉低，两头不对称，均值只能积分出来。
 *  峰值另算，且必须**逐通道**取上界 —— 截断是逐通道发生的，不是按亮度。 */
function analyze(name, cfg, target, plateau) {
  const base = hex(cfg.base);
  const bands = cfg.bands.map(b => [b[0], hex(b[1]), b[2], b[3]]);
  const KSPAN = (cfg.turb || 0) * 1.35;
  const KS = 15;
  const N = 1200;
  let lumSum = 0, peak = 0, clipRows = 0;
  const prof = [];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const c = rowColor(base, bands, t, plateau);
    let lum = 0, clipped = false;
    for (let s = 0; s < KS; s++) {
      const k = 1 - KSPAN + (2 * KSPAN) * (s / (KS - 1));
      let row = 0;
      for (let ch = 0; ch < 3; ch++) {
        const raw = c[ch] * k;
        if (raw > 1) clipped = true;
        row += LUMA[ch] * s2l(Math.min(1, raw));
      }
      lum += row;
    }
    lum /= KS;
    lumSum += lum;
    if (clipped) clipRows++;
    for (let ch = 0; ch < 3; ch++) {
      const l = s2l(Math.min(1, c[ch] * (1 + KSPAN)));
      if (l > peak) peak = l;
    }
    prof.push({t, lum});
  }
  const mean = lumSum / N;
  const gain = target / mean;
  /* 屏幕可见性：纬度 φ 投到圆盘 y=sinφ，中央 ±20° 已经占到盘面一半高度，
     是"一眼看过去"的区域，单独统计它的起伏。 */
  const vis = prof.filter(p => Math.abs(p.t - 0.5) < DISK_CEN);
  const vm = vis.reduce((a, p) => a + p.lum, 0) / vis.length;
  const vs = Math.sqrt(vis.reduce((a, p) => a + (p.lum - vm) * (p.lum - vm), 0) / vis.length);
  return {
    name, rawMean: +mean.toFixed(3), centralMean: +vm.toFixed(3), target, gain: +gain.toFixed(3),
    peakLin: +peak.toFixed(3),
    clippedRowPct: +(clipRows / N * 100).toFixed(1),
    pinAfterGain: +(peak * gain).toFixed(3),          // >1 就是在往帧缓冲天花板上撞
    centralContrastPct: +(vs / vm * 100).toFixed(1),
    centralLinRange: [+Math.min.apply(null, vis.map(p => p.lum)).toFixed(2),
                      +Math.max.apply(null, vis.map(p => p.lum)).toFixed(2)]
  };
}
/* ================= 色调映射链：在 Node 里复刻屏幕字节 =================
   为什么必须复刻：贴图对比度在"线性反射率"空间看着很好（3:1），
   落到屏幕却可能只剩 0.6%。中间这一刀是 ACES 肩部砍的，
   不把它算出来，"该给多少留白"就只能靠手气。
   下面的矩阵与 RRT/ODT 拟合式**逐字**取自 lib/three.min.js 的
   ACESFilmicToneMapping（r147），连 toneMappingExposure/0.6 那个除数一起照抄。 */
const TONE_EXPOSURE = 0.62 / 0.6;
const ACES_IN = [[0.59719, 0.35458, 0.04823],
                 [0.07600, 0.90834, 0.13383],
                 [0.02840, 0.01566, 0.83777]];
const ACES_OUT = [[1.60475, -0.53108, -0.07367],
                  [-0.10208, 1.10813, -0.00605],
                  [-0.00327, -0.07276, 1.07602]];
const l2s = v => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
/** 线性辐照 (r,g,b) → 屏幕字节 (0..255)，含 exposure、ACES、sRGB 编码与饱和 */
function toneMapBytes(c) {
  let v = c.map(x => x * TONE_EXPOSURE);
  v = ACES_IN.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  v = v.map(x => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081));
  v = ACES_OUT.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  return v.map(x => Math.round(255 * Math.max(0, Math.min(1, l2s(x)))));
}
/* ================= 场景辐照与色调曲线膝点 =================
   盘面中心（dotNL≈1）的 tonemap 输入 = 贴图线性值 × 增益 × SCENE_IRR。
   legacy 光下 PointLight 的 π 与 BRDF_Lambert 的 1/π 抵消，所以
   SCENE_IRR ≈ 光强 × (toneMappingExposure/0.6)。
   自校验：按线上常量是 3.1×1.033=3.20；实测反推是 3.42
   （木星盘面中心字节均值 229 → 查 toneMapBytes 得输入 1.81，
     贴图中心线性 0.4845 × 标定增益 1.092 = 0.529 → 1.81/0.529=3.42）。
   差 7%，量级与趋势都对得上，所以这里用**页面常量推导**，不写死实测值。 */
function sceneIrr(html) {
  const pl = html.match(/new THREE\.PointLight\(([^)]*)\)/);
  if (!pl) throw new Error('页面里找不到 PointLight');
  const intensity = Number(pl[1].split(',')[1].trim());
  const ex = html.match(/toneMappingExposure\s*=\s*([\d.]+)/);
  return intensity * (Number(ex[1]) / 0.6);
}
const SCENE_IRR = 3.20;

/* 色调曲线的"膝点"：输入超过它，ACES 肩部就开始吃相对对比度。
   toneMapBytes 扫描（输入 → 相对对比保留率）：
     0.15→63%  0.35→51%  0.50→43%  0.65→33%  1.00→19%  1.81→13%
   膝点取 0.65：再高就只剩两三成对比，再低盘面就开始发灰。 */
const DISK_KNEE = 0.65;
/** 标定增益 + 留白钳位。规则一句话：
 *  贴图平均值照标定（保住"亮度∝反照率"的身份次序），
 *  但**眼睛主要看的中央 ±20°** 的输入不许超过膝点，超了就整体按比例压回来。 */
function kneeGain(rawMean, centralMean, target, irr, knee) {
  const k0 = target / rawMean;
  const kn = knee == null ? DISK_KNEE : knee;
  const input = centralMean * k0 * (irr == null ? SCENE_IRR : irr);
  const h = input > kn ? kn / input : 1;
  return {gain: k0, headroom: h, gainFinal: k0 * h, inputUncapped: +input.toFixed(2)};
}

/** 算「这颗星球在屏幕上到底还剩多少带对比」。
 *  在 ±20° 窗口（球面投影 y=sinφ，这块占盘面一半高度，是眼睛主要看的区域）
 *  逐行取贴图颜色 → 线性 → ×增益×SCENE_IRR → ACES → 字节，
 *  返回字节口径的均值 / 峰谷差 / 起伏比例。
 *  o = {irr, knee, plateau, headroom}，headroom 是在钳位之上再乘的实验系数。 */
function disk(name, cfg, target, o) {
  o = o || {};
  const irr = o.irr == null ? SCENE_IRR : o.irr;
  const base = hex(cfg.base);
  const bands = cfg.bands.map(b => [b[0], hex(b[1]), b[2], b[3]]);
  const a = analyze(name, cfg, target, o.plateau);
  const kg = kneeGain(a.rawMean, a.centralMean, target, irr, o.knee);
  const gain = kg.gainFinal * (o.headroom == null ? 1 : o.headroom);
  const KSPAN = (cfg.turb || 0) * 1.35;
  const rows = [];
  for (let i = 0; i < 600; i++) {
    const t = 0.5 - DISK_CEN + 2 * DISK_CEN * (i + 0.5) / 600;
    const c = rowColor(base, bands, t, o.plateau);
    /* 噪声取 ±KSPAN 两端与中值三点：带的字节起伏里噪声是次要项，
       但它决定"云"的颗粒感，全取 1 会低估。 */
    for (const k of [1 - KSPAN, 1, 1 + KSPAN]) {
      const lin = c.map(v => s2l(Math.min(1, v * k)));
      const b = toneMapBytes(lin.map(v => v * gain * irr));
      rows.push(0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2]);
    }
  }
  const mean = rows.reduce((x, y) => x + y, 0) / rows.length;
  const sd = Math.sqrt(rows.reduce((x, y) => x + (y - mean) * (y - mean), 0) / rows.length);
  return {
    name, gainCal: +kg.gain.toFixed(3), headroom: +kg.headroom.toFixed(3),
    inputUncapped: kg.inputUncapped,
    gain: +gain.toFixed(3), inputCentral: +(a.centralMean * gain * irr).toFixed(2),
    byteMean: +mean.toFixed(0), byteMin: +Math.min.apply(null, rows).toFixed(0),
    byteMax: +Math.max.apply(null, rows).toFixed(0),
    bandContrastPct: +(sd / mean * 100).toFixed(1),
    pinPeak: +(a.peakLin * gain).toFixed(2)             // >1 就是往 8 位天花板上撞，色度先被削
  };
}

/* ================= 直接读页面，不抄配置 =================
   这份工具如果靠手工同步一份配色副本，两次迭代之后就是废代码。
   所以它从 index.html 里把 gasTex 的配置、ALBEDO_TEX 的目标值、光强与曝光
   **一起抓出来**，`node palette.js` 报的永远是线上那一版。 */
function balanced(src, from) {                        // 从 src[from]='{' 起找配对括号
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(from, i + 1); }
  }
  return null;
}
/** → {albedo:{…}, bodies:[{var:'jup', albedoName:'木星', albedo:0.538, cfg:{…}}]} */
function readGasCfg(html) {
  const at = html.indexOf('const ALBEDO_TEX = {');
  if (at < 0) throw new Error('页面里找不到 ALBEDO_TEX');
  const albedo = Function('return ' + balanced(html, html.indexOf('{', at)))();
  const out = [];
  const re = /TEX\.\w+\s*=\s*gasTex\(\s*\{/g;
  let m;
  while ((m = re.exec(html))) {
    const brace = html.indexOf('{', m.index + m[0].length - 1);
    const src = balanced(html, brace);
    if (!src) break;
    const cfg = Function('return ' + src)();
    const tail = html.slice(brace + src.length, brace + src.length + 90);
    const am = tail.match(/ALBEDO_TEX\.([\u4e00-\u9fa5\w]+)/);
    out.push({var: m[0].match(/TEX\.(\w+)/)[1], albedoName: am && am[1],
              albedo: am ? albedo[am[1]] : null, cfg});
    re.lastIndex = brace + src.length;
  }
  return {albedo, bodies: out};
}

module.exports = {analyze, disk, kneeGain, toneMapBytes, s2l, l2s, hex, hexForLuma, rowColor,
            readGasCfg, sceneIrr, PLATEAU, DISK_CEN, SCENE_IRR, DISK_KNEE};

if (require.main === module) {
  /* 一切从 index.html 读：配色、反照率目标、光强、曝光。
     手抄一份副本的离线工具，两次迭代之后就是废代码。 */
  const fs = require('fs');
  const html = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
  const irr = sceneIrr(html);
  const {bodies} = readGasCfg(html);
  console.log('场景辐照 = 光强 × 曝光/0.6 =', irr.toFixed(2),
              ' 膝点 =', DISK_KNEE, ' 剖面平顶 =', PLATEAU);
  console.log('\n=== 线上四颗气星球：标定增益 → 留白后增益 → 屏幕字节 ===');
  for (const b of bodies)
    console.log(JSON.stringify(disk(b.albedoName + ' ' + b.var, b.cfg, b.albedo, {irr})));
  console.log('\n=== 剖面 A/B（同一份配色，只换带剖面形状）');
  const j = bodies[0];
  console.log('  三角 ' + JSON.stringify(disk('jup', j.cfg, j.albedo, {irr, plateau: 0})));
  console.log('  梯形 ' + JSON.stringify(disk('jup', j.cfg, j.albedo, {irr})));
  console.log('\n=== 膝点扫描（木星）：留白给多少，屏幕还剩多少带对比');
  for (const k of [1.2, 0.9, 0.65, 0.5, 0.38, 0.26])
    console.log('  knee=' + k + ' ' + JSON.stringify(disk('jup', j.cfg, j.albedo, {irr, knee: k})));
}
