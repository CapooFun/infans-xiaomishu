import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CircleDollarSign,
  Eye,
  Footprints,
  Gamepad2,
  MousePointerClick,
  RefreshCw,
  RotateCcw,
  Timer,
} from "lucide-react";
import type { GameAnalyticsSummary } from "../../types";
import { Card, Empty, Kicker, fmtDateTime, jsonFetch } from "../../page-shared";

type Environment = GameAnalyticsSummary["environment"];
const RANGES = [7, 30, 90] as const;

function rate(value: number | null) {
  return value == null ? "—" : `${value}%`;
}

function Metric({ label, value, note }: { label: string; value: string | number; note: string }) {
  return (
    <Card className="game-analytics-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </Card>
  );
}

function JourneyStep({ icon: Icon, label, value, rateValue, last = false }: {
  icon: typeof Eye;
  label: string;
  value: number;
  rateValue?: number | null;
  last?: boolean;
}) {
  return (
    <li className={last ? "is-last" : ""}>
      <span className="game-journey-mark"><Icon size={18} aria-hidden="true" /></span>
      <div><small>{label}</small><strong>{value}</strong></div>
      {rateValue !== undefined ? <em>{rate(rateValue)}</em> : null}
    </li>
  );
}

function Breakdown({ title, rows }: { title: string; rows: GameAnalyticsSummary["versions"] }) {
  const total = rows.reduce((sum, row) => sum + row.eventCount, 0);
  return (
    <Card className="game-analytics-breakdown">
      <div className="card-title"><div><Kicker>拆分</Kicker><h3>{title}</h3></div><span>{total} 条事件</span></div>
      {rows.length ? (
        <ol>
          {rows.map((row) => {
            const width = total ? Math.max(4, (row.eventCount / total) * 100) : 0;
            return (
              <li key={row.label}>
                <div><strong>{row.label}</strong><span>{row.eventCount}</span></div>
                <i aria-hidden="true"><b style={{ width: `${width}%` }} /></i>
              </li>
            );
          })}
        </ol>
      ) : <p className="game-analytics-none">这个范围还没有可拆分的数据。</p>}
    </Card>
  );
}

export default function GameAnalyticsDashboard({ active }: { active: boolean }) {
  const [environment, setEnvironment] = useState<Environment>("production");
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [data, setData] = useState<GameAnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({
        game_id: "example-game",
        environment,
        days: String(days),
      });
      if (force) query.set("force", "1");
      setData(await jsonFetch<GameAnalyticsSummary>(`/api/tools/game-analytics?${query}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读不到游戏经营数据");
    } finally {
      setLoading(false);
    }
  }, [days, environment]);

  useEffect(() => {
    if (!active) return;
    void load(false);
  }, [active, load]);

  const metrics = data?.metrics;
  const empty = Boolean(data && data.eventCount === 0);
  return (
    <div className="game-analytics-dashboard">
      <Card className="game-analytics-hero">
        <div className="game-analytics-hero-copy">
          <Kicker>示例游戏 · 网页体验</Kicker>
          <div className="game-analytics-title-row">
            <span aria-hidden="true"><Gamepad2 size={26} /></span>
            <div><h2>示例游戏经营观测</h2><p>从有人来，到真正玩下去；先看清体验，再谈流量和收入。</p></div>
          </div>
        </div>
        <div className="game-analytics-freshness">
          <small>数据新鲜度</small>
          <strong>{data?.dataUpdatedAt ? fmtDateTime(data.dataUpdatedAt) : "还没有数据"}</strong>
          <span>{environment === "production" ? "正式官网" : "本机接线"} · 最近 {days} 天</span>
          <button type="button" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} size={14} aria-hidden="true" />刷新数据
          </button>
        </div>
      </Card>

      <div className="game-analytics-controls" aria-label="数据范围">
        <div className="game-analytics-segment" aria-label="数据环境">
          <button type="button" aria-pressed={environment === "production"} onClick={() => setEnvironment("production")}>正式</button>
          <button type="button" aria-pressed={environment === "development"} onClick={() => setEnvironment("development")}>本机接线</button>
        </div>
        <div className="game-analytics-segment" aria-label="时间范围">
          {RANGES.map((range) => (
            <button key={range} type="button" aria-pressed={days === range} onClick={() => setDays(range)}>{range} 天</button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="game-analytics-error" role="alert">
          <AlertTriangle size={18} />
          <div><strong>暂时读不到经营数据</strong><span>{error}</span></div>
          <button type="button" onClick={() => void load(true)}>重新读取</button>
        </div>
      ) : null}

      {loading && !data ? <Empty>正在读取游戏经营数据。</Empty> : null}
      {empty ? (
        <Card className="game-analytics-empty">
          <span aria-hidden="true"><Footprints size={28} /></span>
          <div>
            <Kicker>{environment === "production" ? "等待正式接入" : "等待本机事件"}</Kicker>
            <h3>{environment === "production" ? "官网数据还没有进入这块看板" : "还没有本机开发版的游玩事件"}</h3>
            <p>{data?.boundary}</p>
          </div>
        </Card>
      ) : null}

      {data && metrics ? (
        <>
          <section className="game-analytics-metrics" aria-label="核心指标">
            <Metric label="访问会话" value={metrics.pageViews} note="打开游戏页面" />
            <Metric label="成功开玩" value={metrics.playStarts} note={`开玩率 ${rate(metrics.playStartRate)}`} />
            <Metric label="玩到 5 分钟" value={metrics.play5m} note={`继续率 ${rate(metrics.play5mRate)}`} />
            <Metric label="玩到 15 分钟" value={metrics.play15m} note={`继续率 ${rate(metrics.play15mRate)}`} />
          </section>

          <Card className="game-analytics-journey">
            <div className="card-title">
              <div><Kicker>修行路径</Kicker><h3>玩家有没有真正走进去</h3></div>
              <span>{data.eventCount} 条匿名事件</span>
            </div>
            <ol>
              <JourneyStep icon={Eye} label="来访" value={metrics.pageViews} />
              <JourneyStep icon={Gamepad2} label="开玩" value={metrics.playStarts} rateValue={metrics.playStartRate} />
              <JourneyStep icon={Timer} label="5 分钟" value={metrics.play5m} rateValue={metrics.play5mRate} />
              <JourneyStep icon={Timer} label="15 分钟" value={metrics.play15m} rateValue={metrics.play15mRate} />
              <JourneyStep icon={Footprints} label="探索归来" value={metrics.runEnds} rateValue={metrics.runEndRate} last />
            </ol>
          </Card>

          <section className="game-analytics-lower">
            <Card className="game-analytics-loop">
              <div className="card-title"><div><Kicker>玩法循环</Kicker><h3>这一世走到哪里</h3></div><RotateCcw size={19} /></div>
              <dl>
                <div><dt>会话结束</dt><dd>{metrics.sessionEnds}</dd></div>
                <div><dt>开始探索</dt><dd>{metrics.runStarts}</dd></div>
                <div><dt>结束探索</dt><dd>{metrics.runEnds}</dd></div>
                <div><dt>死亡</dt><dd>{metrics.deaths}</dd></div>
                <div><dt>轮回</dt><dd>{metrics.reincarnations}</dd></div>
                <div><dt>Steam 点击</dt><dd>{metrics.steamClicks}</dd></div>
              </dl>
              <p><MousePointerClick size={14} />当前网页体验尚未加入 Steam 按钮；这里先保留统一归因事件位。</p>
            </Card>
            <Card className="game-analytics-income">
              <div className="card-title"><div><Kicker>收入</Kicker><h3>还没有接入收入来源</h3></div><CircleDollarSign size={19} /></div>
              <dl>
                <div><dt>广告收入</dt><dd>—</dd></div>
                <div><dt>Steam 销售</dt><dd>—</dd></div>
                <div><dt>其他收入</dt><dd>—</dd></div>
              </dl>
              <p>空白代表没有接入平台，不代表收入为 0。</p>
            </Card>
          </section>

          <section className="game-analytics-breakdowns">
            <Breakdown title="版本表现" rows={data.versions} />
            <Breakdown title="渠道表现" rows={data.channels} />
          </section>

          <p className="game-analytics-boundary">{data.boundary}</p>
        </>
      ) : null}
    </div>
  );
}
