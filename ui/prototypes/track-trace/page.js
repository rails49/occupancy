/* PROTOTYPE, throwaway. The page around trace.js: drawing, pointer and keys. */
(function () {
  'use strict';
  const T = TrackTrace;

  const COLOR = {
    free: '#ff9f1c',
    straight: '#2ec4b6',
    radius: '#c77dff',
    join: '#bbbbbb',
    changed: 'rgba(255, 230, 0, 0.45)',
    truth: '#8a8a8a',
    old: 'rgba(200, 200, 200, 0.7)',
    flag: '#ff4d4f',
    select: '#4cc9f0',
    projection: 'rgba(255, 255, 255, 0.75)',
  };

  const state = {
    clicks: [],
    marks: [],
    rule: 'akima',
    gauge: 12,
    tolerance: 0.1,
    newMark: 'free',
    activeEnd: 'end',
    show: { rails: true, joints: false, projection: true, numbers: true, old: false },
    image: null,
    truth: null,
    selection: null,
    lastEdit: null,
  };
  const history = { undo: [], redo: [] };
  const view = { scale: 1, ox: 0, oy: 0 };

  let result = T.build({ clicks: [], marks: [], rule: 'akima' });
  let samples = [];
  let clickS = [];
  let oldSamples = [];
  let truthSamples = [];
  let reverseDiff = 0;
  let truthDev = null;
  let hover = { click: -1, gap: -1, onLine: false };
  let drag = null;
  let spaceDown = false;
  let measureLine = null;
  let measuring = false;
  let editBefore = null;

  const $ = id => document.getElementById(id);
  const canvas = $('view');
  const ctx = canvas.getContext('2d');
  const strip = $('curvature');
  const sctx = strip.getContext('2d');

  /* ---------- derived state ---------- */

  const step = () => Math.max(0.5, state.gauge / 8);
  const G = x => x / state.gauge;
  const input = () => ({ clicks: state.clicks, marks: state.marks, rule: state.rule, minRadius: 15 * state.gauge });

  function rebuild() {
    result = T.build(input());
    samples = T.sample(result.parts, step());
    clickS = state.clicks.map(p => (samples.length > 1 ? T.nearest(samples, p).s : 0));
    oldSamples = state.show.old && state.rule !== 'onearc' && state.clicks.length > 1
      ? T.sample(T.build({ ...input(), rule: 'onearc' }).parts, step())
      : [];
  }

  /** Slower measures, after an edit ends rather than on every pointer move. */
  function measure() {
    if (state.clicks.length > 1) {
      const rev = T.build({
        clicks: [...state.clicks].reverse(),
        marks: [...state.marks].reverse(),
        rule: state.rule,
        minRadius: 15 * state.gauge,
      });
      reverseDiff = T.farthest(samples, T.sample(rev.parts, step()));
    } else reverseDiff = 0;
    truthDev = state.truth && samples.length > 1 ? T.farthest(samples, truthSamples) : null;
  }

  function gapAtS(s) {
    let g = 0;
    for (let i = 0; i < clickS.length; i++) if (clickS[i] <= s) g = i;
    return Math.min(Math.max(0, g), state.clicks.length - 2);
  }

  /* ---------- edits ---------- */

  const snapshot = () => ({ clicks: state.clicks.map(p => ({ ...p })), marks: [...state.marks] });

  function beginEdit() {
    history.undo.push(snapshot());
    history.redo = [];
    editBefore = samples;
  }

  function endEdit(label) {
    rebuild();
    const before = editBefore || [];
    const tol = 0.01 * state.gauge;
    const changed = new Set();
    if (before.length > 1) {
      result.parts.forEach((part, i) => {
        if (T.farthest(T.sample([part], step()), before, tol) > tol) changed.add(i);
      });
    } else result.parts.forEach((_, i) => changed.add(i));
    const gaps = [];
    changed.forEach(i => {
      const part = result.parts[i];
      if (part.gap !== undefined) gaps.push(part.gap);
      else {
        const run = result.runs[part.run];
        for (let g = run.a; g < run.b; g++) gaps.push(g);
      }
    });
    state.lastEdit = { label, changed, gaps };
    editBefore = null;
    measure();
    render();
  }

  function cancelEdit() {
    history.undo.pop();
    editBefore = null;
  }

  function restore(s) {
    state.clicks = s.clicks;
    state.marks = s.marks;
    state.selection = null;
    state.lastEdit = null;
    rebuild();
    measure();
    render();
  }

  function undo() {
    if (!history.undo.length) return;
    history.redo.push(snapshot());
    restore(history.undo.pop());
  }

  function redo() {
    if (!history.redo.length) return;
    history.undo.push(snapshot());
    restore(history.redo.pop());
  }

  function addClick(p) {
    if (state.activeEnd === 'end') {
      state.clicks.push(p);
      if (state.clicks.length > 1) state.marks.push(state.newMark);
      return state.clicks.length - 1;
    }
    state.clicks.unshift(p);
    if (state.clicks.length > 1) state.marks.unshift(state.newMark);
    return 0;
  }

  function insertClick(g, p) {
    state.clicks.splice(g + 1, 0, p);
    state.marks.splice(g, 0, state.marks[g]);
    return g + 1;
  }

  function deleteClicks(a, b) {
    for (let i = b; i >= a; i--) {
      const n = state.clicks.length;
      state.clicks.splice(i, 1);
      if (n === 1) continue;
      if (i === 0) state.marks.shift();
      else if (i === n - 1) state.marks.pop();
      else state.marks.splice(i - 1, 2, state.marks[i - 1] === state.marks[i] ? state.marks[i - 1] : 'free');
    }
  }

  function setMarks(g0, g1, mark) {
    for (let g = g0; g <= g1; g++) if (g >= 0 && g < state.marks.length) state.marks[g] = mark;
  }

  /* ---------- view ---------- */

  const toWorld = (sx, sy) => ({ x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale });
  const toScreen = p => ({ x: p.x * view.scale + view.ox, y: p.y * view.scale + view.oy });

  function bounds() {
    if (state.image) return { x0: 0, y0: 0, x1: state.image.width, y1: state.image.height };
    const pts = [...state.clicks, ...truthSamples];
    if (!pts.length) return { x0: 0, y0: 0, x1: 1200, y1: 800 };
    const m = 5 * state.gauge;
    return {
      x0: Math.min(...pts.map(p => p.x)) - m,
      y0: Math.min(...pts.map(p => p.y)) - m,
      x1: Math.max(...pts.map(p => p.x)) + m,
      y1: Math.max(...pts.map(p => p.y)) + m,
    };
  }

  function fitView() {
    const b = bounds();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    view.scale = Math.min(w / (b.x1 - b.x0), h / (b.y1 - b.y0));
    view.ox = (w - (b.x1 - b.x0) * view.scale) / 2 - b.x0 * view.scale;
    view.oy = (h - (b.y1 - b.y0) * view.scale) / 2 - b.y0 * view.scale;
    render();
  }

  function zoomAt(sx, sy, factor) {
    const p = toWorld(sx, sy);
    view.scale = Math.min(200, Math.max(0.02, view.scale * factor));
    view.ox = sx - p.x * view.scale;
    view.oy = sy - p.y * view.scale;
    render();
  }

  /* ---------- drawing ---------- */

  function sizeCanvas(c, cx) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function polyline(pts, offset) {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const q = offset
        ? { x: p.x - offset * Math.sin(p.heading), y: p.y + offset * Math.cos(p.heading) }
        : p;
      const s = toScreen(q);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
  }

  function partColor(part) {
    return COLOR[part.kind] || COLOR.free;
  }

  let pending = false;
  function render() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      draw();
      drawStrip();
      renderState();
    });
  }

  function draw() {
    const { w, h } = sizeCanvas(canvas, ctx);
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, w, h);
    if (state.image) {
      ctx.imageSmoothingEnabled = view.scale < 2;
      ctx.drawImage(state.image, view.ox, view.oy, state.image.width * view.scale, state.image.height * view.scale);
    } else {
      const b = bounds();
      const a = toScreen({ x: b.x0, y: b.y0 });
      const c = toScreen({ x: b.x1, y: b.y1 });
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
    }
    const half = state.gauge / 2;

    if (truthSamples.length) {
      ctx.strokeStyle = COLOR.truth;
      ctx.lineWidth = Math.max(1.5, 0.15 * state.gauge * view.scale);
      ctx.setLineDash([]);
      polyline(truthSamples, half);
      polyline(truthSamples, -half);
    }

    if (oldSamples.length) {
      ctx.strokeStyle = COLOR.old;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      polyline(oldSamples, 0);
      ctx.setLineDash([]);
    }

    const byPart = [];
    samples.forEach(p => (byPart[p.part] = byPart[p.part] || []).push(p));

    if (state.lastEdit) {
      ctx.strokeStyle = COLOR.changed;
      ctx.lineWidth = Math.max(10, state.gauge * view.scale * 1.2);
      ctx.lineCap = 'round';
      state.lastEdit.changed.forEach(i => byPart[i] && polyline(byPart[i], 0));
      ctx.lineCap = 'butt';
    }

    result.parts.forEach((part, i) => {
      const pts = byPart[i];
      if (!pts) return;
      ctx.strokeStyle = partColor(part);
      ctx.lineWidth = 2;
      polyline(pts, 0);
      if (state.show.rails) {
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.7;
        polyline(pts, half);
        polyline(pts, -half);
        ctx.globalAlpha = 1;
      }
    });

    if (state.show.joints) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      result.parts.forEach(part => {
        const s = toScreen(part.start);
        const n = { x: -Math.sin(part.start.heading), y: Math.cos(part.start.heading) };
        const l = Math.max(6, half * view.scale);
        ctx.beginPath();
        ctx.moveTo(s.x - n.x * l, s.y - n.y * l);
        ctx.lineTo(s.x + n.x * l, s.y + n.y * l);
        ctx.stroke();
      });
    }

    if (state.show.projection && samples.length > 1) {
      const end = state.activeEnd === 'end' ? samples[samples.length - 1] : samples[0];
      const hd = end.heading + (state.activeEnd === 'end' ? 0 : Math.PI);
      const far = { x: end.x + 1e5 * Math.cos(hd), y: end.y + 1e5 * Math.sin(hd) };
      const a = toScreen(end);
      const b = toScreen(far);
      ctx.strokeStyle = COLOR.projection;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (hover.gap >= 0 && hover.click < 0 && !drag) {
      const pts = samples.filter(p => gapAtS(p.s) === hover.gap);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 6;
      if (pts.length > 1) polyline(pts, 0);
    }

    // Clicks.
    const runOf = new Array(state.clicks.length).fill(null);
    result.runs.forEach(run => {
      run.residuals.forEach((r, k) => (runOf[run.first + k] = { run, r }));
    });
    const sel = state.selection;
    state.clicks.forEach((p, i) => {
      const s = toScreen(p);
      const info = runOf[i];
      const flagged = info && Math.abs(info.r) > state.tolerance * state.gauge;
      const isEnd = (state.activeEnd === 'end' && i === state.clicks.length - 1) || (state.activeEnd === 'start' && i === 0);
      ctx.beginPath();
      ctx.arc(s.x, s.y, i === hover.click ? 6 : 4.5, 0, 2 * Math.PI);
      ctx.fillStyle = info ? COLOR[info.run.kind] : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#000000';
      ctx.stroke();
      if (flagged || (sel && i >= sel.a && i <= sel.b) || isEnd) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 8, 0, 2 * Math.PI);
        ctx.lineWidth = 2;
        ctx.strokeStyle = flagged ? COLOR.flag : sel && i >= sel.a && i <= sel.b ? COLOR.select : '#ffffff';
        ctx.stroke();
      }
      if (state.show.numbers) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 3;
        ctx.strokeText(String(i + 1), s.x + 8, s.y - 8);
        ctx.fillText(String(i + 1), s.x + 8, s.y - 8);
      }
    });

    if (measureLine) {
      const a = toScreen(measureLine[0]);
      const b = toScreen(measureLine[1]);
      ctx.strokeStyle = COLOR.select;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  function drawStrip() {
    const { w, h } = sizeCanvas(strip, sctx);
    sctx.fillStyle = '#181818';
    sctx.fillRect(0, 0, w, h);
    sctx.font = '10px system-ui, sans-serif';
    sctx.fillStyle = '#9a9a9a';
    sctx.fillText('Curvature along the line (1/radius). Ticks: clicks.', 6, 12);
    if (samples.length < 2) return;
    const total = samples[samples.length - 1].s || 1;
    let kmax = 1 / 40;
    samples.forEach(p => (kmax = Math.max(kmax, Math.abs(p.curvature * state.gauge))));
    kmax *= 1.15;
    const pad = 36;
    const x = s => pad + ((w - pad - 8) * s) / total;
    const y = k => h / 2 - ((h / 2 - 16) * k * state.gauge) / kmax;
    sctx.strokeStyle = '#3a3a3a';
    sctx.lineWidth = 1;
    sctx.beginPath();
    sctx.moveTo(pad, h / 2);
    sctx.lineTo(w - 8, h / 2);
    sctx.stroke();
    const used = [h / 2];
    [15, 30, 60, 120, 240].forEach(R => {
      if (1 / R > kmax) return;
      [1, -1].forEach(sg => {
        const yy = y((sg / R) / state.gauge);
        if (used.some(u => Math.abs(u - yy) < 12)) return;
        used.push(yy);
        sctx.strokeStyle = '#2c2c2c';
        sctx.beginPath();
        sctx.moveTo(pad, yy);
        sctx.lineTo(w - 8, yy);
        sctx.stroke();
        sctx.fillStyle = '#8a8a8a';
        sctx.fillText(`R ${R}`, 2, yy + 3);
      });
    });
    if (truthSamples.length > 1) {
      const tt = truthSamples[truthSamples.length - 1].s;
      sctx.strokeStyle = COLOR.truth;
      sctx.setLineDash([4, 3]);
      sctx.beginPath();
      truthSamples.forEach((p, i) => {
        const xx = x((p.s * total) / tt);
        const yy = y(p.curvature);
        if (i === 0) sctx.moveTo(xx, yy);
        else sctx.lineTo(xx, yy);
      });
      sctx.stroke();
      sctx.setLineDash([]);
    }
    sctx.lineWidth = 2;
    let from = 0;
    for (let i = 1; i <= samples.length; i++) {
      if (i < samples.length && samples[i].part === samples[from].part) continue;
      sctx.strokeStyle = partColor(result.parts[samples[from].part]);
      sctx.beginPath();
      sctx.moveTo(x(samples[Math.max(0, from - 1)].s), y(samples[Math.max(0, from - 1)].curvature));
      for (let k = from; k < i; k++) sctx.lineTo(x(samples[k].s), y(samples[k].curvature));
      sctx.stroke();
      from = i;
    }
    sctx.strokeStyle = '#ffffff';
    sctx.lineWidth = 1;
    clickS.forEach(s => {
      sctx.beginPath();
      sctx.moveTo(x(s), h - 8);
      sctx.lineTo(x(s), h - 2);
      sctx.stroke();
    });
  }

  /* ---------- state panel ---------- */

  const fmtG = px => `${G(px).toFixed(3)} G`;
  const clickRange = (a, b) => (a === b ? `click ${a + 1}` : `clicks ${a + 1}–${b + 1}`);

  function renderState() {
    const rows = [];
    const add = (k, v, cls) => rows.push(`<dt>${k}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`);
    const n = state.clicks.length;
    add('Clicks', n ? `${n}${state.selection ? `, selected ${clickRange(state.selection.a, state.selection.b)}` : ''}` : 'none yet');
    add('Adding at', state.activeEnd === 'end' ? 'the end' : 'the start');
    add('Rule', $('rule').selectedOptions[0].textContent);
    const tol = state.tolerance * state.gauge;
    if (state.rule === 'onearc') add('Runs', 'marks are ignored by the old rule');
    else if (!result.runs.length) add('Runs', 'none: every gap is free');
    result.runs.forEach((run, i) => {
      const what = run.kind === 'straight' ? 'Straight' : `One radius, ${G(run.radius).toFixed(1)} G`;
      const touch = run.touches ? `, touches ${run.touches}` : '';
      add(`Run ${i + 1}`, `${what}, ${clickRange(run.a, run.b)}${touch}. Farthest click ${fmtG(run.worst)}${run.worst > tol ? ', over the tolerance' : ''}`, run.worst > tol ? 'warn' : '');
    });
    if (n > 1) add('Free clicks', 'on the line (0 G)');
    if (state.lastEdit) {
      const g = state.lastEdit.gaps;
      const reach = g.length
        ? `the line changed between clicks ${Math.min(...g) + 1} and ${Math.max(...g) + 2}`
        : 'the line did not change';
      add('Last edit', `${state.lastEdit.label}: ${reach}`, 'changed');
    }
    if (n > 1) {
      add('Reverse order', reverseDiff < 0.001 * state.gauge
        ? 'gives the same line'
        : `gives a line up to ${fmtG(reverseDiff)} away`, reverseDiff < 0.001 * state.gauge ? '' : 'warn');
    }
    if (truthDev !== null) add('True track', `the line is at most ${fmtG(truthDev)} from it`);
    if (hover.gap >= 0 && n > 1) add('Under pointer', `gap ${hover.gap + 1} (${clickRange(hover.gap, hover.gap + 1)}), ${state.marks[hover.gap]}`);
    result.warnings.forEach(wn => add('Note', wn, 'warn'));
    $('state').innerHTML = rows.join('');
  }

  /* ---------- pointer ---------- */

  function hitClick(sx, sy) {
    let best = -1;
    let bd = 9;
    state.clicks.forEach((p, i) => {
      const s = toScreen(p);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  function hitLine(p) {
    if (samples.length < 2) return null;
    const nr = T.nearest(samples, p);
    return nr.d * view.scale < 7 ? nr : null;
  }

  function updateHover(sx, sy) {
    const p = toWorld(sx, sy);
    const c = hitClick(sx, sy);
    const nr = c < 0 ? hitLine(p) : null;
    const gap = nr && state.clicks.length > 1 ? gapAtS(nr.s) : -1;
    hover = { click: c, gap, onLine: !!nr };
    canvas.classList.toggle('over-click', c >= 0);
    canvas.classList.toggle('over-line', c < 0 && !!nr);
  }

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    const sx = e.offsetX;
    const sy = e.offsetY;
    const p = toWorld(sx, sy);
    if (measuring) {
      measureLine = [p, p];
      drag = { kind: 'measure' };
      return;
    }
    if (e.button === 2 || e.button === 1 || spaceDown) {
      drag = { kind: 'pan', sx, sy, ox: view.ox, oy: view.oy };
      canvas.classList.add('panning');
      return;
    }
    const c = hitClick(sx, sy);
    if (c >= 0) {
      beginEdit();
      drag = { kind: 'click', i: c, sx, sy, moved: false, fresh: false, shift: e.shiftKey };
      return;
    }
    const nr = hitLine(p);
    beginEdit();
    if (nr && state.clicks.length > 1) {
      const i = insertClick(gapAtS(nr.s), p);
      drag = { kind: 'click', i, sx, sy, moved: true, fresh: true, label: `inserted click ${i + 1}` };
    } else {
      const i = addClick(p);
      drag = { kind: 'click', i, sx, sy, moved: true, fresh: true, label: `added click ${i + 1} at the ${state.activeEnd}` };
    }
    state.selection = null;
    rebuild();
    render();
  });

  canvas.addEventListener('pointermove', e => {
    const sx = e.offsetX;
    const sy = e.offsetY;
    if (!drag) {
      const was = hover;
      updateHover(sx, sy);
      if (was.click !== hover.click || was.gap !== hover.gap) render();
      return;
    }
    if (drag.kind === 'measure') {
      measureLine[1] = toWorld(sx, sy);
      render();
      return;
    }
    if (drag.kind === 'pan') {
      view.ox = drag.ox + sx - drag.sx;
      view.oy = drag.oy + sy - drag.sy;
      render();
      return;
    }
    if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
    drag.moved = true;
    state.clicks[drag.i] = toWorld(sx, sy);
    state.lastEdit = null;
    rebuild();
    render();
  });

  canvas.addEventListener('pointerup', e => {
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.classList.remove('panning');
    if (d.kind === 'measure') {
      const len = T.dist(measureLine[0], measureLine[1]);
      if (len > 1) setGauge(len);
      measureLine = null;
      measuring = false;
      $('measure').classList.remove('on');
      render();
      return;
    }
    if (d.kind !== 'click') return;
    if (!d.moved) {
      cancelEdit();
      const i = d.i;
      if (d.shift && state.selection) {
        state.selection = { a: Math.min(state.selection.a, i), b: Math.max(state.selection.b, i) };
      } else state.selection = { a: i, b: i };
      if (i === 0 && state.clicks.length > 1) setActiveEnd('start');
      else if (i === state.clicks.length - 1) setActiveEnd('end');
      updateHover(e.offsetX, e.offsetY);
      render();
      return;
    }
    endEdit(d.label || `moved click ${d.i + 1}`);
  });

  canvas.addEventListener(
    'wheel',
    e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.01));
      else {
        view.ox -= e.deltaX;
        view.oy -= e.deltaY;
        render();
      }
    },
    { passive: false }
  );

  /* ---------- keys ---------- */

  const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

  window.addEventListener('keydown', e => {
    if (typing()) return;
    if (e.key === ' ') {
      spaceDown = true;
      e.preventDefault();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === '1' || k === '2' || k === '3') setNewMark(['free', 'straight', 'radius'][Number(k) - 1]);
    else if (k === 'e') setActiveEnd(state.activeEnd === 'end' ? 'start' : 'end');
    else if (k === '+' || k === '=') zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.25);
    else if (k === '-') zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 0.8);
    else if (k === 'escape') {
      state.selection = null;
      render();
    } else if (k === 's' || k === 'r' || k === 'f') {
      const mark = { s: 'straight', r: 'radius', f: 'free' }[k];
      let g0;
      let g1;
      if (state.selection && state.selection.b > state.selection.a) {
        g0 = state.selection.a;
        g1 = state.selection.b - 1;
      } else if (hover.gap >= 0) {
        g0 = g1 = hover.gap;
      } else return;
      beginEdit();
      setMarks(g0, g1, mark);
      endEdit(`marked ${clickRange(g0, g1 + 1)} ${mark === 'radius' ? 'one radius' : mark}`);
    } else if (k === 'delete' || k === 'backspace') {
      let a;
      let b;
      if (state.selection) ({ a, b } = state.selection);
      else if (hover.click >= 0) a = b = hover.click;
      else return;
      e.preventDefault();
      beginEdit();
      deleteClicks(a, b);
      state.selection = null;
      hover = { click: -1, gap: -1, onLine: false };
      endEdit(`removed ${clickRange(a, b)}`);
    }
  });

  window.addEventListener('keyup', e => {
    if (e.key === ' ') spaceDown = false;
  });

  /* ---------- controls ---------- */

  function setGauge(px) {
    state.gauge = Math.round(px * 10) / 10;
    $('gauge').value = state.gauge;
    rebuild();
    measure();
    render();
  }

  function setNewMark(m) {
    state.newMark = m;
    document.querySelectorAll('input[name="newMark"]').forEach(r => (r.checked = r.value === m));
  }

  function setActiveEnd(end) {
    state.activeEnd = end;
    document.querySelectorAll('input[name="activeEnd"]').forEach(r => (r.checked = r.value === end));
    render();
  }

  function setRule(rule) {
    state.rule = rule;
    $('rule').value = rule;
    state.lastEdit = null;
    rebuild();
    measure();
    render();
  }

  function initControls() {
    $('gauge').value = state.gauge;
    $('tolerance').value = state.tolerance;
    $('rule').value = state.rule;
    setNewMark(state.newMark);
    setActiveEnd(state.activeEnd);
    $('showRails').checked = state.show.rails;
    $('showJoints').checked = state.show.joints;
    $('showProjection').checked = state.show.projection;
    $('showNumbers').checked = state.show.numbers;
    $('showOld').checked = state.show.old;

    $('gauge').addEventListener('change', e => setGauge(Number(e.target.value) || state.gauge));
    $('tolerance').addEventListener('change', e => {
      state.tolerance = Number(e.target.value) || state.tolerance;
      render();
    });
    $('rule').addEventListener('change', e => setRule(e.target.value));
    document.querySelectorAll('input[name="newMark"]').forEach(r => r.addEventListener('change', () => setNewMark(r.value)));
    document.querySelectorAll('input[name="activeEnd"]').forEach(r => r.addEventListener('change', () => setActiveEnd(r.value)));
    [['showRails', 'rails'], ['showJoints', 'joints'], ['showProjection', 'projection'], ['showNumbers', 'numbers'], ['showOld', 'old']].forEach(([id, key]) =>
      $(id).addEventListener('change', e => {
        state.show[key] = e.target.checked;
        rebuild();
        render();
      })
    );
    $('measure').addEventListener('click', () => {
      measuring = !measuring;
      $('measure').classList.toggle('on', measuring);
    });
    $('fit').addEventListener('click', fitView);
    $('reverse').addEventListener('click', reverseOrder);
    $('undo').addEventListener('click', undo);
    $('redo').addEventListener('click', redo);
    $('clear').addEventListener('click', () => {
      beginEdit();
      state.clicks = [];
      state.marks = [];
      state.selection = null;
      endEdit('cleared');
    });
    $('photo').addEventListener('change', e => e.target.files[0] && loadPhoto(e.target.files[0]));
    canvas.addEventListener('dragover', e => e.preventDefault());
    canvas.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) loadPhoto(f);
    });
    $('jsonOut').addEventListener('click', () => {
      $('json').value = JSON.stringify({
        gauge: state.gauge,
        clicks: state.clicks.map(p => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]),
        marks: state.marks,
      });
    });
    $('jsonIn').addEventListener('click', () => {
      const d = JSON.parse($('json').value);
      beginEdit();
      if (d.gauge) setGauge(d.gauge);
      state.clicks = d.clicks.map(([x, y]) => ({ x, y }));
      state.marks = d.marks || state.clicks.slice(1).map(() => 'free');
      endEdit('loaded clicks');
      fitView();
    });
    window.addEventListener('resize', render);
  }

  function reverseOrder() {
    beginEdit();
    state.clicks.reverse();
    state.marks.reverse();
    state.selection = null;
    endEdit('reversed the click order');
  }

  function loadPhoto(file) {
    const img = new Image();
    img.onload = () => {
      state.image = img;
      state.truth = null;
      truthSamples = [];
      rebuild();
      measure();
      fitView();
    };
    img.src = URL.createObjectURL(file);
  }

  /* ---------- walkthroughs ---------- */

  /** A true track from (length G, curvature 1/G) pieces, and clicks along it. */
  function makeTruth(pieces, gauge) {
    let p = { x: 0, y: 0, heading: 0 };
    const parts = pieces.map(([len, k]) => {
      const part = { start: p, length: len * gauge, curvature: k / gauge, kind: k ? 'radius' : 'straight' };
      p = T.advance(p, len * gauge, k / gauge);
      return part;
    });
    return parts;
  }

  function clicksOn(parts, at, noise, gauge, seed) {
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
    const ends = [];
    let acc = 0;
    parts.forEach(pt => ends.push((acc += pt.length)));
    return at.map(sG => {
      const s0 = sG * gauge;
      let i = ends.findIndex(e => s0 <= e + 1e-6);
      if (i < 0) i = parts.length - 1;
      const from = i ? ends[i - 1] : 0;
      const q = T.advance(parts[i].start, s0 - from, parts[i].curvature);
      const on = [i];
      if (Math.abs(s0 - ends[i]) < 1e-6 && i + 1 < parts.length) on.push(i + 1);
      if (Math.abs(s0 - from) < 1e-6 && i > 0) on.push(i - 1);
      return { p: { x: q.x + noise * gauge * gauss(), y: q.y + noise * gauge * gauss() }, on };
    });
  }

  let scenarioClicks = [];

  function loadScenario(sc) {
    const gauge = 12;
    state.gauge = gauge;
    $('gauge').value = gauge;
    state.image = null;
    state.truth = makeTruth(sc.track, gauge);
    truthSamples = T.sample(state.truth, Math.max(0.5, gauge / 8));
    scenarioClicks = clicksOn(state.truth, sc.at, sc.noise, gauge, sc.seed || 7);
    history.undo = [];
    history.redo = [];
    state.clicks = scenarioClicks.map(c => ({ ...c.p }));
    state.marks = state.clicks.slice(1).map(() => 'free');
    state.selection = null;
    state.lastEdit = null;
    state.activeEnd = 'end';
    setActiveEnd('end');
    rebuild();
    measure();
    fitView();
  }

  /** Mark every gap whose two clicks lie on true piece `k`. */
  function markPiece(k, mark) {
    beginEdit();
    scenarioClicks.forEach((c, i) => {
      if (i + 1 < scenarioClicks.length && c.on.includes(k) && scenarioClicks[i + 1].on.includes(k)) state.marks[i] = mark;
    });
    const gs = state.marks.map((m, g) => (m === mark ? g : -1)).filter(g => g >= 0);
    endEdit(`marked true piece ${k + 1} ${mark === 'radius' ? 'one radius' : mark}${gs.length ? '' : ' (no gaps)'}`);
  }

  function moveSideways(i, byG) {
    beginEdit();
    const P = state.clicks;
    const a = P[Math.max(0, i - 1)];
    const b = P[Math.min(P.length - 1, i + 1)];
    const h = Math.atan2(b.y - a.y, b.x - a.x);
    P[i] = { x: P[i].x - byG * state.gauge * Math.sin(h), y: P[i].y + byG * state.gauge * Math.cos(h) };
    endEdit(`moved click ${i + 1} sideways by ${byG} G`);
  }

  function pointOnTruth(sG) {
    return clicksOn(state.truth, [sG], 0, state.gauge, 1)[0].p;
  }

  const SCENARIOS = [
    {
      title: 'Moving a click',
      text:
        'Sixteen clicks on a track that bends left, then right, then runs straight. Move one click under the old rule, then under the new rule, and compare how far the yellow band reaches.',
      track: [[20, 1 / 25], [25, -1 / 40], [20, 1 / 60], [15, 0]],
      at: Array.from({ length: 16 }, (_, i) => i * 5),
      noise: 0,
      steps: [
        { label: 'Load the clicks under the old rule (one arc per gap)', run: sc => (loadScenario(sc), setRule('onearc')) },
        { label: 'Move click 6 sideways by 0.5 G', run: () => moveSideways(5, 0.5) },
        { label: 'Undo, and switch to the new rule', run: () => (undo(), setRule('akima')) },
        { label: 'Move click 6 sideways by 0.5 G again', run: () => moveSideways(5, 0.5) },
      ],
    },
    {
      title: 'Curve into a straight',
      text:
        'A straight, a quarter circle of radius 30 G, and a straight. Clicks every 5 G, each off by about 0.04 G. With every gap free the straights wobble: zoom in, and watch the curvature strip. Then mark the straights, and the curve as one radius.',
      track: [[25, 0], [(Math.PI / 2) * 30, 1 / 30], [30, 0]],
      at: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, ...[0, 5, 10, 15, 20, 25, 30].map(x => 25 + 15 * Math.PI + x)],
      noise: 0.04,
      seed: 11,
      steps: [
        { label: 'Load the clicks, every gap free', run: sc => (loadScenario(sc), setRule('akima')) },
        { label: 'Mark the first straight', run: () => markPiece(0, 'straight') },
        { label: 'Mark the last straight', run: () => markPiece(2, 'straight') },
        { label: 'Mark the curve one radius', run: () => markPiece(1, 'radius') },
        { label: 'Reverse the click order', run: () => reverseOrder() },
      ],
    },
    {
      title: 'Broad curve',
      text:
        'A straight, a 50° curve of radius 80 G, and a straight, clicked every 3 G, each click off by about 0.04 G. Free gaps follow every click, so the radius swings from gap to gap: see the strip. One radius fits a single circle within the tolerance.',
      track: [[15, 0], [(50 / 180) * Math.PI * 80, 1 / 80], [15, 0]],
      at: Array.from({ length: 34 }, (_, i) => i * 3),
      noise: 0.04,
      seed: 5,
      steps: [
        { label: 'Load the clicks, every gap free', run: sc => (loadScenario(sc), setRule('akima')) },
        { label: 'Mark the curve one radius', run: () => markPiece(1, 'radius') },
        { label: 'Mark the first straight', run: () => markPiece(0, 'straight') },
        { label: 'Mark the last straight', run: () => markPiece(2, 'straight') },
      ],
    },
    {
      title: 'Extend and insert',
      text:
        'An S-curve traced in the middle only. Add a click at each end, insert one on the line, and reverse the order. Each edit should change the line only near it.',
      track: [[10, 0], [30, 1 / 35], [30, -1 / 35], [10, 0]],
      at: [12, 17, 22, 27, 32, 37, 42, 47, 52, 57, 62, 67],
      noise: 0,
      steps: [
        { label: 'Load the clicks', run: sc => (loadScenario(sc), setRule('akima')) },
        {
          label: 'Add a click at the start',
          run: () => {
            beginEdit();
            setActiveEnd('start');
            const i = addClick(pointOnTruth(7));
            endEdit(`added click ${i + 1} at the start`);
          },
        },
        {
          label: 'Add a click at the end',
          run: () => {
            beginEdit();
            setActiveEnd('end');
            const i = addClick(pointOnTruth(72));
            endEdit(`added click ${i + 1} at the end`);
          },
        },
        {
          label: 'Insert a click on the line between clicks 6 and 7',
          run: () => {
            beginEdit();
            const s = (clickS[5] + clickS[6]) / 2;
            const q = samples.reduce((b, p) => (Math.abs(p.s - s) < Math.abs(b.s - s) ? p : b));
            insertClick(5, { x: q.x, y: q.y });
            endEdit('inserted click 7 on the line');
          },
        },
        { label: 'Reverse the click order', run: () => reverseOrder() },
      ],
    },
  ];

  let activeScenario = 0;
  let nextStep = 0;

  function renderWalkthroughs() {
    const sc = SCENARIOS[activeScenario];
    $('tabs').innerHTML = '';
    SCENARIOS.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s.title;
      if (i === activeScenario) b.classList.add('active');
      b.addEventListener('click', () => {
        activeScenario = i;
        nextStep = 0;
        renderWalkthroughs();
      });
      $('tabs').appendChild(b);
    });
    $('scenarioText').textContent = sc.text;
    $('steps').innerHTML = '';
    sc.steps.forEach((st, i) => {
      const li = document.createElement('li');
      if (i === nextStep) li.classList.add('next');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = st.label;
      b.addEventListener('click', () => {
        st.run(sc);
        nextStep = i + 1;
        renderWalkthroughs();
      });
      li.appendChild(b);
      $('steps').appendChild(li);
    });
  }

  initControls();
  renderWalkthroughs();
  rebuild();
  fitView();
})();
