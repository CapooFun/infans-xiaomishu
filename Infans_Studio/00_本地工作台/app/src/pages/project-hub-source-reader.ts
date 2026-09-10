// 项目主页原件阅读器：只把相对 Markdown 链接对上同一清单已登记的 source，
// 页内打开只使用稳定 project + object。未登记本地路径与 .app 等保持不可点。

export type ProjectHubSourceTarget = {
  objectId: string;
  path: string;
  rank: number;
};

export type ProjectHubSourceHrefDecision =
  | { kind: "web"; href: string }
  | { kind: "hash"; href: string }
  | { kind: "registered"; objectId: string; path: string }
  | { kind: "plain"; detail: string };

const MARKDOWN_SOURCE_RE = /\.(?:md|markdown)$/iu;
const WEB_HREF_RE = /^(?:https?:|mailto:)/iu;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/iu;

type HubSourceNode = { id?: string; source?: { path?: string } | null; view?: { kind?: string }; children?: ProjectHubSourceNode[] };
type ProjectHubSourceNode = HubSourceNode;

export function collectProjectHubSourceTargets(hub: {
  worklines?: Array<HubSourceNode>;
  featureTrees?: Array<{
    id?: string;
    source?: { path?: string } | null;
    modules?: Array<{ id?: string; source?: { path?: string } | null; features?: ProjectHubSourceNode[] }>;
  }>;
} | null | undefined): ProjectHubSourceTarget[] {
  const targets: ProjectHubSourceTarget[] = [];
  const add = (objectId: string | undefined, sourcePath: string | undefined, rank: number) => {
    const id = String(objectId || "").trim();
    const path = canonicalHubSourcePath(sourcePath || "");
    if (!id || !path || !MARKDOWN_SOURCE_RE.test(path)) return;
    targets.push({ objectId: id, path, rank });
  };
  for (const workline of hub?.worklines || []) {
    add(workline.id, workline.source?.path, workline.view?.kind === "featureTree" ? 1 : 0);
  }
  const visitFeature = (feature: ProjectHubSourceNode | undefined) => {
    if (!feature) return;
    add(feature.id, feature.source?.path, 2);
    for (const child of feature.children || []) visitFeature(child);
  };
  for (const tree of hub?.featureTrees || []) {
    add(tree.id, tree.source?.path, 2);
    for (const module of tree.modules || []) {
      add(module.id, module.source?.path, 2);
      for (const feature of module.features || []) visitFeature(feature);
    }
  }
  return targets;
}

export function canonicalHubSourcePath(value: string): string {
  return posixNormalize(decodeHrefPath(stripFragmentAndQuery(value)), { keepAbsolute: false });
}

export function resolveProjectHubSourceHref(
  href: string,
  options: { sourcePath?: string; sources?: Iterable<ProjectHubSourceTarget> } = {},
): ProjectHubSourceHrefDecision {
  const raw = String(href || "").trim();
  if (!raw) return { kind: "plain", detail: "空链接" };
  if (raw.startsWith("#") && !raw.startsWith("#/")) return { kind: "hash", href: raw };
  if (WEB_HREF_RE.test(raw)) return { kind: "web", href: raw };
  if (raw.startsWith("//") || SCHEME_RE.test(raw)) return { kind: "plain", detail: raw };
  const sourcePath = String(options.sourcePath || "");
  const resolved = looksLikeAbsoluteLocalPath(raw)
    ? canonicalHubSourcePath(raw)
    : resolveAgainstSource(sourcePath, raw);
  const detail = resolved || raw;
  if (!resolved || looksLikeAbsoluteLocalPath(raw) || !isProjectRelativeSourcePath(resolved)) {
    return { kind: "plain", detail };
  }
  const match = matchRegisteredHubSource(resolved, options.sources);
  if (!match) return { kind: "plain", detail };
  return { kind: "registered", objectId: match.objectId, path: match.path };
}

function matchRegisteredHubSource(resolved: string, sources: Iterable<ProjectHubSourceTarget> | undefined): ProjectHubSourceTarget | null {
  let best: ProjectHubSourceTarget | null = null;
  for (const source of sources || []) {
    if (!source?.objectId || canonicalHubSourcePath(source.path) !== resolved) continue;
    if (!best || source.rank < best.rank) best = source;
  }
  return best;
}

function resolveAgainstSource(sourcePath: string, href: string): string {
  const relative = decodeHrefPath(stripFragmentAndQuery(href)).replaceAll("\\", "/");
  if (!relative || relative.startsWith("/") || WINDOWS_DRIVE_RE.test(relative)) return canonicalHubSourcePath(relative);
  const base = dirnamePosix(String(sourcePath || "").replaceAll("\\", "/"));
  return posixNormalize(base ? `${base}/${relative}` : relative, { keepAbsolute: false });
}

function stripFragmentAndQuery(value: string): string {
  return String(value || "").trim().replace(/[?#].*$/u, "");
}

function decodeHrefPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

function looksLikeAbsoluteLocalPath(value: string): boolean {
  const text = String(value || "").trim();
  return text.startsWith("/") || WINDOWS_DRIVE_RE.test(text) || text.startsWith("\\\\");
}

function isProjectRelativeSourcePath(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !WINDOWS_DRIVE_RE.test(value) && !value.includes("://");
}

function dirnamePosix(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/u, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? "" : trimmed.slice(0, index);
}

function posixNormalize(value: string, { keepAbsolute }: { keepAbsolute: boolean }): string {
  const slash = String(value || "").replaceAll("\\", "/");
  const absolute = keepAbsolute && slash.startsWith("/");
  const parts: string[] = [];
  for (const part of slash.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const normalized = parts.join("/");
  return absolute ? `/${normalized}` : normalized;
}

export function projectHubSourceBodyMatches(
  body: { projectId?: string; objectId?: string } | null | undefined,
  projectId: string,
  objectId: string,
): boolean {
  return Boolean(body && body.projectId === projectId && body.objectId === objectId);
}
