export function stripDisplayFrontmatter(markdown?: string): string;

export function normalizeJapaneseStudyMarkdown(markdown?: string): string;

export function vaultMarkdownUrlTransform(url?: string): string;

export function remarkVaultWikiLinks(options?: { sourcePath?: string }): (tree: unknown) => void;
