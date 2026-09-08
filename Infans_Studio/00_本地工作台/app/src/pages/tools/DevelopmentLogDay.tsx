import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { PageTrail } from "../../shell/PageNavigation";
import type { DevelopmentLogDay } from "../../types";
import { Kicker } from "../../page-shared";
import { remarkVaultWikiLinks, stripDisplayFrontmatter, vaultMarkdownUrlTransform } from "../../markdown-display.mjs";

const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: defaultSchema.protocols?.href ?? ["http", "https", "mailto"],
  },
};

const markdownComponents = {
  a: ({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) => <a href={href} {...rest}>{children}</a>,
};

export default function DevelopmentLogDayView({
  day,
  onBack,
}: {
  day: DevelopmentLogDay;
  onBack: () => void;
}) {
  return (
    <div className="development-log-day-view">
      <PageTrail items={[
        { label: "协作记录", href: "/tools/collaboration-records" },
        { label: "工作日志", href: "/tools/collaboration-records?view=work", onSelect: onBack },
        { label: day.date },
      ]} />
      <header className="development-log-reader-head collaboration-reader-head">
        <div>
          <Kicker>完整日志</Kicker>
          <h2>{day.date}</h2>
          <p>{day.description || "日志目录中的当日原文"}</p>
        </div>
      </header>
      <article className="development-log-full development-log-document">
        <div className="development-log-markdown">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, [remarkVaultWikiLinks, { sourcePath: day.sourcePath }]]}
            rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
            components={markdownComponents}
            urlTransform={vaultMarkdownUrlTransform}
          >
            {stripDisplayFrontmatter(day.markdown)}
          </ReactMarkdown>
        </div>
      </article>
    </div>
  );
}
