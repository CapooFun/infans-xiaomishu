import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BookOpenText, CalendarClock, Check, RefreshCw, WalletCards } from "lucide-react";

import { Card, Empty, Kicker, fmtCurrency, fmtDateTime, jsonFetch } from "../../page-shared";
import { createToolSessionCache } from "../../tool-session-cache";
import type { RenewalAuthority, RenewalExpiryItem, RenewalExpirySnapshot, RenewalIntent, WriteAction } from "../../types";

const renewalExpiryCache = createToolSessionCache<"renewals", RenewalExpirySnapshot>(() => jsonFetch<RenewalExpirySnapshot>("/api/assets/payment-authorization"));
const VAULT_UPDATED_EVENT = "infans:vault-updated";

const GROUPS: Array<{ id: RenewalExpiryItem["group"]; label: string }> = [
  { id: "attention", label: "需要确认" },
  { id: "authorized", label: "已经确认" },
  { id: "watching", label: "自动续费" },
  { id: "upcoming", label: "之后处理" },
  { id: "pending", label: "日期待补" },
];

const INTENTS: Array<{ id: Exclude<RenewalIntent, "review">; label: string }> = [
  { id: "continue", label: "继续" },
  { id: "cancel", label: "取消" },
];

const REMINDERS: Array<{ id: Exclude<RenewalAuthority, "automatic">; label: string }> = [
  { id: "remind", label: "只报异常" },
  { id: "confirm", label: "到期前提醒" },
];

type Draft = { intent: Exclude<RenewalIntent, "review">; authority: Exclude<RenewalAuthority, "automatic"> };

function normalizedIntent(intent: RenewalIntent): Draft["intent"] {
  return intent === "cancel" ? "cancel" : "continue";
}

function normalizedAuthority(authority: RenewalAuthority): Draft["authority"] {
  return authority === "confirm" ? "confirm" : "remind";
}

function itemDraft(item: RenewalExpiryItem): Draft {
  return { intent: normalizedIntent(item.decision.intent), authority: normalizedAuthority(item.decision.authority) };
}

function sameDraft(item: RenewalExpiryItem, draft: Draft) {
  return normalizedIntent(item.decision.intent) === draft.intent
    && normalizedAuthority(item.decision.authority) === draft.authority;
}

function dateCopy(item: RenewalExpiryItem) {
  if (!item.date) return "日期待补";
  const due = item.mode === "automatic" ? `扣款 ${item.date}` : `到期 ${item.date}`;
  if (!item.actionDate || item.actionDate === item.date) return due;
  return `${due} · ${item.actionDate} 前处理`;
}

function amountCopy(item: RenewalExpiryItem) {
  if (item.amount != null && item.currency) return fmtCurrency(item.amount, item.currency);
  return item.recurring ? "金额待确认" : "无固定金额";
}

function accountCopy(item: RenewalExpiryItem) {
  if (!item.recurring) return "不涉及固定扣款账户";
  return item.funding.accountLabel || "扣款账户待核对";
}

function fundingAlert(item: RenewalExpiryItem) {
  if (item.funding.status === "insufficient") return { tone: "danger", label: "余额可能不足" };
  if (item.funding.status === "missing") return { tone: "quiet", label: "绑定待核对" };
  return null;
}

function reminderExplanation(authority: Draft["authority"]) {
  return authority === "confirm"
    ? "每次到期前提醒一次；余额不足或扣款异常也会提醒。"
    : "不报例行到期，只报余额不足、扣款异常或必须由你处理的事项。";
}

export default function RenewalExpiryView({
  active,
  onWritePreview,
}: {
  active: boolean;
  onWritePreview?: (action: WriteAction) => void | Promise<void>;
}) {
  const [data, setData] = useState<RenewalExpirySnapshot | null>(() => renewalExpiryCache.get("renewals"));
  const [loading, setLoading] = useState(() => !renewalExpiryCache.get("renewals"));
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const load = async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const next = await renewalExpiryCache.load("renewals", { force });
      setData(next);
      setDrafts({});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读不到支付与续约确认单");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active]);

  useEffect(() => {
    const refresh = () => { renewalExpiryCache.clear(); void load(true); };
    window.addEventListener(VAULT_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(VAULT_UPDATED_EVENT, refresh);
  }, []);

  const groupedItems = useMemo(() => {
    const grouped = new Map<RenewalExpiryItem["group"], RenewalExpiryItem[]>();
    for (const item of data?.items || []) grouped.set(item.group, [...(grouped.get(item.group) || []), item]);
    return grouped;
  }, [data?.items]);
  const attentionCount = data?.counts.attention || 0;
  const explicitCount = data?.items.filter((item) => item.decision.explicit).length || 0;

  const updateDraft = (item: RenewalExpiryItem, patch: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [item.id]: { ...(current[item.id] || itemDraft(item)), ...patch } }));
  };

  const save = (item: RenewalExpiryItem) => {
    const draft = drafts[item.id] || itemDraft(item);
    void onWritePreview?.({
      kind: "updateRenewalDecision",
      id: item.id,
      expectedUpdatedAt: data?.updatedAt || "",
      intent: draft.intent,
      authority: draft.authority,
      paymentAccountId: item.decision.paymentAccountId || item.funding.accountId,
    });
  };

  return (
    <section className="renewal-expiry" aria-labelledby="renewal-expiry-title">
      <Card className={`renewal-expiry-hero${attentionCount ? " has-due" : ""}`}>
        <div>
          <Kicker>支付与续约</Kicker>
          <h2 id="renewal-expiry-title">一项一页，确认就好</h2>
          <p>你只决定去留和提醒程度。扣款账户、余额判断与异常跟进由小秘书整理。</p>
        </div>
        <div className="renewal-expiry-summary">
          <BookOpenText size={19} />
          <span><strong>{data?.items.length || 0}</strong><small>份确认单</small></span>
          <span><strong>{explicitCount}</strong><small>份已确认</small></span>
          <button type="button" onClick={() => void load(true)} disabled={loading} aria-label="重新核对确认单"><RefreshCw className={loading ? "spin" : ""} size={15} /></button>
        </div>
      </Card>

      {error ? <div className="vpn-warning"><CalendarClock size={16} /><div><strong>暂时读不到确认单</strong><span>{error}。若资产保护已开启，请先到资产管理解锁。</span></div></div> : null}
      {loading && !data ? <Empty>正在核对支付与续约。</Empty> : null}

      {data ? (
        <div className="renewal-expiry-groups">
          {GROUPS.map((group) => {
            const items = groupedItems.get(group.id) || [];
            if (!items.length) return null;
            return (
              <section className={`renewal-expiry-group is-${group.id}`} key={group.id}>
                <header><h3>{group.label}</h3><span>{items.length} 份</span></header>
                <div className="renewal-expiry-list">
                  {items.map((item, index) => {
                    const draft = drafts[item.id] || itemDraft(item);
                    const alert = fundingAlert(item);
                    const changed = !sameDraft(item, draft);
                    const canSave = Boolean(onWritePreview) && (changed || !item.decision.explicit);
                    return (
                      <article className="renewal-authorization-sheet" key={item.id}>
                        <span className="renewal-sheet-folio" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                        <header className="renewal-sheet-heading">
                          <div><span>{item.category}</span><h4>{item.name}</h4></div>
                          <strong>{amountCopy(item)}</strong>
                        </header>

                        <div className="renewal-sheet-facts">
                          <span><CalendarClock size={15} />{dateCopy(item)}</span>
                          <span><WalletCards size={15} />扣款账户：<strong>{accountCopy(item)}</strong>{alert ? <em className={`is-${alert.tone}`}><AlertTriangle size={12} />{alert.label}</em> : null}</span>
                        </div>

                        <div className="renewal-sheet-choices">
                          <section>
                            <Kicker>是否继续</Kicker>
                            <div className="renewal-segmented" role="group" aria-label={`${item.name}去留`}>
                              {INTENTS.map((option) => <button type="button" className={draft.intent === option.id ? "active" : ""} aria-pressed={draft.intent === option.id} key={option.id} onClick={() => updateDraft(item, { intent: option.id })}>{option.label}</button>)}
                            </div>
                          </section>
                          <section>
                            <Kicker>怎么提醒</Kicker>
                            <div className="renewal-segmented" role="group" aria-label={`${item.name}提醒程度`}>
                              {REMINDERS.map((option) => <button type="button" className={draft.authority === option.id ? "active" : ""} aria-pressed={draft.authority === option.id} key={option.id} onClick={() => updateDraft(item, { authority: option.id })}>{option.label}</button>)}
                            </div>
                          </section>
                        </div>

                        <footer className="renewal-sheet-footer">
                          <small>{reminderExplanation(draft.authority)}</small>
                          {canSave ? <button type="button" className="gold-button" onClick={() => save(item)}>保存这张确认单</button> : <button type="button" className="renewal-saved-button" disabled><Check size={14} />已保存</button>}
                        </footer>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
          <small className="renewal-expiry-updated">更新于 {fmtDateTime(data.updatedAt)} · 金额与账户关系只在本机显示</small>
        </div>
      ) : null}
    </section>
  );
}
