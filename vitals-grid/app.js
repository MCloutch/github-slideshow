'use strict';

// Layout of the intra-op vitals grid on the paper AOS Anesthetic Record.
// The form prints no time interval: 5 minutes per column is inferred, and can also be changed on the page.
const GRID = {
  minutesPerColumn: 5,
  columns: 38,          // 3 full hour blocks plus nearly 2 more columns on paper
  dottedEvery: 3,       // every 3rd vertical line is dotted
  darkEvery: 12,        // every 12th vertical line is solid and dark
  valueMin: -10,        // one unlabelled row below 0
  valueMax: 230,        // one unlabelled row above 220
  rowStep: 10,
  labelFrom: 0,
  labelTo: 220,
  labelStep: 20,
  dottedValue: 100,
};
const LOWER_ROWS = ['SpO2 %', 'EtCO2', 'RR', 'Paw', 'EKG', 'T', 'IV Fluid', 'EBL'];
const COLUMN_MINUTE_CHOICES = [1, 2, 3, 5, 10, 15];
const SNAP_CHOICES = [1, 2, 5, 10];
const DEFAULT_SNAP = 5;
// Numbers kept per time point. Modes B and C share them; only sys, dia and hr plot on the grid.
const VITAL_FIELDS = [
  { key: 'sys', label: 'Systolic', min: 1, max: 300, len: 3 },
  { key: 'dia', label: 'Diastolic', min: 1, max: 250, len: 3 },
  { key: 'hr', label: 'Heart rate', min: 1, max: 300, len: 3 },
  { key: 'spo2', label: 'SpO\u2082', min: 1, max: 100, len: 3 },
  { key: 'etco2', label: 'EtCO\u2082', min: 0, max: 150, len: 3 },
  { key: 'rr', label: 'RR', min: 0, max: 99, len: 2 },
];

// Horizontal sizes are in column widths so drawings rescale cleanly when the iPad rotates.
const NOTES_COLS = 3.6;
const SCALE_COLS = 1.25;
const RIGHT_PAD_COLS = 0.6;
const LOWER_ROW_RATIO = 1.25;   // height of a row below the grid, relative to one 10-unit grid row
const HEADER_H = 20;            // clock-time strip above the grid (CSS px)

const INK_COLOR = '#1b2f80';
const BP_COLOR = '#1d4ed8';
const HR_COLOR = '#d42a2a';
const INK_WIDTH = 2.2;
const ERASER_R = 11;
const TAP_PX = 7;
const STORE_KEY = 'vitals-grid-spike-v1';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const $ = (sel) => document.querySelector(sel);
const chartEl = $('#chart');
const canvases = {
  bg: $('#bgCanvas'),
  ink: $('#inkCanvas'),
  live: $('#liveCanvas'),
  overlay: $('#overlayCanvas'),
};
const ctx = {};
for (const [k, c] of Object.entries(canvases)) ctx[k] = c.getContext('2d');

const state = {
  mode: 'ink',
  mark: 'auto',
  snap: DEFAULT_SNAP,
  minutesPerColumn: GRID.minutesPerColumn,
  start: '08:00',
  data: {
    ink: { strokes: [] },
    smart: { strokes: [], vitals: {} },
  },
};
let tool = 'pen';
const undoStacks = { ink: [], smart: [] };   // keyed by dataKey(): B and C share one history
const hasPointerEvents = typeof PointerEvent !== 'undefined';
const supports = {
  coalesced: hasPointerEvents && 'getCoalescedEvents' in PointerEvent.prototype,
  predicted: hasPointerEvents && 'getPredictedEvents' in PointerEvent.prototype,
};
const diag = { lastType: '-', pressure: null, ignored: 0, hover: false, coalescedSeen: false, predictedSeen: false, rate: null };

let L = null;            // current layout, see computeLayout()
let gesture = null;      // the Pencil (or mouse) gesture in progress
let chartRect = null;
let lastChangedCol = null;

/* ---------- persistence ---------- */

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!saved) return;
    if (['ink', 'smart', 'typed'].includes(saved.mode)) state.mode = saved.mode;
    if (['auto', 'sys', 'dia', 'hr'].includes(saved.mark)) state.mark = saved.mark;
    if (SNAP_CHOICES.includes(saved.snap)) state.snap = saved.snap;
    if (saved.minutesPerColumn > 0) state.minutesPerColumn = saved.minutesPerColumn;
    if (/^\d\d:\d\d$/.test(saved.start || '')) state.start = saved.start;
    if (Array.isArray(saved.data?.ink?.strokes)) state.data.ink.strokes = saved.data.ink.strokes;
    if (Array.isArray(saved.data?.smart?.strokes)) state.data.smart.strokes = saved.data.smart.strokes;
    if (saved.data?.smart?.vitals) state.data.smart.vitals = saved.data.smart.vitals;
  } catch (err) {
    console.warn('Could not restore the saved drawing', err);
  }
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn('Could not save the drawing', err);
    }
  }, 250);
}

/* ---------- layout and coordinates ---------- */

function computeLayout() {
  const cssW = Math.max(320, Math.floor(chartEl.clientWidth));
  const colW = cssW / (NOTES_COLS + SCALE_COLS + GRID.columns + RIGHT_PAD_COLS);
  const nRows = (GRID.valueMax - GRID.valueMin) / GRID.rowStep;
  const chartTop = chartEl.getBoundingClientRect().top + window.scrollY;
  const belowH = $('#below').offsetHeight;
  const avail = window.innerHeight - chartTop - belowH - 4;
  const rowH = Math.min(26, Math.max(11, (avail - HEADER_H - 4) / (nRows + LOWER_ROWS.length * LOWER_ROW_RATIO)));
  const gridLeft = (NOTES_COLS + SCALE_COLS) * colW;
  const gridTop = HEADER_H;
  const lowerRowH = rowH * LOWER_ROW_RATIO;
  const lowerTop = gridTop + nRows * rowH;
  const lowerBottom = lowerTop + LOWER_ROWS.length * lowerRowH;
  return {
    cssW, cssH: Math.ceil(lowerBottom + 4), colW, rowH, nRows,
    gridLeft, gridTop, gridRight: gridLeft + GRID.columns * colW, gridBottom: lowerTop,
    notesW: NOTES_COLS * colW, lowerRowH, lowerTop, lowerBottom,
    dpr: Math.min(3, window.devicePixelRatio || 1),
  };
}

function applyLayout() {
  L = computeLayout();
  chartEl.style.height = L.cssH + 'px';
  for (const [k, c] of Object.entries(canvases)) {
    c.width = Math.round(L.cssW * L.dpr);
    c.height = Math.round(L.cssH * L.dpr);
    c.style.width = L.cssW + 'px';
    c.style.height = L.cssH + 'px';
    ctx[k].setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
  }
  drawBackground();
  redrawInk();
  renderTable();
  renderTyped();
}

const colX = (col) => L.gridLeft + col * L.colW;
const valueY = (v) => L.gridTop + ((GRID.valueMax - v) / GRID.rowStep) * L.rowH;
const yToValue = (y) => GRID.valueMax - ((y - L.gridTop) / L.rowH) * GRID.rowStep;
// Ink is stored in grid units (x in columns from the grid's left edge, y in 10-unit rows from its top).
const unitX = (u) => L.gridLeft + u * L.colW;
const unitY = (u) => L.gridTop + u * L.rowH;
const toUnits = (x, y) => ({ x: (x - L.gridLeft) / L.colW, y: (y - L.gridTop) / L.rowH });

function snapCol(x) {
  return Math.max(0, Math.min(GRID.columns, Math.round((x - L.gridLeft) / L.colW)));
}
function snapValue(v) {
  return Math.max(0, Math.min(GRID.valueMax, Math.round(v / state.snap) * state.snap));
}

function startMinutes() {
  const [h, m] = state.start.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function timeAt(col) {
  const t = Math.round(startMinutes() + col * state.minutesPerColumn);
  return String(Math.floor(t / 60) % 24).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

function regionAt(x, y) {
  if (x >= L.gridLeft - 6 && x <= L.gridRight + 6 && y >= L.gridTop - 8 && y <= L.gridBottom) return 'grid';
  if (x >= 2 && x < L.notesW && y >= L.gridTop && y <= L.gridBottom) return 'notes';
  if (x >= L.gridLeft && x <= L.gridRight && y > L.gridBottom && y <= L.lowerBottom) return 'rows';
  return null;
}

/* ---------- drawing ---------- */

function clearCanvas(name) {
  ctx[name].clearRect(0, 0, L.cssW, L.cssH);
}

function drawBackground() {
  const c = ctx.bg;
  const { gridLeft: gl, gridRight: gr, gridTop: gt, gridBottom: gb, lowerTop, lowerBottom, lowerRowH, notesW } = L;
  const crisp = (v) => Math.round(v) + 0.5;
  c.fillStyle = '#fff';
  c.fillRect(0, 0, L.cssW, L.cssH);

  // Faint time guides in the rows below (paper has none; on the iPad they can share the grid's columns).
  c.strokeStyle = '#eceef1';
  c.lineWidth = 1;
  c.beginPath();
  for (let i = GRID.dottedEvery; i < GRID.columns; i += GRID.dottedEvery) {
    const x = crisp(colX(i));
    c.moveTo(x, lowerTop);
    c.lineTo(x, lowerBottom);
  }
  c.stroke();

  // Light lines: every 10 units and every column.
  c.strokeStyle = '#d3d6db';
  c.beginPath();
  for (let i = 1; i < L.nRows; i++) {
    const y = crisp(gt + i * L.rowH);
    c.moveTo(gl, y);
    c.lineTo(gr, y);
  }
  for (let i = 1; i < GRID.columns; i++) {
    if (i % GRID.dottedEvery === 0) continue;
    const x = crisp(colX(i));
    c.moveTo(x, gt);
    c.lineTo(x, gb);
  }
  c.stroke();

  // Dotted lines: every 3rd column, and across at 100.
  c.strokeStyle = '#1f1f1f';
  c.lineWidth = 1.3;
  c.setLineDash([2.5, 2.5]);
  c.beginPath();
  for (let i = GRID.dottedEvery; i < GRID.columns; i += GRID.dottedEvery) {
    if (i % GRID.darkEvery === 0) continue;
    const x = crisp(colX(i));
    c.moveTo(x, gt);
    c.lineTo(x, gb);
  }
  const y100 = crisp(valueY(GRID.dottedValue));
  c.moveTo(gl, y100);
  c.lineTo(gr, y100);
  c.stroke();
  c.setLineDash([]);

  // Dark solid lines every 12th column.
  c.strokeStyle = '#2b2b2b';
  c.lineWidth = 2;
  c.beginPath();
  for (let i = GRID.darkEvery; i < GRID.columns; i += GRID.darkEvery) {
    const x = Math.round(colX(i));
    c.moveTo(x, gt);
    c.lineTo(x, gb);
  }
  c.stroke();

  // Frames: grid, Notes column, rows below.
  c.strokeStyle = '#222';
  c.lineWidth = 1.5;
  c.strokeRect(gl, gt, gr - gl, gb - gt);
  c.beginPath();
  c.moveTo(1, gt); c.lineTo(gl, gt);
  c.moveTo(1, gt); c.lineTo(1, lowerBottom);
  c.moveTo(gr, gb); c.lineTo(gr, lowerBottom);
  for (let i = 0; i <= LOWER_ROWS.length; i++) {
    const y = Math.round(lowerTop + i * lowerRowH) + 0.5;
    c.moveTo(1, y);
    c.lineTo(gr, y);
  }
  c.moveTo(gl, lowerTop); c.lineTo(gl, lowerBottom);
  c.stroke();
  c.strokeStyle = '#c9ccd1';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(crisp(notesW), gt + 4);
  c.lineTo(crisp(notesW), gb - 4);
  c.stroke();

  // Labels.
  c.fillStyle = '#111';
  c.font = `600 12px ${FONT}`;
  c.textAlign = 'left';
  c.textBaseline = 'top';
  c.fillText('Notes:', 6, gt + 5);

  c.fillStyle = '#666';
  c.font = `11px ${FONT}`;
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  for (let v = GRID.labelFrom; v <= GRID.labelTo; v += GRID.labelStep) c.fillText(String(v), gl - 4, valueY(v));

  c.fillStyle = '#222';
  c.font = `12px ${FONT}`;
  LOWER_ROWS.forEach((label, i) => c.fillText(label, gl - 6, lowerTop + (i + 0.5) * lowerRowH + 0.5));

  // Clock times: not printed on paper, generated from the start time and column interval.
  c.textAlign = 'center';
  c.fillStyle = '#333';
  for (let i = 0; i < GRID.columns; i += GRID.dottedEvery) {
    c.font = `${i % GRID.darkEvery === 0 ? '700 ' : ''}11px ${FONT}`;
    c.fillText(timeAt(i), colX(i), HEADER_H / 2 + 1);
  }
}

function inkStyle(c, color) {
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineCap = 'round';
  c.lineJoin = 'round';
}

function strokeWidth(p) {
  return INK_WIDTH * (0.45 + 0.95 * p);
}

// Smooth with quadratic curves through midpoints; draws the piece that ends at point i.
function drawSegment(c, pts, i) {
  const a = pts[i - 1], b = pts[i];
  const ax = unitX(a.x), ay = unitY(a.y), bx = unitX(b.x), by = unitY(b.y);
  let sx = ax, sy = ay;
  if (i > 1) {
    const z = pts[i - 2];
    sx = (unitX(z.x) + ax) / 2;
    sy = (unitY(z.y) + ay) / 2;
  }
  c.lineWidth = strokeWidth((a.p + b.p) / 2);
  c.beginPath();
  c.moveTo(sx, sy);
  c.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2);
  c.stroke();
}

function drawTail(c, pts) {
  const n = pts.length;
  const b = pts[n - 1];
  if (n === 1) {
    c.beginPath();
    c.arc(unitX(b.x), unitY(b.y), strokeWidth(b.p) * 1.1, 0, Math.PI * 2);
    c.fill();
    return;
  }
  const a = pts[n - 2];
  c.lineWidth = strokeWidth(b.p);
  c.beginPath();
  c.moveTo((unitX(a.x) + unitX(b.x)) / 2, (unitY(a.y) + unitY(b.y)) / 2);
  c.lineTo(unitX(b.x), unitY(b.y));
  c.stroke();
}

function renderStroke(c, s, color = s.color || INK_COLOR) {
  inkStyle(c, color);
  for (let i = 1; i < s.pts.length; i++) drawSegment(c, s.pts, i);
  drawTail(c, s.pts);
}

function symbolSize() {
  const hw = Math.max(3.5, Math.min(5.5, L.colW * 0.21));
  return { hw, hh: hw * 1.4 };
}

// Point of the triangle at (x, y); its flat side is dy away (negative = above, so it points down).
function drawTriangle(c, x, y, hw, dy) {
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x - hw, y + dy);
  c.lineTo(x + hw, y + dy);
  c.closePath();
  c.fill();
  c.stroke();
}

// Typed values can lie beyond the scale; plot those on its edge.
const plotY = (v) => valueY(Math.max(GRID.valueMin, Math.min(GRID.valueMax, v)));

// Martin's legend: ▼ with its point at the systolic value, ▲ with its point at the diastolic value, dot for heart rate.
function drawMarks(c, x, v) {
  const { hw, hh } = symbolSize();
  c.lineJoin = 'round';
  c.lineWidth = 1;
  c.fillStyle = BP_COLOR;
  c.strokeStyle = BP_COLOR;
  if (v.sys != null) drawTriangle(c, x, plotY(v.sys), hw, -hh);
  if (v.dia != null) drawTriangle(c, x, plotY(v.dia), hw, hh);
  if (v.hr != null) {
    c.fillStyle = HR_COLOR;
    c.beginPath();
    c.arc(x, plotY(v.hr), 3.3, 0, Math.PI * 2);
    c.fill();
  }
}

function drawSmartMarks(c, skipCol = null) {
  for (const [key, v] of Object.entries(state.data.smart.vitals)) {
    if (Number(key) !== skipCol) drawMarks(c, colX(Number(key)), v);
  }
}

function redrawInk() {
  clearCanvas('ink');
  for (const s of cur().strokes) renderStroke(ctx.ink, s);
  // While a typed time point has unsaved changes, its preview replaces the saved marks.
  if (state.mode !== 'ink') drawSmartMarks(ctx.ink, state.mode === 'typed' && typed.dirty ? typed.col : null);
}

/* ---------- Pencil input ---------- */

function local(e) {
  const r = chartRect || chartEl.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function coalesced(e) {
  if (typeof e.getCoalescedEvents === 'function') {
    const list = e.getCoalescedEvents();
    if (list && list.length) {
      if (list.length > 1) diag.coalescedSeen = true;
      return list;
    }
  }
  return [e];
}

function onPointerDown(e) {
  if (state.mode === 'typed') {
    typedPointerDown(e);
    return;
  }
  // Fingers and palms never draw.
  if (e.pointerType === 'touch') {
    diag.ignored++;
    renderDiag();
    return;
  }
  if (gesture || (e.pointerType === 'mouse' && e.button !== 0)) return;
  chartRect = chartEl.getBoundingClientRect();
  const [x, y] = local(e);
  const region = regionAt(x, y);
  if (!region) {
    chartRect = null;
    return;
  }
  e.preventDefault();
  try { chartEl.setPointerCapture(e.pointerId); } catch (_) { /* capture is optional */ }
  const erasing = tool === 'erase' || (e.buttons & 32) !== 0;
  gesture = {
    id: e.pointerId,
    erasing,
    smart: !erasing && state.mode === 'smart' && region === 'grid',
    pts: [],
    t0: e.timeStamp,
    events: 1,
    samples: 1,
    snapshotTaken: false,
  };
  diag.lastType = e.pointerType;
  clearTimeout(rejectTimer);
  clearCanvas('live');
  if (erasing) {
    eraseAt(x, y);
  } else {
    inkStyle(ctx.live, INK_COLOR);
    addPoint(e, x, y);
  }
  updateOverlay(x, y);
  renderDiag();
}

function addPoint(ev, x, y) {
  const pts = gesture.pts;
  const u = toUnits(x, y);
  const last = pts[pts.length - 1];
  if (last && Math.abs(last.x - u.x) * L.colW < 0.3 && Math.abs(last.y - u.y) * L.rowH < 0.3) return;
  const p = ev.pressure > 0 ? ev.pressure : (last ? last.p : 0.5);
  pts.push({ x: u.x, y: u.y, p });
  if (pts.length > 1) drawSegment(ctx.live, pts, pts.length - 1);
  if (ev.pointerType === 'pen') diag.pressure = ev.pressure;
}

function onPointerMove(e) {
  if (state.mode === 'typed') {
    typedPointerMove(e);
    return;
  }
  if (e.pointerType === 'touch') return;
  if (!gesture) {
    if (e.pointerType === 'pen' && e.buttons === 0 && !diag.hover) {
      diag.hover = true;
      renderDiag();
    }
    const [x, y] = local(e);
    updateOverlay(x, y);
    return;
  }
  if (e.pointerId !== gesture.id) return;
  gesture.events++;
  for (const ev of coalesced(e)) {
    const [x, y] = local(ev);
    if (gesture.erasing) eraseAt(x, y);
    else addPoint(ev, x, y);
    gesture.samples++;
  }
  const [x, y] = local(e);
  updateOverlay(x, y);
  if (!gesture.erasing) drawPrediction(e);
  renderDiag();
}

function endGesture(e) {
  const dur = (e.timeStamp - gesture.t0) / 1000;
  if (dur > 0.25) diag.rate = { events: Math.round(gesture.events / dur), samples: Math.round(gesture.samples / dur) };
  gesture = null;
  chartRect = null;
  clearCanvas('overlay');
  hideReadout();
  updateButtons();
  renderDiag();
}

function endTypedGesture() {
  gesture = null;
  chartRect = null;
  clearCanvas('overlay');
  hideReadout();
}

function onPointerUp(e) {
  if (!gesture || e.pointerId !== gesture.id) return;
  if (gesture.typed) {
    endTypedGesture();
    return;
  }
  if (gesture.erasing) {
    if (gesture.snapshotTaken) save();
  } else {
    finishStroke();
  }
  endGesture(e);
}

function onPointerCancel(e) {
  if (!gesture || e.pointerId !== gesture.id) return;
  if (gesture.typed) {
    endTypedGesture();
    return;
  }
  if (gesture.erasing) {
    if (gesture.snapshotTaken) save();
  } else if (gesture.smart) {
    clearCanvas('live');
  } else {
    finishStroke();
  }
  endGesture(e);
}

function onPointerLeave() {
  if (gesture) return;
  clearCanvas('overlay');
  hideReadout();
}

function finishStroke() {
  const pts = gesture.pts;
  clearCanvas('live');
  if (!pts.length) return;
  if (gesture.smart) {
    interpretSmart(pts);
    return;
  }
  const round = (v, k) => Math.round(v * k) / k;
  const stroke = { color: INK_COLOR, pts: pts.map((q) => ({ x: round(q.x, 1000), y: round(q.y, 1000), p: round(q.p, 100) })) };
  pushUndo();
  cur().strokes.push(stroke);
  renderStroke(ctx.ink, stroke);
  save();
}

function drawPrediction(e) {
  if (typeof e.getPredictedEvents !== 'function') return;
  const list = e.getPredictedEvents();
  const pts = gesture.pts;
  if (!list || !list.length || pts.length < 2) return;
  diag.predictedSeen = true;
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const c = ctx.overlay;
  inkStyle(c, INK_COLOR);
  c.lineWidth = strokeWidth(b.p);
  c.beginPath();
  c.moveTo((unitX(a.x) + unitX(b.x)) / 2, (unitY(a.y) + unitY(b.y)) / 2);
  c.lineTo(unitX(b.x), unitY(b.y));
  for (const pe of list) {
    const [x, y] = local(pe);
    c.lineTo(x, y);
  }
  c.stroke();
}

/* ---------- smart grid ---------- */

// Turns a finished stroke into a measurement, or null if it isn't recognized.
function classify(P, mark) {
  const n = P.length;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let iTop = 0, iBottom = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const { x, y } = P[i];
    sx += x;
    sy += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) { minY = y; iTop = i; }
    if (y > maxY) { maxY = y; iBottom = i; }
  }
  const w = maxX - minX, h = maxY - minY, cx = sx / n, cy = sy / n;
  const tap = Math.max(w, h) <= TAP_PX;

  if (mark === 'hr') return { kind: 'hr', x: cx, y: cy };
  if (mark === 'sys') return tap ? { kind: 'sys', x: cx, y: cy } : { kind: 'sys', x: P[iBottom].x, y: maxY };
  if (mark === 'dia') return tap ? { kind: 'dia', x: cx, y: cy } : { kind: 'dia', x: P[iTop].x, y: minY };

  // V and Λ are checked before taps so that small ones aren't mistaken for dots.
  const first = P[0], last = P[n - 1];
  const inner = (i) => i > 0.1 * (n - 1) && i < 0.9 * (n - 1);
  // Ends far apart sideways: rules out tiny circles drawn as dots.
  const vShaped = h >= 4 && w >= 0.35 * h && w <= 4 * h && Math.abs(last.x - first.x) >= 0.5 * w;
  if (vShaped && inner(iBottom) && maxY - first.y >= 0.55 * h && maxY - last.y >= 0.55 * h) {
    return { kind: 'sys', x: P[iBottom].x, y: maxY };
  }
  if (vShaped && inner(iTop) && first.y - minY >= 0.55 * h && last.y - minY >= 0.55 * h) {
    return { kind: 'dia', x: P[iTop].x, y: minY };
  }
  const tri = closedTriangle(P, minX, maxX, minY, maxY);
  if (tri === 'down') return { kind: 'sys', x: P[iBottom].x, y: maxY };
  if (tri === 'up') return { kind: 'dia', x: P[iTop].x, y: minY };
  if (tap) return { kind: 'hr', x: cx, y: cy };
  if (h >= 10 && h >= 1.6 * w) return { kind: 'bp', x: cx, top: minY, bottom: maxY };
  return null;
}

// A hand-drawn closed triangle: 'down' (▼) or 'up' (▲), else null.
function closedTriangle(P, minX, maxX, minY, maxY) {
  const w = maxX - minX, h = maxY - minY;
  if (w < 5 || h < 4 || w < 0.5 * h || w > 3 * h) return null;
  const first = P[0], last = P[P.length - 1];
  if (Math.hypot(last.x - first.x, last.y - first.y) > 0.4 * Math.max(w, h)) return null;
  let length = 0;
  for (let i = 1; i < P.length; i++) length += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
  if (length < 2 * Math.max(w, h)) return null;
  // The flat side is wide and the point is narrow; a circle is equally wide at both ends.
  const widthBetween = (y0, y1) => {
    let a = Infinity, b = -Infinity;
    for (const p of P) {
      if (p.y < y0 || p.y > y1) continue;
      if (p.x < a) a = p.x;
      if (p.x > b) b = p.x;
    }
    return b > a ? b - a : 0;
  };
  const top = widthBetween(minY, minY + 0.25 * h);
  const bottom = widthBetween(maxY - 0.25 * h, maxY);
  if (top >= 0.5 * w && top >= 1.8 * bottom) return 'down';
  if (bottom >= 0.5 * w && bottom >= 1.8 * top) return 'up';
  return null;
}

let rejectTimer = 0;
function interpretSmart(pts) {
  const P = pts.map((q) => ({ x: unitX(q.x), y: unitY(q.y) }));
  const res = classify(P, state.mark);
  if (!res) {
    renderStroke(ctx.live, { pts }, 'rgba(212, 42, 42, 0.55)');
    clearTimeout(rejectTimer);
    rejectTimer = setTimeout(() => { if (!gesture) clearCanvas('live'); }, 700);
    toast('Not recognized. Tap for heart rate, draw a short vertical line for blood pressure, or draw \u25BC / \u25B2 (V / \u039B also work).', true);
    return;
  }
  const col = snapCol(res.x);
  const fields = {};
  if (res.kind === 'bp') {
    fields.sys = snapValue(yToValue(res.top));
    fields.dia = snapValue(yToValue(res.bottom));
  } else {
    fields[res.kind] = snapValue(yToValue(res.y));
  }
  record(col, fields);
}

function record(col, fields) {
  pushUndo();
  const vit = state.data.smart.vitals;
  const before = vit[col] ? { ...vit[col] } : {};
  const after = { ...before, ...fields };
  vit[col] = after;
  lastChangedCol = col;
  redrawInk();
  renderTable();
  save();
  toast(describe(col, fields, before, after));
}

function describe(col, f, before, after) {
  const t = timeAt(col);
  const dash = '\u2013';
  let msg;
  let was = '';
  if (f.sys != null && f.dia != null) {
    msg = `BP ${f.sys}/${f.dia} at ${t}`;
    if (before.sys != null || before.dia != null) was = ` (was ${before.sys ?? dash}/${before.dia ?? dash})`;
  } else if (f.sys != null) {
    msg = `Systolic ${f.sys} at ${t}`;
    if (before.sys != null) was = ` (was ${before.sys})`;
  } else if (f.dia != null) {
    msg = `Diastolic ${f.dia} at ${t}`;
    if (before.dia != null) was = ` (was ${before.dia})`;
  } else {
    msg = `Heart rate ${f.hr} at ${t}`;
    if (before.hr != null) was = ` (was ${before.hr})`;
  }
  const odd = after.sys != null && after.dia != null && after.sys <= after.dia ? ` ${dash} systolic is not above diastolic` : '';
  return msg + was + odd;
}

/* ---------- erase, undo, clear ---------- */

const boxCache = new WeakMap();
function strokeBox(s) {
  let b = boxCache.get(s);
  if (!b) {
    b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const q of s.pts) {
      if (q.x < b.x0) b.x0 = q.x;
      if (q.x > b.x1) b.x1 = q.x;
      if (q.y < b.y0) b.y0 = q.y;
      if (q.y > b.y1) b.y1 = q.y;
    }
    boxCache.set(s, b);
  }
  return b;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeHit(s, x, y, r) {
  const b = strokeBox(s);
  if (x < unitX(b.x0) - r || x > unitX(b.x1) + r || y < unitY(b.y0) - r || y > unitY(b.y1) + r) return false;
  const pts = s.pts;
  let ax = unitX(pts[0].x), ay = unitY(pts[0].y);
  if (pts.length === 1) return Math.hypot(x - ax, y - ay) <= r;
  for (let i = 1; i < pts.length; i++) {
    const bx = unitX(pts[i].x), by = unitY(pts[i].y);
    if (distToSegment(x, y, ax, ay, bx, by) <= r) return true;
    ax = bx;
    ay = by;
  }
  return false;
}

function markHits(x, y) {
  const { hh } = symbolSize();
  const hits = [];
  for (const [col, v] of Object.entries(state.data.smart.vitals)) {
    const cx = colX(Number(col));
    if (v.sys != null && Math.hypot(x - cx, y - (plotY(v.sys) - hh / 2)) <= ERASER_R + 4) hits.push([col, 'sys']);
    if (v.dia != null && Math.hypot(x - cx, y - (plotY(v.dia) + hh / 2)) <= ERASER_R + 4) hits.push([col, 'dia']);
    if (v.hr != null && Math.hypot(x - cx, y - plotY(v.hr)) <= ERASER_R + 3) hits.push([col, 'hr']);
  }
  return hits;
}

function eraseAt(x, y) {
  const d = cur();
  const strokeIdx = [];
  for (let i = d.strokes.length - 1; i >= 0; i--) if (strokeHit(d.strokes[i], x, y, ERASER_R)) strokeIdx.push(i);
  const marks = state.mode === 'smart' ? markHits(x, y) : [];
  if (!strokeIdx.length && !marks.length) return;
  if (!gesture.snapshotTaken) {
    pushUndo();
    gesture.snapshotTaken = true;
  }
  for (const i of strokeIdx) d.strokes.splice(i, 1);
  for (const [col, field] of marks) {
    const v = d.vitals[col];
    delete v[field];
    if (!hasAnyValue(v)) delete d.vitals[col];
  }
  lastChangedCol = null;
  redrawInk();
  renderTable();
}

const hasAnyValue = (v) => VITAL_FIELDS.some((f) => v[f.key] != null);

// B (smart grid) and C (type it in) work on the same data.
const dataKey = () => (state.mode === 'ink' ? 'ink' : 'smart');

function cur() {
  return state.data[dataKey()];
}

function pushUndo() {
  const d = cur();
  const stack = undoStacks[dataKey()];
  stack.push({ strokes: d.strokes.slice(), vitals: d.vitals ? JSON.parse(JSON.stringify(d.vitals)) : null });
  if (stack.length > 300) stack.shift();
  updateButtons();
}

function undo() {
  // With unsaved typing, Undo first throws that away.
  if (state.mode === 'typed' && typed.dirty) {
    revertDraft();
    return;
  }
  const snap = undoStacks[dataKey()].pop();
  if (!snap) return;
  const d = cur();
  d.strokes = snap.strokes;
  if (snap.vitals) d.vitals = snap.vitals;
  lastChangedCol = null;
  if (state.mode === 'typed') loadDraft();
  redrawInk();
  renderTable();
  renderTyped();
  save();
  updateButtons();
}

function clearAll() {
  const d = cur();
  if (!d.strokes.length && !(d.vitals && Object.keys(d.vitals).length)) return;
  const what = state.mode === 'ink' ? 'drawn in Digital ink' : 'in Smart grid and Type it in (they share the same numbers)';
  if (!window.confirm(`Clear everything ${what}? Undo can bring it back.`)) return;
  pushUndo();
  d.strokes = [];
  if (d.vitals) d.vitals = {};
  lastChangedCol = null;
  if (state.mode === 'typed') loadDraft();
  redrawInk();
  renderTable();
  renderTyped();
  save();
}

/* ---------- overlay, readout, table, status ---------- */

const readoutEl = $('#readout');
function showReadout(x, y, text) {
  if (readoutEl.textContent !== text) readoutEl.textContent = text;
  readoutEl.hidden = false;
  const w = readoutEl.offsetWidth;
  let rx = x - w - 14, ry = y - 34;
  if (rx < 4) rx = x + 16;
  if (ry < 2) ry = y + 18;
  readoutEl.style.transform = `translate(${Math.round(rx)}px, ${Math.round(ry)}px)`;
}
function hideReadout() {
  readoutEl.hidden = true;
}

function updateOverlay(x, y) {
  const c = ctx.overlay;
  clearCanvas('overlay');
  if (state.mode === 'typed') {
    // Hover (Pencil or mouse): show which time a tap would pick.
    if (gesture || !overTimeColumns(x, y)) {
      hideReadout();
      return;
    }
    const sx = colX(snapCol(x));
    c.save();
    c.strokeStyle = 'rgba(245, 158, 11, 0.35)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(sx, L.gridTop);
    c.lineTo(sx, L.lowerBottom);
    c.stroke();
    c.restore();
    showReadout(x, y, `${timeAt(snapCol(x))} \u00b7 tap to pick`);
    return;
  }
  const erasing = gesture ? gesture.erasing : tool === 'erase';
  if (erasing) {
    hideReadout();
    if (!gesture && !regionAt(x, y)) return;
    c.save();
    c.setLineDash([3, 3]);
    c.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    c.lineWidth = 1.2;
    c.beginPath();
    c.arc(x, y, ERASER_R, 0, Math.PI * 2);
    c.stroke();
    c.restore();
    return;
  }
  const smartHere = state.mode === 'smart' && (gesture ? gesture.smart : regionAt(x, y) === 'grid');
  if (!smartHere) {
    hideReadout();
    return;
  }
  // Show where the mark will snap: the time line and the value.
  const col = snapCol(x);
  const v = snapValue(yToValue(y));
  const sx = colX(col), sy = valueY(v);
  c.save();
  c.strokeStyle = 'rgba(245, 158, 11, 0.35)';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(sx, L.gridTop);
  c.lineTo(sx, L.gridBottom);
  c.stroke();
  c.strokeStyle = '#f59e0b';
  c.lineWidth = 1.5;
  c.beginPath();
  c.arc(sx, sy, 6, 0, Math.PI * 2);
  c.stroke();
  c.restore();
  let text = `${timeAt(col)} \u00b7 ${v}`;
  if (gesture && state.mark === 'auto' && gesture.pts.length > 1) {
    const v0 = snapValue(yToValue(unitY(gesture.pts[0].y)));
    if (Math.abs(valueY(v0) - sy) >= 10) text = `${timeAt(col)} \u00b7 ${Math.max(v0, v)}/${Math.min(v0, v)}`;
  }
  showReadout(x, y, text);
}

function renderTable() {
  const el = $('#vtable');
  if (!L || state.mode === 'ink') {
    el.innerHTML = '';
    return;
  }
  const vit = state.data.smart.vitals;
  const cols = Object.keys(vit).map(Number).sort((a, b) => a - b);
  const parts = [
    `<div class="labels" style="width:${Math.round(L.gridLeft - L.colW / 2 - 6)}px">` +
      `<span class="t">Time</span>${VITAL_FIELDS.map((f) => `<span>${f.label}</span>`).join('')}</div>`,
  ];
  let prevHour = null;
  for (const col of cols) {
    const v = vit[col];
    const t = timeAt(col);
    // Columns are narrow: write the hour only when it changes (08:00, :05, :10 ... 09:00).
    const label = t.slice(0, 2) === prevHour ? t.slice(2) : t;
    prevHour = t.slice(0, 2);
    parts.push(
      `<div class="vcol${col === lastChangedCol ? ' fresh' : ''}" style="left:${(colX(col) - L.colW / 2).toFixed(1)}px;width:${L.colW.toFixed(1)}px">` +
        `<span class="t">${label}</span>${VITAL_FIELDS.map((f) => `<span class="${f.key}">${v[f.key] ?? ''}</span>`).join('')}</div>`,
    );
  }
  if (!cols.length) {
    const how = state.mode === 'typed' ? 'Values you type' : 'Marks you draw on the grid';
    parts.push(`<div class="empty" style="left:${Math.round(L.gridLeft + 8)}px">${how} show up here as numbers, under their time.</div>`);
  }
  el.innerHTML = parts.join('');
}

let toastTimer = 0;
function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 2600 : 1600);
}

let diagFrame = 0;
function renderDiag() {
  if (diagFrame) return;
  diagFrame = requestAnimationFrame(() => {
    diagFrame = 0;
    const yesNo = (supported, seen) => (supported ? (seen ? 'yes' : 'supported') : 'no');
    const line1 = [`Finger/palm touches ignored: ${diag.ignored}`, `last input: ${diag.lastType}`];
    if (diag.pressure != null) line1.push(`pressure ${diag.pressure.toFixed(2)}`);
    const line2 = [];
    if (diag.rate) line2.push(`${diag.rate.samples} samples/s`);
    line2.push(`coalesced ${yesNo(supports.coalesced, diag.coalescedSeen)}`);
    line2.push(`predicted ${yesNo(supports.predicted, diag.predictedSeen)}`);
    line2.push(`Pencil hover ${diag.hover ? 'yes' : 'not seen'}`);
    $('#diag1').textContent = line1.join(' \u00b7 ');
    $('#diag2').textContent = line2.join(' \u00b7 ');
  });
}

const HINTS = {
  ink: 'Only the Pencil draws; fingers and palms leave no marks.',
  auto: 'Tap = heart rate \u00b7 short vertical line = BP \u00b7 or draw \u25BC / \u25B2 (V / \u039B also work)',
  sys: 'Every mark is a systolic value (tap, or the point of a \u25BC or V)',
  dia: 'Every mark is a diastolic value (tap, or the point of a \u25B2 or \u039B)',
  hr: 'Every mark is a heart rate',
  typed: 'Tap a time, enter the numbers, then Save. Keyboard: digits, Tab, Enter, arrow keys.',
};

function updateButtons() {
  $('#undoBtn').disabled = undoStacks[dataKey()].length === 0 && !(state.mode === 'typed' && typed.dirty);
  $('#hint').textContent = state.mode === 'smart' ? HINTS[state.mark] : HINTS[state.mode];
}

/* ---------- controls ---------- */

function setSegment(segSel, attr, value) {
  for (const b of document.querySelectorAll(`${segSel} button`)) b.classList.toggle('on', b.dataset[attr] === value);
}

function setMode(mode) {
  if (L && mode === state.mode) return;
  if (state.mode === 'typed' && mode !== 'typed' && typed.dirty && !commitDraft()) {
    loadDraft();
    toast('Unsaved values were not valid, so they were discarded', true);
  }
  state.mode = mode;
  document.body.dataset.mode = mode;
  setSegment('#modeSeg', 'mode', mode);
  lastChangedCol = null;
  typed.col = null;
  updateButtons();
  if (L) {
    applyLayout();
    if (mode === 'typed') selectNow();
  }
  save();
}

function setTool(t) {
  tool = t;
  setSegment('#toolSeg', 'tool', t);
}

function setMark(m) {
  state.mark = m;
  setSegment('#markSeg', 'mark', m);
  updateButtons();
  save();
}

function fillSelect(sel, values, current, label) {
  const list = [...new Set([...values, current])].sort((a, b) => a - b);
  sel.innerHTML = list.map((v) => `<option value="${v}"${v === current ? ' selected' : ''}>${label(v)}</option>`).join('');
}

function formatSpan(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

function initControls() {
  $('#modeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
  $('#toolSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); });
  $('#markSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMark(b.dataset.mark); });
  $('#undoBtn').addEventListener('click', undo);
  $('#clearBtn').addEventListener('click', clearAll);

  const colSel = $('#colSel');
  fillSelect(colSel, COLUMN_MINUTE_CHOICES, state.minutesPerColumn, (v) => `${v} min`);
  colSel.addEventListener('change', () => {
    state.minutesPerColumn = Number(colSel.value);
    drawBackground();
    renderTable();
    renderTyped();
    save();
    toast(`Each column is now ${state.minutesPerColumn} min; the grid covers ${formatSpan(GRID.columns * state.minutesPerColumn)}`);
  });

  const snapSel = $('#snapSel');
  fillSelect(snapSel, SNAP_CHOICES, state.snap, (v) => `nearest ${v}`);
  snapSel.addEventListener('change', () => {
    state.snap = Number(snapSel.value);
    save();
  });

  const startInput = $('#startInput');
  startInput.value = state.start;
  startInput.addEventListener('change', () => {
    if (/^\d\d:\d\d/.test(startInput.value)) setStart(startInput.value.slice(0, 5));
  });

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (state.mode === 'typed') typedKeydown(e);
  });

  chartEl.addEventListener('pointerdown', onPointerDown);
  chartEl.addEventListener('pointermove', onPointerMove);
  chartEl.addEventListener('pointerup', onPointerUp);
  chartEl.addEventListener('pointercancel', onPointerCancel);
  chartEl.addEventListener('pointerleave', onPointerLeave);
  // Stop Safari from scrolling, zooming, selecting or starting Scribble on the chart.
  for (const type of ['touchstart', 'touchmove', 'touchend']) {
    chartEl.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  chartEl.addEventListener('contextmenu', (e) => e.preventDefault());

  let resizeTimer = 0;
  const relayout = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyLayout, 120);
  };
  window.addEventListener('resize', relayout);
  if (typeof ResizeObserver !== 'undefined') {
    // The bars can wrap after first layout (e.g. when status text fills in); refit the chart.
    const heights = new Map();
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const en of entries) {
        const h = Math.round(en.contentRect.height);
        if (heights.has(en.target) && heights.get(en.target) !== h) changed = true;
        heights.set(en.target, h);
      }
      if (changed) relayout();
    });
    for (const el of [$('.bar.top'), $('.bar.tools'), $('#below')]) ro.observe(el);
  }

  initTyped();
  initPhoto();
}

function setStart(value) {
  state.start = value;
  $('#startInput').value = value;
  drawBackground();
  renderTable();
  renderTyped();
  save();
}

/* ---------- C: type it in ---------- */

// The time point being edited; draft holds the typed strings until they are saved.
const typed = { col: null, field: 'sys', draft: {}, dirty: false, replace: true, autoAdvanced: false, notice: false };

function overTimeColumns(x, y) {
  return x >= L.gridLeft - L.colW && x <= L.gridRight + L.colW && y >= 0 && y <= L.lowerBottom;
}

// Any finger, Pencil or mouse tap on the chart picks the time.
function typedPointerDown(e) {
  if (gesture || (e.pointerType === 'mouse' && e.button !== 0)) return;
  chartRect = chartEl.getBoundingClientRect();
  const [x, y] = local(e);
  if (!overTimeColumns(x, y)) {
    chartRect = null;
    return;
  }
  e.preventDefault();
  try { chartEl.setPointerCapture(e.pointerId); } catch (_) { /* capture is optional */ }
  gesture = { id: e.pointerId, typed: true };
  diag.lastType = e.pointerType;
  renderDiag();
  clearCanvas('overlay');
  hideReadout();
  selectCol(snapCol(x));
}

function typedPointerMove(e) {
  const [x, y] = local(e);
  if (gesture) {
    // Sliding along the chart moves the selected time.
    if (gesture.typed && e.pointerId === gesture.id) selectCol(snapCol(x));
    return;
  }
  if (e.pointerType !== 'touch') updateOverlay(x, y);
}

function storedString(col, key) {
  const v = state.data.smart.vitals[col];
  return v && v[key] != null ? String(v[key]) : '';
}

function setField(key) {
  typed.field = key;
  typed.replace = true;   // the first digit typed replaces what's there
  typed.autoAdvanced = false;
}

function loadDraft() {
  typed.draft = {};
  for (const f of VITAL_FIELDS) typed.draft[f.key] = storedString(typed.col, f.key);
  typed.dirty = false;
  setField((VITAL_FIELDS.find((f) => !typed.draft[f.key]) || VITAL_FIELDS[0]).key);
}

function updateDirty() {
  typed.dirty = VITAL_FIELDS.some((f) => typed.draft[f.key] !== storedString(typed.col, f.key));
}

// Column of the current time slot; it may lie off the chart.
function nowCol() {
  const d = new Date();
  let diff = d.getHours() * 60 + d.getMinutes() - startMinutes();
  if (diff < 0) diff += 24 * 60;
  return Math.floor(diff / state.minutesPerColumn);
}

function selectNow() {
  const col = nowCol();
  const onChart = col <= GRID.columns;
  let target = col;
  if (!onChart) {
    // Fall back to the slot after the last values, and offer to move the chart to now.
    const used = Object.keys(state.data.smart.vitals).map(Number);
    target = typed.col ?? (used.length ? Math.max(...used) + 1 : 0);
  }
  if (selectCol(target, { keepNotice: true })) {
    typed.notice = !onChart;
    renderTyped();
  }
}

function selectCol(col, { keepNotice = false } = {}) {
  col = Math.max(0, Math.min(GRID.columns, col));
  if (!keepNotice) typed.notice = false;
  if (col !== typed.col) {
    if (typed.dirty && !commitDraft()) return false;   // unsaved values are saved before moving on
    typed.col = col;
    loadDraft();
  }
  renderTyped();
  return true;
}

function typeKey(k) {
  if (typed.col == null) return;
  const i = VITAL_FIELDS.findIndex((f) => f.key === typed.field);
  const f = VITAL_FIELDS[i];
  if (/^\d$/.test(k)) {
    let s = typed.replace ? '' : typed.draft[f.key];
    if (s.length >= f.len) return;
    s = s === '0' ? k : s + k;
    typed.draft[f.key] = s;
    typed.replace = false;
    typed.autoAdvanced = false;
    // A full field moves on by itself, except from the last one.
    if (s.length === f.len && i < VITAL_FIELDS.length - 1) {
      setField(VITAL_FIELDS[i + 1].key);
      typed.autoAdvanced = true;
    }
  } else if (k === 'back' || k === 'clear') {
    typed.draft[f.key] = k === 'back' && !typed.replace ? typed.draft[f.key].slice(0, -1) : '';
    typed.replace = false;
    typed.autoAdvanced = false;
  } else if (k === 'next' || k === 'prev') {
    // Next straight after an automatic move would skip a field ("120", Next must land on Dia).
    if (k === 'next' && typed.autoAdvanced) typed.autoAdvanced = false;
    else setField(VITAL_FIELDS[(i + (k === 'next' ? 1 : VITAL_FIELDS.length - 1)) % VITAL_FIELDS.length].key);
  }
  updateDirty();
  renderTyped();
}

function draftValues() {
  const v = {};
  for (const f of VITAL_FIELDS) if (typed.draft[f.key]) v[f.key] = Number(typed.draft[f.key]);
  return v;
}

function commitDraft() {
  if (typed.col == null || !typed.dirty) return true;
  for (const f of VITAL_FIELDS) {
    const s = typed.draft[f.key];
    if (s && (Number(s) < f.min || Number(s) > f.max)) {
      setField(f.key);
      renderTyped();
      toast(`${f.label} must be between ${f.min} and ${f.max}`, true);
      return false;
    }
  }
  const after = draftValues();
  const vit = state.data.smart.vitals;
  pushUndo();
  if (hasAnyValue(after)) vit[typed.col] = after;
  else delete vit[typed.col];
  typed.dirty = false;
  lastChangedCol = typed.col;
  renderTable();
  renderTyped();
  save();
  toast(savedMessage(typed.col, after));
  return true;
}

function saveDraft() {
  if (typed.dirty) commitDraft();
  else toast('No changes to save');
}

function savedMessage(col, v) {
  const t = timeAt(col);
  if (!hasAnyValue(v)) return `Removed all values at ${t}`;
  const dash = '\u2013';
  const parts = [];
  if (v.sys != null || v.dia != null) parts.push(`BP ${v.sys ?? dash}/${v.dia ?? dash}`);
  for (const f of VITAL_FIELDS.slice(2)) if (v[f.key] != null) parts.push(`${f.key === 'hr' ? 'HR' : f.label} ${v[f.key]}`);
  const odd = v.sys != null && v.dia != null && v.sys <= v.dia ? ` ${dash} systolic is not above diastolic` : '';
  return `Saved ${t}: ${parts.join(' \u00b7 ')}${odd}`;
}

function revertDraft() {
  if (!typed.dirty) return;
  loadDraft();
  renderTyped();
  toast('Unsaved changes discarded');
}

function deleteTimePoint() {
  const vit = state.data.smart.vitals;
  if (!vit[typed.col]) {
    revertDraft();
    return;
  }
  pushUndo();
  delete vit[typed.col];
  lastChangedCol = null;
  loadDraft();
  renderTable();
  renderTyped();
  save();
  toast(`Deleted everything at ${timeAt(typed.col)} (Undo brings it back)`);
}

function startChartNow() {
  const start = $('#tpStartNow').dataset.start;
  const d = state.data.smart;
  const hasData = Object.keys(d.vitals).length || d.strokes.length;
  if (hasData && !window.confirm(`Start the chart at ${start}? Values already on it keep their columns, so their times move too.`)) return;
  if (typed.dirty && !commitDraft()) return;
  setStart(start);
  selectNow();
}

function renderTyped() {
  const panel = $('#typePanel');
  if (state.mode !== 'typed' || !L || typed.col == null) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const saved = !!state.data.smart.vitals[typed.col];
  $('#tpTime').textContent = timeAt(typed.col);
  const status = $('#tpStatus');
  status.textContent = typed.dirty ? 'Unsaved changes' : saved ? 'Saved' : 'Nothing saved yet';
  status.classList.toggle('dirty', typed.dirty);
  for (const b of document.querySelectorAll('#tpFields button')) {
    const key = b.dataset.field;
    const s = typed.draft[key] || '';
    b.querySelector('b').textContent = s || '\u2013';
    b.classList.toggle('active', key === typed.field);
    b.classList.toggle('replace', key === typed.field && typed.replace && s !== '');
    b.classList.toggle('changed', s !== storedString(typed.col, key));
  }
  $('#tpSave').disabled = !typed.dirty;
  $('#tpDelete').disabled = !saved && !typed.dirty;
  renderNotice();
  placePanel();
  updateButtons();
  redrawInk();
  drawSelection();
}

function renderNotice() {
  $('#tpNotice').hidden = !typed.notice;
  if (!typed.notice) return;
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  $('#tpNoticeText').textContent = `${hh}:${String(d.getMinutes()).padStart(2, '0')} is not on this chart (${timeAt(0)}\u2013${timeAt(GRID.columns)}).`;
  const btn = $('#tpStartNow');
  btn.dataset.start = `${hh}:00`;
  btn.textContent = `Start at ${hh}:00`;
}

// Dock on the side away from the selected time so the panel never hides it.
function placePanel() {
  const panel = $('#typePanel');
  const w = Math.round(Math.min(340, Math.max(270, L.cssW * 0.27)));
  const dockLeft = colX(typed.col) > L.cssW * 0.55;
  const h = Math.min(L.cssH - 8, 600);
  panel.style.width = `${w}px`;
  panel.style.height = `${Math.round(h)}px`;
  panel.style.left = `${dockLeft ? 4 : Math.round(L.cssW - w - 4)}px`;
  panel.classList.toggle('compact', h < 470);
}

function drawSelection() {
  clearCanvas('live');
  const c = ctx.live;
  const x = colX(typed.col);
  c.save();
  c.fillStyle = 'rgba(245, 158, 11, 0.14)';
  c.fillRect(x - L.colW / 2, L.gridTop, L.colW, L.lowerBottom - L.gridTop);
  c.strokeStyle = 'rgba(217, 119, 6, 0.85)';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(x, L.gridTop);
  c.lineTo(x, L.lowerBottom);
  c.stroke();
  const label = timeAt(typed.col);
  c.font = `700 11px ${FONT}`;
  const w = c.measureText(label).width + 10;
  c.fillStyle = '#d97706';
  c.fillRect(x - w / 2, 2, w, HEADER_H - 4);
  c.fillStyle = '#fff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(label, x, HEADER_H / 2 + 0.5);
  if (typed.dirty) {
    c.globalAlpha = 0.5;
    drawMarks(c, x, draftValues());
  }
  c.restore();
}

function typedKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || typed.col == null || !$('#photoModal').hidden) return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const k = e.key;
  if (/^\d$/.test(k)) typeKey(k);
  else if (k === 'Backspace') typeKey('back');
  else if (k === 'Delete') typeKey('clear');
  else if (k === 'Tab') typeKey(e.shiftKey ? 'prev' : 'next');
  else if (k === '/' || k === ' ' || k === 'ArrowDown') typeKey('next');
  else if (k === 'ArrowUp') typeKey('prev');
  else if (k === 'Enter') saveDraft();
  else if (k === 'Escape') revertDraft();
  else if (k === 'ArrowLeft') selectCol(typed.col - 1);
  else if (k === 'ArrowRight') selectCol(typed.col + 1);
  else return;
  e.preventDefault();
}

function initTyped() {
  $('#typePanel').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.key) typeKey(b.dataset.key);
    else if (b.dataset.field) {
      setField(b.dataset.field);
      renderTyped();
    } else if (b.dataset.step) selectCol(typed.col + Number(b.dataset.step));
    else if (b.id === 'tpNow') selectNow();
    else if (b.id === 'tpSave') saveDraft();
    else if (b.id === 'tpDelete') deleteTimePoint();
    else if (b.id === 'tpStartNow') startChartNow();
    b.blur();   // leave Enter and Space to the number entry
  });
}

/* ---------- photo of the monitor ---------- */

function initPhoto() {
  const input = $('#photoInput');
  const modal = $('#photoModal');
  const img = $('#photoImg');
  const caption = $('#photoCaption');
  let url = null;
  let takenAt = '';
  let sizeText = '';

  const open = () => { modal.hidden = false; };
  const close = () => { modal.hidden = true; };

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(file);
    takenAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    sizeText = `${(file.size / 1e6).toFixed(1)} MB`;
    caption.textContent = `Taken ${takenAt} \u00b7 ${sizeText} \u00b7 stays on this iPad, nothing is uploaded`;
    img.src = url;
    $('#thumbBtn img').src = url;
    $('#thumbBtn').hidden = false;
    input.value = '';
    open();
  });
  img.addEventListener('load', () => {
    caption.textContent = `Taken ${takenAt} \u00b7 ${img.naturalWidth}\u00d7${img.naturalHeight}, ${sizeText} \u00b7 stays on this iPad, nothing is uploaded`;
  });
  $('#thumbBtn').addEventListener('click', open);
  $('#photoClose').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
}

/* ---------- start ---------- */

load();
initControls();
setSegment('#markSeg', 'mark', state.mark);
setMode(state.mode);
applyLayout();
if (state.mode === 'typed') selectNow();
renderDiag();
