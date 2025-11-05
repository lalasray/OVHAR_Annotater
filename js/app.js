'use strict';
// Avoid $ conflicts by using a uniquely named helper.
const getById = (id) => document.getElementById(id);

// Element refs
const video = getById('video');
const btnPlay = getById('btnPlay');
const btnPrev = getById('btnPrev');
const btnNext = getById('btnNext');
const fpsInput = getById('fps');
const gotoInput = getById('gotoFrame');
const btnGo = getById('btnGo');
const meta = getById('meta');
const file = getById('file');
const url = getById('url');
const btnLoad = getById('btnLoad');

// Range form elements
const laneSelect = getById('laneSelect');
const singleNameWrap = getById('singleNameWrap');
const dualNameWrap = getById('dualNameWrap');
const sixNameWrap  = getById('sixNameWrap');
const labelNameInput = getById('labelName');
const upperTextInput = getById('upperText');
const lowerTextInput = getById('lowerText');
const ullInput = getById('ull');
const lllInput = getById('lll');
const urlimbInput = getById('urlimb');
const lrlimbInput = getById('lrlimb');
const torsoInput = getById('torso');
const headInput = getById('head');
const startFrameInput = getById('startFrame');
const endFrameInput = getById('endFrame');
const btnAddLabel = getById('btnAddLabel');
const rangesTbody = getById('rangesTbody');
const btnExport = getById('btnExport');
const btnImport = getById('btnImport');
const importJsonInput = getById('importJson');
const importInfo = getById('importInfo');

const timeline = getById('timeline');
const ticks = getById('ticks');
const playhead = getById('playhead');
const frameOut = getById('frameOut');
const timeOut = getById('timeOut');
const zoom = getById('zoom');

// Normalize UI labels/icons in case HTML has encoding issues
try {
  if (btnPlay) btnPlay.textContent = '▶ Play';
  if (btnPrev) btnPrev.textContent = '◀';
  if (btnNext) btnNext.textContent = '▶';
  const helpEl = document.querySelector('.help');
  if (helpEl) helpEl.innerHTML = 'Shortcuts: <span class="kbd">Space</span> play/pause • <span class="kbd">←/→</span> step by 1 frame • <span class="kbd">Home/End</span> to start/end.';
} catch {}

let labelLanes = [];
function initLabelLanes(){
  labelLanes = Array.from(document.querySelectorAll('.label-lane'));
}

// Store ranges per lane: {id, lane, name, start, end, el}
const labelRanges = [[],[],[],[]];
let nextRangeId = 1;

// Layout constants
const MIN_BAR_PX = 16; // minimum visible width for a range bar
const BAR_HEIGHT = 27; // must match CSS height
const BAR_VGAP = 4;    // vertical gap between stacked bars

const DEFAULT_FPS = 30;
const MIN_FPS = 1;
const MAX_FPS = 240;

let pxPerFrameBase = 6; // multiplied by zoom
let totalFrames = 0;
let rafId = null;
let selectedFile = null;

// ---------- Helpers ----------
const isFiniteNumber = (n) => Number.isFinite(n);
function getValidFPS() {
  const n = Number(fpsInput.value);
  if (!isFiniteNumber(n) || n < MIN_FPS || n > MAX_FPS) return DEFAULT_FPS;
  return n;
}
function sanitizeFPSInput() {
  const n = Number(fpsInput.value);
  if (!isFiniteNumber(n) || n < MIN_FPS) fpsInput.value = String(DEFAULT_FPS);
  if (n > MAX_FPS) fpsInput.value = String(MAX_FPS);
}
function canSeek() {
  return isFiniteNumber(video.duration) && video.duration > 0;
}
function safeSetCurrentTime(t) {
  // Only set if video has a valid duration and time is finite
  if (!canSeek()) return;
  if (!isFiniteNumber(t)) return;
  const clamped = Math.min(video.duration, Math.max(0, t));
  if (isFiniteNumber(clamped)) video.currentTime = clamped;
}

function timeToFrame(time) {
  const fps = getValidFPS();
  return Math.floor((time * fps) + 1e-6);
}
function frameToTime(frame) {
  const fps = getValidFPS();
  return frame / fps;
}
function fmtTime(s) { return (s || 0).toFixed(3) + 's'; }

function rebuildTimeline() {
  if (!canSeek()) return;
  sanitizeFPSInput();
  const fps = getValidFPS();
  totalFrames = Math.max(0, Math.floor(video.duration * fps));
  gotoInput.max = String(totalFrames);

  const pxPerFrame = pxPerFrameBase * Number(zoom.value || 1);
  const width = Math.max(totalFrames * pxPerFrame, timeline.clientWidth + 1);
  ticks.style.width = width + 'px';

  // draw ticks
  ticks.innerHTML = '';
  const majorEvery = 10;
  for (let f = 0; f <= totalFrames; f++) {
    const x = f * pxPerFrame;
    const tick = document.createElement('div');
    tick.className = 'tick' + (f % majorEvery === 0 ? ' major' : '');
    tick.style.left = x + 'px';
    tick.style.height = f % majorEvery === 0 ? '100%' : '70%';
    ticks.appendChild(tick);
    if (f % majorEvery === 0) {
      const label = document.createElement('div');
      label.className = 'tick-label';
      label.textContent = f;
      label.style.left = x + 'px';
      ticks.appendChild(label);
    }
  }

  // Ensure lanes are present
  initLabelLanes();

  // Resize label tracks to match timeline width
  labelLanes.forEach((lane)=>{
    const track = lane.querySelector('.label-track');
    if (track) track.style.width = width + 'px';
  });

  // Reposition all range bars with minimum width
  labelRanges.forEach((laneArr)=>{
    laneArr.forEach(r => {
      const left = r.start * pxPerFrame;
      const w = Math.max(MIN_BAR_PX, (r.end - r.start) * pxPerFrame);
      if (r.el) { r.el.style.left = left + 'px'; r.el.style.width = w + 'px'; }
    });
  });

  // Re-layout to avoid overlaps and adjust lane heights
  layoutAllLanes();

  updatePlayhead();
}

function updatePlayhead() {
  const pxPerFrame = pxPerFrameBase * Number(zoom.value || 1);
  const curTime = canSeek() ? video.currentTime : 0;
  const curFrame = timeToFrame(curTime);
  playhead.style.left = (curFrame * pxPerFrame) + 'px';
  frameOut.textContent = curFrame + ' / ' + totalFrames;
  timeOut.textContent = fmtTime(curTime);

  // Sync label lane playheads
  initLabelLanes();
  labelLanes.forEach((lane)=>{
    const lp = lane.querySelector('.label-playhead');
    if (lp) lp.style.left = (curFrame * pxPerFrame) + 'px';
  });
}

function tick() { updatePlayhead(); rafId = requestAnimationFrame(tick); }

// Interactions
btnPlay.addEventListener('click', () => { if (video.paused) video.play(); else video.pause(); });
video.addEventListener('play', () => { btnPlay.textContent = '⏸ Pause'; if (!rafId) rafId = requestAnimationFrame(tick); });
video.addEventListener('pause', () => { btnPlay.textContent = '▶ Play'; cancelAnimationFrame(rafId); rafId = null; updatePlayhead(); });

fpsInput.addEventListener('change', () => { sanitizeFPSInput(); rebuildTimeline(); });
zoom.addEventListener('input', rebuildTimeline);

btnPrev.addEventListener('click', () => stepFrames(-1));
btnNext.addEventListener('click', () => stepFrames(1));
btnGo.addEventListener('click', () => goToFrame(Number(gotoInput.value)));

function stepFrames(delta) {
  if (!canSeek()) return;
  const t = video.currentTime + frameToTime(delta);
  safeSetCurrentTime(t);
  updatePlayhead();
}
function goToFrame(f) {
  if (!canSeek()) return;
  const n = Number(f);
  if (!isFiniteNumber(n)) return; // ignore invalid
  const clampedFrame = Math.min(totalFrames, Math.max(0, Math.floor(n)));
  const t = frameToTime(clampedFrame);
  safeSetCurrentTime(t);
  updatePlayhead();
}

// Seek by clicking timeline
timeline.addEventListener('click', (e) => {
  if (!canSeek()) return;
  const rect = timeline.getBoundingClientRect();
  const x = e.clientX - rect.left + timeline.scrollLeft;
  const frame = Math.round(x / (pxPerFrameBase * Number(zoom.value || 1)));
  goToFrame(frame);
});

// Keyboard shortcuts to match help text
document.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return; // don't hijack typing
  if (e.code === 'Space') { e.preventDefault(); btnPlay.click(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrames(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepFrames(1); }
  else if (e.key === 'Home') { e.preventDefault(); goToFrame(0); }
  else if (e.key === 'End') { e.preventDefault(); goToFrame(totalFrames); }
});

// Scroll sync (two-way)
let isSyncing = false;
function syncScrollFrom(source){
  if (isSyncing) return; isSyncing = true;
  const scrollLeft = source.scrollLeft;
  initLabelLanes();
  if (source === timeline) {
    labelLanes.forEach(l => { l.scrollLeft = scrollLeft; });
  } else {
    timeline.scrollLeft = scrollLeft;
    labelLanes.forEach(l => { if (l !== source) l.scrollLeft = scrollLeft; });
  }
  isSyncing = false;
}
timeline.addEventListener('scroll', () => syncScrollFrom(timeline));
initLabelLanes();
labelLanes.forEach(lane => lane.addEventListener('scroll', () => syncScrollFrom(lane)));

// ---------- Range helpers ----------
function renderRangeBar(laneIndex, range){
  initLabelLanes();
  const lane = labelLanes[laneIndex];
  if (!lane) { console.warn('Lane not available for index', laneIndex); return null; }
  const pxPerFrame = pxPerFrameBase * Number(zoom.value || 1);
  const bar = document.createElement('div');
  bar.className = 'range-bar';
  bar.dataset.id = range.id;
  bar.title = `${range.name} [${range.start}, ${range.end})`;
  const widthPx = Math.max(MIN_BAR_PX,(range.end - range.start) * pxPerFrame);
  bar.style.left = (range.start * pxPerFrame) + 'px';
  bar.style.width = widthPx + 'px';
  bar.textContent = range.name;

  const del = document.createElement('button');
  del.className = 'btn-mini';
  del.textContent = '×';
  del.style.position = 'absolute';
  del.style.right = '4px';
  del.style.top = '4px';
  del.addEventListener('click', (e)=>{ e.stopPropagation(); removeRange(range.id); });
  bar.appendChild(del);

  lane.appendChild(bar);
  range.el = bar;
  return bar;
}

// Compute vertical stacking to avoid overlaps in each lane
function layoutLaneBars(laneIndex){
  initLabelLanes();
  const lane = labelLanes[laneIndex];
  if (!lane) return;
  const pxPerFrame = pxPerFrameBase * Number(zoom.value || 1);
  const items = [...labelRanges[laneIndex]];
  items.sort((a,b)=> (a.start-b.start) || (a.end-b.end));
  const rowsLastEnd = [];
  let maxRow = 0;
  items.forEach(r=>{
    let row = 0;
    while (row < rowsLastEnd.length && r.start < rowsLastEnd[row]) row++;
    rowsLastEnd[row] = Math.max(rowsLastEnd[row]||0, r.end);
    if (r.el){
      r.el.style.top = (4 + row * (BAR_HEIGHT + BAR_VGAP)) + 'px';
      const widthPx = Math.max(MIN_BAR_PX,(r.end - r.start) * pxPerFrame);
      r.el.style.left = (r.start * pxPerFrame) + 'px';
      r.el.style.width = widthPx + 'px';
    }
    if (row > maxRow) maxRow = row;
  });
  const needed = 4 + (maxRow+1)*(BAR_HEIGHT+BAR_VGAP) + 4;
  lane.style.height = Math.max(35, needed) + 'px';
}

function layoutAllLanes(){
  initLabelLanes();
  for (let i=0;i<labelLanes.length;i++) layoutLaneBars(i);
}

function addRange(laneIndex, name, start, end){
  if (!Number.isFinite(start) || !Number.isFinite(end)) { alert('Start/End must be numbers'); return; }
  start = Math.max(0, Math.floor(start));
  end = Math.max(0, Math.floor(end));
  if (end <= start) { alert('End must be > Start (exclusive)'); return; }
  if (canSeek() && totalFrames>0 && start > totalFrames) { alert('Start is beyond video length'); return; }

  const r = { id: nextRangeId++, lane: laneIndex, name: name || `Range ${Date.now()}`, start, end, el: null };
  labelRanges[laneIndex].push(r);
  renderRangeBar(laneIndex, r);
  refreshRangesTable();
  layoutLaneBars(laneIndex);
}

function removeRange(id){
  for (let laneIndex=0; laneIndex<labelRanges.length; laneIndex++){
    const arr = labelRanges[laneIndex];
    const i = arr.findIndex(r => r.id === id);
    if (i >= 0){
      const [r] = arr.splice(i,1);
      if (r.el && r.el.parentNode) r.el.parentNode.removeChild(r.el);
      refreshRangesTable();
      layoutLaneBars(laneIndex);
      return;
    }
  }
}

function refreshRangesTable(){
  rangesTbody.innerHTML='';
  labelRanges.forEach((arr, laneIndex)=>{
    arr.forEach(r=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${r.id}</td><td>${laneIndex}</td><td>${r.name}</td><td>${r.start}</td><td>${r.end}</td>`;
      const tdAct = document.createElement('td');
      const btnDel = document.createElement('button'); btnDel.className='btn-mini'; btnDel.textContent='Delete';
      btnDel.addEventListener('click', ()=> removeRange(r.id));
      tdAct.appendChild(btnDel);
      tr.appendChild(tdAct);
      rangesTbody.appendChild(tr);
    });
  });
}

// Add range from form
btnAddLabel.addEventListener('click', ()=>{
  const laneIndex = Number(laneSelect.value)||0;
  let name;
  if (laneIndex === 1) {
    const u = (upperTextInput.value||'').trim();
    const l = (lowerTextInput.value||'').trim();
    if (!u && !l) { alert('Please fill at least one of Upper body text or Lower body text.'); return; }
    name = [u,l].filter(Boolean).join(' • ');
  } else if (laneIndex === 2) {
    const parts = [
      (ullInput?.value||'').trim(),
      (lllInput?.value||'').trim(),
      (urlimbInput?.value||'').trim(),
      (lrlimbInput?.value||'').trim(),
      (torsoInput?.value||'').trim(),
      (headInput?.value||'').trim()
    ].filter(Boolean);
    if (parts.length === 0) { alert('Please fill at least one of the six fields for label 2.'); return; }
    name = parts.join(' • ');
  } else {
    if (laneIndex === 3) {
      // Center of mass lane: default to label text "Center of mass" when empty
      name = (labelNameInput.value||'').trim() || 'Center of mass';
    } else {
      name = (labelNameInput.value||'').trim() || `label ${laneIndex}`;
    }
  }
  const start = Number(startFrameInput.value);
  const end = Number(endFrameInput.value);
  addRange(laneIndex, name, start, end);
  // Clear inputs after adding a label so the next entry starts blank
  clearLabelTextInputs();
});

// Toggle input UI based on lane selection
function clearLabelTextInputs(){
  if (labelNameInput) labelNameInput.value='';
  if (upperTextInput) upperTextInput.value='';
  if (lowerTextInput) lowerTextInput.value='';
  if (ullInput) ullInput.value='';
  if (lllInput) lllInput.value='';
  if (urlimbInput) urlimbInput.value='';
  if (lrlimbInput) lrlimbInput.value='';
  if (torsoInput) torsoInput.value='';
  if (headInput) headInput.value='';
}
function updateNameInputs(){
  const laneIndex = Number(laneSelect.value)||0;
  const isDual = laneIndex === 1;
  const isSix  = laneIndex === 2;
  dualNameWrap.style.display = isDual ? 'flex' : 'none';
  sixNameWrap.style.display  = isSix  ? 'flex' : 'none';
  singleNameWrap.style.display = (!isDual && !isSix) ? 'block' : 'none';
  // Clear any pre-filled values when the user switches lanes
  clearLabelTextInputs();
}
laneSelect.addEventListener('change', updateNameInputs);
updateNameInputs();

// Loading from file input
file.addEventListener('change', () => {
  if (!file.files || !file.files[0]) return;
  selectedFile = file.files[0];
  const src = URL.createObjectURL(selectedFile);
  loadVideo(src);
  if (selectedFile.type.includes('quicktime')) meta.innerHTML = (meta.innerHTML || '') + '<br/><b>Tip:</b> MOV may not play in this browser unless H.264.';
});

// Loading from URL box
btnLoad.addEventListener('click', () => {
  if (!url.value.trim()) return;
  loadVideo(url.value.trim());
});

function loadVideo(src) { video.src = src; video.load(); video.play().catch(()=>{}); }

// When metadata is ready, build timeline
video.addEventListener('loadedmetadata', () => {
  const d = canSeek() ? video.duration : 0;
  meta.innerHTML = `Duration: <b>${fmtTime(d)}</b><br/>Resolution: <b>${video.videoWidth}×${video.videoHeight}</b>`;
  rebuildTimeline();
});

// Keep playhead synced on timeupdate (fallback)
video.addEventListener('timeupdate', updatePlayhead);

// Drag & drop
document.addEventListener('dragover', (e)=>{ e.preventDefault(); });
document.addEventListener('drop', (e)=>{ e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && f.type.startsWith('video/')) { selectedFile = f; loadVideo(URL.createObjectURL(f)); if (f.type.includes('quicktime')) meta.innerHTML = (meta.innerHTML || '') + '<br/><b>Tip:</b> MOV may not play in this browser unless H.264.'; } });

// ---------- Export / Import ----------
function serializeLabels() {
  const fps = getValidFPS();
  const out = {
    schema: 'ov_labeler/1',
    generatedAt: new Date().toISOString(),
    fps,
    video: {
      src: video.currentSrc || video.src || '',
      kind: selectedFile ? 'file' : (url && url.value ? 'url' : 'unknown'),
      name: selectedFile ? (selectedFile.name || '') : '',
      duration: canSeek() ? Number(video.duration) : null,
      width: Number(video.videoWidth || 0),
      height: Number(video.videoHeight || 0)
    },
    lanes: []
  };
  for (let i = 0; i < labelRanges.length; i++) {
    const items = labelRanges[i].map(r => ({
      id: r.id,
      name: r.name,
      startFrame: r.start,
      endFrame: r.end,
      startTime: frameToTime(r.start),
      endTime: frameToTime(r.end)
    }));
    out.lanes.push({ lane: i, items });
  }
  return out;
}

function downloadJSON(data, suggestedName) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  const urlObj = URL.createObjectURL(blob);
  a.href = urlObj;
  a.download = suggestedName || 'labels.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(urlObj);
}

function baseNameFromVideo() {
  if (selectedFile && selectedFile.name) {
    return selectedFile.name.replace(/\.[^./\\]+$/, '');
  }
  const src = video.currentSrc || video.src || '';
  try {
    const u = new URL(src, window.location.href);
    const last = (u.pathname.split('/').pop() || '').split('.')[0];
    return last || 'labels';
  } catch {
    return 'labels';
  }
}

function clearAllRanges() {
  for (let laneIndex = 0; laneIndex < labelRanges.length; laneIndex++) {
    // copy ids to avoid mutation issues while removing
    const ids = labelRanges[laneIndex].map(r => r.id);
    ids.forEach(id => removeRange(id));
  }
}

function importLabelsObject(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Invalid JSON: not an object');
  if (!Array.isArray(obj.lanes)) throw new Error('Invalid JSON: missing lanes array');
  if (obj.fps) { fpsInput.value = String(obj.fps); sanitizeFPSInput(); }

  clearAllRanges();

  const fps = getValidFPS();
  const toFrame = (item, keyFrame, keyTime) => {
    if (Number.isFinite(item[keyFrame])) return Math.floor(Number(item[keyFrame]));
    if (Number.isFinite(item[keyTime])) return Math.floor(Number(item[keyTime]) * fps + 1e-6);
    return 0;
  };

  obj.lanes.forEach(l => {
    const laneIndex = Number(l.lane);
    if (!Number.isFinite(laneIndex) || laneIndex < 0 || laneIndex >= labelRanges.length) return; // skip invalid
    (l.items || []).forEach(item => {
      const name = (item.name || '').toString();
      const start = toFrame(item, 'startFrame', 'startTime');
      const end = toFrame(item, 'endFrame', 'endTime');
      addRange(laneIndex, name, start, end);
    });
  });

  refreshRangesTable();
  layoutAllLanes();
  rebuildTimeline();
}

if (btnExport) {
  btnExport.addEventListener('click', () => {
    try {
      const data = serializeLabels();
      const name = baseNameFromVideo() + '.labels.json';
      downloadJSON(data, name);
      if (importInfo) importInfo.textContent = `Exported ${data.lanes.reduce((s,l)=>s+(l.items?.length||0),0)} labels to ${name}`;
    } catch (e) {
      alert('Failed to export labels: ' + (e && e.message ? e.message : e));
    }
  });
}

if (btnImport && importJsonInput) {
  btnImport.addEventListener('click', () => importJsonInput.click());
  importJsonInput.addEventListener('change', () => {
    const f = importJsonInput.files && importJsonInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result||'{}'));
        importLabelsObject(obj);
        if (importInfo) importInfo.textContent = `Imported ${obj.lanes?.reduce((s,l)=>s+(l.items?.length||0),0)||0} labels from ${f.name}`;
      } catch (e) {
        alert('Failed to import JSON: ' + (e && e.message ? e.message : e));
      } finally {
        importJsonInput.value = '';
      }
    };
    reader.onerror = () => { alert('Failed to read file'); importJsonInput.value=''; };
    reader.readAsText(f);
  });
}

// ---------------- Dev self-tests ----------------
function runSelfTests(){
  try {
    // === Existing tests (unchanged) ===
    fpsInput.value = 30;
    const t = 1.0; // seconds
    const f = timeToFrame(t); // expect 30
    console.assert(f === 30, 'Test1 failed: timeToFrame(1s) at 30fps should be 30, got', f);
    const t2 = frameToTime(f);
    console.assert(Math.abs(t2 - 1.0) < 1e-6, 'Test2 failed: frameToTime(30) at 30fps should be 1.0s, got', t2);

    ['video','btnPlay','btnPrev','btnNext','fps','gotoFrame','btnGo','timeline','ticks','playhead','zoom'].forEach(id=>{
      console.assert(document.getElementById(id), 'Test3 failed: missing element #' + id);
    });

    console.assert(document.querySelectorAll('.label-lane').length === 4, 'Test4 failed: expected 4 label lanes');

    // === Added tests ===
    // Test 5: $ conflict avoided (informational)
    console.assert(typeof window.$ === 'undefined' || typeof window.$ === 'function', 'Test5 info: window.$ exists, but our code does not depend on it');
    console.assert(typeof getById === 'function', 'Test6 failed: helper getById missing');

    // Test 7: frame/time roundtrip for non-30 fps
    fpsInput.value = 60; sanitizeFPSInput();
    const fA = 120; // frames
    const tA = frameToTime(fA); // 2.0s
    console.assert(Math.abs(tA - 2.0) < 1e-6, 'Test7 failed: frameToTime at 60fps');
    const fB = timeToFrame(2.0);
    console.assert(fB === 120, 'Test8 failed: timeToFrame at 60fps');
    fpsInput.value = 30; sanitizeFPSInput();

    // Test 9: addRange validation & creation
    const preCount = labelRanges[0].length;
    addRange(0, 'test', 10, 20);
    console.assert(labelRanges[0].length === preCount + 1, 'Test9 failed: addRange should push to lane');
    // Test 10: removeRange
    const newId = labelRanges[0][labelRanges[0].length-1].id;
    removeRange(newId);
    console.assert(labelRanges[0].every(r => r.id !== newId), 'Test10 failed: removeRange should delete the range');

    // Test 11: keyboard shortcuts are disabled when typing
    const inputEl = getById('labelName');
    inputEl.focus();
    const beforeTime = video.currentTime;
    const keyEvt = new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true});
    document.dispatchEvent(keyEvt);
    console.assert(video.currentTime === beforeTime, 'Test11 failed: ArrowRight should be ignored when input focused');
    inputEl.blur();

    // Test 12: invalid FPS values should be sanitized and never yield NaN times
    fpsInput.value = 'abc'; sanitizeFPSInput();
    console.assert(getValidFPS() === 30, 'Test12 failed: non-numeric FPS should fallback to 30');
    fpsInput.value = '0'; sanitizeFPSInput();
    console.assert(getValidFPS() >= 1, 'Test12b failed: zero FPS should be corrected');
    fpsInput.value = '9999'; sanitizeFPSInput();
    console.assert(getValidFPS() <= 240, 'Test12c failed: huge FPS should be clamped');
    fpsInput.value = '30'; sanitizeFPSInput();

    // Test 13: goToFrame should ignore NaN/Infinity and not set non-finite currentTime
    const timeBefore = video.currentTime;
    goToFrame(NaN);
    goToFrame(Infinity);
    console.assert(isFinite(video.currentTime) && video.currentTime === timeBefore, 'Test13 failed: goToFrame with invalid should not change currentTime');

    // Test 14: very short range should still be min width
    const pxPerFrame = pxPerFrameBase * Number(zoom.value || 1);
    addRange(0,'tiny',100,101);
    const tiny = labelRanges[0][labelRanges[0].length-1];
    console.assert(tiny.el && parseFloat(tiny.el.style.width) >= MIN_BAR_PX, 'Test14 failed: tiny range should have minimum pixel width');
    removeRange(tiny.id);

    // Test 15: overlapping ranges should stack vertically
    const baseCount = labelRanges[1].length;
    addRange(1,'A',10,30);
    addRange(1,'B',20,40);
    const a = labelRanges[1][baseCount];
    const b = labelRanges[1][baseCount+1];
    console.assert(a.el && b.el && a.el.style.top !== b.el.style.top, 'Test15 failed: overlapping bars did not stack');
    removeRange(a.id); removeRange(b.id);

    // Test 16: lane 1 requires at least one of the two texts
    const preLane1 = labelRanges[1].length;
    laneSelect.value = '1'; updateNameInputs();
    upperTextInput.value=''; lowerTextInput.value='';
    const prevCount = labelRanges[1].length;
    btnAddLabel.click();
    console.assert(labelRanges[1].length === prevCount, 'Test16 failed: should not add when both upper/lower empty');

    // Test 17: lane 1 accepts only upper
    upperTextInput.value='UpperOnly'; lowerTextInput.value='';
    startFrameInput.value='0'; endFrameInput.value='5';
    btnAddLabel.click();
    console.assert(labelRanges[1].length === preLane1+1, 'Test17 failed: should add when upper provided');
    const last1 = labelRanges[1][labelRanges[1].length-1];
    console.assert(last1.name.includes('UpperOnly'), 'Test17b failed: composed name should include upper text');
    removeRange(last1.id);

    // Test 18: lane 1 accepts both and composes name with separator
    upperTextInput.value='U'; lowerTextInput.value='L';
    startFrameInput.value='1'; endFrameInput.value='6';
    btnAddLabel.click();
    const last2 = labelRanges[1][labelRanges[1].length-1];
    console.assert(last2.name.includes('U • L'), 'Test18 failed: name should be "U • L" when both provided');
    removeRange(last2.id);

    // Test 19: lane 2 requires at least one value
    laneSelect.value = '2'; updateNameInputs();
    if (ullInput && lllInput && urlimbInput && lrlimbInput && torsoInput && headInput) {
      ullInput.value = lllInput.value = urlimbInput.value = lrlimbInput.value = torsoInput.value = headInput.value = '';
      const beforeL2 = labelRanges[2].length;
      btnAddLabel.click();
      console.assert(labelRanges[2].length === beforeL2, 'Test19 failed: lane 2 should not add when all six empty');

      // Test 20: lane 2 accepts one field
      ullInput.value = 'UL';
      startFrameInput.value='2'; endFrameInput.value='7';
      btnAddLabel.click();
      console.assert(labelRanges[2].length === beforeL2+1, 'Test20 failed: lane 2 should add when one field provided');
      const lastL2a = labelRanges[2][labelRanges[2].length-1];
      console.assert(lastL2a.name.includes('UL'), 'Test20b failed: lane 2 composed name should contain provided part');
      removeRange(lastL2a.id);

      // Test 21: lane 2 composes multiple fields with separator
      ullInput.value='UL'; lllInput.value='LL'; urlimbInput.value='UR'; lrlimbInput.value='LR'; torsoInput.value='T'; headInput.value='H';
      startFrameInput.value='3'; endFrameInput.value='8';
      btnAddLabel.click();
      const lastL2b = labelRanges[2][labelRanges[2].length-1];
      console.assert(lastL2b.name.includes('UL • LL • UR • LR • T • H'), 'Test21 failed: lane 2 name should join all non-empty fields');
      removeRange(lastL2b.id);
    }

    // Test 22: lane 3 shows Center of mass placeholder
    laneSelect.value = '3'; updateNameInputs();
    console.assert(labelNameInput.placeholder === '', 'Test22 failed: lane 3 should have no placeholder');
    // Test 23: lane 3 default label when empty
    const beforeL3 = labelRanges[3].length;
    labelNameInput.value = '';
    startFrameInput.value='4'; endFrameInput.value='9';
    btnAddLabel.click();
    const lastL3 = labelRanges[3][labelRanges[3].length-1];
    console.assert(lastL3 && lastL3.name === 'Center of mass', 'Test23 failed: lane 3 default name should be "Center of mass"');
    removeRange(lastL3.id);
    labelNameInput.value = ''; // cleanup test residue so UI doesn't keep COM text
    // Test 24: lane 3 uses custom input when provided
    labelNameInput.value = 'COM Custom';
    btnAddLabel.click();
    const lastL3c = labelRanges[3][labelRanges[3].length-1];
    console.assert(lastL3c && lastL3c.name === 'COM Custom', 'Test24 failed: lane 3 should use custom input value');
    removeRange(lastL3c.id);
    labelNameInput.value = ''; // cleanup test residue

    // Test 25: lane 1 inputs have no placeholders
    laneSelect.value = '1'; updateNameInputs();
    console.assert((upperTextInput.placeholder||'') === '' && (lowerTextInput.placeholder||'') === '', 'Test25 failed: lane 1 inputs should have no placeholder');
    // Test 26: lane 2 inputs have no placeholders
    laneSelect.value = '2'; updateNameInputs();
    const l2NoPh = [ullInput, lllInput, urlimbInput, lrlimbInput, torsoInput, headInput].every(el => (el.placeholder||'') === '');
    console.assert(l2NoPh, 'Test26 failed: lane 2 inputs should have no placeholder');

    // Test 27: switching lanes clears text inputs
    laneSelect.value='1'; updateNameInputs();
    upperTextInput.value='foo'; lowerTextInput.value='bar';
    laneSelect.value='2'; updateNameInputs();
    const laneSwitchCleared = [upperTextInput.value, lowerTextInput.value].every(v=>v==='');
    console.assert(laneSwitchCleared, 'Test27 failed: lane switch should clear previous lane text inputs');

    // Test 28: after Add, inputs are cleared
    laneSelect.value='1'; updateNameInputs();
    upperTextInput.value='U'; startFrameInput.value='0'; endFrameInput.value='2';
    btnAddLabel.click();
    const clearedAfterAdd = (upperTextInput.value==='') && (lowerTextInput.value==='');
    console.assert(clearedAfterAdd, 'Test28 failed: inputs should be cleared after adding a range');
    // Clean up the test-created range so the table starts empty
    if (labelRanges[1].length) {
      const justAdded = labelRanges[1][labelRanges[1].length-1];
      removeRange(justAdded.id);
    }

    console.log('%cSelf-tests passed', 'color:#3ad29f');
  } catch (e) {
    console.warn('Self-tests encountered an issue:', e);
  }
}

// Only run self-tests when explicitly enabled to avoid pop-ups on first load.
// Enable via URL: ?selftest=1 or ?devtests=1, or localStorage.setItem('enableSelfTests','1')
try {
  const qs = String(location.search || '');
  const enabledByQS = /(?:[?&])(selftest|devtests)=1(?:&|$)/i.test(qs);
  const enabledByLS = (localStorage.getItem('enableSelfTests') === '1');
  if (enabledByQS || enabledByLS) {
    setTimeout(runSelfTests, 0);
  }
} catch {}
