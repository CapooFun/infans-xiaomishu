import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChevronLeft,
  ChevronRight,
  FolderDown,
  LineChart,
  X,
} from "lucide-react";
import type {
  AssetBankIncomeData,
  AssetCashflowData,
  AssetCashflowEntry,
  AssetCashflowMonth,
  AssetCustodyData,
  AssetFixedExpenseItem,
  AssetFixedExpensesData,
} from "../types";
import { Card, Empty, Kicker, fmtCny, fmtCurrency, fmtDate } from "../page-shared";
import { tokyoDateKey } from "../tokyo-time.mjs";
import { useIsNarrowViewport, useVisualViewportBackdropStyle } from "../shell/useVisualViewportBox";
import { convertAmountToCny, DEFAULT_STABLE_JPY_TO_CNY } from "../asset-fx.mjs";

const STABLE_JPY_TO_CNY = DEFAULT_STABLE_JPY_TO_CNY;

/** 东京日历当前月 YYYY-MM；固定备忘不得摊到未到来的月份。 */
function tokyoMonthKey(value = new Date()) {
  return tokyoDateKey(value).slice(0, 7);
}

export type CashflowMode = "income" | "expense";

const CAT_TONE: Record<string, string> = {
  吃喝: "teal",
  饮食: "teal",
  便利店: "teal",
  出行: "teal",
  出行旅游: "teal",
  健康: "teal",
  健康护理: "teal",
  收入: "teal",
  工资: "teal",
  "失待/补助": "teal",
  报销: "teal",
  退款: "teal",
  债权回收: "mist",
  还款入账: "mist",
  代收代付: "mist",
  购物: "gold",
  订阅: "gold",
  订阅娱乐: "gold",
  游戏: "gold",
  公司支出: "gold",
  娱乐: "gold",
  人情: "gold",
  转账红包: "gold",
  学习: "gold",
  手续费: "gold",
  居住: "gold",
  居住通讯: "gold",
  房租: "gold",
  SoftBank: "gold",
  "SoftBank 光": "gold",
  还款: "gold",
  闪电贷月供: "gold",
  租房入住: "gold",
  租房中介: "gold",
  开网一次性: "gold",
  学费: "gold",
  租房大事: "gold",
  资金划转: "mist",
  当面扫码: "mist",
  当面付款: "mist",
  物流: "gold",
  其他: "mist",
  待确认: "mist",
};

const STACK_COLORS = ["var(--teal)", "var(--gold)", "var(--mist-blue)", "var(--red)", "color-mix(in srgb, var(--red) 45%, var(--mist-blue))", "color-mix(in srgb, var(--teal) 60%, var(--gold))"];
const STACK_GRADIENTS = STACK_COLORS.map((color, index) => ({
  id: `life-finance-grad-${index}`,
  color,
}));

const BANK_CAT_LABEL: Record<string, string> = {
  salary: "工资",
  unemployment: "失待/补助",
  reimbursement: "报销",
  receivableIn: "债权回收",
};

function monthTitle(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) return month;
  const [y, m] = month.split("-");
  return `${y} 年 ${Number(m)} 月`;
}

function formatShortCny(value: number) {
  const abs = Math.abs(value);
  if (abs >= 10_000) return `${(value / 10_000).toFixed(abs >= 100_000 ? 0 : 1)}万`;
  return fmtCny(value);
}

function channelLabel(channel?: string) {
  if (channel === "alipay") return "支付宝";
  if (channel === "paypay") return "PayPay";
  if (channel === "icbc") return "工行";
  if (channel === "memo") return "备忘";
  return "微信";
}

function moneyLabel(amount: number, currency?: string) {
  if (currency === "JPY") return fmtCurrency(amount, "JPY");
  return fmtCny(amount);
}

function toCny(amount: number, currency?: string, jpyToCny = STABLE_JPY_TO_CNY) {
  return convertAmountToCny(amount, currency, jpyToCny);
}

function selectionLabel(selected: string[]) {
  if (!selected.length) return "还没选月份";
  if (selected.length === 1) return monthTitle(selected[0]);
  const years = [...new Set(selected.map((m) => m.slice(0, 4)))];
  if (years.length === 1) {
    const months = selected.map((m) => Number(m.slice(5))).sort((a, b) => a - b);
    return `${years[0]} 年 ${months.join("、")} 月（共 ${selected.length} 个月）`;
  }
  return `已选 ${selected.length} 个月`;
}

function monthKeyFromDate(date: string) {
  return /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : "";
}

function bankIncomeEntries(bankIncome: AssetBankIncomeData | undefined, selected: string[]): AssetCashflowEntry[] {
  if (!bankIncome?.incomeItems?.length) return [];
  const set = new Set(selected);
  return bankIncome.incomeItems
    .filter((item) => set.has(monthKeyFromDate(item.date)))
    .map((item) => {
      const category = BANK_CAT_LABEL[item.categoryKey] || item.categoryLabel || "收入";
      return {
        id: `bank:${item.id}`,
        at: item.date.length === 10 ? `${item.date}T12:00:00` : item.date,
        day: item.date.slice(0, 10),
        name: item.counterparty || item.type || category,
        amount: item.amount,
        kind: "income" as const,
        category,
        type: item.type || category,
        method: "工行借记",
        status: "备忘",
        note: item.note || "",
        channel: "icbc",
        currency: "CNY",
      };
    });
}

function fixedCoveredByLedger(row: AssetCashflowEntry, existing: AssetCashflowEntry[]) {
  if (row.channel !== "memo" || !String(row.id).startsWith("fixed-month:")) return false;
  const name = row.name || "";
  return existing.some((item) => {
    // 只认真实支出；PayPay「ポイント・残高の獲得」等退款/积分不能盖住整笔月费备忘
    if (item.channel === "memo" || item.kind !== "expense") return false;
    const hay = `${item.name || ""} ${item.note || ""}`;
    if (/Octopus|电费/.test(name) && /Octopus|オクトパス|电费|エナジー/i.test(hay)) return true;
    if (/燃气/.test(name) && /ガス|燃气|Tokyo\s*Gas|東京ガス/i.test(hay)) return true;
    if (/水道/.test(name) && /水道|東京水/i.test(hay)) return true;
    if (/Netflix/.test(name) && /Netflix/i.test(hay)) return true;
    if (/JOYFIT/.test(name) && /JOYFIT/i.test(hay)) return true;
    // ChatGPT 走 Apple 账单：勿用任意「Apple」小额（表情包等）误伤
    if (/ChatGPT/.test(name) && /ChatGPT|Appleサービス|apple\.com\/bill/i.test(hay)) return true;
    if (/Cursor/.test(name) && /Cursor|Stripe/i.test(hay)) return true;
    if (/Language Reactor/.test(name) && /Language Reactor|LANG REACT|Paddle/i.test(hay)) return true;
    if (/SoftBank/.test(name) && /SoftBank|ソフトバンク/i.test(hay)) return true;
    if (/房租/.test(name) && /房租|保证料/i.test(hay)) return true;
    return false;
  });
}

function fixedMemoEntries(fixed: AssetFixedExpensesData | undefined, selected: string[]): AssetCashflowEntry[] {
  if (!fixed?.items?.length) return [];
  const set = new Set(selected);
  const currentMonth = tokyoMonthKey();
  const rows: AssetCashflowEntry[] = [];
  for (const item of fixed.items) {
    if (item.amount == null) continue;
    const group = item.group || (item.kind === "receivable" ? "receivable" : item.kind === "monthly" ? "living" : "event");
    if (group === "receivable") continue;
    if (group === "event") {
      const month = item.eventMonth || "";
      if (!month || month > currentMonth || !set.has(month)) continue;
      const category = item.name.includes("SoftBank")
        ? "居住"
        : item.name.includes("诺亚")
          ? "学习"
          : item.name.includes("机票") || item.name.includes("差旅") || item.name.includes("航空")
            ? "出行"
            : item.name.includes("燃气") ||
                item.name.includes("水道") ||
                item.name.includes("电费") ||
                item.name.includes("Octopus") ||
                item.name.includes("中介") ||
                item.name.includes("入住") ||
                item.name.includes("房租")
              ? "居住"
              : "居住";
      rows.push({
        id: `fixed-event:${item.id}:${month}`,
        at: `${item.eventDate || `${month}-15`}T12:00:00`,
        day: item.eventDate || `${month}-15`,
        name: item.name,
        amount: item.amount,
        kind: "expense",
        category,
        type: "一次性",
        method: "备忘",
        status: "confirmed",
        note: item.note || "",
        channel: "memo",
        currency: item.currency || "JPY",
      });
      continue;
    }
    if (item.kind !== "monthly") continue;
    for (const month of selected) {
      if (month > currentMonth) continue;
      if (item.fromMonth && month < item.fromMonth) continue;
      const category =
        group === "repayment"
          ? "还款"
          : item.name.includes("Cursor")
            ? "公司支出"
            : item.name.includes("SoftBank") ||
                item.name.includes("房租") ||
                item.name.includes("保证料") ||
                item.name.includes("Octopus") ||
                item.name.includes("电费") ||
                item.name.includes("燃气") ||
                item.name.includes("水道")
              ? "居住"
              : item.name.includes("Netflix") ||
                  item.name.includes("ChatGPT") ||
                  item.name.includes("Language Reactor")
                ? "订阅"
                : item.name.includes("JOYFIT")
                  ? "健康"
                  : "居住";
      rows.push({
        id: `fixed-month:${item.id}:${month}`,
        at: `${month}-${String(item.dueDay || 15).padStart(2, "0")}T12:00:00`,
        day: `${month}-${String(item.dueDay || 15).padStart(2, "0")}`,
        name: item.name,
        amount: item.amount,
        kind: "expense",
        category,
        type: group === "repayment" ? "固定还款" : "固定生活",
        method: "备忘",
        status: "confirmed",
        note: item.note || "",
        channel: "memo",
        currency: item.currency || "CNY",
      });
    }
  }
  return rows;
}

function aggregateFromLedger(ledger: AssetCashflowEntry[], jpyToCny: number) {
  let income = 0;
  let expense = 0;
  let neutral = 0;
  let incomeJpy = 0;
  let expenseJpy = 0;
  let neutralJpy = 0;
  let incomeCount = 0;
  let expenseCount = 0;
  let neutralCount = 0;
  for (const row of ledger) {
    const cny = toCny(row.amount, row.currency, jpyToCny);
    if (row.kind === "income") {
      income += cny;
      incomeCount += 1;
      if (row.currency === "JPY") incomeJpy += row.amount;
    } else if (row.kind === "expense") {
      expense += cny;
      expenseCount += 1;
      if (row.currency === "JPY") expenseJpy += row.amount;
    } else {
      neutral += cny;
      neutralCount += 1;
      if (row.currency === "JPY") neutralJpy += row.amount;
    }
  }
  return {
    income,
    expense,
    neutral,
    balance: income - expense,
    incomeJpy,
    expenseJpy,
    neutralJpy,
    balanceJpy: incomeJpy - expenseJpy,
    incomeCount,
    expenseCount,
    neutralCount,
    monthCount: 0,
  };
}

function categoriesFromLedger(ledger: AssetCashflowEntry[], kind: "income" | "expense", jpyToCny: number) {
  const catMap = new Map<string, { name: string; cny: number; count: number }>();
  for (const row of ledger) {
    if (row.kind !== kind) continue;
    const name = row.category || "待确认";
    const prev = catMap.get(name) || { name, cny: 0, count: 0 };
    prev.cny += toCny(row.amount, row.currency, jpyToCny);
    prev.count += 1;
    catMap.set(name, prev);
  }
  return [...catMap.values()]
    .map((item) => ({
      name: item.name,
      amount: item.cny,
      currency: "CNY" as const,
      cny: item.cny,
      count: item.count,
    }))
    .sort((a, b) => Math.abs(b.cny) - Math.abs(a.cny));
}

function topNames(ledger: AssetCashflowEntry[], category: string, kind: string, jpyToCny: number, limit = 3) {
  const map = new Map<string, number>();
  for (const row of ledger) {
    if (row.kind !== kind || row.category !== category) continue;
    const name = row.name || "未命名";
    map.set(name, (map.get(name) ?? 0) + toCny(row.amount, row.currency, jpyToCny));
  }
  return [...map.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, limit)
    .map(([name, cny]) => ({ name, cny }));
}

function formatSharePct(share: number) {
  if (!(share > 0)) return "0%";
  if (share < 10) return `${share.toFixed(1)}%`;
  return `${Math.round(share)}%`;
}

function topSources(ledger: AssetCashflowEntry[], kind: "income" | "expense", jpyToCny: number, limit = 3) {
  const map = new Map<string, number>();
  let total = 0;
  for (const row of ledger) {
    if (row.kind !== kind) continue;
    const cny = toCny(row.amount, row.currency, jpyToCny);
    total += Math.abs(cny);
    const label = row.category || row.name;
    map.set(label, (map.get(label) ?? 0) + cny);
  }
  return [...map.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, limit)
    .map(([name, cny]) => ({
      name,
      cny,
      share: total > 0 ? (Math.abs(cny) / total) * 100 : 0,
    }));
}

function stackedTrend(
  selected: string[],
  ledgerByMonth: Record<string, AssetCashflowEntry[]>,
  kind: "income" | "expense",
  topCats: string[],
  jpyToCny: number,
) {
  return selected.map((month) => {
    const rows = ledgerByMonth[month] ?? [];
    const point: Record<string, string | number> = {
      month,
      label: `${month.slice(2).replace("-", "/")}`,
    };
    for (const cat of topCats) {
      point[cat] = rows
        .filter((row) => row.kind === kind && row.category === cat)
        .reduce((sum, row) => sum + (kind === "expense" ? Math.abs(toCny(row.amount, row.currency, jpyToCny)) : toCny(row.amount, row.currency, jpyToCny)), 0);
    }
    return point;
  });
}

/** 趋势图取大类：按区间合计取前几名，名称去重。 */
function pickTrendCategories(
  selected: string[],
  ledgerByMonth: Record<string, AssetCashflowEntry[]>,
  kind: "income" | "expense",
  jpyToCny: number,
  limit = 5,
) {
  const map = new Map<string, number>();
  for (const month of selected) {
    for (const row of ledgerByMonth[month] ?? []) {
      if (row.kind !== kind) continue;
      const name = row.category || "待确认";
      map.set(name, (map.get(name) ?? 0) + Math.abs(toCny(row.amount, row.currency, jpyToCny)));
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

function BillImportModal({
  cashflow,
  importing,
  onClose,
  onImport,
}: {
  cashflow: AssetCashflowData;
  importing: boolean;
  onClose: () => void;
  onImport: () => void;
}) {
  const picks = [
    cashflow.downloadPicks?.wechat,
    cashflow.downloadPicks?.paypay,
    cashflow.downloadPicks?.alipay,
  ].filter(Boolean);
  const narrow = useIsNarrowViewport();
  const backdropStyle = useVisualViewportBackdropStyle(narrow, "center");
  return (
    <div className="modal-backdrop compact-confirm-backdrop" style={backdropStyle} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="preview-modal compact-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="life-bill-import-title" aria-describedby="life-bill-import-description">
        <h2 id="life-bill-import-title">确认写入？</h2>
        <p id="life-bill-import-description">
          {picks.length ? `将把下载文件夹里的 ${picks.length} 份生活账单写入账单库。` : "下载文件夹里还没有可导入的生活账单。"}
        </p>
        <footer>
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="gold-button" disabled={!picks.length || importing} onClick={onImport}>
            {importing ? "正在写入…" : "确认写入"}
          </button>
        </footer>
      </div>
    </div>
  );
}

const FIXED_SUBGROUP_ORDER = [
  { id: "living_cost", title: "生活成本" },
  { id: "subscription", title: "订阅" },
  { id: "deduction", title: "扣款" },
] as const;

function fixedSubgroupOf(item: AssetFixedExpenseItem): (typeof FIXED_SUBGROUP_ORDER)[number]["id"] {
  if (item.subgroup === "living_cost" || item.subgroup === "subscription" || item.subgroup === "deduction") {
    return item.subgroup;
  }
  if (item.group === "repayment") return "deduction";
  const name = item.name || "";
  if (
    name.includes("Netflix") ||
    name.includes("Language Reactor") ||
    name.includes("ChatGPT") ||
    name.includes("Cursor")
  ) {
    return "subscription";
  }
  return "living_cost";
}

function prepareFixedMonthlyItems(items: AssetFixedExpenseItem[]): AssetFixedExpenseItem[] {
  const monthly = items.filter(
    (item) =>
      item.kind === "monthly" &&
      (item.group === "living" || item.group === "repayment"),
  );
  const rent = monthly.find((item) => item.id === "rent-monthly" || (item.name === "房租" && !item.name.includes("保证")));
  const hosho = monthly.find((item) => item.id === "rent-hosho-monthly" || item.name.includes("保证料"));
  const mergedId = "rent-package-monthly";
  const alreadyMerged = monthly.some((item) => item.id === mergedId || item.name.includes("含保证料"));
  const drop = new Set<string>();
  const out: AssetFixedExpenseItem[] = [];

  if (rent && hosho && !alreadyMerged) {
    drop.add(rent.id);
    drop.add(hosho.id);
    out.push({
      id: mergedId,
      name: "房租（含保证料）",
      kind: "monthly",
      group: "living",
      subgroup: "living_cost",
      amount: Number(rent.amount || 0) + Number(hosho.amount || 0),
      currency: rent.currency || hosho.currency || "JPY",
      fromMonth: rent.fromMonth || hosho.fromMonth,
      dueDay: rent.dueDay || hosho.dueDay,
      status: rent.status || hosho.status,
      note: `房租 ${Number(rent.amount || 0).toLocaleString("zh-CN")} + 保证料 ${Number(hosho.amount || 0).toLocaleString("zh-CN")}，每月一起缴。${rent.note || ""}`,
    });
  }

  for (const item of monthly) {
    if (drop.has(item.id)) continue;
    out.push(item);
  }
  return out;
}

function FixedPairCards({ items, jpyToCny, privacy = false }: { items: AssetFixedExpenseItem[]; jpyToCny: number; privacy?: boolean }) {
  const prepared = prepareFixedMonthlyItems(items);
  const mask = (value: string) => (privacy ? "**********" : value);

  const sections = FIXED_SUBGROUP_ORDER.map((section) => {
    const rows = prepared
      .filter((item) => fixedSubgroupOf(item) === section.id)
      .sort((a, b) => toCny(b.amount ?? 0, b.currency, jpyToCny) - toCny(a.amount ?? 0, a.currency, jpyToCny));
    return { ...section, rows };
  }).filter((section) => section.rows.length > 0);

  const render = (rows: AssetFixedExpenseItem[]) =>
    rows.map((item) => (
      <article key={item.id} className="life-finance-fixed-item">
        <div>
          <strong>{mask(item.name)}</strong>
          <small>
            {item.group === "repayment" || fixedSubgroupOf(item) === "deduction"
              ? "固定还款 · 不算生活开支"
              : "每月"}
            {item.fromMonth ? ` · 自 ${item.fromMonth}` : ""}
            {item.fromDate ? ` · 自 ${item.fromDate}` : ""}
            {item.dueDay ? ` · 约每月 ${item.dueDay} 日` : ""}
          </small>
          {item.note ? <em>{mask(item.note)}</em> : null}
        </div>
        <span>{mask(item.amount == null ? "金额待确认" : `${item.approximate ? "约 " : ""}${moneyLabel(item.amount, item.currency)}`)}</span>
      </article>
    ));

  return (
    <Card className="life-finance-fixed">
      <div className="card-title">
        <div>
          <h2>每月固定要扣的</h2>
        </div>
        <span>生活成本 · 订阅 · 扣款</span>
      </div>
      {sections.length ? (
        <div className="life-finance-fixed-sections">
          {sections.map((section) => (
            <section key={section.id} className="life-finance-fixed-section">
              <h3>{section.title}</h3>
              <div className="life-finance-fixed-list cols-2">{render(section.rows)}</div>
            </section>
          ))}
        </div>
      ) : (
        <Empty>还没有固定扣款备忘。</Empty>
      )}
    </Card>
  );
}

export default function AssetCashflowPanel({
  mode,
  cashflow,
  fixedExpenses,
  bankIncome,
  selectedMonths,
  onSelectedMonthsChange,
  jpyToCny = STABLE_JPY_TO_CNY,
  fxMode,
  stableJpyToCny,
  liveJpyToCny,
  liveUpdatedAt,
  onFxModeChange,
  privacy = false,
  onRefresh,
}: {
  mode: CashflowMode;
  cashflow?: AssetCashflowData;
  custody?: AssetCustodyData;
  fixedExpenses?: AssetFixedExpensesData;
  bankIncome?: AssetBankIncomeData;
  selectedMonths: string[];
  onSelectedMonthsChange: (months: string[]) => void;
  jpyToCny?: number;
  fxMode: "stable" | "live";
  stableJpyToCny: number;
  liveJpyToCny: number | null;
  liveUpdatedAt?: string | null;
  onFxModeChange: (mode: "stable" | "live") => void;
  privacy?: boolean;
  onRefresh?: () => Promise<void> | void;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [expandedCat, setExpandedCat] = useState<string | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [pickerYear, setPickerYear] = useState<number | null>(null);

  const months = useMemo(() => {
    const currentMonth = tokyoMonthKey();
    const map = new Map<string, AssetCashflowMonth>();
    for (const item of cashflow?.months ?? []) {
      if (item.month > currentMonth) continue;
      map.set(item.month, item);
    }
    const ensure = (month: string) => {
      if (!/^\d{4}-\d{2}$/.test(month) || month > currentMonth || map.has(month)) return;
      map.set(month, {
        month,
        income: 0,
        expense: 0,
        neutral: 0,
        balance: 0,
        incomeCount: 0,
        expenseCount: 0,
        neutralCount: 0,
        categories: [],
      });
    };
    if (mode === "income") {
      for (const item of bankIncome?.incomeItems ?? []) ensure(monthKeyFromDate(item.date));
    } else {
      for (const item of fixedExpenses?.items ?? []) {
        if (item.eventMonth) ensure(item.eventMonth);
        // fromMonth 只表示「从哪月开始摊」，不能单独点亮还没到的月份（如水道自 9 月）
        if (item.fromMonth) ensure(item.fromMonth);
      }
    }
    return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
  }, [cashflow?.months, bankIncome?.incomeItems, fixedExpenses?.items, mode]);

  const selected = useMemo(() => {
    const valid = selectedMonths.filter((month) => months.some((item) => item.month === month));
    if (valid.length) return [...valid].sort();
    return cashflow?.latestMonth ? [cashflow.latestMonth] : months.length ? [months.at(-1)!.month] : [];
  }, [selectedMonths, months, cashflow?.latestMonth]);

  const mergedLedgerByMonth = useMemo(() => {
    const map: Record<string, AssetCashflowEntry[]> = {};
    for (const month of selected) {
      const base = [...(cashflow?.ledgerByMonth?.[month] ?? [])];
      map[month] = base;
    }
    const extras = [
      ...bankIncomeEntries(bankIncome, selected),
      ...(mode === "expense" ? fixedMemoEntries(fixedExpenses, selected) : []),
    ];
    for (const row of extras) {
      const month = monthKeyFromDate(row.day || row.at);
      if (!month || !selected.includes(month)) continue;
      if (!map[month]) map[month] = [];
      if (fixedCoveredByLedger(row, map[month])) continue;
      map[month].push(row);
    }
    for (const month of Object.keys(map)) {
      map[month].sort((a, b) => a.at.localeCompare(b.at));
    }
    return map;
  }, [cashflow, bankIncome, fixedExpenses, selected, mode]);

  const ledger = useMemo(() => {
    const rows: AssetCashflowEntry[] = [];
    for (const month of selected) rows.push(...(mergedLedgerByMonth[month] ?? []));
    return rows;
  }, [mergedLedgerByMonth, selected]);

  const summary = useMemo(() => {
    const base = aggregateFromLedger(ledger, jpyToCny);
    return { ...base, monthCount: selected.length };
  }, [ledger, selected, jpyToCny]);

  const categories = useMemo(() => categoriesFromLedger(ledger, mode, jpyToCny), [ledger, mode, jpyToCny]);
  const maxCatCny = Math.max(...categories.map((item) => Math.abs(item.cny)), 1);
  const mainSources = useMemo(() => topSources(ledger, mode, jpyToCny, 3), [ledger, mode, jpyToCny]);

  const monthsByYear = useMemo(() => {
    const map = new Map<string, AssetCashflowMonth[]>();
    for (const item of months) {
      const year = item.month.slice(0, 4);
      if (!map.has(year)) map.set(year, []);
      map.get(year)!.push(item);
    }
    return [...map.entries()];
  }, [months]);

  const availableYears = useMemo(
    () => monthsByYear.map(([year]) => Number(year)).filter(Boolean).sort((a, b) => a - b),
    [monthsByYear],
  );
  const activePickerYear =
    pickerYear ?? Number(selected.at(-1)?.slice(0, 4)) ?? availableYears.at(-1) ?? new Date().getFullYear();
  const canPrevYear = availableYears.some((year) => year < activePickerYear);
  const canNextYear = availableYears.some((year) => year > activePickerYear);
  const monthsInPickerYear = useMemo(() => {
    const set = new Set(
      (monthsByYear.find(([year]) => Number(year) === activePickerYear)?.[1] ?? []).map((item) => item.month),
    );
    return set;
  }, [monthsByYear, activePickerYear]);

  const showTrend = selected.length > 1;
  const trendCats = useMemo(
    () => (showTrend ? pickTrendCategories(selected, mergedLedgerByMonth, mode, jpyToCny, 5) : []),
    [showTrend, selected, mergedLedgerByMonth, mode, jpyToCny],
  );
  const trendData = useMemo(
    () => (showTrend ? stackedTrend(selected, mergedLedgerByMonth, mode, trendCats, jpyToCny) : []),
    [showTrend, selected, mergedLedgerByMonth, mode, trendCats, jpyToCny],
  );

  const toggleMonth = (month: string) => {
    if (!multiSelect) {
      onSelectedMonthsChange([month]);
      setExpandedCat(null);
      return;
    }
    const next = selected.includes(month) ? selected.filter((item) => item !== month) : [...selected, month].sort();
    onSelectedMonthsChange(next.length ? next : [month]);
    setExpandedCat(null);
  };

  const selectWholeYear = (year: number) => {
    const keys = months
      .map((item) => item.month)
      .filter((month) => month.startsWith(`${year}-`))
      .sort();
    if (!keys.length) return;
    setPickerYear(year);
    setMultiSelect(true);
    onSelectedMonthsChange(keys);
    setExpandedCat(null);
  };

  const importDownloads = async () => {
    setImporting(true);
    setImportMessage("");
    try {
      const response = await fetch("/api/assets/bills/import-downloads", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "导入失败");
      const names = (body.imported ?? [])
        .map((item: { name: string; createdAt: string }) => `${item.name}（创建于 ${item.createdAt}）`)
        .join("；");
      setImportMessage(names ? `已导入：${names}` : "已导入");
      setImportOpen(false);
      await onRefresh?.();
    } catch (reason) {
      setImportMessage(reason instanceof Error ? reason.message : "导入失败");
    } finally {
      setImporting(false);
    }
  };

  const isIncome = mode === "income";
  const heroTitle = isIncome ? "收入" : "支出";
  const catTitle = isIncome ? "钱从哪进来" : "钱花在哪";
  const catEmpty = isIncome ? "这个范围没有进账记录。" : "这个范围没有支出记录。";
  const mask = (value: string) => (privacy ? "**********" : value);

  if (!cashflow) {
    return (
      <Card className="life-finance-hero">
        <div className="life-finance-hero-main">
          <h2>{heroTitle}</h2>
          <Empty>还没有账单数据。</Empty>
        </div>
      </Card>
    );
  }

  const hasDownloadPicks = Boolean(
    cashflow.downloadPicks?.wechat || cashflow.downloadPicks?.paypay || cashflow.downloadPicks?.alipay,
  );

  return (
    <div className="life-finance">
      {importOpen ? (
        <BillImportModal
          cashflow={cashflow}
          importing={importing}
          onClose={() => setImportOpen(false)}
          onImport={() => void importDownloads()}
        />
      ) : null}

      <Card className="life-finance-hero">
        <div className="life-finance-hero-main">
          <Kicker>
            {heroTitle} · {selectionLabel(selected)}
          </Kicker>
          <h2 className={isIncome ? "pos" : "neg"}>{mask(fmtCny(isIncome ? summary.income : summary.expense))}</h2>
          <p>
            {isIncome ? "进账合计（折合人民币）" : "花掉合计（折合人民币）"} ·{" "}
            {isIncome ? summary.incomeCount : summary.expenseCount} 笔
            {isIncome
              ? summary.incomeJpy
                ? ` · 日元 ${mask(fmtCurrency(summary.incomeJpy, "JPY"))}`
                : " · 含工行备忘"
              : summary.expenseJpy
                ? ` · 日元 ${mask(fmtCurrency(summary.expenseJpy, "JPY"))}`
                : " · 含固定备忘"}
          </p>
          <div className="asset-fx-chips" role="group" aria-label={`${heroTitle}日元折算口径`}>
            <button type="button" className={fxMode === "stable" ? "active" : ""} onClick={() => onFxModeChange("stable")}>
              固定基准 {(stableJpyToCny * 100).toFixed(1)}
            </button>
            <button
              type="button"
              className={fxMode === "live" ? "active" : ""}
              disabled={!liveJpyToCny}
              onClick={() => liveJpyToCny && onFxModeChange("live")}
            >
              实时 {liveJpyToCny ? (liveJpyToCny * 100).toFixed(3) : "暂无"}
            </button>
            <small>
              所选月份统一按 100 日元 = {(jpyToCny * 100).toFixed(3)} 元人民币重算
              {fxMode === "live" && liveUpdatedAt ? ` · 来源时间 ${fmtDate(liveUpdatedAt)}` : ""}
            </small>
          </div>
          <p className="life-finance-hero-note">
            来源：{cashflow.sourceLabel}
            {isIncome ? " + 工行备忘" : " + 固定备忘"}。已读入渠道 {cashflow.transactionCount} 笔。原始日元金额不变；当前仅切换人民币比较口径。
          </p>
          <div className="life-finance-hero-actions">
            <button type="button" className="life-finance-import-btn" onClick={() => setImportOpen(true)}>
              <FolderDown size={15} />
              {hasDownloadPicks ? "检查下载账单" : "从下载文件夹导入"}
            </button>
            {importMessage ? <span>{importMessage}</span> : null}
          </div>
        </div>

        <div className="asset-snapshot-picker" aria-label="选择月份">
          <span>查看月份</span>
          <div className="asset-month-cal">
            <div className="asset-month-cal-nav">
              <button
                type="button"
                aria-label="上一年"
                disabled={!canPrevYear}
                onClick={() => setPickerYear(activePickerYear - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <strong>
                <button
                  type="button"
                  className="asset-month-cal-year"
                  title="点年份选中该年有数据的全部月份"
                  onClick={() => selectWholeYear(activePickerYear)}
                >
                  {activePickerYear}年
                </button>
              </strong>
              <button
                type="button"
                aria-label="下一年"
                disabled={!canNextYear}
                onClick={() => setPickerYear(activePickerYear + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="asset-month-cal-grid">
              {Array.from({ length: 12 }, (_, index) => {
                const month = index + 1;
                const key = `${activePickerYear}-${String(month).padStart(2, "0")}`;
                const hit = monthsInPickerYear.has(key);
                const active = selected.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    className={[hit ? "has-snap" : "no-snap", active ? "active" : ""].filter(Boolean).join(" ")}
                    disabled={!hit}
                    aria-pressed={active}
                    onClick={() => hit && toggleMonth(key)}
                  >
                    {month}月
                  </button>
                );
              })}
            </div>
          </div>
          <button
            type="button"
            className={`life-finance-multi-toggle ${multiSelect ? "active" : ""}`}
            aria-pressed={multiSelect}
            onClick={() => {
              setMultiSelect((old) => {
                const next = !old;
                if (!next && selected.length > 1) onSelectedMonthsChange([selected.at(-1)!]);
                return next;
              });
            }}
          >
            {multiSelect ? "多选中" : "多选"}
          </button>
        </div>
      </Card>

      <Card className="life-finance-invest">
        <div className="card-title">
          <div>
            <Kicker>前三</Kicker>
            <h2>{isIncome ? "这段时间主要进账" : "这段时间主要花销"}</h2>
          </div>
          <span>{selectionLabel(selected)}</span>
        </div>
        {mainSources.length ? (
          <div className="life-finance-top3">
            {mainSources.map((item, index) => (
              <div key={item.name}>
                <small>第 {index + 1}</small>
                <strong>{mask(item.name)}</strong>
                <span>
                  {mask(fmtCny(item.cny))}
                  <b className="life-finance-top3-share">
                    {isIncome ? "占进账" : "占花销"} {formatSharePct(item.share)}
                  </b>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>这个范围还没有可汇总的分项。</Empty>
        )}
      </Card>

      {mode === "expense" && fixedExpenses?.items?.length ? <FixedPairCards items={fixedExpenses.items} jpyToCny={jpyToCny} privacy={privacy} /> : null}

      {showTrend ? (
        <Card className="life-finance-trend">
          <div className="card-title">
            <div>
              <Kicker>趋势</Kicker>
              <h2>已选月份 · {isIncome ? "大类进账" : "大类花销"}（折合人民币）</h2>
            </div>
            <LineChart size={18} />
          </div>
          <div className="life-finance-chart tall">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
                <defs>
                  {STACK_GRADIENTS.map((item) => (
                    <linearGradient key={item.id} id={item.id} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={item.color} stopOpacity={0.7} />
                      <stop offset="100%" stopColor={item.color} stopOpacity={0.08} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid stroke="var(--line)" strokeDasharray="3 6" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "var(--muted)", fontSize: "var(--text-meta)" }} axisLine={false} tickLine={false} />
                <YAxis
                  tickFormatter={(value) => formatShortCny(Number(value))}
                  tick={{ fill: "var(--muted)", fontSize: "var(--text-meta)" }}
                  axisLine={false}
                  tickLine={false}
                  width={58}
                />
                <Tooltip
                  formatter={(value, name) => [fmtCny(Number(value)), String(name)]}
                  labelFormatter={(_, payload) => {
                    const row = payload?.[0]?.payload as { month?: string } | undefined;
                    return row?.month ? monthTitle(row.month) : "";
                  }}
                  contentStyle={{
                    background: "var(--surface-2)",
                    color: "var(--ink)",
                    border: "1px solid var(--line-strong)",
                    borderRadius: 12,
                    fontSize: "var(--text-meta)",
                    boxShadow: "0 12px 28px var(--shadow-soft)",
                  }}
                  itemSorter={(item) => -Number(item.value || 0)}
                />
                {trendCats.map((cat, index) => (
                  <Area
                    key={cat}
                    type="monotone"
                    dataKey={cat}
                    name={cat}
                    stackId="spend"
                    stroke={STACK_COLORS[index % STACK_COLORS.length]}
                    fill={`url(#${STACK_GRADIENTS[index % STACK_GRADIENTS.length].id})`}
                    strokeWidth={2}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <footer className="life-finance-legend pills">
            {trendCats.map((cat, index) => (
              <span key={`${cat}-${index}`}>
                <i style={{ background: STACK_COLORS[index % STACK_COLORS.length] }} /> {cat}
              </span>
            ))}
          </footer>
        </Card>
      ) : null}

      <Card className="life-finance-cats">
        <div className="card-title">
          <div>
            <Kicker>{isIncome ? "从哪来" : "花到哪"}</Kicker>
            <h2>
              {selectionLabel(selected)} · {catTitle}
            </h2>
          </div>
          <span>点分类展开明细 · 按折合人民币排序</span>
        </div>
        <div className="life-finance-cat-list">
          {categories.length ? (
            categories.map((item) => {
              const key = item.name;
              const open = expandedCat === key;
              const items = ledger.filter((row) => row.kind === mode && row.category === item.name);
              const tops = topNames(ledger, item.name, mode, jpyToCny, 3);
              return (
                <div key={key} className={`tone-${CAT_TONE[item.name] ?? "mist"} ${open ? "is-open" : ""}`}>
                  <button type="button" className="life-finance-cat-toggle" onClick={() => setExpandedCat(open ? null : key)}>
                    <header>
                      <strong>{item.name}</strong>
                      <span>{mask(fmtCny(item.cny))}</span>
                    </header>
                    <i>
                      <b style={{ width: `${(Math.abs(item.cny) / maxCatCny) * 100}%` }} />
                    </i>
                    <small>
                      {tops.length ? `主要：${tops.map((row) => mask(row.name)).join("、")} · ` : ""}
                      {item.count} 笔 · {open ? "收起" : "展开"}
                    </small>
                  </button>
                  {open ? (
                    <div className="life-finance-cat-entries">
                      {tops.length ? (
                        <div className="life-finance-cat-tops" aria-label="这类里金额前三">
                          {tops.map((row, index) => (
                            <article key={`${row.name}-${index}`} className="is-top">
                              <time>前 {index + 1}</time>
                              <div>
                                <strong>{mask(row.name)}</strong>
                                <small>这类里汇总最高的来源之一</small>
                              </div>
                              <span>{mask(fmtCny(row.cny))}</span>
                            </article>
                          ))}
                        </div>
                      ) : null}
                      {items.length ? (
                        items
                          .slice()
                          .sort((a, b) => Math.abs(toCny(b.amount, b.currency, jpyToCny)) - Math.abs(toCny(a.amount, a.currency, jpyToCny)))
                          .map((row) => (
                            <article key={row.id}>
                              <time>{row.at.slice(0, 10)}</time>
                              <div>
                                <strong>{mask(row.name)}</strong>
                                <small>
                                  {channelLabel(row.channel)} · {row.type}
                                  {row.method && row.method !== "/" ? ` · ${row.method}` : ""}
                                </small>
                              </div>
                              <span>
                                {isIncome ? "+" : "−"}
                                {mask(moneyLabel(row.amount, row.currency))}
                              </span>
                            </article>
                          ))
                      ) : (
                        <Empty>这类没有明细。</Empty>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <Empty>{catEmpty}</Empty>
          )}
        </div>
      </Card>
    </div>
  );
}
