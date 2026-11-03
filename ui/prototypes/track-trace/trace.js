/*
 * PROTOTYPE, throwaway. Pure geometry for the track-trace prototype: no DOM.
 * The page calls build(); nothing here reaches the page.
 *
 * A line through clicks P0..Pn-1. Each gap between two clicks is marked
 * free, straight or radius. Consecutive gaps with the same mark (other than
 * free) form a run: a straight run is one line fitted to its clicks, a radius
 * run one circle. Free clicks lie on the line; each gets a heading from its
 * neighbours and each free gap is an equal-chord biarc. A free curve meets a
 * run on the circle through its last two free clicks that touches the run.
 *
 * Units are image pixels. Headings in radians, curvature positive turning
 * towards increasing heading.
 */
var TrackTrace = (function () {
  'use strict';

  const TAU = 2 * Math.PI;
  const wrap = a => a - TAU * Math.floor((a + Math.PI) / TAU);
  const mod = a => a - TAU * Math.floor(a / TAU);
  const ang = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const add = (a, b, k = 1) => ({ x: a.x + k * b.x, y: a.y + k * b.y });
  const perp = v => ({ x: -v.y, y: v.x });
  const unit = v => {
    const l = Math.hypot(v.x, v.y);
    return { x: v.x / l, y: v.y / l };
  };
  const dir = h => ({ x: Math.cos(h), y: Math.sin(h) });

  /* ---------- parts: a start pose, a length and a curvature ---------- */

  function advance(p, s, k) {
    if (Math.abs(k) < 1e-12) {
      return { x: p.x + s * Math.cos(p.heading), y: p.y + s * Math.sin(p.heading), heading: p.heading };
    }
    const h = p.heading + k * s;
    return {
      x: p.x + (Math.sin(h) - Math.sin(p.heading)) / k,
      y: p.y - (Math.cos(h) - Math.cos(p.heading)) / k,
      heading: h,
    };
  }

  /** The one arc from A with heading h through B. */
  function arcPart(A, h, B, tag) {
    const d = dist(A, B);
    if (d < 1e-9) return null;
    const tau = 2 * wrap(ang(A, B) - h);
    const length = Math.abs(tau) < 1e-9 ? d : (d * (tau / 2)) / Math.sin(tau / 2);
    return Object.assign({ start: { x: A.x, y: A.y, heading: h }, length, curvature: tau / length }, tag);
  }

  /** Equal-chord biarc from A (heading ha) to B (heading hb). */
  function biarc(A, ha, B, hb, tag) {
    const g = ang(A, B);
    const d = dist(A, B);
    if (d < 1e-9) return [];
    const t0 = wrap(ha - g);
    const t1 = wrap(hb - g);
    const k = (d / 2) * Math.tan((t0 - t1) / 4);
    const n = perp(dir(g));
    const J = { x: (A.x + B.x) / 2 + k * n.x, y: (A.y + B.y) / 2 + k * n.y };
    return [arcPart(A, ha, J, tag), arcPart(J, g - (t0 + t1) / 2, B, tag)].filter(Boolean);
  }

  /* ---------- headings at free clicks ---------- */

  /** Circle through A, B, C for travel A to C: curvature and the heading at each point. */
  function circle3(A, B, C) {
    const ac = dist(A, C);
    if (ac < 1e-9 || dist(A, B) < 1e-9 || dist(B, C) < 1e-9) return null;
    const g1 = ang(A, B);
    const g2 = ang(B, C);
    const hB = g1 + wrap(g2 - g1) - wrap(ang(A, C) - g1);
    return { kappa: (2 * Math.sin(wrap(g2 - g1))) / ac, hA: 2 * g1 - hB, hB, hC: 2 * g2 - hB };
  }

  /** Heading at F[i] from the circles behind and ahead, weighted after Akima (1970). */
  function akima(F, i) {
    const b = circle3(F[i - 2], F[i - 1], F[i]);
    const m = circle3(F[i - 1], F[i], F[i + 1]);
    const f = circle3(F[i], F[i + 1], F[i + 2]);
    if (!b || !m || !f) return m ? m.hB : null;
    const wb = Math.abs(f.kappa - m.kappa);
    const wf = Math.abs(b.kappa - m.kappa);
    const share = wb + wf < 1e-15 ? 0.5 : wf / (wb + wf);
    return b.hC + share * wrap(f.hA - b.hC);
  }

  /* ---------- carriers: the line or circle a run lies on ---------- */

  const footOn = (car, x) =>
    car.kind === 'line' ? add(car.p, car.d, dot(sub(x, car.p), car.d)) : add(car.c, unit(sub(x, car.c)), car.r);

  const headingOn = (car, x) =>
    car.kind === 'line' ? Math.atan2(car.d.y, car.d.x) : ang(car.c, x) + (car.sigma * Math.PI) / 2;

  const residual = (car, x) => (car.kind === 'line' ? dot(sub(x, car.p), perp(car.d)) : dist(x, car.c) - car.r);

  const reversed = car =>
    car.kind === 'line' ? { ...car, d: { x: -car.d.x, y: -car.d.y } } : { ...car, sigma: -car.sigma };

  /** Sweep from x to y around centre c in direction sigma, in [0, 2π). */
  const sweep = (c, sigma, x, y) => mod(sigma * (ang(c, y) - ang(c, x)));

  function solve(a, b) {
    const n = b.length;
    const m = a.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      [m[c], m[p]] = [m[p], m[c]];
      const pivot = m[c][c] || 1e-30;
      for (let r = c + 1; r < n; r++) {
        const f = m[r][c] / pivot;
        for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = m[r][n];
      for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k];
      x[r] = s / (m[r][r] || 1e-30);
    }
    return x;
  }

  /** Damped Gauss-Newton on residuals(v) with jacobian(v) (rows per residual). */
  function gaussNewton(v0, residuals, jacobian) {
    let v = [...v0];
    let r = residuals(v);
    let cost = r.reduce((s, x) => s + x * x, 0);
    let lambda = 1e-6;
    for (let it = 0; it < 60; it++) {
      const J = jacobian(v);
      const p = v.length;
      const A = Array.from({ length: p }, (_, i) =>
        Array.from({ length: p }, (_, j) => J.reduce((s, row) => s + row[i] * row[j], 0))
      );
      const g = Array.from({ length: p }, (_, i) => -J.reduce((s, row, k) => s + row[i] * r[k], 0));
      let improved = false;
      while (lambda < 1e8) {
        const D = A.map((row, i) => row.map((x, j) => (i === j ? x * (1 + lambda) + 1e-12 : x)));
        const delta = solve(D, g);
        const w = v.map((x, i) => x + delta[i]);
        const rw = residuals(w);
        const cw = rw.reduce((s, x) => s + x * x, 0);
        if (cw < cost) {
          improved = cost - cw > 1e-12 * (cost + 1e-12);
          v = w;
          r = rw;
          cost = cw;
          lambda = Math.max(1e-9, lambda / 4);
          break;
        }
        lambda *= 8;
      }
      if (!improved) break;
    }
    return v;
  }

  /** Total least squares line, pointing from the first point to the last. */
  function fitLine(P) {
    const n = P.length;
    const m = { x: P.reduce((s, p) => s + p.x, 0) / n, y: P.reduce((s, p) => s + p.y, 0) / n };
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of P) {
      const dx = p.x - m.x, dy = p.y - m.y;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let d = dir(a);
    if (dot(sub(P[n - 1], P[0]), d) < 0) d = { x: -d.x, y: -d.y };
    return { kind: 'line', p: m, d };
  }

  function orient(c, P) {
    let s = 0;
    for (let i = 0; i + 1 < P.length; i++) s += wrap(ang(c, P[i + 1]) - ang(c, P[i]));
    return s >= 0 ? 1 : -1;
  }

  /** Least-squares circle: algebraic start, then geometric distance. */
  function fitCircleFree(P) {
    const n = P.length;
    const m = { x: P.reduce((s, p) => s + p.x, 0) / n, y: P.reduce((s, p) => s + p.y, 0) / n };
    const Q = P.map(p => sub(p, m));
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const b = [0, 0, 0];
    for (const q of Q) {
      const row = [q.x, q.y, 1];
      const z = q.x * q.x + q.y * q.y;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j];
        b[i] -= row[i] * z;
      }
    }
    const [D, E, F] = solve(A, b);
    let v = [-D / 2, -E / 2, Math.sqrt(Math.max(1e-9, (D * D + E * E) / 4 - F))];
    v = gaussNewton(
      v,
      w => Q.map(q => Math.hypot(q.x - w[0], q.y - w[1]) - w[2]),
      w =>
        Q.map(q => {
          const d = Math.hypot(q.x - w[0], q.y - w[1]) || 1e-12;
          return [-(q.x - w[0]) / d, -(q.y - w[1]) / d, -1];
        })
    );
    const c = add(m, { x: v[0], y: v[1] });
    return { kind: 'circle', c, r: Math.abs(v[2]), sigma: orient(c, P) };
  }

  /** The circle through u then v that goes on to touch car, continuing along it. */
  function tangentCircle(car, u, v) {
    const m = { x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 };
    const h = dist(u, v) / 2;
    if (h < 1e-9) return null;
    const w = perp(unit(sub(v, u)));
    let qa, qb, qc;
    if (car.kind === 'line') {
      const n = perp(car.d);
      const alpha = dot(n, sub(m, car.p));
      const beta = dot(n, w);
      qa = beta * beta - 1; qb = 2 * alpha * beta; qc = alpha * alpha - h * h;
    } else {
      const A = dot(sub(m, car.c), sub(m, car.c));
      const B = dot(w, sub(m, car.c));
      const E = A - car.r * car.r - h * h;
      qa = 4 * (B * B - car.r * car.r); qb = 4 * E * B; qc = E * E - 4 * car.r * car.r * h * h;
    }
    const roots = [];
    if (Math.abs(qa) < 1e-12 * (Math.abs(qb) + Math.abs(qc) + 1)) {
      if (Math.abs(qb) > 1e-12) roots.push(-qc / qb);
    } else {
      const disc = qb * qb - 4 * qa * qc;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        roots.push((-qb + s) / (2 * qa), (-qb - s) / (2 * qa));
      }
    }
    let best = null;
    for (const t of roots) {
      const c = add(m, w, t);
      const r = Math.hypot(h, t);
      let T;
      if (car.kind === 'line') {
        T = footOn(car, c);
      } else {
        const e = unit(sub(c, car.c));
        const T1 = add(car.c, e, car.r);
        const T2 = add(car.c, e, -car.r);
        T = Math.abs(dist(T1, c) - r) <= Math.abs(dist(T2, c) - r) ? T1 : T2;
      }
      const along = dir(headingOn(car, T));
      const sigma = dot(perp(sub(T, c)), along) >= 0 ? 1 : -1;
      const uv = sweep(c, sigma, u, v);
      const uT = sweep(c, sigma, u, T);
      if (uv >= Math.PI || uT <= uv) continue;
      if (!best || uT - uv < best.vT) best = { c, r, sigma, T, vT: uT - uv };
    }
    return best;
  }

  /** Position of x along car, measured from ref in the direction of travel. */
  const along = (car, x, ref) =>
    car.kind === 'line' ? dot(sub(x, car.p), car.d) - dot(sub(ref, car.p), car.d)
      : car.r * wrap(car.sigma * (ang(car.c, x) - ang(car.c, ref)));

  /**
   * tangentCircle, kept only if the circle is no tighter than minRadius and
   * touches car between the last free click v and the run's second click.
   */
  function joinCircle(car, u, v, first, second, minRadius) {
    const k = tangentCircle(car, u, v);
    if (!k || k.r < minRadius) return null;
    const ref = footOn(car, first);
    const t = along(car, k.T, ref);
    if (t < along(car, footOn(car, v), ref) || t > along(car, footOn(car, second), ref)) return null;
    return k;
  }

  /** Circle through P touching line L, which comes before it ('before') or after it. */
  function fitCircleTangent1(P, L, side) {
    const n = perp(L.d);
    let init;
    if (P.length >= 3) {
      const f = fitCircleFree(P);
      const s = dot(sub(f.c, L.p), L.d);
      const off = dot(sub(f.c, L.p), n);
      init = [s, Math.sign(off || 1) * f.r];
    } else {
      const k = side === 'before' ? tangentCircle(reversed(L), P[1], P[0]) : tangentCircle(L, P[0], P[1]);
      if (!k) return null;
      init = [dot(sub(k.c, L.p), L.d), dot(sub(k.c, L.p), n)];
    }
    const centre = w => add(add(L.p, L.d, w[0]), n, w[1]);
    const v = gaussNewton(
      init,
      w => P.map(p => dist(p, centre(w)) - Math.abs(w[1])),
      w =>
        P.map(p => {
          const u = unit(sub(p, centre(w)));
          return [-dot(u, L.d), -dot(u, n) - Math.sign(w[1] || 1)];
        })
    );
    const c = centre(v);
    return { kind: 'circle', c, r: Math.abs(v[1]), sigma: v[1] >= 0 ? 1 : -1, T: footOn(L, c) };
  }

  /** Circle near P touching line L1 before it and line L2 after it. */
  function fitCircleTangent2(P, L1, L2) {
    const n1 = perp(L1.d);
    const n2 = perp(L2.d);
    const det = n1.x * n2.y - n1.y * n2.x;
    if (Math.abs(det) < 1e-6) return null;
    const at = (r1, r2) => {
      const [x, y] = solve([[n1.x, n1.y], [n2.x, n2.y]], [r1, r2]);
      return { x, y };
    };
    const c0 = at(dot(n1, L1.p), dot(n2, L2.p));
    const c1 = at(1, 1);
    const centre = rho => add(c0, c1, rho);
    const turn = Math.sign(wrap(Math.atan2(L2.d.y, L2.d.x) - Math.atan2(L1.d.y, L1.d.x))) || 1;
    // Start from the circle through the middle click: |p - c0 - rho c1| = |rho|.
    const p = P[Math.floor(P.length / 2)];
    const q = sub(p, c0);
    const qa = dot(c1, c1) - 1, qb = -2 * dot(c1, q), qc = dot(q, q);
    const disc = qb * qb - 4 * qa * qc;
    const roots = disc < 0 ? [] : [(-qb + Math.sqrt(disc)) / (2 * qa), (-qb - Math.sqrt(disc)) / (2 * qa)];
    const cost = rho => P.reduce((s, x) => s + (dist(x, centre(rho)) - Math.abs(rho)) ** 2, 0);
    const ok = roots.filter(r => Math.sign(r) === turn).sort((a, b) => cost(a) - cost(b));
    if (!ok.length) return null;
    const [rho] = gaussNewton(
      [ok[0]],
      w => P.map(x => dist(x, centre(w[0])) - Math.abs(w[0])),
      w => P.map(x => [-dot(unit(sub(x, centre(w[0]))), c1) - Math.sign(w[0] || 1)])
    );
    if (Math.sign(rho) !== turn) return null;
    const c = centre(rho);
    return { kind: 'circle', c, r: Math.abs(rho), sigma: turn, T1: footOn(L1, c), T2: footOn(L2, c) };
  }

  /** The piece of a carrier from S to E. */
  function piece(car, S, E, tag, warnings) {
    const h = headingOn(car, S);
    if (car.kind === 'line') {
      const length = dot(sub(E, S), car.d);
      if (length < -1e-6) warnings.push(`run ${tag.run + 1}: its ends cross; the straight is drawn with no length`);
      return { start: { x: S.x, y: S.y, heading: h }, length: Math.max(0, length), curvature: 0, ...tag };
    }
    let sw = sweep(car.c, car.sigma, S, E);
    if (sw > 1.9 * Math.PI) {
      warnings.push(`run ${tag.run + 1}: its ends cross; the arc is drawn with no length`);
      sw = 0;
    }
    return { start: { x: S.x, y: S.y, heading: h }, length: car.r * sw, curvature: car.sigma / car.r, ...tag };
  }

  /* ---------- the line ---------- */

  /** The old rule: first gap straight, then one arc per gap tangent to the one before. */
  function oneArcPerGap(P) {
    const parts = [];
    const headings = [];
    let h = ang(P[0], P[1]);
    headings.push(h);
    for (let i = 0; i + 1 < P.length; i++) {
      const part = arcPart(P[i], h, P[i + 1], { kind: 'free', gap: i });
      if (part) parts.push(part);
      h = 2 * ang(P[i], P[i + 1]) - h;
      headings.push(h);
    }
    return parts.length ? { parts, headings, runs: [], warnings: [] } : empty();
  }

  const empty = () => ({ parts: [], headings: [], runs: [], warnings: [] });

  /**
   * input: { clicks, marks (per gap: 'free' | 'straight' | 'radius'), rule ('akima' | 'circle3' | 'onearc'),
   *          minRadius (px, the tightest circle that may join a free curve to a run) }
   * returns: { parts, headings (per click, null on a run click), runs, warnings }
   */
  function build(input) {
    const P = input.clicks;
    const n = P.length;
    if (n < 2) return empty();
    if (input.rule === 'onearc') return oneArcPerGap(P);
    const warnings = [];

    // Runs: maximal stretches of gaps with the same mark other than free.
    let marks = input.marks.slice(0, n - 1);
    const findRuns = () => {
      const runs = [];
      for (let g = 0; g < n - 1; g++) {
        if (marks[g] === 'free') continue;
        const last = runs[runs.length - 1];
        if (last && last.kind === marks[g] && last.b === g) last.b = g + 1;
        else runs.push({ kind: marks[g], a: g, b: g + 1 });
      }
      return runs;
    };
    let runs = findRuns();
    const touches = (r1, r2) => r1 && r2 && r1.b === r2.a;
    // A radius run needs three clicks, counting a click it shares with a straight.
    runs.forEach(r => {
      if (r.kind === 'radius' && r.b - r.a + 1 < 3) {
        warnings.push(`clicks ${r.a + 1}–${r.b + 1}: one radius needs 3 clicks; drawn as free`);
        for (let g = r.a; g < r.b; g++) marks[g] = 'free';
      }
    });
    runs = findRuns();

    // Fit straights, then radii, which touch an adjoining straight. A click
    // shared with a straight belongs to the straight.
    runs.forEach(r => {
      r.clicks = P.slice(r.a, r.b + 1);
      r.first = r.a;
      if (r.kind === 'straight') r.carrier = fitLine(r.clicks);
    });
    runs.forEach((r, i) => {
      if (r.kind !== 'radius') return;
      const before = touches(runs[i - 1], r) && runs[i - 1].kind === 'straight' ? runs[i - 1] : null;
      const after = touches(r, runs[i + 1]) && runs[i + 1].kind === 'straight' ? runs[i + 1] : null;
      r.first = before ? r.a + 1 : r.a;
      r.clicks = P.slice(r.first, after ? r.b : r.b + 1);
      let fit = null;
      if (before && after) {
        fit = fitCircleTangent2(r.clicks, before.carrier, after.carrier);
        if (fit) {
          r.start = fit.T1; before.end = fit.T1;
          r.end = fit.T2; after.start = fit.T2;
          r.touches = 'straights on both sides';
        } else warnings.push(`run ${i + 1}: no circle touches both straights; fitted freely`);
      } else if (before || after) {
        fit = fitCircleTangent1(r.clicks, (before || after).carrier, before ? 'before' : 'after');
        if (fit) {
          if (before) { r.start = fit.T; before.end = fit.T; r.touches = 'the straight before it'; }
          else { r.end = fit.T; after.start = fit.T; r.touches = 'the straight after it'; }
        }
      }
      if (!fit && r.clicks.length < 3) {
        r.carrier = null;
        return;
      }
      r.carrier = fit || fitCircleFree(r.clicks);
    });
    runs = runs.filter(r => r.carrier);
    runs.forEach(r => {
      r.residuals = r.clicks.map(p => residual(r.carrier, p));
      r.worst = Math.max(...r.residuals.map(Math.abs));
      if (!r.start) r.start = footOn(r.carrier, P[r.a]);
      if (!r.end) r.end = footOn(r.carrier, P[r.b]);
    });

    // Free stretches: maximal sequences of clicks in no run.
    const inRun = new Array(n).fill(false);
    runs.forEach(r => { for (let i = r.a; i <= r.b; i++) inRun[i] = true; });
    const headings = new Array(n).fill(null);
    const stretches = [];
    for (let i = 0; i < n; i++) {
      if (inRun[i]) continue;
      const last = stretches[stretches.length - 1];
      if (last && last.idx[last.idx.length - 1] === i - 1) last.idx.push(i);
      else stretches.push({ idx: [i] });
    }
    for (const st of stretches) {
      const idx = st.idx;
      const F = idx.map(i => P[i]);
      const m = F.length;
      const H = new Array(m).fill(null);
      const left = runs.find(r => r.b === idx[0] - 1) || null;
      const right = runs.find(r => r.a === idx[m - 1] + 1) || null;
      st.left = left;
      st.right = right;
      if (left && m >= 2) {
        const k = joinCircle(reversed(left.carrier), F[1], F[0], P[left.b], P[left.b - 1], input.minRadius || 0);
        if (k) {
          const K = { kind: 'circle', c: k.c, r: k.r, sigma: -k.sigma };
          left.end = k.T;
          H[0] = headingOn(K, F[0]);
          if (m >= 4) H[1] = headingOn(K, F[1]);
        } else warnings.push(`clicks ${idx[0] + 1}–${idx[1] + 1}: no circle through them touches the run before inside gap ${idx[0]}; joined by two arcs`);
      }
      if (right && m >= 2) {
        const k = joinCircle(right.carrier, F[m - 2], F[m - 1], P[right.a], P[right.a + 1], input.minRadius || 0);
        if (k) {
          right.start = k.T;
          H[m - 1] = headingOn(k, F[m - 1]);
          if (m >= 4) H[m - 2] = headingOn(k, F[m - 2]);
        } else warnings.push(`clicks ${idx[m - 2] + 1}–${idx[m - 1] + 1}: no circle through them touches the run after inside gap ${idx[m - 1] + 1}; joined by two arcs`);
      }
      if (m === 1) {
        const hs = [];
        if (left) hs.push(2 * ang(left.end, F[0]) - headingOn(left.carrier, left.end));
        if (right) hs.push(2 * ang(F[0], right.start) - headingOn(right.carrier, right.start));
        if (hs.length) H[0] = hs.length === 1 ? hs[0] : hs[0] + wrap(hs[1] - hs[0]) / 2;
      } else if (m === 2 && H[0] === null && H[1] === null) {
        H[0] = H[1] = ang(F[0], F[1]);
      } else {
        for (let i = 1; i < m - 1; i++) {
          if (H[i] !== null) continue;
          const c = circle3(F[i - 1], F[i], F[i + 1]);
          H[i] = input.rule === 'akima' && i >= 2 && i <= m - 3 ? akima(F, i) : c ? c.hB : ang(F[i - 1], F[i + 1]);
          if (H[i] === null) H[i] = ang(F[i - 1], F[i + 1]);
        }
        if (H[0] === null) H[0] = 2 * ang(F[0], F[1]) - H[1];
        if (H[m - 1] === null) H[m - 1] = 2 * ang(F[m - 2], F[m - 1]) - H[m - 2];
      }
      idx.forEach((i, k) => (headings[i] = H[k]));
    }

    // Assemble in click order.
    const parts = [];
    const runAt = a => runs.find(r => r.a === a);
    let i = 0;
    let prevRun = null;
    while (i < n) {
      const r = runAt(i);
      if (r) {
        if (prevRun && prevRun.b === r.a && dist(prevRun.end, r.start) > 1e-6) {
          parts.push(...biarc(prevRun.end, headingOn(prevRun.carrier, prevRun.end), r.start,
            headingOn(r.carrier, r.start), { kind: 'join', gap: r.a }));
        } else if (prevRun && prevRun.b + 1 === r.a) {
          parts.push(...biarc(prevRun.end, headingOn(prevRun.carrier, prevRun.end), r.start,
            headingOn(r.carrier, r.start), { kind: 'free', gap: prevRun.b }));
        }
        parts.push(piece(r.carrier, r.start, r.end, { kind: r.kind, run: runs.indexOf(r) }, warnings));
        prevRun = r;
        i = r.b;
        if (!runAt(i)) i++;
        continue;
      }
      const st = stretches.find(s => s.idx[0] === i);
      const nodes = [];
      if (st.left) nodes.push({ p: st.left.end, h: headingOn(st.left.carrier, st.left.end), gap: st.idx[0] - 1 });
      st.idx.forEach(k => nodes.push({ p: P[k], h: headings[k], gap: k }));
      if (st.right) nodes.push({ p: st.right.start, h: headingOn(st.right.carrier, st.right.start) });
      for (let k = 0; k + 1 < nodes.length; k++) {
        if (nodes[k].h === null || nodes[k + 1].h === null) continue;
        parts.push(...biarc(nodes[k].p, nodes[k].h, nodes[k + 1].p, nodes[k + 1].h, { kind: 'free', gap: nodes[k].gap }));
      }
      prevRun = null;
      i = st.idx[st.idx.length - 1] + 1;
    }

    return {
      parts,
      headings,
      runs: runs.map(r => ({
        kind: r.kind, a: r.a, b: r.b, first: r.first, carrier: r.carrier, residuals: r.residuals, worst: r.worst,
        radius: r.carrier.kind === 'circle' ? r.carrier.r : Infinity, touches: r.touches || null,
      })),
      warnings,
    };
  }

  /* ---------- sampling and measuring ---------- */

  /** Points along the parts every `step` px, with arc length s from the start and curvature. */
  function sample(parts, step) {
    const out = [];
    let s0 = 0;
    parts.forEach((part, pi) => {
      const k = Math.max(1, Math.ceil(part.length / step));
      for (let j = 0; j <= k; j++) {
        const s = (part.length * j) / k;
        const p = advance(part.start, s, part.curvature);
        out.push({ x: p.x, y: p.y, heading: p.heading, s: s0 + s, curvature: part.curvature, part: pi });
      }
      s0 += part.length;
    });
    return out;
  }

  function segDist(p, a, b) {
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
    return dist(p, add(a, ab, t));
  }

  /** Distance from p to a sampled polyline, and the arc length of the nearest point. */
  function nearest(samples, p) {
    let best = { d: Infinity, s: 0, i: -1 };
    for (let i = 0; i + 1 < samples.length; i++) {
      const d = segDist(p, samples[i], samples[i + 1]);
      if (d < best.d) best = { d, s: samples[i].s, i };
    }
    return best;
  }

  /**
   * Largest distance from any sample of a to the polyline b. Each sample is
   * first looked for near where the last one was found; that distance is an
   * upper bound, so it is kept only when it cannot raise the result above
   * max(worst so far, enough), and otherwise the whole of b is searched.
   */
  function farthest(a, b, enough = 0) {
    let worst = 0;
    let hint = -1;
    for (const p of a) {
      let found = null;
      if (hint >= 0) {
        let d = Infinity;
        let at = hint;
        for (let i = Math.max(0, hint - 40); i <= Math.min(b.length - 2, hint + 40); i++) {
          const di = segDist(p, b[i], b[i + 1]);
          if (di < d) {
            d = di;
            at = i;
          }
        }
        if (d <= Math.max(worst, enough)) found = { d, i: at };
      }
      if (!found) found = nearest(b, p);
      hint = found.i;
      worst = Math.max(worst, found.d);
    }
    return worst;
  }

  return { build, sample, nearest, farthest, circle3, biarc, arcPart, advance, wrap, ang, dist };
})();

if (typeof module !== 'undefined') module.exports = TrackTrace;
