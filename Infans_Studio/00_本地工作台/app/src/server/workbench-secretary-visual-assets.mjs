import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DIR_WORKBENCH } from "./vault-paths.mjs";

export const SECRETARY_VISUAL_ASSET_SCHEMA_VERSION = 1;
export const SECRETARY_VISUAL_ASSET_PROJECT_ID = "secretary-visual-assets";
export const SECRETARY_VISUAL_ASSET_ROOT = path.posix.join(DIR_WORKBENCH, "10_设计", "50_视觉资产", "小秘书");
export const SECRETARY_VISUAL_ASSET_MANIFEST_PATH = path.posix.join(SECRETARY_VISUAL_ASSET_ROOT, "asset-manifest.v1.json");
export const SECRETARY_VISUAL_ASSET_CURATION_PATH = path.posix.join(SECRETARY_VISUAL_ASSET_ROOT, "curation.v1.json");

const ASSET_CLASSES = new Set(["source", "master", "derivative", "cache"]);
const STAGES = new Set(["candidate", "approved", "deprecated", "missing"]);
const GOVERNANCE_STATUSES = new Set(["formal", "candidate", "legacy-reference", "needs-confirmation"]);
const REFERENCE_STATUSES = new Set(["referenced", "unreferenced", "unknown"]);
const PHASES = new Set(["pre-migration", "formal-baseline-migrated"]);
export const CORE_VISUAL_SUBJECTS = new Set(["小秘书", "小秘书视觉系统", "银月", "梅凝"]);
const CURATION_STATES = new Set(["selected", "archive", "fallback", "retired"]);
const RUNTIME_PREFIXES = [
  "00_本地工作台/app/public/",
  "00_本地工作台/app/native/",
  "00_本地工作台/chrome-extension-发给秘书/",
  "00_本地工作台/codex-marketplace/plugins/yinyue-read-aloud/assets/",
  "00_本地工作台/小秘书.app/Contents/Resources/",
];

function isRelativeVaultPath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\0") || value.includes("\\")) return false;
  return !value.split("/").includes("..");
}

function countBy(rows, key) {
  return Object.fromEntries([...new Set(rows.map((row) => row[key]))]
    .sort((left, right) => String(left).localeCompare(String(right), "zh-CN"))
    .map((value) => [value, rows.filter((row) => row[key] === value).length]));
}

export async function validateSecretaryVisualAssetManifest(manifest, options = {}) {
  const errors = [];
  const warnings = [];
  const vaultRoot = options.vaultRoot ? path.resolve(options.vaultRoot) : null;
  const requireFiles = options.requireFiles !== false;

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: ["清单必须是 JSON 对象"], warnings };
  }
  if (manifest.schemaVersion !== SECRETARY_VISUAL_ASSET_SCHEMA_VERSION) errors.push("schemaVersion 必须为 1");
  if (manifest.project?.id !== SECRETARY_VISUAL_ASSET_PROJECT_ID) errors.push("project.id 必须是 secretary-visual-assets");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(manifest.snapshotDate || "")) errors.push("snapshotDate 必须是 YYYY-MM-DD");
  if (!PHASES.has(manifest.phase)) errors.push("phase 只能是 pre-migration 或 formal-baseline-migrated");
  if (!Array.isArray(manifest.assets)) errors.push("assets 必须是数组");
  if (errors.length) return { ok: false, errors, warnings };

  const ids = new Set();
  const paths = new Set();
  const assets = manifest.assets;
  for (const [index, asset] of assets.entries()) {
    const label = asset?.assetId || `assets[${index}]`;
    if (!/^secvis-[a-z0-9-]+-[a-f0-9]{12}$/u.test(asset?.assetId || "")) errors.push(`${label}: assetId 格式无效`);
    if (ids.has(asset?.assetId)) errors.push(`${label}: assetId 重复`);
    ids.add(asset?.assetId);
    if (typeof asset?.subject !== "string" || !asset.subject) errors.push(`${label}: subject 缺失`);
    if (typeof asset?.kind !== "string" || !asset.kind) errors.push(`${label}: kind 缺失`);
    if (!ASSET_CLASSES.has(asset?.assetClass)) errors.push(`${label}: assetClass 无效`);
    if (!STAGES.has(asset?.stage)) errors.push(`${label}: stage 无效`);
    if (!GOVERNANCE_STATUSES.has(asset?.governanceStatus)) errors.push(`${label}: governanceStatus 无效`);
    if (!REFERENCE_STATUSES.has(asset?.referenceStatus)) errors.push(`${label}: referenceStatus 无效`);
    if (!/^sha256:[a-f0-9]{64}$/u.test(asset?.hash || "")) errors.push(`${label}: hash 必须是完整 SHA-256`);
    if (!Array.isArray(asset?.currentPaths) || !asset.currentPaths.length) errors.push(`${label}: currentPaths 不能为空`);
    if (!isRelativeVaultPath(asset?.canonicalPath)) errors.push(`${label}: canonicalPath 必须是 Vault 相对路径`);
    if (!asset?.currentPaths?.includes(asset.canonicalPath)) errors.push(`${label}: canonicalPath 必须存在于 currentPaths`);
    if (asset?.plannedCanonicalPath !== null && !isRelativeVaultPath(asset?.plannedCanonicalPath)) errors.push(`${label}: plannedCanonicalPath 无效`);
    if (asset?.plannedCanonicalPath && !asset.plannedCanonicalPath.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`)) {
      errors.push(`${label}: plannedCanonicalPath 必须位于官方视觉目录`);
    }
    if (!Array.isArray(asset?.files) || asset.files.length !== asset?.currentPaths?.length) errors.push(`${label}: files 必须逐项覆盖 currentPaths`);
    else if (asset.files.some((file) => !asset.currentPaths.includes(file?.path))) errors.push(`${label}: files 含未登记路径`);
    if (!Array.isArray(asset?.derivatives)) errors.push(`${label}: derivatives 必须是数组`);
    if (!Array.isArray(asset?.consumers)) errors.push(`${label}: consumers 必须是数组`);
    if (!asset?.provenance || typeof asset.provenance !== "object") errors.push(`${label}: provenance 缺失`);
    if (!asset?.privacy || typeof asset.privacy !== "object") errors.push(`${label}: privacy 缺失`);
    if (asset?.lastVerified !== manifest.snapshotDate) errors.push(`${label}: lastVerified 必须与 snapshotDate 一致`);
    if (asset.governanceStatus === "formal" && asset.stage !== "approved") errors.push(`${label}: formal 必须对应 approved`);
    if (asset.governanceStatus !== "formal" && asset.stage === "approved") errors.push(`${label}: 非 formal 不得标 approved`);
    for (const currentPath of asset.currentPaths || []) {
      if (!isRelativeVaultPath(currentPath)) errors.push(`${label}: currentPaths 含无效路径 ${currentPath}`);
      if (paths.has(currentPath)) errors.push(`${label}: 路径被多个资产重复登记 ${currentPath}`);
      paths.add(currentPath);
      if (vaultRoot && requireFiles) {
        try {
          const absolute = path.resolve(vaultRoot, currentPath);
          const relative = path.relative(vaultRoot, absolute);
          if (relative.startsWith("..") || path.isAbsolute(relative)) errors.push(`${label}: 路径逃离 Vault ${currentPath}`);
          else if (!(await fs.stat(absolute)).isFile()) errors.push(`${label}: 路径不是文件 ${currentPath}`);
          else {
            const actualHash = crypto.createHash("sha256").update(await fs.readFile(absolute)).digest("hex");
            if (`sha256:${actualHash}` !== asset.hash) errors.push(`${label}: 文件摘要漂移 ${currentPath}`);
          }
        } catch {
          errors.push(`${label}: 文件缺失 ${currentPath}`);
        }
      }
    }
    for (const consumer of asset.consumers || []) {
      if (!isRelativeVaultPath(consumer?.path)) errors.push(`${label}: 消费者路径无效`);
      if (vaultRoot && requireFiles && consumer?.path) {
        try { await fs.access(path.resolve(vaultRoot, consumer.path)); } catch { errors.push(`${label}: 消费者文件缺失 ${consumer.path}`); }
      }
    }
  }

  if (manifest.phase === "formal-baseline-migrated") {
    for (const asset of assets.filter((item) => item.governanceStatus === "formal")) {
      if (!asset.canonicalPath.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`)) errors.push(`${asset.assetId}: 正式母版尚未切到官方源目录`);
      if (asset.canonicalPath !== asset.plannedCanonicalPath) errors.push(`${asset.assetId}: 正式母版与计划官方路径不一致`);
      if (asset.migration?.status !== "formal-baseline-migrated" || asset.migration?.oldToNewVerified !== true) {
        errors.push(`${asset.assetId}: 正式母版缺少迁移回读证明`);
      }
      if (typeof asset.migration?.consumersUpdated !== "boolean") {
        errors.push(`${asset.assetId}: 正式母版缺少消费者更新状态`);
      } else if (asset.migration.consumersUpdated === true) {
        if (asset.migration.consumerStatus !== "runtime-mirrors-and-consumers-verified") {
          errors.push(`${asset.assetId}: 消费者已更新必须带运行镜像与引用回读状态`);
        }
      } else if (asset.migration.consumerStatus !== "explicit-exception"
        || !Array.isArray(asset.migration.consumerExceptions)
        || !asset.migration.consumerExceptions.length) {
        errors.push(`${asset.assetId}: 消费者未更新必须登记明确例外`);
      }
    }
  }

  for (const asset of assets) {
    for (const derivativeId of asset.derivatives || []) {
      if (derivativeId === asset.assetId) errors.push(`${asset.assetId}: derivatives 不得指向自身`);
      else if (!ids.has(derivativeId)) errors.push(`${asset.assetId}: 派生目标不存在 ${derivativeId}`);
    }
    if (asset.derivedFrom && !ids.has(asset.derivedFrom)) errors.push(`${asset.assetId}: derivedFrom 不存在 ${asset.derivedFrom}`);
  }

  const expectedSummary = {
    assetCount: assets.length,
    fileCount: assets.reduce((sum, asset) => sum + asset.currentPaths.length, 0),
    byGovernanceStatus: countBy(assets, "governanceStatus"),
    byAssetClass: countBy(assets, "assetClass"),
    byReferenceStatus: countBy(assets, "referenceStatus"),
  };
  if (JSON.stringify(manifest.summary) !== JSON.stringify(expectedSummary)) errors.push("summary 与 assets 实际统计不一致");
  if (!assets.some((asset) => asset.governanceStatus === "formal")) warnings.push("当前没有任何 formal 资产");
  if (assets.some((asset) => asset.governanceStatus !== "formal" && asset.provenance?.reviewStatus === "confirmed")) {
    warnings.push("存在来源已确认但视觉状态尚未正式的资产；这不是错误，仍需 Capoo 审美验收");
  }
  return { ok: errors.length === 0, errors, warnings, summary: expectedSummary };
}

export function validateSecretaryVisualAssetCuration(curation, manifest) {
  const errors = [];
  if (!curation || typeof curation !== "object" || Array.isArray(curation)) return { ok: false, errors: ["取舍快照必须是 JSON 对象"] };
  if (curation.schemaVersion !== 1) errors.push("取舍快照 schemaVersion 必须为 1");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(curation.snapshotDate || "")) errors.push("取舍快照 snapshotDate 必须是 YYYY-MM-DD");
  if (!Array.isArray(curation.decisions)) errors.push("取舍快照 decisions 必须是数组");
  const assetIds = new Set(manifest.assets.map((asset) => asset.assetId));
  const seen = new Set();
  for (const decision of curation.decisions || []) {
    if (!assetIds.has(decision?.assetId)) errors.push(`取舍快照含未知素材 ${decision?.assetId || "(missing)"}`);
    if (seen.has(decision?.assetId)) errors.push(`取舍快照重复登记 ${decision.assetId}`);
    seen.add(decision?.assetId);
    if (!CURATION_STATES.has(decision?.state)) errors.push(`${decision?.assetId || "(missing)"}: state 无效`);
    if (typeof decision?.useClass !== "string" || !decision.useClass) errors.push(`${decision?.assetId || "(missing)"}: useClass 缺失`);
  }
  if (seen.size !== assetIds.size) errors.push(`取舍快照未覆盖全部素材：${seen.size}/${assetIds.size}`);
  return { ok: errors.length === 0, errors };
}

export function deriveSecretaryVisualAssetCatalog(manifest, curation = null) {
  const decisions = new Map((curation?.decisions || []).map((decision) => [decision.assetId, decision]));
  const assets = manifest.assets.map((asset) => {
    const decision = decisions.get(asset.assetId) || null;
    const archived = decision?.state === "archive" || decision?.state === "retired";
    return {
      assetId: asset.assetId,
      subject: asset.subject,
      kind: decision?.useClass || asset.kind,
      originalKind: asset.kind,
      curationState: decision?.state || "unreviewed",
      curationReason: decision?.reason || null,
      assetClass: asset.assetClass,
      stage: archived ? "deprecated" : asset.stage,
      governanceStatus: archived ? "legacy-reference" : asset.governanceStatus,
      referenceStatus: asset.referenceStatus,
      canonicalPath: asset.canonicalPath,
      officialPath: asset.canonicalPath.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`) ? asset.canonicalPath : asset.plannedCanonicalPath,
      currentPaths: asset.currentPaths,
      runtimePaths: asset.currentPaths.filter(isSecretaryVisualRuntimePath),
      plannedCanonicalPath: asset.plannedCanonicalPath,
      hash: asset.hash,
      files: asset.files,
      width: asset.files[0]?.width ?? null,
      height: asset.files[0]?.height ?? null,
      hasAlpha: asset.files[0]?.hasAlpha ?? null,
      consumers: asset.consumers,
      derivatives: asset.derivatives,
      derivedFrom: asset.derivedFrom || null,
      provenance: asset.provenance,
      privacy: asset.privacy,
      migration: asset.migration,
      review: asset.review,
      groupRelated: !CORE_VISUAL_SUBJECTS.has(asset.subject),
      needsCapooReview: asset.governanceStatus !== "formal" || asset.review?.needsCapoo === true,
    };
  });
  const summary = {
    assetCount: assets.length,
    fileCount: assets.reduce((sum, asset) => sum + asset.currentPaths.length, 0),
    byGovernanceStatus: countBy(assets, "governanceStatus"),
    byAssetClass: countBy(assets, "assetClass"),
    byReferenceStatus: countBy(assets, "referenceStatus"),
    byCurationState: countBy(assets, "curationState"),
    byUseClass: countBy(assets, "kind"),
  };
  return {
    schemaVersion: 1,
    project: { ...manifest.project, name: "小秘书" },
    snapshotDate: manifest.snapshotDate,
    phase: manifest.phase,
    readOnly: true,
    source: SECRETARY_VISUAL_ASSET_MANIFEST_PATH,
    curationSource: curation ? SECRETARY_VISUAL_ASSET_CURATION_PATH : null,
    summary,
    facets: {
      subjects: countBy(assets, "subject"),
      kinds: countBy(assets, "kind"),
      statuses: countBy(assets, "governanceStatus"),
      devices: Object.fromEntries([...new Set(assets.flatMap((asset) => asset.consumers.map((consumer) => consumer.device)).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right, "zh-CN"))
        .map((device) => [device, assets.filter((asset) => asset.consumers.some((consumer) => consumer.device === device)).length])),
    },
    assets,
  };
}

export function isSecretaryVisualRuntimePath(value) {
  return RUNTIME_PREFIXES.some((prefix) => String(value || "").startsWith(prefix));
}

export function previewSecretaryVisualReplacement(manifest, assetId) {
  const asset = manifest.assets.find((item) => item.assetId === assetId);
  if (!asset) throw Object.assign(new Error("找不到这件小秘书视觉资产"), { status: 404, code: "SECRETARY_VISUAL_ASSET_NOT_FOUND" });
  if (asset.governanceStatus !== "formal" || !asset.canonicalPath.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`)) {
    throw Object.assign(new Error("替换预览只允许选择已经迁入官方源目录的正式母版"), { status: 409, code: "SECRETARY_VISUAL_FORMAL_SOURCE_REQUIRED" });
  }
  return {
    schemaVersion: 1,
    mode: "preview-only",
    writePerformed: false,
    requiresCapooConfirmation: true,
    direction: "official-source-to-runtime-only",
    assetId: asset.assetId,
    source: { path: asset.canonicalPath, hash: asset.hash },
    targets: asset.currentPaths.filter((item) => item !== asset.canonicalPath && isSecretaryVisualRuntimePath(item)).map((target) => ({
      path: target,
      currentHash: asset.hash,
      expectedHash: asset.hash,
      status: "in-sync",
    })),
    consumers: asset.consumers,
    blockedOperations: ["runtime-to-source", "write-consumer", "delete-old-path", "promote-non-formal"],
  };
}

export async function loadSecretaryVisualAssetCatalog(vaultRoot, options = {}) {
  const lock = path.resolve(vaultRoot, SECRETARY_VISUAL_ASSET_ROOT, ".infans/art-intake.lock");
  for (let attempt = 0; await fs.access(lock).then(() => true, () => false); attempt++) {
    if (attempt >= 80) throw Object.assign(new Error("素材库正在写回，请稍后刷新"), { status: 409, code: "ART_INTAKE_BUSY" });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const absolute = path.resolve(vaultRoot, SECRETARY_VISUAL_ASSET_MANIFEST_PATH);
  const manifest = JSON.parse(await fs.readFile(absolute, "utf8"));
  const validation = await validateSecretaryVisualAssetManifest(manifest, { vaultRoot, requireFiles: options.requireFiles !== false });
  if (!validation.ok) {
    const error = new Error(`小秘书视觉资产清单无效：${validation.errors.join("；")}`);
    error.code = "SECRETARY_VISUAL_ASSET_MANIFEST_INVALID";
    throw error;
  }
  let curation = null;
  try {
    curation = JSON.parse(await fs.readFile(path.resolve(vaultRoot, SECRETARY_VISUAL_ASSET_CURATION_PATH), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const curationValidation = curation ? validateSecretaryVisualAssetCuration(curation, manifest) : { ok: true, errors: [] };
  if (!curationValidation.ok) {
    const error = new Error(`小秘书视觉资产取舍快照无效：${curationValidation.errors.join("；")}`);
    error.code = "SECRETARY_VISUAL_ASSET_CURATION_INVALID";
    throw error;
  }
  return { manifest, validation, curation, curationValidation, catalog: deriveSecretaryVisualAssetCatalog(manifest, curation) };
}
