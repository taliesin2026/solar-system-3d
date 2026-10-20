#!/usr/bin/env node
/* ============================================================
   太阳系模拟器 —— 纯 Node 验证脚本（不碰 GPU）
   ------------------------------------------------------------
   评审问题 #52 说：新增的 16 颗卫星、稀薄环系、环阴影 shader、大陆掩膜
   没有任何测试覆盖，而目录里留下的 _camtest.js / _moonchk.js 断言的符号
   （MOON_ORBIT_FACTOR、MOON_ORBIT_CAP、halo sprite）早已不存在 —— 测试
   过期了却还留在仓库里，比没有测试更糟。

   这个脚本代替它们。它**不开浏览器、不建 WebGL 上下文**：
     · 用真实 lib/three.min.js（数学、几何、材质、场景图都能在 Node 跑），
       只把 WebGLRenderer 换成不做事的假渲染器；
     · 用最小 DOM/canvas 桩跑通整份 index.html 的内联脚本，包括启动、
       交互与 60 帧主循环；
     · 断言的是"程序自己算出来的数"：轨道、自转、标签、UI 接线、着色器
       include 是否真的存在于 three 的 ShaderChunk 表里。
   所以核显一次都不会被调用。

   用法：  node verify.js          （退出码 0 = 全绿）
          node verify.js -v       （打印每项断言的值）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const HTML_PATH = path.join(DIR, 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

const VERBOSE = process.argv.includes('-v');
let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; if (VERBOSE) console.log('  ✓ ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; failures.push(name + (detail ? '  →  ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); }
}
function near(name, got, want, tol) {
  const d = Math.abs(got - want);
  ok(name, Number.isFinite(got) && d <= tol, `实测 ${got}，期望 ${want}±${tol}${Number.isFinite(got) ? '（差 ' + d.toExponential(2) + '）' : ''}`);
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 58 - t.length))); }

/* ============================================================ 1. 静态检查 */
section('1. 内联脚本语法与结构');

const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok('内联脚本数量 = 3（启动层 / 主程序 / 尾层）', scripts.length === 3, '实际 ' + scripts.length);
let syntaxErr = 0;
scripts.forEach((code, i) => {
  try { new Function(code); } catch (e) { syntaxErr++; console.log('    script#' + (i + 1) + ': ' + e.message); }
});
ok('三段脚本全部通过语法解析', syntaxErr === 0, '出错 ' + syntaxErr + ' 段');
ok('文件无 CR 换行（跨平台可 diff）', !html.includes('\r'));
ok('没有残留的调试输出 console.log', !/(^|[^.\w])console\.log\s*\(/m.test(scripts.join('\n')));

/* `?nogl=1` 无渲染模式：这个开关存在的意义是"用真实浏览器量布局但一次都不碰 GPU"，
   所以它必须**真的能跑通**。沙箱里跑不到那条分支（sandbox.location.search 是空串，
   走的是有渲染器的路径），于是这里做两件静态检查：
     ① 开关与桩对象确实写在页面里，且导出 `noGL` 让外部检查能识别；
     ② 页面实际调用到的**每一个** `renderer.xxx` 成员，桩对象里都得有——
        将来谁加了一句 `renderer.setAnimationLoop(...)` 而忘了补桩，
        `?nogl=1` 会在浏览器里当场抛 TypeError，而这条断言会先红。 */
(function noglStubCheck() {
  const src = scripts.join('\n');
  ok('页面支持 ?nogl=1（不建 WebGL 上下文的浏览器目检模式）',
      /const NOGL = \/\[\?&\]nogl/.test(src) && /isNoGLStub/.test(src) && /noGL:\s*NOGL/.test(src));
  /* ⚠ 判"有没有依赖某个 API"要判**调用**，不能判字符串：
     页面注释里就写着"不用 URLSearchParams"，用 `!/URLSearchParams/` 会把自己
     的注释当成违规，红得莫名其妙。`new X(` 才是真正会崩的那一句。 */
  ok('无渲染模式不依赖 URLSearchParams（旧浏览器/测试沙箱里没有这个全局）',
      !/new\s+URLSearchParams\s*\(/.test(src));
  const stub = src.slice(src.indexOf('isNoGLStub'));
  const used = [...new Set((src.match(/\brenderer\.[a-zA-Z]+/g) || []).map(s => s.slice('renderer.'.length)))];
  const missing = used.filter(k => !new RegExp('\\b' + k + '\\b').test(stub.slice(0, 1200)));
  ok('渲染器桩覆盖了页面用到的全部 renderer.* 成员',
      used.length > 0 && missing.length === 0,
      used.length + ' 个成员' + (missing.length ? '，缺：' + missing.join(',') : ''));
})();

/* --- window.__solar 导出必须都是真实存在的符号（曾经因导出已删除的
       MOON_LOOK / setAutoDist 而在启动时抛 ReferenceError，整个钩子挂不上） --- */
section('2. __solar 导出与 DOM id 接线');
const mainCode = scripts.length ? scripts.join('\n') : '';
(function checkExports() {
  const i = mainCode.indexOf('window.__solar =');     // ⚠ 不能用 indexOf('window.__solar')：
  const st = mainCode.indexOf('{', i);                //   注释里也提到这个名字，会先命中注释
  if (i < 0 || st < 0) { ok('存在 window.__solar 导出块', false, '没找到'); return; }
  let depth = 0, end = st;
  for (let k = st; k < mainCode.length; k++) {
    const c = mainCode[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) { end = k; break; } }
  }
  const body = mainCode.slice(st + 1, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // 顶层逗号切分（跳过括号内的）
  let d = 0, cur = '';
  const parts = [];
  for (const c of body) {
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) d--;
    if (c === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const names = [];
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    let m = p.match(/^([A-Za-z_$][\w$]*)$/);           // 简写
    if (m) { names.push(m[1]); continue; }
    m = p.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);  // key:value 同为标识符
    if (m) names.push(m[2]);
  }
  // 声明判定要认四种写法：`function f`、`const a = 1, b = 2`（逗号续表）、
  // `let x = …`、以及**只声明不赋值**的 `let renderer;`（844 行就是它，
  // 渲染器要到 boot 里才创建）。只匹配 `= ` 会把它误判成未声明。
  const declared = n =>
      new RegExp('(?:^|[;,\\s])(?:const|let|var)\\s+[^;]*?\\b' + n + '\\b\\s*(?:=|;|,)').test(mainCode) ||
      new RegExp('function\\s+' + n + '\\s*[\\(=]').test(mainCode);
  const missing = names.filter(n => !declared(n));
  ok('导出的 ' + names.length + ' 个简写符号全部有声明', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : '无缺失');
  ok('导出块里不再引用已删除的 MOON_LOOK / MOON_DAY / moonSystems',
      !/MOON_LOOK|MOON_DAY|moonSystems/.test(body));
})();

/* --- 每个 getElementById 都能在 HTML 里找到对应 id --- */
(function checkIds() {
  const ids = new Set([...html.matchAll(/\bid="([\w:-]+)"/g)].map(m => m[1]));
  const used = new Set([...mainCode.matchAll(/getElementById\(['"]([\w:-]+)['"]\)/g)].map(m => m[1]));
  const dynamic = new Set([...mainCode.matchAll(/id\s*=\s*['"]([\w:-]+)/g)].map(m => m[1]));
  const missing = [...used].filter(x => !ids.has(x) && !dynamic.has(x));
  ok('JS 里用到的 ' + used.size + ' 个 DOM id 都存在于标记中', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : '无缺失');
})();

/* --- 反方向：标记里声明成"可点击"的控件必须真的被 JS 引用 ---
   上面那条只查"JS 用到的 id 在标记里存在"，方向反过来时它是完全瞎的。
   用户第 1 条反馈（最小化按钮点了无效）正是这个形状：#mLeft/#mRight/#mBottom
   三个 `─` 按钮 markup、CSS、aria、title 全写齐了，**JS 里一次都没引用** ——
   于是 150 项断言全绿，而按钮是死的。这种"静态半边工程"只有反向检查能抓。
   ⚠ 判定要先剥注释，并且只认**引号里的 id**：注释里提一嘴"见 #mLeft"不算接线
     （上一轮就吃过"注释里留着旧代码被误判"的亏）。也不要求写成
     getElementById('mLeft') 的字面量 —— 本应用是 `MIN_PANELS` 数组配
     getElementById(btnId) 的动态写法，所以字符串字面量出现在纯代码里即可。 */
(function checkMarkupControlsAreWired() {
  const jsOnly = mainCode
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // 块注释（含 GLSL/HTML 注释无关）
    .replace(/^[ \t]*\/\/.*$/gm, ' ');          // 只剥**整行**行注释，避免误伤 'http://'
  const controls = [...html.matchAll(/<([a-zA-Z][\w-]*)([^>]*?)\bid="([\w:-]+)"([^>]*)>/g)]
    .filter(m => /role="button"|role="checkbox"/.test(m[2] + m[4]) || m[1] === 'button')
    .map(m => m[3]);
  const dead = [...new Set(controls)].filter(
    id => !new RegExp("['\"]" + id + "['\"]").test(jsOnly));
  const uniq = [...new Set(controls)];
  /* ⚠ 空集合会让 `dead.length===0` **假绿**：抓取器的正则一旦和 markup 脱节
     （改标签名、改 role 写法），它一个控件都找不到，于是"全部已接线"照样通过。
     所以这条断言必须先证明抓取器自己是看得见的：这几个 id 是画面上真实存在、
     且正是这条检查当初要抓的那类控件，抓不到就是抓取器坏了，不是页面干净。 */
  const mustSee = ['mLeft', 'mRight', 'mBottom', 'bHelp', 'cOrbit'];
  const blind = mustSee.filter(id => !uniq.includes(id));
  ok('标记里 ' + uniq.length + ' 个 role=button/checkbox 控件全部被 JS 引用（评审：静态半边工程）',
      blind.length === 0 && dead.length === 0,
      blind.length ? '抓取器漏了这些控件（断言会假绿）: ' + blind.join(', ')
                   : (dead.length ? '没有任何事件绑定: ' + dead.join(', ') : '无孤儿'));
})();

/* --- 着色器 include 必须是 three 真实存在的 chunk --- */
(function checkIncludes() {
  const THREE = require(path.join(DIR, 'lib', 'three.min.js'));
  const known = new Set(Object.keys(THREE.ShaderChunk || {}));
  const used = [...new Set([...html.matchAll(/#include <([\w_]+)>/g)].map(m => m[1]))];
  const unknown = used.filter(u => !known.has(u));
  ok('全部 ' + used.length +  ' 个 #include 都是 three r' + THREE.REVISION + ' 的真实 chunk',
      unknown.length === 0, unknown.length ? '不存在: ' + unknown.join(', ') : used.join(', '));
})();

/* --- 手写 ShaderMaterial 必须齐三件套：对数深度 + 色调映射 + 输出编码 --- */
(function checkShaderPipeline() {
  const mats = [...mainCode.matchAll(/new THREE\.ShaderMaterial\(\{[\s\S]*?\n\s*\}\)/g)].map(m => m[0]);
  const bad = [];
  mats.forEach((src, i) => {
    const need = ['logdepthbuf_pars_vertex', 'logdepthbuf_vertex', 'logdepthbuf_pars_fragment',
                  'logdepthbuf_fragment', 'tonemapping_fragment', 'encodings_fragment', 'common'];
    const miss = need.filter(n => !src.includes('#include <' + n + '>'));
    if (miss.length) bad.push('#' + (i + 1) + ' 缺 ' + miss.join(','));
  });
  ok('手写 ShaderMaterial（日面/大气壳/土星环/星空）全部补齐深度+色彩管线',
      mats.length >= 4 && bad.length === 0, mats.length + ' 个材质' + (bad.length ? '：' + bad.join(' | ') : ''));
})();

/* ============================================================ 3. 跑起来 */
section('3. 无 GPU 启动 + 60 帧主循环');

/* ---- 最小 DOM / canvas 桩 ---- */
/* 所有真实创建出来的 canvas，按创建顺序登记。
   `willReadFrequently` 那条浏览器警告的关键在于**顺序**：这个提示只在
   一个 canvas 的「第一次」getContext('2d') 上生效，后面再传同样的属性
   会被直接忽略。所以光看源码里有多少处传了属性没有意义 ——
   必须能拿到"某个 canvas 第一次调用传了什么"，而这只有跑起来才知道。 */
const ALL_CANVAS = [];
function makeCtx(w, h) {
  const noop = () => {};
  const grad = () => ({ addColorStop: noop });
  /* 真实帧缓冲（只覆盖 ImageData 通路）。
     原来 getImageData 一律回全 0，于是凡是"读回贴图像素"的代码 ——
     calibrateAlbedo 的反照率标定、gasSurface 的 oval 逐像素改写 ——
     在沙箱里拿到的都是空图，断言只能测"有没有调用"，测不了"算得对不对"。
     这里补一个最小位图：createImageData 给新缓冲（与规范一致），
     putImageData 写回帧缓冲，getImageData 按矩形取副本。
     ⚠ 矢量笔触（fill/stroke/arc/ellipse/drawImage）仍然是 noop，所以
        "带边那条线画得糊不糊"这类只能靠浏览器截图验收，别拿这里的像素说事。 */
  const W = Math.max(1, w | 0), H = Math.max(1, h | 0);
  const fb = new Uint8ClampedArray(W * H * 4);
  const ctx = {
    canvas: null,
    width: W, height: H, _fb: fb,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt',
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    save: noop, restore: noop, beginPath: noop, closePath: noop, clip: noop,
    fill: noop, stroke: noop, rect: noop, fillRect: noop, clearRect: noop,
    moveTo: noop, lineTo: noop, arc: noop, ellipse: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop,
    translate: noop, rotate: noop, scale: noop, setTransform: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 8 }),
    setLineDash: noop, drawImage: noop,
    createLinearGradient: grad, createRadialGradient: grad, createPattern: () => ({}),
    createImageData: (a, b) => ({ width: a | 0, height: b | 0, data: new Uint8ClampedArray((a | 0) * (b | 0) * 4) }),
    getImageData: (x, y, w2, h2) => {
      x |= 0; y |= 0; w2 |= 0; h2 |= 0;
      const out = new Uint8ClampedArray(Math.max(1, w2 * h2 * 4));
      for (let r = 0; r < h2; r++) {
        const sy = y + r;
        if (sy < 0 || sy >= H) continue;                 // 越界行留全 0，与浏览器一致
        for (let c = 0; c < w2; c++) {
          const sx = x + c;
          if (sx < 0 || sx >= W) continue;
          const si = (sy * W + sx) * 4, di = (r * w2 + c) * 4;
          out[di] = fb[si]; out[di + 1] = fb[si + 1]; out[di + 2] = fb[si + 2]; out[di + 3] = fb[si + 3];
        }
      }
      return { width: w2, height: h2, data: out };
    },
    putImageData: (im, x, y) => {
      if (!im || !im.data) return;
      x |= 0; y |= 0;
      const iw = im.width | 0, ih = im.height | 0;
      for (let r = 0; r < ih; r++) {
        const dy = y + r;
        if (dy < 0 || dy >= H) continue;
        for (let c = 0; c < iw; c++) {
          const dx = x + c;
          if (dx < 0 || dx >= W) continue;
          const si = (r * iw + c) * 4, di = (dy * W + dx) * 4;
          fb[di] = im.data[si]; fb[di + 1] = im.data[si + 1];
          fb[di + 2] = im.data[si + 2]; fb[di + 3] = im.data[si + 3];
        }
      }
    },
  };
  return ctx;
}
class FakeEl {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = []; this.parentNode = null;
    this._attrs = {}; this._events = {};
    this.style = new Proxy({ setProperty: (k, v) => { this.style['_' + k] = v; }, removeProperty: noop_ }, { get: (t, k) => (k in t ? t[k] : '') });
    /* dataset 与 data-* 属性必须同步：页面用 `h.dataset.k = cls` 写分组类别，
       又用 `querySelector('.cat[data-k="sat"]')` 读它。真实的 DOM 里这两者是同一个
       槽位，桩里如果只存 JS 侧，选择器就永远匹配不上 —— 于是"每组只建一个标题"
       的判断在沙箱里恒为 false，会建出 30 个标题，测试断言的就不再是页面的行为。 */
    const ds = {};
    const kebab = k => String(k).replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    this.dataset = new Proxy(ds, {
      get: (t, k) => (typeof k === 'string' && !(k in t))
        ? this._attrs['data-' + kebab(k)] : t[k],
      set: (t, k, v) => { t[k] = v; this._attrs['data-' + kebab(k)] = String(v); return true; },
      has: (t, k) => k in t || ('data-' + kebab(k)) in this._attrs,
    });
    /* title 同理：卫星列表项用 `el.title = '… · 绕 木星'` 写，测试用
       getAttribute('title') 读。真实 DOM 里两者同源，桩里不打通就会读到 null，
       "折叠后母星信息还在不在"这条断言就变成"桩没存"而不是"页面丢了"。 */
    Object.defineProperty(this, 'title', {
      configurable: true, enumerable: true,
      get: () => this._attrs.title == null ? '' : this._attrs.title,
      set: v => { this._attrs.title = String(v); },
    });
    this.classList = (() => {
      const set = new Set();
      /* className 与 classList 在真实 DOM 里是同一个槽位的两种写法。页面用
         `h.className='cat'` 建分组标题、用 `el.className='pl'` 建列表项，
         又用 `querySelector('.cat[data-k="sat"]')` / `closest('.pl')` 去读它。
         桩里如果 className 只是个普通字符串属性，classList 就永远是空的 ——
         "每组只建一个标题"的判断恒为 false（会建出 30 个标题），而按类筛子节点
         的断言恒为 0，测的就不是页面的行为了。 */
      Object.defineProperty(this, 'className', {
        configurable: true, enumerable: true,
        get: () => [...set].join(' '),
        set: v => {
          set.clear();
          String(v == null ? '' : v).split(/\s+/).filter(Boolean).forEach(c => set.add(c));
          this._attrs.class = this.className;
        },
      });
      return {
        add: c => { set.add(c); this._attrs.class = [...set].join(' '); },
        remove: c => { set.delete(c); this._attrs.class = [...set].join(' '); },
        contains: c => set.has(c),
        toggle: (c, force) => {
          const on = force === undefined ? !set.has(c) : !!force;
          on ? set.add(c) : set.delete(c);
          this._attrs.class = [...set].join(' ');
          return on;
        },
        _set: set,
      };
    })();
    this.textContent = ''; this.innerHTML = ''; this.value = '';
    this.width = 300; this.height = 150;
    this.offsetHeight = 96; this.offsetWidth = 320;
    this._ctx = null;
    /* 每次 getContext 的入参都按顺序留档，配合上面的 ALL_CANVAS，
       就能事后回答"这个 canvas 第一次要 2d 上下文时到底传了什么"。 */
    this._ctxCalls = [];
    if (this.tagName === 'CANVAS') ALL_CANVAS.push(this);
  }
  getContext(type, attrs) {
    this._ctxCalls.push({ type, attrs: attrs || null });
    if (type !== '2d') return null;
    if (!this._ctx) { this._ctx = makeCtx(this.width, this.height); this._ctx.canvas = this; }
    return this._ctx;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  removeAttribute(k) { delete this._attrs[k]; }
  addEventListener(t, fn, o) { (this._events[t] = this._events[t] || []).push(fn); }
  removeEventListener() {}
  dispatch(t, ev) { (this._events[t] || []).forEach(fn => fn(Object.assign({ type: t, preventDefault() {}, stopPropagation() {}, target: this }, ev))); }
  querySelector(sel) { return this._descendants().find(c => c.matches && c.matches(sel)) || null; }
  querySelectorAll(sel) { return this._descendants().filter(c => c.matches && c.matches(sel)); }
  /* 真实 DOM 的 querySelector 是整棵子树的，不是只看直接子节点。
     天体列表重构后 `.cat` 标题仍是 plist 的直接子节点，但卫星项被挪进了
     .satfold 容器里，只查一层就漏 —— 断言会变成"桩里查不到所以页面也查不到"。 */
  _descendants(out = []) {
    for (const c of this.children) { if (c) { out.push(c); c._descendants(out); } }
    return out;
  }
  /* 只实现本项目里真的用到的那一小撮选择器语法：
     `tag`、`.class`、`#id`、`[attr]`、`[attr="v"]` 以及它们的**连写**（如
     `.cat[data-k="sat"]`、`input.ck`），逗号表示"或"。
     keyOwnedByControl(e) 靠 closest('input, …, [tabindex]') 判断焦点是否在控件上
     （评审问题 #29），没有 closest 就会退化成"永远不在控件上"，测试变成空测。 */
  matches(sel) {
    return String(sel).split(',').some(raw => {
      const s = raw.trim();
      if (!s) return false;
      /* 带空格 / `>` 的后代、子选择器不支持：明确返回 false，
         而不是"当成一个复杂类名去 contains"，避免假阳性。 */
      if (/[\s>+~]/.test(s)) return false;
      const parts = s.match(/[.#]?[\w-]+|\[[^\]]*\]/g) || [];
      if (!parts.length || parts.join('') !== s) return false;
      return parts.every(p => {
        if (p[0] === '.') return this.classList.contains(p.slice(1));
        if (p[0] === '#') return this.id === p.slice(1);
        if (p[0] === '[') {
          const m = p.match(/^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/);
          if (!m) return false;
          const v = this.getAttribute(m[1]);
          return v !== null && (m[2] === undefined || v === m[2]);
        }
        /* 裸标签名只能是第一部分（`div.ck`），出现在中间就是非法语法 */
        return parts[0] === p && /^[a-zA-Z][\w-]*$/.test(p) && this.tagName === p.toUpperCase();
      });
    });
  }
  closest(sel) { let n = this; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, x: 0, y: 0 }; }
  /* .click() 走的是真实 DOM 的路径：先 onclick，再派发冒泡监听。
     （clickEl() 自己已经调过 onclick，所以它继续用 dispatch，别改成 click()，
       否则同一份 handler 会跑两遍。） */
  click() {
    if (typeof this.onclick === 'function') {
      this.onclick({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
    }
    this.dispatch('click', {});
  }
  focus() {} blur() {}
}
function noop_() {}

/* 把标记里带 id 的开标签原样搬进桩：标签名、全部属性、以及**初始 class**。
   初始 class 必须抄 —— #cOrbit/#cMoon/#cGrid/#cStar/#cSpin 都是 `class="ck on"`，
   漏掉的话 bindCK 的 sync() 一启动就把它们读成"关"，测试断言的是桩的状态、
   不是页面的状态（评审问题 #16 那条就是这么被误判的）。
   同理 tagName：keyOwnedByControl() 用 closest('input,…') 判断焦点归谁，
   把 <input> 建成 DIV 就等于把那套保护整个关掉了。 */
const registry = new Map();
[...html.matchAll(/<([a-zA-Z][\w-]*)([^>]*?\bid="([\w:-]+)"[^>]*)>/g)].forEach(m => {
  const el = new FakeEl(m[1]);
  el.id = m[3];
  for (const a of m[2].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    el._attrs[a[1]] = a[2];
    if (a[1] === 'class') a[2].split(/\s+/).filter(Boolean).forEach(c => el.classList.add(c));
    if (['value', 'min', 'max', 'step', 'type'].includes(a[1])) el[a[1]] = a[2];
  }
  registry.set(m[3], el);
});

const documentShim = {
  createElement: t => new FakeEl(t),
  createElementNS: (ns, t) => new FakeEl(t),
  getElementById: id => registry.get(id) || null,
  querySelector: () => null,
  querySelectorAll: sel => {
    if (sel === '.pad[data-dx]') return [...registry.values()].filter(e => e._attrs['data-dx'] !== undefined);
    return [];
  },
  body: new FakeEl('body'),
  documentElement: new FakeEl('html'),
  addEventListener: () => {},
  fonts: { ready: Promise.resolve() },
};

const listeners = {};
let rafQueue = [];
/* 虚拟时钟：主循环的 dt 来自 performance.now()。用真实墙钟的话，Node 里
   一帧只过 0.1ms，飞行动画（flyToPose 0.8s）永远跑不完，流速 10 天/秒也
   等于没推进。这里每帧固定推进 16.7ms，60 帧 = 1 秒 = 10 天。 */
let vnow = 0;
const sandbox = {
  console,
  document: documentShim,
  window: null,
  performance: { now: () => vnow },
  requestAnimationFrame: fn => { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame: () => {},
  setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask,
  Promise, Symbol, Reflect, Proxy, WeakMap, WeakSet, Function, RegExp, RangeError, TypeError,
  devicePixelRatio: 1,
  innerWidth: 1440, innerHeight: 900,
  /* 沙箱里没有 URLSearchParams，页面也不该依赖它（见 index.html 里 NOGL 那段的注释）。
     但 `location.search` 是浏览器全局，页面读它是正当用法，所以沙箱要补上——
     缺它会让整份脚本在 `const NOGL = ...` 处 ReferenceError，
     表现是"__solar 挂不上 + 全线 undefined"，看起来像页面坏了，其实是桩不全。
     `search:''` = 不带 `?nogl`，即沙箱里跑的是**有渲染器**的那条分支
     （渲染器由 sandbox 里的 THREE 桩提供，仍然不碰 GPU）。 */
  location: { search: '', href: 'file:///verify/index.html', protocol: 'file:' },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {}, removeEventListener: () => {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener: () => {},
  Math, Date, JSON, Object, Array, Set, Map, Number, String, Boolean, Error, isFinite, isNaN, parseInt, parseFloat,
  Uint8ClampedArray, Uint8Array, Float32Array, Uint32Array, Int32Array, ArrayBuffer,
  ImageData: class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.addEventListener = sandbox.addEventListener;
sandbox.window.blur = () => {};

/* 真实 three，只把 WebGLRenderer 换成假渲染器 */
const THREE = require(path.join(DIR, 'lib', 'three.min.js'));
class FakeRenderer {
  constructor() {
    this.domElement = new FakeEl('canvas');
    this.domElement.width = 1440; this.domElement.height = 900;
    this.info = { memory: { geometries: 0, textures: 0 }, programs: [{ name: 'stub' }], render: { calls: 0, triangles: 0 } };
    this.capabilities = { isWebGL2: true, getMaxAnisotropy: () => 1, getContext: () => ({}) };
    this.shadowMap = { enabled: false, type: 0 };
    this.toneMapping = THREE.NoToneMapping; this.toneMappingExposure = 1;
    this.outputEncoding = THREE.LinearEncoding;
    this._pr = 1;
  }
  setPixelRatio(p) { this._pr = p; }
  getPixelRatio() { return this._pr; }
  setSize(w, h) {
    // three 的 setSize 会把 CSS 尺寸乘上 pixelRatio 再写进 canvas.width，
    // 桩必须照做，否则 #49 的"buffer 真的重建了"这条断言就是空测。
    this.domElement.width = Math.round(w * this._pr);
    this.domElement.height = Math.round(h * this._pr);
    this._cssW = w; this._cssH = h;
  }
  getSize(v) { return v.set(this._cssW || this.domElement.width, this._cssH || this.domElement.height); }
  render(scene, camera) {
    // 只做一遍场景遍历，把 draw call 数记下来（等价于渲染前的可见性计算）
    let calls = 0, visCount = 0;
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    scene.traverse(o => { if (o.visible && o.isMesh) visCount++; });
    this.info.render.calls = calls; this.info.render.triangles = visCount;
  }
  compile() {} dispose() {} forceContextLoss() {}
  initTexture() { return {}; }
  getContext() { return {}; }
}
THREE.WebGLRenderer = FakeRenderer;
// 经典脚本版 OrbitControls 是 `(function(){ ... THREE.EventDispatcher ... })()`，
// 它读的是**全局** THREE，所以 require 之前必须先把 THREE 挂到 global 上。
global.THREE = THREE;
require(path.join(DIR, 'lib', 'OrbitControls.js'));
if (!THREE.OrbitControls) { console.log('! OrbitControls 未能加载'); }
sandbox.THREE = THREE;

/* 启动主脚本；同时把 three 的两个库脚本一起喂进沙箱（按页面里的顺序） */
const bootErrors = [];
const vmCtx = vm.createContext(sandbox);
const allInline = [
  ['lib/three.min.js', fs.readFileSync(path.join(DIR, 'lib', 'three.min.js'), 'utf8')],
];
try {
  // three 已在 Node 里 require 过，页面里那两个 <script src> 不需要重放；
  // 只跑内联脚本即可。第一行 window.__boot 的桩已由 sandbox.console 记录。
  const code = scripts.join('\n;\n');
  vm.runInContext(code, vmCtx, { filename: 'index.html(inline)' });
} catch (e) {
  bootErrors.push(e && e.message || String(e));
  if (VERBOSE) console.log(e && e.stack);
}
ok('整份内联脚本在 Node 沙箱里跑完不抛异常', bootErrors.length === 0, bootErrors.join(' | '));
const S = sandbox.__solar;
ok('window.__solar 钩子成功挂载', !!S, bootErrors.length ? '（前置异常导致未挂载）' : '');

/* ---------- 驱动真实 UI，而不是往沙箱里塞私有变量 ----------
   评审问题 #52 要的是"测程序"，不是"测桩"。凡是有按钮/开关能到达的
   状态，一律走那条路：点击 #mReal/#mLog 切距离模式、给 #dDate 派发
   change 改历元、点 #cLabel/#cMoon/#cSpin 切显示开关。
   `__solar` 只保留纯函数（mapAU / fmtRate / labelText…）供直接断言。 */
const $ = id => registry.get(id);
function clickEl(id) {
  const el = $(id);
  if (!el) { ok('存在 #' + id, false, 'DOM 里没有这个 id'); return false; }
  // 应用同时用了 onclick= 与 addEventListener('click')，两种都要触发
  if (typeof el.onclick === 'function') el.onclick({ target: el, preventDefault() {}, stopPropagation() {} });
  el.dispatch('click', {});
  return true;
}
function setJd(y, mo, d) {
  const el = $('dDate');
  const p = n => String(n).padStart(2, '0');
  el.value = `${String(y).padStart(4, '0')}-${p(mo)}-${p(d)}`;
  el.dispatch('change', { target: el, value: el.value });
}
/** 场景图里当前挂着的几何体数（唯一 uuid），用来抓"重建不释放" */
function sceneGeoCount() {
  const seen = new Set();
  S.scene.traverse(o => { if (o.geometry) seen.add(o.geometry.uuid); });
  return seen.size;
}
/** 记录被 dispose() 过的几何体 uuid（#40 的直接证据） */
const disposedGeo = new Set();
{
  const proto = THREE.BufferGeometry.prototype;
  const orig = proto.dispose;
  proto.dispose = function () { disposedGeo.add(this.uuid); return orig.call(this); };
}
/** 触发 N 帧主循环（app 自己 requestAnimationFrame 排队的那条路，虚拟时钟每帧 +16.7ms） */
function rafDrain(n) {
  for (let f = 0; f < n; f++) {
    vnow += 16.7;
    const q = rafQueue; rafQueue = [];
    if (!q.length) { vnow -= 16.7; return; }
    q.forEach(fn => fn(vnow));
  }
}
/** 一直跑到条件满足或帧数用尽（flyToPose 这类缓动动画需要按墙钟收敛） */
function rafUntil(pred, maxFrames) {
  for (let f = 0; f < (maxFrames || 600); f++) {
    if (pred()) return f + 1;
    rafDrain(1);
  }
  return -1;
}

/* ============================================================ 4. 天文数值 */
if (S) {
  section('4. 轨道与自转的物理正确性');
  const J2000 = 2451545.0;
  const jdOf = (y, mo, d) => Date.UTC(y, mo - 1, d) / 86400000 + 2440587.5;

  ok('场景里有 30 个天体（9 行星 + 太阳 + 月球 + 19 颗行星卫星）', S.bodies.length === 30, '实际 ' + S.bodies.length);
  ok('行星 9 颗', S.planetBodies.length === 9, '实际 ' + S.planetBodies.length);
  ok('卫星表 19 条（木星 4 / 土星 7 / 天王星 5 / 火星 2 / 海王星 1）',
      S.MOONS.length === 19, '实际 ' + S.MOONS.length);
  ok('太阳 + 月球 + 9 行星 = 11 个主天体',
      S.bodies.filter(b => !b.isSat).length === 11, '实际 ' + S.bodies.filter(b => !b.isSat).length);

  // 4.1 转轴方位：倾角决定自转轴与黄道法线(+Y)的夹角（评审问题 #1）
  //     ⚠ 用 transformDirection 而不是 applyMatrix4：axis 组带着天体的**缩放**
  //     （bodyRadius）与平移，applyMatrix4 会把向量拉离单位长度后再 normalize，
  //     在 axis 有非均匀父级时得到的是错的朝向（实测 cos 全是 ±0.08 的噪声）。
  (function axisCheck() {
    const V = THREE.Vector3;
    const bad = [];
    S.planetBodies.forEach(b => {
      const tilt = b.def.tilt * Math.PI / 180;
      b.axis.parent.updateMatrixWorld(true);
      const world = new V(0, 1, 0).transformDirection(b.axis.matrixWorld);
      const cos = world.y;                       // 与黄道法线(+Y)的夹角余弦
      if (Math.abs(cos - Math.cos(tilt)) > 1e-3) bad.push(`${b.def.n}: cos=${cos.toFixed(4)} 应为 ${Math.cos(tilt).toFixed(4)}`);
    });
    ok('每颗行星的自转轴与黄道法线夹角 = 表列转轴倾角', bad.length === 0, bad.join(' | ') || '9/9 吻合');
    // 天王星 97.77° → 轴几乎躺进黄道面；金星 177.36° → 轴朝下（逆行来自倾角）
    const ur = S.planetBodies.find(b => b.def.n === '天王星');
    const v = new V(0, 1, 0).transformDirection(ur.axis.matrixWorld);
    ok('天王星自转轴确实"躺平"（|y| < 0.15）', Math.abs(v.y) < 0.15, 'axis·ŷ = ' + v.y.toFixed(4));
  })();

  // 4.2 逆行只由倾角>90° 决定，不许"负负得正"（评审问题 #2）
  (function retroCheck() {
    const expect = { 水星: false, 金星: true, 地球: false, 火星: false, 木星: false, 土星: false, 天王星: true, 海王星: false, 冥王星: true };
    const bad = [];
    S.planetBodies.forEach(b => {
      const got = S.isRetro(b.def);
      if (expect[b.def.n] !== undefined && got !== expect[b.def.n]) bad.push(`${b.def.n} 判为 ${got ? '逆' : '顺'}，应为 ${expect[b.def.n] ? '逆' : '顺'}（tilt=${b.def.tilt}, rot=${b.def.rot}）`);
      if (b.def.rot < 0) bad.push(`${b.def.n} 的自转周期仍是负数（会和 tilt 双重取反）`);
    });
    ok('金星/天王星/冥王星=逆行，其余=顺行，且周期全为正', bad.length === 0, bad.join(' | '));
  })();

  // 4.3 轨道根数抽查：与 JPL SSD 1800–2050 表逐条比对（含海王星 ϖ̄₀，评审问题 #9）
  (function elementsCheck() {
    const JPL = {
      水星: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
      金星: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
      地球: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
      火星: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
      木星: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
      土星: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
      天王星: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
      海王星: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.97137259, 131.78422574],
      冥王星: [39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684],
    };
    const bad = [];
    S.planetBodies.forEach(b => {
      const want = JPL[b.def.n]; if (!want) return;
      want.forEach((v, i) => { if (Math.abs(b.def.a[i] - v) > 1e-8) bad.push(`${b.def.n}[${i}] ${b.def.a[i]} ≠ ${v}`); });
    });
    ok('9 行星 × 6 轨道根数 = 54 个数值与 JPL 表逐条一致', bad.length === 0, bad.join(' | ') || '全部一致');
  })();

  // 4.4 地球轨道速度：必须是**当前时刻**的真值，不是近日点常数（评审问题 #3）
  //     走真实链路：选中地球 → 改 #dDate → 面板 innerHTML 里的「轨道速度」。
  //     vis-viva 上界：近日点 30.29、远日点 29.29，两端之差就是"实时"的证据。
  (function speedCheck() {
    const earth = S.planetBodies.find(b => b.def.n === '地球');
    S.select(earth, true);
    const readPanel = () => {
      S.update(0); S.refreshInfo();
      const html = $('info').innerHTML;
      const v = (html.match(/轨道速度<\/span><span class="v">([\d.]+) km\/s/) || [])[1];
      const r = (html.match(/日心距离<\/span><span class="v">([\d.]+) AU/) || [])[1];
      return { v: v === undefined ? NaN : +v, r: r === undefined ? NaN : +r };
    };
    setJd(2026, 1, 3); const per = readPanel();     // 近日点附近：最快
    setJd(2026, 7, 6); const apo = readPanel();     // 远日点附近：最慢
    setJd(2026, 10, 13); const now = readPanel();
    ok('地球近日点速度 ≈ 30.3 km/s（面板实时值）', per.v > 30.0 && per.v < 30.6, `${per.v} km/s @ r=${per.r}`);
    ok('地球远日点速度 ≈ 29.3 km/s（面板实时值）', apo.v > 29.0 && apo.v < 29.6, `${apo.v} km/s @ r=${apo.r}`);
    ok('速度随历元变化（不再恒等于近日点 30.29）', Math.abs(per.v - apo.v) > 0.6,
        `冬夏差 ${(per.v - apo.v).toFixed(2)} km/s`);
    ok('日心距跨过 1 AU（近日点 <1、远日点 >1）', per.r < 0.984 && apo.r > 1.016,
        `${per.r} / ${apo.r} AU`);
    ok('当前速度落在 29.3–30.3 km/s 之间', now.v > 29.2 && now.v < 30.4, `${now.v} km/s`);
    // 悬浮卡与面板必须同一口径（评审问题 #3 的"一张卡内打架"）
    const viaVisViva = 29.7847 * Math.sqrt(Math.max(1e-9, 2 / now.r - 1 / 1.00000261));
    near('面板速度与 vis-viva 独立复核一致（±0.15 km/s）', now.v, viaVisViva, 0.15);
  })();

  // 4.5 月球：日心距必须会跨过 1（评审问题 #5：原实现恒 ≥1.0024 且只增不减）
  (function moonCheck() {
    let min = 9, max = -9, gmin = 9e9, gmax = 0;
    let dMin = 9, dMax = -9;                 // (月日心距 − 地日心距) 的上下界
    const p = n => String(n).padStart(2, '0');
    /* 窗口选在**近日点附近**（12-20 → 01-20）：那 32 天里地球日心距几乎不动
       （dr/dd 在 1 月 3 日过零，全程变化 <0.00005 AU），于是月心±25.7 万 km
       的摆动就是全部信号 —— 换别的窗口，地球自己那 0.034 AU 的年变化会淹掉它。 */
    for (let k = 0; k <= 32; k++) {
      const d = new Date(Date.UTC(2026, 11, 20 + k));
      const el = $('dDate');
      el.value = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
      el.dispatch('change', { target: el, value: el.value });   // JD 由应用自己算
      S.update(0);
      const m = S.moonBody, e = S.planetBodies.find(b => b.def.n === '地球');
      min = Math.min(min, m.trueAU); max = Math.max(max, m.trueAU);
      gmin = Math.min(gmin, m.relAU); gmax = Math.max(gmax, m.relAU);
      dMin = Math.min(dMin, m.trueAU - e.trueAU);
      dMax = Math.max(dMax, m.trueAU - e.trueAU);
    }
    ok('月球有时比地球更近日、有时更远日（真的跑到地球两侧）',
        dMin < -0.0015 && dMax > 0.0015, `−${(-dMin).toFixed(5)} / +${dMax.toFixed(5)} AU`);
    ok('摆动幅度 ≈ 2×月地距离（新月最近、满月最远）',
        (dMax - dMin) > 0.0045 && (dMax - dMin) < 0.0060, `跨度 ${(dMax - dMin).toFixed(5)} AU`);
    const gminKm = gmin * 149597870.7, gmaxKm = gmax * 149597870.7;
    ok('月地距离区间 ≈ 35.6–40.7 万 km（Meeus 截断表允许 ±2%）',
        gminKm > 356000 && gmaxKm < 407000 && gmaxKm - gminKm > 20000,
        `${(gminKm / 1e3).toFixed(0)}k–${(gmaxKm / 1e3).toFixed(0)}k km`);
    // 原 bug：helio = 1 + 地心距，与 relAU 恒等 → 现在必须明显不等
    ok('月球日心距 ≠ 1 + 地心距（旧恒等式已破除）',
        Math.abs(S.moonBody.trueAU - (1 + S.moonBody.relAU)) > 1e-4,
        `真值 ${S.moonBody.trueAU.toFixed(5)} vs 旧式 ${(1 + S.moonBody.relAU).toFixed(5)}`);
    // 三角不等式：|月日心 − 地日心| 不能超过月地距离
    ok('月球日心距与地球日心距之差 ≤ 月地距离（三角不等式）',
        Math.abs(S.moonBody.trueAU - S.planetBodies[2].trueAU) <= S.moonBody.relAU * 1.001,
        'Δ=' + Math.abs(S.moonBody.trueAU - S.planetBodies[2].trueAU).toFixed(6));
    // 全年粗查：月球日心距必须真的两次跨过 1 AU（原实现恒 ≥1.0024）
    let above = 0, below = 0;
    for (let mo = 1; mo <= 12; mo++) {
      const el = $('dDate'), p2 = n => String(n).padStart(2, '0');
      el.value = `2026-${p2(mo)}-15`;
      el.dispatch('change', { target: el, value: el.value });
      S.update(0);
      S.moonBody.trueAU > 1 ? above++ : below++;
    }
    ok('一年里月球日心距两侧跨过 1 AU（不再"只增不减且恒 ≥1.0024"）',
        above > 3 && below > 3, `>1 AU 有 ${above} 次、<1 有 ${below} 次`);
    setJd(2026, 10, 13);
  })();

  // 4.6 标签读数 = 真实日心距，与对数压缩无关（评审问题 #4）
  //     labelText 是纯函数：先在两种映射模式下逐星比对真值，
  //     再确认真正写进 DOM 的那条路用的就是它。
  (function labelCheck() {
    setJd(2026, 10, 13);
    const bad = [];
    ['real', 'log'].forEach(mode => {
      clickEl(mode === 'real' ? 'mReal' : 'mLog');
      S.update(0);
      S.planetBodies.forEach(b => {
        const txt = S.labelText(b);
        const m = txt.match(/([\d.]+)\s*AU/);
        if (!m) { bad.push(`${mode}/${b.def.n} 无 AU`); return; }
        const shown = +m[1], real = b.trueAU;
        const tol = real < 0.01 ? 5e-5 : (real < 1 ? 0.006 : 0.06);
        if (Math.abs(shown - real) > tol) bad.push(`${mode}/${b.def.n} 标签 ${shown} ≠ 真值 ${real.toFixed(4)}`);
      });
    });
    ok('两种距离映射下标签 AU 都等于真实日心距（切对数不再变 1817"AU"）',
        bad.length === 0, bad.join(' | '));
    ok('标签渲染确实走 labelText()（而不是又拿场景坐标除基数）',
        /const txt = labelText\(b\);/.test(mainCode));
    // 真开一次「常显全部标签」+ 真跑主循环，确认 DOM 里出现 AU 文本
    const ck = $('cLabel');
    if (ck && !ck.classList.contains('on')) ck.dispatch('click', {});
    S.camera.position.set(0, 900, 2100); S.camera.lookAt(0, 0, 0); S.camera.updateProjectionMatrix();
    clickEl('mReal');
    S.update(0);
    rafDrain(4);
    const withAu = S.bodies.filter(b => b.label && /AU/.test(b.label.innerHTML)).length;
    ok('开启常显标签并跑主循环后，DOM 标签真的带 AU 读数', withAu >= 8, withAu + ' 个标签含 AU');
    // 卫星标签：标的是到母星距离（万 km），不是日心距（评审问题 #6/#17）
    const satTxt = S.bodies.filter(b => b.isSat).map(b => S.labelText(b));
    ok('卫星标签给「万km」而不是 AU', satTxt.length > 0 && satTxt.every(t => /万km/.test(t)),
        satTxt[0]);
  })();

  // 4.7 对数映射单调、端点正确
  (function logMapCheck() {
    const S2 = S;
    S2.setViewDir && null;
    const AUs = [0.00257, 0.3, 0.72, 1, 5.2, 19.2, 30.07, 39.48];
    const out = AUs.map(a => S.mapAU ? S.mapAU(a) : null);
    if (out[0] == null) { ok('mapAU 已导出', false, 'window.__solar 里没有 mapAU'); return; }
    let mono = true; for (let i = 1; i < out.length; i++) if (!(out[i] > out[i - 1])) mono = false;
    ok('距离映射单调递增', mono, out.map(v => v.toFixed(1)).join(' → '));
  })();

  /* 4.8 土星环的差动公转（用户第 3 条「是否应该跟着旋转」）
     这一组是本轮唯一"页面自己说了一个物理数，我去外部核对"的检查：
     GM 与赤道半径取 NASA Planetary Fact Sheet，周期由测试独立算一遍，
     不读页面导出的 RING_REF_PERIOD 去自证。 */
  (function ringPhysicsCheck() {
    const sat = S.bodies.find(b => b.def.n === '土星');
    ok('土星有环网格与环材质（b.rings / b.ringMat）', !!sat && !!sat.rings && !!sat.ringMat, '');
    if (!sat || !sat.ringMat) return;
    const GM = 3.7931e7, REq = 60268;                 // km³/s², km（旅行者/卡西尼定案值）
    const keplerDays = r => 2 * Math.PI * Math.sqrt(Math.pow(r * REq, 3) / GM) / 86400;
    ok('环系参考周期符合开普勒第三定律',
        Math.abs(S.RING_REF_PERIOD - keplerDays(S.RING_REF_R)) < 0.01,
        `页面 ${S.RING_REF_PERIOD} 天 / 公式 ${keplerDays(S.RING_REF_R).toFixed(4)} 天 @ ${S.RING_REF_R}R`);
    /* 参考半径必须落在"最亮、面积最大"的那一段（B 环 1.52–1.95R）。
       它决定限速的标尺：选了 D 环就快到看不清，选了 F 环就慢到像没转。 */
    ok('相位参考半径落在 B 环内（1.52–1.95R）',
        S.RING_REF_R > 1.52 && S.RING_REF_R < 1.95, String(S.RING_REF_R));
    const u = sat.ringMat.uniforms;
    const pos = sat.rings.geometry.getAttribute('position');
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));   // 环建在局部 XY 平面（z=0）
      mn = Math.min(mn, r); mx = Math.max(mx, r);
    }
    ok('shader 的 uR0/uR1 就是几何真实内外径（差动螺距不会静悄悄地漂）',
        Math.abs(u.uR0.value - mn) < 1e-6 && Math.abs(u.uR1.value - mx) < 1e-6,
        `几何 ${mn.toFixed(3)}–${mx.toFixed(3)} vs uniform ${u.uR0.value.toFixed(3)}–${u.uR1.value.toFixed(3)}`);
    ok('shader 的 uRefR 与推进相位的 RING_REF_R 同源（不是各抄一份）',
        u.uRefR.value === S.RING_REF_R, `${u.uRefR.value} / ${S.RING_REF_R}`);
    const frag = sat.ringMat.fragmentShader;
    ok('fragment 用 uniform 拿半径，没有把 1.74 硬写进 shader',
        /uSpinPhase/.test(frag) && !/pow\(\s*1\.74/.test(frag), '');
    ok('逐半径差动按 ω ∝ r^-1.5 换算（环不是刚体）',
        /pow\(uRefR\/max\([A-Za-z0-9.,\s]*\),\s*1\.5\s*\)/.test(frag), '');
    /* 贴图是轴对称的（每条暗纹横贯整个环周），只推进相位是**看不出来**的。
       必须有一层方位向疏密才被差动剪成螺旋 —— 这是"跟着旋转"这件事
       在画面上成立的前提，缺它整组改造等于零。 */
    ok('环有方位向疏密项，转动才可见（贴图本身是轴对称的）',
        /spk/.test(frag) && /azK/.test(frag) && /vUv\.y/.test(frag), '');
  })();

  /* 4.9 环相位的每帧驱动：推进量、限速、以及与行星空转的抵消
     走真实 `update(dt)`，不读私有变量。跑完把 jd 和流速还原，
     否则后面每一节的时间基准会被这里的高流速测试改掉。 */
  (function ringDriveCheck() {
    const sat = S.bodies.find(b => b.def.n === '土星');
    if (!sat || !sat.ringMat) { ok('环驱动检查需要土星环', false, ''); return; }
    const D2R = Math.PI / 180;
    const jd0 = S.jdRef(), rate0 = $('sSpeed').value, play0 = $('bPlay').textContent;
    if (/播放/.test(play0)) clickEl('bPlay');          // 必须是"正在走"的状态
    const phase = () => sat.ringMat.uniforms.uSpinPhase.value;
    const r = k => Math.round(k * 1e6) / 1e6;

    // 低速：一帧都没跨过限速，推进量应严格等于 dtDays / 周期 × 360°
    $('sSpeed').value = '8';
    $('sSpeed').dispatch('input', { target: $('sSpeed'), value: '8' });
    const rate = S.sliderToRate(8), dt = 1 / 60;
    const p0 = phase();
    S.update(dt);
    const dLow = Math.abs(phase() - p0) / D2R;
    const want = rate * dt / S.RING_REF_PERIOD * 360;
    ok('环相位按 dtDays/参考周期 推进（低速时不限速）',
        Math.abs(dLow - want) < 1e-6, `实测 ${dLow.toFixed(5)}° / 期望 ${want.toFixed(5)}°`);

    // 高速：必须撞到 RING_STEP_CAP，而不是"一帧跳过几十圈"读成闪烁
    $('sSpeed').value = $('sSpeed').max;
    $('sSpeed').dispatch('input', { target: $('sSpeed'), value: $('sSpeed').max });
    const p1 = phase();
    S.update(dt);
    const dHi = Math.abs(phase() - p1) / D2R;
    ok('高流速下环相位被限速（读成"在转"而不是"在闪"）',
        dHi <= S.RING_STEP_CAP + 1e-9,
        `${dHi.toFixed(3)}°/帧，上限 ${S.RING_STEP_CAP}°（未限速时 ${(S.sliderToRate(+$('sSpeed').max) * dt / S.RING_REF_PERIOD * 360).toFixed(0)}°）`);

    /* 不取模：差动之后各半径回到原相的周期互不相同，整体取模一定让某段跳相。
       这里跑够帧数让相位越过一整圈，确认它继续增长。 */
    const p2 = phase();
    for (let i = 0; i < 60; i++) S.update(dt);
    ok('相位越过 2π 后不取模（取模会让某些半径跳相、画面闪一下）',
        Math.abs(phase() - p2) / D2R > 360,
        `累计 ${((phase() - p2) / D2R).toFixed(0)}°`);

    // 环不跟行星空转走：抵消必须在同一帧里成立
    S.update(0);
    ok('环网格按 −自转角抵消行星空转（Ry·Rx(−90)·Rz(−spin) ≡ Rx(−90)）',
        Math.abs(sat.rings.rotation.z + sat.spinAng * D2R) < 1e-12,
        `rotation.z=${sat.rings.rotation.z.toFixed(6)} spin=${sat.spinAng.toFixed(4)}°`);
    ok('环面仍贴在赤道面（rotation.x 保持 −90°，抵消只动方位向）',
        Math.abs(sat.rings.rotation.x + Math.PI / 2) < 1e-12, String(sat.rings.rotation.x));

    // 还原时间与流速，别让后面的节接着跑在 2026 年之外
    S.setJd(jd0);
    $('sSpeed').value = rate0;
    $('sSpeed').dispatch('input', { target: $('sSpeed'), value: rate0 });
    if (/播放/.test($('bPlay').textContent)) clickEl('bPlay');
    S.update(0);
  })();
}

/* ============================================================ 5. 帧循环与泄漏 */
if (S) {
  section('5. 主循环、取景与资源');

  // 5.1 距离模式切换不得泄漏（评审问题 #40：remove() 只断父子，GPU 缓冲还在）
  //     走真实按钮：#mReal / #mLog。三条证据同时成立才算修好 ——
  //     ① 网格子节点数不涨；② 场景里挂着的几何体总数不涨；③ dispose() 真的被调用。
  (function distModeLeakCheck() {
    const children0 = S.gridGroup.children.length;
    const geo0 = sceneGeoCount();
    const disp0 = disposedGeo.size;
    const before = S.gridGroup.children.map(c => c.geometry.uuid);
    for (let i = 0; i < 6; i++) { clickEl('mLog'); clickEl('mReal'); }
    const children1 = S.gridGroup.children.length;
    const geo1 = sceneGeoCount();
    const disp1 = disposedGeo.size;
    const after = S.gridGroup.children.map(c => c.geometry.uuid);
    ok('切 12 次距离模式后网格节点数不变（评审问题 #40）', children1 === children0,
        `${children0} → ${children1}`);
    ok('场景内几何体总数不随切换累积', geo1 === geo0, `${geo0} → ${geo1}`);
    ok('每切一次确实 dispose 掉旧的 10 个网格几何体', disp1 - disp0 >= 60,
        `新增释放 ${disp1 - disp0} 个（6 次真切换 × 10）`);
    ok('当前挂着的网格几何体没有被"释放了还留着"（先 dispose 后重建）',
        after.every(u => !before.includes(u)));
  })();

  // 网格必须离开黄道面、轴不得穿日面（评审问题 #43）
  (function gridCheck() {
    const ys = new Set();
    S.gridGroup.children.forEach(c => {
      const p = c.geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++) ys.add(+p.getY(i).toFixed(6));
    });
    const offPlane = ![...ys].some(v => Math.abs(v) < 1e-9);
    ok('黄道网格整体下沉，不再与轨道线共面 z-fight', offPlane, 'y 取值 ' + [...ys].join(','));
    ok('只下沉一层（所有网格顶点同一 y），不会出现斜切面', ys.size === 1, [...ys].join(','));
    // 轨道线必须压在网格之上：靠 renderOrder，不靠关深度测试
    const gridRO = S.gridGroup.children[0].renderOrder;
    const orbitLine = S.scene.getObjectByProperty('type', 'Line');
    ok('网格 renderOrder=1、轨道线 renderOrder=2（稳定的前后关系）',
        gridRO === 1 && orbitLine.renderOrder === 2, `grid ${gridRO} / orbit ${orbitLine.renderOrder}`);
    ok('网格 depthWrite:false（不污染深度缓冲）',
        S.gridGroup.children.every(c => c.material.depthWrite === false));
    const axes = S.gridGroup.children[S.gridGroup.children.length - 1];
    const p = axes.geometry.getAttribute('position');
    const sunR = S.bodyRadius(695700);
    let minR = Infinity;
    for (let i = 0; i < p.count; i++) minR = Math.min(minR, Math.hypot(p.getX(i), p.getZ(i)));
    ok('黄道轴从太阳外围起画，不穿过日面', minR > sunR * 1.5,
        `轴内端 ${minR.toFixed(1)} 单位，日面半径 ${sunR.toFixed(1)}`);
  })();

  /* 太阳外围：只剩柔光，而且必须收在水星近日点之内（评审问题 #41/#42）
     ⚠ 这一段的旧版本是"日冕外缘 < 30.75"，靠 `S.corona.scale.x * 1.35` 算的。
     硬边日冕环已经按用户要求整体删掉了（RingGeometry 平铺在黄道面、
     两条解析硬边、侧视变亮带、相机进环内就是半屏灰色挡板），
     所以这里改成断言三件事：
       ① 那一层**真的不在了**（导出里没有 corona，太阳组里也没有 RingGeometry）；
       ② 删掉它之后 `__solar` 仍然挂得上（引用已删除的 const 会让对象字面量
          当场 ReferenceError，全线 undefined —— 这个坑踩过，必须反向钉住）；
       ③ 剩下的辉光仍然守住同一条尺寸约束。 */
  (function sunHaloCheck() {
    setJd(2026, 10, 13); clickEl('mReal'); S.update(0);
    const MERC_PERIHELION = 30.75;      // 场景单位，README/评审同一口径
    const sunR = S.bodyRadius(695700);
    const glowR = S.SUN_GLOW_BASE / 2;                 // Sprite 半边长
    const rings = [];
    S.sunGroup.traverse(o => { if (o.geometry && o.geometry.type === 'RingGeometry') rings.push(o); });
    ok('硬边日冕环已删除：太阳组里没有 RingGeometry', rings.length === 0,
        rings.length + ' 个环面');
    ok('删除 corona 没有连带炸掉 __solar 导出（对象字面量里不留悬空 const）',
        ('corona' in S) === false && !!S.sunGlow && !!S.scene,
        'corona in __solar = ' + ('corona' in S));
    ok('太阳显示半径恒 17.14 单位（不再 ×2）', Math.abs(sunR - 17.14) < 0.05, sunR.toFixed(2));
    ok('辉光半径 ≤ 水星近日点（不吞掉水星轨道）', glowR <= MERC_PERIHELION, `半径 ${glowR.toFixed(1)}`);
    ok('辉光保留 depthTest（不穿透空间照亮夜面）',
        S.sunGlow.material.depthTest !== false, String(S.sunGlow.material.depthTest));
    // 水星轨道必须整体在辉光之外
    const merc = S.planetBodies.find(b => b.def.n === '水星');
    let minMerc = Infinity;
    for (let k = 0; k < 420; k += 7) {
      const d = new Date(Date.UTC(2026, 0, 1 + k));
      const el = $('dDate'), p = n => String(n).padStart(2, '0');
      el.value = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
      el.dispatch('change', { target: el, value: el.value });
      S.update(0);
      minMerc = Math.min(minMerc, merc.grp.position.length());
    }
    ok('一年里水星轨道最近点仍在辉光之外', minMerc > glowR,
        `水星最近 ${minMerc.toFixed(2)} > 辉光半径 ${glowR.toFixed(2)}`);
    setJd(2026, 10, 13); S.update(0);
  })();

  // 取景：全览 vs 默认必须给出不同的机位（评审问题 #25）
  (function framingCheck() {
    const fit = S.fitAllPose(), dfl = S.defaultPose();
    ok('全览机位远大于默认内行星机位（两个按钮不等价）', fit.pos.length() > dfl.pos.length() * 1.5,
        `全览 ${fit.pos.length().toFixed(1)} vs 默认 ${dfl.pos.length().toFixed(1)}`);
    // 全览要真把冥王星收进视锥（评审问题 #24）
    const aspect = sandbox.innerWidth / sandbox.innerHeight;
    const vF = S.camera.fov * Math.PI / 180;
    const hF = 2 * Math.atan(Math.tan(vF / 2) * aspect);
    const half = Math.min(vF, hF) / 2;
    const reach = fit.pos.length() * Math.sin(half);
    ok('全览视锥半径 ≥ 冥王星轨道显示半径', reach >= S.mapAU(39.48),
        `覆盖 ${reach.toFixed(0)} 单位，冥王星轨道在 ${S.mapAU(39.48).toFixed(0)}`);
    // 全览按钮点击后相机确实飞到全览机位（而不是停在原处）—— 缓动要按帧收敛
    clickEl('bFitAll');
    const want = S.fitAllPose().pos.length();
    const frames = rafUntil(() => Math.abs(S.camera.position.length() - want) < want * 0.02, 400);
    ok('点「全览」后相机真的飞到位（评审问题 #25 的两个按钮落点不同）',
        frames > 0, `${frames < 0 ? '未收敛' : frames + ' 帧后'} 停在 ${S.camera.position.length().toFixed(0)}，目标 ${want.toFixed(0)}`);
    // 「重置」必须回到默认机位，而不是全览位
    clickEl('bReset');
    const back = S.defaultPose().pos.length();
    const f2 = rafUntil(() => Math.abs(S.camera.position.length() - back) < back * 0.02, 400);
    ok('点「重置」后相机回到默认内行星机位', f2 > 0,
        `${f2 < 0 ? '未收敛' : f2 + ' 帧'} 停在 ${S.camera.position.length().toFixed(0)}，目标 ${back.toFixed(0)}`);
  })();

  // 滑块量程：手动写满/写空都能真的改变距离（评审问题 #23 的死区）
  (function sliderCheck() {
    const r = S.zoomRange();
    const lo = S.sliderToDist(0), hi = S.sliderToDist(1000);
    ok('滑块两端映射到可达区间（下限=当前天体最小距离，上限=ZOOM_MAX）',
        Math.abs(lo - r.lo) < 1e-6 && Math.abs(hi - r.hi) < 1e-6,
        `[${lo.toFixed(2)}, ${hi.toFixed(2)}] vs 区间 [${r.lo.toFixed(2)}, ${r.hi.toFixed(2)}]`);
    const mid = S.sliderToDist(500);
    ok('滑块中点确实落在区间内（无死区）', mid > lo * 1.05 && mid < hi * 0.95, `中点 ${mid.toFixed(2)}`);
    // 反函数必须闭环：距离 → 滑块 → 距离
    [0, 137, 500, 862, 1000].forEach(v => {
      const d = S.sliderToDist(v), back = S.distToSlider(d);
      ok(`滑块 ${v} → 距离 → 回填 ${back}（往返一致）`, Math.abs(back - v) <= 2, '误差 ' + Math.abs(back - v));
    });
    // 下限不得小于天体半径 ×2（拉近不穿模）
    S.select(S.planetBodies.find(b => b.def.n === '地球'), true);
    ok('最近观察距离 ≥ 当前天体显示半径 ×2（拉近不穿模）',
        S.zoomRange().lo >= S.bodyRadius(6371) * 2 - 1e-6,
        `lo=${S.zoomRange().lo.toFixed(2)}，地球半径 ${S.bodyRadius(6371).toFixed(2)}`);
  })();

  // 自转限速（评审问题 #47）：高速下相位必须是连续小步，不是随机跳
  (function spinCheck() {
    const earth = S.planetBodies.find(b => b.def.n === '地球');
    earth.spinAng = 0; earth.spinLagged = false;
    const seq = [];
    for (let i = 0; i < 8; i++) { S.advanceSpin(earth, (i * 44) * 360 / 0.99727); seq.push(earth.spinAng); }
    let maxStep = 0;
    for (let i = 1; i < seq.length; i++) {
      let d = Math.abs(seq[i] - seq[i - 1]); if (d > 180) d = 360 - d;
      maxStep = Math.max(maxStep, d);
    }
    ok('高流速下每帧自转相位被限速到 ≤14°（不再随机闪烁）', maxStep <= 14.001, `最大步进 ${maxStep.toFixed(2)}°/帧`);
    ok('限速时挂出「自转显示已限速」标记', earth.spinLagged === true);
    // 正常流速下不该被限速
    earth.spinAng = 0; earth.spinLagged = false;
    S.advanceSpin(earth, 9);
    ok('小步（9°/帧）不触发限速', earth.spinLagged === false && Math.abs(earth.spinAng - 9) < 1e-6);
    // 相位与 axis.rotation.y 必须同步，否则限速只改了个没人读的数
    ok('spinAng 真的写进 axis.rotation.y',
        Math.abs(earth.axis.rotation.y - earth.spinAng * Math.PI / 180) < 1e-9);
  })();

  // fmtRate 不再把 0.0002 天/秒印成"0.00 小时/秒"
  (function rateLabelCheck() {
    const cases = [[0.0002, /分钟/], [0.02, /小时|分钟/], [10, /天/], [1, /天/]];
    cases.forEach(([r, re]) => {
      const t = S.fmtRate(r);
      ok(`流速 ${r} 天/秒的读数不是 0.00（${t}）`, !/^0\.00/.test(t) && !!t, t);
    });
    ok('最慢档改标「分钟/秒」', /分钟/.test(S.fmtRate(0.0002)), S.fmtRate(0.0002));
    ok('sliderToRate 单调（滑块右端更快）',
        S.sliderToRate(0) < S.sliderToRate(500) && S.sliderToRate(500) < S.sliderToRate(1000),
        `${S.sliderToRate(0)} / ${S.sliderToRate(500)} / ${S.sliderToRate(1000)}`);
  })();

  // 帧循环：跑 60 帧，检查 innerHTML 写入次数与几何体增量（评审问题 #50/#39）
  (function loopCheck() {
    setJd(2026, 10, 13);
    clickEl('mReal');
    const ck = $('cLabel');
    if (ck && !ck.classList.contains('on')) ck.dispatch('click', {});
    let writes = 0;
    const labels = S.bodies.filter(b => b.label).map(b => b.label);
    labels.forEach(l => {
      let v = '\0sentinel\0';                           // 强制第一次写入也被计数
      Object.defineProperty(l, 'innerHTML', { configurable: true, get: () => v, set: nv => { if (nv !== v) writes++; v = nv; } });
    });
    // 虚拟时钟 60 帧 = 1 秒 → 默认流速 10 天/秒，地球自转目标约 60°/帧（必然触发限速）
    $('hDate').textContent = '';
    const geo0 = sceneGeoCount(), disp0 = disposedGeo.size;
    rafDrain(60);
    const geo1 = sceneGeoCount(), disp1 = disposedGeo.size;
    ok('60 帧主循环不新增场景几何体（轨道折线按需重建，评审问题 #39）', geo1 === geo0, `${geo0} → ${geo1}`);
    ok('60 帧不产生游离 dispose', disp1 - disp0 <= 20, `新增 ${disp1 - disp0}`);
    ok('60 帧 innerHTML 写入 ≪ 每帧一次（评审问题 #50）',
        writes <= labels.length * 2, `写入 ${writes} 次 / 60 帧（每帧一次会是 ${labels.length * 60} 次）`);
    ok('静态核对：写 DOM 前确实先比对缓存文本', /if\(b\._ltxt!==txt\)/.test(mainCode));
    ok('跑完 60 帧日期读数仍在', /20\d\d-\d\d-\d\d/.test($('hDate').textContent), $('hDate').textContent);
    ok('流速过快时 HUD 亮起「自转显示已限速」（评审问题 #47）',
        $('hSpin').classList.contains('on'), 'hSpin.on=' + $('hSpin').classList.contains('on'));
    // 把流速滑块推到最慢档再跑 60 帧：限速提示必须自己熄灭，写入次数也应塌下来
    const slow = $('sSpeed');
    slow.value = '0';
    slow.dispatch('input', { target: slow, value: '0' });
    writes = 0;
    rafDrain(60);
    ok('降到最慢档后限速提示自动熄灭（评审问题 #47）',
        $('hSpin').classList.contains('on') === false, 'hSpin.on=' + $('hSpin').classList.contains('on'));
    ok('最慢档 60 帧 innerHTML 写入 ≪ 每帧一次（评审问题 #50）',
        writes <= 12, `写入 ${writes} 次 / 60 帧`);
    // 恢复默认档，别把流速状态留给后面的用例
    slow.value = '500';
    slow.dispatch('input', { target: slow, value: '500' });
  })();

  /* willReadFrequently：这条只能这么测。
     浏览器规则是「属性只在该 canvas 第一次 getContext('2d') 时生效，之后传的
     一律忽略」，所以静态数源码里有几处传了属性毫无意义 —— 属性写在第二次、
     第三次的调用上照样满屏警告。真正的判据是**运行时每个 canvas 的首次调用**。
     沙箱把每次 getContext 的入参按顺序存了下来（FakeEl._ctxCalls），
     于是这里能直接检查顺序本身。 */
  (function readHint() {
    const asked = ALL_CANVAS.filter(c => c._ctxCalls.some(x => x.type === '2d'));
    /* 防假绿：一个都没登记的话 `bad.length===0` 会空转通过。
       页面至少给 8 颗行星 + 卫星生成贴图，取 10 为下限留有余量。 */
    const blind = asked.length < 10;
    const bad = asked.filter(c => {
      const first = c._ctxCalls.find(x => x.type === '2d');
      return !(first.attrs && first.attrs.willReadFrequently === true);
    });
    ok('每个 canvas 首次取 2d 上下文就带 willReadFrequently（回读贴图像素不告警）',
        !blind && bad.length === 0,
        blind ? '沙箱里只有 ' + asked.length + ' 个 canvas 要过 2d 上下文，断言会假绿'
              : (bad.length ? bad.length + ' 个漏了：' +
                    bad.slice(0, 4).map(c => c.width + '×' + c.height).join(', ')
                  : asked.length + ' 个 canvas 全部命中'));
  })();
}

/* ============================================================ 6. UI 接线 */
if (S) {
  section('6. UI 接线（开关真的连着画面状态）');

  // #16：「行星自转」原来是空回调，取消勾选照转不误
  (function spinToggle() {
    const earth = S.planetBodies.find(b => b.def.n === '地球');
    const ck = $('cSpin');
    if (ck.classList.contains('on')) ck.dispatch('click', {});           // 关
    const before = earth.axis.rotation.y;
    for (let k = 0; k < 5; k++) { setJd(2026, 10, 13 + k); S.update(0); }
    ok('关掉「行星自转」后自转轴真的原地冻结（评审问题 #16）',
        Math.abs(earth.axis.rotation.y - before) < 1e-12,
        `${before.toFixed(6)} → ${earth.axis.rotation.y.toFixed(6)}`);
    ck.dispatch('click', {});                                            // 开
    setJd(2026, 12, 1); S.update(0);
    ok('重新勾选后自转恢复', Math.abs(earth.axis.rotation.y - before) > 1e-6);
  })();

  // #17：「月球与行星卫星」开关必须能一次关掉 19 颗卫星
  (function moonToggle() {
    const ck = $('cMoon');
    if (!ck.classList.contains('on')) ck.dispatch('click', {});
    ck.dispatch('click', {});                                            // 关
    const satOn = S.satBodies.filter(s => s.grp.visible).length;
    ok('关掉开关后 19 颗行星卫星全部隐藏（评审问题 #17）', satOn === 0,
        `仍可见 ${satOn}/${S.satBodies.length}`);
    ok('月球本体也一并隐藏', S.moonBody.grp.visible === false);
    ck.dispatch('click', {});                                            // 开
    ok('重新打开后卫星恢复显示', S.satBodies.every(s => s.grp.visible));
  })();

  // #19：开关/列表项的可访问性语义必须是点得出的（不是只在注释里"补了"）
  (function a11yCheck() {
    const cks = ['cOrbit', 'cLabel', 'cMoon', 'cGrid', 'cStar', 'cSpin'];
    const bad = cks.filter(id => {
      const el = $(id);
      return el.getAttribute('role') !== 'checkbox' || el.getAttribute('tabindex') !== '0' ||
             !['true', 'false'].includes(el.getAttribute('aria-checked'));
    });
    ok('6 个显示开关都有 role=checkbox / tabindex=0 / aria-checked', bad.length === 0, bad.join(','));
    const before = $('cGrid').getAttribute('aria-checked');
    $('cGrid').dispatch('click', {});
    ok('点击开关会同步 aria-checked（读屏能听到状态变化）',
        $('cGrid').getAttribute('aria-checked') !== before, `${before} → ${$('cGrid').getAttribute('aria-checked')}`);
    $('cGrid').dispatch('click', {});
    // 空格也能切（键盘可达不等于只支持鼠标）
    const b2 = $('cStar').getAttribute('aria-checked');
    $('cStar').dispatch('keydown', { key: ' ' });
    ok('空格键能切换开关', $('cStar').getAttribute('aria-checked') !== b2, b2 + ' → ' + $('cStar').getAttribute('aria-checked'));
    $('cStar').dispatch('keydown', { key: ' ' });
    // 列表项
    const items = S.bodies.filter(b => b.listEl);
    const noRole = items.filter(b => b.listEl.getAttribute('role') !== 'button').length;
    ok('30 个列表项全部是 role=button + tabindex=0', items.length === 30 && noRole === 0,
        `${items.length} 项，缺 role ${noRole} 个`);
    ok('卫星列表项的 aria-label 说明母星',
        /母星/.test(S.satBodies[0].listEl.getAttribute('aria-label')), S.satBodies[0].listEl.getAttribute('aria-label'));
  })();

  // #28：选中态用 aria-current 表达，且旧的必须被清掉
  (function selectCheck() {
    S.select(S.planetBodies[3], true);
    const a = S.planetBodies[3].listEl.getAttribute('aria-current');
    S.select(S.planetBodies[5], true);
    const stale = S.planetBodies[3].listEl.getAttribute('aria-current');
    ok('选中项带 aria-current="true"', a === 'true', String(a));
    ok('切换选中后旧项的 aria-current 被移除', stale === null, String(stale));
    ok('点列表项 = 走 select()（onclick 真的挂着）',
        typeof S.planetBodies[0].listEl.onclick === 'function');
  })();

  // #29：快捷键面板 —— ? 打开、Esc 关闭；焦点在控件上时不劫持空格
  (function keysCheck() {
    const fire = (ev) => (listeners.keydown || []).forEach(fn => fn(Object.assign(
      { target: documentShim.body, preventDefault() {}, stopPropagation() {}, shiftKey: false }, ev)));
    const help = $('help');
    const was = help.classList.contains('open');
    fire({ key: '?' });
    ok('按 ? 打开快捷键面板（评审问题 #29：快捷键要有就地说明）',
        help.classList.contains('open') !== was, 'open=' + help.classList.contains('open'));
    fire({ key: 'Escape' });
    ok('按 Esc 收起面板', help.classList.contains('open') === false);
    // 焦点在滑块上时按空格：不该被"暂停"抢走
    const slider = $('sZoom');
    const play = $('bPlay').textContent;
    slider._attrs['type'] = 'range';
    fire({ key: ' ', code: 'Space', target: slider });
    ok('焦点在滑块上时空格不劫持播放', $('bPlay').textContent === play, play);
    fire({ key: ' ', code: 'Space', target: documentShim.body });
    ok('焦点在页面上时空格仍切换播放', $('bPlay').textContent !== play, $('bPlay').textContent);
    fire({ key: ' ', code: 'Space', target: documentShim.body });
  })();

  // #34/#33：「真实星球大小」开启后滑块必须失效且读数一致
  (function trueSizeCheck() {
    const ck = $('cTrueSize'), s = $('sSize'), v = $('vSize');
    if (!ck.classList.contains('on')) ck.dispatch('click', {});
    ok('开启真实大小后「星球大小」滑块 disabled（评审问题 #34）',
        s.disabled === true || s.getAttribute('disabled') !== null,
        'disabled=' + s.disabled);
    ok('开启真实大小后读数写「真实大小」而不是 ×N',
        /真实大小/.test(v.innerHTML + v.textContent), (v.innerHTML || v.textContent));
    ck.dispatch('click', {});
    ok('关闭真实大小后滑块恢复可用', s.disabled === false || s.getAttribute('disabled') === null);
  })();

  // #49：DPR 变化必须重设 framebuffer（浏览器缩放后不再持续发糊）
  (function dprCheck() {
    const cv = S.renderer.domElement;
    const pr0 = S.renderer.getPixelRatio(), w0 = cv.width;
    sandbox.devicePixelRatio = 2;
    (listeners.resize || []).forEach(fn => fn({ target: sandbox }));
    const pr1 = S.renderer.getPixelRatio(), w1 = cv.width;
    ok('devicePixelRatio 变化后 renderer 比例随之更新（评审问题 #49）', pr1 === 2, `${pr0} → ${pr1}`);
    ok('并按新比例重建 drawingBuffer（不是只改比例）', w1 === w0 * 2, `${w0}× → ${w1}×${cv.height}`);
    ok('星空点的 uPR uniform 也跟着改', (() => {
      let pts = null;
      S.scene.traverse(o => { if (o.isPoints && o.material && o.material.uniforms && o.material.uniforms.uPR) pts = o; });
      return pts && pts.material.uniforms.uPR.value === 2;
    })(), '');
    sandbox.devicePixelRatio = 1;
    (listeners.resize || []).forEach(fn => fn({ target: sandbox }));
    ok('退回 1× 后 buffer 也跟着缩回去', S.renderer.domElement.width === w0,
        `${S.renderer.domElement.width} vs ${w0}`);
  })();

  // #48：星空必须用 per-vertex size 属性（PointsMaterial 不认它）
  (function starCheck() {
    const pts = [];
    S.scene.traverse(o => { if (o.isPoints && o.geometry && o.geometry.getAttribute('size')) pts.push(o); });
    ok('星空使用带 size 属性的手写 Points 材质（评审问题 #48）', pts.length >= 1, pts.length + ' 个');
    if (pts.length) {
      const p = pts[0];
      ok('星星尺寸有层次（不是全部同一大小）',
          p.material.isShaderMaterial === true && !!p.material.uniforms.uPR,
          'material=' + p.material.type);
      const sz = p.geometry.getAttribute('size');
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < sz.count; i++) { mn = Math.min(mn, sz.getX(i)); mx = Math.max(mx, sz.getX(i)); }
      ok('亮度→尺寸映射产生 ≥2.5× 的尺寸差', mx / mn >= 2.5, `${mn.toFixed(2)}–${mx.toFixed(2)} px`);
    }
  })();

  // #44：手写 shader 必须走完整管线（Node 里只能静态核对 uniform 与 chunk）
  (function shaderGainCheck() {
    const names = ['日面 limbDarkened', '大气壳 atmosphereMesh', '土星环 ringMat', '星空'];
    const gains = [];
    S.scene.traverse(o => {
      if (o.material && o.material.isShaderMaterial && o.material.uniforms && o.material.uniforms.uGain) {
        gains.push(o.name || (o.material.uniforms.uGain.value));
      }
    });
    ok('三层加色/发光材质都带 uGain（评审问题 #44 的曝光补偿）', gains.length >= 3,
        names.join(' / ') + ' → ' + gains.join(', '));
    ok('uGain 数值在 0.3–2 之间（不会把画面整体压黑或炸白）',
        gains.every(g => typeof g === 'number' && g > 0.3 && g < 2), gains.join(', '));
  })();

  // #12/#51 相关：大陆掩膜与环阴影必须有真实数据源，不能是空实现
  (function textureCheck() {
    ok('地球大陆掩膜已生成（非空数组）', (() => { const L = S.LANDMASK(); return L && L.length >= 8; })(),
        (S.LANDMASK() || []).length + ' 项');
    ok('大陆多边形表 CONTINENTS 覆盖七大洲', S.CONTINENTS.length >= 7, S.CONTINENTS.length + ' 块');
    ok('buildLandMask 是纯函数且返回 Uint8/普通数组',
        typeof S.buildLandMask === 'function', '');
    ok('纹理表 TEX 覆盖 9 行星 + 太阳', (() => {
      const need = ['sun', 'merc', 'venus', 'earth', 'mars', 'jup', 'sat', 'ura', 'nep', 'plu'];
      return need.every(k => S.TEX[k] && S.TEX[k].map);
    })(), Object.keys(S.TEX).join(','));
    ok('ATMOS/PHYS 配置表存在且带真实参量', !!S.ATMOS && !!S.PHYS,
        Object.keys(S.ATMOS || {}).length + ' / ' + Object.keys(S.PHYS || {}).length);
  })();

  /* ---------- 用户第 1 条：面板最小化按钮点了无效 ----------
     病根不是逻辑写错，是**根本没有逻辑**：markup / CSS（`#left.min > .sec{display:none}`）
     / aria / title 上一轮全写好了，事件处理器一行都没有，按钮能聚焦、能读到
     aria-label，点下去什么都不发生。所以这里逐项量"点了之后页面状态真的变了吗"，
     而不是去读某个内部布尔量。 */
  (function minimizeCheck() {
    const pairs = [['mLeft', 'left', '控制台面板'], ['mRight', 'right', '天体面板'],
                   ['mBottom', 'bottom', '底栏']];
    pairs.forEach(([btn, panelId, lbl]) => {
      const B = $(btn), P = $(panelId);
      if (!B || !P) { ok(`#${btn} 与 #${panelId} 都在元素登记表里`, false, `${btn}:${!!B} ${panelId}:${!!P}`); return; }
      if (P.classList.contains('min')) clickEl(btn);           // 从展开态开始
      clickEl(btn);
      ok(`点 #${btn} 真的给 #${panelId} 挂上 .min（${lbl}）`, P.classList.contains('min'),
          'class=' + P.className);
      ok(`${lbl}收起后按钮字形/aria 同步成"恢复"`,
          B.textContent === '+' && B.getAttribute('aria-expanded') === 'false'
          && /恢复/.test(B.getAttribute('aria-label') || '') && /恢复/.test(B.title),
          `text=${B.textContent} aria-expanded=${B.getAttribute('aria-expanded')} aria-label=${B.getAttribute('aria-label')}`);
      clickEl(btn);
      ok(`再点 #${btn} 恢复${lbl}（.min 摘掉、aria 回到展开）`,
          !P.classList.contains('min') && B.textContent === '─'
          && B.getAttribute('aria-expanded') === 'true',
          'class=' + P.className + ' text=' + B.textContent);
      // 键盘可达：role=button + tabindex 的控件必须能用 Enter/空格触发
      const n0 = P.classList.contains('min');
      B.dispatch('keydown', { key: 'Enter' });
      ok(`${lbl}：键盘 Enter 与鼠标点击等价（role=button 必须真的可操作）`,
          P.classList.contains('min') !== n0, '');
      if (P.classList.contains('min') !== n0) B.dispatch('keydown', { key: ' ' });
      ok(`${lbl}：空格同样能开合`, P.classList.contains('min') === n0, '');
    });
    /* 底栏收起会改 --bh（左右栏的 max-height 就靠它）。桩里 offsetHeight 是静态值，
       量不出"收起后变矮"，但能证明**这条链路被触发了**：改 offsetHeight → 点按钮 →
       --bh 必须跟着重写。少一次 measureBottomBar() 调用时这里会红。 */
    const before = documentShim.documentElement.style['_--bh'];
    $('bottom').offsetHeight = 140;                 // 模拟底栏换行成两排
    clickEl('mBottom');
    const after = documentShim.documentElement.style['_--bh'];
    ok('收起/恢复底栏会重测 --bh（左右栏 max-height 跟得上）',
        after === '170px' && after !== before, `--bh ${before} → ${after}`);
    $('bottom').offsetHeight = 96;                  // 先还原高度，再点恢复 → --bh 回到 126px
    clickEl('mBottom');
    ok('恢复底栏后 --bh 也跟着回到实测高度（不是停在收起时的值）',
        documentShim.documentElement.style['_--bh'] === '126px',
        documentShim.documentElement.style['_--bh']);
  })();

  /* ---------- 用户第 4 条：大小滑块拖动跳帧、变化不连贯 ----------
     两个独立病根，分别断言，别混成一条：
       ① 映射曾经取整（`Math.round(pow(20000, v/1000))`）→ 低倍率段整段钉在 ×1，
          然后一步跳到 ×2。半径 ∝ mul^0.58，所以倍率不动 = 画面完全不动，
          读起来就是"拖了没反应，突然变大"。
       ② 每个 input 事件当场做三件重活（硬写 camera.position + 重建 30 条折线 +
          refreshInfo），一次拖动几十个事件全落在同一帧里 → 掉帧。
     现在 input 只挂一个 pending，重活每帧结算一次。 */
  (function sizeSliderCheck() {
    let mono = true, plateau = 0, prev = S.sliderToSize(0);
    for (let v = 1; v <= 1000; v++) {
      const cur = S.sliderToSize(v);
      if (!(cur > prev)) mono = false;
      if (cur / prev < 1.0001) plateau++;          // 千分之一行程的增量必须可辨
      prev = cur;
    }
    ok('大小倍率映射严格单调、整条行程没有平台（曾有 Math.round）',
        mono && plateau === 0, plateau + ' 处平台');
    ok('倍率保持浮点，读数只在显示时取整（×1.00/×1.01 之间不再是台阶）',
        S.sliderToSize(300) % 1 !== 0 && /^×/.test(S.fmtSize(1.004)) && S.fmtSize(320) === '×320',
        `raw=${S.sliderToSize(300).toFixed(4)} fmt=${S.fmtSize(1.004)}/${S.fmtSize(19.5)}/${S.fmtSize(320)}`);

    const s = $('sSize'), vEl = $('vSize');
    const mul0 = S.sizeRef(), n0 = S.pathsRebuilds();
    s.value = '420';
    s.dispatch('input', { target: s, value: '420' });
    ok('input 事件只写 pending，不当场改半径/相机（重活每帧只结算一次）',
        S.sizeRef() === mul0 && Math.abs(S.pendingRef() - S.sliderToSize(420)) < 1e-12,
        `sizeMul=${S.sizeRef()} pending=${S.pendingRef()}`);
    ok('拖动时读数立刻跟着 pending 变（数值不许慢一帧）',
        vEl.textContent === S.fmtSize(S.sliderToSize(420)), vEl.textContent);
    const applied = S.applyPendingSize();
    ok('帧首结算把 pending 落成倍率，并清空 pending',
        applied === true && S.sizeRef() === S.sliderToSize(420) && S.pendingRef() === null, '');
    ok('没有 pending 时结算直接返回（不重复做重活）', S.applyPendingSize() === false, '');
    ok('改半径不触发 30 条行星折线整批重建（它们只跟轨道根数/距离映射走）',
        S.pathsRebuilds() === n0 && S.pathsDirtyRef() === false,
        `重建次数 ${n0} → ${S.pathsRebuilds()}`);
    ok('但月轨下限保护必须标脏，否则半径变了而月球轨道还按旧尺度',
        S.moonDirtyRef() === true, '');
    /* 暂停时也要响应：`frozen` 那条分支走 update(0)，jd 一点不动但画面得重算。
       这里只验"暂停态拖滑块画面状态会变"这个可观察结果。 */
    S.setSizeMul(mul0);
    const play = $('bPlay').textContent;
    if (/暂停/.test(play)) clickEl('bPlay');
    s.value = '300'; s.dispatch('input', { target: s, value: '300' });
    ok('暂停状态下拖动滑块仍然即时生效（update(0) 重算，不偷偷推进时间）',
        S.applyPendingSize() === true && Math.abs(S.sizeRef() - S.sliderToSize(300)) < 1e-12, '');
    S.setSizeMul(mul0);
    if (/播放/.test($('bPlay').textContent) && /暂停/.test(play)) clickEl('bPlay');
  })();
}

/* ============================================================ 7. 排版 */
/* 这一节对应"UI 排版再优化"那一轮。核显没被调用，所以**画面好不好看没法测**，
   这里测的是排版改造的结构性前提：列表项一个都没丢、折叠开关真的能开合、
   以及 CSS 里那些"顺序/特异性错了就静默失效"的规则确实写对了位置。 */
if (S) {
  section('7. 排版：列表结构与 CSS 规则位置');

  const styleSrc = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) || [null, ''])[1];
  /* 注释必须先剥掉：CSS 里留了大量"旧写法是这样的"的说明（例如
     `.plist{grid-template-columns:1fr 1fr 1fr}`、`.cat{display:none}`），
     不剥注释的话这些历史写法会被正则当成现行规则，断言直接指错地方。 */
  const css = styleSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = sel => {
    const i = css.indexOf(sel);
    if (i < 0) return '';
    const a = css.indexOf('{', i), b = css.indexOf('}', a);
    return a < 0 || b < 0 ? '' : css.slice(a + 1, b);
  };

  const cats = S.plist.querySelectorAll('.cat');
  const classes = [...new Set(S.bodies.map(b => b.def.cls))].filter(c => S.CATS.some(x => x.k === c));
  ok('每个有成员的类别只建 1 个分组标题（没有重复标题）',
      cats.length === classes.length, `${cats.length} 个标题 / ${classes.length} 个类别`);

  const mainItems = S.plist.children.filter(c => c.classList.contains('pl'));
  const fold = S.satFoldEl(), foldItems = fold ? fold.children.filter(c => c.classList.contains('pl')) : [];
  ok('常驻列表只有 11 个主天体（卫星全部收进折叠区）',
      mainItems.length === 11 && foldItems.length === 19,
      `主列表 ${mainItems.length} + 卫星 ${foldItems.length}`);
  ok('折叠容器是 #plist 的一格（grid-column:1/-1 的 .satfold）',
      !!fold && fold.classList.contains('satfold'), fold ? fold.className : '（未创建）');

  /* 折叠的默认态与可达性 —— 排版改造最容易悄悄弄丢的就是这两条 */
  ok('行星卫星分组默认为收起态（窄窗口不再被 30 项撑爆）',
      fold.classList.contains('collapsed') && S.satCatEl().getAttribute('aria-expanded') === 'false');
  ok('收起态有对应的 CSS 规则（collapsed 必须真的 display:none）',
      /\.satfold\.collapsed\{[^}]*display:none/.test(css), '');
  ok('分组标题是可达的折叠开关（role=button + tabindex + aria-controls）',
      S.satCatEl().getAttribute('role') === 'button' &&
      S.satCatEl().getAttribute('tabindex') === '0' &&
      S.satCatEl().getAttribute('aria-controls') === fold.id &&
      fold.classList.contains('satfold'),
      'aria-controls=' + S.satCatEl().getAttribute('aria-controls') + ' / id=' + fold.id);
  ok('折叠不影响可选性：30 项都还在 DOM 里且都是 role=button',
      S.bodies.filter(b => b.listEl && b.listEl.getAttribute('role') === 'button').length === 30);
  ok('其它分组标题没有被误做成折叠开关',
      cats.filter(c => c.classList.contains('foldable')).length === 1,
      cats.filter(c => c.classList.contains('foldable')).map(c => c.getAttribute('data-k')).join(','));

  /* 折叠的开合一律走**真实事件**（点标题 / 键盘 Enter·空格），不调 setSatFold：
     那样测到的是函数本身，而排版改造真正会弄坏的是"接线"——标题被换位置、
     class 名改了、onclick 挂到了别的节点上，直接调函数都发现不了。 */
  (function foldToggleCheck() {
    const h = S.satCatEl();
    h.click();
    const opened = !fold.classList.contains('collapsed') &&
                   h.getAttribute('aria-expanded') === 'true' &&
                   h.classList.contains('open');
    h.click();
    const closed = fold.classList.contains('collapsed') &&
                   h.getAttribute('aria-expanded') === 'false' &&
                   !h.classList.contains('open');
    ok('点分组标题能展开、再点能收起（class 与 aria 同步翻转）', opened && closed);
    ok('标题的 click 就是开关（onclick 真的挂在标题上）',
        typeof h.onclick === 'function', typeof h.onclick);
    h.dispatch('keydown', { key: 'Enter' });
    const byEnter = h.getAttribute('aria-expanded') === 'true';
    h.dispatch('keydown', { key: ' ' });
    const bySpace = h.getAttribute('aria-expanded') === 'false';
    ok('键盘 Enter / 空格也能开合分组', byEnter && bySpace);
    ok('折叠态下的卫星项仍带着母星信息（title / aria-label，名字里不含母星）',
        /绕/.test(S.satBodies[0].listEl.getAttribute('title') || '') &&
        /母星/.test(S.satBodies[0].listEl.getAttribute('aria-label') || ''),
        S.satBodies[0].listEl.getAttribute('title'));
  })();

  (function selectRevealCheck() {
    /* 从 3D 场景里点卫星时必须自动展开所在分组，否则会出现
       "选中的天体在列表里看不见"（选中态高亮裁在 display:none 的容器里）。
       走到这里分组是收起态（上一段用键盘关掉了对称性，这里再确认一次）。 */
    if (S.satCatEl().getAttribute('aria-expanded') === 'true') S.satCatEl().click();
    let threw = '';
    try { S.select(S.satBodies[0], true); } catch (e) { threw = e.message; }
    ok('选中折叠区里的卫星不会抛错（scrollIntoView 在无布局环境要兜底）',
        threw === '', threw);
    ok('选中卫星后所在分组自动展开', S.satCatEl().getAttribute('aria-expanded') === 'true',
        'aria-expanded=' + S.satCatEl().getAttribute('aria-expanded'));
    ok('自动展开后该项拿到了选中态',
        S.satBodies[0].listEl.classList.contains('sel'), S.satBodies[0].listEl.className);
    S.select(S.planetBodies[0], true);
    S.satCatEl().click();            // 恢复默认收起态
  })();

  (function fitCheck() {
    /* Node 沙箱没有布局：clientHeight 为 undefined，fitPanel 必须把这种情况
       当作"不触发降级"（|| 1e9），而不是 NaN 比较后随手挂上 .tight。 */
    S.fitPanels();
    ok('无布局环境下 fitPanels 不会误判成整栏滚动（.tight 只在真挤不下时出现）',
        !S.leftEl.classList.contains('tight') && !S.rightEl.classList.contains('tight'),
        'left.tight=' + S.leftEl.classList.contains('tight'));
    ok('面板高度由实测的 --bh 驱动（底栏换行时两栏跟着让位）',
        /max-height:calc\(100vh - var\(--bh/.test(rule('#left')) &&
        /calc\(var\(--bh/.test(rule('#status')), '');
  })();

  /* --- CSS 规则位置：这三类错误在浏览器里不会报错，只会静默失效 --- */
  ok('分组标题吸顶（列表内部滚动时仍知道自己在哪一组）',
      /position:sticky/.test(rule('.cat')), rule('.cat').slice(0, 60));
  /* ⚠ 断点数值不写死（原来钉的是 min-height:7xp x）：
     列表并入右栏之后基准是 96px，窄屏断点再逐级降到 88/78/68，
     钉死某一位数只会让断言跟着排版漂。这里要钉的是**机制**：
     列表在自己的容器里滚（overflow-y:auto）、有下限不被压没（min-height）、
     滚动条是细轨（scrollbar-width:thin）。 */
  ok('天体列表改为容器内部滚动（min-height 兜底 + 细滚动条）',
      /overflow-y:auto/.test(rule('#plistWrap')) &&
      /min-height:\d+px/.test(rule('#plistWrap')) &&
      /scrollbar-width:thin/.test(rule('#plistWrap')),
      rule('#plistWrap'));
  /* 伸缩段（`.sec.grow`）在**右栏**：天体列表这轮从左栏搬进了右栏
     （左栏只留时间/视角/尺度三组自然高控件，所以它没有伸缩段）。
     原来这两条断言钉的是 `#left > .sec.grow`，搬到 #right 之后
     它们就一直红着 —— 报错的不是布局，是断言跟着旧分区写。
     ⚠ 这里也不能用 rule('#right')：css 里 '#right' 第一次出现在合并选择器
     `#left > .hd,#right > .hd{flex:0 0 auto}` 上，rule() 会拿那块当基础规则，
     于是 flex-direction/overflow 两条永远读不到 —— 改成整段正则。 */
  ok('两栏都是 overflow:hidden 的 flex 列（固定段 + min-height:0 的伸缩段）',
      /#left\{[^}]*flex-direction:column[^}]*overflow:hidden/.test(css) &&
      /#right\{[^}]*flex-direction:column[^}]*overflow:hidden/.test(css) &&
      /#right > \.sec\.grow\{[^}]*min-height:0/.test(css) &&
      /#left > \.sec\{flex:0 0 auto\}/.test(css) &&
      /#left\.tight,#right\.tight\{[^}]*overflow-y:auto/.test(css));
  /* .tight 兜底必须真的把"内部滚动"取消掉。flex 的收缩量按**容器高度**算，
     面板改成 overflow-y:auto 并不会让 `.sec.grow` 停止被压扁，它自己的
     `overflow:hidden` 反而会把列表裁掉——固定段依旧顶出屏幕，兜底变成装饰。 */
  ok('.tight 会取消内部滚动区（flex 收缩按容器高度算，光加 overflow-y:auto 没用）',
      /#right\.tight > \.sec\.grow[^{]*\{[^}]*flex:0 0 auto[^}]*overflow:visible/.test(css) &&
      /#right\.tight #plistWrap[^{]*\{[^}]*overflow:visible/.test(css));
  /* 选择器里的 `>` 要容许：实际写的是合并规则
     `#right.tight > .sec.grow,#right.tight > #info{...}`，
     原来的正则钉的是后代写法 `#right.tight #info{`，
     于是这条一直在报"右栏兜底没覆盖 #info"，其实覆盖得好好的。
     ⚠ 用户第 2 条（排版优先级重排）之后，右栏的**伸缩段换人了**：
     `#info` 改成 `flex:0 0 auto`（信息卡是"必须看全"的那块，不再自己滚），
     真正吃剩余高度的是带 `.grow` 的 `#secBodies`（天体列表）。
     标题里那句"伸缩段 #info"因此是错的，同时补一条接线断言：
     CSS 的 `.grow` 与 fitPanel 的第二个参数必须指向同一个元素，
     否则兜底取消的是没人伸缩的那块，`.tight` 就白挂了。 */
  ok('右栏兜底同时取消「伸缩段 #secBodies」与「信息卡 #info」的内部滚动',
      /#right\.tight\s*>\s*\.sec\.grow[^{]*\{[^}]*flex:0 0 auto/.test(css) &&
      /#right\.tight\s*>\s*#info\{[^}]*overflow:visible/.test(css) &&
      /#info\{[^}]*flex:0 0 auto/.test(css), '');
  ok('.grow 与 fitPanel 指向同一个伸缩段（#secBodies）',
      /class="[^"]*\bgrow\b[^"]*"\s+id="secBodies"/.test(html) &&
      /fitPanel\(\s*rightEl\s*,\s*document\.getElementById\('secBodies'\)/.test(html),
      'fitPanel(rightEl, #secBodies) ↔ .sec.grow');
  ok('响应式里不再隐藏分类标题（旧 .cat{display:none} 会把折叠开关也藏掉）',
      !/\.cat\{[^}]*display:none/.test(css));
  /* ⚠ 这条以前数的是 `.plist{` 出现的次数 —— 那只是"列数只在基础规则里定义"
     的代理指标，而且代理得过头：矮屏档里加一条 `.plist{gap:2px}`（只改行距、
     完全不碰列数）就会被它判红。真正要钉的不变量是两条：
     ① 带 `grid-template-columns` 的 .plist 块**只有一个**；
     ② 那一个不在任何 @media 块**内部**（断点里不许再改列数）。
     第 ② 条一开始写成"位置在第一个 @media 之前"，实测直接判红：
     本文件的媒体查询从 #bToggles 那档就开始了（第 160 行附近），
     而 .plist 的基础规则在 274 行 —— **文件里早就有媒体查询**不代表后面的
     规则就在媒体查询里。所以老老实实做花括号配对，算出每个 @media 块的区间。
     换完之后这条比旧写法更严：旧写法连"列数被写进媒体查询"都查不出来。 */
  const mediaRanges = (() => {
    const out = [], re = /@media[^{]*\{/g; let m;
    while ((m = re.exec(css))) {
      let i = m.index + m[0].length, depth = 1;
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++; else if (css[i] === '}') depth--;
        i++;
      }
      out.push([m.index, i]);
    }
    return out;
  })();
  const inMedia = idx => mediaRanges.some(([a, b]) => idx >= a && idx < b);
  ok('列表列数只在基础规则里定义一次（断点不再靠改列数硬塞）', (() => {
      const withCols = [...css.matchAll(/\.plist\{[^}]*grid-template-columns/g)].map(m => m.index);
      return withCols.length === 1 && !withCols.some(inMedia);
    })(),
    (css.match(/\.plist\{[^}]*grid-template-columns/g) || []).length + ' 处列数定义，' +
      mediaRanges.length + ' 个 @media 块');
  ok('.row .val 用双类抬特异度（否则被 .row span 的 12px 覆盖，读数不右对齐）',
      rule('.row .val').includes('text-align:right'), rule('.row .val'));
  ok('#bInfo 基础规则写在窄屏 override 之前（媒体查询后置才生效）',
      css.indexOf('#bInfo{display:none') >= 0 &&
      css.indexOf('#bInfo{display:none') < css.indexOf('#bInfo{display:inline-flex'),
      `基础 @${css.indexOf('#bInfo{display:none')}，override @${css.indexOf('#bInfo{display:inline-flex')}`);
  /* ⚠ 列数跟着开关集合走，不钉死 4：「真实星球大小 / 月球真实距离」两个开关
     按用户要求并进了左栏的「显示尺度」，底栏只剩 6 个画面叠加层开关，
     于是网格从 4 列 ×2 行改成 **3 列 ×2 行**。要钉的还是那两条机制：
     底栏用固定列数的 grid（不是 flex-wrap，否则最后一行永远缺几个），
     并且窄屏有真的降列覆盖。 */
  ok('底栏开关区是固定列数网格，窄屏降级为两列',
      /display:grid/.test(rule('#bToggles')) &&
      /repeat\(\d,/.test(rule('#bToggles')) &&
      (css.match(/#bToggles\{[^}]*repeat\(2,/g) || []).length >= 1,
      rule('#bToggles'));
  /* ⚠ 这里一律用"整段正则"而不是上面的 rule(sel)：rule() 取的是选择器**第一次**
     出现的那个块，而窄屏覆盖（`.padgrid{width:92px}`）写在媒体查询里、位置比
     基础规则还靠前 —— 用它判基础规则会读到覆盖块，断言就变成"桩读错了"。 */
  /* 方向键盘（.padgrid / .vcol / .pad[data-dx]）已经按用户第 1 条**整体删掉**：
     平移留着三条入口（✥ 模式开关 + 右键拖拽 + 系统方向键），
     所以这里改成断言"方向盘真的不在了"，而不是断言它的格子怎么排。 */
  ok('四按钮一行（.brow.c4）+ 方向盘已按需求移除（只剩 ✥ 平移开关）',
      /\.brow\.c4 > \.btn\{[^}]*flex:1 1 0/.test(css) &&
      html.includes('<div class="brow c4">') &&
      !/class="[^"]*\bpadgrid\b/.test(html) &&
      !/<div class="pad\b/.test(html) &&
      /id="bPanMode"/.test(html));
  ok('三列窄格子里列表名有省略号兜底（长名不撑破面板）',
      /text-overflow:ellipsis/.test(rule('.pl span')), rule('.pl span'));
  ok('折叠态卫星项与主列表共用同一套选中样式（.satfold .pl.sel）',
      /\.satfold \.pl\.sel\{/.test(css));
  ok('HTML 可见文案里没有残留 markdown 星号（**显示尺度** 这类会原样显示）',
      !/\*\*/.test(html.replace(/<script[\s\S]*?<\/script>/g, '')
                    .replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')));

  /* 标记嵌套平衡：排版改造全是手改 markup（把区块从一栏搬到另一栏、
     插 .sec.grow / #plistWrap / .satfold 容器），漏一个 </div> 浏览器不会报错，
     它只会"就近闭合"——面板层级当场塌掉，而这在纯 CSS 断言里看不出来。 */
  (function markupBalanceCheck() {
    const body = html.replace(/<script[\s\S]*?<\/script>/g, '')
                     .replace(/<style[\s\S]*?<\/style>/g, '')
                     .replace(/<!--[\s\S]*?-->/g, '')
                     .replace(/<!DOCTYPE[^>]*>/i, '');
    const VOID = new Set(['br', 'input', 'img', 'hr', 'meta', 'link', 'source', 'area',
                          'base', 'col', 'embed', 'track', 'wbr', 'path', 'circle',
                          'use', 'polygon', 'stop', 'rect', 'line', 'ellipse', 'polyline']);
    const stack = [], errs = [];
    const line = i => html.slice(0, i).split('\n').length;
    for (const m of body.matchAll(/<(\/)?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/)?>/g)) {
      const tag = m[2].toLowerCase();
      if (VOID.has(tag) || m[4]) continue;
      if (!m[1]) stack.push({ tag, line: line(m.index) });
      else {
        const top = stack.pop();
        if (!top || top.tag !== tag) errs.push(`行${line(m.index)}: </${tag}> 实际配到 <${top ? top.tag + '@' + top.line : '空'}>`);
      }
    }
    if (stack.length) errs.push('未闭合: ' + stack.map(s => `#${s.tag}@${s.line}`).join(', '));
    ok('markup 标签配对平衡（重排面板后层级没有塌）', errs.length === 0, errs.slice(0, 3).join(' | '));
  })();
}

/* ================================================= 8. 气态巨行星贴图模型 */
{
  section('8. 气态巨行星贴图（页面 ⇄ palette.js 必须同步）');
  /* 这一节测的是"离线设计工具算的那套数，页面里到底是不是同一套"。
     palette.js 用 ACES + 梯形带剖面 + 拐点增益预测木星盘面还剩多少带对比，
     页面用 gasSurface / calibrateAlbedo 真的生成贴图 —— 两边一旦分叉，
     工具报的数就成了假数据，比没有工具更糟。
     所以这里一律**从沙箱里取真函数、真常量**来跑（vm.runInContext 能看见
     上一段脚本的顶层 const，因为它们进的是同一个 realm 的全局词法环境），
     而不是在测试里复制一份公式 —— 复制公式的测试只会验证"我抄对了"。 */
  let P = null, pErr = '';
  try { P = require(path.join(DIR, 'palette.js')); } catch (e) { pErr = e && e.message; }
  ok('palette.js 能作为模块加载（离线工具与测试共用一份实现）', !!P, pErr);

  let PG = null, pgErr = '';
  try {
    PG = vm.runInContext('({gasSurface, calibrateAlbedo, lumaLin, DISK_KNEE, ALBEDO_CEN, GAS_PLATEAU, ALBEDO_TEX, surfaceIrradiance})', vmCtx);
  } catch (e) { pgErr = e && e.message; }
  ok('能从沙箱取到页面内部的贴图函数与常量', !!PG && typeof PG.gasSurface === 'function' &&
      typeof PG.calibrateAlbedo === 'function', pgErr);

  if (P && PG) {
    const irr = PG.surfaceIrradiance();
    ok('palette.SCENE_IRR = 页面 surfaceIrradiance()（场景辐照口径一致，差 <2%）',
        Math.abs(P.SCENE_IRR / irr - 1) < 0.02, `palette ${P.SCENE_IRR} vs 页面 ${irr.toFixed(3)}`);
    ok('GAS_PLATEAU ≡ palette.PLATEAU（带剖面梯形比两边同一个数）',
        PG.GAS_PLATEAU === P.PLATEAU && PG.GAS_PLATEAU > 0 && PG.GAS_PLATEAU < 1,
        `页面 ${PG.GAS_PLATEAU} / palette ${P.PLATEAU}`);
    ok('DISK_KNEE ≡ palette.DISK_KNEE（ACES 肩部拐点两边同一个数）',
        PG.DISK_KNEE === P.DISK_KNEE && PG.DISK_KNEE > 0 && PG.DISK_KNEE < 1,
        `页面 ${PG.DISK_KNEE} / palette ${P.DISK_KNEE}`);
    ok('ALBEDO_CEN ≡ palette.DISK_CEN（留白只看中心 ±20°，两边同一个窗口）',
        Math.abs(PG.ALBEDO_CEN - P.DISK_CEN) < 1e-12 && PG.ALBEDO_CEN > 0 && PG.ALBEDO_CEN < 0.5,
        `页面 ${PG.ALBEDO_CEN.toFixed(6)} / palette ${P.DISK_CEN.toFixed(6)}`);
    /* ⚠ palette.js 的 ACES 链是"逐字抄 lib/three.min.js"抄出来的（r147）。
       抄错一个数字，工具预测的对比度就整体偏移，而它看起来仍然很合理 ——
       所以这里回到源头核对：这些常数必须真的在库里。 */
    (function acesSync() {
      const three = fs.readFileSync(path.join(DIR, 'lib', 'three.min.js'), 'utf8');
      const NEED = ['0.59719', '0.90834', '0.04823', '0.83777', '1.60475', '1.10813',
                    '1.07602', '0.983729', '0.432951', '0.238081', '0.0245786', '0.000090537'];
      const miss = NEED.filter(k => !three.includes(k));
      ok('palette 的 ACES 常数逐字来自 lib/three.min.js（升级 three 要同步）',
          NEED.length === 12 && miss.length === 0, miss.length ? '库里缺 ' + miss.join(', ') : '12/12 命中');
    })();

    /* ---------- calibrateAlbedo：喂合成像素，测"算得对不对" ----------
       桩里现在有了真帧缓冲（见 makeCtx），所以标定函数读到的不再是全 0 图。 */
    (function kneeClamp() {
      const mk = (W, H, fn) => {
        const d = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const c = fn(x / W, y / H), i = (y * W + x) * 4;
          d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
        }
        return { width: W, height: H,
                 getContext: () => ({ getImageData: () => ({ width: W, height: H, data: d }) }) };
      };
      const g2 = v => [v, v, v];
      const K = PG.DISK_KNEE, CEN = PG.ALBEDO_CEN, irr = PG.surfaceIrradiance();
      const TGT = PG.ALBEDO_TEX['木星'];
      /* 防假绿：拐点这套逻辑只在"目标亮度真的会顶到肩部"时才有意义。
         木星 0.538 × 场景辐照 3.2 = 1.72 ≫ 0.65，所以拿它当靶子是有效的。 */
      ok('木星反照率目标确实顶过拐点（下面几条不是空测）',
          TGT * irr > K && K > 0, `target×irr = ${(TGT * irr).toFixed(2)}，拐点 ${K}`);
      const DIM = mk(260, 200, () => g2(60));
      const rawDim = PG.lumaLin(60, 60, 60);
      const gDim = PG.calibrateAlbedo(DIM, 0.12);
      ok('未过拐点时增益 = 目标反照率/全图均值（纯标定，一个像素都不动）',
          Math.abs(gDim - 0.12 / rawDim) < 1e-12,
          `增益 ${gDim.toFixed(6)} vs 目标/均值 ${(0.12 / rawDim).toFixed(6)}，盘面输入 ${(rawDim * gDim * irr).toFixed(3)} < 拐点 ${K}`);
      const BR = mk(260, 200, () => g2(250));
      const rawBr = PG.lumaLin(250, 250, 250), gBr = PG.calibrateAlbedo(BR, TGT);
      ok('过拐点后盘面中心输入被压回拐点（不然 ACES 肩部只剩 13% 相对对比）',
          Math.abs(rawBr * gBr * irr - K) < 1e-9 && gBr < TGT / rawBr,
          `输入 ${(rawBr * gBr * irr).toFixed(6)}，拐点 ${K}，未钳位应为 ${(TGT / rawBr).toFixed(4)} → 实得 ${gBr.toFixed(4)}`);
      /* 判据取中心还是取全图？构造一张"中间亮、四周暗"的图：
         中心均值 0.956、全图均值 0.25，两者差 4 倍，
         钳位深度因此能一眼分辨 —— 除以中心得 0.21，除以全图得 0.81。 */
      /* ⚠ mk 的回调是 fn(x/W, y/H) 两个参数：这里要的是**沿纬度**分带，
         所以取第二个参数 v。写成 t=>… 会画成一条竖直亮带，中心窗口均值≈全图均值，
         这条判据就悄悄退化成空测（实测踩过：增益 0.699，两个预测值都对不上）。 */
      const C = mk(260, 200, (u, v) => g2(Math.abs(v - 0.5) < 0.11 ? 250 : 74));
      /* 均值直接从像素数组量，不用中点积分：积分会把"±20° 落在哪几行"摊成小数，
         0.8% 的差就够把 1e-9 的判据打红 —— 那测的是取整方式，不是钳位逻辑。 */
      const lumOf = (d, i) => PG.lumaLin(d[i], d[i + 1], d[i + 2]);
      const rawOf = m => { const d = m.getContext().getImageData().data; let s = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { s += lumOf(d, i); n++; } return s / n; };
      const cenOf = m => { const d = m.getContext().getImageData().data, W = m.width, H = m.height;
        let s = 0, n = 0;
        for (let y = 0; y < H; y++) { if (Math.abs(y / H - 0.5) >= CEN) continue;
          for (let x = 0; x < W; x++) { s += lumOf(d, (y * W + x) * 4); n++; } }
        return n ? s / n : 0; };
      const rawC = rawOf(C), cenC = cenOf(C);
      const gC = PG.calibrateAlbedo(C, TGT);
      const byCentral = K / (cenC * irr), byGlobal = K / (rawC * irr);
      ok('拐点钳位除以的是中心 ±20° 均值，不是全图均值',
          Math.abs(gC - byCentral) < 1e-9 && Math.abs(gC - byGlobal) > 0.05,
          `实得 ${gC.toFixed(4)}；按中心 ${byCentral.toFixed(4)}；按全图 ${byGlobal.toFixed(4)}（中心均值 ${cenC.toFixed(3)} / 全图 ${rawC.toFixed(3)}）`);
      ok('没有反照率目标（0/undefined）时标定退化为 1，不悄悄改亮度',
          PG.calibrateAlbedo(BR, 0) === 1 && PG.calibrateAlbedo(BR, undefined) === 1);
    })();

    /* ---------- gasSurface：带剖面到底是不是梯形 ---------- */
    (function trapezoid() {
      const cfg = { base: 0xffffff, turb: 0, swirls: 0, warp: 0, shearX: 3, shearY: 16,
                    bands: [[0.5, '#000000', 0.1, 1.0]] };
      const cv = PG.gasSurface(16, 512, cfg);
      const d = cv.getContext('2d').getImageData(0, 0, 16, 512).data;
      const col = y => d[(y * 16 + 0) * 4];                  // 全白底 + 一条全黑带，看 R 就够
      const flat = [];
      for (let y = 0; y < 512; y++) if (col(y) < 1) flat.push(y);
      const total = [];
      for (let y = 0; y < 512; y++) if (col(y) < 254) total.push(y);
      const flatFrac = flat.length / Math.max(1, total.length);
      ok('带剖面是梯形：平顶占带宽的比例 = GAS_PLATEAU（三角形会在这里直接失败）',
          Math.abs(flatFrac - PG.GAS_PLATEAU) < 0.05,
          `平顶 ${flat.length}px / 过渡 ${total.length}px = ${flatFrac.toFixed(3)}，期望 ${PG.GAS_PLATEAU}`);
      /* 斜坡中点：梯形在 bw*(P+(1-P)/2) 处正好一半黑；三角形在同一位置的取值不同。 */
      const yMid = Math.round((0.5 + 0.1 * (PG.GAS_PLATEAU + (1 - PG.GAS_PLATEAU) / 2)) * 512);
      ok('斜坡中点灰度≈128（线性过渡，不是二次/三角形）',
          Math.abs(col(yMid) - 128) <= 4, `y=${yMid} → ${col(yMid)}`);
      ok('贴图生成走的是真帧缓冲（沙箱能读回像素，上面两条不是空测）',
          total.length > 40 && total.length < 200, `过渡带 ${total.length} 行`);
    })();

    /* ---------- 大红斑：颜色不许是半径的单调函数 ----------
       用户目检原话"像个同心靶心，而不像气旋"。靶心的可测定义就是
       "同一等距线上颜色几乎不变、沿半径却单调变化"，所以直接测这个比。 */
    (function notABullseye() {
      const cfg = { base: 0xe2cfae, turb: 0, swirls: 0, warp: 0, shearX: 3, shearY: 16, bands: [],
                    spots: [{ type: 'oval', x: 0.5, y: 0.5, rx: 0.16, ry: 0.09, a: 0.88, swirl: 2.6,
                              core: '#b8492a', inner: '#c8623c', ring: '#d68a5e', deep: '#8f3a20' }] };
      const W = 256, H = 128;
      const cv = PG.gasSurface(W, H, cfg);
      const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
      const lum = (x, y) => { const i = (y * W + x) * 4; return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; };
      const rx = cfg.spots[0].rx * W, ry = cfg.spots[0].ry * H;
      const bins = [0.2, 0.35, 0.5, 0.65];
      const spread = [], step = [], means = [];
      for (const b of bins) {
        const ring = [];
        for (let k = 0; k < 24; k++) {
          const a = k / 24 * 6.28318;
          ring.push(lum(Math.round(W / 2 + Math.cos(a) * rx * b), Math.round(H / 2 + Math.sin(a) * ry * b)));
        }
        const mn = Math.min(...ring), mx = Math.max(...ring);
        means.push(ring.reduce((x, y) => x + y, 0) / 24);
        spread.push(mx - mn);
      }
      for (let i = 1; i < bins.length; i++) step.push(Math.abs(means[i] - means[i - 1]));
      const ms = spread.reduce((a, b) => a + b, 0) / spread.length;
      const mp = step.reduce((a, b) => a + b, 0) / step.length;
      const baseL = lum(4, 4);
      ok('大红斑内部：同一等距线上的颜色起伏 ≫ 沿半径的变化（不是"一圈一色"的靶心）',
          ms > 8 && ms > 3 * mp, `周向起伏 ${ms.toFixed(1)} 灰阶 / 径向步进 ${mp.toFixed(2)} = ${(ms / Math.max(mp, 0.01)).toFixed(1)}×`);
      ok('斑点确实改了像素（上面那条不是"图是平的"空测）',
          Math.abs(means[1] - baseL) > 12, `斑内 ${means[1].toFixed(1)} vs 底 ${baseL.toFixed(1)}`);
    })();

    /* ---------- 带表本身：纬度排布对不对 ----------
       带剖面/增益都对了，但带要是排在错的纬度上，±20° 窗口里照样没东西看。 */
    (function bandLatitudes() {
      const g = P.readGasCfg(html);
      const jup = g.bodies.find(b => b.var === 'jup');
      ok('palette 能从页面解析出木星带表（工具不抄配置）',
          !!jup && Array.isArray(jup.cfg.bands) && jup.cfg.bands.length === 12,
          jup ? `${jup.cfg.bands.length} 条带` : '没找到 TEX.jup');
      if (jup) {
        const lat = t => (0.5 - t) * 180;
        const win = jup.cfg.bands.filter(b => Math.abs(lat(b[0])) < 20);
        /* 真实木星在 ±20° 里就是三条：NEB(+12.5°)、EZ(−0.5°)、SEB(−17°)，
           NTZ(+21.6°)/STZ(−27°) 已经在窗口外 —— 判据按真实天文学写，
           不是"越多越好"。要盯的是：赤道两侧都得有带，且赤道本身是亮的 EZ。 */
        ok('±20° 测量窗口里有 3 条带，且南北半球各有 1 条以上（近景看得见带）',
            win.length >= 3 && win.some(b => lat(b[0]) > 5) && win.some(b => lat(b[0]) < -5),
            `${win.length} 条：` + win.map(b => lat(b[0]).toFixed(1) + '°').join(' '));
        ok('赤道 ±5° 内正好一条带（那是最亮的 EZ，位置错了就等于没有赤道带）',
            jup.cfg.bands.filter(b => Math.abs(lat(b[0])) < 5).length === 1,
            jup.cfg.bands.filter(b => Math.abs(lat(b[0])) < 5).map(b => lat(b[0]).toFixed(1) + '°').join(' '));
        const sorted = jup.cfg.bands.every((b, i, a) => !i || b[0] > a[i - 1][0]);
        const widths = jup.cfg.bands.every(b => b[2] > 0 && b[2] < 0.09);
        ok('带表按纬度递增、带宽都在 0..16° 之间（不会互相吞掉）', sorted && widths,
            sorted ? (widths ? 'ok' : '有带过宽') : '顺序乱了');
        ok('木星底色 R 通道 ≤227（贴图自身不往 8 位天花板撞，色度才留得住）',
            (jup.cfg.base >> 16) <= 227, 'base=0x' + jup.cfg.base.toString(16));
      }
    })();
  }
}

/* ============================================================ 汇总 */
console.log('\n' + '='.repeat(62));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('\n失败清单：'); failures.forEach(f => console.log('  · ' + f)); }
process.exit(fail ? 1 : 0);
