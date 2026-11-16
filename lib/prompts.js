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
- 连续空窗超过 2 天要重点提醒：宁可 30 分钟 Z2 也别断练。

铁律（必须遵守）：
- 只引用给定的真实数据，禁止编造数字、功率、心率或成绩；数据缺失就直说“这项数据没有”。
- 每次分析都要有针对性：指出当前最该练的 1-2 项能力，并给出对应课型。常见对应：
  后程掉功率/长间歇塌陷 → 有氧耐力底（长 Z2 时间）；
  VI 偏高(>1.1)或功率忽高忽低 → 功率稳定输出（固定功率节奏课）；
  EF 长期不涨或偏低 → 有氧效率（低强度大量 + 节奏课）；
  FTP 测试后半段崩 → 阈值耐力（2×20 阈值、SST）；
  W' 耗尽/短冲刺后恢复慢 → 重复冲刺与神经肌肉能力；
  心率漂移大(decoupling>5%) → 有氧底不够，别急着上强度。
- 语气像真人教练：先给结论，再用数据解释为什么，最后说“下一步练什么”；可以指出进步或问题，像私教聊天，禁止套模板空话。`;

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
  // 列表接口不含功率/心率明细，只存在于详情接口（已在调用方合并进来）
  const np = a.icu_weighted_avg_watts ?? a.icu_normalized_power ?? null;
  const avgP = a.icu_average_watts ?? a.avg_power ?? null;
  const avgHr = a.average_heartrate ?? a.icu_avg_hr ?? a.avg_hr ?? null;
  return {
    name: a.name || a.type || "训练",
    type: a.type || null,
    date: a.start_date_local,
    duration_min: a.moving_time ? Math.round(a.moving_time / 60) : null,
    tss: a.icu_training_load ?? a.tss ?? null,
    intensity: a.icu_intensity ?? null,
    np,
    avg_power: avgP,
    avg_hr: avgHr,
    max_hr: a.max_heartrate ?? null,
    ef: a.icu_efficiency_factor ?? (np && avgHr ? Math.round((np / avgHr) * 100) / 100 : null),
    vi: a.icu_variability_index ?? (np && avgP ? Math.round((np / avgP) * 100) / 100 : null),
    decoupling: a.decoupling ?? null,
    wbal_depletion: a.icu_max_wbal_depletion ?? null,
    ftp_model: a.icu_pm_ftp_watts ?? a.icu_pm_ftp ?? a.icu_rolling_ftp ?? null,
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
    `FTP: ${profile?.ftp ?? "未知"} W（室内 ${profile?.indoor_ftp ?? "未知"} W）`,
    `体重: ${profile?.weight_kg ?? "未知"} kg`,
    `最大心率: ${profile?.max_hr ?? "未知"} bpm, LTHR: ${profile?.lthr ?? "未知"} bpm`,
    `W'(无氧储备): ${profile?.w_prime ?? "未知"} J, 峰值功率: ${profile?.p_max ?? "未知"} W`,
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
  const b = ctx.baseline;
  if (b && (b.hrv_30d != null || b.rhr_30d != null)) {
    lines.push(
      `恢复基线(历史均值): HRV近30天=${b.hrv_30d ?? "—"}、近7天=${b.hrv_7d ?? "—"}; 静息心率近30天=${b.rhr_30d ?? "—"} bpm、近7天=${b.rhr_7d ?? "—"}; 近7天平均睡眠=${b.sleep_7d != null ? Math.round(b.sleep_7d * 10) / 10 + "h" : "—"}`
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
  const { profile, fitness, wellness, activities, baseline } = ctx;
  const f = fitness || {};
  const p = {
    ftp: profile?.ftp ?? null,
    indoor_ftp: profile?.indoor_ftp ?? null,
    weight_kg: profile?.weight_kg ?? null,
    max_hr: profile?.max_hr ?? null,
    lthr: profile?.lthr ?? null,
    w_prime: profile?.w_prime ?? null,
    p_max: profile?.p_max ?? null,
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
FTP: ${p.ftp ?? "未知"} W（室内 ${p.indoor_ftp ?? "未知"} W）
体重: ${p.weight_kg ?? "未知"} kg
最大心率: ${p.max_hr ?? "未知"} bpm
LTHR: ${p.lthr ?? "未知"} bpm
W'(无氧储备): ${p.w_prime ?? "未知"} J
峰值功率: ${p.p_max ?? "未知"} W

【训练负荷】
CTL(体能): ${f.ctl ?? "—"}
ATL(疲劳): ${f.atl ?? "—"}
Form(状态): ${f.form ?? "—"}

【训练连贯性】
${gap === null ? "（暂无训练记录）" : `距上次训练 ${gap} 天${gap >= 2 ? "——空窗警告：今天不要选休息，宁可短 Z2 也别断练" : ""}`}

【最近恢复状态】
${w ? JSON.stringify(w) : "（暂无 wellness 数据）"}
${baseline && (baseline.hrv_30d != null || baseline.rhr_30d != null)
    ? `恢复基线(历史均值): HRV近30天=${baseline.hrv_30d ?? "—"}、近7天=${baseline.hrv_7d ?? "—"}; 静息心率近30天=${baseline.rhr_30d ?? "—"} bpm、近7天=${baseline.rhr_7d ?? "—"}; 近7天平均睡眠=${baseline.sleep_7d != null ? Math.round(baseline.sleep_7d * 10) / 10 + "h" : "—"}`
    : "恢复基线: （暂无历史数据，只有当晚值——注意：一晚的 HRV/静息心率不能当基线判断异常，需看趋势）"}

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

## 针对性训练方向
（基于最近训练暴露的具体短板，指出当前最该练的 1-2 项能力 + 对应课型，1-2 行；没有明显短板就说明当前课表合理，不要硬凑）

## 接下来 1-2 天的建议
（具体到强度区间与时长，例如“今天建议 Z2 耐力 60-90 分钟，或完全休息”）

## 可以问我的问题
（1-2 个，帮助我进一步了解你的状态）`;
}

export function buildPlanPrompt(ctx, custom = "") {
  const { goal, days, startDate, constraints } = ctx;
  const mode = ctx.mode === "outdoor" ? "outdoor" : "indoor";
  const sceneNote =
    mode === "outdoor"
      ? `\n训练场景: 路骑（户外）。description 按路骑写，如“- 10m 55% 热身\n- 3x10m 90% 平路或缓坡\n- 组间 5m 50% 放松”；课名带上“路骑”标签；附安全提示（照明/交通/下坡控制）；功率仍用 %FTP，间歇段优先找平路或缓坡。`
      : `\n训练场景: 骑行台（室内）。description 按骑行台写，如“- 10m 55% 90rpm\n- 3x10m 90% 85-95rpm\n- 组间 5m 50% 放松”；课名带上“骑行台”标签；可注明可开 ERG 模式；功率用 %FTP 并附踏频区间。`;

  if (custom) {
    const todayNote =
      days === 1
        ? `\n本次是“当天可选课表”模式：只生成 3 节当天可选的课（强度低/中/高各一节，如恢复骑、甜区、阈值，name 带上强度标签），让用户按当天体感选一节，不要安排多天计划。`
        : "";
    return (
      formatDataBlock(ctx, { includeActivities: false }) +
      `\n\n【本次课表需求】\n训练目标: ${goal || "未指定，按提升综合骑行能力安排"}\n天数: ${days} 天\n开始日期: ${startDate}\n生活/训练约束: ${constraints || "时间碎片化，晚间训练为主，单次 60-90 分钟"}` +
      sceneNote +
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
${sceneNote}

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

// 训练科学知识卡：蒸馏自开源知识库「人类耐力变强计划」（human-upgrade-plan，作者张张的鞋），骑行向改编
const TRAINING_SCIENCE_CARD = `
【训练科学知识卡（蒸馏自开源知识库「人类耐力变强计划」human-upgrade-plan，骑行向改编；原则面向业余爱好者，非医疗建议）】
- 适应来自可重复完成，不是单次狠。一周只安排一个主刺激（一次质量课），其余服务恢复；下周只改一个变量。完成率、次日还能骑、关键课输出不散，比“感觉练到了”重要。漏课重排，不堆周末，不用更多高强度课“补偿”。
- 睡眠是适应开关。连续睡眠差 → 取消质量课，不靠咖啡硬上。精神疲劳会抬高 RPE：下班/带娃后先骑 5-10 分钟轻松活动再决定是否上强度。
- 开课闸门（生病）：发烧/发冷/胸闷/静息心悸/全身酸痛/喘气比平时难 → 停课。只有轻微鼻塞等，先短时间轻松试探，当天不上质量课。病后按空窗接训：停 3-7 天先轻松 1-2 次再给短版质量课（量砍约 1/3），不接病前功率；停 2 周以上当基础重建。
- 空气质量看 PM2.5（μg/m³），不抄“AQI 数字”（中国与美国 AQI 口径不同）：<35 正常；35-75 质量课改室内或砍成轻松；75-115 不上室外高强度；>115 取消室外。高强度长时间吸入剂量更大。
- HRV/恢复分用法：一晚偏低不自动砍课（可能是昨天质量课的拖尾）；连续 2 天明显偏低且主观也差才降档。表显示恢复很好但人发烧/疼痛 → 听症状。
- 间歇组间休息是处方变量，不是越短越狠：练有氧功率（长段 2-5 分钟以上）组间歇约工作段的 1/2 到等时；练短冲/速度要接近完全恢复；阈值段间短轻松即可。下一趟明显掉功率或 RPE 失控 → 加歇或减组，禁止缩短休息硬撑。业余爱好者组间可加 30-60 秒保质量。
- 阈值强度锚：无血乳酸仪时用“能说话短句”、RPE 6-7/10 控强度，不假装测到了乳酸。入门/回归/训练不稳定：每周至多 1 次单阈值（如 3-5×6-8 分钟，组间轻松 2-3 分钟）；双阈值日只给进阶，且默认从两个分开的阈值日开始，不默认同一天早晚两次。
- 天气与体感：温度越高，强度目标越要保守（速度慢的人受影响更大）。冷天热身拉长、强度下调一档；热天热身缩短，组间多休息。热天口渴就喝，禁止灌到体重上涨；咖啡因只用于质量课和比赛（约 3-6 mg/kg、提前约 60 分钟），且必须先在训练里试过。
- 恢复与生活：恢复骑/轻松骑也是负荷，不是休息。训练会挤压睡眠或进食时，先保睡眠和吃饭。伤停期间低冲击骑行可保有氧，回归后重新渐进负荷。
- 给建议时：先给“今天做还是不做”的判断（带取消条件），再给可执行剂量；说明理由分两层——生理原理一句 + 文献依据一句，并诚实说明外推边界；信息不足就给条件分支，不编造数据。`;

export function coachSystem() {
  return COACH_SYSTEM + TRAINING_SCIENCE_CARD;
}

// 对话模式的紧凑数据块（只带最近 3 次训练，控制长度）
export function buildChatDataBlock(ctx) {
  // ICU 的 activities 是“最新在前”返回；这里统一按日期倒序，取最近 3 条
  const activities = (ctx.activities || [])
    .slice()
    .sort(
      (a, b) =>
        new Date(b.start_date_local).getTime() - new Date(a.start_date_local).getTime()
    )
    .slice(0, 3);
  return formatDataBlock({ ...ctx, activities }, { includeActivities: true });
}

// 每日建议（练前小纸条）
export function buildDailyPrompt(ctx, dateStr) {
  return `${buildChatDataBlock(ctx)}

今天是 ${dateStr}。请写一份“今日训练建议”，要求：
- 第一句点明当前状态（必须引用上方给定的真实数字：Form、CTL/ATL、HRV 与基线、静息心率、睡眠）；
- 第二句给出今天练什么：明确强度区间（写具体功率范围，用 %FTP 换算，不要凭空写瓦数）与时长；恢复差或空窗警告时建议休息或短 Z2；
- 结合最近训练暴露的具体短板给针对性内容（例如 FTP 测试后程掉功率就安排阈值耐力，不要每次都只说 Z2）；
- 最后一句给理由；
- 全文 80-140 字，口语化，像真人教练贴在训练计划上的小纸条，有温度；
- 只输出建议正文本身，不要任何标题、列表或 Markdown 符号；
- 禁止编造数据：所有数字都必须来自上方给定的真实数据。`;
}
