import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseByteRange } from "./workbench-music.mjs";

const MANIFEST_NAME = "课件清单.json";
const MAX_SCAN_DEPTH = 6;
const MAX_COURSES = 100;
const MAX_MANIFEST_BYTES = 128 * 1024;
const COURSE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const IMAGE_MIMES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
]);

function courseShelfError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeArtifactPath(value, expected) {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || raw.includes("\\") || path.isAbsolute(raw)) {
    throw courseShelfError("课件清单中的文件路径不合法");
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw courseShelfError("课件清单中的文件越过了课程目录");
  }
  const extension = path.extname(normalized).toLowerCase();
  if (expected === "pdf" && extension !== ".pdf") throw courseShelfError("阅读版必须是 PDF");
  if (expected === "cover" && !IMAGE_MIMES.has(extension)) throw courseShelfError("封面格式不受支持");
  return normalized;
}

async function resolveArtifact(courseDir, relativePath, expected) {
  const normalized = normalizeArtifactPath(relativePath, expected);
  const candidate = path.join(courseDir, ...normalized.split("/"));
  let linkInfo;
  try {
    linkInfo = await fs.lstat(candidate);
  } catch {
    throw courseShelfError(expected === "pdf" ? "课程 PDF 不在支持库中" : "课程封面不在支持库中", 404);
  }
  if (linkInfo.isSymbolicLink()) throw courseShelfError("课件文件不能使用符号链接");
  const real = await fs.realpath(candidate);
  if (!inside(courseDir, real)) throw courseShelfError("课件文件越过了课程目录");
  const info = await fs.stat(real);
  if (!info.isFile()) throw courseShelfError("课件路径不是文件");
  return { path: real, bytes: info.size, modifiedAt: info.mtime.toISOString(), mime: expected === "pdf" ? "application/pdf" : IMAGE_MIMES.get(path.extname(real).toLowerCase()) };
}

async function findManifests(root, current, depth, output) {
  if (depth > MAX_SCAN_DEPTH || output.length >= MAX_COURSES) return;
  const rows = await fs.readdir(current, { withFileTypes: true });
  for (const row of rows) {
    if (output.length >= MAX_COURSES || !row.name || row.name.startsWith(".") || row.isSymbolicLink()) continue;
    const target = path.join(current, row.name);
    if (row.isFile() && row.name === MANIFEST_NAME) {
      output.push(target);
    } else if (row.isDirectory()) {
      await findManifests(root, target, depth + 1, output);
    }
  }
}

function artifactByRole(raw, role, mime) {
  return Array.isArray(raw?.artifacts)
    ? raw.artifacts.find((item) => item && typeof item === "object" && (item.role === role || item.type === mime))
    : null;
}

async function parseCourseManifest(manifestPath) {
  const info = await fs.stat(manifestPath);
  if (info.size > MAX_MANIFEST_BYTES) throw courseShelfError("课件清单过大");
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    throw courseShelfError("课件清单不是有效 JSON");
  }
  const courseId = String(raw?.courseId || "").trim();
  if (!COURSE_ID_RE.test(courseId)) throw courseShelfError("课件清单缺少合格的 courseId");
  const topicId = String(raw?.topicId || "").trim();
  if (!COURSE_ID_RE.test(topicId)) throw courseShelfError("课件清单缺少合格的 topicId");
  const title = String(raw?.title || "").trim();
  if (!title) throw courseShelfError("课件清单缺少课程名称");
  const courseDir = await fs.realpath(path.dirname(manifestPath));
  const pdfArtifact = artifactByRole(raw, "reading", "application/pdf");
  if (!pdfArtifact?.path) throw courseShelfError("课件清单没有声明 PDF 阅读版");
  const pdf = await resolveArtifact(courseDir, pdfArtifact.path, "pdf");
  const coverArtifact = artifactByRole(raw, "cover", "image/png");
  let cover = null;
  if (coverArtifact?.path) {
    try { cover = await resolveArtifact(courseDir, coverArtifact.path, "cover"); } catch { cover = null; }
  }
  const topics = Array.isArray(raw?.topics)
    ? raw.topics.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 16)
    : [];
  return {
    id: courseId,
    topicId,
    title,
    subtitle: String(raw?.subtitle || "").trim(),
    status: String(raw?.status || "ready").trim(),
    version: String(raw?.version || "").trim(),
    createdAt: String(raw?.createdAt || "").trim(),
    language: String(raw?.language || "zh-CN").trim(),
    topics,
    pdf,
    cover,
  };
}

async function discoverCourses(libraryDir) {
  let root;
  try {
    root = await fs.realpath(libraryDir);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("not directory");
  } catch {
    return { root: null, entries: [], warnings: ["支持库学习资料还没连接"] };
  }
  const manifests = [];
  await findManifests(root, root, 0, manifests);
  const entries = [];
  const warnings = [];
  const ids = new Set();
  for (const manifestPath of manifests) {
    try {
      const entry = await parseCourseManifest(manifestPath);
      if (ids.has(entry.id)) {
        warnings.push(`课程编号重复：${entry.id}`);
        continue;
      }
      ids.add(entry.id);
      entries.push(entry);
    } catch (error) {
      warnings.push(`${path.basename(path.dirname(manifestPath))}：${error instanceof Error ? error.message : "课件清单无法读取"}`);
    }
  }
  entries.sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || "") || left.title.localeCompare(right.title, "zh-Hans-CN"));
  return { root, entries, warnings };
}

export async function readCourseShelf(libraryDir) {
  const discovered = await discoverCourses(libraryDir);
  const courses = discovered.entries.map((entry) => ({
    id: entry.id,
    topicId: entry.topicId,
    title: entry.title,
    subtitle: entry.subtitle,
    status: entry.status,
    version: entry.version,
    createdAt: entry.createdAt,
    language: entry.language,
    topics: entry.topics,
    bytes: entry.pdf.bytes,
    modifiedAt: entry.pdf.modifiedAt,
    pdfUrl: `/api/course-shelf/${encodeURIComponent(entry.id)}/pdf`,
    coverUrl: entry.cover ? `/api/course-shelf/${encodeURIComponent(entry.id)}/cover` : null,
  }));
  return { available: courses.length > 0, courses, warnings: discovered.warnings };
}

async function findCourse(libraryDir, courseId) {
  if (!COURSE_ID_RE.test(String(courseId || ""))) throw courseShelfError("课程编号不合法");
  const discovered = await discoverCourses(libraryDir);
  const course = discovered.entries.find((entry) => entry.id === courseId);
  if (!course) throw courseShelfError("找不到这门课", 404);
  return course;
}

export async function streamCourseArtifact(request, response, libraryDir, courseId, kind) {
  const course = await findCourse(libraryDir, courseId);
  const artifact = kind === "pdf" ? course.pdf : kind === "cover" ? course.cover : null;
  if (!artifact) throw courseShelfError(kind === "cover" ? "这门课没有封面" : "找不到课件文件", 404);
  const range = parseByteRange(request.headers.range, artifact.bytes);
  if (range === false) {
    response.statusCode = 416;
    response.setHeader("Content-Range", `bytes */${artifact.bytes}`);
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? artifact.bytes - 1;
  response.statusCode = range ? 206 : 200;
  response.setHeader("Content-Type", artifact.mime);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Length", String(end - start + 1));
  response.setHeader("Cache-Control", "private, max-age=300");
  response.setHeader("Content-Disposition", `${kind === "pdf" ? "inline" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.basename(artifact.path))}`);
  if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${artifact.bytes}`);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(artifact.path, { start, end }).pipe(response);
}
