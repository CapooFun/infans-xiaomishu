import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowUp,
  Camera,
  Check,
  ChevronRight,
  Columns3,
  Download,
  FileText,
  Image as ImageIcon,
  Keyboard,
  Mic,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Smile,
  SlidersHorizontal,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import {
  DEFAULT_NATIVE_DESIGN_STATE,
  IPAD_SCENES,
  NATIVE_BASELINE_TOKENS,
  NATIVE_DESIGN_DEVICES,
  PHONE_SCENES,
  createNativeDesignExport,
  normalizeNativeDesignState,
  type NativeDesignDeviceId,
  type NativeDesignIpadScene,
  type NativeDesignLabState,
  type NativeDesignPhoneScene,
  type NativeDesignScene,
  type NativeDesignTokens,
} from "./native-ui-design-model";
import "./native-ui-design.css";

const STORAGE_KEY = "infans-native-ui-design-lab-v3";
const chatLandscape = "/theme/avatar-yinyue-public.svg";
const chatPortrait = "/theme/avatar-yinyue-public.svg";
const watchPortrait = "/theme/avatar-yinyue-public.svg";

function readStoredState() {
  try {
    return normalizeNativeDesignState(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null"));
  } catch {
    return normalizeNativeDesignState(null);
  }
}

function sceneLabel(scene: NativeDesignScene) {
  return [...PHONE_SCENES, ...IPAD_SCENES].find((item) => item.id === scene)?.label || scene;
}

function downloadJson(state: NativeDesignLabState) {
  const payload = createNativeDesignExport(state);
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `native-ui-design-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function StatusBar({ watch = false }: { watch?: boolean }) {
  return (
    <div className={`nud-statusbar${watch ? " is-watch" : ""}`} aria-hidden="true">
      <span>{watch ? "03:15" : "03:16"}</span>
      {!watch ? <span className="nud-status-icons"><i /><i /><b /></span> : null}
    </div>
  );
}

function IconButton({ children, label }: { children: ReactNode; label: string }) {
  return <button type="button" className="nud-native-icon-button" tabIndex={-1} aria-label={label}>{children}</button>;
}

function SecretaryAvatar({ portrait = false }: { portrait?: boolean }) {
  return portrait
    ? <img className="nud-secretary-portrait" src={watchPortrait} alt="" />
    : <span className="nud-secretary-avatar" aria-hidden="true">银</span>;
}

function ConnectionHeader() {
  return (
    <header className="nud-native-header">
      <IconButton label="会话列表"><PanelLeft /></IconButton>
      <SecretaryAvatar />
      <span className="nud-native-title">
        <strong>银月</strong>
        <small>需要重新配对</small>
      </span>
      <span className="nud-native-connection"><i /><small>需要重新配对</small></span>
      <IconButton label="刷新"><RefreshCw /></IconButton>
      <IconButton label="设置"><SlidersHorizontal /></IconButton>
    </header>
  );
}

function CandidatePhoneHeader({ onOpenConversations }: { onOpenConversations?: () => void }) {
  return (
    <header className="nud-candidate-phone-header">
      <button type="button" className="nud-native-icon-button" aria-label="会话列表" onClick={onOpenConversations}><PanelLeft /></button>
      <strong>银月</strong>
      <span aria-hidden="true" />
    </header>
  );
}

function CandidateOpeningMessage() {
  return (
    <div className="nud-native-messages is-opening">
      <div className="nud-native-message is-assistant">
        <SecretaryAvatar />
        <div><span>银月 <Volume2 /></span><p>你好，银月在呢～</p></div>
      </div>
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="nud-native-empty">
      <SecretaryAvatar />
      <h2>你好，银月在呢～</h2>
      <p>随时找我说话都在。就算这会儿连不上 Mac，消息也会乖乖留着，上线立刻告诉你～</p>
    </div>
  );
}

function ChatMessages() {
  return (
    <div className="nud-native-messages">
      <div className="nud-native-message is-assistant">
        <SecretaryAvatar />
        <div><span>银月 <Volume2 /></span><p>你好，银月在呢～</p></div>
      </div>
      <div className="nud-native-message is-user">
        <p>帮我看看这张图。</p>
        <small><Check /> 已送达</small>
      </div>
    </div>
  );
}

function Composer() {
  return (
    <div className="nud-native-composer">
      <div className="nud-native-attachments">
        <IconButton label="相机"><Camera /></IconButton>
        <IconButton label="照片"><ImageIcon /></IconButton>
        <IconButton label="文件"><FileText /></IconButton>
        <span>0/4</span>
      </div>
      <div className="nud-native-compose-row">
        <div>和银月说说话…</div>
        <IconButton label="语音"><Mic /></IconButton>
        <button type="button" className="nud-native-send" tabIndex={-1} aria-label="发送"><ArrowUp /></button>
      </div>
    </div>
  );
}

function CandidateComposer() {
  const [showActions, setShowActions] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  return (
    <div className={`nud-candidate-composer${showActions ? " is-open" : ""}${voiceMode ? " is-voice" : ""}`}>
      <div className="nud-candidate-compose-row">
        <button type="button" className="nud-native-icon-button" aria-label={voiceMode ? "切换文字输入" : "切换语音输入"} onClick={() => setVoiceMode(!voiceMode)}>{voiceMode ? <Keyboard /> : <Mic />}</button>
        {voiceMode ? <button type="button" className="nud-candidate-hold-to-talk">按住 说话</button> : <div className="nud-candidate-input">和银月说说话…</div>}
        <IconButton label="表情"><Smile /></IconButton>
        <button type="button" className="nud-candidate-more" aria-label={showActions ? "收起更多操作" : "更多操作"} onClick={() => setShowActions((current) => !current)}><Plus /></button>
      </div>
      {showActions ? (
        <div className="nud-candidate-action-tray" aria-label="发送更多内容">
          <button type="button" tabIndex={-1}><span><ImageIcon /></span><small>照片</small></button>
          <button type="button" tabIndex={-1}><span><Camera /></span><small>拍摄</small></button>
          <button type="button" tabIndex={-1}><span><FileText /></span><small>文件</small></button>
        </div>
      ) : null}
      <div className="nud-candidate-home-indicator" aria-hidden="true" />
    </div>
  );
}

function ConversationSurface({ populated = false }: { populated?: boolean }) {
  return (
    <div className="nud-native-sheet nud-conversation-sheet">
      <header>
        <IconButton label="关闭"><X /></IconButton>
        <span><strong>会话</strong><small>{populated ? "3 个 Mac 会话" : "0 个 Mac 会话"}</small></span>
        <IconButton label="新建会话"><Pencil /></IconButton>
      </header>
      <label className="nud-native-search"><Search /><span>搜标题、消息或成员…</span></label>
      {populated ? (
        <div className="nud-native-thread-list">
          {[
            ["当前会话", "先按真实页面完成复刻。", "12 条", "1 位角色"],
            ["跨端原生验收", "等待三端下一轮验收。", "38 条", "1 位角色"],
            ["语音转写", "原声最长 60 秒。", "21 条", "1 位角色"],
          ].map(([title, message, count, members], index) => (
            <article className={index === 0 ? "is-current" : ""} key={title}>
              <SecretaryAvatar />
              <span><strong>{title}</strong><small>{message}</small><em>{count}　{members}</em></span>
            </article>
          ))}
        </div>
      ) : (
        <div className="nud-native-list-empty"><strong>没有可显示的会话</strong><p>Mac 返回会话后会出现在这里。</p></div>
      )}
      <footer><button type="button"><Pencil />重命名</button><button type="button"><Trash2 />删除</button></footer>
    </div>
  );
}

function CandidateConversationSidebar({ onClose }: { onClose?: () => void }) {
  return (
    <div className="nud-candidate-sidebar-layer">
      <aside className="nud-candidate-sidebar" aria-label="会话与设置侧边栏">
        <header>
          <span><strong>会话</strong><small>3 个会话</small></span>
          <span className="nud-candidate-sidebar-actions">
            <IconButton label="直接新建会话"><Plus /></IconButton>
            {onClose ? <button type="button" className="nud-native-icon-button" aria-label="关闭会话列表" onClick={onClose}><X /></button> : null}
          </span>
        </header>
        <label className="nud-native-search"><Search /><span>搜索会话</span></label>
        <div className="nud-native-thread-list">
          {[
            ["原生界面第二次迭代", "刚刚"],
            ["9月2日 · 和银月聊聊", "昨天"],
            ["语音转写", "9月1日"],
          ].map(([title, message], index) => (
            <article className={index === 0 ? "is-current" : ""} key={title}>
              <span><strong>{title}</strong><small>{message}</small></span>
              <ChevronRight aria-hidden="true" />
            </article>
          ))}
        </div>
        <div className="nud-candidate-sidebar-bottom">
          <button type="button" tabIndex={-1}>
            <SlidersHorizontal />
            <span><strong>设置与连接</strong><small><i />需要重新配对</small></span>
            <ChevronRight />
          </button>
        </div>
      </aside>
    </div>
  );
}

const SETTINGS_SECTIONS = [
  {
    title: "连接 Mac 小秘书",
    rows: [["Mac HTTPS 地址", ""], ["小秘书指令令牌", ""], ["保存小秘书指令令牌", ""]],
    note: "聊天与系统分享复用这条私有 HTTPS 连接和独立设备令牌；它们不使用 Apple 健康同步令牌。",
  },
  {
    title: "聊天声音与通知",
    rows: [["银月回复完后自动朗读", "关闭"], ["朗读速度", "正常"], ["后台收到完整回复时提醒我", "关闭"], ["系统权限", "尚未决定"]],
    note: "使用 iPhone 系统中文声音，不会猜测角色专属音色。",
  },
  {
    title: "系统分享收件箱",
    rows: [["待重试", "0"], ["重试待送达分享", ""]],
    note: "Safari、抖音、B站、小红书等 App 只要愿意交给系统分享 URL 或文字，就能从分享面板选择“发给秘书”。",
  },
  {
    title: "健康自动同步",
    rows: [["计划", "每天 12:00 后尽快"], ["范围", "近 35 天·非医疗数据"], ["立即同步", ""]],
    note: "",
  },
  {
    title: "统一提醒权限",
    rows: [["Apple 提醒事项", "未授权"], ["Apple 日历", "未授权"], ["强提醒与计时器", "未授权"]],
    note: "",
  },
  {
    title: "Apple 健康授权",
    rows: [["授权读取 Apple 健康", ""]],
    note: "只读取步数、活动能量、锻炼与站立时间、静息心率、睡眠、身体测量和运动。",
  },
  {
    title: "健康同步私有入口",
    rows: [["HTTPS 地址", ""], ["健康同步配对令牌", ""], ["保存配对令牌", ""]],
    note: "传输只走 Tailscale HTTPS；这枚令牌只用于 Apple 健康同步。",
  },
] as const;

function SettingsSurface() {
  return (
    <div className="nud-native-sheet nud-settings-sheet">
      <header><span /><strong>设置与连接</strong><button type="button">完成</button></header>
      <div className="nud-native-form">
        {SETTINGS_SECTIONS.map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            <div>
              {section.rows.map(([label, value]) => <p key={label}><span>{label}</span>{value ? <small>{value}</small> : null}</p>)}
            </div>
            {section.note ? <small>{section.note}</small> : null}
          </section>
        ))}
      </div>
    </div>
  );
}

function ChatSurface({ landscape = false, showMessages = false, candidate = false }: { landscape?: boolean; showMessages?: boolean; candidate?: boolean }) {
  const art = landscape ? chatLandscape : chatPortrait;
  return (
    <div className={`nud-native-chat${landscape ? " is-landscape" : ""}${candidate ? " is-candidate-phone" : ""}`} style={{ "--nud-chat-art": `url("${art}")` } as CSSProperties}>
      {candidate ? <CandidatePhoneHeader /> : <ConnectionHeader />}
      <div className="nud-native-chat-body">
        <div className="nud-native-token-warning">{candidate ? "需要重新配对 · 点此查看" : "请先在设置中保存小秘书指令令牌"}</div>
        {showMessages ? <ChatMessages /> : candidate ? <CandidateOpeningMessage /> : <EmptyConversation />}
      </div>
      {candidate ? <CandidateComposer /> : <Composer />}
    </div>
  );
}

function PhoneScreen({ scene, candidate = false }: { scene: NativeDesignPhoneScene; candidate?: boolean }) {
  return (
    <div className={`nud-phone-screen${candidate ? " is-candidate" : ""}`}>
      <StatusBar />
      <div className="nud-native-app-body">
        <ChatSurface candidate={candidate} />
        {scene === "conversation" ? (candidate ? <CandidateConversationSidebar /> : <ConversationSurface populated />) : null}
        {scene === "settings" ? <SettingsSurface /> : null}
      </div>
    </div>
  );
}

function CandidateIpadPrivateChat({ onOpenConversations }: { onOpenConversations?: () => void }) {
  const [speaking, setSpeaking] = useState(false);
  return (
    <div className={`nud-ipad-private-chat${speaking ? " is-speaking" : ""}`}>
      <CandidatePhoneHeader onOpenConversations={onOpenConversations} />
      <div className="nud-ipad-private-body">
        {speaking ? (
          <>
            <div className="nud-ipad-candidate-speaker" style={{ backgroundImage: `url("${watchPortrait}")` }}>
              <span><strong>银月</strong><small><i />正在说话</small></span>
            </div>
            <button type="button" className="nud-ipad-voice-progress" aria-label="结束朗读并返回文字聊天" onClick={() => setSpeaking(false)}>
              <Volume2 />
              <span><strong>正在朗读</strong><i /></span>
              <small>00:08 / 00:18</small>
            </button>
          </>
        ) : (
          <div className="nud-ipad-private-thread">
            <div className="nud-native-message is-assistant">
              <SecretaryAvatar />
              <div><span>银月 <button type="button" aria-label="播放银月语音" onClick={() => setSpeaking(true)}><Volume2 /></button></span><p>你好，银月在呢～</p></div>
            </div>
          </div>
        )}
      </div>
      <CandidateComposer />
    </div>
  );
}

function CandidateIpadWorkspace({ scene, landscape }: { scene: NativeDesignIpadScene; landscape: boolean }) {
  const art = landscape ? chatLandscape : chatPortrait;
  const [showConversationPanel, setShowConversationPanel] = useState(true);
  useEffect(() => {
    if (scene === "conversation") setShowConversationPanel(true);
  }, [scene]);
  const conversationOpen = scene === "conversation" && showConversationPanel;
  const sidePanelOpen = conversationOpen || scene === "settings";
  return (
    <div className={`nud-ipad-candidate-workspace${landscape ? " is-landscape" : " is-portrait"}${scene === "conversation" || scene === "settings" ? " is-side-panel" : ""}${sidePanelOpen ? " is-side-panel-open" : ""}`} style={{ "--nud-chat-art": `url("${art}")` } as CSSProperties}>
      <section className="nud-ipad-chat-pane" aria-label={sidePanelOpen ? "iPad 右侧聊天浮窗" : "iPad 左侧纯净聊天浮窗"}>
        <CandidateIpadPrivateChat onOpenConversations={() => setShowConversationPanel(true)} />
      </section>
      {scene !== "chat" ? (
        <section className={`nud-ipad-floating-panel${scene === "conversation" && !showConversationPanel ? " is-panel-hidden" : ""}`} aria-label={scene === "conversation" ? "iPad 左侧会话列表浮窗" : "iPad 左侧设置与连接浮窗"}>
          {scene === "conversation" ? <CandidateConversationSidebar onClose={() => setShowConversationPanel(false)} /> : null}
          {scene === "settings" ? <SettingsSurface /> : null}
        </section>
      ) : null}
    </div>
  );
}

function IpadScreen({ scene, landscape, candidate = false }: { scene: NativeDesignIpadScene; landscape: boolean; candidate?: boolean }) {
  return (
    <div className={`nud-ipad-screen${candidate ? " is-candidate" : ""}`}>
      <StatusBar />
      {candidate ? <CandidateIpadWorkspace scene={scene} landscape={landscape} /> : (
        <div className="nud-native-app-body">
          <ChatSurface landscape={landscape} />
          {scene === "conversation" ? <ConversationSurface populated /> : null}
          {scene === "settings" ? <SettingsSurface /> : null}
        </div>
      )}
    </div>
  );
}

function DeviceCanvas({
  id,
  state,
  allowFocus,
  onFocus,
}: {
  id: NativeDesignDeviceId;
  state: NativeDesignLabState;
  allowFocus: boolean;
  onFocus: () => void;
}) {
  const device = NATIVE_DESIGN_DEVICES.find((item) => item.id === id)!;
  const orientation = id === "ipad129" ? state.orientation : "portrait";
  const points = device.points[orientation];
  const scene = state.scenes[id];
  const tokens = state.mode === "baseline" ? NATIVE_BASELINE_TOKENS : state.tokens;
  const variables = {
    "--nud-density": tokens.density,
    "--nud-sidebar-width": `${tokens.sidebarWidth}px`,
    "--nud-topbar-height": `${tokens.topBarHeight}px`,
    "--nud-composer-height": `${tokens.composerHeight}px`,
    "--nud-radius": `${tokens.cornerRadius}px`,
    "--nud-accent": tokens.accent,
    "--nud-canvas": tokens.canvas,
  } as CSSProperties;
  return (
    <article className={`nud-device-card is-${id} is-${orientation}`} style={variables}>
      <header>
        <span><strong>{device.label}</strong><small>{sceneLabel(scene)}</small></span>
        {allowFocus ? <button type="button" onClick={onFocus}>单独看</button> : <b>放大预览</b>}
      </header>
      <div className="nud-measure-top" aria-hidden={!state.showMeasurements}>{state.showMeasurements ? `${points[0]} pt` : ""}</div>
      <div className="nud-device-shell">
        <div className="nud-screen">
          {id === "iphone15" ? <PhoneScreen scene={scene as NativeDesignPhoneScene} candidate={state.mode === "candidate"} /> : null}
          {id === "ipad129" ? <IpadScreen scene={scene as NativeDesignIpadScene} landscape={orientation === "landscape"} candidate={state.mode === "candidate"} /> : null}
          {state.showSafeArea ? <div className="nud-safe-area" aria-label="安全区参考线" /> : null}
        </div>
      </div>
      <div className="nud-measure-side" aria-hidden={!state.showMeasurements}>{state.showMeasurements ? `${points[1]} pt` : ""}</div>
    </article>
  );
}

function RangeControl({
  label,
  value,
  minimum,
  maximum,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  step?: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="nud-range-control">
      <span><b>{label}</b><output>{value}{suffix}</output></span>
      <input type="range" min={minimum} max={maximum} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export default function NativeUiDesignLab() {
  const [state, setState] = useState<NativeDesignLabState>(readStoredState);
  const [feedback, setFeedback] = useState("基准来自当前 SwiftUI 与同型号模拟器");
  const selectedDevices = useMemo(() => NATIVE_DESIGN_DEVICES.filter((device) => state.selectedDevices.includes(device.id)), [state.selectedDevices]);

  const patchState = (patch: Partial<NativeDesignLabState>) => setState((current) => normalizeNativeDesignState({ ...current, ...patch }));
  const patchTokens = (patch: Partial<NativeDesignTokens>) => setState((current) => normalizeNativeDesignState({ ...current, tokens: { ...current.tokens, ...patch } }));
  const patchScene = (device: NativeDesignDeviceId, scene: NativeDesignScene) => setState((current) => normalizeNativeDesignState({ ...current, scenes: { ...current.scenes, [device]: scene } }));
  const toggleDevice = (device: NativeDesignDeviceId) => setState((current) => {
    const selected = current.selectedDevices.includes(device)
      ? current.selectedDevices.filter((item) => item !== device)
      : [...current.selectedDevices, device];
    return normalizeNativeDesignState({ ...current, selectedDevices: selected });
  });
  const showAllDevices = () => patchState({ selectedDevices: NATIVE_DESIGN_DEVICES.map((device) => device.id) });
  const save = () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    setFeedback(`已保存“${state.schemeName || "未命名方案"}”`);
  };
  const reset = () => {
    const next = normalizeNativeDesignState(DEFAULT_NATIVE_DESIGN_STATE);
    setState(next);
    setFeedback("已恢复本轮调整方案");
  };

  return (
    <div className={`native-ui-design-lab is-${state.mode}`}>
      <header className="nud-lab-header">
        <div>
          <span className="nud-eyebrow">IOS NATIVE GEN 1 · DESIGN ITERATION 02</span>
          <h1>原生一代，进入第二次交互迭代。</h1>
          <p>默认展示我们正在讨论的新方案；“当前原生基准”继续保留，用来随时核对真实文案、尺寸和改动差异。</p>
        </div>
        <div className="nud-baseline-mark"><span>当前查看</span><strong>{state.mode === "baseline" ? "现有原生界面" : "交互设计二次迭代"}</strong><small>{state.mode === "baseline" ? "只读对照 · 可切回本轮方案" : "iPhone 15 · iPad 横屏"}</small></div>
      </header>

      <div className="nud-workbench">
        <aside className="nud-control-panel" aria-label="设计参数">
          <section>
            <div className="nud-control-heading"><span>版本</span><small>{state.mode === "baseline" ? "只读基准" : "可调整"}</small></div>
            <div className="nud-mode-switch" aria-label="预览版本">
              <button type="button" aria-pressed={state.mode === "baseline"} className={state.mode === "baseline" ? "is-active" : ""} onClick={() => patchState({ mode: "baseline" })}>当前原生基准</button>
              <button type="button" aria-pressed={state.mode === "candidate"} className={state.mode === "candidate" ? "is-active" : ""} onClick={() => patchState({ mode: "candidate" })}>调整方案</button>
            </div>
            <label className="nud-name-field"><span>名称</span><input value={state.schemeName} maxLength={48} onChange={(event) => patchState({ schemeName: event.target.value })} /></label>
            <div className="nud-action-row">
              <button type="button" onClick={save}><Save />保存</button>
              <button type="button" onClick={() => { downloadJson(state); setFeedback("已导出方案 JSON"); }}><Download />导出</button>
              <button type="button" aria-label="恢复基准" onClick={reset}><RotateCcw /></button>
            </div>
            <p className="nud-feedback" role="status">{feedback}</p>
          </section>

          <section>
            <div className="nud-control-heading"><span>并排设备</span><Columns3 /></div>
            <div className="nud-device-toggles">
              {NATIVE_DESIGN_DEVICES.map((device) => <button type="button" className={state.selectedDevices.includes(device.id) ? "is-active" : ""} aria-pressed={state.selectedDevices.includes(device.id)} key={device.id} onClick={() => toggleDevice(device.id)}><i />{device.label}</button>)}
            </div>
          </section>

          <section>
            <div className="nud-control-heading"><span>当前页面</span><small>现有文案</small></div>
            <label className="nud-select-field"><span>iPhone</span><select value={state.scenes.iphone15} onChange={(event) => patchScene("iphone15", event.target.value as NativeDesignPhoneScene)}>{PHONE_SCENES.map((scene) => <option value={scene.id} key={scene.id}>{scene.label}</option>)}</select></label>
            <label className="nud-select-field"><span>iPad</span><select value={state.scenes.ipad129} onChange={(event) => patchScene("ipad129", event.target.value as NativeDesignIpadScene)}>{IPAD_SCENES.map((scene) => <option value={scene.id} key={scene.id}>{scene.label}</option>)}</select></label>
          </section>

          <section>
            <div className="nud-control-heading"><span>画布</span><RotateCw /></div>
            <div className="nud-segmented" aria-label="iPad 方向">
              <button type="button" className={state.orientation === "portrait" ? "is-active" : ""} onClick={() => patchState({ orientation: "portrait" })}>iPad 竖向</button>
              <button type="button" className={state.orientation === "landscape" ? "is-active" : ""} onClick={() => patchState({ orientation: "landscape" })}>iPad 横向</button>
            </div>
            <label className="nud-check"><input type="checkbox" checked={state.showSafeArea} onChange={(event) => patchState({ showSafeArea: event.target.checked })} /><span>安全区参考线</span></label>
            <label className="nud-check"><input type="checkbox" checked={state.showMeasurements} onChange={(event) => patchState({ showMeasurements: event.target.checked })} /><span>尺寸标记</span></label>
          </section>

          <section>
            <div className="nud-control-heading"><span>调整参数</span><small>{state.mode === "baseline" ? "切换方案后可用" : "即时预览"}</small></div>
            <fieldset disabled={state.mode === "baseline"}>
              <RangeControl label="密度" value={state.tokens.density} minimum={0.82} maximum={1.18} step={0.02} suffix="×" onChange={(density) => patchTokens({ density })} />
              <RangeControl label="iPad 舞台宽" value={state.tokens.sidebarWidth} minimum={280} maximum={440} suffix=" pt" onChange={(sidebarWidth) => patchTokens({ sidebarWidth })} />
              <RangeControl label="顶栏" value={state.tokens.topBarHeight} minimum={48} maximum={82} suffix=" pt" onChange={(topBarHeight) => patchTokens({ topBarHeight })} />
              <RangeControl label="输入区" value={state.tokens.composerHeight} minimum={70} maximum={124} suffix=" pt" onChange={(composerHeight) => patchTokens({ composerHeight })} />
              <RangeControl label="圆角" value={state.tokens.cornerRadius} minimum={10} maximum={30} suffix=" pt" onChange={(cornerRadius) => patchTokens({ cornerRadius })} />
              <div className="nud-color-row"><label><span>强调色</span><input type="color" value={state.tokens.accent} onChange={(event) => patchTokens({ accent: event.target.value })} /></label><label><span>底色</span><input type="color" value={state.tokens.canvas} onChange={(event) => patchTokens({ canvas: event.target.value })} /></label></div>
            </fieldset>
          </section>
        </aside>

        <main className="nud-stage" aria-label="设备界面预览">
          <div className="nud-stage-ruler"><span>{state.mode === "baseline" ? "当前原生基准" : "调整方案"}</span><i /><small>{selectedDevices.length} 台设备 · 4K 同屏优先</small>{selectedDevices.length < NATIVE_DESIGN_DEVICES.length ? <button type="button" onClick={showAllDevices}>三机同屏</button> : null}</div>
          <div className={`nud-device-row${selectedDevices.length === 1 ? " is-single" : ""}`}>
            {selectedDevices.map((device) => <DeviceCanvas id={device.id} state={state} allowFocus={selectedDevices.length > 1} onFocus={() => patchState({ selectedDevices: [device.id] })} key={device.id} />)}
          </div>
          <footer><span>基准：现有 SwiftUI、同型号模拟器和当前静态文案。</span><span>验收：动态字体、键盘、触觉、真实会话与设备状态仍回到原生端确认。</span></footer>
        </main>
      </div>
    </div>
  );
}
