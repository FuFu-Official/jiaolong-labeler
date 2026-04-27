const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = __dirname;
const CONFIG_DIR = path.join(ROOT, "config");
const DATA_DIR = path.join(ROOT, "data");
const IMAGE_DIR = path.join(ROOT, "images");
const PUBLIC_DIR = path.join(ROOT, "public");
const LABEL_DIR = path.join(ROOT, "labels");
const EXPORT_DIR = path.join(ROOT, "exports");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const TEMPLATE_PATH = path.join(DATA_DIR, "template.json");
const APP_CONFIG_PATH = path.join(CONFIG_DIR, "app-config.json");

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const sessions = new Map();
let writeQueue = Promise.resolve();

const DEFAULT_APP_CONFIG = {
  appName: "Jiaolong Labeler",
  deploymentMode: "local",
  localUser: {
    id: "local-user",
    username: "local"
  },
  server: {
    host: "127.0.0.1",
    port: 3000
  },
  annotation: {
    cornerCount: 4,
    templateFile: "data/template.json"
  }
};

function toPositiveInt(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function asString(value, fallback) {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function normalizeDeploymentMode(value) {
  return String(value || "").toLowerCase() === "shared" ? "shared" : "local";
}

function normalizeLabelFormat(rawFormat = {}) {
  const source = typeof rawFormat === "object" && rawFormat ? rawFormat : {};
  const type = String(source.type || "").trim().toLowerCase() || "yolo_pose";
  const defaults = type === "xy_pairs"
    ? { includeClassId: false, includeBox: false, includeVisibility: false }
    : { includeClassId: true, includeBox: true, includeVisibility: true };

  return {
    type,
    includeClassId: source.includeClassId === undefined ? defaults.includeClassId : source.includeClassId !== false,
    includeBox: source.includeBox === undefined ? defaults.includeBox : source.includeBox !== false,
    includeVisibility: source.includeVisibility === undefined ? defaults.includeVisibility : source.includeVisibility !== false
  };
}

function defaultCornerNames(count) {
  const seeded = ["top_left", "bottom_left", "bottom_right", "top_right"];
  return Array.from({ length: count }, (_, index) => seeded[index] || `corner_${index + 1}`);
}

function normalizeAppConfig(rawConfig = {}) {
  const config = typeof rawConfig === "object" && rawConfig ? rawConfig : {};
  const deploymentMode = normalizeDeploymentMode(process.env.APP_MODE || config.deploymentMode || DEFAULT_APP_CONFIG.deploymentMode);
  const hostFallback = deploymentMode === "shared" ? "0.0.0.0" : "127.0.0.1";
  const serverConfig = config.server || {};
  const annotationConfig = config.annotation || {};
  const localUserConfig = config.localUser || {};

  return {
    appName: asString(config.appName, DEFAULT_APP_CONFIG.appName),
    deploymentMode,
    localUser: {
      id: asString(localUserConfig.id, DEFAULT_APP_CONFIG.localUser.id),
      username: asString(localUserConfig.username, DEFAULT_APP_CONFIG.localUser.username)
    },
    server: {
      host: asString(process.env.HOST, asString(serverConfig.host, hostFallback)),
      port: toPositiveInt(process.env.PORT, toPositiveInt(serverConfig.port, DEFAULT_APP_CONFIG.server.port))
    },
    annotation: {
      cornerCount: toPositiveInt(annotationConfig.cornerCount, DEFAULT_APP_CONFIG.annotation.cornerCount),
      templateFile: asString(annotationConfig.templateFile, DEFAULT_APP_CONFIG.annotation.templateFile)
    }
  };
}

function resolveTemplatePath(appConfig) {
  const requested = appConfig?.annotation?.templateFile || DEFAULT_APP_CONFIG.annotation.templateFile;
  const full = path.resolve(ROOT, requested);
  if (full === ROOT || full.startsWith(`${ROOT}${path.sep}`)) return full;
  return TEMPLATE_PATH;
}

function normalizeTemplate(rawTemplate = {}, appConfig) {
  const configuredCornerCount = toPositiveInt(appConfig?.annotation?.cornerCount, DEFAULT_APP_CONFIG.annotation.cornerCount);
  const source = typeof rawTemplate === "object" && rawTemplate ? rawTemplate : {};
  const rawCornerNames = Array.isArray(source.cornerNames)
    ? source.cornerNames.map((name) => String(name || "").trim()).filter(Boolean)
    : [];
  const cornerCount = Math.max(configuredCornerCount, rawCornerNames.length, 1);
  const fallbackNames = defaultCornerNames(cornerCount);
  const cornerNames = fallbackNames.map((fallback, index) => rawCornerNames[index] || fallback);

  const internalPoints = Array.isArray(source.internalPoints)
    ? source.internalPoints.map((point, index) => ({
        id: String(point?.id || index + 1),
        name: String(point?.name || `kp_${index + 1}`),
        u: Number(point?.u),
        v: Number(point?.v)
      }))
    : [];

  const allIds = [
    ...cornerNames.map((_, index) => `corner_${index}`),
    ...internalPoints.map((point) => `kp_${point.id}`)
  ];
  const validIds = new Set(allIds);

  const ordered = [];
  if (Array.isArray(source.exportOrder)) {
    for (const id of source.exportOrder.map((item) => String(item))) {
      if (validIds.has(id) && !ordered.includes(id)) ordered.push(id);
    }
  }
  for (const id of allIds) {
    if (!ordered.includes(id)) ordered.push(id);
  }

  return {
    classId: Number.isFinite(Number(source.classId)) ? Number(source.classId) : 0,
    cornerNames,
    exportOrder: ordered,
    internalPoints,
    labelFormat: normalizeLabelFormat(source.labelFormat),
    cornerCount: cornerNames.length,
    keypointCount: cornerNames.length + internalPoints.length
  };
}

async function readAppConfig() {
  return normalizeAppConfig(await readJson(APP_CONFIG_PATH, DEFAULT_APP_CONFIG));
}

async function readTemplate(appConfig) {
  const templatePath = resolveTemplatePath(appConfig);
  const fallback = {
    classId: 0,
    cornerNames: defaultCornerNames(toPositiveInt(appConfig?.annotation?.cornerCount, DEFAULT_APP_CONFIG.annotation.cornerCount)),
    exportOrder: [],
    internalPoints: [],
    labelFormat: { type: "yolo_pose" }
  };
  return normalizeTemplate(await readJson(templatePath, fallback), appConfig);
}

function isAuthEnabled(appConfig) {
  return appConfig?.deploymentMode === "shared";
}

function currentLocalUser(appConfig) {
  return {
    id: appConfig?.localUser?.id || DEFAULT_APP_CONFIG.localUser.id,
    username: appConfig?.localUser?.username || DEFAULT_APP_CONFIG.localUser.username
  };
}

async function ensureStore() {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(LABEL_DIR, { recursive: true });
  await fsp.mkdir(EXPORT_DIR, { recursive: true });
  try {
    await fsp.access(APP_CONFIG_PATH);
  } catch {
    await writeJson(APP_CONFIG_PATH, DEFAULT_APP_CONFIG);
  }
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

function currentUser(req, appConfig) {
  if (!isAuthEnabled(appConfig)) return currentLocalUser(appConfig);
  const sid = parseCookies(req).sid;
  return sid ? sessions.get(sid) : null;
}

function normalizeImageName(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw) return null;
  const normalized = path.posix.normalize(raw).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("..")) return null;
  return normalized;
}

function resolvePathInDir(rootDir, relativePath) {
  const normalized = normalizeImageName(relativePath);
  if (!normalized) return null;
  const fullPath = path.resolve(rootDir, ...normalized.split("/"));
  if (fullPath === rootDir || fullPath.startsWith(`${rootDir}${path.sep}`)) {
    return { normalized, fullPath };
  }
  return null;
}

function labelNameForImage(imageName) {
  const normalized = normalizeImageName(imageName);
  if (!normalized) return null;
  const parsed = path.posix.parse(normalized);
  return parsed.dir ? `${parsed.dir}/${parsed.name}.txt` : `${parsed.name}.txt`;
}

function legacyLabelNameForImage(imageName) {
  const normalized = normalizeImageName(imageName);
  if (!normalized) return null;
  const parsed = path.posix.parse(path.posix.basename(normalized));
  return `${parsed.name}.txt`;
}

function labelPathsForImage(imageName) {
  const names = [labelNameForImage(imageName), legacyLabelNameForImage(imageName)].filter(Boolean);
  const uniqueNames = [...new Set(names)];
  const paths = [];
  for (const relativeLabelName of uniqueNames) {
    const fullPath = path.resolve(LABEL_DIR, ...relativeLabelName.split("/"));
    if (fullPath === LABEL_DIR || fullPath.startsWith(`${LABEL_DIR}${path.sep}`)) {
      paths.push(fullPath);
    }
  }
  return paths;
}

function hasLabelForImage(imageName) {
  return labelPathsForImage(imageName).some((labelPath) => fs.existsSync(labelPath));
}

function resolveImageNameFromInput(inputName, images) {
  const normalized = normalizeImageName(inputName);
  if (normalized && images.includes(normalized)) {
    return { imageName: normalized };
  }

  if (normalized) {
    const parsed = path.posix.parse(normalized);
    const sameDirMatches = images.filter((name) => {
      const imageParsed = path.posix.parse(name);
      return imageParsed.dir === parsed.dir && imageParsed.name === parsed.name;
    });
    if (sameDirMatches.length === 1) return { imageName: sameDirMatches[0] };
    if (sameDirMatches.length > 1) {
      return { error: `存在多个同名图片，请使用完整文件名：${sameDirMatches.slice(0, 5).join("、")}` };
    }
  }

  const raw = String(inputName || "").trim().replace(/\\/g, "/");
  const rawBase = path.posix.basename(raw);
  const rawStem = path.posix.parse(rawBase).name;
  if (!rawStem) return { error: "缺少图片文件名" };

  const matches = images.filter((name) => {
    const base = path.posix.basename(name);
    return base === rawBase || path.posix.parse(base).name === rawStem;
  });

  if (!matches.length) return { error: `找不到图片：${inputName}` };
  if (matches.length > 1) {
    return { error: `存在多个同名图片，请使用相对路径：${matches.slice(0, 5).join("、")}` };
  }
  return { imageName: matches[0] };
}

async function imageList() {
  const images = [];

  async function walk(currentDir, currentPrefix) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = currentPrefix ? `${currentPrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      images.push(relPath);
    }
  }

  try {
    await walk(IMAGE_DIR, "");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  return images.sort((a, b) => a.localeCompare(b));
}

async function labelFileList() {
  const labels = [];

  async function walk(currentDir, currentPrefix) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = currentPrefix ? `${currentPrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".txt")) continue;
      labels.push(relPath);
    }
  }

  try {
    await walk(LABEL_DIR, "");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  return labels.sort((a, b) => a.localeCompare(b));
}

function removeImageExtension(imagePath) {
  const parsed = path.posix.parse(imagePath);
  return parsed.dir ? `${parsed.dir}/${parsed.name}` : parsed.name;
}

function safeImagePath(name) {
  const resolved = resolvePathInDir(IMAGE_DIR, name);
  return resolved ? resolved.fullPath : null;
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
  return labelPathsForImage(imageName)[0] || null;
}

function orderedPointDefs(template) {
  const cornerNames = Array.isArray(template.cornerNames) && template.cornerNames.length
    ? template.cornerNames
    : defaultCornerNames(toPositiveInt(template.cornerCount, DEFAULT_APP_CONFIG.annotation.cornerCount));
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

function requiredLabeledPoints(points, labelFormat) {
  return labelFormat.includeVisibility ? points : points.filter((point) => point.labeled !== false);
}

function pointsForBox(points) {
  const visiblePoints = points.filter((point) => point.visible && Number.isFinite(point.x) && Number.isFinite(point.y));
  const labeledPoints = points.filter((point) => point.labeled !== false && Number.isFinite(point.x) && Number.isFinite(point.y));
  return visiblePoints.length ? visiblePoints : labeledPoints;
}

function boundingBoxValues(points) {
  const boxPoints = pointsForBox(points);
  if (!boxPoints.length) throw new Error("没有可导出的点位");
  const xs = boxPoints.map((point) => point.x);
  const ys = boxPoints.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return [(minX + maxX) / 2, (minY + maxY) / 2, maxX - minX, maxY - minY];
}

function serializeAnnotation(annotation, template) {
  const points = orderedAnnotationPoints(annotation, template);
  const labelFormat = normalizeLabelFormat(template.labelFormat);
  const exportPoints = requiredLabeledPoints(points, labelFormat);
  if (!exportPoints.length) throw new Error("没有可导出的点位");
  if (!labelFormat.includeVisibility && exportPoints.length !== points.length) {
    throw new Error("当前标签格式不支持缺失点，请先补全所有导出点位");
  }

  const values = [];
  if (labelFormat.includeClassId) values.push(Number(template.classId || 0));
  if (labelFormat.includeBox) values.push(...boundingBoxValues(points));

  for (const point of points) {
    if (!labelFormat.includeVisibility && point.labeled === false) {
      throw new Error("当前标签格式不支持缺失点，请先补全所有导出点位");
    }
    values.push(point.x, point.y);
    if (labelFormat.includeVisibility) values.push(point.labeled === false ? 0 : point.visible ? 2 : 1);
  }

  return values.map((value, index) => {
    if (labelFormat.includeClassId && index === 0) return String(Math.trunc(value));
    return Number(value).toFixed(6);
  }).join(" ");
}

function parseSerializedAnnotation(imageName, text, template, fallback = {}) {
  const values = text.trim().split(/\s+/).map(Number);
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;

  const defs = orderedPointDefs(template);
  const labelFormat = normalizeLabelFormat(template.labelFormat);
  let offset = 0;
  if (labelFormat.includeClassId) {
    if (values.length < 1) return null;
    offset += 1;
  }
  if (labelFormat.includeBox) {
    if (values.length < offset + 4) return null;
    offset += 4;
  }

  const stride = labelFormat.includeVisibility ? 3 : 2;
  if (values.length < offset + defs.length * stride) return null;

  const points = [];
  for (const def of defs) {
    const x = values[offset];
    const y = values[offset + 1];
    const visibility = labelFormat.includeVisibility ? values[offset + 2] : 2;
    offset += stride;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(visibility) || visibility === 0) continue;
    points.push({ ...def, x, y, visible: labelFormat.includeVisibility ? visibility === 2 : true });
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
  for (const labelPath of labelPathsForImage(imageName)) {
    try {
      const text = await fsp.readFile(labelPath, "utf8");
      return parseSerializedAnnotation(imageName, text, template, fallback) || fallback;
    } catch {}
  }
  return fallback;
}

async function writeLabelForAnnotation(annotation, template) {
  const labelPath = labelPathForImage(annotation.imageName);
  if (!labelPath) throw new Error("无效图片名，无法写入标注文件");
  await fsp.mkdir(path.dirname(labelPath), { recursive: true });
  await fsp.writeFile(labelPath, `${serializeAnnotation(annotation, template)}\n`);
}

async function exportLabels(appConfig) {
  const store = await readJson(STORE_PATH, { annotations: {} });
  const template = await readTemplate(appConfig);
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
  const appConfig = await readAppConfig();
  const template = await readTemplate(appConfig);
  const runtime = {
    appName: appConfig.appName,
    deploymentMode: appConfig.deploymentMode,
    authEnabled: isAuthEnabled(appConfig),
    annotation: {
      cornerCount: template.cornerCount,
      keypointCount: template.keypointCount,
      labelFormat: template.labelFormat,
      templateFile: appConfig.annotation.templateFile
    }
  };

  if (url.pathname === "/api/runtime" && req.method === "GET") {
    return send(res, 200, runtime);
  }

  if (url.pathname === "/api/register" && req.method === "POST") {
    if (!isAuthEnabled(appConfig)) {
      return send(res, 400, { error: "当前是本地模式，不需要注册。", runtime });
    }
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
    return send(res, 200, { user, runtime }, { "Set-Cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/` });
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    if (!isAuthEnabled(appConfig)) {
      return send(res, 200, { user: currentLocalUser(appConfig), runtime });
    }
    const { username, password } = await readBody(req);
    const store = await readJson(STORE_PATH, { users: [] });
    const found = store.users.find((user) => user.username === String(username || "").trim());
    if (!found || !verifyPassword(password || "", found.passwordHash)) return send(res, 401, { error: "用户名或密码不正确" });
    const user = { id: found.id, username: found.username };
    const sid = crypto.randomUUID();
    sessions.set(sid, user);
    return send(res, 200, { user, runtime }, { "Set-Cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/` });
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    if (!isAuthEnabled(appConfig)) return send(res, 200, { ok: true, runtime });
    const sid = parseCookies(req).sid;
    if (sid) sessions.delete(sid);
    return send(res, 200, { ok: true }, { "Set-Cookie": "sid=; Max-Age=0; Path=/" });
  }

  if (url.pathname === "/api/visualize" && req.method === "GET") {
    const rawName = String(url.searchParams.get("imageName") || "").trim();
    if (!rawName) return send(res, 400, { error: "缺少图片文件名" });
    const images = await imageList();
    const resolved = resolveImageNameFromInput(rawName, images);
    if (resolved.error) return send(res, 404, { error: resolved.error });
    const imageName = resolved.imageName;

    const store = await readJson(STORE_PATH, { annotations: {}, claims: {} });
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
    const imageName = normalizeImageName(body.imageName);
    if (!imageName || !Array.isArray(body.points)) return send(res, 400, { error: "缺少图片名或点位数据" });
    const images = await imageList();
    if (!images.includes(imageName)) return send(res, 404, { error: "图片不存在" });
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
    const imageName = normalizeImageName(body.imageName);
    if (!imageName) return send(res, 400, { error: "缺少图片名" });
    await Promise.all(labelPathsForImage(imageName).map((labelPath) => fsp.unlink(labelPath).catch(() => {})));
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
    const labelFiles = new Set(await labelFileList());
    const labelBasePaths = new Set(Array.from(labelFiles).map((name) => removeImageExtension(name)));
    return send(res, 200, {
      images: images.map((imageName) => {
        const annotation = store.annotations?.[imageName] || {};
        const labelName = labelNameForImage(imageName);
        const legacyLabelName = legacyLabelNameForImage(imageName);
        const imageBasePath = removeImageExtension(imageName);
        const legacyBasePath = removeImageExtension(path.posix.basename(imageName));
        const annotated = Boolean(
          (labelName && labelFiles.has(labelName)) ||
          (legacyLabelName && labelFiles.has(legacyLabelName)) ||
          labelBasePaths.has(imageBasePath) ||
          labelBasePaths.has(legacyBasePath)
        );
        return {
          imageName,
          labelName: labelName || "",
          annotated,
          updatedBy: annotation.updatedBy || null,
          updatedAt: annotation.updatedAt || null
        };
      })
    });
  }

  const user = currentUser(req, appConfig);
  if (!user) return send(res, 401, { error: "请先登录" });

  if (url.pathname === "/api/me" && req.method === "GET") return send(res, 200, { user, runtime });

  if (url.pathname === "/api/template" && req.method === "GET") {
    return send(res, 200, template);
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    const [images, store] = await Promise.all([imageList(), readJson(STORE_PATH, { annotations: {}, claims: {} })]);
    const done = images.filter((imageName) => hasLabelForImage(imageName)).length;
    const mine = Object.values(store.claims || {}).filter((claim) => claim.userId === user.id).length;
    const completedByMe = Object.values(store.annotations || {}).filter((annotation) => annotation.updatedBy === user.username && hasLabelForImage(annotation.imageName)).length;
    return send(res, 200, { total: images.length, done, remaining: Math.max(images.length - done, 0), mine, completedByMe });
  }

  if (url.pathname === "/api/task" && req.method === "GET") {
    const imageName = normalizeImageName(url.searchParams.get("imageName"));
    if (!imageName) return send(res, 400, { error: "缺少图片名" });
    const [images, store] = await Promise.all([imageList(), readJson(STORE_PATH, { annotations: {}, claims: {} })]);
    if (!images.includes(imageName)) return send(res, 404, { error: "图片不存在" });
    return send(res, 200, { task: { imageName, annotation: await annotationForImage(imageName, store, template) } });
  }

  if (url.pathname === "/api/task/release" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const imageName = normalizeImageName(body.imageName);
    if (!imageName) return send(res, 400, { error: "缺少图片名" });
    await withStore((store) => {
      const claim = store.claims?.[imageName];
      if (claim?.userId === user.id) delete store.claims[imageName];
      const annotation = store.annotations?.[imageName];
      if (annotation && (!annotation.points || annotation.points.length === 0) && !hasLabelForImage(imageName)) {
        delete store.annotations[imageName];
      }
    });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/task/next" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const skipImageName = normalizeImageName(body.skipImageName);
    const images = await imageList();
    const task = await withStore((store) => {
      const own = Object.entries(store.claims).find(
        ([imageName, claim]) => imageName !== skipImageName && claim.userId === user.id && store.annotations[imageName]?.status !== "done"
      );
      const imageName =
        own?.[0] ||
        images.find((name) => name !== skipImageName && !store.annotations[name] && !store.claims[name]) ||
        images.find((name) => name !== skipImageName && hasLabelForImage(name));
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
    const imageName = normalizeImageName(body.imageName);
    if (!imageName || !Array.isArray(body.points)) return send(res, 400, { error: "缺少图片名或点位数据" });
    const images = await imageList();
    if (!images.includes(imageName)) return send(res, 404, { error: "图片不存在" });
    const saved = await withStore((store) => {
      const status = body.status === "done" ? "done" : "draft";
      store.annotations[imageName] = {
        imageName,
        status,
        points: body.points.map(normalizePoint),
        imageWidth: Number(body.imageWidth),
        imageHeight: Number(body.imageHeight),
        updatedBy: user.username,
        updatedAt: new Date().toISOString()
      };
      store.claims[imageName] = { userId: user.id, username: user.username, claimedAt: store.claims[imageName]?.claimedAt || new Date().toISOString() };
      if (status === "done") delete store.claims[imageName];
      return store.annotations[imageName];
    });
    if (body.writeLabel !== false && saved.points.length) {
      await writeLabelForAnnotation(saved, template);
      await withStore((store) => {
        delete store.claims[imageName];
      });
    }
    return send(res, 200, { annotation: saved });
  }

  if (url.pathname === "/api/export" && req.method === "POST") {
    return send(res, 200, await exportLabels(appConfig));
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
  const appConfig = await readAppConfig();
  const host = appConfig.server.host;
  const port = appConfig.server.port;
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
  server.listen(port, host, () => {
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    console.log(`${appConfig.appName} running at http://${displayHost}:${port} (${appConfig.deploymentMode})`);
  });
}

main();
