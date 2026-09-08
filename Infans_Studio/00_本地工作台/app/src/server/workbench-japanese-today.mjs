export function tokyoTodayKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function tokyoPreviousDateKey(now = new Date()) {
  const [year, month, day] = tokyoTodayKey(now).split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day));
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

const TRACK_LABELS = {
  full: "练习",
  formal: "练习",
  vocab: "词汇",
  grammar: "文法",
  special: "专项练习",
  mistake: "错题",
  reading: "阅读",
  listening: "听力",
  bank_quiz: "练习",
};

const TRACK_GROUPS = {
  special: "special",
  mistake: "special",
  grammar: "special",
  vocab: "special",
  reading: "reading",
  full: "exam",
  formal: "exam",
  listening: "exam",
  bank_quiz: "exam",
};

function finiteMinutes(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function summarizeSessions(sessions, group) {
  const rows = sessions.filter((item) => TRACK_GROUPS[String(item?.track || "").toLowerCase()] === group);
  if (!rows.length) return null;
  const timed = rows.map((item) => finiteMinutes(item.durationMinutes)).filter((value) => value != null);
  const scored = rows.filter((item) => item.correct != null && item.total != null);
  const first = rows[0];
  return {
    at: first.at || "",
    sameDay: true,
    durationMinutes: timed.length ? Math.round(timed.reduce((sum, value) => sum + value, 0) * 10) / 10 : null,
    sessionCount: rows.length,
    correct: scored.length ? scored.reduce((sum, item) => sum + Number(item.correct), 0) : null,
    total: scored.length ? scored.reduce((sum, item) => sum + Number(item.total), 0) : null,
    label: `${first.level || "N2"} ${TRACK_LABELS[first.track] || first.track || "练习"}`,
  };
}

export function buildJapaneseTodayStudy({ date = tokyoTodayKey(), oralSessions = [], ankiActivity = null, examSessions = [] } = {}) {
  const todayOral = oralSessions.filter((item) => item?.date === date);
  const oralMinutes = todayOral.reduce((sum, item) => sum + (Number(item.durationMinutes) || 0), 0);
  const todayExams = examSessions.filter((item) => String(item?.at || "").startsWith(date));
  const special = summarizeSessions(todayExams, "special");
  const reading = summarizeSessions(todayExams, "reading");
  const exam = summarizeSessions(todayExams, "exam");
  const ankiMatchesToday = ankiActivity?.available && ankiActivity.day === date;
  const ankiMinutes = ankiMatchesToday ? finiteMinutes(ankiActivity.durationMinutes) : null;
  const activityMinutes = [special, reading, exam].reduce((sum, item) => sum + (item?.durationMinutes || 0), 0);
  const totalDurationMinutes = Math.round((oralMinutes + (ankiMinutes || 0) + activityMinutes) * 10) / 10;
  return {
    date,
    totalDurationMinutes,
    oral: {
      durationMinutes: oralMinutes,
      sessionCount: todayOral.length,
      estimated: todayOral.some((item) => item.estimated),
    },
    anki: {
      durationMinutes: ankiMinutes,
      reviewCount: ankiMatchesToday ? Number(ankiActivity.reviewCount) || 0 : null,
      source: ankiMatchesToday ? (ankiActivity.source === "snapshot" ? "snapshot" : "live") : "none",
    },
    special,
    reading,
    exam,
  };
}

export function hasJapaneseStudyActivity(summary) {
  return Boolean(
    summary
    && (summary.oral.sessionCount > 0
      || (summary.anki.reviewCount || 0) > 0
      || (summary.special?.sessionCount || 0) > 0
      || (summary.reading?.sessionCount || 0) > 0
      || (summary.exam?.sessionCount || 0) > 0),
  );
}
