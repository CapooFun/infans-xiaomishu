import { useId, useState, type KeyboardEvent } from "react";
import {
  COMPUTER_SHORTCUT_COMMANDS,
  DEFAULT_COMPUTER_SHORTCUT_BINDINGS,
  normalizeComputerShortcutBindings,
  presentComputerShortcuts,
  validateComputerShortcutBindings,
} from "../../computer-shortcuts.mjs";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_COMMANDS,
  formatShortcutBinding,
  normalizeShortcutBindings,
  shortcutBindingAriaLabel,
  shortcutBindingFromKeyboardEvent,
  shortcutBindingSignature,
  validateShortcutBindings,
  type ShortcutBinding,
  type ShortcutBindings,
  type WorkbenchShortcutCommand,
} from "../../workbench-shortcuts";
import "./shortcut-settings.css";

type ComputerShortcutBindings = ReturnType<typeof presentComputerShortcuts>["bindings"];
type ComputerShortcutCommandId = (typeof COMPUTER_SHORTCUT_COMMANDS)[number]["id"];
type RecordingId = WorkbenchShortcutCommand | ComputerShortcutCommandId | null;

type ShortcutSettingsProps = {
  value: ShortcutBindings;
  onChange: (bindings: ShortcutBindings) => void;
  computerValue: ComputerShortcutBindings;
  onComputerChange: (bindings: ComputerShortcutBindings) => void;
  computerLoaded?: boolean;
  disabled?: boolean;
};

const WINDOW_GROUPS = ["书签", "浏览"] as const;
const COMPUTER_GROUPS = ["电脑", "截屏", "对话"] as const;

export function ShortcutSettings({
  value,
  onChange,
  computerValue,
  onComputerChange,
  computerLoaded = true,
  disabled = false,
}: ShortcutSettingsProps) {
  const headingId = useId();
  const helpId = useId();
  const [recording, setRecording] = useState<RecordingId>(null);
  const [feedback, setFeedback] = useState<{ command: RecordingId; text: string; error: boolean }>({ command: null, text: "", error: false });
  const bindings = normalizeShortcutBindings(value);
  const computerBindings = normalizeComputerShortcutBindings(computerValue);
  const computerPresented = presentComputerShortcuts(computerBindings).commands;
  const windowIsDefault = SHORTCUT_COMMANDS.every(({ id }) => shortcutBindingSignature(bindings[id]) === shortcutBindingSignature(DEFAULT_SHORTCUT_BINDINGS[id]));
  const computerIsDefault = COMPUTER_SHORTCUT_COMMANDS.every(({ id }) => shortcutBindingSignature(computerBindings[id]) === shortcutBindingSignature(DEFAULT_COMPUTER_SHORTCUT_BINDINGS[id]));

  const changeWindowBinding = (command: WorkbenchShortcutCommand, binding: ShortcutBinding | null) => {
    if (disabled) return;
    const next = { ...bindings, [command]: binding };
    const issue = validateShortcutBindings(next)[0];
    if (issue) {
      setFeedback({ command, text: issue.message, error: true });
      return;
    }
    onChange(next);
    setRecording(null);
    setFeedback({ command, text: binding ? "已修改，保存后生效。" : "已设为停用，保存后生效。", error: false });
  };

  const changeComputerBinding = (command: ComputerShortcutCommandId, binding: ShortcutBinding | null) => {
    if (disabled || !computerLoaded) return;
    const next = { ...computerBindings, [command]: binding };
    const issue = validateComputerShortcutBindings(next)[0];
    if (issue) {
      setFeedback({ command, text: issue.message, error: true });
      return;
    }
    onComputerChange(next as ComputerShortcutBindings);
    setRecording(null);
    setFeedback({ command, text: binding ? "已修改，保存后在这台 Mac 生效。" : "已设为停用，保存后生效。", error: false });
  };

  const capture = (event: KeyboardEvent<HTMLButtonElement>, command: RecordingId, kind: "window" | "computer") => {
    if (disabled || recording !== command || !command) return;
    event.stopPropagation();
    if (event.key === "Tab") {
      setRecording(null);
      return;
    }
    event.preventDefault();
    if (event.key === "Escape") {
      setRecording(null);
      setFeedback({ command, text: "已取消录入。", error: false });
      return;
    }
    const nativeEvent = event.nativeEvent;
    if (nativeEvent.isComposing || nativeEvent.keyCode === 229 || event.repeat || /^(Meta|Control|Alt|Shift)$/.test(event.key)) return;
    const binding = shortcutBindingFromKeyboardEvent(nativeEvent);
    if (!binding) {
      setFeedback({ command, text: "请按 Command 或 Control 加另一个按键；Esc 取消。", error: true });
      return;
    }
    if (kind === "window") changeWindowBinding(command as WorkbenchShortcutCommand, binding);
    else changeComputerBinding(command as ComputerShortcutCommandId, binding);
  };

  const renderRow = ({
    id,
    label,
    note,
    binding,
    defaultBinding,
    kind,
    rowDisabled,
  }: {
    id: WorkbenchShortcutCommand | ComputerShortcutCommandId;
    label: string;
    note?: string;
    binding: ShortcutBinding | null;
    defaultBinding: ShortcutBinding | null;
    kind: "window" | "computer";
    rowDisabled: boolean;
  }) => {
    const fixedChord = id === "agent-screenshot-chat";
    const active = !rowDisabled && !fixedChord && recording === id;
    const sameAsDefault = shortcutBindingSignature(binding) === shortcutBindingSignature(defaultBinding);
    const messageId = `${headingId}-${id}-feedback`;
    const hasMessage = feedback.command === id && Boolean(feedback.text);
    return (
      <div className="shortcut-settings-row" key={id}>
        <span className="shortcut-settings-label">
          {label}
          {note ? <small>{note}</small> : null}
        </span>
        <div className="shortcut-settings-actions">
          <button
            type="button"
            className={`shortcut-settings-binding${active ? " is-recording" : ""}`}
            disabled={rowDisabled}
            aria-label={fixedChord ? `${label}：${shortcutBindingAriaLabel(binding)}，这项固定为 Shift 加左右 Command` : `${label}：${active ? "正在录入" : shortcutBindingAriaLabel(binding)}，点击修改`}
            aria-pressed={active}
            aria-describedby={hasMessage ? `${helpId} ${messageId}` : helpId}
            onClick={() => {
              if (fixedChord) {
                setRecording(null);
                setFeedback({ command: id, text: "这项固定为 Shift 加左右 Command。任意软件前台都会把鼠标所在那块屏交给 Cursor 当前对话。不加 Shift 的左右 Command 留给 Codex。", error: false });
                return;
              }
              setRecording(active ? null : id);
              setFeedback({ command: id, text: "", error: false });
            }}
            onKeyDown={(event) => {
              if (fixedChord) return;
              capture(event, id, kind);
            }}
            onBlur={() => setRecording((current) => current === id ? null : current)}
          >
            {active ? "请按组合键…" : <kbd>{formatShortcutBinding(binding)}</kbd>}
          </button>
          <button
            type="button"
            disabled={rowDisabled || binding === null}
            aria-label={`停用${label}快捷键`}
            onClick={() => kind === "window" ? changeWindowBinding(id as WorkbenchShortcutCommand, null) : changeComputerBinding(id as ComputerShortcutCommandId, null)}
          >停用</button>
          <button
            type="button"
            disabled={rowDisabled || sameAsDefault}
            aria-label={`恢复${label}默认快捷键`}
            onClick={() => kind === "window" ? changeWindowBinding(id as WorkbenchShortcutCommand, defaultBinding) : changeComputerBinding(id as ComputerShortcutCommandId, defaultBinding)}
          >默认</button>
        </div>
        {hasMessage ? <p id={messageId} className={`shortcut-settings-feedback${feedback.error ? " is-error" : ""}`} role="status">{feedback.text}</p> : null}
      </div>
    );
  };

  return <section className="shortcut-settings" aria-labelledby={headingId} data-workbench-shortcuts="off">
    <header className="shortcut-settings-heading">
      <div><h3 id={headingId}>快捷键</h3><p id={helpId}>点击组合键后按下新按键。支持 Command／Control，Esc 取消录入。</p></div>
      <button type="button" disabled={disabled || (windowIsDefault && computerIsDefault)} onClick={() => {
        onChange(normalizeShortcutBindings());
        onComputerChange(normalizeComputerShortcutBindings({}) as ComputerShortcutBindings);
        setRecording(null);
        setFeedback({ command: null, text: "已选用全部默认快捷键，保存后生效。", error: false });
      }}>恢复全部默认</button>
    </header>

    {COMPUTER_GROUPS.map((group) => (
      <div className="shortcut-settings-group" key={group}>
        <h4>{group === "电脑" ? "这台电脑 · 关灯" : group === "截屏" ? "这台电脑 · 截屏" : "这台电脑 · 对话"}</h4>
        <p>{group === "电脑" ? "副屏切掉，Mac 只留一点光。再按一次恢复。系统强制退出是 Option+Command+Esc。" : group === "截屏" ? "全屏和框选对整台 Mac 生效。截进 Cursor 当前对话随时可用：截鼠标所在那块屏，贴进当前对话。Codex 自己用左右 Command。" : "只在 Codex 或 Cursor 位于前台时拦截。"}</p>
        <div className="shortcut-settings-list">
          {computerPresented.filter((command) => command.group === group).map((command) => {
            const id = command.id as ComputerShortcutCommandId;
            return renderRow({
              id,
              label: command.label,
              note: [command.scope, command.note].filter(Boolean).join(" "),
              binding: computerBindings[id],
              defaultBinding: DEFAULT_COMPUTER_SHORTCUT_BINDINGS[id],
              kind: "computer",
              rowDisabled: disabled || !computerLoaded,
            });
          })}
        </div>
      </div>
    ))}

    {WINDOW_GROUPS.map((group) => (
      <div className="shortcut-settings-group" key={group}>
        <h4>{group === "书签" ? "小秘书窗口 · 书签" : "小秘书窗口 · 浏览"}</h4>
        <p>{group === "书签" ? "在小秘书窗口内生效，按侧栏顺序排列。输入文字或操作弹窗时暂停。" : "在小秘书窗口内生效。"}</p>
        <div className="shortcut-settings-list">
          {SHORTCUT_COMMANDS.filter((command) => command.group === group).map(({ id, label }) => renderRow({
            id,
            label,
            binding: bindings[id],
            defaultBinding: DEFAULT_SHORTCUT_BINDINGS[id],
            kind: "window",
            rowDisabled: disabled,
          }))}
        </div>
      </div>
    ))}

    {feedback.command === null && feedback.text ? <p className="shortcut-settings-feedback" role="status">{feedback.text}</p> : null}
    <p className="shortcut-settings-note">⌘ Command · ⌃ Control · ⌥ Option · ⇧ Shift。⇧⌘⌘ 表示 Shift 加左右 Command，随时把焦点所在屏幕交给 Cursor。不加 Shift 的 ⌘⌘ 留给 Codex。窗口内已知系统或浏览器占用的组合会提示更换。桌面 App 菜单仍显示原生默认键位，停用窗口内某项会同时停用其菜单命令。本机截屏保存后立即写进这台 Mac。</p>
  </section>;
}
