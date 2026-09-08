/**
 * 银月朗读语种检测与声线映射。
 * Edge 无古典拉丁语专用声线：拉丁语暂用意大利语女声（教会拉丁读音更接近）。
 */

import { chatCharacterById, normalizeChatSpeaker } from "./secretary-characters.mjs";

export const SECRETARY_EDGE_VOICES = {
  zh: "zh-CN-XiaoxiaoNeural",
  ja: "ja-JP-NanamiNeural",
  ko: "ko-KR-SunHiNeural",
  en: "en-US-AvaNeural",
  la: "it-IT-ElsaNeural",
  it: "it-IT-ElsaNeural",
  fr: "fr-FR-DeniseNeural",
  es: "es-ES-ElviraNeural",
  de: "de-DE-KatjaNeural",
};

export const SECRETARY_EDGE_VOICE = SECRETARY_EDGE_VOICES.zh;

/** 真词里的「儿」要保留，别当儿化音拆掉。 */
const ERHUA_KEEP =
  /女儿|儿子|儿童|儿歌|儿科|儿化|幼儿|托儿|婴儿|孤儿|男儿|健儿|少儿|宠儿|胎儿|新生儿|混血儿|托儿所|幼儿园/g;

/**
 * 朗读前去掉口语儿化，避免大陆神经声线把「会儿 / 这儿」念得很京腔。
 * 只能处理文案里写出来的儿化；模型自己加的卷舌无法完全关掉。
 */
export function stripErhuaForSpeech(raw = "") {
  let text = String(raw || "");
  if (!text.includes("儿")) return text;

  /** @type {string[]} */
  const kept = [];
  text = text.replace(ERHUA_KEEP, (match) => {
    const token = `\uE000${kept.length}\uE001`;
    kept.push(match);
    return token;
  });

  const phrases = [
    [/这儿/g, "这里"],
    [/那儿/g, "那里"],
    [/哪儿/g, "哪里"],
    [/一点儿/g, "一点"],
    [/有点儿/g, "有点"],
    [/差点儿/g, "差点"],
    [/一会儿/g, "一会"],
    [/这会儿/g, "这会"],
    [/那会儿/g, "那会"],
    [/待会儿/g, "待会"],
    [/一块儿/g, "一块"],
    [/干活儿/g, "干活"],
    [/好玩儿/g, "好玩"],
    [/大伙儿/g, "大伙"],
    [/小孩儿/g, "小孩"],
    [/老头儿/g, "老头"],
    [/门口儿/g, "门口"],
  ];
  for (const [pattern, repl] of phrases) text = text.replace(pattern, repl);

  // 常见后缀儿化：会儿、事儿、玩儿、劲儿…
  text = text.replace(/([点会事玩劲味空活门火哥妹花猫鸟刀片弦弯圈堆份股瓣边面座])儿/g, "$1");

  text = text.replace(/\uE000(\d+)\uE001/g, (_, index) => kept[Number(index)] || "");
  return text;
}

/** @param {"yinyue" | "meining" | string} speaker */
export function edgeVoiceForSecretary(speaker = "yinyue", lang = "zh") {
  const id = normalizeChatSpeaker(speaker);
  const character = id ? chatCharacterById(id) : null;
  // 银月的身份声线优先于语种：中日文混排可以口音不完美，但不能换成另一个人。
  if (id === "yinyue" && character?.edgeZhVoice) return character.edgeZhVoice;
  if ((!lang || lang === "zh") && character?.edgeZhVoice) return character.edgeZhVoice;
  return voiceForSpeechLang(lang);
}

const LATIN_WORDS = /\b(et|est|sunt|non|sed|cum|quod|qui|quae|hoc|hac|ego|sum|esse|amor|vita|deus|rex|lux|pax|veritas|ergo|igitur|quia|neque|atque|aut|vel|si|nisi|ut|ad|ab|ex|in|de|per|pro|sub|super|inter|ante|post|contra|sine|meus|tuus|suus|noster|vester|ille|iste|ipse|hic|haec|idem|eadem|omnia|nihil|res|dies|homo|femina|puer|puella|bonus|magnus|parvus|novus|vetus|amo|amas|amat|amare|habeo|video|dico|facio|venio|possum|volo|nolo|scio|credo|anno|domini|sanctus|mater|pater|filius|spiritus|amen|bellum|corpus|lingua|tempus|locus|nomen|vox|aqua|terra|caelum|sol|luna|nox|ars|lex|mos|gens|urbs|via|mare|flumen|ignis|ventus|rosa|liber|schola|discipulus|magister|gratia|gloria|ora|ora[s]?|oro|orare)\b/gi;
const ENGLISH_WORDS = /\b(the|and|is|are|you|that|with|this|have|for|not|but|what|can|will|would|should|about|from|they|their|been|were|said|just|like|want|know|your|my|me|we|our|it's|don't|can't|i'm|you're)\b/gi;
const LATIN_ENDINGS = /\b[a-záéíóú]{3,}(ibus|orum|arum|tur|ntur|que|ae|iis)\b/gi;

function count(text, re) {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const matches = String(text).match(new RegExp(re.source, flags));
  return matches ? matches.length : 0;
}

function looksLikeLatin(text) {
  const lower = String(text).toLowerCase();
  const latinHits = count(lower, LATIN_WORDS);
  const enHits = count(lower, ENGLISH_WORDS);
  const endings = count(lower, LATIN_ENDINGS);
  if (latinHits >= 2 && latinHits >= enHits) return true;
  if (latinHits >= 1 && endings >= 2 && enHits <= latinHits) return true;
  if (endings >= 4 && enHits === 0) return true;
  return false;
}

/** @returns {keyof typeof SECRETARY_EDGE_VOICES} */
export function detectSpeechLang(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return "zh";

  const kana = count(text, /[\u3040-\u309F\u30A0-\u30FF]/g);
  const hangul = count(text, /[\uAC00-\uD7AF]/g);
  const han = count(text, /[\u4E00-\u9FFF]/g);
  const letters = count(text, /[A-Za-zÀ-öø-ÿĀ-ſ]/g);

  if (hangul >= 2 && hangul >= kana) return "ko";
  // 假名优先：日语常夹汉字
  if (kana >= 1) return "ja";
  if (han >= 1 && letters < Math.max(4, han * 3)) return "zh";

  if (letters >= 3) {
    if (looksLikeLatin(text)) return "la";
    if (/[äöüß]/i.test(text) || /\b(der|die|das|und|ist|nicht|ich|sie|ein|eine)\b/i.test(text)) return "de";
    if (/[àâæçéèêëïîôùûüÿœ]/i.test(text) && /\b(le|la|les|des|une|est|dans|pour|avec|je|tu|nous)\b/i.test(text)) return "fr";
    if (/[áéíóúñ¿¡]/i.test(text) || /\b(el|los|las|que|para|con|una|por|como)\b/i.test(text)) return "es";
    if (/\b(il|gli|che|non|sono|per|una|questo|quella|ciao)\b/i.test(text) && !looksLikeLatin(text)) return "it";
    return "en";
  }

  return "zh";
}

export function voiceForSpeechLang(lang = "zh") {
  return SECRETARY_EDGE_VOICES[lang] || SECRETARY_EDGE_VOICES.zh;
}

/** 中文默认略快于神经声线基准；外语按跟读舒适度单独微调。 */
export function prosodyForSpeechLang(lang = "zh") {
  if (lang === "ja") return { rate: "+22%", pitch: "+3Hz" };
  if (lang === "la") return { rate: "+12%", pitch: "+2Hz" };
  if (lang === "en") return { rate: "+20%", pitch: "+3Hz" };
  if (lang === "ko") return { rate: "+20%", pitch: "+3Hz" };
  return { rate: "+10%", pitch: "+5Hz" };
}

/** 声线差异从共享注册表读取。 */
export function prosodyForSecretary(speaker = "yinyue", lang = "zh") {
  const character = chatCharacterById(speaker);
  if (character && character.id !== "meining") {
    if (lang === "ja" || lang === "en" || lang === "ko") return { rate: "+10%", pitch: "+1Hz" };
    if (lang === "la") return { rate: "+5%", pitch: "+0Hz" };
    return { rate: `${Math.round((character.webRate - 1) * 100) >= 0 ? "+" : ""}${Math.round((character.webRate - 1) * 100)}%`, pitch: `${Math.round((character.webPitch - 1) * 30) >= 0 ? "+" : ""}${Math.round((character.webPitch - 1) * 30)}Hz` };
  }
  return prosodyForSpeechLang(lang);
}

/**
 * 按句切段并合并相邻同语种，方便中日夹杂朗读。
 * @returns {{ lang: string, text: string }[]}
 */
export function segmentSpeechByLang(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return [];

  const pieces = text
    .split(/(?<=[。！？!?…\n])\s*|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const source = pieces.length ? pieces : [text];
  /** @type {{ lang: string, text: string }[]} */
  const segments = [];
  for (const part of source) {
    const lang = detectSpeechLang(part);
    const last = segments[segments.length - 1];
    if (last && last.lang === lang) {
      const joiner = /^(zh|ja|ko)$/.test(lang) ? "" : " ";
      last.text = `${last.text}${joiner}${part}`.replace(/\s{2,}/g, " ").trim();
    } else segments.push({ lang, text: part });
  }
  return segments;
}

/** Web Speech 的 BCP-47 提示。 */
export function webSpeechLangFor(lang = "zh") {
  const map = {
    zh: "zh-CN",
    "zh-TW": "zh-TW",
    ja: "ja-JP",
    ko: "ko-KR",
    en: "en-US",
    la: "it-IT",
    it: "it-IT",
    fr: "fr-FR",
    es: "es-ES",
    de: "de-DE",
  };
  return map[lang] || "zh-CN";
}

/** @param {"yinyue" | "meining" | string} speaker */
export function webSpeechLangForSecretary(speaker = "yinyue", lang = "zh") {
  return webSpeechLangFor(lang);
}
