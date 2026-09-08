import type { MuscleMapValues, MuscleGroup } from "@musclemap/core";
import type { TrainingSession } from "./types";

export type MuscleId = "chest" | "back" | "shoulders" | "arms" | "quads" | "posterior" | "core";
export type MuscleView = "front" | "back";
export type RecoveryStatus = "recovering" | "ready" | "due" | "overdue" | "unknown";

export type MuscleHit = { date: string; exercise: string; topSet: string };
export type ExerciseRecommendation = {
  name: string;
  note: string;
  /** exercises-dataset 文件名主干，如 0025-EIeI8Vf */
  mediaId?: string;
  datasetName?: string;
};

export type MuscleZone = {
  id: MuscleId;
  label: string;
  views: MuscleView[];
  recoveryDays: number;
  idealCadenceDays: number;
  overdueDays: number;
  keywords: string[];
  strengthLabels: string[];
  muscleGroups: MuscleGroup[];
  recommendations: ExerciseRecommendation[];
};

export type MuscleState = {
  id: MuscleId;
  label: string;
  status: RecoveryStatus;
  daysSince: number | null;
  lastDate: string | null;
  hits: MuscleHit[];
  headline: string;
  detail: string;
  score: number;
};

/** 按一周 4 练上下肢分化的粗粒度恢复窗；非医学精确，只服务「该练了吗」提示。 */
export const MUSCLE_ZONES: MuscleZone[] = [
  {
    id: "chest",
    label: "胸",
    views: ["front"],
    recoveryDays: 2,
    idealCadenceDays: 5,
    overdueDays: 10,
    keywords: ["卧推", "夹胸", "飞鸟", "俯卧撑", "胸推", "上斜"],
    strengthLabels: ["杠铃卧推", "平板哑铃卧推", "俯卧撑"],
    muscleGroups: ["CHEST"],
    recommendations: [
      { name: "杠铃平板卧推", note: "主项 · 工作组约 55–60 kg", mediaId: "0025-EIeI8Vf", datasetName: "barbell bench press" },
      { name: "上斜哑铃卧推", note: "补上胸 · 7/30 约 39kg(史密斯) × 12次 4组", mediaId: "0314-ns0SIbU", datasetName: "dumbbell incline bench press" },
      { name: "哑铃飞鸟", note: "开合轨迹 · 6kg × 25次 3组", mediaId: "0308-yz9nUhF", datasetName: "dumbbell fly" },
    ],
  },
  {
    id: "back",
    label: "背",
    views: ["back"],
    recoveryDays: 2,
    idealCadenceDays: 5,
    overdueDays: 10,
    keywords: ["引体", "划船", "下拉", "山羊挺身"],
    strengthLabels: ["标准引体", "引体训练容量", "划船"],
    muscleGroups: ["LATS", "TRAPEZIUS", "RHOMBOIDS", "BACK_LOWER"],
    recommendations: [
      { name: "引体向上", note: "背宽维持 · 7/30 总量约 20", mediaId: "0652-lBDjFxJ", datasetName: "pull-up" },
      { name: "坐姿划船", note: "厚度 · 胸托 40kg/侧 × 10次 3组", mediaId: "0861-fUBheHs", datasetName: "cable seated row" },
      { name: "高位下拉", note: "引体替代 · 记档位", mediaId: "2330-LEprlgG", datasetName: "cable lat pulldown full range of motion" },
    ],
  },
  {
    id: "shoulders",
    label: "肩",
    views: ["front", "back"],
    recoveryDays: 2,
    idealCadenceDays: 5,
    overdueDays: 10,
    keywords: ["侧平举", "肩推", "推举", "面拉", "耸肩"],
    strengthLabels: [],
    muscleGroups: ["SHOULDERS_FRONT", "SHOULDERS_SIDE", "SHOULDERS_REAR"],
    recommendations: [
      { name: "侧平举", note: "侧束 · 勿冲大重量", mediaId: "0334-DsgkuIt", datasetName: "dumbbell lateral raise" },
      { name: "面拉", note: "后束与肩胛稳定", mediaId: "0233-ZfyAGhK", datasetName: "cable standing rear delt row (with rope)" },
    ],
  },
  {
    id: "arms",
    label: "手臂",
    views: ["front", "back"],
    recoveryDays: 2,
    idealCadenceDays: 5,
    overdueDays: 10,
    keywords: ["弯举", "臂屈伸", "三头", "二头", "绳索下压"],
    strengthLabels: [],
    muscleGroups: ["BICEPS", "TRICEPS", "FOREARMS"],
    recommendations: [
      { name: "哑铃弯举", note: "二头 · 上肢日收尾", mediaId: "0294-NbVPDMW", datasetName: "dumbbell biceps curl" },
      { name: "绳索下压", note: "三头 · 推日自然带到", mediaId: "0201-3ZflifB", datasetName: "cable pushdown" },
    ],
  },
  {
    id: "quads",
    label: "股四",
    views: ["front"],
    recoveryDays: 3,
    idealCadenceDays: 7,
    overdueDays: 14,
    keywords: ["深蹲", "保加利亚", "分腿蹲", "腿屈伸", "单腿蹲", "腿举"],
    strengthLabels: ["深蹲", "保加利亚分腿蹲"],
    muscleGroups: ["QUADS", "ADDUCTORS"],
    recommendations: [
      { name: "杠铃深蹲", note: "主项 · 日志约 59kg(史密斯) × 10次 3组", mediaId: "0043-qXTaZnJ", datasetName: "barbell full squat" },
      { name: "保加利亚分腿蹲", note: "单侧 · 最近 14kg × 12次/侧", mediaId: "0410-qx4fgX7", datasetName: "dumbbell single leg split squat" },
      { name: "腿屈伸", note: "孤立收尾 · 可跳过若已力竭", mediaId: "0585-my33uHU", datasetName: "lever leg extension" },
    ],
  },
  {
    id: "posterior",
    label: "后链",
    views: ["back"],
    recoveryDays: 3,
    idealCadenceDays: 7,
    overdueDays: 14,
    keywords: ["硬拉", "腿弯举", "臀桥", "髋推", "山羊挺身", "罗马尼亚"],
    strengthLabels: [],
    muscleGroups: ["HAMSTRINGS", "GLUTES", "CALVES"],
    recommendations: [
      { name: "罗马尼亚硬拉", note: "臀腘与久坐后链", mediaId: "0085-wQ2c4XD", datasetName: "barbell romanian deadlift" },
      { name: "腿弯举", note: "腘绳孤立", mediaId: "0586-17lJ1kr", datasetName: "lever lying leg curl" },
    ],
  },
  {
    id: "core",
    label: "核心",
    views: ["front"],
    recoveryDays: 1,
    idealCadenceDays: 4,
    overdueDays: 10,
    keywords: ["悬垂举腿", "举腿", "抬腿", "平板支撑", "卷腹", "核心", "死虫", "腹轮", "骨盆"],
    strengthLabels: ["悬垂举腿", "平板支撑"],
    muscleGroups: ["CORE", "OBLIQUES"],
    recommendations: [
      { name: "死虫", note: "控骨盆与下腹", mediaId: "0276-iny3m5y", datasetName: "dead bug" },
      { name: "负重卷腹", note: "腹厚度", mediaId: "0832-s8nrDXF", datasetName: "weighted crunch" },
      { name: "悬垂举腿", note: "下腹 · 8/4 总量 60；日常约 15次 3组", mediaId: "0472-I3tsCnC", datasetName: "hanging leg raise" },
    ],
  },
];

const STATUS_COPY: Record<RecoveryStatus, { headline: string; tone: string; score: number; color: string }> = {
  /** 安全第一：还在恢复 → 红色，先别硬冲 */
  recovering: { headline: "恢复中", tone: "warn", score: 50, color: "#e0786e" },
  /** 恢复好了 → 绿色，可以练 */
  ready: { headline: "已恢复", tone: "teal", score: 50, color: "#7ec9c0" },
  /** 该安排了 → 黄色 */
  due: { headline: "该练了", tone: "gold", score: 50, color: "#e2c76a" },
  /** 太久没练 → 白色，提醒覆盖，但不是「疲劳危险」 */
  overdue: { headline: "太久没练", tone: "white", score: 50, color: "#edf2ef" },
  unknown: { headline: "尚无记录", tone: "muted", score: 50, color: "#5a6c6e" },
};

export const STATUS_COLORS = {
  recovering: STATUS_COPY.recovering.color,
  ready: STATUS_COPY.ready.color,
  due: STATUS_COPY.due.color,
  overdue: STATUS_COPY.overdue.color,
  unknown: STATUS_COPY.unknown.color,
} as const;

export const MUSCLEMAP_LABELS: Partial<Record<MuscleGroup, string>> = {
  CHEST: "胸",
  LATS: "背阔",
  TRAPEZIUS: "斜方",
  RHOMBOIDS: "菱形",
  BACK_LOWER: "下背",
  SHOULDERS_FRONT: "前束",
  SHOULDERS_SIDE: "侧束",
  SHOULDERS_REAR: "后束",
  BICEPS: "二头",
  TRICEPS: "三头",
  FOREARMS: "前臂",
  QUADS: "股四",
  ADDUCTORS: "内收",
  HAMSTRINGS: "腘绳",
  GLUTES: "臀",
  CALVES: "小腿",
  CORE: "腹直",
  OBLIQUES: "腹斜",
};

export function statusMeta(status: RecoveryStatus) {
  return STATUS_COPY[status];
}

export function statusColor(status: RecoveryStatus) {
  return STATUS_COPY[status].color;
}

/** 把 MuscleMap 的 group / partId 解析成我们的状态色。 */
export function paintColorForMuscleLabel(label: string, states: MuscleState[], partIndex: Record<string, MuscleGroup>) {
  const direct = label as MuscleGroup;
  const group = partIndex[label] ?? (MUSCLE_ZONES.some((zone) => zone.muscleGroups.includes(direct)) ? direct : null);
  if (!group) return null;
  const id = muscleIdFromGroup(group);
  if (!id) return null;
  const state = states.find((item) => item.id === id);
  return state ? STATUS_COPY[state.status].color : null;
}

export function buildPartGroupIndex(parts: Record<string, readonly string[]>) {
  const index: Record<string, MuscleGroup> = {};
  for (const [group, list] of Object.entries(parts)) {
    index[group] = group as MuscleGroup;
    for (const partId of list) index[partId] = group as MuscleGroup;
  }
  return index;
}

function daysBetween(fromDay: string, toDay: string) {
  const a = Date.parse(`${fromDay}T00:00:00+09:00`);
  const b = Date.parse(`${toDay}T00:00:00+09:00`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function matchZone(exerciseName: string) {
  return MUSCLE_ZONES.filter((zone) => zone.keywords.some((keyword) => exerciseName.includes(keyword)));
}

function classify(zone: MuscleZone, daysSince: number | null): RecoveryStatus {
  if (daysSince === null) return "unknown";
  if (daysSince < zone.recoveryDays) return "recovering";
  if (daysSince < zone.idealCadenceDays) return "ready";
  if (daysSince < zone.overdueDays) return "due";
  return "overdue";
}

function detailFor(status: RecoveryStatus, daysSince: number | null, zone: MuscleZone) {
  if (daysSince === null) return "训练日志里还没练过这块；点开看从哪几个动作开始。";
  if (status === "recovering") return `距上次 ${daysSince} 天 · 建议再歇 ${zone.recoveryDays - daysSince} 天左右。`;
  if (status === "ready") return `距上次 ${daysSince} 天 · 已经恢复好了，可以正式练。`;
  if (status === "due") return `距上次 ${daysSince} 天 · 超过该练的间隔（约 ${zone.idealCadenceDays} 天），这周排进去。`;
  return `距上次 ${daysSince} 天 · 已经拖过 ${zone.overdueDays} 天了，尽快练一次。`;
}

export function buildMuscleStates(sessions: TrainingSession[], today: string): MuscleState[] {
  const hits = new Map<MuscleId, MuscleHit[]>(MUSCLE_ZONES.map((zone) => [zone.id, []]));

  for (const session of sessions) {
    for (const exercise of session.exercises) {
      for (const zone of matchZone(exercise.name)) {
        hits.get(zone.id)!.push({ date: session.date, exercise: exercise.name, topSet: exercise.topSet || "—" });
      }
    }
  }

  return MUSCLE_ZONES.map((zone) => {
    const zoneHits = [...(hits.get(zone.id) ?? [])].sort((a, b) => b.date.localeCompare(a.date));
    const lastDate = zoneHits[0]?.date ?? null;
    const daysSince = lastDate ? daysBetween(lastDate, today) : null;
    const status = classify(zone, daysSince);
    return {
      id: zone.id,
      label: zone.label,
      status,
      daysSince,
      lastDate,
      hits: zoneHits.slice(0, 6),
      headline: STATUS_COPY[status].headline,
      detail: detailFor(status, daysSince, zone),
      score: STATUS_COPY[status].score,
    };
  });
}

export function zoneById(id: MuscleId) {
  return MUSCLE_ZONES.find((zone) => zone.id === id)!;
}

export function muscleIdFromGroup(group: MuscleGroup): MuscleId | null {
  return MUSCLE_ZONES.find((zone) => zone.muscleGroups.includes(group))?.id ?? null;
}

export function toMuscleMapValues(states: MuscleState[]): MuscleMapValues {
  const values: MuscleMapValues = {};
  for (const state of states) {
    const zone = zoneById(state.id);
    for (const group of zone.muscleGroups) {
      values[group] = {
        score: state.score,
        trend: state.status === "overdue" || state.status === "due" ? "DOWN" : state.status === "ready" ? "UP" : "STABLE",
      };
    }
  }
  return values;
}

export function exerciseMediaUrls(mediaId: string) {
  return {
    gif: `/api/exercises/${encodeURIComponent(mediaId)}.gif`,
    image: `/api/exercises/${encodeURIComponent(mediaId)}.jpg`,
  };
}
