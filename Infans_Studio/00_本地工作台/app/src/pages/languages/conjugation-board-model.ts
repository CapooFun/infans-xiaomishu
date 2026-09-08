export type ConjugationCardPhase = "foundation" | "functional" | "combination";

export type ConjugationExample = {
  japanese: string;
  chinese: string;
};

export type ConjugationCard = {
  id: string;
  phase: ConjugationCardPhase;
  masteryPointIds: string[];
  title: string;
  japaneseTitle: string;
  purpose: string;
  route: [string, string];
  whenToUse: string;
  steps: string[];
  groupRules: string[];
  examples: ConjugationExample[];
  pitfalls: string[];
  oralPractice: string[];
  sources: string[];
};

export const CONJUGATION_SOURCE_ROOT = "55_语言学习/日语/文法/变形";

export const CONJUGATION_SOURCES = {
  wiki: `${CONJUGATION_SOURCE_ROOT}/日语变形Wiki.md`,
  matrix: `${CONJUGATION_SOURCE_ROOT}/五段动词变形矩阵.md`,
  teForm: `${CONJUGATION_SOURCE_ROOT}/动词て形变形表.md`,
  quickReference: `${CONJUGATION_SOURCE_ROOT}/动词变形.md`,
} as const;

/**
 * 变形卡是 Vault 权威原件的学习视图，不保存或推断掌握状态。
 * masteryPointIds 只声明与现有文法专项掌握节点的对应关系，实时状态仍由探索数据提供。
 * 例句、规则与例外均取自 CONJUGATION_SOURCES；口头练习只要求使用这些已列出的形式。
 */
export const CONJUGATION_CARDS: ConjugationCard[] = [
  {
    id: "volitional",
    phase: "functional",
    masteryPointIds: ["N4-02", "N4-03"],
    title: "意向形",
    japaneseTitle: "〜よう／〜おう",
    purpose: "裸形说当下意志或邀请；谈计划时接「〜ようと思っています／と思う」。",
    route: ["行く", "行こう"],
    whenToUse: "「行こう」这类裸意向形常表达当下意志或邀请；谈较完整的计划时，用「意向形＋と思っています／と思う」。",
    steps: [
      "五段动词：把辞书形最后一个假名移到お段，再接「う」。",
      "一段动词：去掉「る」，接「よう」。",
      "する变「しよう」；来る变「来よう（こよう）」。",
      "表达较完整的计划：在意向形后接「と思っています／と思う」。",
    ],
    groupRules: ["五段：書く→書こう；一段：始める→始めよう。", "不规则：する→しよう；来る→来よう（こよう）。"],
    examples: [
      { japanese: "行く → 行こう", chinese: "走吧／那我去吧（当下意志）" },
      { japanese: "始める → 始めよう", chinese: "开始吧" },
      { japanese: "将来、自分のゲームを作ろうと思っています。", chinese: "将来我打算制作自己的游戏。" },
    ],
    pitfalls: [
      "五段看お段：書く不是直接接「う」，而是「書こ＋う」。",
      "する、来る不走五段坐标，要单独记「しよう、来よう」。",
      "不要把裸意向形一律理解成长期计划；说计划时用「〜ようと思っています／と思う」。",
    ],
    oralPractice: [
      "把「行く・始める・する・来る」依次变成意向形。",
      "选其中一个形式，说一句自己的下一步计划。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix, CONJUGATION_SOURCES.quickReference],
  },
  {
    id: "tara",
    phase: "functional",
    masteryPointIds: ["N4-17"],
    title: "た形＋ら",
    japaneseTitle: "〜たら",
    purpose: "说“如果……”或“做完……以后”。",
    route: ["着く", "着いたら"],
    whenToUse: "四大条件里最通用的一种，既能表达假设，也能表达前一件事完成后的下一步。",
    steps: [
      "先把动词变成た形；五段的た形与て形共用同一套音便。",
      "在た形后接「ら」。",
      "一段动词去「る」接「た」；する→した，来る→来た（きた）。",
    ],
    groupRules: ["五段先做音便：着く→着いたら；行く例外为行ったら。", "一段去る接たら；する→したら；来る→来たら（きたら）。"],
    examples: [
      { japanese: "着いたら連絡して。", chinese: "到了以后联系我。" },
      { japanese: "雨が降ったら行かない。", chinese: "如果下雨就不去。" },
      { japanese: "行く → 行ったら", chinese: "如果去／去了以后（行く是高频音便例外）" },
    ],
    pitfalls: [
      "「たら」从た形出发，不是把「ら」直接接在辞书形后。",
      "行く的正确た形是「行った」，不是「行いた」。",
    ],
    oralPractice: [
      "先说出「着く・降る・行く」的た形，再分别加「ら」。",
      "用一个「〜たら」句说清计划成立的条件。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix],
  },
  {
    id: "nakereba",
    phase: "functional",
    masteryPointIds: ["N4-44"],
    title: "ない形＋なければ",
    japaneseTitle: "〜なければ",
    purpose: "说“如果不做”，继续接「ならない」就是“必须做”。",
    route: ["書かない", "書かなければ"],
    whenToUse: "表达否定条件；接「ならない」时，表达必须完成的事。",
    steps: [
      "先做ない形：五段移到あ段接「ない」；一段去「る」接「ない」。",
      "把结尾「ない」变成「なければ」。",
      "需要表达义务时，继续接「ならない」。",
    ],
    groupRules: ["五段：書く→書かない→書かなければ。", "一段：食べる→食べなければ；する→しなければ；来る→来なければ（こなければ）。"],
    examples: [
      { japanese: "書かない → 書かなければ", chinese: "如果不写" },
      { japanese: "書かなければならない。", chinese: "必须写。" },
      { japanese: "来る → 来ない → 来なければならない", chinese: "必须来。" },
    ],
    pitfalls: [
      "「ない」像い形容词继续变化，不需要回到辞书形重新选音段。",
      "来る的否定是「来ない（こない）」，读音和ます形的「来ます（きます）」不同。",
    ],
    oralPractice: [
      "把「書く・食べる・来る」依次说成ない形，再改成「〜なければ」。",
      "挑一件为了目标必须做的事，用「〜なければならない」说出来。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix],
  },
  {
    id: "verb-groups",
    phase: "foundation",
    masteryPointIds: ["N5-33", "N5-38", "N5-40", "N5-42"],
    title: "先判断动词组别",
    japaneseTitle: "五段・一段・不規則",
    purpose: "先定生成引擎，再选后缀；组别错了，后面的形都会错。",
    route: ["切る", "切らない"],
    whenToUse: "每次开始变形前都先判断：五段改最后一个假名，一段去「る」接后缀，する与来る单独记。",
    steps: [
      "する、来る归入不规则动词。",
      "非「る」结尾的动词几乎都可判为五段。",
      "「いる／える」结尾多数是一段，但帰る、入る、走る、切る、知る、要る等是五段例外；不确定就查词典。",
    ],
    groupRules: ["五段改最后一个假名；一段去る接后缀；する和来る单独记。", "常见五段例外：帰る、入る、走る、切る、知る、要る、減る、しゃべる。"],
    examples: [
      { japanese: "切る → 切らない", chinese: "切る是五段" },
      { japanese: "着る → 着ない", chinese: "着る是一段" },
      { japanese: "食べる → 食べない", chinese: "一段去る接后缀" },
    ],
    pitfalls: [
      "不要把所有「る」结尾都当作一段动词。",
      "自动词／他动词是动作关系，不是五段／一段的变形分类。",
    ],
    oralPractice: [
      "判断「書く・食べる・切る・着る・する・来る」各属哪一组。",
      "用各自正确的规则说出ない形。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.teForm],
  },
  {
    id: "dictionary",
    phase: "foundation",
    masteryPointIds: ["N5-42"],
    title: "辞书形",
    japaneseTitle: "辞書形",
    purpose: "查词、说普通体的非过去肯定，也是大量句型的入口。",
    route: ["書きます", "書く"],
    whenToUse: "查词典、说日常习惯或将来动作，以及接「こと、と、な」等结构时。",
    steps: ["把辞书形当作每张变形卡的原点。", "从ます形还原时，根据词汇与组别恢复词尾，不只是删掉ます。"],
    groupRules: ["五段以う段假名结尾：書く、読む、話す。", "一段以る结尾：食べる、見る；不规则为する、来る（くる）。"],
    examples: [{ japanese: "毎日、日本語を勉強する。", chinese: "每天学日语。" }, { japanese: "明日、京都へ行く。", chinese: "明天去京都。" }],
    pitfalls: ["辞书形可表习惯也可表将来，不等于“现在进行时”。", "「食べるな」的な是禁止，不是否定的ない形。"],
    oralPractice: ["把「書きます・読みます・食べます・します・来ます」还原成辞书形。", "用辞书形说一件每天做的事和一件明天做的事。"],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix],
  },
  {
    id: "masu",
    phase: "foundation",
    masteryPointIds: ["N5-30"],
    title: "ます形",
    japaneseTitle: "連用形＋ます",
    purpose: "说礼貌句，并取得「たい、ながら、やすい」等后缀所需的词干。",
    route: ["書く", "書きます"],
    whenToUse: "在礼貌会话中陈述动作；去掉ます后的连用词干也是多个组合的入口。",
    steps: ["五段移到い段接ます；一段去る接ます。", "时态与否定在ます系统内变：ます／ません／ました／ませんでした。"],
    groupRules: ["五段：読む→読みます；一段：食べる→食べます。", "する→します；来る→来ます（きます）。"],
    examples: [{ japanese: "毎朝七時に起きます。", chinese: "每天早上七点起床。" }, { japanese: "昨日は勉強しませんでした。", chinese: "昨天没有学习。" }],
    pitfalls: ["连用词干是「書き」，ます形是「書きます」，不要混叫。", "来る在来ます中读「き」，不读「こ」。"],
    oralPractice: ["把「買う・書く・読む・食べる・する・来る」变成ます形。", "选一个动词说出四种礼貌时态。"],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix],
  },
  {
    id: "nai",
    phase: "foundation",
    masteryPointIds: ["N5-38"],
    title: "ない形",
    japaneseTitle: "未然形＋ない",
    purpose: "表达普通体否定，并为「なければ、ないで、なくて」提供入口。",
    route: ["買う", "買わない"],
    whenToUse: "说不做某事，或在否定后继续接条件、请求和原因等表达。",
    steps: ["五段移到あ段接ない，但う的あ段是わ。", "一段去る接ない；否定过去把ない变成なかった。"],
    groupRules: ["五段：書く→書かない，買う→買わない；一段：見る→見ない。", "する→しない；来る→来ない（こない）；ある的否定是「ない」。"],
    examples: [{ japanese: "今日はお酒を飲まない。", chinese: "今天不喝酒。" }, { japanese: "昨日はこのアプリを使わなかった。", chinese: "昨天没用这个应用。" }],
    pitfalls: ["買う不是「買あない」，而是「買わない」。", "ある→ない是词汇级例外，不说「あらない」。"],
    oralPractice: ["把「買う・待つ・死ぬ・見る・する・来る」变成ない形。", "把其中两个再变成「なかった」。"],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix],
  },
  {
    id: "te-form",
    phase: "foundation",
    masteryPointIds: ["N5-33"],
    title: "て形",
    japaneseTitle: "音便＋て／で",
    purpose: "连接动作，并打开请求、进行、允许、尝试等整个て形家族。",
    route: ["読む", "読んで"],
    whenToUse: "把动作串起来，或接「ください、いる、もいい、みる、おく」等表达时。",
    steps: ["五段不走五行矩阵，根据词尾使用音便。", "一段去る接て；する→して；来る→来て（きて）。"],
    groupRules: ["う・つ・る→って；む・ぶ・ぬ→んで；く→いて；ぐ→いで；す→して。", "行く例外为行って；一段去る接て。"],
    examples: [{ japanese: "朝起きて、顔を洗って、コーヒーを飲む。", chinese: "早上起床，洗脸，然后喝咖啡。" }, { japanese: "この漢字を読んでください。", chinese: "请读一下这个汉字。" }],
    pitfalls: ["行く的正确て形是行って，不是行いて。", "て形本身不等于请求；语气由后续结构决定。"],
    oralPractice: ["按「うつる／むぶぬ／く／ぐ／す」的顺序背一遍音便。", "把「買う・読む・書く・泳ぐ・話す・行く」变成て形。"],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix, CONJUGATION_SOURCES.teForm],
  },
  {
    id: "ta-form",
    phase: "foundation",
    masteryPointIds: ["N5-40"],
    title: "た形",
    japaneseTitle: "音便＋た／だ",
    purpose: "表达过去或完成，并接经验、列举、条件等结构。",
    route: ["読む", "読んだ"],
    whenToUse: "说已发生或已完成的动作，或接「ことがある、り、ら、ばかり」时。",
    steps: ["使用与て形平行的音便，把て／で换成た／だ。", "一段去る接た；する→した；来る→来た（きた）。"],
    groupRules: ["う・つ・る→った；む・ぶ・ぬ→んだ；く→いた；ぐ→いだ；す→した。", "行く例外为行った；一段去る接た。"],
    examples: [{ japanese: "昨日、新しい辞書を買った。", chinese: "昨天买了新词典。" }, { japanese: "日本で温泉に入ったことがある。", chinese: "曾经在日本泡过温泉。" }],
    pitfalls: ["た形与て形是同一套音便，不要分别背两套。", "読んだ的だ是浊化结果，不写成「読んた」。"],
    oralPractice: ["先把「買う・読む・書く・泳ぐ・話す・行く」说成て形，再原地换成た形。", "用「〜たことがある」说一项真实经验。"],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix],
  },
  {
    id: "core-four",
    phase: "foundation",
    masteryPointIds: ["N5-30", "N5-33", "N5-38", "N5-42"],
    title: "基础四格",
    japaneseTitle: "辞書・ます・ない・て",
    purpose: "先把最常用的四个入口练到能从辞书形稳定生成。",
    route: ["書く", "書きます／書かない／書いて"],
    whenToUse: "礼貌表达、否定和所有て形家族都从这里出发；这是后续叠加语法的基础引擎。",
    steps: [
      "ます形：五段移到い段；一段去る；する→し，来る→来（き）。",
      "ない形：五段移到あ段；一段去る；する→しない，来る→来ない（こない）。",
      "て形：五段查音便表；一段去る接て；する→して，来る→来て（きて）。",
    ],
    groupRules: ["五段在あ／い／う／え／お段之间移动；一段去る；て／た形单独用音便。", "う结尾的あ段是わ：買う→買わない；来る的读音随形式变化。"],
    examples: [
      { japanese: "書く／書きます／書かない／書いて", chinese: "五段四格" },
      { japanese: "食べる／食べます／食べない／食べて", chinese: "一段四格" },
      { japanese: "来る／来ます／来ない／来て", chinese: "来る的读音随形式变化" },
    ],
    pitfalls: [
      "う结尾五段的あ段是「わ」：買う→買わない。",
      "「ます、たい」是接在同一个连用词干上，不是动词自身再变一次。",
    ],
    oralPractice: [
      "把「書く・食べる・する・来る」各说一遍四格。",
      "每个词控制在三秒内完成，再换一个高频动词。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix, CONJUGATION_SOURCES.teForm],
  },
  {
    id: "te-ta",
    phase: "foundation",
    masteryPointIds: ["N5-33", "N5-40"],
    title: "て形／た形音便",
    japaneseTitle: "〜て／〜た",
    purpose: "一套声音规则同时生成接续形和过去／完成形。",
    route: ["読む", "読んで／読んだ"],
    whenToUse: "て形连接动作并承接ください、いる、みる、から等；た形表达过去／完成并承接たら、たり、ことがある。",
    steps: [
      "う・つ・る→って／った；む・ぶ・ぬ→んで／んだ。",
      "く→いて／いた；ぐ→いで／いだ；す→して／した。",
      "一段去る接て／た；する→して／した；来る→来て（きて）／来た（きた）。",
    ],
    groupRules: ["五段：うつる→って／った；むぶぬ→んで／んだ；く→いて／いた；ぐ→いで／いだ；す→して／した。", "一段去る接て／た；行く例外为行って／行った。"],
    examples: [
      { japanese: "買って／買った・読んで／読んだ", chinese: "促音便／拨音便" },
      { japanese: "書いて／書いた・泳いで／泳いだ", chinese: "イ音便与浊化" },
      { japanese: "行く → 行って／行った", chinese: "高频例外" },
    ],
    pitfalls: [
      "て形／た形不走五段主矩阵，要单独查音便。",
      "行く不是「行いて／行いた」，正确是「行って／行った」。",
    ],
    oralPractice: [
      "按「うつる、むぶぬ、く、ぐ、す」的顺序背一遍音便。",
      "把「買う・読む・書く・泳ぐ・話す・行く」变成て形与た形。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix, CONJUGATION_SOURCES.teForm],
  },
  {
    id: "conditionals",
    phase: "functional",
    masteryPointIds: ["N3-20", "N4-15", "N4-16", "N4-17", "N4-18"],
    title: "四大条件",
    japaneseTitle: "と・ば・たら・なら",
    purpose: "按规律、成立条件、通用假设和承接话题区分四种“如果”。",
    route: ["時間がある", "時間があれば行く"],
    whenToUse: "と偏规律与自动结果；ば强调只要条件成立；たら最通用；なら承接已经提出的话题。",
    steps: [
      "と：辞书形／ない形＋と。",
      "ば：五段移到え段＋ば；一段去る＋れば。",
      "たら：た形＋ら；なら：普通形、名词、な形容词＋なら。",
    ],
    groupRules: ["ば：五段え段＋ば；一段去る＋れば；する→すれば；来る→来れば（くれば）。", "と和なら不另造动词活用；たら必须先生成正确た形。"],
    examples: [
      { japanese: "春になると暖かくなる。", chinese: "一到春天就会变暖。" },
      { japanese: "時間があれば行く。", chinese: "有时间就去。" },
      { japanese: "日本へ行くなら京都へ。", chinese: "如果要去日本，就去京都。" },
    ],
    pitfalls: [
      "四种条件不是同一个后缀的替换；它们表达的条件视角不同。",
      "ば形里，一段是去る接「れば」；五段才是移到え段接「ば」。",
    ],
    oralPractice: [
      "把「書く・食べる」分别变成ば形。",
      "用同一个计划各说一句「〜たら」和「〜なら」，听出关注点差别。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix],
  },
  {
    id: "to-nara",
    phase: "functional",
    masteryPointIds: ["N4-15", "N4-18"],
    title: "と与なら",
    japaneseTitle: "規律のと／話題のなら",
    purpose: "用と说稳定结果，用なら承接已提出的话题并给反应。",
    route: ["日本へ行く", "行くと…／行くなら…"],
    whenToUse: "前项一成立就自然发生后项时用と；听到对方的计划后给针对性建议时用なら。",
    steps: ["と：辞书形／ない形＋と。", "なら：动词普通形＋なら；名词和な形容词词干直接＋なら。", "先判断是“自然结果”还是“对话题的反应”。"],
    groupRules: ["动词各组都不另造新活用：すると／するなら，来ると／来るなら。", "名词和な形容词不保留断定的だ：学生なら、静かなら。"],
    examples: [{ japanese: "このボタンを押すと、ドアが開く。", chinese: "一按这个按钮，门就开。" }, { japanese: "日本へ行くなら、京都にも行ってみて。", chinese: "如果要去日本，也去京都看看吧。" }],
    pitfalls: ["と后项通常不放说话人当场的命令、邀请或意志。", "なら不强调 A 完成后 B 才发生；要表时间先后优先用たら。"],
    oralPractice: ["用と说一个机器操作或季节规律。", "听到「日本へ行きたい」后，用なら给一条建议。"],
    sources: [CONJUGATION_SOURCES.wiki],
  },
  {
    id: "ba",
    phase: "functional",
    masteryPointIds: ["N4-16"],
    title: "ば条件",
    japaneseTitle: "仮定形＋ば",
    purpose: "强调只要条件成立，后项就可成立。",
    route: ["時間がある", "時間があれば行く"],
    whenToUse: "把关注点放在成立条件本身，常用于规则、建议和一般假设。",
    steps: ["五段词尾移到え段接ば。", "一段去る接れば。", "否定从ない形出发：ない→なければ。"],
    groupRules: ["五段：書く→書けば，読む→読めば；一段：食べる→食べれば。", "する→すれば；来る→来れば（くれば）。"],
    examples: [{ japanese: "時間があれば、一緒に行きます。", chinese: "如果有时间，我就一起去。" }, { japanese: "毎日練習すれば、少しずつ上手になる。", chinese: "只要每天练习，就会一点点进步。" }],
    pitfalls: ["一段的条件形是食べれば；食べられれば表示“如果能吃”。", "同一主语且前项是意志动作时，后项命令或意志表达受限，入门可先换たら。"],
    oralPractice: ["把「書く・読む・食べる・する・来る」变成ば形。", "用「時間があれば」完成一句真实计划。"],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix],
  },
  {
    id: "commands",
    phase: "functional",
    masteryPointIds: ["N4-04"],
    title: "命令与禁止",
    japaneseTitle: "命令形／辞書形＋な",
    purpose: "识别强硬命令；日常表达请求时要换成更柔和的形式。",
    route: ["書く", "書け／書くな"],
    whenToUse: "命令形要求对方做；禁止形要求对方不做。两者语气都很强，日常慎用。",
    steps: [
      "五段命令形：最后一个假名移到え段；一段去る接「ろ／よ」。",
      "する→しろ／せよ；来る→来い（こい）。",
      "禁止形不移动音段，直接用辞书形＋な。",
    ],
    groupRules: ["五段：書く→書け；一段：食べる→食べろ／食べよ。", "する→しろ／せよ；来る→来い（こい）；禁止形各组一律辞书形＋な。"],
    examples: [
      { japanese: "書く → 書け／食べる → 食べろ", chinese: "五段／一段命令" },
      { japanese: "動くな。／言うな。", chinese: "不准动。／别说。" },
      { japanese: "食べてくれる？→食べてください→食べなさい→食べろ", chinese: "从柔和到强硬" },
    ],
    pitfalls: [
      "禁止形不是把动词移到其他音段，而是完整辞书形直接接「な」。",
      "命令形与禁止形都很强，不要把它们当普通请求。",
    ],
    oralPractice: [
      "把「書く・食べる・する・来る」说成命令形。",
      "再给每个辞书形接「な」，对比两种方向。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix, CONJUGATION_SOURCES.quickReference],
  },
  {
    id: "potential",
    phase: "functional",
    masteryPointIds: ["N4-01"],
    title: "可能形",
    japaneseTitle: "〜える／〜られる",
    purpose: "表达能做、会做或条件允许做。",
    route: ["書く", "書ける"],
    whenToUse: "说能力或许可；能力对象常用「が」。五段可能形生成后按一段动词继续变化。",
    steps: [
      "五段移到え段接「る」。",
      "一段去る接「られる」；する→できる；来る→来られる（こられる）。",
      "生成后的可能动词按一段继续变：書けない、書けます、書けた。",
    ],
    groupRules: ["五段：書く→書ける；一段：食べる→食べられる。", "不规则：する→できる；来る→来られる（こられる）；正式场合优先保留ら。"],
    examples: [
      { japanese: "書く → 書ける", chinese: "能写" },
      { japanese: "食べる → 食べられる", chinese: "能吃" },
      { japanese: "日本語が話せる。", chinese: "会说日语。" },
    ],
    pitfalls: [
      "一段的「〜られる」也可能表示被动或尊敬，必须看主语、助词和上下文。",
      "考试与正式写作优先完整形式「食べられる、来られる」。",
    ],
    oralPractice: [
      "把「書く・食べる・する・来る」变成可能形。",
      "用「〜が〜られる／〜える」说一项自己能做的事。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix, CONJUGATION_SOURCES.quickReference],
  },
  {
    id: "passive",
    phase: "functional",
    masteryPointIds: ["N4-05", "N3-54"],
    title: "被动形",
    japaneseTitle: "〜れる／〜られる",
    purpose: "表达被做、受到影响，也可能用于尊敬表达。",
    route: ["褒める", "褒められる"],
    whenToUse: "说动作落在主语身上、主语受到了某件事的影响，或用作尊敬表达。",
    steps: [
      "五段移到あ段接「れる」。",
      "一段去る接「られる」；する→される；来る→来られる。",
      "根据主语、助词与上下文区分被动、可能和尊敬。",
    ],
    groupRules: ["五段：叱る→叱られる；一段：褒める→褒められる。", "する→される；来る→来られる（こられる）；「〜られる」需靠句法区分可能／被动／尊敬。"],
    examples: [
      { japanese: "私は先生に褒められた。", chinese: "我被老师表扬了。" },
      { japanese: "私は雨に降られた。", chinese: "我倒霉地遇上了下雨。" },
      { japanese: "先生は帰られました。", chinese: "老师回去了。（尊敬）" },
    ],
    pitfalls: [
      "看到「〜られる」不能只靠词尾断定含义。",
      "五段被动走あ段：叱る→叱られる，不是可能形的え段。",
    ],
    oralPractice: [
      "把「書く・食べる・する・来る」变成被动形。",
      "朗读三条例句，分别指出被动受事、受害和尊敬。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix, CONJUGATION_SOURCES.quickReference],
  },
  {
    id: "causative",
    phase: "functional",
    masteryPointIds: ["N4-06", "N3-55"],
    title: "使役形",
    japaneseTitle: "〜せる／〜させる",
    purpose: "表达让、使或允许别人做。",
    route: ["行く", "行かせる"],
    whenToUse: "说让某人做、使某事发生，或允许某人做。使役对象用「に」还是「を」取决于原动词和句子结构。",
    steps: [
      "五段移到あ段接「せる」。",
      "一段去る接「させる」。",
      "する→させる；来る→来させる（こさせる）。",
    ],
    groupRules: ["五段：行く→行かせる；一段：食べる→食べさせる。", "する→させる；来る→来させる（こさせる）；使役对象的に／を要结合原动词与句子结构。"],
    examples: [
      { japanese: "行く → 行かせる", chinese: "让去" },
      { japanese: "食べる → 食べさせる", chinese: "让吃" },
      { japanese: "書く → 書かせる", chinese: "让写" },
    ],
    pitfalls: [
      "五段的使役与被动都从あ段出发，但后缀分别是「せる」与「れる」。",
      "一段去る接「させる」，不要套五段音段移动。",
    ],
    oralPractice: [
      "把「書く・食べる・する・来る」变成使役形。",
      "在形式前说出原形，再解释它是“让谁做什么”。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix, CONJUGATION_SOURCES.quickReference],
  },
  {
    id: "causative-passive",
    phase: "functional",
    masteryPointIds: ["N3-56"],
    title: "使役被动",
    japaneseTitle: "〜させられる／〜される",
    purpose: "表达被迫做、不情愿地被要求做。",
    route: ["書く", "書かせられる／書かされる"],
    whenToUse: "把使役继续变成被动，表达主语被迫完成动作。长变形要从右往左拆。",
    steps: [
      "先生成使役：書く→書かせる，食べる→食べさせる。",
      "再接被动：書かせられる、食べさせられる。",
      "部分五段可缩约：書かせられる→書かされる；話す通常不缩成「話さされる」。",
    ],
    groupRules: ["五段完整形可缩约：書かせられる→書かされる，読ませられる→読まされる。", "一段与不规则保留完整形：食べさせられる、させられる、来させられる；す结尾五段通常不缩。"],
    examples: [
      { japanese: "書く → 書かせられる → 書かされる", chinese: "被迫写" },
      { japanese: "飲む → 飲ませられる → 飲まされる", chinese: "被迫喝" },
      { japanese: "食べさせられたくなかった。", chinese: "过去并不想被迫吃。" },
    ],
    pitfalls: [
      "不要把整串后缀当成一个无法拆分的单词；从右往左识别否定、时态与语态。",
      "「話させられる」通常不缩成「話さされる」。",
    ],
    oralPractice: [
      "把「書く・飲む・食べる」先变使役，再变使役被动。",
      "从右往左拆解「食べさせられたくなかった」。",
    ],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.quickReference],
  },
  {
    id: "masu-family",
    phase: "combination",
    masteryPointIds: ["N5-30", "N3-50"],
    title: "ます词干家族",
    japaneseTitle: "連用形＋たい・ながら・やすい…",
    purpose: "用同一个连用词干组合愿望、同时动作、难易和动作阶段。",
    route: ["書きます", "書きたい／書きながら"],
    whenToUse: "已经能生成ます形时，去掉ます保留词干，再接愿望、易难和复合动词。",
    steps: ["先生成正确的ます形。", "去掉「ます」取得连用词干。", "按意思接「たい、ながら、やすい、にくい、始める、終わる」等。"],
    groupRules: ["五段：書く→書き，読む→読み；一段：食べる→食べ。", "する→し；来る→来（き）。"],
    examples: [{ japanese: "日本語の本を読みながら、新しい言葉を覚える。", chinese: "一边读日语书，一边记新词。" }, { japanese: "この辞書は使いやすい。", chinese: "这本词典很好用。" }],
    pitfalls: ["「たい」接连用词干：読みたい，不是読みますたい。", "「たい」后按い形容词变：食べたくない、食べたかった。"],
    oralPractice: ["说出「書く・読む・食べる・する・来る」的连用词干。", "从「たい・ながら・やすい・始める」选两个后缀各造一句。"],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.matrix],
  },
  {
    id: "te-ta-families",
    phase: "combination",
    masteryPointIds: ["N5-33", "N5-40", "N4-07", "N4-08"],
    title: "て形／た形家族",
    japaneseTitle: "〜ている・〜てみる／〜たことがある…",
    purpose: "把基础音便形当成稳定接口，不为每个句型重背变形。",
    route: ["食べて／食べた", "食べてみる／食べたことがある"],
    whenToUse: "表达进行或状态、允许、尝试、准备、完成，以及经验、列举、建议和条件时。",
    steps: ["先独立生成て形或た形。", "选后缀：ている／もいい／みる／おく／しまう，或たことがある／り／ら／ほうがいい。", "只让整串最后的词负责否定、时态和礼貌度。"],
    groupRules: ["所有组先归约到正确て／た形，再共用后缀；行く仍是行って／行った。", "口语缩约：ている→てる，ておく→とく，てしまう→ちゃう，でしまう→じゃう。"],
    examples: [{ japanese: "新しい方法を試してみる。", chinese: "试试新方法。" }, { japanese: "北海道へ行ったことがある。", chinese: "曾经去过北海道。" }],
    pitfalls: ["「結婚している」常表已婚状态，不是正在举行婚礼。", "缩约形先要能还原完整形，正式写作中谨慎使用。"],
    oralPractice: ["用同一个动词依次接「ている・てみる・ておく・たことがある・たら」。", "把「食べちゃった」还原成完整形并解释。"],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.teForm],
  },
  {
    id: "stack-reading",
    phase: "combination",
    masteryPointIds: ["N4-01", "N4-05", "N4-06", "N3-56"],
    title: "长变形拆解",
    japaneseTitle: "原形＋语态＋愿望＋否定＋时态",
    purpose: "从左向右生成，从右向左识别，把长词尾拆成可验证的层。",
    route: ["食べる", "食べさせられたくなかった"],
    whenToUse: "遇到使役、被动、愿望、否定和过去叠在一起的长形式时，不整块硬背。",
    steps: ["从原形一层一层生成：食べる→食べさせる→食べさせられる。", "继续接愿望、否定和过去：〜たい→〜たくない→〜たくなかった。", "识别时反向剥离最右边的时态、否定、愿望和语态。"],
    groupRules: ["语态形生成后多数按一段继续变；右端「なかった」负责整体过去否定。", "复合动词以最后一个动词的组别决定后续变形。"],
    examples: [{ japanese: "子どもの頃、野菜を食べさせられたくなかった。", chinese: "小时候不想被迫吃蔬菜。" }, { japanese: "この記事は読まれていない。", chinese: "这篇文章还没有被读。" }],
    pitfalls: ["语态变形后不能回头再按原动词组别处理每一层。", "长形式整体的否定和过去由最右端决定。"],
    oralPractice: ["从左向右说「書く→让写→被迫写→不想被迫写→过去不想被迫写」。", "从右向左拆「読ませられたくなかった」，每层说功能。"],
    sources: [CONJUGATION_SOURCES.wiki, CONJUGATION_SOURCES.quickReference],
  },
];

export function cardsForPhase(phase: ConjugationCardPhase) {
  const order: Record<ConjugationCardPhase, string[]> = {
    foundation: ["verb-groups", "dictionary", "masu", "nai", "te-form", "ta-form", "core-four", "te-ta"],
    functional: ["volitional", "conditionals", "to-nara", "ba", "tara", "nakereba", "commands", "potential", "passive", "causative", "causative-passive"],
    combination: ["masu-family", "te-ta-families", "stack-reading"],
  };
  const rank = new Map(order[phase].map((id, index) => [id, index]));
  return CONJUGATION_CARDS
    .filter((card) => card.phase === phase)
    .toSorted((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export function uniqueConjugationSources(cards: ConjugationCard[] = CONJUGATION_CARDS) {
  return [...new Set(cards.flatMap((card) => card.sources))];
}
