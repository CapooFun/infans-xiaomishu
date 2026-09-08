import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileCode2, FileText, GitBranch, Search, ShieldCheck, Users } from "lucide-react";
import { Empty, Kicker } from "../page-shared";
import { PageTrail } from "../shell/PageNavigation";
import { navigationHref } from "../shell/page-navigation-model";
import "./GovernanceMapView.css";

type GovernanceStatus = "current" | "candidate" | "compatibility" | "historical";

type GovernanceDocument = {
  id: string;
  path: string;
  title: string;
  description: string;
  responsibility: string;
  notResponsible: string;
  layer: string;
  kind: string;
  status: GovernanceStatus;
  authorityKey: string | null;
  maintainers: string[];
  readers: string[];
  impacts: string[];
  parentIds: string[];
  implementsIds: string[];
  evidenceForIds: string[];
  childIds: string[];
  implementedByIds: string[];
  evidenceIds: string[];
  placement: string;
  reviewNote: string;
  sourceExists: boolean;
};

type GovernanceIssue = { code: string; severity: "error"; message: string; documentId: string | null; path: string | null };
type GovernanceSnapshot = {
  title: string;
  updatedAt: string | null;
  sourcePolicy: string;
  registryPath: string;
  documents: GovernanceDocument[];
  issues: GovernanceIssue[];
  summary: { documents: number; issues: number; byStatus: Record<string, number>; byLayer: Record<string, number> };
};

const LAYERS = [
  { id: "entry", label: "入口", caption: "先从哪里读" },
  { id: "core", label: "核心治理", caption: "共同底线" },
  { id: "routing", label: "任务路由", caption: "按任务找原件" },
  { id: "specialty", label: "专项规则", caption: "只约束对应主题" },
  { id: "product", label: "产品原件", caption: "项目与模块事实" },
  { id: "adapter", label: "平台适配", caption: "加载共同规则" },
  { id: "implementation", label: "实现检查", caption: "代码与校验" },
  { id: "evidence", label: "证据历史", caption: "证明与追溯" },
] as const;

const STATUS_META: Record<GovernanceStatus, { label: string; note: string }> = {
  current: { label: "现行", note: "当前有效" },
  candidate: { label: "候选", note: "尚待确认" },
  compatibility: { label: "兼容", note: "保留旧入口" },
  historical: { label: "历史", note: "只供追溯，不指导当前工作" },
};

const RELATIONS = [
  { key: "parentIds", label: "上位规则" },
  { key: "childIds", label: "下位／专项" },
  { key: "implementsIds", label: "落实这些规则" },
  { key: "implementedByIds", label: "对应实现" },
  { key: "evidenceForIds", label: "证明这些事项" },
  { key: "evidenceIds", label: "对应证据" },
] as const;

function includesSearch(document: GovernanceDocument, query: string) {
  if (!query) return true;
  const haystack = [document.title, document.path, document.description, document.responsibility, document.kind, ...document.impacts, ...document.maintainers].join(" ").toLocaleLowerCase("zh-CN");
  return haystack.includes(query.toLocaleLowerCase("zh-CN"));
}

function StatusBadge({ status }: { status: GovernanceStatus }) {
  return <span className={`governance-status is-${status}`} title={STATUS_META[status].note}>{STATUS_META[status].label}</span>;
}

function ChipList({ items, empty = "未单列" }: { items: string[]; empty?: string }) {
  return items.length ? <div className="governance-chips">{items.map((item) => <span key={item}>{item}</span>)}</div> : <p className="governance-muted">{empty}</p>;
}

function RelationGroup({ label, ids, byId, onSelect }: {
  label: string;
  ids: string[];
  byId: Map<string, GovernanceDocument>;
  onSelect: (id: string) => void;
}) {
  if (!ids.length) return null;
  return <section className="governance-relation-group">
    <h4>{label}<span>{ids.length}</span></h4>
    <div>{ids.map((id) => {
      const target = byId.get(id);
      return <button type="button" key={id} onClick={() => onSelect(id)} disabled={!target}>
        <GitBranch size={13} aria-hidden /><span>{target?.title || id}</span>{target ? <StatusBadge status={target.status} /> : null}
      </button>;
    })}</div>
  </section>;
}

export function GovernanceMapView({ projectId, projectName, displayMode = false, onBack }: { projectId: string; projectName: string; displayMode?: boolean; onBack: () => void }) {
  const [snapshot, setSnapshot] = useState<GovernanceSnapshot | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [layer, setLayer] = useState("all");
  const [statuses, setStatuses] = useState<Set<GovernanceStatus>>(() => new Set(Object.keys(STATUS_META) as GovernanceStatus[]));
  const [selectedId, setSelectedId] = useState("vault-agent-entry");
  const deferredQuery = useDeferredValue(query.trim());

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/workbench-governance${displayMode ? "?display=1" : ""}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error || "读取规则总览失败");
        setSnapshot(payload);
      })
      .catch((reason) => {
        if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "读取规则总览失败");
      });
    return () => controller.abort();
  }, [displayMode]);

  const byId = useMemo(() => new Map(snapshot?.documents.map((document) => [document.id, document]) || []), [snapshot]);
  const visibleDocuments = useMemo(() => (snapshot?.documents || []).filter((document) =>
    (layer === "all" || document.layer === layer) && statuses.has(document.status) && includesSearch(document, deferredQuery)
  ), [deferredQuery, layer, snapshot, statuses]);
  const visibleByLayer = useMemo(() => new Map(LAYERS.map((item) => [item.id, visibleDocuments.filter((document) => document.layer === item.id)])), [visibleDocuments]);
  const selected = visibleDocuments.find((document) => document.id === selectedId) || visibleDocuments[0] || snapshot?.documents[0] || null;
  const selectedIssues = snapshot?.issues.filter((item) => item.documentId === selected?.id || item.path === selected?.path) || [];

  const toggleStatus = (status: GovernanceStatus) => {
    setStatuses((current) => {
      const next = new Set(current);
      if (next.has(status) && next.size > 1) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  return <div className="project-workbench governance-map">
    <PageTrail items={[
      { label: projectName, href: navigationHref("/projects", { project: projectId, view: "home" }), onSelect: onBack, history: "replace" },
      { label: "规则总览" },
    ]} />

    <header className="governance-hero">
      <div>
        <Kicker>权威文件，仅供只读</Kicker>
        <h2>规则总览</h2>
        <p>{snapshot?.sourcePolicy || "规则正文仍在各自原件；这里负责把层级、边界和落地关系照亮。"}</p>
      </div>
      <div className={`governance-health${snapshot?.issues.length ? " has-issues" : ""}`}>
        {snapshot?.issues.length ? <AlertTriangle size={20} /> : <ShieldCheck size={20} />}
        <strong>{snapshot ? `${snapshot.summary.documents} 项已登记` : "正在核对登记"}</strong>
        <span>{snapshot?.issues.length ? `${snapshot.issues.length} 项需要处理` : "原件、权威键与关系检查通过"}</span>
      </div>
    </header>

    <section className="governance-toolbar" aria-label="筛选规则">
      <label className="governance-search"><Search size={15} aria-hidden /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索规则、职责、模块或路径" /><span>{visibleDocuments.length} 项</span></label>
      <div className="governance-status-filters" aria-label="状态筛选">
        {(Object.keys(STATUS_META) as GovernanceStatus[]).map((status) => <button type="button" className={statuses.has(status) ? "is-active" : ""} aria-pressed={statuses.has(status)} onClick={() => toggleStatus(status)} key={status}><i className={`is-${status}`} />{STATUS_META[status].label}<span>{snapshot?.summary.byStatus[status] || 0}</span></button>)}
      </div>
    </section>

    {error ? <div className="governance-load-error" role="alert"><AlertTriangle size={18} /><span>{error}</span></div> : null}

    <div className="governance-layout">
      <aside className="governance-spine" aria-label="规则层级">
        <div className="governance-layer-tabs">
          <button type="button" className={layer === "all" ? "is-active" : ""} onClick={() => setLayer("all")}><span>全部层级</span><b>{snapshot?.summary.documents || 0}</b></button>
          {LAYERS.map((item, index) => <button type="button" className={layer === item.id ? "is-active" : ""} onClick={() => setLayer(item.id)} key={item.id}><i>{String(index + 1).padStart(2, "0")}</i><span><strong>{item.label}</strong><small>{item.caption}</small></span><b>{snapshot?.summary.byLayer[item.id] || 0}</b></button>)}
        </div>

        <div className="governance-document-list">
          {LAYERS.map((layerItem) => {
            const documents = visibleByLayer.get(layerItem.id) || [];
            if (!documents.length) return null;
            return <section key={layerItem.id}>
              <header><span>{layerItem.label}</span><small>{documents.length}</small></header>
              {documents.map((document) => <button type="button" className={selected?.id === document.id ? "is-selected" : ""} aria-pressed={selected?.id === document.id} onClick={() => setSelectedId(document.id)} key={document.id}>
                <span className="governance-file-icon" aria-hidden>{document.layer === "implementation" ? <FileCode2 size={14} /> : <FileText size={14} />}</span>
                <span><strong>{document.title}</strong><small>{document.kind}</small></span>
                <StatusBadge status={document.status} />
              </button>)}
            </section>;
          })}
          {!snapshot ? <Empty>正在读取规则登记表…</Empty> : !visibleDocuments.length ? <Empty>没有符合当前筛选的条目。</Empty> : null}
        </div>
      </aside>

      <main className="governance-detail" aria-live="polite">
        {selected ? <>
          <header className="governance-detail-head">
            <div><div className="governance-eyebrow"><span>{selected.kind}</span><StatusBadge status={selected.status} /></div><h3>{selected.title}</h3><p>{selected.description}</p></div>
          </header>

          <div className="governance-boundary-grid">
            <section className="is-responsible"><Kicker>负责什么</Kicker><p>{selected.responsibility}</p></section>
            <section className="is-boundary"><Kicker>不负责什么</Kicker><p>{selected.notResponsible}</p></section>
          </div>

          <section className="governance-people-grid">
            <div><h4><Users size={14} />维护者</h4><ChipList items={selected.maintainers} /></div>
            <div><h4><Users size={14} />谁应阅读</h4><ChipList items={selected.readers} /></div>
            <div><h4><GitBranch size={14} />影响模块</h4><ChipList items={selected.impacts} /></div>
          </section>

          <section className="governance-relations">
            <div className="governance-section-title"><div><Kicker>关系图</Kicker><h4>从规则到落地与证据</h4></div><span>{RELATIONS.reduce((total, relation) => total + selected[relation.key].length, 0)} 条连接</span></div>
            {RELATIONS.some((relation) => selected[relation.key].length) ? RELATIONS.map((relation) => <RelationGroup key={relation.key} label={relation.label} ids={selected[relation.key]} byId={byId} onSelect={setSelectedId} />) : <Empty>这个条目尚未登记上下游关系。</Empty>}
          </section>

          <footer className="governance-source-meta">
            <div><Kicker>原件路径</Kicker><code>{selected.path}</code></div>
            {selected.authorityKey ? <div><Kicker>权威键</Kicker><code>{selected.authorityKey}</code></div> : null}
            <div><Kicker>放置判断</Kicker><span>{selected.placement === "in-place" ? "当前位置合理" : selected.placement === "review" ? "需要本人判断" : selected.placement}</span></div>
          </footer>

          {selectedIssues.length ? <section className="governance-issues" aria-label="登记异常"><h4><AlertTriangle size={15} />这个条目需要处理</h4>{selectedIssues.map((item) => <p key={`${item.code}:${item.message}`}><code>{item.code}</code>{item.message}</p>)}</section> : null}
          {selected.reviewNote ? <section className="governance-review-note"><h4><AlertTriangle size={15} />需要本人判断</h4><p>{selected.reviewNote}</p></section> : null}
        </> : <Empty>选择一份规则查看职责和关系。</Empty>}
      </main>
    </div>

    {snapshot ? <footer className="governance-registry-note"><span>{snapshot.issues.length ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}{snapshot.updatedAt ? `登记更新于 ${snapshot.updatedAt}` : "登记时间未填写"}</span></footer> : null}
  </div>;
}
