function clean(value = "") {
  return String(value)
    .replace(/\*\*|__|`/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function groupTitle(value = "") {
  return clean(value).replace(/^[一二三四五六七八九十百]+[、.．]\s*/, "");
}

function oralStatus(value = "") {
  if (value.includes("后续复测仍稳定") || value.includes("稳定使用")) return ["stable", "可稳定使用"];
  if (value.includes("无提示") || value.includes("独立")) return ["independent", "可独立使用"];
  if (value.includes("提示后")) return ["prompted", "提示后可用"];
  return ["not-practiced", "未练习"];
}

export function parseGrammarChecklist(markdown, level) {
  const groups = [];
  let group = null;
  let point = null;

  const finishPoint = () => {
    if (!point || !group) return;
    group.points.push(point);
    point = null;
  };
  const finishGroup = () => {
    finishPoint();
    if (group?.points.length) groups.push(group);
    group = null;
  };

  for (const rawLine of String(markdown ?? "").split(/\r?\n/)) {
    const heading = rawLine.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      finishGroup();
      group = { id: `${level}-${groups.length + 1}`, title: groupTitle(heading[1]), note: "", points: [] };
      continue;
    }

    const pointHeading = rawLine.match(/^\*\*(N[2-5]-\d+)\s+(.+?)\*\*\s*[　 ]*｜掌握度\s*(\d)｜复习\s*([^\n]+)$/);
    if (pointHeading && group) {
      finishPoint();
      point = {
        id: pointHeading[1],
        title: clean(pointHeading[2]),
        mastery: Number(pointHeading[3]),
        review: clean(pointHeading[4]),
        connection: "",
        meaning: "",
        examples: [],
        distinctions: [],
        notes: [],
        oral: undefined,
      };
      continue;
    }

    const quote = rawLine.match(/^>\s*(.+)$/);
    if (quote && group && !point) {
      group.note = [group.note, clean(quote[1])].filter(Boolean).join(" ");
      continue;
    }

    const field = rawLine.match(/^\s*-\s*(接续|含义|例|辨析|备注)：\s*(.*)$/);
    const personal = rawLine.match(/^\s{2,}-\s*(最近口语证据|可观察表现|个性化模式|下次复习)：\s*(.*)$/);
    if (personal && point) {
      const value = clean(personal[2]);
      point.oral ||= { status: "not-practiced", label: "未练习", evidence: "", note: "", nextReview: "" };
      if (personal[1] === "最近口语证据") {
        const [status, label] = oralStatus(value);
        point.oral.status = status;
        point.oral.label = label;
        point.oral.evidence = value;
      } else if (personal[1] === "下次复习") {
        point.oral.nextReview = value;
      } else {
        point.oral.note = [point.oral.note, `${personal[1]}：${value}`].filter(Boolean).join("；");
      }
      continue;
    }
    if (!field || !point) continue;
    const value = clean(field[2]);
    if (!value) continue;
    if (field[1] === "接续") point.connection = value;
    else if (field[1] === "含义") point.meaning = value;
    else if (field[1] === "例") point.examples.push(value);
    else if (field[1] === "辨析") point.distinctions.push(value);
    else point.notes.push(value);
  }
  finishGroup();

  const points = groups.flatMap((item) => item.points);
  return {
    level,
    total: points.length,
    diagnosed: points.filter((item) => item.mastery > 0).length,
    mastered: points.filter((item) => item.mastery >= 3).length,
    groups,
  };
}
