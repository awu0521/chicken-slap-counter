import {
  FilesetResolver,
  HandLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Tuning constants (velocities are in frame-heights per second, +y = downward).
const STOP_RATIO = 0.25;      // impact = speed falls below this fraction of the peak
const PEAK_MAX_AGE_MS = 300;  // the stop must follow the peak within this window
// Minimum gap between counted slaps (10/sec max). Kept short because a second
// count already needs a whole new swing toward the chicken.
const COOLDOWN_MS = 100;
const AUDIO_WINDOW_MS = 150;  // motion and sound must line up within this window
const LOST_HAND_MS = 300;     // forget a hand after it's been missing this long
const MIN_FRAME_GAP_S = 0.008; // frames closer than this can't give a reliable speed
const BLUR_GAP_MS = 150;       // a hand gone this briefly may just be motion-blurred

const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("overlay");
const ctx = canvas.getContext("2d");
const stage = $("stage");
const countEl = $("count");
const hintEl = $("hint");
const statusEl = $("status");
const speedInput = $("speed");
const audioInput = $("audio");
const useAudioInput = $("use-audio");

let landmarker = null;
let mirrored = false; // selfie camera: shown mirrored like a mirror
let cameraReady = false; // false while a camera is opening or switching
let lastResult = null;
let count = 0;
let lastSlapT = -Infinity;
let lastVideoTime = -1;
let pendingMotionT = null; // motion impact awaiting a matching sound
const hands = new Map();   // handedness -> { x, y, t, speed, peak, peakT, pvx, pvy, px, py, missing }

// ---------- settings ----------
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let zone = load("zone", null); // { x1, y1, x2, y2 } normalized 0..1
// Default lowered from 2 to 1.5 (quick successive slaps are shorter and
// slower); move anyone still on the old default along with it.
const savedSpeed = load("speed", 1.5);
speedInput.value = savedSpeed === 2 ? 1.5 : savedSpeed;
audioInput.value = load("audioSens", 4);

function syncLabels() {
  $("speed-val").textContent = Number(speedInput.value).toFixed(1);
  $("audio-val").textContent = Number(audioInput.value).toFixed(1) + "×";
  $("speed-mark").style.left = (speedInput.value / speedInput.max) * 100 + "%";
  $("audio-mark").style.left = (audioInput.value / audioInput.max) * 100 + "%";
}
speedInput.addEventListener("input", () => { save("speed", +speedInput.value); syncLabels(); });
audioInput.addEventListener("input", () => { save("audioSens", +audioInput.value); syncLabels(); });
syncLabels();

// ---------- drawer ----------
function setDrawer(open) {
  document.body.classList.toggle("drawer-open", open);
  $("menu-toggle").setAttribute("aria-expanded", open);
  $("drawer").setAttribute("aria-hidden", !open);
  save("drawerOpen", open);
}
$("menu-toggle").addEventListener("click", () => setDrawer(true));
$("menu-close").addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setDrawer(false); });
setDrawer(load("drawerOpen", false));

$("reset").addEventListener("click", () => setCount(0));
$("clear-zone").addEventListener("click", () => {
  setZone(null);
  setDrawer(false);
});

function setCount(n) {
  count = n;
  countEl.textContent = n;
}

function updateStatus(msg) {
  if (msg) { statusEl.textContent = msg; return; }
  if (!landmarker) return;
  hintEl.classList.toggle("hidden", !!zone);
  statusEl.textContent = zone
    ? `counting slaps${audio ? " (motion + sound)" : ""}.`
    : "drag a box around the chicken.";
}

function setZone(z) {
  zone = z;
  save("zone", zone);
  updateStatus();
}

// ---------- target box drawing ----------
let dragStart = null;
let dragZone = null;
// Convert a screen point to 0..1 video coordinates, undoing the
// object-fit (contain or cover) scaling of the video on screen.
function normPoint(e) {
  const r = canvas.getBoundingClientRect();
  const fit = stage.classList.contains("cover") ? Math.max : Math.min;
  const scale = fit(r.width / canvas.width, r.height / canvas.height);
  const shownW = canvas.width * scale;
  const shownH = canvas.height * scale;
  let x = (e.clientX - r.left - (r.width - shownW) / 2) / shownW;
  const y = (e.clientY - r.top - (r.height - shownH) / 2) / shownH;
  if (mirrored) x = 1 - x; // selfie view is flipped on screen
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

// Fill the screen with the camera when their shapes are close (e.g. a phone
// held upright with an upright camera feed); otherwise show the whole frame
// so the edges of the scene aren't cropped away.
function updateFit() {
  if (!video.videoWidth) return;
  const ratio = (video.videoWidth / video.videoHeight) / (window.innerWidth / window.innerHeight);
  stage.classList.toggle("cover", ratio > 0.75 && ratio < 1.34);
}
function syncCanvasSize() {
  if (!video.videoWidth) return;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  updateFit();
}
// Phones change the feed's shape when rotated.
video.addEventListener("resize", syncCanvasSize);
window.addEventListener("resize", updateFit);
canvas.addEventListener("pointerdown", (e) => {
  if (!landmarker) return;
  syncCanvasSize(); // make sure the coordinate mapping matches the current feed
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  dragStart = normPoint(e);
  dragZone = null;
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  const p = normPoint(e);
  dragZone = {
    x1: Math.min(dragStart.x, p.x), y1: Math.min(dragStart.y, p.y),
    x2: Math.max(dragStart.x, p.x), y2: Math.max(dragStart.y, p.y),
  };
});
canvas.addEventListener("pointerup", () => {
  if (!dragStart) return;
  dragStart = null;
  // Ignore taps and tiny drags so a stray click doesn't wipe the box.
  if (dragZone && dragZone.x2 - dragZone.x1 > 0.02 && dragZone.y2 - dragZone.y1 > 0.02) {
    setZone(dragZone);
  }
  dragZone = null;
});

// The palm centre sits just off the chicken's surface at impact, so pad the
// box on every side. Padding is the same in all directions because a phone
// lying on its side (with rotation lock) sees "down" as left or right.
function inZone(x, y, generous = false) {
  if (!zone) return false;
  const w = zone.x2 - zone.x1;
  const h = zone.y2 - zone.y1;
  const padX = generous ? Math.max(0.15, w) : Math.max(0.08, w * 0.3);
  const padY = generous ? Math.max(0.15, h) : Math.max(0.08, h * 0.3);
  return (
    x >= zone.x1 - padX && x <= zone.x2 + padX &&
    y >= zone.y1 - padY && y <= zone.y2 + padY
  );
}

// Was the hand heading toward the chicken at its fastest moment? This is
// what tells a slap apart from the wind-up, in any camera orientation.
function headingToZone(h) {
  if (!zone || h.peak <= 0) return false;
  const aspect = video.videoWidth / video.videoHeight || 1;
  // direction to the nearest point of the box (x scaled so units are square)
  const nx = Math.min(Math.max(h.px, zone.x1), zone.x2);
  const ny = Math.min(Math.max(h.py, zone.y1), zone.y2);
  let dx = (nx - h.px) * aspect;
  let dy = ny - h.py;
  let dist = Math.hypot(dx, dy);
  if (dist < 0.02) {
    // already over the box: fall back to the direction of its centre
    dx = ((zone.x1 + zone.x2) / 2 - h.px) * aspect;
    dy = (zone.y1 + zone.y2) / 2 - h.py;
    dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return true;
    return (dx * h.pvx + dy * h.pvy) / (dist * h.peak) > 0;
  }
  return (dx * h.pvx + dy * h.pvy) / (dist * h.peak) > 0.5; // within ~60°
}

// ---------- audio ----------
let audio = null; // { ac, stream, analyser, buf, baseline }
let lastSpikeT = -Infinity;
let audioRatio = 0;

async function enableAudio() {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Processing would smooth away the sharp transient we're listening for.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ac = new AudioContext();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 2048;
  ac.createMediaStreamSource(stream).connect(analyser);
  audio = { ac, stream, analyser, buf: new Float32Array(analyser.fftSize), baseline: 0.01 };
}
function disableAudio() {
  if (!audio) return;
  audio.stream.getTracks().forEach((t) => t.stop());
  audio.ac.close();
  audio = null;
}
useAudioInput.addEventListener("change", async () => {
  if (useAudioInput.checked) {
    try {
      await enableAudio();
    } catch (err) {
      useAudioInput.checked = false;
      updateStatus("microphone unavailable: " + err.message);
      return;
    }
  } else {
    disableAudio();
  }
  pendingMotionT = null;
  updateStatus();
});

function sampleAudio(t) {
  if (!audio) { audioRatio = 0; return; }
  audio.analyser.getFloatTimeDomainData(audio.buf);
  let sum = 0;
  for (const v of audio.buf) sum += v * v;
  const rms = Math.sqrt(sum / audio.buf.length);
  audioRatio = rms / audio.baseline;
  const isSpike = audioRatio > +audioInput.value && rms > 0.02;
  if (isSpike) lastSpikeT = t;
  else audio.baseline = Math.max(0.002, audio.baseline * 0.98 + rms * 0.02);
}

// ---------- slap detection ----------
function motionImpact(t) {
  if (!audio) return registerSlap(t);
  if (t - lastSpikeT <= AUDIO_WINDOW_MS) return registerSlap(t);
  pendingMotionT = t; // wait briefly for the sound to arrive
}

function registerSlap(t) {
  pendingMotionT = null;
  if (t - lastSlapT < COOLDOWN_MS) return;
  lastSlapT = t;
  setCount(count + 1);
  countEl.classList.add("bump");
  stage.classList.add("flash");
  setTimeout(() => {
    countEl.classList.remove("bump");
    stage.classList.remove("flash");
  }, 90);
}

// A slap = the palm moves fast toward the chicken, then suddenly stops on it.
// Direction-free, so it works with the phone upright, sideways or upside down.
function processHands(result, t) {
  const threshold = +speedInput.value;
  const aspect = video.videoWidth / video.videoHeight || 1;
  const seen = new Set();
  let maxSpeed = 0;

  result.landmarks.forEach((lm, i) => {
    const key = result.handednesses[i]?.[0]?.categoryName ?? String(i);
    seen.add(key);
    // Palm centre: midpoint of wrist (0) and middle-finger knuckle (9).
    const x = (lm[0].x + lm[9].x) / 2;
    const y = (lm[0].y + lm[9].y) / 2;
    const prev = hands.get(key);
    const fresh = { x, y, t, speed: 0, peak: 0, peakT: t, pvx: 0, pvy: 0, px: x, py: y };
    if (!prev) {
      hands.set(key, fresh);
      return;
    }

    if (prev.missing) {
      // The hand dropped out of tracking and is back. Fast slaps often blur
      // out for a frame or two and reappear already on the chicken, so count
      // the jump as a slap if it looks like one: the hand was moving fast,
      // was gone only briefly, jumped toward the chicken and landed on it.
      // Anything else (a still hand re-found elsewhere) just starts fresh.
      const gap = t - prev.t;
      if (!prev.countedOnVanish && gap > 0 && gap <= BLUR_GAP_MS &&
          prev.speed >= threshold * 0.5 && inZone(x, y)) {
        const g = {
          px: prev.x, py: prev.y,
          pvx: ((x - prev.x) / (gap / 1000)) * aspect,
          pvy: (y - prev.y) / (gap / 1000),
        };
        g.peak = Math.hypot(g.pvx, g.pvy);
        if (g.peak > threshold && headingToZone(g)) motionImpact(t);
      }
      hands.set(key, fresh);
      return;
    }

    // Same picture as last time (screen refreshed faster than the camera):
    // nothing to measure, and a fake "stop" would confuse detection.
    if (x === prev.x && y === prev.y) return;
    const dt = (t - prev.t) / 1000;
    if (dt < MIN_FRAME_GAP_S) return; // too close to measure; fold into the next frame
    // velocity in frame-heights per second (x scaled so both axes match)
    const vx = ((x - prev.x) / dt) * aspect;
    const vy = (y - prev.y) / dt;
    const speed = Math.hypot(vx, vy);
    maxSpeed = Math.max(maxSpeed, speed);

    if (t - prev.peakT > PEAK_MAX_AGE_MS) prev.peak = 0;

    // Impact: the hand's speed *toward the chicken* collapses. That covers a
    // stop, a slide, and a bounce straight into the next wind-up, which is
    // what slaps in quick succession look like (the hand never sits still).
    // Checked before the peak is updated, so the bounce can't erase the swing.
    // Either of the last two positions may be the low point; at low frame
    // rates the exact moment of contact is often between frames.
    if (prev.peak > threshold && (inZone(x, y) || inZone(prev.x, prev.y))) {
      const towardChicken = (vx * prev.pvx + vy * prev.pvy) / prev.peak;
      if (towardChicken < prev.peak * STOP_RATIO) {
        motionImpact(t);
        prev.peak = 0;
        Object.assign(prev, { x, y, t, speed });
        return;
      }
    }

    // Only movement toward the chicken can be the fast part of a slap. The
    // wind-up is often just as fast, so if it were allowed to set the peak it
    // would hide the slap that follows; fast movement away starts over instead.
    const move = { px: (x + prev.x) / 2, py: (y + prev.y) / 2, pvx: vx, pvy: vy, peak: speed };
    if (headingToZone(move)) {
      if (speed > prev.peak) Object.assign(prev, move, { peakT: t });
    } else if (speed > threshold) {
      prev.peak = 0;
    }
    Object.assign(prev, { x, y, t, speed });
  });

  // A hand that vanishes mid-swing toward the chicken (motion blur) and
  // doesn't come back on it is counted at the moment it disappears.
  for (const [key, h] of hands) {
    if (seen.has(key) || h.missing) {
      if (!seen.has(key) && t - h.t > LOST_HAND_MS) hands.delete(key);
      continue;
    }
    if (h.peak > threshold && t - h.peakT < 150 && inZone(h.x, h.y, true) && headingToZone(h)) {
      motionImpact(t);
      h.countedOnVanish = true;
    }
    h.missing = true;
    h.peak = 0;
  }

  $("speed-meter").style.width = Math.min(100, (maxSpeed / speedInput.max) * 100) + "%";
}

// ---------- drawing ----------
// Everything is stored in camera coordinates; in selfie view the video is
// mirrored on screen, so flip x when drawing (text stays readable).
const sx = (x) => (mirrored ? 1 - x : x);

function drawBox(z, label) {
  const W = canvas.width, H = canvas.height;
  const x = Math.min(sx(z.x1), sx(z.x2)) * W;
  const y = z.y1 * H, w = (z.x2 - z.x1) * W, h = (z.y2 - z.y1) * H;
  ctx.strokeStyle = "#eee";
  ctx.lineWidth = Math.max(2, W / 400);
  ctx.strokeRect(x, y, w, h);
  if (!label) return;

  const size = Math.round(H / 32);
  ctx.font = `700 ${size}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  const pad = size * 0.4;
  const tw = ctx.measureText(label).width;
  const ly = y - size - pad * 2 >= 0 ? y - size - pad * 2 : y; // flip inside if no room above
  ctx.fillStyle = "#eee";
  ctx.fillRect(x - ctx.lineWidth / 2, ly, tw + pad * 2, size + pad * 2);
  ctx.fillStyle = "#333";
  ctx.textBaseline = "top";
  ctx.fillText(label, x + pad, ly + pad);
}

function draw(result) {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (dragZone) drawBox(dragZone, null);
  else if (zone) drawBox(zone, "chicken");

  if (!result) return;
  for (const lm of result.landmarks) {
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(sx(p.x) * W, p.y * H, W / 250, 0, Math.PI * 2);
      ctx.fill();
    }
    const px = (lm[0].x + lm[9].x) / 2, py = (lm[0].y + lm[9].y) / 2;
    // Palm marker: hollow ring normally, filled when over the chicken.
    ctx.beginPath();
    ctx.arc(sx(px) * W, py * H, W / 80, 0, Math.PI * 2);
    if (inZone(px, py)) {
      ctx.fillStyle = "#eee";
      ctx.fill();
    } else {
      ctx.strokeStyle = "#eee";
      ctx.lineWidth = Math.max(2, W / 400);
      ctx.stroke();
    }
  }
}

// ---------- main loop ----------
function loop() {
  requestAnimationFrame(loop); // schedule first, so an error below can't end the loop
  const t = performance.now();
  sampleAudio(t);
  $("audio-meter").style.width = Math.min(100, (audioRatio / audioInput.max) * 100) + "%";

  if (pendingMotionT !== null) {
    if (lastSpikeT >= pendingMotionT - AUDIO_WINDOW_MS) registerSlap(pendingMotionT);
    else if (t - pendingMotionT > AUDIO_WINDOW_MS) pendingMotionT = null;
  }

  // Only hand MediaPipe real frames: while a camera is switching the video
  // briefly has no picture, and an empty frame makes the tracker throw.
  const frameReady = cameraReady && video.readyState >= 2 && video.videoWidth > 0;
  if (frameReady && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    // Some browsers don't fire "resize" when the phone rotates; catch it here.
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) syncCanvasSize();
    try {
      lastResult = landmarker.detectForVideo(video, t);
      processHands(lastResult, t);
    } catch (err) {
      // One bad frame must never stop the loop (that froze drawing before).
      console.warn("skipped a frame:", err);
      lastResult = null;
    }
  }
  draw(lastResult);
}

// ---------- stopwatch ----------
const swTime = $("sw-time");
const swToggle = $("sw-toggle");
let swElapsed = 0;      // ms accumulated before the current run
let swStartedAt = null; // performance.now() when running, else null

function swNow() {
  return swElapsed + (swStartedAt === null ? 0 : performance.now() - swStartedAt);
}
function swRender() {
  const ms = swNow();
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const tenths = Math.floor((ms % 1000) / 100);
  swTime.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths}`;
  if (swStartedAt !== null) requestAnimationFrame(swRender);
}
swToggle.addEventListener("click", () => {
  if (swStartedAt === null) {
    swStartedAt = performance.now();
    swToggle.textContent = "stop";
    swToggle.classList.add("running");
    swRender();
  } else {
    swElapsed = swNow();
    swStartedAt = null;
    swToggle.textContent = "start";
    swToggle.classList.remove("running");
  }
});
$("sw-reset").addEventListener("click", () => {
  swElapsed = 0;
  if (swStartedAt !== null) swStartedAt = performance.now();
  swRender();
});

// Drag the stopwatch anywhere (grab it by anything except its buttons).
// Position is saved as a fraction of the window so it survives resizes.
const swBox = $("stopwatch");
let swDrag = null;
let swPos = load("swPos", null); // { x, y } as fractions of the viewport

function placeStopwatch(x, y) {
  const maxX = window.innerWidth - swBox.offsetWidth;
  const maxY = window.innerHeight - swBox.offsetHeight;
  x = Math.min(Math.max(0, x), Math.max(0, maxX));
  y = Math.min(Math.max(0, y), Math.max(0, maxY));
  swBox.style.left = x + "px";
  swBox.style.top = y + "px";
  swBox.style.bottom = "auto";
  return { x, y };
}
function restoreStopwatch() {
  if (swPos) placeStopwatch(swPos.x * window.innerWidth, swPos.y * window.innerHeight);
}
swBox.addEventListener("pointerdown", (e) => {
  if (e.target.closest("button")) return;
  const r = swBox.getBoundingClientRect();
  swDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  swBox.setPointerCapture(e.pointerId);
  swBox.classList.add("dragging");
});
swBox.addEventListener("pointermove", (e) => {
  if (swDrag) placeStopwatch(e.clientX - swDrag.dx, e.clientY - swDrag.dy);
});
function endStopwatchDrag() {
  if (!swDrag) return;
  swDrag = null;
  swBox.classList.remove("dragging");
  const r = swBox.getBoundingClientRect();
  swPos = { x: r.left / window.innerWidth, y: r.top / window.innerHeight };
  save("swPos", swPos);
}
swBox.addEventListener("pointerup", endStopwatchDrag);
swBox.addEventListener("pointercancel", endStopwatchDrag);
window.addEventListener("resize", restoreStopwatch);
restoreStopwatch();

// ---------- camera ----------
// Default to the rear camera on phones; laptops just use their only camera.
let facing = load("facing", "environment"); // "environment" (back) or "user" (selfie)

async function getCamera(mode) {
  const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } };
  try {
    // "exact" makes phones actually switch lenses...
    return await navigator.mediaDevices.getUserMedia({
      video: { ...base, facingMode: { exact: mode } },
    });
  } catch (err) {
    // ...but laptops have no back camera, so fall back to whatever exists.
    if (err.name !== "OverconstrainedError" && err.name !== "NotFoundError") throw err;
    return navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { ideal: mode } } });
  }
}

async function openCamera() {
  cameraReady = false; // pause hand tracking until the new feed is live
  lastResult = null;
  // Phones often can't open two cameras at once, so release the old one first.
  if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
  const stream = await getCamera(facing);
  const actual = stream.getVideoTracks()[0].getSettings().facingMode;
  mirrored = actual ? actual === "user" : facing === "user";
  stage.classList.toggle("mirrored", mirrored);
  $("switch-camera").textContent = mirrored ? "use back camera" : "use selfie camera";
  video.srcObject = stream;
  await video.play();
  syncCanvasSize();
  hands.clear();
  lastVideoTime = -1;
  cameraReady = true;
}

$("switch-camera").addEventListener("click", async () => {
  facing = facing === "environment" ? "user" : "environment";
  save("facing", facing);
  $("switch-camera").disabled = true;
  try {
    await openCamera();
  } catch (err) {
    updateStatus("couldn't switch camera: " + err.message);
    // go back to the camera that was working
    facing = facing === "environment" ? "user" : "environment";
    save("facing", facing);
    try { await openCamera(); } catch {}
  } finally {
    $("switch-camera").disabled = false;
  }
});

const startStatus = (msg) => { $("start-status").textContent = msg; };

$("start").addEventListener("click", async () => {
  $("start").disabled = true;
  try {
    startStatus("starting camera…");
    await openCamera();
    // Only offer switching when there's more than one camera.
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput").length;
    $("switch-camera").classList.toggle("hidden", cams < 2);

    startStatus("loading hand model…");
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });

    $("start-screen").classList.add("hidden");
    updateStatus();
    requestAnimationFrame(loop);
  } catch (err) {
    $("start").disabled = false;
    startStatus("couldn't start: " + err.message);
  }
});
