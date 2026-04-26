const form = document.querySelector("#loadForm");
const input = document.querySelector("#fileInput");
const canvas = document.querySelector("#canvas");
const ctx = canvas.getContext("2d");
const message = document.querySelector("#message");
const imageNameEl = document.querySelector("#imageName");
const metaEl = document.querySelector("#meta");
const pointList = document.querySelector("#pointList");
const imageListEl = document.querySelector("#imageList");
const listMeta = document.querySelector("#listMeta");
const filterInput = document.querySelector("#filterInput");
const saveBtn = document.querySelector("#saveBtn");
const resetBtn = document.querySelector("#resetBtn");
const deletePointBtn = document.querySelector("#deletePointBtn");
const deleteLabelBtn = document.querySelector("#deleteLabelBtn");
const editHint = document.querySelector("#editHint");

ctx.imageSmoothingEnabled = false;

let image = new Image();
let data = null;
let runtime = { appName: "Jiaolong Labeler", authEnabled: true, deploymentMode: "shared", annotation: { cornerCount: 4 } };
let view = { ox: 0, oy: 0, width: 0, height: 0 };
let zoom = 1;
let pan = { x: 0, y: 0 };
let panState = null;
let imageRows = [];
let selectedId = null;
let dragId = null;
let recalibrating = false;
let cornerDraft = null;
let contextClick = null;

let cornerIds = [];

function setMessage(text, show = true) {
  message.textContent = text;
  message.classList.toggle("hidden", !show);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function deriveCornerIds(nextTemplate) {
  const explicitCount = Number(nextTemplate?.cornerCount);
  const fromNames = Array.isArray(nextTemplate?.cornerNames) ? nextTemplate.cornerNames.length : 0;
  const fromConfig = Number(runtime?.annotation?.cornerCount);
  const count = Math.max(1, Number.isFinite(explicitCount) ? explicitCount : fromNames || fromConfig || 4);
  return Array.from({ length: count }, (_, index) => `corner_${index}`);
}

function applyRuntimeUi() {
  const titleEl = document.querySelector("#viewerTitle");
  const descEl = document.querySelector("#viewerDesc");
  const appName = runtime.appName || "Jiaolong Labeler";
  document.title = `${appName} Visualizer`;
  if (titleEl) titleEl.textContent = `${appName} Visualizer`;
  if (descEl) {
    const modeText = runtime.authEnabled ? "shared" : "local";
    descEl.textContent = `输入图片名或 label 名，可视化并编辑关键点标注结果（${modeText} mode）。`;
  }
}

async function loadLabel(name) {
  setMessage("加载中...");
  const payload = await api(`/api/visualize?imageName=${encodeURIComponent(name)}`);
  data = payload;
  cornerIds = deriveCornerIds(data.template);
  selectedId = data.points.find((point) => point.labeled !== false)?.id || data.points[0]?.id || null;
  recalibrating = false;
  image = new Image();
  image.onload = () => {
    resetViewport();
    imageNameEl.textContent = data.imageName;
    updateMeta();
    renderList();
    resizeCanvas();
    setMessage("", false);
    renderImageList();
    updateHint();
  };
  image.onerror = () => {
    setMessage(`图片加载失败：${data.imageName}`);
  };
  image.src = data.imageUrl;
}

async function loadImageList() {
  const payload = await api("/api/visualize/list");
  imageRows = payload.images || [];
  renderImageList();
}

function updateMeta() {
  if (!data) {
    metaEl.textContent = "";
    return;
  }
  const labeled = data.points.filter((point) => point.labeled !== false).length;
  const user = data.updatedBy || "未知";
  const time = data.updatedAt ? ` · ${formatDate(data.updatedAt)}` : "";
  metaEl.textContent = `${labeled}/${data.expectedPointCount} points · 标注者：${user}${time} · source: ${data.source}`;
}

function updateHint() {
  if (!data) {
    editHint.textContent = "加载图片后可以编辑标注。";
    return;
  }
  if (recalibrating) {
    const index = currentCornerIndex();
    const names = cornerIds.map((id, idx) => cornerName(id, `corner_${idx + 1}`)).join("、");
    editHint.textContent =
      index >= 0
        ? `重新标定：请按 ${names} 的顺序，点击第 ${index + 1} 个关键点。`
        : `${cornerIds.length} 个关键点已完成，可以拖动微调后保存。`;
    return;
  }
  editHint.textContent = "左键拖点修改，右键点切换可见性，右键拖拽移动图片。";
}

function renderImageList() {
  const keyword = filterInput.value.trim().toLowerCase();
  const filtered = imageRows.filter((item) => item.imageName.toLowerCase().includes(keyword) || item.labelName.toLowerCase().includes(keyword));
  const annotated = imageRows.filter((item) => item.annotated).length;
  listMeta.textContent = `${annotated}/${imageRows.length} 已标注`;
  imageListEl.innerHTML = "";
  for (const item of filtered) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `image-row ${data?.imageName === item.imageName ? "active" : ""}`;
    const user = item.annotated ? item.updatedBy || "未知" : "未标注";
    row.innerHTML = `
      <span>
        <span class="name">${item.imageName}</span>
        <small class="annotator">标注者：${user}</small>
      </span>
      <span class="badge ${item.annotated ? "" : "pending"}">${item.annotated ? "已标注" : "未标注"}</span>
    `;
    row.addEventListener("click", () => {
      input.value = item.imageName;
      loadAndStoreUrl(item.imageName);
    });
    imageListEl.appendChild(row);
  }
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function resetViewport() {
  zoom = 1;
  pan = { x: 0, y: 0 };
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
  if (!image.naturalWidth) {
    view = { ox: 0, oy: 0, width: rect.width, height: rect.height };
    return;
  }
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight) * zoom;
  view.width = image.naturalWidth * scale;
  view.height = image.naturalHeight * scale;
  view.ox = (rect.width - view.width) / 2 + pan.x;
  view.oy = (rect.height - view.height) / 2 + pan.y;
}

function pointToCanvas(point) {
  return { x: view.ox + point.x * view.width, y: view.oy + point.y * view.height };
}

function canvasToImage(x, y) {
  if (!view.width || !view.height) return { x: 0, y: 0 };
  return {
    x: Math.min(1, Math.max(0, (x - view.ox) / view.width)),
    y: Math.min(1, Math.max(0, (y - view.oy) / view.height))
  };
}

function draw() {
  updateView();
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#20272d";
  ctx.fillRect(0, 0, rect.width, rect.height);
  if (!data || !image.naturalWidth) return;
  ctx.drawImage(image, view.ox, view.oy, view.width, view.height);
  data.points.forEach((point, index) => drawPoint(point, index + 1));
  if (cornerDraft) drawDraftCorner();
}

function drawPoint(point, index) {
  if (point.labeled === false) return;
  const pos = pointToCanvas(point);
  const active = point.id === selectedId;
  ctx.save();
  ctx.globalAlpha = point.visible ? 1 : 0.5;
  ctx.fillStyle = point.visible ? "#22a6f2" : "#b12a34";
  ctx.strokeStyle = active ? "#ffffff" : "#172026";
  ctx.lineWidth = active ? 3 : 1.5;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, active ? 7 : 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = "12px Arial";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.fillStyle = "#ffffff";
  ctx.strokeText(`${index}`, pos.x + 8, pos.y - 8);
  ctx.fillText(`${index}`, pos.x + 8, pos.y - 8);
  ctx.restore();
}

function drawDraftCorner() {
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#f0b429";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cornerDraft.canvasX, cornerDraft.canvasY, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function renderList() {
  pointList.innerHTML = "";
  if (!data) return;
  data.points.forEach((point, index) => {
    const row = document.createElement("div");
    row.className = `point-row ${point.id === selectedId ? "active" : ""}`;
    const visibleText = point.labeled === false ? "未标注" : point.visible ? "可见" : "不可见";
    const visibleClass = point.visible && point.labeled !== false ? "visible" : "hidden-point";
    row.innerHTML = `
      <span class="index">${index + 1}</span>
      <span>
        <strong>${point.name}</strong>
        <small>x=${point.x.toFixed(6)} y=${point.y.toFixed(6)}</small>
      </span>
      <span class="${visibleClass}">${visibleText}</span>
    `;
    row.addEventListener("click", () => {
      selectedId = point.id;
      renderList();
      draw();
    });
    pointList.appendChild(row);
  });
  updateMeta();
}

function hitTest(x, y) {
  let best = null;
  let bestDistance = 14;
  for (const point of data?.points || []) {
    if (point.labeled === false) continue;
    const pos = pointToCanvas(point);
    const distance = Math.hypot(pos.x - x, pos.y - y);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

function clampZoom(value) {
  return Math.min(20, Math.max(0.2, value));
}

function zoomAt(canvasX, canvasY, deltaY) {
  if (!data || !image.naturalWidth) return;
  updateView();
  const before = canvasToImage(canvasX, canvasY);
  const nextZoom = clampZoom(zoom * Math.exp(-deltaY * 0.0012));
  if (nextZoom === zoom) return;
  zoom = nextZoom;
  updateView();
  const nextCanvasX = view.ox + before.x * view.width;
  const nextCanvasY = view.oy + before.y * view.height;
  pan.x += canvasX - nextCanvasX;
  pan.y += canvasY - nextCanvasY;
  draw();
}

function cornerName(id, fallback) {
  const index = Number(String(id).replace("corner_", ""));
  return data?.template?.cornerNames?.[index] || fallback;
}

function currentCornerIndex() {
  return cornerIds.findIndex((id) => !data.points.some((point) => point.id === id && point.labeled !== false));
}

function addCorner(canvasX, canvasY) {
  const index = currentCornerIndex();
  if (index < 0) return;
  const id = cornerIds[index];
  const p = canvasToImage(canvasX, canvasY);
  upsertPoint({ id, name: cornerName(id, `corner_${index + 1}`), x: p.x, y: p.y, visible: true, labeled: true });
  selectedId = id;
  if (currentCornerIndex() < 0) {
    generateInternalPoints();
    recalibrating = false;
  }
  updateHint();
  renderList();
  draw();
}

function upsertPoint(point) {
  const existing = data.points.find((item) => item.id === point.id);
  if (existing) Object.assign(existing, point);
  else data.points.push(point);
  orderPoints();
}

function orderPoints() {
  const order = data.template?.exportOrder || data.points.map((point) => point.id);
  const indexById = new Map(order.map((id, index) => [id, index]));
  data.points.sort((a, b) => (indexById.get(a.id) ?? 9999) - (indexById.get(b.id) ?? 9999));
}

function generateInternalPoints() {
  const corners = cornerIds.map((id) => data.points.find((point) => point.id === id && point.labeled !== false));
  if (corners.some((point) => !point)) return;
  if (!(data.template?.internalPoints || []).length) {
    selectedId = corners[corners.length - 1]?.id || selectedId;
    orderPoints();
    return;
  }
  if (cornerIds.length !== 4) {
    const others = data.points.filter((point) => !point.id.startsWith("corner_") && point.labeled !== false);
    selectedId = others[0]?.id || corners[corners.length - 1]?.id || selectedId;
    orderPoints();
    return;
  }
  const [tl, bl, br, tr] = corners;
  for (const item of data.template?.internalPoints || []) {
    const u = Number(item.u);
    const v = Number(item.v);
    const top = lerpPoint(tl, tr, u);
    const bottom = lerpPoint(bl, br, u);
    const projected = lerpPoint(top, bottom, v);
    upsertPoint({
      id: `kp_${item.id}`,
      name: item.name || `point_${item.id}`,
      x: projected.x,
      y: projected.y,
      visible: true,
      labeled: true
    });
  }
  selectedId = data.points.find((point) => point.id.startsWith("kp_"))?.id || selectedId;
}

function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function toggleVisibility(point) {
  if (!point || point.labeled === false) return;
  point.visible = !point.visible;
  selectedId = point.id;
  renderList();
  draw();
}

async function saveLabel() {
  if (!data) return;
  const labeled = data.points.filter((point) => point.labeled !== false);
  if (cornerIds.some((id) => !labeled.some((point) => point.id === id))) {
    setMessage(`保存前需要先标出 ${cornerIds.length} 个关键点。`);
    return;
  }
  try {
    await api("/api/visualize/save", {
      method: "POST",
      body: JSON.stringify({
        imageName: data.imageName,
        imageWidth: image.naturalWidth,
        imageHeight: image.naturalHeight,
        points: data.points
      })
    });
    setMessage("已保存并覆盖 label 文件。");
    await loadImageList();
  } catch (error) {
    setMessage(error.message);
  }
}

async function deleteLabel() {
  if (!data) return;
  if (!confirm(`确定删除 ${data.imageName} 对应的 label 文件吗？`)) return;
  try {
    await api("/api/visualize/delete", {
      method: "POST",
      body: JSON.stringify({ imageName: data.imageName })
    });
    data.points.forEach((point) => {
      point.labeled = false;
      point.visible = false;
    });
    data.source = "deleted";
    renderList();
    draw();
    setMessage("label 已删除。");
    await loadImageList();
  } catch (error) {
    setMessage(error.message);
  }
}

function deleteSelectedPoint() {
  if (!data || !selectedId) return;
  const point = data.points.find((item) => item.id === selectedId);
  if (!point) return;
  point.labeled = false;
  point.visible = false;
  selectedId = data.points.find((item) => item.labeled !== false)?.id || null;
  renderList();
  draw();
}

function startRecalibration() {
  if (!data) return;
  data.points.forEach((point) => {
    point.labeled = false;
    point.visible = false;
  });
  selectedId = null;
  recalibrating = true;
  cornerDraft = null;
  updateHint();
  renderList();
  draw();
}

async function loadAndStoreUrl(name) {
  try {
    await loadLabel(name);
    const url = new URL(window.location.href);
    url.searchParams.set("file", name);
    history.replaceState(null, "", url.toString());
  } catch (error) {
    setMessage(error.message);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = input.value.trim();
  if (name) loadAndStoreUrl(name);
});

saveBtn.addEventListener("click", saveLabel);
deleteLabelBtn.addEventListener("click", deleteLabel);
deletePointBtn.addEventListener("click", deleteSelectedPoint);
resetBtn.addEventListener("click", startRecalibration);
filterInput.addEventListener("input", renderImageList);

canvas.addEventListener("contextmenu", (event) => event.preventDefault());

canvas.addEventListener("pointerdown", (event) => {
  if (!data) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = hitTest(x, y);

  if (event.button === 2) {
    contextClick = { pointerId: event.pointerId, hitId: hit?.id || null, moved: false };
    panState = { pointerId: event.pointerId, lastX: x, lastY: y };
    canvas.setPointerCapture(event.pointerId);
    return;
  }

  if (event.button !== 0) return;
  if (hit) {
    selectedId = hit.id;
    dragId = hit.id;
    canvas.setPointerCapture(event.pointerId);
    renderList();
    draw();
    return;
  }

  if (recalibrating && currentCornerIndex() >= 0) {
    cornerDraft = { pointerId: event.pointerId, canvasX: x, canvasY: y };
    canvas.setPointerCapture(event.pointerId);
    draw();
  }
});

canvas.addEventListener("pointermove", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  if (panState && panState.pointerId === event.pointerId) {
    const dx = x - panState.lastX;
    const dy = y - panState.lastY;
    if (contextClick) contextClick.moved ||= Math.hypot(dx, dy) > 2;
    pan.x += dx;
    pan.y += dy;
    panState.lastX = x;
    panState.lastY = y;
    draw();
    return;
  }

  if (cornerDraft && cornerDraft.pointerId === event.pointerId) {
    cornerDraft.canvasX = x;
    cornerDraft.canvasY = y;
    draw();
    return;
  }

  if (!dragId) return;
  const point = data.points.find((item) => item.id === dragId);
  if (!point || point.labeled === false) return;
  const next = canvasToImage(x, y);
  point.x = next.x;
  point.y = next.y;
  if (point.id.startsWith("corner_") && cornerIds.every((id) => data.points.some((item) => item.id === id && item.labeled !== false))) {
    generateInternalPoints();
  }
  renderList();
  draw();
});

canvas.addEventListener("pointerup", (event) => {
  if (contextClick?.pointerId === event.pointerId && !contextClick.moved && contextClick.hitId) {
    toggleVisibility(data.points.find((point) => point.id === contextClick.hitId));
  }
  if (cornerDraft?.pointerId === event.pointerId) {
    const { canvasX, canvasY } = cornerDraft;
    cornerDraft = null;
    addCorner(canvasX, canvasY);
  }
  if (panState?.pointerId === event.pointerId) panState = null;
  if (contextClick?.pointerId === event.pointerId) contextClick = null;
  dragId = null;
  try {
    canvas.releasePointerCapture(event.pointerId);
  } catch {}
  draw();
});

canvas.addEventListener("pointercancel", () => {
  panState = null;
  contextClick = null;
  cornerDraft = null;
  dragId = null;
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

const initialFile = new URLSearchParams(window.location.search).get("file");
api("/api/runtime")
  .then((payload) => {
    runtime = { ...runtime, ...payload };
    applyRuntimeUi();
  })
  .catch(() => {});
loadImageList().catch((error) => {
  listMeta.textContent = "加载失败";
  setMessage(error.message);
});
if (initialFile) {
  input.value = initialFile;
  loadLabel(initialFile).catch((error) => setMessage(error.message));
}
