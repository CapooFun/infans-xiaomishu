import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { Area, AreaChart, CartesianGrid, Line, LineChart as RechartsLineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowUpRight, ChevronLeft, ChevronRight, LineChart as LineChartIcon, LoaderCircle, LockKeyhole, MessageSquareText, ShieldCheck } from "lucide-react";
import type { AssetCustodyData, AssetItem, AssetSnapshot, AssetVaultData, InvestmentInstrumentSeries, InvestmentLedgerData, InvestmentPeriodPerformance } from "../types";
import { Card, Empty, ExternalSourceDisclosure, Kicker, fmtCny, fmtCurrency, fmtDate, jsonFetch } from "../page-shared";
import { sortInvestmentPerformanceRows, type InvestmentPerformanceSort } from "../investment-performance-sort";
import { calculateInvestmentPeriodComparison } from "../investment-aggregate-series.mjs";
import {
  readInvestmentDashboardPreferences,
  writeInvestmentDashboardPreferences,
  type InvestmentChartMetric,
  type InvestmentDashboardRange,
} from "../investment-dashboard-preferences";
import {
  availableInvestmentMarkets,
  investmentPositionState,
  INVESTMENT_MARKET_LABELS,
  scopeInvestmentLedger,
  scopeInvestmentPeriodPerformance,
  type InvestmentMarketScope,
} from "../investment-dashboard-scope";
import { ASSET_DISPLAY_DEMO, readAssetDisplayDemoPerformance, readAssetDisplayDemoSeries } from "../asset-display-demo";
import AssetCashflowPanel from "./AssetCashflowPanel";
import { resolveJpyToCny } from "../asset-fx.mjs";

type AssetsTab = "networth" | "investments" | "income" | "expense";
type FxMode = "stable" | "live";
const ASSET_TABS: { id: AssetsTab; label: string; tabDomId: string; panelId: string }[] = [
  { id: "networth", label: "资产", tabDomId: "asset-tab-networth", panelId: "asset-panel-networth" },
  { id: "investments", label: "投资", tabDomId: "asset-tab-investments", panelId: "asset-panel-investments" },
  { id: "income", label: "收入", tabDomId: "asset-tab-income", panelId: "asset-panel-income" },
  { id: "expense", label: "支出", tabDomId: "asset-tab-expense", panelId: "asset-panel-expense" },
];

function readAssetsTab(): AssetsTab {
  const value = new URLSearchParams(window.location.search).get("tab");
  return value === "investments" || value === "income" || value === "expense" || value === "networth" ? value : "networth";
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function buildAssetHealthSeed(snapshot: AssetSnapshot, previous?: AssetSnapshot) {
  const structure = snapshot.categories
    .map((item) => `${item.name} ${fmtCny(item.value)}`)
    .join("；");
  const prevLine = previous
    ? `上一期 ${previous.date} 净资产 ${fmtCny(previous.netAssets)}（变动 ${fmtCny(snapshot.netAssets - previous.netAssets)}）。`
    : "这是目前唯一一期快照。";
  return [
    "请根据我最近的资产结构，做一次简短的资产健康度评估。说人话，别吓人，也不要编造我没给你的数字。",
    "",
    `当前期 ${snapshot.date}：净资产 ${fmtCny(snapshot.netAssets)}；总资产 ${fmtCny(snapshot.totalAssets)}；总负债 ${fmtCny(snapshot.totalLiabilities)}。`,
    prevLine,
    `结构：${structure || "暂无"}。`,
    "",
    "请看：负债压力、资产分散、有没有明显异常；给 2～3 条可执行建议。",
  ].join("\n");
}

function groupItemsByCategory(items: AssetItem[]) {
  const map = new Map<string, AssetItem[]>();
  for (const item of items) {
    const key = item.category || "其他";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return [...map.entries()]
    .map(([category, rows]) => ({
      category,
      rows,
      totalCny: rows.reduce((sum, row) => sum + row.cnyValue, 0),
    }))
    .sort((a, b) => Math.abs(b.totalCny) - Math.abs(a.totalCny));
}

function categoryTone(category: string) {
  if (/负债|贷款|信用/.test(category)) return "debt";
  if (/证券|股票|基金/.test(category)) return "invest";
  if (/委托|代持/.test(category)) return "custody";
  if (/债权/.test(category)) return "receivable";
  if (/现金|第三方|PayPay/.test(category)) return "cash";
  if (/银行|存款/.test(category)) return "bank";
  return "default";
}

const PRIVACY_MASK = "**********";

function privacyText(hidden: boolean, value: string) {
  return hidden ? PRIVACY_MASK : value;
}

function isLiabilityGroup(category: string, totalCny: number) {
  return totalCny < 0 || /负债|贷款|信用/.test(category);
}

function snapshotMonthKey(date: string) {
  return String(date || "").slice(0, 7);
}

function monthTitle(monthKey: string) {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return monthKey;
  return `${y}年${m}月`;
}

function shiftYear(year: number, delta: number) {
  return year + delta;
}

function snapshotLabelDate(snapshot: AssetSnapshot) {
  return snapshot.capturedAt || snapshot.date;
}

function DetailGroupCards({
  groups,
  privacy,
}: {
  groups: Array<{ category: string; rows: AssetItem[]; totalCny: number }>;
  privacy: boolean;
}) {
  if (!groups.length) return <Empty>这一侧还没有项目。</Empty>;
  return (
    <div className="asset-detail-grid">
      {groups.map((group) => (
        <Card className={`asset-detail-card tone-${categoryTone(group.category)}`} key={group.category}>
          <header className="asset-detail-card-head">
            <div>
              <strong>{privacyText(privacy, group.category)}</strong>
              <small>{group.rows.length} 项</small>
            </div>
            <span className={group.totalCny < 0 ? "negative" : ""}>
              {privacyText(privacy, fmtCny(group.totalCny))}
            </span>
          </header>
          <ul>
            {group.rows.map((item, index) => (
              <li key={`${item.name}-${index}`}>
                <div>
                  <strong>{privacyText(privacy, item.name)}</strong>
                  <small>
                    {privacy
                      ? PRIVACY_MASK
                      : `${item.currency === "JPY" ? `按当前所选口径 ${item.rateToCny} 折算进合计` : "人民币"}${item.note ? ` · ${item.note}` : ""}`}
                  </small>
                </div>
                <span className={`asset-detail-card-amount ${item.amount < 0 ? "negative" : ""}`}>
                  {privacyText(privacy, fmtCurrency(item.amount, item.currency))}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function trendYDomain(values: number[]): [number, number] {
  if (!values.length) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pad = Math.max(span * 0.18, Math.abs(max || min) * 0.02, 5_000);
  if (span < 1) return [min - pad, max + pad];
  return [min - pad, max + pad];
}

function revalueSnapshot(snapshot: AssetSnapshot, jpyToCny: number): AssetSnapshot {
  const items = snapshot.items.map((item) => {
    if (item.currency !== "JPY") return item;
    const cnyValue = round2(item.amount * jpyToCny);
    return { ...item, rateToCny: jpyToCny, cnyValue };
  });
  const totalAssets = items.reduce((sum, item) => sum + Math.max(0, item.cnyValue), 0);
  const totalLiabilities = items.reduce((sum, item) => sum + Math.abs(Math.min(0, item.cnyValue)), 0);
  const categoryMap = new Map<string, number>();
  for (const item of items) categoryMap.set(item.category, (categoryMap.get(item.category) ?? 0) + item.cnyValue);
  const categories = [...categoryMap.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return {
    ...snapshot,
    items,
    totalAssets,
    totalLiabilities,
    netAssets: totalAssets - totalLiabilities,
    categories,
  };
}

function CustodyPanel({
  custody,
  jpyToCny,
  privacy = false,
  onImport,
  importing,
  message,
}: {
  custody?: AssetCustodyData;
  jpyToCny: number;
  privacy?: boolean;
  onImport: () => void;
  importing: boolean;
  message: string;
}) {
  if (!custody) return null;
  const usCny = round2((custody.usStocks?.amountJpy ?? 0) * jpyToCny);
  const fundsCny = round2((custody.funds?.amountJpy ?? 0) * jpyToCny);
  const gainCny = round2((custody.income?.gainJpy ?? 0) * jpyToCny);
  const mask = (value: string) => privacyText(privacy, value);
  return (
    <Card className="asset-custody">
      <div className="card-title">
        <div>
          <Kicker>代持明细</Kicker>
          <h2>{mask("代持美股")}</h2>
        </div>
        {custody.googleSheetUrl ? (
          <a href={custody.googleSheetUrl} target="_blank" rel="noreferrer">
            打开代持原表
            <ArrowUpRight size={12} />
          </a>
        ) : null}
      </div>

      {!custody.available ? (
        <p className="asset-custody-empty">
          {custody.message || "还没有代持表。"}
          {custody.source?.name ? (
            <>
              <br />
              已找到文件 {mask(custody.source.name)}
              {custody.source.location === "downloads" ? "（下载文件夹）" : "（个人资产库）"}，但还没读成功。
            </>
          ) : null}
        </p>
      ) : (
        <>
          <p className="asset-custody-meta">
            读入 {mask(custody.source?.name || "代持表")}
            {custody.source?.createdAt ? ` · 创建于 ${custody.source.createdAt}` : ""}
            {custody.source?.location === "downloads" ? " · 下载文件夹" : " · 个人资产库"}
            。最新一期净资产明细已用本表刷新美股 / 基金 / 欠款三项。
          </p>
          <div className="asset-custody-metrics">
            <div>
              <span>美股代持</span>
              <strong>{mask(fmtCurrency(custody.usStocks?.amountJpy ?? 0, "JPY"))}</strong>
              <small>≈ {mask(fmtCny(usCny))}</small>
            </div>
            <div>
              <span>基金代持</span>
              <strong>{mask(fmtCurrency(custody.funds?.amountJpy ?? 0, "JPY"))}</strong>
              <small>≈ {mask(fmtCny(fundsCny))}</small>
            </div>
            <div>
              <span>{mask("代持欠款")}</span>
              <strong>{mask(fmtCny(custody.receivableCny ?? 0))}</strong>
              <small>应收账款</small>
            </div>
            <div className={gainCny >= 0 ? "pos" : "neg"}>
              <span>投资浮动盈亏</span>
              <strong>{mask(fmtCny(gainCny))}</strong>
              <small>
                {mask(
                  `日元 ${fmtCurrency(custody.income?.gainJpy ?? 0, "JPY")} · 约 ${((custody.income?.yield ?? 0) * 100).toFixed(1)}%（现市值 − 成本）`,
                )}
              </small>
            </div>
          </div>
          {custody.compareJune ? (
            <p className="asset-custody-compare">
              {mask(
                `相对 6 月快照：美股 ${custody.compareJune.usStocksJpyDelta >= 0 ? "+" : ""}${fmtCurrency(custody.compareJune.usStocksJpyDelta, "JPY")}，基金 ${custody.compareJune.fundsJpyDelta >= 0 ? "+" : ""}${fmtCurrency(custody.compareJune.fundsJpyDelta, "JPY")}，欠款差额 ${fmtCny(custody.compareJune.receivableCnyDelta)}。`,
              )}
            </p>
          ) : null}
        </>
      )}

      <div className="asset-custody-actions">
        <button type="button" disabled={importing} onClick={onImport}>
          {importing ? "正在导入…" : "确认无误，导入到个人资产库"}
        </button>
        {message ? <span>{message}</span> : <span>也可把表格导出的代持 xlsx 放到下载文件夹后刷新。</span>}
      </div>
    </Card>
  );
}

function fmtPercent(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "待补";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

function fmtShare(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "待补";
  return `${(value * 100).toFixed(digits)}%`;
}

function fmtInvestmentQuantity(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(value);
}

function fmtInvestmentChartAmount(value: number) {
  const amount = Number(value) || 0;
  const absolute = Math.abs(amount);
  if (absolute >= 10_000) return `${round2(amount / 10_000).toLocaleString("zh-CN", { maximumFractionDigits: absolute >= 1_000_000 ? 0 : 1 })}万`;
  if (absolute >= 1_000) return `${round2(amount / 1_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}k`;
  return Math.round(amount).toLocaleString("zh-CN");
}

function investmentPerformanceBasis(row: { basis: string }) {
  if (row.basis === "period-strategy") return "区间策略毛收益";
  if (row.basis === "period-unavailable") return "区间待补";
  if (row.basis === "platform-holding") return "截图持有收益";
  if (row.basis === "platform-closed-record") return "截图已清仓段";
  if (row.basis === "transaction-gross") return "完整成交链毛收益";
  return "仅有平台累计盈亏";
}

function investmentPositionLabel(currentMarketValue: number, currentPosition: boolean) {
  const state = investmentPositionState(currentMarketValue, currentPosition);
  if (state === "watch-light") return { state, label: "轻观察仓" };
  if (state === "watch-heavy") return { state, label: "重观察仓" };
  if (state === "cleared") return { state, label: "已清仓" };
  return { state, label: "正式仓位" };
}

function investmentRangeBounds(range: InvestmentDashboardRange, end: string) {
  if (range === "all") return { from: "", to: end };
  if (range.startsWith("year:")) {
    const year = range.slice(5);
    return { from: `${year}-01-01`, to: `${year}-12-31` < end ? `${year}-12-31` : end };
  }
  const date = new Date(`${end}T00:00:00Z`);
  if (range === "ytd") return { from: `${date.getUTCFullYear()}-01-01`, to: end };
  if (range === "mtd") return { from: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`, to: end };
  date.setUTCMonth(date.getUTCMonth() - (range === "1y" ? 12 : range === "6m" ? 6 : 3));
  return { from: date.toISOString().slice(0, 10), to: end };
}

function investmentRangeLabel(range: InvestmentDashboardRange) {
  if (range === "all") return "全周期";
  if (range === "mtd") return "本月";
  if (range === "3m") return "近三月";
  if (range === "6m") return "近半年";
  if (range === "ytd") return "年初至今";
  if (range === "1y") return "近一年";
  return range.slice(5);
}

function investmentRangeOptions(years: string[]): Array<[InvestmentDashboardRange, string]> {
  return [
    ["all", "全周期"],
    ["mtd", "本月"],
    ["3m", "近三月"],
    ["6m", "近半年"],
    ["ytd", "年初至今"],
    ["1y", "近一年"],
    ...years.map((year) => [`year:${year}` as InvestmentDashboardRange, year] as [InvestmentDashboardRange, string]),
  ];
}

function InvestmentPerformanceBoard({
  ledger,
  privacy = false,
  period,
  loading,
  selectedInstrumentId,
  onSelectInstrument,
  range,
  onRangeChange,
  years,
  sort,
  onSortChange,
}: {
  ledger: InvestmentLedgerData;
  privacy?: boolean;
  period: InvestmentPeriodPerformance | null;
  loading: boolean;
  selectedInstrumentId: string;
  onSelectInstrument: (instrumentId: string) => void;
  range: InvestmentDashboardRange;
  onRangeChange: (range: InvestmentDashboardRange) => void;
  years: string[];
  sort: InvestmentPerformanceSort;
  onSortChange: (sort: InvestmentPerformanceSort) => void;
}) {
  const [showAllOnMobile, setShowAllOnMobile] = useState(false);
  const mask = (value: string) => privacyText(privacy, value);
  const accountById = useMemo(() => new Map(ledger.accounts.map((row) => [row.id, row])), [ledger.accounts]);
  const instrumentById = useMemo(() => new Map(ledger.instruments.map((row) => [row.id, row])), [ledger.instruments]);
  const bounds = useMemo(() => investmentRangeBounds(range, ledger.performance.to), [ledger.performance.to, range]);

  useEffect(() => setShowAllOnMobile(false), [range]);

  const visibleRows = useMemo(() => sortInvestmentPerformanceRows(period?.rows || [], sort), [period?.rows, sort]);
  const availableRows = visibleRows.filter((row) => row.returnRate !== null);
  const bestContribution = visibleRows.filter((row) => row.profit !== null).toSorted((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity))[0] || null;
  const maxAbsoluteRate = Math.max(0.01, ...availableRows.map((row) => Math.abs(row.returnRate || 0)));
  const rangeLabel = investmentRangeLabel(range);

  return (
    <Card className="asset-investment-performance-board">
      <div className="card-title asset-investment-performance-head">
        <div>
          <Kicker>区间收益贡献 · {period?.from || bounds.from || ledger.performance.from}—{period?.to || bounds.to}</Kicker>
          <h2>{rangeLabel}，每一项投资带来了什么</h2>
        </div>
        <span>包含区间内已清仓资产；场外基金缺流水时不复用全周期收益率</span>
      </div>
      <div className="asset-investment-periods" role="group" aria-label="投资回报时段">
        {investmentRangeOptions(years).map(([id, label]) => (
          <button type="button" className={range === id ? "active" : ""} aria-pressed={range === id} onClick={() => onRangeChange(id)} key={id}>{label}</button>
        ))}
      </div>
      <div className="asset-investment-sort" role="group" aria-label="全资产排序">
        <span>排序</span>
        {([
          ["profit", "收益"],
          ["rate", "收益率"],
          ["value", "当前市值"],
          ["date", "最近交易"],
        ] as Array<[InvestmentPerformanceSort, string]>).map(([id, label]) => (
          <button type="button" className={sort === id ? "active" : ""} aria-pressed={sort === id} onClick={() => onSortChange(id)} key={id}>{label}</button>
        ))}
      </div>
      <div className="asset-investment-performance-summary">
        <div><span>可复算区间盈亏</span><strong>{period?.summary.availableCount ?? 0} / {period?.summary.totalCount ?? 0}</strong></div>
        <div><span>盈利 / 亏损</span><strong>{period?.summary.positiveCount ?? 0} / {period?.summary.negativeCount ?? 0}</strong></div>
        <div><span>覆盖资产合计盈亏</span><strong className={(period?.summary.totalProfit || 0) >= 0 ? "positive" : "negative"}>{mask(fmtCny(period?.summary.totalProfit || 0))}</strong></div>
        <div><span>最大正贡献</span><strong className="positive">{bestContribution ? mask(fmtCny(bestContribution.profit || 0)) : "—"}</strong><small>{bestContribution ? mask(instrumentById.get(bestContribution.instrumentId)?.name || "—") : "—"}</small></div>
      </div>
      {loading ? <div className="asset-investment-period-loading"><LoaderCircle size={17} />正在按{rangeLabel}重算成交链与行情…</div> : !period?.available ? <Empty>{period?.message || "所选区间没有投资记录。"}</Empty> : <div className="asset-investment-performance-table" role="table" aria-label="全资产区间收益贡献">
        <div className="asset-investment-performance-row is-head" role="row">
          <span>资产 / 区间</span><span>账户 / 口径</span><span>区间盈亏 / 贡献</span><span>区间收益率</span><span>同额持有 / 操作差额</span>
        </div>
        {visibleRows.map((row, index) => {
          const instrument = instrumentById.get(row.instrumentId);
          const account = accountById.get(row.accountId);
          const rate = row.returnRate;
          const position = investmentPositionLabel(row.currentMarketValue, row.currentPosition);
          const segmented = row.currentPosition && ledger.historicalInvestments.some((item) => item.accountId === row.accountId && item.instrumentId === row.instrumentId);
          const barWidth = rate === null ? 0 : Math.max(2, Math.abs(rate) / maxAbsoluteRate * 100);
          return (
            <button
              type="button"
              className={`asset-investment-performance-row${selectedInstrumentId === row.instrumentId ? " is-selected" : ""}${index >= 6 && !showAllOnMobile && selectedInstrumentId !== row.instrumentId ? " is-mobile-collapsed" : ""}`}
              role="row"
              aria-pressed={selectedInstrumentId === row.instrumentId}
              onClick={() => onSelectInstrument(row.instrumentId)}
              key={row.id}
            >
              <div>
                <strong>{mask(instrument?.name || row.instrumentId)} <em className={`asset-investment-position-tag ${position.state}`}>{position.label}</em>{segmented ? <em className="asset-investment-position-tag segmented">收益分段</em> : null}</strong>
                <small>{row.from || "起始日待补"}—{row.to || "至今"}{row.currentPosition ? " · 持有中" : " · 终点为末次卖出"}</small>
              </div>
              <div><span>账户 / 口径</span><strong>{mask(account?.broker || "—")}</strong><small>{investmentPerformanceBasis(row)}</small></div>
              <div className={(row.profit || 0) >= 0 ? "positive" : "negative"}><span>区间盈亏 / 贡献</span><strong>{row.profit === null ? "待补" : mask(fmtCny(row.profit))}</strong><small>{row.contributionRate === null ? row.note : `占覆盖净盈亏 ${fmtPercent(row.contributionRate)}`}</small></div>
              <div className={`asset-investment-rate ${(rate || 0) >= 0 ? "positive" : "negative"}`}>
                <span>区间收益率</span><strong>{rate === null ? "待补" : mask(fmtPercent(rate))}</strong>
                <i><b style={{ width: `${barWidth}%` }} /></i>
              </div>
              <div className={(row.operationProfit || 0) >= 0 ? "positive" : "negative"}><span>同额持有 / 操作差额</span><strong>{row.marketReturn === null ? "待补" : mask(fmtPercent(row.marketReturn))}</strong><small>{row.operationProfit === null ? row.note : `操作${row.operationProfit >= 0 ? "多赚" : "少赚"} ${mask(fmtCny(Math.abs(row.operationProfit)))} · ${fmtPercent(row.operationDifference)}`}</small></div>
            </button>
          );
        })}
      </div>}
      {visibleRows.length > 6 ? (
        <button type="button" className="asset-investment-performance-expand" onClick={() => setShowAllOnMobile((value) => !value)}>
          {showAllOnMobile ? "收起到前 6 项" : `展开全部 ${visibleRows.length} 项`}
        </button>
      ) : null}
      <div className="asset-investment-performance-foot">
        <span>默认按所选区间盈亏金额排序；点击任一资产会切换上方同周期主图。</span>
        <span>{period?.sourceLabel || "成交链口径未计齐手续费与税费。"}</span>
      </div>
    </Card>
  );
}

function InvestmentFullCycleBoard({
  ledger,
  period,
  selectedInstrumentId,
  onSelectInstrument,
  privacy = false,
  range,
  onRangeChange,
  years,
  metric,
  onMetricChange,
  demoMode = false,
}: {
  ledger: InvestmentLedgerData;
  period: InvestmentPeriodPerformance | null;
  selectedInstrumentId: string;
  onSelectInstrument: (instrumentId: string) => void;
  privacy?: boolean;
  range: InvestmentDashboardRange;
  onRangeChange: (range: InvestmentDashboardRange) => void;
  years: string[];
  metric: InvestmentChartMetric;
  onMetricChange: (metric: InvestmentChartMetric) => void;
  demoMode?: boolean;
}) {
  const [series, setSeries] = useState<InvestmentInstrumentSeries | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedActionDate, setSelectedActionDate] = useState<string | null>(null);
  const performance = ledger.performance.rows.find((row) => row.instrumentId === selectedInstrumentId && row.basis !== "platform-closed-record")
    || ledger.performance.rows.find((row) => row.instrumentId === selectedInstrumentId);
  const periodPerformance = period?.rows.find((row) => row.instrumentId === selectedInstrumentId && row.basis !== "platform-closed-record")
    || period?.rows.find((row) => row.instrumentId === selectedInstrumentId);
  const position = investmentPositionLabel(performance?.currentMarketValue || 0, Boolean(performance?.currentPosition));
  const segmented = Boolean(performance?.currentPosition && ledger.historicalInvestments.some((row) => row.accountId === performance.accountId && row.instrumentId === selectedInstrumentId));
  const selectable = useMemo(() => {
    const stats = new Map<string, { transactionCount: number; profit: number; currentPosition: boolean }>();
    for (const row of ledger.performance.rows) {
      const current = stats.get(row.instrumentId) || { transactionCount: 0, profit: 0, currentPosition: false };
      current.transactionCount += row.transactionCount;
      current.profit += row.profit || 0;
      current.currentPosition ||= row.currentPosition;
      stats.set(row.instrumentId, current);
    }
    return ledger.instruments.flatMap((item) => {
      const stat = stats.get(item.id);
      return stat ? [{ ...item, ...stat }] : [];
    }).toSorted((a, b) => b.profit - a.profit);
  }, [ledger.instruments, ledger.performance.rows]);
  const instrument = ledger.instruments.find((row) => row.id === selectedInstrumentId);

  useEffect(() => {
    if (!selectedInstrumentId || privacy) return;
    if (demoMode) {
      setLoading(false);
      setSeries(readAssetDisplayDemoSeries(selectedInstrumentId));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSeries(null);
    const endpoint = `/api/assets/investment-series?instrumentId=${encodeURIComponent(selectedInstrumentId)}`;
    jsonFetch<InvestmentInstrumentSeries>(endpoint)
      .then((next) => { if (!cancelled) setSeries(next); })
      .catch((error) => { if (!cancelled) setSeries({ available: false, instrumentId: selectedInstrumentId, message: error instanceof Error ? error.message : "全周期行情暂时不可用。" }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [demoMode, privacy, selectedInstrumentId]);

  useEffect(() => setSelectedActionDate(null), [range, selectedInstrumentId]);

  const periodView = useMemo(() => {
    const rows = series?.rows || [];
    const bounds = investmentRangeBounds(range, ledger.performance.to);
    const firstIncludedIndex = rows.findIndex((row) => (!bounds.from || row.date >= bounds.from) && (!bounds.to || row.date <= bounds.to));
    if (firstIncludedIndex < 0) return { rows: [], baselineProfit: 0 };
    const baseline = firstIncludedIndex > 0 ? rows[firstIncludedIndex - 1] : null;
    const filtered = rows.slice(firstIncludedIndex).filter((row) => !bounds.to || row.date <= bounds.to);
    const baselineProfit = baseline?.profit ?? 0;
    return { rows: calculateInvestmentPeriodComparison(filtered, baseline), baselineProfit };
  }, [ledger.performance.to, range, series]);
  const chartRows = periodView.rows;
  const marketOnly = series?.mode === "market-only";
  const chartMetric: InvestmentChartMetric = marketOnly ? "return" : metric;
  const chartStart = chartRows[0]?.date || series?.from || performance?.from || "";
  const chartEnd = chartRows.at(-1)?.date || series?.to || performance?.to || "";
  const actions = (series?.actions || []).filter((row) => (!chartStart || row.date >= chartStart) && (!chartEnd || row.date <= chartEnd));
  const latest = chartRows.at(-1);
  const strategyReturn = latest?.strategyReturn ?? null;
  const marketReturn = latest?.marketReturn ?? null;
  const periodProfit = latest ? latest.profitView : null;
  const actionGroups = useMemo(() => {
    const grouped = new Map<string, InvestmentInstrumentSeries["actions"]>();
    for (const action of actions) grouped.set(action.date, [...(grouped.get(action.date) || []), action]);
    const rowByDate = new Map(chartRows.map((row) => [row.date, row]));
    return [...grouped.entries()].flatMap(([date, rows]) => {
      const point = rowByDate.get(date);
      const markerY = marketOnly ? point?.marketView : chartMetric === "return" ? point?.strategyView : point?.profitView;
      if (markerY === null || markerY === undefined) return [];
      const buys = (rows || []).filter((row) => row.side === "buy");
      const sells = (rows || []).filter((row) => row.side === "sell");
      const side = buys.length && sells.length ? "mixed" : buys.length ? "buy" : "sell";
      const shortLabel = side === "mixed" ? "买卖" : side === "buy" ? "买" : "卖";
      const detail = (rows || []).map((row) => `${row.instrumentName ? `${row.instrumentName} · ` : ""}${row.side === "buy" ? "买入" : "卖出"} ${fmtInvestmentQuantity(row.quantity)} 份 × ${row.price}`).join("；");
      return [{ date, rows: rows || [], side, markerY, shortLabel: `${shortLabel}${(rows || []).length > 1 ? (rows || []).length : ""}`, detail }];
    });
  }, [actions, chartMetric, chartRows, marketOnly]);
  const selectedActionGroup = actionGroups.find((row) => row.date === selectedActionDate) || null;
  const chartDomain = useMemo<[number, number]>(() => {
    const values = chartRows.flatMap((row) => chartMetric === "return"
      ? marketOnly ? [row.marketView] : [row.strategyView, row.marketView]
      : [row.profitView]).filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
    if (!values.length) return [0, 100];
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const spread = Math.max(maximum - minimum, chartMetric === "return" ? 4 : Math.max(Math.abs(maximum), 1) * 0.04);
    const padding = spread * 0.12;
    const lower = minimum < 0 && maximum > 0 ? Math.min(0, minimum - padding) : minimum - padding;
    const upper = minimum < 0 && maximum > 0 ? Math.max(0, maximum + padding) : maximum + padding;
    const step = chartMetric === "return" ? 1 : Math.max(1, 10 ** Math.floor(Math.log10(Math.max(Math.abs(lower), Math.abs(upper), 1))) / 5);
    return [Math.floor(lower / step) * step, Math.ceil(upper / step) * step];
  }, [chartMetric, chartRows, marketOnly]);
  const hasComparableSeries = Boolean(!marketOnly && series?.available && chartRows.length && strategyReturn !== null && marketReturn !== null);
  const displayedRateLabel = hasComparableSeries
    ? "实际同期收益率（净值口径）"
    : performance?.basis === "platform-holding"
      ? "当前持有收益率（平台口径）"
      : performance?.basis === "platform-closed-record"
        ? "已清仓收益率（平台口径）"
        : performance?.basis === "transaction-gross" ? "成交链毛收益率" : "收益率";
  const displayedRate = hasComparableSeries ? strategyReturn : range === "all" ? performance?.returnRate : null;
  const displayedProfit = hasComparableSeries ? periodProfit : range === "all" ? performance?.profit : null;
  const profitLabel = `${investmentRangeLabel(range)}盈亏`;
  const displayedOperationProfit = periodPerformance?.operationProfit;
  const displayedOperationDifference = periodPerformance?.operationDifference;
  const primaryMetricLabel = profitLabel;
  const primaryMetricValue = displayedProfit;
  const firstMarketRow = chartRows[0];
  const formatMarketPrice = (value: number | null | undefined) => value === null || value === undefined
    ? "待补"
    : `${series?.priceCurrency || ""} ${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 4 })}`.trim();

  return (
    <Card className="asset-investment-cycle-board">
      <div className="asset-investment-cycle-head">
        <div>
          <Kicker>{investmentRangeLabel(range)} · 主图 · {chartStart || "起始日待补"}—{chartEnd || "至今"}</Kicker>
          <h2>{privacyText(privacy, `${instrument?.symbol || "—"} ${instrument?.name || "选择一项投资"}`)} {performance ? <em className={`asset-investment-position-tag ${position.state}`}>{position.label}</em> : null}{segmented ? <em className="asset-investment-position-tag segmented">曾清仓后重持</em> : null}</h2>
        </div>
        <div className="asset-investment-cycle-switcher">
          <label>
            <span>切换资产</span>
            <select value={selectedInstrumentId} onChange={(event) => {
              onSelectInstrument(event.target.value);
            }} disabled={privacy}>
              {selectable.map((row) => <option value={row.id} key={row.id}>{row.symbol} {row.name}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div className="asset-investment-cycle-controls">
        <div role="group" aria-label="图表指标">
          <button type="button" className={chartMetric === "return" ? "active" : ""} aria-pressed={chartMetric === "return"} onClick={() => onMetricChange("return")}>{marketOnly ? "价格走势" : "收益率对比"}</button>
          <button type="button" className={chartMetric === "profit" ? "active" : ""} aria-pressed={chartMetric === "profit"} onClick={() => onMetricChange("profit")} disabled={marketOnly} title={marketOnly ? "成交链不完整，不能计算个人累计盈亏" : undefined}>累计盈亏</button>
        </div>
        <div role="group" aria-label="图表周期">
          {investmentRangeOptions(years).map(([id, label]) => (
            <button type="button" className={range === id ? "active" : ""} aria-pressed={range === id} onClick={() => onRangeChange(id)} key={id}>{label}</button>
          ))}
        </div>
      </div>
      {privacy ? <div className="asset-investment-chart-mask">{PRIVACY_MASK}</div> : loading ? (
        <div className="asset-investment-cycle-loading"><LoaderCircle size={18} />正在读取全周期日线…</div>
      ) : !series?.available || !chartRows.length ? (
        <Empty>{series?.message || "这只资产还没有可画的全周期数据。"}</Empty>
      ) : (
        <>
          <div className="asset-investment-cycle-chart" aria-label={`${instrument?.name || "投资"}${investmentRangeLabel(range)}投资曲线`}>
            <ResponsiveContainer width="100%" height="100%">
              <RechartsLineChart data={chartRows} margin={{ top: 14, right: 12, left: chartMetric === "return" ? 0 : 4, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="2 5" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(value) => String(value).slice(2, 7).replace("-", "/")} minTickGap={34} tickLine={false} axisLine={false} />
                <YAxis domain={chartDomain} allowDataOverflow tickFormatter={(value) => chartMetric === "return" ? Number(value).toFixed(0) : fmtInvestmentChartAmount(Number(value))} tickLine={false} axisLine={false} width={chartMetric === "return" ? 40 : 52} />
                <Tooltip
                  labelFormatter={(value) => String(value)}
                  formatter={(value, name) => [chartMetric === "return" ? `${Number(value).toFixed(2)}` : fmtCny(Number(value)), String(name)]}
                  contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12 }}
                />
                {actionGroups.map((group) => (
                  <ReferenceDot
                    key={group.date}
                    x={group.date}
                    y={group.markerY}
                    r={selectedActionDate === group.date ? 8 : 6}
                    fill={group.side === "sell" ? "var(--gold)" : group.side === "buy" ? "var(--teal)" : "var(--ink)"}
                    stroke="var(--surface)"
                    strokeWidth={2}
                    ifOverflow="extendDomain"
                    cursor="pointer"
                    onClick={() => setSelectedActionDate(group.date)}
                    label={{ value: group.shortLabel, position: "top", fill: group.side === "sell" ? "var(--gold)" : "var(--teal)", fontSize: "var(--text-micro)" }}
                  />
                ))}
                {chartMetric === "return" ? (
                  marketOnly ? <Line type="monotone" dataKey="marketView" name="公开价格走势（起点=100）" stroke="var(--teal)" strokeWidth={3} dot={false} activeDot={{ r: 4 }} connectNulls /> : <>
                    <Line type="monotone" dataKey="strategyView" name="我的实际操作" stroke="var(--gold)" strokeWidth={3} dot={false} activeDot={{ r: 4 }} connectNulls />
                    <Line type="monotone" dataKey="marketView" name="同额买入并持有" stroke="var(--teal)" strokeWidth={2} dot={false} connectNulls />
                  </>
                ) : <Line type="monotone" dataKey="profitView" name="区间累计盈亏" stroke="var(--gold)" strokeWidth={3} dot={false} activeDot={{ r: 4 }} />}
              </RechartsLineChart>
            </ResponsiveContainer>
          </div>
          <div className="asset-investment-cycle-legend">
            {marketOnly ? <span><i className="market" />公开价格走势（起点=100）</span> : chartMetric === "return" ? <><span><i className="strategy" />我的实际操作</span><span><i className="market" />同额买入并持有</span></> : <span><i className="strategy" />区间累计盈亏</span>}
            <span className="actions">{marketOnly ? `${series.note || "历史成交记录不完整；此曲线仅供大盘走势参考。"} · ${actions.length ? "已确认买卖点可查看" : "暂无可确认买卖日期"}` : "收益率已排除加减仓资金跳变 · 买卖标记可查看逐笔成交"} · {series.sourceLabel}</span>
          </div>
          {actionGroups.length ? (
            <div className="asset-investment-action-review" aria-label="图表内买卖交易点">
              <div className="asset-investment-action-strip">
                {actionGroups.map((group) => (
                  <button
                    type="button"
                    className={`${group.side}${selectedActionDate === group.date ? " active" : ""}`}
                    aria-pressed={selectedActionDate === group.date}
                    title={`${group.date} · ${group.detail}`}
                    onClick={() => setSelectedActionDate((value) => value === group.date ? null : group.date)}
                    key={group.date}
                  >
                    <span>{group.date.slice(5)}</span><strong>{group.shortLabel}</strong>
                  </button>
                ))}
              </div>
              {selectedActionGroup ? (
                <div className="asset-investment-action-detail">
                  <strong>{selectedActionGroup.date}</strong>
                  <div>
                    {selectedActionGroup.rows.map((action) => (
                      <span key={action.id}>{action.instrumentName ? `${action.instrumentName} · ` : ""}{action.side === "buy" ? "买入" : "卖出"} {fmtInvestmentQuantity(action.quantity)} 份 × {action.price}</span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      {segmented ? <p className="asset-investment-segment-note">这只资产曾清仓后重新持有。已记录的清仓收益作为独立历史段保留；当前段缺申赎流水时不会与旧段强行连成一条曲线。</p> : null}
      {marketOnly ? <div className="asset-investment-cycle-kpis">
        <div><span>区间价格变化</span><strong className={(marketReturn || 0) >= 0 ? "positive" : "negative"}>{privacyText(privacy, fmtPercent(marketReturn))}</strong></div>
        <div><span>起点价格</span><strong>{privacyText(privacy, formatMarketPrice(firstMarketRow?.price))}</strong></div>
        <div><span>最新价格</span><strong>{privacyText(privacy, formatMarketPrice(latest?.price))}</strong></div>
        <div><span>已确认交易点</span><strong>{actions.length} 笔</strong><small>只标真实日期；缺失部分不推断</small></div>
      </div> : <div className="asset-investment-cycle-kpis">
        <div><span>{primaryMetricLabel}</span><strong className={(primaryMetricValue || 0) >= 0 ? "positive" : "negative"}>{primaryMetricValue === null || primaryMetricValue === undefined ? "待补" : privacyText(privacy, fmtCny(primaryMetricValue))}</strong></div>
        <div><span>{displayedRateLabel}</span><strong>{privacyText(privacy, fmtPercent(displayedRate))}</strong></div>
        <div><span>同额持有收益率</span><strong>{privacyText(privacy, fmtPercent(hasComparableSeries ? marketReturn : null))}</strong></div>
        <div><span>{(displayedOperationProfit || 0) >= 0 ? "操作多赚" : "操作少赚"}</span><strong className={(displayedOperationProfit || 0) >= 0 ? "positive" : "negative"}>{displayedOperationProfit === null || displayedOperationProfit === undefined ? "待补" : privacyText(privacy, fmtCny(Math.abs(displayedOperationProfit)))}</strong><small>{displayedOperationDifference === null || displayedOperationDifference === undefined ? "同日投入并持有参照待补" : `相差 ${fmtPercent(displayedOperationDifference)}`}</small></div>
      </div>}
    </Card>
  );
}

function investmentAccountMeta(account: InvestmentLedgerData["accounts"][number]) {
  const owner = account.ownerType === "custody" ? "代持" : "自营";
  const channel = account.accountClass === "fund-platform" ? "场外基金" : account.accountClass === "custody-brokerage" ? "美股／日股" : "场内证券";
  return `${owner} · ${account.baseCurrency} · ${channel}`;
}

function InvestmentScopeSelector({
  ledger,
  accountLedger,
  activeLedger,
  accountId,
  market,
  marketOptions,
  onAccountChange,
  onMarketChange,
  privacy = false,
}: {
  ledger: InvestmentLedgerData;
  accountLedger: InvestmentLedgerData;
  activeLedger: InvestmentLedgerData;
  accountId: string;
  market: InvestmentMarketScope;
  marketOptions: InvestmentMarketScope[];
  onAccountChange: (accountId: string) => void;
  onMarketChange: (market: InvestmentMarketScope) => void;
  privacy?: boolean;
}) {
  const mask = (value: string) => privacyText(privacy, value);
  const snapshots = [...ledger.accountSnapshots]
    .sort((a, b) => b.asOf.localeCompare(a.asOf))
    .filter((row, index, rows) => rows.findIndex((candidate) => candidate.accountId === row.accountId) === index);
  const snapshotByAccount = new Map(snapshots.map((snapshot) => [snapshot.accountId, snapshot]));
  const allAssets = snapshots.reduce((sum, snapshot) => sum + snapshot.totalAssets, 0);
  const selectedSnapshots = accountId === "all" ? snapshots : snapshots.filter((row) => row.accountId === accountId);
  const platformPnl = selectedSnapshots.reduce((sum, row) => sum + (row.reportedPnl || 0), 0);
  const selectedAccount = ledger.accounts.find((account) => account.id === accountId);
  const selectedAccountLabel = selectedAccount?.label || "全部账户";
  const selectedTabId = `investment-account-tab-${selectedAccount ? accountId : "all"}`;
  return (
    <section className="asset-investment-scope" aria-label="投资账户与市场范围">
      <div className="asset-investment-account-switcher">
        <div className="asset-investment-account-tabs" role="tablist" aria-label="选择投资账户">
          <button id="investment-account-tab-all" type="button" role="tab" aria-controls="investment-account-detail" className={accountId === "all" ? "active" : ""} aria-selected={accountId === "all"} onClick={() => onAccountChange("all")}>
            <span><b>全部账户</b><strong>{mask(fmtCny(allAssets))}</strong></span>
            <small>市值 {mask(fmtCny(ledger.portfolio.marketValue))} · 现金 {mask(fmtCny(ledger.portfolio.cash))}</small>
          </button>
          {ledger.accounts.map((account) => {
            const snapshot = snapshotByAccount.get(account.id);
            return (
              <button id={`investment-account-tab-${account.id}`} type="button" role="tab" aria-controls="investment-account-detail" className={accountId === account.id ? "active" : ""} aria-selected={accountId === account.id} onClick={() => onAccountChange(account.id)} key={account.id}>
                <span><b>{mask(account.label)}</b><strong>{snapshot ? mask(fmtCny(snapshot.totalAssets)) : "待补"}</strong></span>
                <small>{snapshot ? `市值 ${mask(fmtCny(snapshot.marketValue))} · 现金 ${mask(fmtCny(snapshot.cash))}` : investmentAccountMeta(account)}</small>
              </button>
            );
          })}
        </div>
      </div>
      <div id="investment-account-detail" className="asset-investment-scope-detail" role="tabpanel" aria-labelledby={selectedTabId}>
        <div className="asset-investment-market-filter">
          <span>账户内市场</span>
          <div role="group" aria-label="筛选当前账户内的投资市场">
            {marketOptions.map((option) => (
              <button type="button" className={market === option ? "active" : ""} aria-pressed={market === option} onClick={() => onMarketChange(option)} key={option}>
                {INVESTMENT_MARKET_LABELS[option]}
              </button>
            ))}
          </div>
          <small>市场只筛选当前账户内的持仓、贡献和曲线；现金与平台累计盈亏保持账户口径。</small>
        </div>
        <div className="asset-investment-overview" aria-label={`${selectedAccountLabel}概览`}>
          <div><span>账户总资产</span><strong>{mask(fmtCny(accountLedger.portfolio.totalAssets))}</strong><small>{accountLedger.portfolio.accountCount} 个账户</small></div>
          <div><span>{market === "all" ? "当前投资市值" : `${INVESTMENT_MARKET_LABELS[market]}方向市值`}</span><strong>{mask(fmtCny(activeLedger.portfolio.marketValue))}</strong><small>占账户资产 {fmtShare(activeLedger.portfolio.investedRatio)}</small></div>
          <div><span>证券现金</span><strong>{mask(fmtCny(accountLedger.portfolio.cash))}</strong><small>暂未按市场细分</small></div>
          <div className={platformPnl >= 0 ? "positive" : "negative"}><span>平台累计盈亏相加</span><strong>{mask(fmtCny(platformPnl))}</strong><small>各平台口径不同，非账户收益率</small></div>
        </div>
      </div>
    </section>
  );
}

function InvestmentCashBridge({ ledger, privacy = false }: { ledger: InvestmentLedgerData; privacy?: boolean }) {
  const bridge = ledger.cashFlowSummaries.find((row) => row.range === "all");
  const account = ledger.accounts.find((row) => row.id === bridge?.accountId);
  if (!bridge) return null;
  const mask = (value: number | null) => value === null ? "待补" : privacyText(privacy, fmtCny(value));
  return (
    <details className="asset-investment-cash-bridge">
      <summary>
        <span><b>账户资金桥</b> · 本金、转入转出与平台累计盈亏</span>
        <small>{privacyText(privacy, account?.label || bridge.accountId)} · 截至 {bridge.asOf}</small>
      </summary>
      <div className="asset-investment-cash-bridge-body">
        <div className="asset-investment-cash-flow" aria-label="全周期账户资金桥">
          <div><span>期初资产</span><strong>{mask(bridge.initialAssets)}</strong></div>
          <i>＋</i>
          <div><span>银证转入</span><strong className="positive">{mask(bridge.transferIn)}</strong></div>
          <i>－</i>
          <div><span>银证转出</span><strong>{mask(bridge.transferOut)}</strong></div>
          <i>＋</i>
          <div><span>平台账户盈亏</span><strong className={(bridge.reportedPnl || 0) >= 0 ? "positive" : "negative"}>{mask(bridge.reportedPnl)}</strong></div>
          <i>＝</i>
          <div className="ending"><span>期末资产</span><strong>{mask(bridge.endingAssets)}</strong></div>
        </div>
        <div className="asset-investment-cash-bridge-note">
          <span>累计净流入 {mask(bridge.netInflow)}</span>
          <span>待对齐差额 {mask(bridge.reconciliationDifference)}</span>
          <small>{bridge.note}</small>
        </div>
      </div>
    </details>
  );
}

function InvestmentDataQuality({ ledger, privacy = false }: { ledger: InvestmentLedgerData; privacy?: boolean }) {
  const mask = (value: string) => privacyText(privacy, value);
  const instruments = new Map(ledger.instruments.map((item) => [item.id, item]));
  const quantity = (value: number) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(value);
  const blockedEpisodes = ledger.analysis.episodes.filter((item) => item.status === "blocked");

  return (
    <details className="asset-investment-data-quality">
      <summary>
        <span><ShieldCheck size={15} />数据质量与逐笔成交</span>
        <small>{ledger.transactions.length} 笔成交 · {ledger.coverage.missing.length} 类待补数据</small>
      </summary>
      <div className="asset-investment-data-quality-body">
        <div className="asset-investment-quality-grid">
          <div>
            <span>当前持仓</span>
            <strong>{ledger.portfolio.reconciledAccountCount}/{ledger.portfolio.accountCount} 个账户对平</strong>
          </div>
          <div>
            <span>账户收益率</span>
            <strong>{ledger.returns.available ? "可计算" : "待资金流水"}</strong>
          </div>
          <div>
            <span>未评分交易段</span>
            <strong>{blockedEpisodes.length} 段</strong>
          </div>
        </div>
        <div className="asset-investment-quality-note">
          <strong>账户级 XIRR／TWR：{ledger.returns.available ? "可计算" : "暂不可计算"}</strong>
          <span>{ledger.returns.reasons.join("；")}。</span>
        </div>
        {ledger.coverage.futureCapture.length ? (
          <div className="asset-investment-future-capture">
            <strong>以后收到新账单或截图时，优先补这些信息</strong>
            <ul>{ledger.coverage.futureCapture.map((item) => <li key={item}>{item}</li>)}</ul>
            <small>不追历史债；从新数据接入日起逐步提高后续区间准确度。</small>
          </div>
        ) : null}
        <Card className="asset-detail asset-investment-transactions">
          <div className="card-title">
            <div><Kicker>成交记录</Kicker><h2>逐笔成交</h2></div>
            <span>{ledger.transactions.length} 笔</span>
          </div>
          <div className="asset-table">
            <table>
              <thead><tr><th>时间</th><th>方向</th><th>证券</th><th>数量</th><th>成交价</th><th>成交额</th><th>费用</th></tr></thead>
              <tbody>
                {ledger.transactions.map((row) => {
                  const rowInstrument = instruments.get(row.instrumentId);
                  return (
                    <tr key={row.id}>
                      <td>{row.tradedAt.slice(0, 19).replace("T", " ")}</td>
                      <td className={row.side === "buy" ? "positive" : "negative"}>{row.side === "buy" ? "买入" : "卖出"}</td>
                      <td><strong>{mask(rowInstrument?.symbol || row.instrumentId)}</strong><small>{mask(rowInstrument?.name || "")}</small></td>
                      <td>{mask(quantity(row.quantity))}</td>
                      <td>{mask(fmtCurrency(row.price, row.currency))}</td>
                      <td>{mask(fmtCurrency(row.grossAmount, row.currency))}</td>
                      <td>{row.fees === null || row.taxes === null ? "待补" : mask(fmtCurrency(row.fees + row.taxes, row.currency))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="asset-investment-sources">
          <strong>账本、行情与基准来源</strong>
          <ExternalSourceDisclosure sources={ledger.marketEvidence.sources.flatMap((source) => source.url ? [{ label: source.label, url: source.url }] : [])} />
          {ledger.marketEvidence.sources.filter((source) => !source.url).map((source) => <span key={source.id}>{source.label}</span>)}
        </div>
      </div>
    </details>
  );
}

function InvestmentLedgerPanel({ ledger, privacy = false, demoMode = false }: { ledger?: InvestmentLedgerData; privacy?: boolean; demoMode?: boolean }) {
  const [initialPreferences] = useState(() => readInvestmentDashboardPreferences(window.localStorage, demoMode));
  const [selectedAccountId, setSelectedAccountId] = useState(initialPreferences.accountId);
  const [marketScope, setMarketScope] = useState<InvestmentMarketScope>(initialPreferences.market);
  const accountScopedLedger = useMemo(() => ledger ? scopeInvestmentLedger(ledger, selectedAccountId, "all") : null, [ledger, selectedAccountId]);
  const marketOptions = useMemo(() => ledger ? availableInvestmentMarkets(ledger, selectedAccountId) : ["all"] as InvestmentMarketScope[], [ledger, selectedAccountId]);
  const scopedLedger = useMemo(() => ledger ? scopeInvestmentLedger(ledger, selectedAccountId, marketScope) : null, [ledger, marketScope, selectedAccountId]);
  const defaultInstrumentId = useMemo(() => scopedLedger?.performance.rows
    .filter((row) => row.transactionCount > 0)
    .toSorted((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity))[0]?.instrumentId
    || scopedLedger?.performance.rows[0]?.instrumentId
    || "", [scopedLedger]);
  const [selectedInstrumentId, setSelectedInstrumentId] = useState(initialPreferences.instrumentId || defaultInstrumentId);
  const [analysisRange, setAnalysisRange] = useState<InvestmentDashboardRange>(initialPreferences.range);
  const [chartMetric, setChartMetric] = useState<InvestmentChartMetric>(initialPreferences.metric);
  const [performanceSort, setPerformanceSort] = useState<InvestmentPerformanceSort>(initialPreferences.sort);
  const [periodResult, setPeriodResult] = useState<InvestmentPeriodPerformance | null>(null);
  const [periodLoading, setPeriodLoading] = useState(false);
  const periodBounds = useMemo(() => investmentRangeBounds(analysisRange, ledger?.performance.to || ""), [analysisRange, ledger?.performance.to]);
  useEffect(() => {
    if (!ledger || privacy) {
      setPeriodResult(null);
      return;
    }
    if (demoMode) {
      setPeriodResult(readAssetDisplayDemoPerformance(periodBounds.from, periodBounds.to));
      setPeriodLoading(false);
      return;
    }
    let cancelled = false;
    const query = new URLSearchParams();
    if (periodBounds.from) query.set("from", periodBounds.from);
    if (periodBounds.to) query.set("to", periodBounds.to);
    setPeriodLoading(true);
    jsonFetch<InvestmentPeriodPerformance>(`/api/assets/investment-performance?${query.toString()}`)
      .then((next) => { if (!cancelled) setPeriodResult(next); })
      .catch((error) => {
        if (!cancelled) setPeriodResult({
          available: false,
          from: periodBounds.from || ledger.performance.from,
          to: periodBounds.to,
          sourceLabel: "",
          summary: { totalCount: 0, availableCount: 0, positiveCount: 0, negativeCount: 0, totalProfit: 0 },
          rows: [],
          message: error instanceof Error ? error.message : "区间收益暂时不可用。",
        });
      })
      .finally(() => { if (!cancelled) setPeriodLoading(false); });
    return () => { cancelled = true; };
  }, [demoMode, ledger, periodBounds.from, periodBounds.to, privacy]);
  const scopedPeriod = useMemo(() => scopedLedger ? scopeInvestmentPeriodPerformance(periodResult, scopedLedger) : null, [periodResult, scopedLedger]);
  const years = useMemo(() => {
    const firstYear = Number(scopedLedger?.performance.from.slice(0, 4));
    const lastYear = Number(scopedLedger?.performance.to.slice(0, 4));
    if (!firstYear || !lastYear || firstYear > lastYear) return [];
    return Array.from({ length: lastYear - firstYear + 1 }, (_, index) => String(lastYear - index));
  }, [scopedLedger?.performance.from, scopedLedger?.performance.to]);
  useEffect(() => {
    if (!ledger || selectedAccountId === "all") return;
    if (!ledger.accounts.some((account) => account.id === selectedAccountId)) setSelectedAccountId("all");
  }, [ledger, selectedAccountId]);
  useEffect(() => {
    if (!marketOptions.includes(marketScope)) setMarketScope("all");
  }, [marketOptions, marketScope]);
  useEffect(() => {
    if (!scopedLedger) return;
    if (!selectedInstrumentId || !scopedLedger.instruments.some((row) => row.id === selectedInstrumentId)) setSelectedInstrumentId(defaultInstrumentId);
  }, [defaultInstrumentId, scopedLedger, selectedInstrumentId]);
  useEffect(() => {
    if (!ledger?.available) return;
    writeInvestmentDashboardPreferences({
      accountId: selectedAccountId,
      market: marketScope,
      instrumentId: selectedInstrumentId,
      range: analysisRange,
      metric: chartMetric,
      sort: performanceSort,
    }, window.localStorage, demoMode);
  }, [analysisRange, chartMetric, demoMode, ledger?.available, marketScope, performanceSort, selectedAccountId, selectedInstrumentId]);
  if (!ledger?.available || !accountScopedLedger || !scopedLedger) return <Empty>{ledger?.message || "投资账本还没有接入。"}</Empty>;

  const mask = (value: string) => privacyText(privacy, value);
  const instrumentById = new Map(scopedLedger.instruments.map((row) => [row.id, row]));
  const tradedInstrumentCount = new Set(scopedLedger.transactions.map((row) => row.instrumentId)).size;
  const largestInstrument = instrumentById.get(scopedLedger.portfolio.largestPositionId);
  const accountReconciled = accountScopedLedger.portfolio.reconciledAccountCount === accountScopedLedger.portfolio.accountCount;
  const primaryExposure = scopedLedger.portfolio.exposures[0];
  const selectAccount = (accountId: string) => {
    setSelectedAccountId(accountId);
    setMarketScope("all");
  };

  return (
    <section className="asset-investment-dashboard">
      <header className="asset-investment-dashboard-head">
        <div>
          <Kicker>投资 · 截至 {scopedLedger.portfolio.asOf}</Kicker>
          <h2>跨市场投资账户</h2>
        </div>
        <div className="asset-investment-context" aria-label="看板范围">
          <span>统一折合 {scopedLedger.baseCurrency} · 代持沿用账本固定汇率</span>
          <span className={accountReconciled ? "matched" : "mismatch"}>{accountReconciled ? "持仓已对平" : "存在持仓差额"}</span>
        </div>
      </header>

      <InvestmentScopeSelector
        ledger={ledger}
        accountLedger={accountScopedLedger}
        activeLedger={scopedLedger}
        accountId={selectedAccountId}
        market={marketScope}
        marketOptions={marketOptions}
        onAccountChange={selectAccount}
        onMarketChange={setMarketScope}
        privacy={privacy}
      />

      <InvestmentFullCycleBoard ledger={scopedLedger} period={scopedPeriod} selectedInstrumentId={selectedInstrumentId || defaultInstrumentId} onSelectInstrument={setSelectedInstrumentId} privacy={privacy} range={analysisRange} onRangeChange={setAnalysisRange} years={years} metric={chartMetric} onMetricChange={setChartMetric} demoMode={demoMode} />

      {selectedAccountId === "all" ? null : <InvestmentCashBridge ledger={accountScopedLedger} privacy={privacy} />}

      <InvestmentPerformanceBoard ledger={scopedLedger} period={scopedPeriod} loading={periodLoading} selectedInstrumentId={selectedInstrumentId || defaultInstrumentId} onSelectInstrument={setSelectedInstrumentId} privacy={privacy} range={analysisRange} onRangeChange={setAnalysisRange} years={years} sort={performanceSort} onSortChange={setPerformanceSort} />

      <Card className="asset-investment-exposure-strip">
        <div><span>{marketScope === "all" ? "当前投资仓位" : "所选市场仓位"}</span><strong>{fmtShare(scopedLedger.portfolio.investedRatio)}</strong></div>
        <div><span>最大单项</span><strong>{mask(fmtShare(scopedLedger.portfolio.largestPositionWeight))}</strong><small>{mask(largestInstrument?.name || "—")}</small></div>
        <div><span>主要市场暴露</span><strong>{fmtShare(primaryExposure?.weight ?? null, 0)}</strong><small>{primaryExposure?.name || "未分类"}</small></div>
        <div><span>成交覆盖</span><strong>{scopedLedger.transactions.length} 笔</strong><small>{tradedInstrumentCount} 个历史标的</small></div>
      </Card>

      {demoMode ? null : <InvestmentDataQuality ledger={scopedLedger} privacy={privacy} />}
    </section>
  );
}

export default function AssetsPage({ displayMode = false, onAskSecretary }: { displayMode?: boolean; onAskSecretary?: (seedUser: string) => void }) {
  const useDemoPortfolio = true;
  const [privateData, setData] = useState<AssetVaultData | null>(null);
  const [password, setPassword] = useState("");
  const [unlockEditable, setUnlockEditable] = useState(false);
  const [error, setError] = useState("");
  const [accessDenied, setAccessDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState("");
  const [pickerYear, setPickerYear] = useState<number | null>(null);
  const [tab, setTab] = useState<AssetsTab>(readAssetsTab);
  const [fxMode, setFxMode] = useState<FxMode>("stable");
  const [custodyImporting, setCustodyImporting] = useState(false);
  const [custodyMessage, setCustodyMessage] = useState("");
  const [selectedMonths, setSelectedMonths] = useState<string[]>([]);
  const unlockInputRef = useRef<HTMLInputElement>(null);
  const tabButtonRefs = useRef<Partial<Record<AssetsTab, HTMLButtonElement | null>>>({});
  const data = useDemoPortfolio || displayMode ? ASSET_DISPLAY_DEMO : privateData;

  useEffect(() => {
    const onPop = () => setTab(readAssetsTab());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const writeAssetsTab = (next: AssetsTab) => {
    const url = new URL(window.location.href);
    if (next === "networth") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const selectAssetsTab = (next: AssetsTab, focus = false) => {
    setTab(next);
    writeAssetsTab(next);
    if (!focus) return;
    requestAnimationFrame(() => tabButtonRefs.current[next]?.focus());
  };

  const onAssetsTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const order = ASSET_TABS.map((item) => item.id);
    const index = order.indexOf(tab);
    if (index < 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % order.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + order.length) % order.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = order.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectAssetsTab(order[nextIndex]!, true);
  };

  const loadAssets = async () => {
    if (useDemoPortfolio || displayMode) {
      const latest = ASSET_DISPLAY_DEMO.snapshots.at(-1)?.date || "";
      setSelectedDate(latest);
      if (latest) setPickerYear(Number(latest.slice(0, 4)) || null);
      setSelectedMonths(ASSET_DISPLAY_DEMO.cashflow?.latestMonth ? [ASSET_DISPLAY_DEMO.cashflow.latestMonth] : []);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/assets", { credentials: "same-origin" });
      const body = await response.json();
      if (response.status === 403 && body.code === "PRIVATE_ACCESS_REQUIRED") {
        setData(null);
        setAccessDenied(true);
        setError("");
        return;
      }
      if (response.status === 401) {
        setData(null);
        setAccessDenied(false);
        setError("");
        return;
      }
      if (!response.ok) throw new Error(body.error || "无法读取资产数据");
      setData(body);
      setAccessDenied(false);
      const latest = body.snapshots.at(-1)?.date || "";
      setSelectedDate((old) => {
        if (old && body.snapshots.some((item: AssetSnapshot) => item.date === old)) return old;
        return latest;
      });
      if (latest) setPickerYear(Number(latest.slice(0, 4)) || null);
      setError("");
      const months: Array<{ month: string }> = body.cashflow?.months ?? [];
      const latestMonth = body.cashflow?.latestMonth || "";
      setSelectedMonths((old) => {
        const valid = old.filter((month) => months.some((item) => item.month === month));
        if (valid.length) return valid;
        return latestMonth ? [latestMonth] : [];
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取资产数据");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAssets();
  }, [displayMode, useDemoPortfolio]);

  useEffect(() => {
    if (data || loading || accessDenied) return;
    setUnlockEditable(false);
    const timer = window.setTimeout(() => unlockInputRef.current?.focus({ preventScroll: true }), 120);
    return () => window.clearTimeout(timer);
  }, [accessDenied, data, loading]);

  const stableRate = data?.fx?.stableJpyToCny ?? 0.047;
  const liveRate = data?.fx?.liveJpyToCny ?? null;
  const activeRate = resolveJpyToCny(fxMode, stableRate, liveRate);
  const valuedSnapshots = useMemo(
    () => (data?.snapshots ?? []).map((item) => revalueSnapshot(item, activeRate)),
    [data?.snapshots, activeRate],
  );
  const valuedTrend = useMemo(
    () =>
      valuedSnapshots.map((item) => ({
        date: item.date,
        month: snapshotMonthKey(item.date),
        label: monthTitle(snapshotMonthKey(item.date)),
        netAssets: item.netAssets,
      })),
    [valuedSnapshots],
  );
  const snapshotsByMonth = useMemo(() => {
    const map = new Map<string, AssetSnapshot>();
    for (const item of valuedSnapshots) map.set(snapshotMonthKey(item.date), item);
    return map;
  }, [valuedSnapshots]);
  const availableYears = useMemo(() => {
    const years = [...new Set([...snapshotsByMonth.keys()].map((key) => Number(key.slice(0, 4))).filter(Boolean))];
    return years.sort((a, b) => a - b);
  }, [snapshotsByMonth]);
  const activePickerYear = pickerYear ?? availableYears.at(-1) ?? new Date().getFullYear();
  const canPrevYear = availableYears.some((year) => year < activePickerYear);
  const canNextYear = availableYears.some((year) => year > activePickerYear);
  const trendDomain = useMemo(
    () => trendYDomain(valuedTrend.map((item) => item.netAssets)),
    [valuedTrend],
  );

  const unlock = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/assets/unlock", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "无法解锁");
      setPassword("");
      setUnlockEditable(false);
      await loadAssets();
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : "无法解锁");
      setLoading(false);
    }
  };

  const lock = async () => {
    await fetch("/api/assets/lock", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    setData(null);
    setPassword("");
    setUnlockEditable(false);
    setError("");
  };

  const importCustody = async () => {
    setCustodyImporting(true);
    setCustodyMessage("");
    try {
      const response = await fetch("/api/assets/custody/import-downloads", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "导入失败");
      const created = body.imported?.createdAt ? `（创建于 ${body.imported.createdAt}）` : "";
      setCustodyMessage(`已导入 ${body.imported?.name || "代持表"}${created}`);
      await loadAssets();
    } catch (reason) {
      setCustodyMessage(reason instanceof Error ? reason.message : "导入失败");
    } finally {
      setCustodyImporting(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="asset-loading">
        <LoaderCircle className="spin" />
        <span>正在读取资产与账单…</span>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="asset-locked-page">
        <motion.div className="asset-unlock-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <div className="asset-lock-emblem">
            <ShieldCheck size={30} />
          </div>
          <Kicker>私人内容</Kicker>
          <h2>这台设备尚未授权</h2>
          <p>工作台其它内容仍可使用。私人资产数据仅对已受信任设备开放。</p>
          <small>
            <LockKeyhole size={13} />
            授权按设备与访问来源判断，与屏幕大小无关
          </small>
        </motion.div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="asset-locked-page">
        <motion.div className="asset-unlock-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <div className="asset-lock-emblem">
            <LockKeyhole size={30} />
          </div>
          <Kicker>资产保险库</Kicker>
          <h2>资产管理已锁定</h2>
          <p className="asset-unlock-hint">
            <span>解锁前金额不会离开这台电脑</span>
            <span>15 分钟后自动重新锁上</span>
          </p>
          <form
            className="asset-unlock-form"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              if (password && !loading) void unlock();
            }}
          >
            <label>
              解锁码
              <input
                ref={unlockInputRef}
                className="asset-unlock-input"
                type="text"
                name="infans_local_vault_token"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                inputMode="text"
                data-1p-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
                readOnly={!unlockEditable}
                onFocus={() => setUnlockEditable(true)}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入解锁码"
              />
            </label>
            {error ? <div className="asset-error">{error}</div> : null}
            <button type="submit" className="gold-button" disabled={!password || loading}>
              {loading ? "正在验证…" : "解锁资产管理"}
            </button>
          </form>
          <small>
            <ShieldCheck size={13} />
            只在这台电脑上看 · 不进搜索、也不给 AI
          </small>
        </motion.div>
      </div>
    );
  }

  if (!valuedSnapshots.length) {
    return (
      <div className="asset-locked-page">
        <div className="asset-unlock-card" role="status">
          <Kicker>资产管理</Kicker>
          <h2>还没有可用的资产快照</h2>
          <p>缺失记录不会被当成 0。补齐或恢复资产资料后再刷新。</p>
        </div>
      </div>
    );
  }

  const snapshot: AssetSnapshot = valuedSnapshots.find((item) => item.date === selectedDate) ?? valuedSnapshots.at(-1)!;
  const previous = valuedSnapshots[valuedSnapshots.findIndex((item) => item.date === snapshot.date) - 1];
  const change = previous ? snapshot.netAssets - previous.netAssets : 0;
  const changeRate = previous?.netAssets ? (change / previous.netAssets) * 100 : 0;
  const maxCategory = Math.max(...snapshot.categories.map((item) => Math.abs(item.value)), 1);
  const detailGroups = groupItemsByCategory(snapshot.items);
  const assetDetailGroups = detailGroups.filter((group) => !isLiabilityGroup(group.category, group.totalCny));
  const liabilityDetailGroups = detailGroups.filter((group) => isLiabilityGroup(group.category, group.totalCny));
  const privacy = false;
  const mask = (value: string) => privacyText(privacy, value);

  return (
    <div className={`asset-dashboard asset-dashboard-wide${useDemoPortfolio || displayMode ? " is-demo" : ""}`}>
      <div className="asset-tabs-row">
        <div className="asset-tabs" role="tablist" aria-label="资产管理分区">
          {ASSET_TABS.map((item) => {
            const selected = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={item.tabDomId}
                aria-selected={selected}
                aria-controls={item.panelId}
                tabIndex={selected ? 0 : -1}
                className={selected ? "active" : ""}
                ref={(node) => {
                  tabButtonRefs.current[item.id] = node;
                }}
                onClick={() => selectAssetsTab(item.id)}
                onKeyDown={onAssetsTabKeyDown}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        {!data.openAccess ? (
          <div className="asset-tabs-tools">
            <button type="button" className="asset-lock-chip" onClick={() => void lock()} title="立即锁定">
              <LockKeyhole size={14} />
            </button>
          </div>
        ) : null}
      </div>

      {tab === "income" ? (
        <div
          className="asset-tab-panel"
          role="tabpanel"
          id="asset-panel-income"
          aria-labelledby="asset-tab-income"
        >
          <AssetCashflowPanel
            mode="income"
            cashflow={data.cashflow}
            custody={data.custody}
            bankIncome={data.bankIncome}
            selectedMonths={selectedMonths}
            onSelectedMonthsChange={setSelectedMonths}
            jpyToCny={activeRate}
            fxMode={fxMode}
            stableJpyToCny={stableRate}
            liveJpyToCny={liveRate}
            liveUpdatedAt={data.fx?.liveUpdatedAt}
            onFxModeChange={setFxMode}
            privacy={privacy}
            onRefresh={loadAssets}
          />
        </div>
      ) : null}

      {tab === "investments" ? (
        <div
          className="asset-tab-panel"
          role="tabpanel"
          id="asset-panel-investments"
          aria-labelledby="asset-tab-investments"
        >
          <InvestmentLedgerPanel key={useDemoPortfolio || displayMode ? "demo-investments" : "real-investments"} ledger={data.investments} privacy={privacy} demoMode={useDemoPortfolio || displayMode} />
        </div>
      ) : null}

      {tab === "expense" ? (
        <div
          className="asset-tab-panel"
          role="tabpanel"
          id="asset-panel-expense"
          aria-labelledby="asset-tab-expense"
        >
          <AssetCashflowPanel
            mode="expense"
            cashflow={data.cashflow}
            fixedExpenses={data.fixedExpenses}
            selectedMonths={selectedMonths}
            onSelectedMonthsChange={setSelectedMonths}
            jpyToCny={activeRate}
            fxMode={fxMode}
            stableJpyToCny={stableRate}
            liveJpyToCny={liveRate}
            liveUpdatedAt={data.fx?.liveUpdatedAt}
            onFxModeChange={setFxMode}
            privacy={privacy}
            onRefresh={loadAssets}
          />
        </div>
      ) : null}

      {tab === "networth" ? (
        <div
          className="asset-tab-panel"
          role="tabpanel"
          id="asset-panel-networth"
          aria-labelledby="asset-tab-networth"
        >
          <Card className="asset-hero">
            <div>
              <Kicker>
                净资产 · {monthTitle(snapshotMonthKey(snapshot.date))}
                {useDemoPortfolio || displayMode ? <span className="asset-display-demo-label">虚构演示</span> : null}
                {snapshot.proxy ? " · 顶替数据" : ""}
                {snapshot.custodyOverlaid ? " · 含代持刷新" : ""}
              </Kicker>
              <h2>{mask(fmtCny(snapshot.netAssets))}</h2>
              <p className={change >= 0 ? "positive" : "negative"}>
                {previous
                  ? mask(`比上一期 ${change >= 0 ? "+" : ""}${fmtCny(change)}（${changeRate >= 0 ? "+" : ""}${changeRate.toFixed(2)}%）`)
                  : "第一期记录"}
              </p>
              {snapshot.proxy ? (
                <p className="asset-proxy-banner" role="status">
                  {snapshot.proxyNote ||
                    `顶替数据：本期末无法补采，数字沿用 ${snapshot.proxyOf || "上一期"}，勿当真实盘点。`}
                </p>
              ) : null}
              <div className="asset-fx-chips" role="group" aria-label="日元折算口径">
                <button type="button" className={fxMode === "stable" ? "active" : ""} onClick={() => setFxMode("stable")}>
                  固定基准 4.7
                </button>
                <button
                  type="button"
                  className={fxMode === "live" ? "active" : ""}
                  disabled={!liveRate}
                  onClick={() => liveRate && setFxMode("live")}
                >
                  实时 {liveRate ? (liveRate * 100).toFixed(3) : "暂无"}
                </button>
                <small>
                  所有月份统一按 100 日元 = {(activeRate * 100).toFixed(3)} 元人民币重算
                  {fxMode === "live" && data.fx?.liveUpdatedAt ? ` · 来源时间 ${fmtDate(data.fx.liveUpdatedAt)}` : ""}
                </small>
              </div>
            </div>
            <div className="asset-snapshot-picker" aria-label="按月查看净资产">
              <span>查看月份</span>
              <div className="asset-month-cal">
                <div className="asset-month-cal-nav">
                  <button
                    type="button"
                    aria-label="上一年"
                    disabled={!canPrevYear}
                    onClick={() => setPickerYear(shiftYear(activePickerYear, -1))}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <strong>{activePickerYear}年</strong>
                  <button
                    type="button"
                    aria-label="下一年"
                    disabled={!canNextYear}
                    onClick={() => setPickerYear(shiftYear(activePickerYear, 1))}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
                <div className="asset-month-cal-grid">
                  {Array.from({ length: 12 }, (_, index) => {
                    const month = index + 1;
                    const key = `${activePickerYear}-${String(month).padStart(2, "0")}`;
                    const hit = snapshotsByMonth.get(key);
                    const active = hit && hit.date === snapshot.date;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={[hit ? "has-snap" : "no-snap", active ? "active" : ""].filter(Boolean).join(" ")}
                        disabled={!hit}
                        aria-current={active ? "true" : undefined}
                        onClick={() => hit && setSelectedDate(hit.date)}
                      >
                        {month}月
                      </button>
                    );
                  })}
                </div>
              </div>
              <small>
                {snapshot.proxy
                  ? `顶替 · 沿用 ${snapshot.proxyOf || "上一期"}`
                  : `标成月末 · 实采于 ${fmtDate(snapshotLabelDate(snapshot))}`}
                {data.source.syncedAt ? ` · 同步 ${fmtDate(data.source.syncedAt)}` : ""}
              </small>
            </div>
          </Card>
          <section className="asset-metrics">
            <Card>
              <span>总资产</span>
              <strong>{mask(fmtCny(snapshot.totalAssets))}</strong>
              <small>{snapshot.items.filter((item) => item.cnyValue > 0).length} 个资产项目</small>
            </Card>
            <Card>
              <span>总负债</span>
              <strong>{mask(fmtCny(snapshot.totalLiabilities))}</strong>
              <small>{snapshot.items.filter((item) => item.cnyValue < 0).length} 个负债项目</small>
            </Card>
            <Card>
              <span>资产负债率</span>
              <strong>{mask(snapshot.totalAssets ? `${((snapshot.totalLiabilities / snapshot.totalAssets) * 100).toFixed(1)}%` : "0.0%")}</strong>
              <small>欠的钱占总资产多少</small>
            </Card>
          </section>
          <Card className="asset-trend">
            <div className="card-title">
              <div>
                <Kicker>历史</Kicker>
                <h2>净资产趋势</h2>
              </div>
              <LineChartIcon size={18} />
            </div>
            <div className="asset-chart">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={valuedTrend}>
                  <defs>
                    <linearGradient id="assetTrend" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--gold)" stopOpacity={0.32} />
                      <stop offset="95%" stopColor="var(--gold)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: "var(--quiet)", fontSize: "var(--text-micro)" }} axisLine={false} tickLine={false} />
                  <YAxis
                    domain={trendDomain}
                    tickFormatter={(value) => fmtCny(Number(value), true)}
                    tick={{ fill: "var(--quiet)", fontSize: "var(--text-micro)" }}
                    axisLine={false}
                    tickLine={false}
                    width={62}
                  />
                  <Tooltip
                    formatter={(value) => fmtCny(Number(value))}
                    contentStyle={{ background: "var(--surface-2)", color: "var(--ink)", border: "1px solid var(--line-strong)", borderRadius: 8, fontSize: "var(--text-micro)" }}
                  />
                  <Area type="monotone" dataKey="netAssets" name="净资产" stroke="var(--gold)" strokeWidth={2} fill="url(#assetTrend)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card className="asset-allocation">
            <div className="card-title">
              <div>
                <Kicker>配置</Kicker>
                <h2>资产结构</h2>
              </div>
              <div className="asset-allocation-actions">
                <span>{snapshot.categories.length} 类</span>
                {onAskSecretary ? (
                  <button
                    type="button"
                    className="asset-ask-secretary"
                    onClick={() => onAskSecretary(buildAssetHealthSeed(snapshot, previous))}
                  >
                    <MessageSquareText size={13} />
                    问问小秘书
                  </button>
                ) : null}
              </div>
            </div>
            <p className="asset-allocation-hint">可以让小秘书根据当前结构，讲讲近期资产健康度。</p>
            <div className="allocation-list">
              {snapshot.categories.map((item) => (
                <div key={item.name}>
                  <header>
                    <strong>{mask(item.name)}</strong>
                    <span className={item.value < 0 ? "negative" : ""}>{mask(fmtCny(item.value))}</span>
                  </header>
                  <i>
                    <b className={item.value < 0 ? "negative" : ""} style={{ width: `${(Math.abs(item.value) / maxCategory) * 100}%` }} />
                  </i>
                </div>
              ))}
            </div>
          </Card>
          <section className="asset-detail-groups" aria-label="资产明细">
            <div className="asset-detail-groups-head">
              <div>
                <h2>资产明细</h2>
              </div>
              <span>按类型分卡 · 账号只显示别名或后几位</span>
            </div>
            <DetailGroupCards groups={assetDetailGroups} privacy={privacy} />
          </section>
          <section className="asset-detail-groups" aria-label="负债明细">
            <div className="asset-detail-groups-head">
              <div>
                <h2>负债明细</h2>
              </div>
              <span>贷款与信用卡欠款</span>
            </div>
            <DetailGroupCards groups={liabilityDetailGroups} privacy={privacy} />
            <footer className="asset-detail-groups-foot">
              <span>
                <ShieldCheck size={13} />
                私密数据 · 不保存密码和完整账号
              </span>
              {data.source.url ? (
                <a href={data.source.url} target="_blank" rel="noreferrer">
                  打开 Google 原表
                  <ArrowUpRight size={12} />
                </a>
              ) : null}
            </footer>
          </section>
          <CustodyPanel
            custody={data.custody}
            jpyToCny={activeRate}
            privacy={privacy}
            onImport={() => void importCustody()}
            importing={custodyImporting}
            message={custodyMessage}
          />
        </div>
      ) : null}
    </div>
  );
}
