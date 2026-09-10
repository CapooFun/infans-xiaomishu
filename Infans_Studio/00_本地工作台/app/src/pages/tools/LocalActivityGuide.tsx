import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { ArrowLeft, BookOpenText, CalendarDays, CircleDotDashed, ExternalLink, Share2 } from "lucide-react";

import { Card, Empty, Kicker, jsonFetch } from "../../page-shared";
import { stripDisplayFrontmatter } from "../../markdown-display.mjs";
import type { LocalActivityGuideDocument } from "../../types";
import GuideOfficialImage from "./GuideOfficialImage";
import { isMacDesktopBrowser } from "./guide-share-platform.mjs";

type GuideSection = { title: string; markdown: string };

const WIDE_SECTIONS = new Set(["当前结论", "为什么值得去", "听讲抓手", "展览内容与看展抓手", "来源与核验边界"]);

function shareDocumentTitle(data: LocalActivityGuideDocument) {
  const base = (data.shareName || data.name || "本地活动攻略")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${base || "本地活动攻略"}｜分享攻略`;
}

function splitGuideSections(markdown: string): GuideSection[] {
  const lines = stripDisplayFrontmatter(markdown).split(/\r?\n/);
  const sections: GuideSection[] = [];
  let title = "";
  let body: string[] = [];
  const finish = () => {
    if (title && body.some((line) => line.trim())) sections.push({ title, markdown: body.join("\n").trim() });
  };
  for (const line of lines) {
    if (/^#\s+/.test(line)) continue;
    const heading = line.match(/^##\s+(.+)$/)?.[1]?.trim();
    if (heading) {
      finish();
      title = heading;
      body = [];
    } else if (title) {
      body.push(line);
    }
  }
  finish();
  return sections;
}

const markdownComponents = {
  a: ({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) => (
    <a href={href} target="_blank" rel="noreferrer" {...rest}>{children}<ExternalLink size={12} /></a>
  ),
};

export default function LocalActivityGuide({ id, onBack, backLabel }: { id: string; onBack: () => void; backLabel: string }) {
  const [data, setData] = useState<LocalActivityGuideDocument | null>(null);
  const [error, setError] = useState("");
  const [preparingShare, setPreparingShare] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  const [canSharePdf] = useState(isMacDesktopBrowser);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    void jsonFetch<LocalActivityGuideDocument>(`/api/tools/local-activity-guide?id=${encodeURIComponent(id)}`)
      .then((document) => { if (!cancelled) setData(document); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "攻略打不开"); });
    return () => { cancelled = true; };
  }, [id]);

  const sections = useMemo(() => data ? splitGuideSections(data.markdown) : [], [data]);
  const departureSection = sections.find((section) => section.title === "出发导航与取票");
  const readingSections = sections.filter((section) => section !== departureSection);

  function openShareSheet() {
    if (!data || preparingShare) return;
    const nativePrintBridge = (window as Window & {
      webkit?: { messageHandlers?: { secretaryPet?: { postMessage: (payload: unknown) => void } } };
    }).webkit?.messageHandlers?.secretaryPet;
    setPreparingShare(true);
    setShareMessage("正在打开系统打印面板…");
    const previousTitle = document.title;
    const root = document.documentElement;
    const previousTheme = root.getAttribute("data-theme");
    const previousRootColorScheme = root.style.colorScheme;
    const previousRootBackground = root.style.backgroundColor;
    const previousBodyBackground = document.body.style.backgroundColor;
    let restored = false;
    let printStarted = false;
    let printFinished = false;
    let openCheckTimer: number | undefined;

    const cleanup = () => {
      window.removeEventListener("beforeprint", handleBeforePrint);
      window.removeEventListener("afterprint", handleAfterPrint);
      window.removeEventListener("infans:guide-print-started", handleNativePrintStarted);
      window.removeEventListener("infans:guide-print-finished", handleNativePrintFinished);
      if (openCheckTimer !== undefined) window.clearTimeout(openCheckTimer);
    };
    const restorePage = () => {
      if (restored) return;
      restored = true;
      cleanup();
      document.title = previousTitle;
      if (previousTheme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previousTheme);
      root.style.colorScheme = previousRootColorScheme;
      root.style.backgroundColor = previousRootBackground;
      document.body.style.backgroundColor = previousBodyBackground;
      setPreparingShare(false);
    };
    function handleBeforePrint() {
      printStarted = true;
      setShareMessage("系统打印面板已打开，可选择存储为 PDF 后继续转发。");
    }
    function handleAfterPrint() {
      printFinished = true;
      setShareMessage("系统打印面板已关闭；需要时可以再次导出。");
      restorePage();
    }
    function handleNativePrintStarted() {
      handleBeforePrint();
    }
    function handleNativePrintFinished() {
      handleAfterPrint();
    }

    window.addEventListener("beforeprint", handleBeforePrint);
    window.addEventListener("afterprint", handleAfterPrint);
    window.addEventListener("infans:guide-print-started", handleNativePrintStarted);
    window.addEventListener("infans:guide-print-finished", handleNativePrintFinished);
    try {
      root.setAttribute("data-theme", "day");
      root.style.colorScheme = "light";
      root.style.backgroundColor = "#fff";
      document.body.style.backgroundColor = "#fff";
      document.title = shareDocumentTitle(data);
      if (nativePrintBridge) {
        nativePrintBridge.postMessage({ type: "print-guide", jobTitle: shareDocumentTitle(data) });
        openCheckTimer = window.setTimeout(() => {
          if (printStarted) return;
          setShareMessage("系统打印面板未能打开，请重新启动小秘书后再试。");
          restorePage();
        }, 1800);
        return;
      }
      window.print();
      if (!printStarted) {
        openCheckTimer = window.setTimeout(() => {
          if (printStarted) return;
          setShareMessage("系统打印面板未能打开，请检查浏览器是否允许打印弹窗后重试。");
          restorePage();
        }, 800);
      } else if (printFinished) {
        restorePage();
      }
    } catch {
      setShareMessage("系统打印面板未能打开，请检查浏览器是否允许打印弹窗后重试。");
      restorePage();
    }
  }

  return (
    <div className="local-guide-reader">
      <div className="local-guide-reader-toolbar">
        <button type="button" className="activity-guide-back" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          {backLabel}
        </button>
        {data && canSharePdf ? (
          <div className="local-guide-share-action">
            <span>完整攻略会整理成无侧栏的分页版</span>
            <button type="button" onClick={openShareSheet} disabled={preparingShare}>
              <Share2 size={16} aria-hidden="true" />
              {preparingShare ? "准备分享版…" : "分享攻略"}
            </button>
          </div>
        ) : data ? (
          <span className="local-guide-share-availability">PDF 分享请在 Mac 上使用</span>
        ) : null}
      </div>
      {shareMessage ? <p className="local-guide-share-status" role="status" aria-live="polite">{shareMessage}</p> : null}

      {error ? (
        <div className="vpn-warning" role="alert">
          <BookOpenText size={16} />
          <div><strong>这份攻略暂时打不开</strong><span>{error}</span></div>
        </div>
      ) : null}
      {!data && !error ? <Empty>正在小秘书里打开完整攻略。</Empty> : null}

      {data ? (
        <>
          {departureSection ? (
            <Card className="local-guide-departure">
              <h2>{departureSection.title}</h2>
              <div className="local-guide-reader-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={markdownComponents}>
                  {departureSection.markdown}
                </ReactMarkdown>
              </div>
            </Card>
          ) : null}
          <Card className="local-guide-reader-hero">
            <GuideOfficialImage {...data} guideId={data.id} className="is-guide-hero" priority sourceLink />
            <div>
              <Kicker>{data.status.startsWith("已参加") ? "活动纪念 · 小秘书内阅读" : "攻略集 · 小秘书内阅读"}</Kicker>
              <h2>{data.name}</h2>
              <p>{data.description || "出发前需要确认的事实、路线与现场行动。"}</p>
            </div>
            <div className="local-guide-reader-facts">
              <span><CalendarDays size={16} /><strong>{data.dateLabel}</strong></span>
              <span><CircleDotDashed size={16} /><strong>{data.status}</strong></span>
              <small>攻略内容已与本地知识库同步 · {data.updatedAt || "更新日期待补"}</small>
            </div>
          </Card>

          <div className="local-guide-reader-grid">
            {readingSections.map((section, index) => (
              <Card className={`local-guide-reader-section${WIDE_SECTIONS.has(section.title) ? " is-wide" : ""}`} key={section.title}>
                <header>
                  <Kicker>{String(index + 1).padStart(2, "0")} · {data.status.startsWith("已参加") ? (data.name.includes("观影") ? "观影纪念" : "活动纪念") : "出门攻略"}</Kicker>
                  <h2>{section.title}</h2>
                </header>
                <div className="local-guide-reader-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={markdownComponents}>
                    {section.markdown}
                  </ReactMarkdown>
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
