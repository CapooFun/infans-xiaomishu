import { useEffect, useState } from "react";
import { Copy, Sparkles } from "lucide-react";
import { buildAskSelectionSeedUser } from "./ask-selection";

const TEXT_LIMIT = 1200;

function selectionInEditable(node: Node | null) {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement) {
      const tag = current.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || current.isContentEditable) return true;
      if (current.closest?.(".ai-panel, .selection-ask-menu, .selection-ask-fab")) return true;
    }
    current = current.parentNode;
  }
  return false;
}

function readSelectionText() {
  const sel = window.getSelection();
  const raw = sel?.toString().trim() || "";
  if (!raw || raw.length < 2 || !sel || sel.rangeCount < 1) return "";
  if (selectionInEditable(sel.getRangeAt(0).commonAncestorContainer)) return "";
  return raw.slice(0, TEXT_LIMIT);
}

/** 工作台页内划字后，右键可以问问小秘书。 */
export function SelectionAskMenu({
  route,
  onAsk,
}: {
  route: string;
  onAsk: (seedUser: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const close = () => setMenu(null);
    const onContextMenu = (event: MouseEvent) => {
      const text = readSelectionText();
      if (!text) {
        setMenu(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const x = Math.min(window.innerWidth - 180, Math.max(8, event.clientX));
      const y = Math.min(window.innerHeight - 96, Math.max(8, event.clientY));
      setMenu({ x, y, text });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!menu) return null;

  return (
    <>
      <div className="selection-ask-menu-backdrop" onMouseDown={() => setMenu(null)} />
      <div className="selection-ask-menu" style={{ top: menu.y, left: menu.x }} role="menu">
        <button
          type="button"
          role="menuitem"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const seedUser = buildAskSelectionSeedUser({
              selectedText: menu.text,
              pageUrl: window.location.href,
              pageTitle: document.title,
              route,
            });
            setMenu(null);
            if (seedUser) onAsk(seedUser);
          }}
        >
          <Sparkles size={14} aria-hidden="true" />
          问问小秘书
        </button>
        <button
          type="button"
          role="menuitem"
          onMouseDown={(event) => event.preventDefault()}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(menu.text);
            } catch {
              /* ignore */
            }
            setMenu(null);
          }}
        >
          <Copy size={14} aria-hidden="true" />
          复制
        </button>
      </div>
    </>
  );
}
