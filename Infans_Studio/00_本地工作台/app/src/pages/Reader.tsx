import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { ArrowLeft, ArrowRight, LoaderCircle, X } from "lucide-react";
import type { WritingDocument } from "../types";
import { Kicker, jsonFetch } from "../page-shared";
import { remarkVaultWikiLinks, stripDisplayFrontmatter, vaultMarkdownUrlTransform } from "../markdown-display.mjs";
import { TopicCourseShelf, type CourseShelfItem } from "./topics/CourseShelf";

const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? ["http", "https", "mailto"]), "infans-doc"],
  },
};

export default function Reader({
  id,
  onClose,
  onMove,
  backLabel = "返回艺术馆藏",
  relatedCourses = [],
}: {
  id: string;
  onClose: () => void;
  onMove: (id: string) => void;
  backLabel?: string;
  relatedCourses?: CourseShelfItem[];
}) {
  const [doc, setDoc] = useState<WritingDocument | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError("");
    jsonFetch<WritingDocument>(`/api/content/${id}`)
      .then((next) => { if (!cancelled) setDoc(next); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "这篇打不开"); });
    return () => { cancelled = true; };
  }, [id]);

  const markdownComponents = {
    a: ({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) => {
      if (href?.startsWith("infans-doc:")) {
        const targetId = href.slice("infans-doc:".length);
        return (
          <button type="button" className="reader-doc-link" onClick={() => onMove(targetId)}>
            {children}
          </button>
        );
      }
      return <a href={href} {...rest}>{children}</a>;
    },
  };

  return (
    <div className="reader" role="dialog" aria-modal="true" aria-label={doc?.title || "阅读"}>
      <header>
        <button type="button" onClick={onClose}><ArrowLeft size={16} />{backLabel}</button>
        <div><span>{doc?.category}</span><strong>{doc?.readTime ?? "—"} 分钟</strong></div>
        <button className="reader-close-action" type="button" onClick={onClose}><X size={18} />关闭阅读</button>
      </header>
      {doc ? (
        <div className="reader-layout">
          <aside>
            <Kicker>{doc.kind === "topic" ? "专题" : "文稿"}</Kicker>
            <h2>{doc.title}</h2>
            <p>{doc.description}</p>
            <div className="reader-meta"><span>{doc.date}</span>{doc.tags.map((x) => <i key={x}>{x}</i>)}</div>
            {relatedCourses.length ? <TopicCourseShelf courses={relatedCourses}/> : null}
            {doc.siblings?.length ? (
              <nav className="reader-siblings" aria-label="本课复习卡">
                {doc.siblings.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.id === doc.id ? "active" : ""}
                    onClick={() => onMove(item.id)}
                  >
                    {item.title}
                  </button>
                ))}
              </nav>
            ) : (
              <nav>{doc.headings.slice(0, 12).map((h) => <span className={`level-${h.level}`} key={h.id}>{h.text}</span>)}</nav>
            )}
          </aside>
          <article>
            <ReactMarkdown remarkPlugins={[remarkGfm, [remarkVaultWikiLinks, { sourcePath: doc.sourcePath }]]} rehypePlugins={[[rehypeSanitize, sanitizeSchema]]} components={markdownComponents} urlTransform={vaultMarkdownUrlTransform}>
              {stripDisplayFrontmatter(doc.markdown)}
            </ReactMarkdown>
            <footer>
              <button type="button" disabled={!doc.previousId} onClick={() => doc.previousId && onMove(doc.previousId)}><ArrowLeft size={14} />上一篇</button>
              <button type="button" disabled={!doc.nextId} onClick={() => doc.nextId && onMove(doc.nextId)}>下一篇<ArrowRight size={14} /></button>
            </footer>
          </article>
        </div>
      ) : error ? (
        <div className="reader-error">
          <strong>这篇打不开</strong>
          <p>{error}</p>
          <button type="button" className="ghost-button" onClick={onClose}>关掉</button>
        </div>
      ) : (
        <div className="reader-inline-loading"><LoaderCircle className="spin" />正在打开…</div>
      )}
    </div>
  );
}
