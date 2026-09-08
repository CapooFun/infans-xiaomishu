import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { buildAskSelectionSeedUser } from "./ask-selection";

const TEXT_LIMIT = 1200;

function prefersTouchUi() {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  } catch {
    return navigator.maxTouchPoints > 0;
  }
}

function selectionInEditable(node: Node | null) {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement) {
      const tag = current.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || current.isContentEditable) return true;
      if (current.closest?.(".ai-panel")) return true;
    }
    current = current.parentNode;
  }
  return false;
}

export function SelectionAskFab({
  route,
  onAsk,
}: {
  route: string;
  onAsk: (seedUser: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState("");
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!prefersTouchUi()) return;

    const sync = () => {
      const sel = window.getSelection();
      const raw = sel?.toString().trim() || "";
      if (!raw || raw.length < 2 || !sel || sel.rangeCount < 1) {
        setVisible(false);
        setText("");
        return;
      }
      const range = sel.getRangeAt(0);
      if (selectionInEditable(range.commonAncestorContainer)) {
        setVisible(false);
        setText("");
        return;
      }
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        setVisible(false);
        return;
      }
      const clipped = raw.slice(0, TEXT_LIMIT);
      setText(clipped);
      setPos({
        top: Math.max(12, rect.top - 44),
        left: Math.min(window.innerWidth - 120, Math.max(12, rect.left + rect.width / 2 - 54)),
      });
      setVisible(true);
    };

    document.addEventListener("selectionchange", sync);
    document.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      document.removeEventListener("selectionchange", sync);
      document.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, []);

  if (!visible || !text) return null;

  return (
    <button
      type="button"
      className="selection-ask-fab"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        const seedUser = buildAskSelectionSeedUser({
          selectedText: text,
          pageUrl: window.location.href,
          pageTitle: document.title,
          route,
        });
        if (!seedUser) return;
        setVisible(false);
        onAsk(seedUser);
      }}
    >
      <Sparkles size={14} aria-hidden="true" />
      问问小秘书
    </button>
  );
}
