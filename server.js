const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(ROOT, "data");
const IMAGE_DIR = path.join(ROOT, "images", "total");
const PUBLIC_DIR = path.join(ROOT, "public");
const LABEL_DIR = path.join(ROOT, "labels");
const EXPORT_DIR = path.join(ROOT, "exports");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const TEMPLATE_PATH = path.join(DATA_DIR, "template.json");

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const sessions = new Map();
let writeQueue = Promise.resolve();

async function ensureStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(LABEL_DIR, { recursive: true });
  await fsp.mkdir(EXPORT_DIR, { recursive: true });
  try {
    await fsp.access(STORE_PATH);
  } catch {
    await writeJson(STORE_PATH, { users: [], annotations: {}, claims: {} });
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

function withStore(mutator) {
  const run = writeQueue.catch(() => {}).then(async () => {
    const store = await readJson(STORE_PATH, { users: [], annotations: {}, claims: {} });
    const result = await mutator(store);
    await writeJson(STORE_PATH, store);
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), actual);
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length === 2)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function currentUser(req) {
  const sid = parseCookies(req).sid;
  return sid ? sessions.get(sid) : null;
}

async function imageList() {
  const files = await fsp.readdir(IMAGE_DIR);
  return files.filter((file) => IMAGE_EXTS.has(path.extname(file).toLowerCase())).sort();
}

function safeImagePath(name) {
  const base = path.basename(name);
  const full = path.join(IMAGE_DIR, base);
  if (!full.startsWith(IMAGE_DIR)) return null;
  return full;
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8"
  }[ext] || "application/octet-stream";
}

function normalizePoint(point) {
  return {
    id: String(point.id),
    name: String(point.name || point.id),
    x: Number(point.x),
    y: Number(point.y),
    visible: point.visible !== false
  };
}

function labelPathForImage(imageName) {
  return path.join(LABEL_DIR, `${path.parse(path.basename(imageName)).name}.txt`);
}

function orderedPointDefs(template) {
  const cornerNames = template.cornerNames || ["top_left", "top_right", "bottom_right", "bottom_left"];
  const corners = cornerNames.map((name, index) => ({ id: `corner_${index}`, name: String(name || `corner_${index + 1}`) }));
  const internals = (template.internalPoints || []).map((point, index) => ({
    id: `kp_${point.id || index + 1}`,
    name: String(point.name || point.id || `kp_${index + 1}`)
  }));
  const byId = new Map([...corners, ...internals].map((point) => [point.id, point]));
  if (Array.isArray(template.exportOrder) && template.exportOrder.length) {
    return template.exportOrder
      .map((id) => byId.get(String(id)))
      .filter(Boolean);
  }
  return [...corners, ...internals];
}

function orderedAnnotationPoints(annotation, template) {
  const defs = orderedPointDefs(template);
  const byId = new Map((annotation.points || []).map((point) => [String(point.id), normalizePoint(point)]));
  return defs.map((def) => {
    const point = byId.get(def.id);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { ...def, x: 0, y: 0, visible: false, labeled: false };
    }
    return { ...point, id: def.id, name: def.name, labeled: true };
  });
}

function annotationToYolo(annotation, template) {
  const points = orderedAnnotationPoints(annotation, template);
  const visiblePoints = points.filter((point) => point.visible && Number.isFinite(point.x) && Number.isFinite(point.y));
  const labeledPoints = points.filter((point) => point.labeled !== false && Number.isFinite(point.x) && Number.isFinite(point.y));
  const boxPoints = visiblePoints.length ? visiblePoints : labeledPoints;
  if (!boxPoints.length) throw new Error("没有可导出的点位");
  const xs = boxPoints.map((point) => point.x);
  const ys = boxPoints.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const w = maxX - minX;
  const h = maxY - minY;
  const coords = points.flatMap((point) => [point.x, point.y, point.labeled === false ? 0 : point.visible ? 2 : 1]);
  return [Number(template.classId || 0).toString(), ...[cx, cy, w, h, ...coords].map((value) => Number(value).toFixed(6))].join(" ");
}

function parseYoloLabel(imageName, text, template, fallback = {}) {
  const values = text.trim().split(/\s+/).map(Number);
  if (values.length < 5) return null;
  const defs = orderedPointDefs(template);
  const points = [];
  let offset = 5;
  for (const def of defs) {
    const x = values[offset];
    const y = values[offset + 1];
    const visibility = values[offset + 2];
    offset += 3;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(visibility) || visibility === 0) continue;
    points.push({ ...def, x, y, visible: visibility === 2 });
  }
  return {
    imageName,
    status: fallback.status || "done",
    points,
    imageWidth: fallback.imageWidth,
    imageHeight: fallback.imageHeight,
    updatedBy: fallback.updatedBy,
    updatedAt: fallback.updatedAt,
    source: "label"
  };
}

async function annotationForImage(imageName, store, template) {
  const fallback = store.annotations?.[imageName] || { imageName, status: "draft", points: [] };
  try {
    const text = await fsp.readFile(labelPathForImage(imageName), "utf8");
    return parseYoloLabel(imageName, text, template, fallback) || fallback;
  } catch {
    return fallback;
  }
}

async function writeLabelForAnnotation(annotation, template) {
  await fsp.mkdir(LABEL_DIR, { recursive: true });
  await fsp.writeFile(labelPathForImage(annotation.imageName), `${annotationToYolo(annotation, template)}\n`);
}

async function exportLabels() {
  const store = await readJson(STORE_PATH, { annotations: {} });
  const template = await readJson(TEMPLATE_PATH, { classId: 0 });
  let count = 0;
  await fsp.mkdir(LABEL_DIR, { recursive: true });
  for (const [imageName, annotation] of Object.entries(store.annotations || {})) {
    if (annotation.status !== "done") continue;
    await writeLabelForAnnotation(annotation, template);
    count += 1;
  }
  const summary = { exportedAt: new Date().toISOString(), labelDir: "labels", count };
  await writeJson(path.join(EXPORT_DIR, "last-export.json"), summary);
  return summary;
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/register" && req.method === "POST") {
    const { username, password } = await readBody(req);
    if (!username || !password || String(password).length < 4) return send(res, 400, { error: "用户名和至少 4 位密码是必填项" });
    const user = await withStore((store) => {
      const cleanName = String(username).trim();
      if (!cleanName) throw new Error("用户名不能为空");
      if (store.users.some((item) => item.username === cleanName)) throw new Error("用户名已存在");
      const created = { id: crypto.randomUUID(), username: cleanName, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
      store.users.push(created);
      return { id: created.id, username: created.username };
    }).catch((error) => ({ error: error.message }));
    if (user.error) return send(res, 409, user);
    const sid = crypto.randomUUID();
    sessions.set(sid, user);
    return send(res, 200, { user }, { "Set-Cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/` });
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    const { username, password } = await readBody(req);
    const store = await readJson(STORE_PATH, { users: [] });
    const found = store.users.find((user) => user.username === String(username || "").trim());
    if (!found || !verifyPassword(password || "", found.passwordHash)) return send(res, 401, { error: "用户名或密码不正确" });
    const user = { id: found.id, username: found.username };
    const sid = crypto.randomUUID();
    sessions.set(sid, user);
    return send(res, 200, { user }, { "Set-Cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/` });
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    const sid = parseCookies(req).sid;
    if (sid) sessions.delete(sid);
    return send(res, 200, { ok: true }, { "Set-Cookie": "sid=; Max-Age=0; Path=/" });
  }

  if (url.pathname === "/api/visualize" && req.method === "GET") {
    const rawName = String(url.searchParams.get("imageName") || "").trim();
    if (!rawName) return send(res, 400, { error: "缺少图片文件名" });
    const imageBase = path.parse(path.basename(rawName)).name;
    const images = await imageList();
    const imageName = images.find((name) => path.parse(name).name === imageBase || name === path.basename(rawName));
    if (!imageName) return send(res, 404, { error: `找不到图片：${rawName}` });

    const [store, template] = await Promise.all([
      readJson(STORE_PATH, { annotations: {}, claims: {} }),
      readJson(TEMPLATE_PATH, { internalPoints: [] })
    ]);
    const annotation = await annotationForImage(imageName, store, template);
    const orderedPoints = orderedAnnotationPoints(annotation, template);
    return send(res, 200, {
      imageName,
      imageUrl: `/images/${encodeURIComponent(imageName)}`,
      source: annotation.source || "store",
      updatedBy: annotation.updatedBy || null,
      updatedAt: annotation.updatedAt || null,
      points: orderedPoints,
      expectedPointCount: orderedPointDefs(template).length,
      template
    });
  }

  if (url.pathname === "/api/visualize/save" && req.method === "POST") {
    const body = await readBody(req);
    const imageName = path.basename(String(body.imageName || ""));
    if (!imageName || !Array.isArray(body.points)) return send(res, 400, { error: "缺少图片名或点位数据" });
    const images = await imageList();
    if (!images.includes(imageName)) return send(res, 404, { error: "图片不存在" });
    const template = await readJson(TEMPLATE_PATH, { internalPoints: [] });
    const annotation = {
      imageName,
      status: "done",
      points: body.points
        .filter((point) => point.labeled !== false)
        .map(normalizePoint),
      imageWidth: Number(body.imageWidth),
      imageHeight: Number(body.imageHeight),
      updatedBy: "visualizer",
      updatedAt: new Date().toISOString()
    };
    if (!annotation.points.length) return send(res, 400, { error: "没有可保存的点" });
    await writeLabelForAnnotation(annotation, template);
    await withStore((store) => {
      store.annotations[imageName] = annotation;
      delete store.claims[imageName];
    });
    return send(res, 200, { ok: true, annotation });
  }

  if (url.pathname === "/api/visualize/delete" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const imageName = path.basename(String(body.imageName || ""));
    if (!imageName) return send(res, 400, { error: "缺少图片名" });
    await fsp.unlink(labelPathForImage(imageName)).catch(() => {});
    await withStore((store) => {
      delete store.annotations[imageName];
      delete store.claims[imageName];
    });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/visualize/list" && req.method === "GET") {
    const [images, store] = await Promise.all([
      imageList(),
      readJson(STORE_PATH, { annotations: {} })
    ]);
    const labelFiles = new Set(
      (await fsp.readdir(LABEL_DIR).catch(() => []))
        .filter((file) => file.endsWith(".txt"))
        .map((file) => path.parse(file).name)
    );
    return send(res, 200, {
      images: images.map((imageName) => {
        const annotation = store.annotations?.[imageName] || {};
        const annotated = labelFiles.has(path.parse(imageName).name);
        return {
          imageName,
          labelName: `${path.parse(imageName).name}.txt`,
          annotated,
          updatedBy: annotation.updatedBy || null,
          updatedAt: annotation.updatedAt || null
        };
      })
    });
  }

  const user = currentUser(req);
  if (!user) return send(res, 401, { error: "请先登录" });

  if (url.pathname === "/api/me" && req.method === "GET") return send(res, 200, { user });

  if (url.pathname === "/api/template" && req.method === "GET") {
    return send(res, 200, await readJson(TEMPLATE_PATH, { internalPoints: [] }));
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    const [images, store] = await Promise.all([imageList(), readJson(STORE_PATH, { annotations: {}, claims: {} })]);
    const labelFiles = await fsp.readdir(LABEL_DIR).catch(() => []);
    const done = labelFiles.filter((file) => file.endsWith(".txt")).length;
    const mine = Object.values(store.claims || {}).filter((claim) => claim.userId === user.id).length;
    const completedByMe = Object.values(store.annotations || {}).filter((annotation) => annotation.updatedBy === user.username && fs.existsSync(labelPathForImage(annotation.imageName))).length;
    return send(res, 200, { total: images.length, done, remaining: Math.max(images.length - done, 0), mine, completedByMe });
  }

  if (url.pathname === "/api/task" && req.method === "GET") {
    const imageName = path.basename(String(url.searchParams.get("imageName") || ""));
    if (!imageName) return send(res, 400, { error: "缺少图片名" });
    const [images, store, template] = await Promise.all([
      imageList(),
      readJson(STORE_PATH, { annotations: {}, claims: {} }),
      readJson(TEMPLATE_PATH, { internalPoints: [] })
    ]);
    if (!images.includes(imageName)) return send(res, 404, { error: "图片不存在" });
    return send(res, 200, { task: { imageName, annotation: await annotationForImage(imageName, store, template) } });
  }

  if (url.pathname === "/api/task/release" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const imageName = body.imageName ? path.basename(String(body.imageName)) : null;
    if (!imageName) return send(res, 400, { error: "缺少图片名" });
    await withStore((store) => {
      const claim = store.claims?.[imageName];
      if (claim?.userId === user.id) delete store.claims[imageName];
      const annotation = store.annotations?.[imageName];
      if (annotation && (!annotation.points || annotation.points.length === 0) && !fs.existsSync(labelPathForImage(imageName))) {
        delete store.annotations[imageName];
      }
    });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/task/next" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const skipImageName = body.skipImageName ? path.basename(String(body.skipImageName)) : null;
    const images = await imageList();
    const template = await readJson(TEMPLATE_PATH, { internalPoints: [] });
    const task = await withStore((store) => {
      const own = Object.entries(store.claims).find(
        ([imageName, claim]) => imageName !== skipImageName && claim.userId === user.id && store.annotations[imageName]?.status !== "done"
      );
      const imageName =
        own?.[0] ||
        images.find((name) => name !== skipImageName && !store.annotations[name] && !store.claims[name]) ||
        images.find((name) => name !== skipImageName && fs.existsSync(labelPathForImage(name)));
      if (!imageName) return null;
      store.claims[imageName] = { userId: user.id, username: user.username, claimedAt: new Date().toISOString() };
      store.annotations[imageName] ||= { imageName, status: "draft", points: [], updatedBy: user.username, updatedAt: new Date().toISOString() };
      return { imageName };
    });
    if (task) {
      const store = await readJson(STORE_PATH, { annotations: {}, claims: {} });
      task.annotation = await annotationForImage(task.imageName, store, template);
    }
    return send(res, 200, { task });
  }

  if (url.pathname === "/api/annotation" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.imageName || !Array.isArray(body.points)) return send(res, 400, { error: "缺少图片名或点位数据" });
    const template = await readJson(TEMPLATE_PATH, { internalPoints: [] });
    const saved = await withStore((store) => {
      const status = body.status === "done" ? "done" : "draft";
      store.annotations[body.imageName] = {
        imageName: body.imageName,
        status,
        points: body.points.map(normalizePoint),
        imageWidth: Number(body.imageWidth),
        imageHeight: Number(body.imageHeight),
        updatedBy: user.username,
        updatedAt: new Date().toISOString()
      };
      store.claims[body.imageName] = { userId: user.id, username: user.username, claimedAt: store.claims[body.imageName]?.claimedAt || new Date().toISOString() };
      if (status === "done") delete store.claims[body.imageName];
      return store.annotations[body.imageName];
    });
    if (body.writeLabel !== false && saved.points.length) {
      await writeLabelForAnnotation(saved, template);
      await withStore((store) => {
        delete store.claims[body.imageName];
      });
    }
    return send(res, 200, { annotation: saved });
  }

  if (url.pathname === "/api/export" && req.method === "POST") {
    return send(res, 200, await exportLabels());
  }

  return send(res, 404, { error: "接口不存在" });
}

async function serveStatic(req, res, url) {
  if (url.pathname.startsWith("/images/")) {
    const file = safeImagePath(decodeURIComponent(url.pathname.replace("/images/", "")));
    if (!file || !fs.existsSync(file)) return send(res, 404, "Not found");
    res.writeHead(200, { "Content-Type": mimeFor(file), "Cache-Control": "public, max-age=3600" });
    return fs.createReadStream(file).pipe(res);
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) return send(res, 404, "Not found");
  res.writeHead(200, { "Content-Type": mimeFor(full) });
  fs.createReadStream(full).pipe(res);
}

async function main() {
  await ensureStore();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      return await serveStatic(req, res, url);
    } catch (error) {
      console.error(error);
      return send(res, 500, { error: error.message || "服务器错误" });
    }
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Four Keypoint Labeler running at http://localhost:${PORT}`);
  });
}

main();
