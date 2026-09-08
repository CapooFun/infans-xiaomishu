import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function makeFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "infans-readonly-test-"));
  const vaultRoot = path.join(base, "vault");
  const stateDirectory = path.join(base, "state");
  const outside = path.join(base, "outside.txt");
  await fs.mkdir(path.join(vaultRoot, "30_事业顺利", "游戏开发"), { recursive: true });
  const domains = [
    ["游戏", "游戏文化研究_总览.md", "# 游戏\n\n## 七条领域主干\n\n1. 游戏史、文化与批评\n2. 玩家、社群与身份\n"],
    ["人工智能", "人工智能_总览.md", "# 人工智能\n\n## 领域主干\n\n1. AI 历史、范式与数理基础\n2. 搜索、规划与优化\n"],
    ["经济与金融", "经济与金融_总览.md", "# 经济与金融\n\n## 十六条领域主干\n\n1. 微观经济学\n2. 宏观经济学\n"],
    ["语言研究", "语言研究_总览.md", "# 语言研究\n\n## 领域主干\n\n1. 语言学共同基础\n2. 语言史、类型与比较\n"],
    ["思想史", "思想史_总览.md", "# 思想史\n\n## 目前关注\n\n### 哲学史\n\n### 神学史\n"],
    ["资治通鉴", "资治通鉴_总览.md", "# 资治通鉴\n\n## 纵向课程主轴\n\n- [[熊逸讲透_01季|第一季]]：001–250 讲\n"],
    ["形象管理", "形象管理_总览.md", "# 形象管理\n\n## 这里是什么\n\n- **个人形象档案**：尺码、肤色、发质与体态。\n- **化妆**：自然日常妆。\n"],
    ["运动健身", "运动健身_总览.md", "# 运动健身\n\n## 领域主干\n\n1. 解剖、生理与运动适应\n2. 力量、肌肥大与爆发力\n"],
  ];
  await fs.mkdir(path.join(vaultRoot, "70_领域研究", "10_方法"), { recursive: true });
  for (const [directory, fileName, content] of domains) {
    await fs.mkdir(path.join(vaultRoot, "70_领域研究", directory, "学习记录"), { recursive: true });
    await fs.writeFile(path.join(vaultRoot, "70_领域研究", directory, fileName), content, "utf8");
  }
  await fs.mkdir(path.join(vaultRoot, "70_领域研究", "人工智能", "知识节点"), { recursive: true });
  await fs.mkdir(path.join(vaultRoot, ".git"), { recursive: true });
  await fs.mkdir(path.join(vaultRoot, ".claude"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "首页.md"), "# 首页\n今天继续推进阳台种植计划。\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "30_事业顺利", "游戏开发", "项目.md"), "当前目标：完成云存档验收。\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "70_领域研究", "10_方法", "GPT_Live知识地图学习交接包.md"), "# 学习协议\n先定位唯一 nodeId，不自行生成课程路线。教学方法灵活选用，不机械补齐。\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "70_领域研究", "10_方法", "知识节点可信度与学习进度规范.md"), "# 可信度规范\n学习状态与正文状态分开。\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "70_领域研究", "人工智能", "知识节点", "人工智能知识节点_完整框架.md"), "---\ntype: domain-knowledge-catalog\ndomainId: ai\n---\n# 人工智能\n\n| branchId | topicId | nodeId | order | 节点标题 | 单次认知任务 |\n|---|---|---|---:|---|---|\n| ai-learning-generative | ai-representation | ai-representation-tokenization | 10 | Token 化怎样改变输入长度与边界 | 用中英文切分案例说明离散表示。 |\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "70_领域研究", "人工智能", "人工智能知识地图_内容状态台账.md"), "# AI 状态\n正文待补。\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "70_领域研究", "人工智能", "学习记录", "2026-08-27_Token.md"), "---\ntype: domain-learning-record\ndomainId: ai\nnodeId: ai-representation-tokenization\nrecordId: learn-20260827-token-test\nlearningState: session-recorded\ndate: 2026-08-27\n---\n# Token 化·第一次学习记录\n\n## 下一次从哪里继续\n\n- 用中英文短句实际走一次切分。\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, ".git", "secret"), "old-token", "utf8");
  await fs.writeFile(path.join(vaultRoot, ".claude", "history.json"), "private-history", "utf8");
  await fs.writeFile(path.join(vaultRoot, ".env"), "SECRET=value", "utf8");
  await fs.writeFile(outside, "outside-secret", "utf8");
  await fs.symlink(outside, path.join(vaultRoot, "outside-link.txt"));
  return {
    base,
    vaultRoot,
    stateDirectory,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

export async function writeMinimalPdf(filePath, text = "Vault PDF marker") {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text.replace(/[()\\]/g, "\\$&")}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  await fs.writeFile(filePath, pdf, "binary");
}
