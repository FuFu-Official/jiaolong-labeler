const authView = document.querySelector("#authView");
const workView = document.querySelector("#workView");
const authForm = document.querySelector("#authForm");
const registerBtn = document.querySelector("#registerBtn");
const usernameInput = document.querySelector("#username");
const passwordInput = document.querySelector("#password");
const authMessage = document.querySelector("#authMessage");
const statusText = document.querySelector("#statusText");
const taskTitle = document.querySelector("#taskTitle");
const shortcutCorners = document.querySelector("#shortcutCorners");
const prevBtn = document.querySelector("#prevBtn");
const nextBtn = document.querySelector("#nextBtn");
const logoutBtn = document.querySelector("#logoutBtn");
const canvas = document.querySelector("#canvas");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;
const emptyState = document.querySelector("#emptyState");
const selectedInfo = document.querySelector("#selectedInfo");
const pointList = document.querySelector("#pointList");
const visibleBtn = document.querySelector("#visibleBtn");
const deleteBtn = document.querySelector("#deleteBtn");
const doneBtn = document.querySelector("#doneBtn");
const resetBtn = document.querySelector("#resetBtn");
const saveMessage = document.querySelector("#saveMessage");

let user = null;
let template = null;
let runtime = { appName: "Jiaolong Labeler", authEnabled: true, deploymentMode: "shared", annotation: { cornerCount: 4 } };
let task = null;
let image = new Image();
let imageLoaded = false;
let points = [];
let selectedId = null;
let dragId = null;
let view = { scale: 1, ox: 0, oy: 0, width: 0, height: 0 };
let zoom = 1;
let pan = { x: 0, y: 0 };
let panState = null;
let cornerDraft = null;
let magnifier = null;
let taskHistory = [];
let historyIndex = -1;

let cornerIds = [];

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function setMessage(el, text, type = "") {
  el.textContent = text || "";
  el.className = `message ${type}`.trim();
}

function showWork() {
  authView.classList.add("hidden");
  workView.classList.remove("hidden");
  requestAnimationFrame(resizeCanvas);
}

function showAuth() {
  if (!runtime.authEnabled) return showWork();
  workView.classList.add("hidden");
  authView.classList.remove("hidden");
}

function deriveCornerIds(nextTemplate) {
  const explicitCount = Number(nextTemplate?.cornerCount);
  const fromNames = Array.isArray(nextTemplate?.cornerNames) ? nextTemplate.cornerNames.length : 0;
  const fromConfig = Number(runtime?.annotation?.cornerCount);
  const count = Math.max(1, Number.isFinite(explicitCount) ? explicitCount : fromNames || fromConfig || 4);
  return Array.from({ length: count }, (_, index) => `corner_${index}`);
}

function selectedCornerNames() {
  return cornerIds.map((id, index) => pointName(id, `corner_${index + 1}`));
}

function applyRuntimeUi() {
  const authTitle = document.querySelector("#authTitle");
  const appName = runtime.appName || "Jiaolong Labeler";
  document.title = appName;
  if (authTitle) authTitle.textContent = appName;
  registerBtn.classList.toggle("hidden", !runtime.authEnabled);
  logoutBtn.classList.toggle("hidden", !runtime.authEnabled);
  const loginBtn = authForm.querySelector("button[type='submit']");
  if (loginBtn) loginBtn.classList.toggle("hidden", !runtime.authEnabled);
}

function updateStepText() {
  const stepCorners = document.querySelector("#stepCorners");
  const stepExport = document.querySelector("#stepExport");
  const names = selectedCornerNames();
  if (stepCorners) {
    stepCorners.textContent = `依次点击 ${cornerIds.length} 个关键点：${names.join("、")}`;
  }
  if (stepExport) {
    stepExport.textContent = `关键点将按模板顺序导出（共 ${template?.keypointCount || cornerIds.length} 个）`;
  }
  if (shortcutCorners) {
    shortcutCorners.textContent = `${cornerIds.length} 个关键点`;
  }
}

async function init() {
  try {
    runtime = { ...runtime, ...(await api("/api/runtime")) };
  } catch {}
  applyRuntimeUi();

  try {
    const me = await api("/api/me");
    user = me.user;
    if (me.runtime) runtime = { ...runtime, ...me.runtime };
    applyRuntimeUi();
    showWork();
    await loadTemplate();
    await refreshStatus();
  } catch {
    if (runtime.authEnabled) showAuth();
    else {
      user = { id: "local-user", username: "local" };
      showWork();
      await loadTemplate();
      await refreshStatus().catch(() => {});
    }
  }
  resizeCanvas();
}

async function loadTemplate() {
  template = await api("/api/template");
  cornerIds = deriveCornerIds(template);
  updateStepText();
}

async function refreshStatus() {
  const status = await api("/api/status");
  const mode = runtime.authEnabled ? "" : "（本地模式）";
  statusText.textContent = `${user.username}${mode} · 我已标注 ${status.completedByMe || 0} · 总数 ${status.total} · 已完成 ${status.done} · 剩余 ${status.remaining}`;
}

async function submitAuth(mode) {
  setMessage(authMessage, "");
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  try {
    const result = await api(`/api/${mode}`, {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    user = result.user;
    if (result.runtime) runtime = { ...runtime, ...result.runtime };
    applyRuntimeUi();
    showWork();
    await loadTemplate();
    await refreshStatus();
  } catch (error) {
    setMessage(authMessage, error.message, "error");
  }
}

function imageToCanvas(point) {
  return { x: view.ox + point.x * view.width, y: view.oy + point.y * view.height };
}

function canvasToImage(x, y) {
  if (!view.width || !view.height) return { x: 0, y: 0 };
  return {
    x: Math.min(1, Math.max(0, (x - view.ox) / view.width)),
    y: Math.min(1, Math.max(0, (y - view.oy) / view.height))
  };
}

function resetViewport() {
  zoom = 1;
  pan = { x: 0, y: 0 };
}

function togglePointVisibility(point) {
  if (!point) return;
  selectedId = point.id;
  point.visible = !point.visible;
  renderPoints();
  draw();
}

function pointName(id, fallback) {
  if (id.startsWith("corner_")) {
    const index = Number(id.replace("corner_", ""));
    return template.cornerNames?.[index] || fallback;
  }
  return fallback;
}

function generateInternalPoints(selectFirstGenerated = true) {
  const corners = cornerIds.map((id) => points.find((point) => point.id === id));
  if (corners.some((point) => !point)) return;
  const internals = template.internalPoints || [];
  if (!internals.length) {
    points = corners;
    if (selectFirstGenerated) selectedId = corners[corners.length - 1]?.id || selectedId;
    return;
  }
  if (cornerIds.length !== 4) {
    const others = points.filter((point) => !point.id.startsWith("corner_"));
    points = [...corners, ...others];
    if (selectFirstGenerated) selectedId = others[0]?.id || corners[corners.length - 1]?.id || selectedId;
    return;
  }
  const generated = internals.map((item, index) => {
    const projected = projectUnitPoint(corners, Number(item.u), Number(item.v));
    return {
      id: `kp_${item.id || index + 1}`,
      name: item.name || `kp_${index + 1}`,
      x: projected.x,
      y: projected.y,
      visible: true
    };
  });
  points = [...corners, ...generated];
  if (selectFirstGenerated) selectedId = generated[0]?.id || selectedId;
}

function projectUnitPoint(corners, u, v) {
  if (!Array.isArray(corners) || corners.length !== 4) {
    const first = corners[0] || { x: 0, y: 0 };
    return { x: first.x, y: first.y };
  }
  const [tl, bl, br, tr] = corners;
  const top = lerpPoint(tl, tr, u);
  const bottom = lerpPoint(bl, br, u);
  return lerpPoint(top, bottom, v);
}

function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.imageSmoothingEnabled = false;
  draw();
}

function updateView() {
  const rect = canvas.getBoundingClientRect();
  if (!imageLoaded) {
    view = { scale: 1, ox: 0, oy: 0, width: rect.width, height: rect.height };
    return;
  }
  const baseScale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const scale = baseScale * zoom;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  view = { scale, width, height, ox: (rect.width - width) / 2 + pan.x, oy: (rect.height - height) / 2 + pan.y };
}

function draw() {
  updateView();
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#20272d";
  ctx.fillRect(0, 0, rect.width, rect.height);
  if (!imageLoaded) return;

  ctx.drawImage(image, view.ox, view.oy, view.width, view.height);
  drawPolygon();
  for (const point of points) drawPoint(point);
  drawMagnifier();
}

function drawPolygon() {
  const corners = cornerIds.map((id) => points.find((point) => point.id === id)).filter(Boolean);
  if (corners.length < 2) return;
  ctx.save();
  ctx.strokeStyle = "rgba(18, 124, 114, 0.95)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  corners.forEach((point, index) => {
    const pos = imageToCanvas(point);
    if (index === 0) ctx.moveTo(pos.x, pos.y);
    else ctx.lineTo(pos.x, pos.y);
  });
  if (corners.length === cornerIds.length) ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawPoint(point) {
  const pos = imageToCanvas(point);
  const active = point.id === selectedId;
  const isCorner = point.id.startsWith("corner_");
  const dragging = point.id === dragId;
  ctx.save();
  ctx.globalAlpha = dragging ? 0.45 : point.visible ? 1 : 0.45;
  ctx.fillStyle = point.visible ? (isCorner ? "#f0b429" : "#22a6f2") : "#b12a34";
  ctx.strokeStyle = active ? "#ffffff" : "#172026";
  ctx.lineWidth = active ? 3 : 1.5;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, active ? 7 : 5, 0, Math.PI * 2);
  if (!dragging) ctx.fill();
  ctx.stroke();
  ctx.font = "12px Arial";
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.lineWidth = 3;
  const label = point.name;
  ctx.strokeText(label, pos.x + 8, pos.y - 8);
  ctx.fillText(label, pos.x + 8, pos.y - 8);
  ctx.restore();
}

function drawMagnifier() {
  if (!magnifier || !imageLoaded) return;
  const point = magnifier.pointId ? points.find((item) => item.id === magnifier.pointId) : magnifier.point;
  if (!point) return;

  const rect = canvas.getBoundingClientRect();
  const lensSize = 230;
  const sourceSize = 18;
  const margin = 16;
  const imageX = point.x * image.naturalWidth;
  const imageY = point.y * image.naturalHeight;
  const sx = Math.max(0, Math.min(image.naturalWidth - sourceSize, imageX - sourceSize / 2));
  const sy = Math.max(0, Math.min(image.naturalHeight - sourceSize, imageY - sourceSize / 2));

  let dx = magnifier.canvasX + 28;
  let dy = magnifier.canvasY - lensSize - 28;
  if (dx + lensSize + margin > rect.width) dx = magnifier.canvasX - lensSize - 28;
  if (dy < margin) dy = magnifier.canvasY + 28;
  if (dx < margin) dx = margin;
  if (dy + lensSize + margin > rect.height) dy = rect.height - lensSize - margin;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "rgba(9, 14, 18, 0.92)";
  ctx.fillRect(dx - 5, dy - 25, lensSize + 10, lensSize + 32);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.88)";
  ctx.lineWidth = 1;
  ctx.strokeRect(dx - 5, dy - 25, lensSize + 10, lensSize + 32);
  ctx.drawImage(image, sx, sy, sourceSize, sourceSize, dx, dy, lensSize, lensSize);

  const px = dx + ((imageX - sx) / sourceSize) * lensSize;
  const py = dy + ((imageY - sy) / sourceSize) * lensSize;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, dy);
  ctx.lineTo(px, dy + lensSize);
  ctx.moveTo(dx, py);
  ctx.lineTo(dx + lensSize, py);
  ctx.stroke();

  ctx.strokeStyle = "#ff3b30";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(px, py, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px - 13, py);
  ctx.lineTo(px - 4, py);
  ctx.moveTo(px + 4, py);
  ctx.lineTo(px + 13, py);
  ctx.moveTo(px, py - 13);
  ctx.lineTo(px, py - 4);
  ctx.moveTo(px, py + 4);
  ctx.lineTo(px, py + 13);
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.font = "12px Arial";
  ctx.fillText(`${point.name}  x=${point.x.toFixed(5)} y=${point.y.toFixed(5)}`, dx, dy - 8);
  ctx.restore();
}

function setDraftMagnifier(canvasX, canvasY) {
  const index = currentCornerIndex();
  const id = index >= 0 ? cornerIds[index] : selectedId || "point";
  const imagePoint = canvasToImage(canvasX, canvasY);
  magnifier = {
    canvasX,
    canvasY,
    point: {
      id,
      name: pointName(id, `corner_${index + 1}`),
      x: imagePoint.x,
      y: imagePoint.y,
      visible: true
    }
  };
}

function renderPoints() {
  const selected = points.find((point) => point.id === selectedId);
  selectedInfo.textContent = selected
    ? `${selected.name} · x=${selected.x.toFixed(4)} y=${selected.y.toFixed(4)} · ${selected.visible ? "可见" : "不可见"}`
    : "未选择";
  pointList.innerHTML = "";
  for (const point of points) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `point-item ${point.id === selectedId ? "active" : ""}`;
    row.innerHTML = `<span>${point.name}<small>${point.x.toFixed(4)}, ${point.y.toFixed(4)}</small></span><span class="visibility ${point.visible ? "" : "hidden-point"}">${point.visible ? "可见" : "不可见"}</span>`;
    row.addEventListener("click", () => {
      selectedId = point.id;
      renderPoints();
      draw();
    });
    pointList.appendChild(row);
  }
}

function currentCornerIndex() {
  return cornerIds.findIndex((id) => !points.some((point) => point.id === id));
}

function hitTest(x, y) {
  let best = null;
  let bestDistance = 14;
  for (const point of points) {
    const pos = imageToCanvas(point);
    const distance = Math.hypot(pos.x - x, pos.y - y);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

function clampZoom(value) {
  return Math.min(12, Math.max(0.25, value));
}

function zoomAt(canvasX, canvasY, deltaY) {
  if (!imageLoaded) return;
  updateView();
  const before = canvasToImage(canvasX, canvasY);
  const factor = Math.exp(-deltaY * 0.0012);
  const nextZoom = clampZoom(zoom * factor);
  if (nextZoom === zoom) return;
  zoom = nextZoom;
  updateView();
  const nextCanvasX = view.ox + before.x * view.width;
  const nextCanvasY = view.oy + before.y * view.height;
  pan.x += canvasX - nextCanvasX;
  pan.y += canvasY - nextCanvasY;
  draw();
}

function addCorner(x, y) {
  const index = currentCornerIndex();
  if (index < 0) return false;
  const point = canvasToImage(x, y);
  points.push({
    id: cornerIds[index],
    name: pointName(cornerIds[index], `corner_${index + 1}`),
    x: point.x,
    y: point.y,
    visible: true
  });
  selectedId = cornerIds[index];
  if (currentCornerIndex() < 0) generateInternalPoints();
  renderPoints();
  draw();
  return true;
}

async function loadNextTask(options = {}) {
  if (!options.skipSave && !(await saveLabelBeforeSwitch("draft"))) return;
  setMessage(saveMessage, "");
  const result = await api("/api/task/next", {
    method: "POST",
    body: JSON.stringify({ skipImageName: task?.imageName || null })
  });
  if (!result.task) {
    task = null;
    imageLoaded = false;
    emptyState.textContent = "没有可领取的任务";
    emptyState.classList.remove("hidden");
    taskTitle.textContent = "没有可领取的任务";
    draw();
    return;
  }
  await openTask(result.task, true);
  await refreshStatus();
}

async function fetchTask(imageName) {
  const query = new URLSearchParams({ imageName });
  const result = await api(`/api/task?${query.toString()}`);
  return result.task;
}

async function openTask(nextTask, pushHistory) {
  task = nextTask;
  points = (task.annotation.points || []).map((point) => ({ ...point }));
  if (hasAllCorners() && points.filter((point) => point.id.startsWith("kp_")).length < (template.internalPoints || []).length) {
    generateInternalPoints(false);
  }
  selectedId = points[0]?.id || null;
  imageLoaded = false;
  resetViewport();
  emptyState.textContent = "图片加载中...";
  emptyState.classList.remove("hidden");
  image = new Image();
  image.onload = () => {
    imageLoaded = true;
    taskTitle.textContent = task.imageName;
    requestAnimationFrame(() => {
      resizeCanvas();
      emptyState.classList.add("hidden");
      renderPoints();
      draw();
    });
  };
  image.onerror = () => {
    imageLoaded = false;
    emptyState.textContent = `图片加载失败：${task.imageName}`;
    emptyState.classList.remove("hidden");
    draw();
  };
  image.src = `/images/${encodeURIComponent(task.imageName)}`;
  if (pushHistory) {
    taskHistory = taskHistory.slice(0, historyIndex + 1);
    taskHistory.push(nextTask);
    historyIndex = taskHistory.length - 1;
  }
  updateHistoryButtons();
}

async function loadPreviousTask() {
  if (historyIndex <= 0) return;
  if (!(await saveLabelBeforeSwitch("draft"))) return;
  historyIndex -= 1;
  const freshTask = await fetchTask(taskHistory[historyIndex].imageName);
  taskHistory[historyIndex] = freshTask;
  await openTask(freshTask, false);
}

function updateHistoryButtons() {
  prevBtn.disabled = historyIndex <= 0;
}

function hasAllCorners() {
  return cornerIds.every((id) => points.some((point) => point.id === id));
}

async function saveLabelBeforeSwitch(status = "draft") {
  if (!task || !imageLoaded) return true;
  if (!points.length) {
    await api("/api/task/release", {
      method: "POST",
      body: JSON.stringify({ imageName: task.imageName })
    }).catch(() => {});
    return true;
  }
  if (!hasAllCorners()) {
    setMessage(saveMessage, `请先标出 ${cornerIds.length} 个关键点，再切换图片或提交。`, "error");
    return false;
  }
  task.annotation = {
    ...(task.annotation || {}),
    points: points.map((point) => ({ ...point })),
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
    status
  };
  if (historyIndex >= 0) taskHistory[historyIndex] = task;
  try {
    await api("/api/annotation", {
      method: "POST",
      body: JSON.stringify({
        imageName: task.imageName,
        imageWidth: image.naturalWidth,
        imageHeight: image.naturalHeight,
        points,
        status
      })
    });
    setMessage(saveMessage, "已写入 labels/ 中对应的标注文件。", "ok");
    return true;
  } catch (error) {
    setMessage(saveMessage, error.message, "error");
    return false;
  }
}

async function save(status) {
  if (!task || !imageLoaded) return;
  if (status === "done" && !hasAllCorners()) {
    setMessage(saveMessage, `完成提交前需要先标出 ${cornerIds.length} 个关键点。`, "error");
    return;
  }
  if (await saveLabelBeforeSwitch(status)) {
    await refreshStatus();
    if (status === "done") await loadNextTask({ skipSave: true });
  }
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth("login");
});

registerBtn.addEventListener("click", () => submitAuth("register"));
prevBtn.addEventListener("click", loadPreviousTask);
nextBtn.addEventListener("click", loadNextTask);
doneBtn.addEventListener("click", () => save("done"));

logoutBtn.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  user = null;
  showAuth();
});

visibleBtn.addEventListener("click", () => {
  const point = points.find((item) => item.id === selectedId);
  togglePointVisibility(point);
});

deleteBtn.addEventListener("click", () => {
  if (!selectedId) return;
  points = points.filter((point) => point.id !== selectedId);
  selectedId = points[0]?.id || null;
  renderPoints();
  draw();
});

resetBtn.addEventListener("click", () => {
  points = [];
  selectedId = null;
  renderPoints();
  draw();
});

canvas.addEventListener("pointerdown", (event) => {
  if (!imageLoaded) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = hitTest(x, y);
  if (event.button === 2) {
    panState = {
      pointerId: event.pointerId,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      moved: false,
      hitId: hit?.id || null
    };
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  if (hit) {
    selectedId = hit.id;
    dragId = hit.id;
    magnifier = { canvasX: x, canvasY: y, pointId: hit.id };
    canvas.setPointerCapture(event.pointerId);
    renderPoints();
    draw();
    return;
  }
  if (currentCornerIndex() >= 0) {
    cornerDraft = { pointerId: event.pointerId, canvasX: x, canvasY: y };
    setDraftMagnifier(x, y);
    canvas.setPointerCapture(event.pointerId);
    draw();
  }
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

canvas.addEventListener("pointermove", (event) => {
  const rect = canvas.getBoundingClientRect();
  if (panState && panState.pointerId === event.pointerId) {
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const distance = Math.hypot(x - panState.startX, y - panState.startY);
    if (!panState.moved && distance <= 3) return;
    const dx = x - (panState.moved ? panState.lastX : panState.startX);
    const dy = y - (panState.moved ? panState.lastY : panState.startY);
    panState.moved = true;
    pan.x += dx;
    pan.y += dy;
    panState.lastX = x;
    panState.lastY = y;
    draw();
    return;
  }
  if (cornerDraft && cornerDraft.pointerId === event.pointerId) {
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    cornerDraft.canvasX = x;
    cornerDraft.canvasY = y;
    setDraftMagnifier(x, y);
    draw();
    return;
  }
  if (!dragId) return;
  const point = points.find((item) => item.id === dragId);
  if (!point) return;
  const next = canvasToImage(event.clientX - rect.left, event.clientY - rect.top);
  point.x = next.x;
  point.y = next.y;
  magnifier = { canvasX: event.clientX - rect.left, canvasY: event.clientY - rect.top, pointId: point.id };
  if (point.id.startsWith("corner_") && hasAllCorners()) generateInternalPoints(false);
  renderPoints();
  draw();
});

canvas.addEventListener("pointerup", (event) => {
  if (panState && panState.pointerId === event.pointerId) {
    const hitId = panState.hitId;
    const moved = panState.moved;
    panState = null;
    if (!moved && hitId) {
      const point = points.find((item) => item.id === hitId);
      togglePointVisibility(point);
    }
  }
  if (cornerDraft && cornerDraft.pointerId === event.pointerId) {
    const x = cornerDraft.canvasX;
    const y = cornerDraft.canvasY;
    cornerDraft = null;
    magnifier = null;
    addCorner(x, y);
  }
  dragId = null;
  magnifier = null;
  draw();
  try {
    canvas.releasePointerCapture(event.pointerId);
  } catch {}
});

canvas.addEventListener("pointercancel", () => {
  panState = null;
  cornerDraft = null;
  dragId = null;
  magnifier = null;
  draw();
});

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY);
  },
  { passive: false }
);

window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
  if (event.key.toLowerCase() === "v") visibleBtn.click();
  if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") {
    event.preventDefault();
    loadPreviousTask();
  }
  if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") {
    event.preventDefault();
    loadNextTask();
  }
});

init();
