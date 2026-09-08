import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { normalizeJapaneseStudyMarkdown, remarkVaultWikiLinks, vaultMarkdownUrlTransform } from "../../markdown-display.mjs";

const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: defaultSchema.protocols?.href ?? ["http", "https", "mailto"],
  },
};

const markdownComponents = {
  a: ({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) => (
    <a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel={href?.startsWith("http") ? "noopener noreferrer" : undefined} {...rest}>{children}</a>
  ),
};

export function JapaneseCollectionDocumentBody({ markdown, sourcePath }: { markdown: string; sourcePath: string }) {
  return <div className="collection-document-markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkVaultWikiLinks, { sourcePath }]]}
      rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
      components={markdownComponents}
      urlTransform={vaultMarkdownUrlTransform}
    >
      {normalizeJapaneseStudyMarkdown(markdown)}
    </ReactMarkdown>
  </div>;
}
