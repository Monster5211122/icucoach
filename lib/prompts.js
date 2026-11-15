// AI 教练的系统提示与任务提示（中文）

const COACH_SYSTEM = `你是一位专业的自行车骑行教练，精通功率训练、心率训练与 Intervals.icu 的训练负荷模型（CTL/ATL/Form、TSS、Readiness）。
你的服务对象是业余骑行爱好者。你的表达：
- 简洁、直接、口语化，像一位靠谱的私教；
- 用数字说话，给出明确可执行的建议；
- 区分“事实”（来自数据）与“推断”（你的判断）；
- 训练建议要贴合对方的生活约束（时间碎片化、需照顾家庭）。

判断原则（参考）：
- 训练负荷看绝对值（Form = CTL − ATL）：-10~-30 为正常训练区，<-30 危险，>+20 可加量；CTL 周增幅不超过 8% 为安全。
- 稳态课的 VI 应在 1.00-1.05；EF（NP÷平均心率）是衡量有氧进步的可靠趋势指标。
- 判断“今天能不能练”优先看恢复数据（HRV/静息心率/睡眠）与体感，Form 只作参考。
- 连续空窗超过 2 天要重点提醒：宁可 30 分钟 Z2 也别断练。`;

// 课表回写的 JSON 契约（自定义提示词模式下强制附加，保证能写回 ICU）
const JSON_CONTRACT = `\n\n【输出格式要求（必须遵守）】
你只输出一个 JSON 对象，不要输出任何其它文字，结构如下：
{
  "summary": "一句话说明课表的整体思路",
  "workouts": [
    {
      "name": "课表名，如“阈值 2x20”",
      "type": "Ride 或 Rest",
      "start_date_local": "YYYY-MM-DDT00:00:00",
      "description": "ICU 原生 workout 文本，例如：- 15m 55% 85-95rpm\\nMain set 2x\\n- 20m 95%\\n- 5m 50%\\n- 10m 60%（Rest 时留空字符串）",
      "moving_time": 预计总秒数（整数，Rest 为 0）
    }
  ]
}`;

function fmtActivity(a) {
  const np = a.icu_normalized_power ?? a.avg_power ?? null;
  const avgHr = a.icu_avg_hr ?? a.avg_hr ?? null;
  const avgP = a.avg_power ?? null;
  return {
    name: a.name || a.type || "训练",
    type: a.type || null,
    date: a.start_date_local,
    duration_min: a.moving_time ? Math.round(a.moving_time / 60) : null,
    tss: a.icu_training_load ?? a.tss ?? null,
    intensity: a.icu_intensity ?? null,
    np: np,
    avg_power: avgP,
    avg_hr: avgHr,
    ef: np && avgHr ? Math.round((np / avgHr) * 100) / 100 : null,
    vi: np && avgP ? Math.round((np / avgP) * 100) / 100 : null,
    distance_km: a.icu_distance ? Math.round(a.icu_distance / 10) / 100 : null,
    elevation_m: a.icu_elevation_gain ?? null,
    reviewed:
      typeof a.description === "string" && a.description.includes("[AI复盘已完成]"),
  };
}

// 距上次训练多少天（用于空窗提醒）
function lastActivityDaysAgo(activities) {
  if (!activities || activities.length === 0) return null;
  const dates = activities
    .map((a) => new Date(a.start_date_local).getTime())
    .filter((t) => Number.isFinite(t));
  if (dates.length === 0) return null;
  const last = Math.max(...dates);
  return Math.floor((Date.now() - last) / 86400000);
}

// 生成“当前真实数据”文本块（自定义提示词模式下动态拼接）
function formatDataBlock(ctx, { includeActivities }) {
  const { profile, fitness, wellness } = ctx;
  const f = fitness || {};
  const lines = [
    "【当前真实数据（由系统自动获取，请基于这些数据进行分析）】",
    `FTP: ${profile?.ftp ?? "未知"} W`,
    `体重: ${profile?.weight_kg ?? "未知"} kg`,
    `最大心率: ${profile?.max_hr ?? "未知"} bpm`,
    `CTL(体能): ${f.ctl ?? "—"}`,
    `ATL(疲劳): ${f.atl ?? "—"}`,
    `Form(状态): ${f.form ?? "—"}`,
  ];
  const w = wellness && wellness.length ? wellness[0] : null;
  if (w) {
    lines.push(
      `最近恢复状态: readiness=${w.readiness ?? "—"}%, HRV=${w.hrv ?? "—"}, 静息心率=${w.restingHR ?? "—"} bpm, 睡眠=${w.sleepSecs ? Math.round((w.sleepSecs / 3600) * 10) / 10 + "h" : "—"}, 主观疲劳=${w.fatigue ?? "—"}`
    );
  }
  if (includeActivities) {
    const gap = lastActivityDaysAgo(ctx.activities);
    if (gap !== null) {
      lines.push(
        `距上次训练: ${gap} 天${gap >= 2 ? "（空窗警告：今天不要选休息，宁可短 Z2 也别断练）" : ""}`
      );
    }
    lines.push(`最近训练记录: ${JSON.stringify((ctx.activities || []).map(fmtActivity))}`);
  }
  return lines.join("\n");
}

export function buildAnalyzePrompt(ctx, custom = "") {
  const { focus } = ctx;

  if (custom) {
    return (
      formatDataBlock(ctx, { includeActivities: true }) +
      (focus ? `\n\n【用户想重点关注的问题】\n${focus}` : "") +
      `\n\n请按照你在系统提示词中定义的教练框架与风格，完成本次复盘。`
    );
  }

  // 内置模板
  const { profile, fitness, wellness, activities } = ctx;
  const f = fitness || {};
  const p = {
    ftp: profile?.ftp ?? null,
    weight_kg: profile?.weight_kg ?? null,
    max_hr: profile?.max_hr ?? null,
  };

  const latestWellness = wellness && wellness.length ? wellness[0] : null;
  const w = latestWellness
    ? {
        date: latestWellness.ctime,
        readiness: latestWellness.readiness ?? null,
        hrv: latestWellness.hrv ?? null,
        resting_hr: latestWellness.restingHR ?? null,
        sleep_secs: latestWellness.sleepSecs ?? null,
        fatigue: latestWellness.fatigue ?? null,
        soreness: latestWellness.soreness ?? null,
      }
    : null;

  const acts = (activities || []).map(fmtActivity);
  const gap = lastActivityDaysAgo(activities);

  return `以下是这名骑友当前的数据，请据此做一次训练复盘与状态评估。

【基础数据】
FTP: ${p.ftp ?? "未知"} W
体重: ${p.weight_kg ?? "未知"} kg
最大心率: ${p.max_hr ?? "未知"} bpm

【训练负荷】
CTL(体能): ${f.ctl ?? "—"}
ATL(疲劳): ${f.atl ?? "—"}
Form(状态): ${f.form ?? "—"}

【训练连贯性】
${gap === null ? "（暂无训练记录）" : `距上次训练 ${gap} 天${gap >= 2 ? "——空窗警告：今天不要选休息，宁可短 Z2 也别断练" : ""}`}

【最近恢复状态】
${w ? JSON.stringify(w) : "（暂无 wellness 数据）"}

【最近训练记录】
${JSON.stringify(acts, null, 0)}
（说明：reviewed=true 的活动此前已做过复盘，只需纳入趋势判断，不必展开点评；重点分析 reviewed=false 的活动。）

【用户想重点关注的问题】
${focus || "（无特殊要求，请给常规复盘）"}

请按以下结构输出（Markdown）：
## 状态概览
（一两句话：现在体能/疲劳/状态处于什么位置，趋势如何）

## 关键发现
（3-5 条，每条一句，基于数据；EF/VI 有变化时要点出趋势）

## 风险提示
（如有过度训练、恢复不足、连续高强度、训练空窗等风险，明确指出；没有就说“无明显风险”）

## 接下来 1-2 天的建议
（具体到强度区间与时长，例如“今天建议 Z2 耐力 60-90 分钟，或完全休息”）

## 可以问我的问题
（1-2 个，帮助我进一步了解你的状态）`;
}

export function buildPlanPrompt(ctx, custom = "") {
  const { goal, days, startDate, constraints } = ctx;

  if (custom) {
    const todayNote =
      days === 1
        ? `\n本次是“当天可选课表”模式：只生成 3 节当天可选的课（强度低/中/高各一节，如恢复骑、甜区、阈值，name 带上强度标签），让用户按当天体感选一节，不要安排多天计划。`
        : "";
    return (
      formatDataBlock(ctx, { includeActivities: false }) +
      `\n\n【本次课表需求】\n训练目标: ${goal || "未指定，按提升综合骑行能力安排"}\n天数: ${days} 天\n开始日期: ${startDate}\n生活/训练约束: ${constraints || "时间碎片化，晚间训练为主，单次 60-90 分钟"}` +
      todayNote +
      JSON_CONTRACT
    );
  }

  // 内置模板
  const { profile, fitness } = ctx;
  const f = fitness || {};

  return `请为这名骑友生成一份接下来 ${days} 天的训练课表。

【基础数据】
FTP: ${profile?.ftp ?? "未知"} W
体重: ${profile?.weight_kg ?? "未知"} kg
CTL(体能): ${f.ctl ?? "—"}
ATL(疲劳): ${f.atl ?? "—"}
Form(状态): ${f.form ?? "—"}

【训练目标】
${goal || "（未指定，请按提升综合骑行能力来安排）"}

【生活/训练约束】
${constraints || "时间碎片化，倾向在晚间训练，单次以 60-90 分钟为主"}

【要求】
1. ${
    days === 1
      ? `今天是“当天可选课表”模式：只生成 3 节当天可选的课，强度低/中/高各一节（如恢复骑、甜区、阈值），name 带上强度标签，让用户按当天体感选一节；不要安排多天计划。`
      : `从 ${startDate} 开始连续安排 ${days} 天，休息日也要明确标出（type 用 "Rest"）。`
  }
2. 强度合理递进，参考当前 CTL/ATL/Form，不要过度训练。
3. 每节课的 description 字段必须用 Intervals.icu 原生 workout 文本语法，例如：
   "- 15m 55% 85-95rpm\\nMain set 2x\\n- 20m 95%\\n- 5m 50%\\n- 10m 60%"
   功率用 %FTP 表示（如 60%、95%），时长用 m（分钟）表示，可附加踏频区间。
4. 只输出 JSON，格式如下（不要输出其它任何文字）：
{
  "summary": "一句话说明课表的整体思路",
  "workouts": [
    {
      "name": "课表名，如“阈值 2x20”",
      "type": "Ride 或 Rest",
      "start_date_local": "YYYY-MM-DDT00:00:00",
      "description": "ICU 原生 workout 文本（Rest 时留空字符串）",
      "moving_time": 预计总秒数（整数，Rest 为 0）
    }
  ]
}`;
}

export function coachSystem() {
  return COACH_SYSTEM;
}

// 对话模式的紧凑数据块（只带最近 3 次训练，控制长度）
export function buildChatDataBlock(ctx) {
  const activities = (ctx.activities || []).slice(-3);
  return formatDataBlock({ ...ctx, activities }, { includeActivities: true });
}

// 每日建议（练前小纸条）
export function buildDailyPrompt(ctx, dateStr) {
  return `${buildChatDataBlock(ctx)}

今天是 ${dateStr}。请写一份“今日训练建议”，要求：
- 第一句点明当前状态（Form 与恢复数据）；
- 第二句给出今天练什么：明确强度区间（写具体功率范围）与时长；恢复差或空窗警告时建议休息或短 Z2；
- 最后一句给理由；
- 全文 80-120 字，口语化，像教练贴在训练计划上的小纸条；
- 只输出建议正文本身，不要任何标题、列表或 Markdown 符号。`;
}
