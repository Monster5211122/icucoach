import { createIcuClient } from "../lib/icu.js";
import { chatCompletionRaw, chatCompletionStream, llmEnv, withAutoThinking, extractDsmlCalls, stripDsml, createDsmlStripper } from "../lib/llm.js";
import { coachSystem, buildChatDataBlock } from "../lib/prompts.js";
import { summarizeActivity, buildDeepContext, markReviewed } from "../lib/review.js";
import { appendMemory, memoryContext } from "../lib/memory.js";
import { authError } from "../lib/auth.js";
import { trainingHistory } from "../lib/history.js";
import { workoutTextFromSteps } from "../lib/workout-text.js";

// ICU Key / 运动员 ID：优先取页面「设置」里带过来的请求头，兜底用服务器环境变量
function getEnv(req) {
  const apiKey = req.headers["x-icu-api-key"] || process.env.ICU_API_KEY;
  if (!apiKey) {
    return {
      error: "未配置 ICU API Key：请在 App「设置」页填写，或在 Vercel 环境变量里配置 ICU_API_KEY",
      status: 400,
    };
  }
  return {
    apiKey,
    athleteId: req.headers["x-icu-athlete-id"] || process.env.ICU_ATHLETE_ID,
  };
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// 教练可用工具：查活动列表 / 拉单课深度数据 / 标记已复盘
const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_activities",
      description:
        "列出最近 N 天的骑行活动（含活动 ID 与是否已复盘）。用户要求复盘时先调用它找出未复盘的活动。",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", description: "回看天数，默认 14，最大 30" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_activity_detail",
      description:
        "获取某次活动的深度数据（自动分段、NP/VI/EF、心率、心率漂移、HRRc 等），用于单课深度复盘。",
      parameters: {
        type: "object",
        properties: {
          activity_id: { type: "integer", description: "活动 ID（来自 list_activities）" },
        },
        required: ["activity_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_reviewed",
      description:
        "复盘完成后，把该活动标记为「AI复盘已完成」（写入活动 description，避免下次重复复盘）。",
      parameters: {
        type: "object",
        properties: {
          activity_id: { type: "integer", description: "活动 ID" },
        },
        required: ["activity_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_workout",
      description:
        "把一节课写入 Intervals.icu 日历（结构化课表，会同步到码表）。只在用户明确要求时调用，例如“把今天这节课写进 ICU”“帮我写一节甜区课”。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "课表名，如“阈值 2x20”" },
          type: {
            type: "string",
            enum: ["Ride", "Rest"],
            description: "Ride=骑行课，Rest=休息日",
          },
          start_date_local: { type: "string", description: "日期，格式 YYYY-MM-DD（只写日期，不要带时间）" },
          description: {
            type: "string",
            description:
              "ICU 原生 workout 文本，必须每段一行，如：- 12m ramp 55-70%\\n- 20m 90%\\n- 5m 55%\\n- 20m 90%\\n- 13m 50%。只放结构化行（可带「# 段名」），不要写中文散文、不要加来源/说明；散文会被拒绝写入。",
          },
          steps: {
            type: "array",
            description: "也可以用分段数组代替 description；两者都有时优先 description 里带结构化行",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "段名，如 Warm-up / Sweet Spot 1 / Recovery" },
                minutes: { type: "integer", description: "该段分钟数" },
                pct: { type: "array", items: { type: "number" }, description: "强度 %FTP，单值写 [90,90]，递进写 [55,70]" },
                cad: { type: "integer", description: "该段目标踏频 rpm，如 88" },
              },
              required: ["label", "minutes", "pct"],
            },
          },
          moving_time: { type: "integer", description: "预计总秒数，可选" },
        },
        required: ["name", "type", "start_date_local"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_workouts",
      description:
        "一次把多节课（最多 7 节）写入 Intervals.icu 日历。用户说“排这周课表”“给我排三天”并确认要写进日历时调用；先按真实数据排好再写，不要写他练不了的天数。",
      parameters: {
        type: "object",
        properties: {
          workouts: {
            type: "array",
            description: "要写入的课，按日期从早到晚",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "课表名，如“阈值 2x20”" },
                type: { type: "string", enum: ["Ride", "Rest"] },
                start_date_local: { type: "string", description: "日期 YYYY-MM-DD" },
                description: {
                  type: "string",
                  description: "ICU 原生 workout 文本，如：- 12m 55% 85-95rpm\nMain set 2x\n- 20m 93%\n- 5m 50%",
                },
                moving_time: { type: "integer", description: "预计总秒数" },
              },
              required: ["name", "type", "start_date_local"],
            },
          },
        },
        required: ["workouts"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "把一条值得长期记住的要点写入教练记忆（用户特征、训练偏好、重要结论、伤病情况等）。只有真正值得长期记住时才调用，日常闲聊不要记。",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "一条要点，20-100 字，不要带日期（系统会自动加日期）",
          },
        },
        required: ["text"],
      },
    },
  },
];

const TOOL_INSTRUCTIONS = `\n\n【工具使用规则】
你拥有五个工具，只在必要时调用（闲聊或一般咨询不要调用）：
- 用户要求复盘某次/某段时间的训练时：先调用 list_activities 找出还没有复盘标记的活动；
- 用 get_activity_detail 拉取该活动的深度数据，再给出复盘；复盘必须按返回的 intervals **逐段**列（段号/类型/起止分钟/时长/平均功率与 NP/%FTP/心率区间/踏频/漂移），不许合并成"整体稳定""前后半程"这类概括；只有 intervals 为空才退回前后半程对比，并写明"本次没有分段数据"；
- 每复盘完一个活动，调用 mark_reviewed 准备标记，并在回复末尾说明「已准备好标记，点下面的“确认写入 ICU”才会写回」；**绝不能说“已写入/已标记”**，因为工具只做暂存；
- 用户问“今天怎么练/今天练什么”时，不要只说方向：按「判决（练/降档练/不练）→ 今天这一节（热身/主段/组间/放松，每段写确切分钟数、瓦数区间、踏频）→ 体感校准（RPE 与心率红线）→ 降一档 → 停的条件 → 为什么」给，读完他能直接上台骑。
- 用户说“排这周课表/给我排几天”时：先把每天的课排好（按上面的时段、时长、强度两端分化、灰区占比规则），再调用 create_workouts 准备批量写入（同样要等用户点确认）；不要预排他练不了的天数，每周至少留 1-2 天恢复或休息。
- 用户明确要求写课表（如“把今天这节课写进 ICU”“帮我写一节甜区课”）时，调用 create_workout 准备课表：description 必须写成 ICU 结构化文本，**一段一行**（形如「- 12m ramp 55-70%」「- 20m 90%」），或直接给 steps 数组；**中文字数再详细也不会生成结构**。复述课表内容和日期，并说明「等你点下面的‘确认写入 ICU’按钮才会写进日历」；**禁止说已写入**；
- **写入要短**：用户说“写入/写进日历/把刚才那节写进去”时，只回复一句（如“已准备好，点下面确认写入”）；确认成功后只需「日期 + 课名 + TSS + 是否回读确认」一行，禁止再复述课表结构、禁止解释过程、禁止列理由。
- 工具参数只许用 schema 里有的字段名；不要自创字段，也不要把调用写成文本标签（任何「<| | DSML | | ...>」形式的输出都会被当作无效内容剔除）。
- 遇到值得长期记住的用户特征、训练偏好、重要结论或伤病情况时，调用 remember 写入教练记忆；同样的内容不要重复记；
- 用户说出任何**训练约束**时必须 remember 一条（这类信息会进入课表与每日建议，不记就等于下次又要他重复一遍）：可用时段（如"白天午睡 13:00-15:30、晚上 21:30 后"）、单次时长上限、哪几天完全没空、身体问题（坐垫疼/膝痛/腰紧）、装备条件（没穿骑行裤、只有骑行台）、睡眠与工作安排；
- 已标记（reviewed=true）的活动可以略过或只用于趋势对比，重点复盘未标记的。`;


// 工具调用阶段：只跑“取数据”的轮次，最多 2 轮，且用低思考档位省时间
// 返回 { msgs, answered }：answered 有值说明模型没调工具、已经直接答完了
async function toolPhase(messages, tools, executor, env, maxRounds = 2) {
  const msgs = [...messages];
  for (let round = 0; round < maxRounds; round++) {
    const msg = await chatCompletionRaw(msgs, env, { tools });
    // 有的模型把工具调用写成 DSML 标记文本：解析出来照常执行，并把标记从正文剔掉
    const dsml = extractDsmlCalls(msg.content || "");
    if ((!msg.tool_calls || msg.tool_calls.length === 0) && dsml.calls.length) {
      msg.tool_calls = dsml.calls.map((c, i) => ({
        id: `dsml_${round}_${i}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
      }));
      msg.content = dsml.text;
    } else if (/DSML/.test(msg.content || "")) {
      msg.content = dsml.text;
    }
    msgs.push(msg);
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { msgs, answered: stripDsml(msg.content || "") };
    }
    for (const tc of msg.tool_calls) {
      let result;
      try {
        const args = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        result = await executor(tc.function.name, args);
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { msgs, answered: "" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "仅支持 POST" });
  }

  const authErr = authError(req);
  if (authErr) return res.status(authErr.status).json({ ok: false, error: authErr.error });

  const cfg = getEnv(req);
  if (cfg.error) return res.status(cfg.status).json({ ok: false, error: cfg.error });

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: "messages 不能为空" });
  }

  // 未来 7 天日历摘要：教练排课时必须先看这里，已有的课不重复加
  function calendarLine(evs) {
    if (!Array.isArray(evs) || !evs.length) return "";
    return evs
      .filter((e) => e && e.start_date_local)
      .sort((a, b) => String(a.start_date_local).localeCompare(String(b.start_date_local)))
      .slice(0, 10)
      .map((e) => `${String(e.start_date_local).slice(0, 10)} ${e.name || e.category || "训练"}`)
      .join("\n");
  }

  // 只保留最近 20 条合法消息，防止超长
  const history = messages
    .filter(
      (m) =>
        m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  const icu = createIcuClient(cfg.apiKey, cfg.athleteId);

  // 记忆保留天数：页面设置 > 服务器环境变量 > 默认 48 天
  const retention = Math.max(
    1,
    Math.min(
      365,
      Number(
        req.headers["x-memory-days"] ||
          (req.body && req.body.memoryDays) ||
          process.env.MEMORY_DAYS ||
          48
      )
    )
  );

  // 工具执行器（闭包持有 icu 客户端）
  const staged = []; // 本次对话里等用户点「确认写入」的动作
async function executeTool(name, args) {
    if (name === "list_activities") {
      const days = Math.min(30, Math.max(1, Number(args.days) || 14));
      const acts = await icu.activities({ oldest: daysAgo(days) });
      const rides = acts.filter((a) => /ride/i.test(a.type || ""));
      return {
        count: rides.length,
        activities: rides.slice(0, 15).map(summarizeActivity),
      };
    }
    if (name === "get_activity_detail") {
      // id 保持原样（如 i209987472），icu.js 会自动补 i 前缀；转成纯数字会 404
      const id = String(args.activity_id ?? "").trim();
      const [a, iv] = await Promise.all([
        icu.activity(id),
        icu.activityIntervals(id).catch(() => null),
      ]);
      // 详情接口不带分段，必须单独拉区间，否则复盘只能给整课数字
      if (iv && Array.isArray(iv.icu_intervals) && iv.icu_intervals.length) {
        a.icu_intervals = iv.icu_intervals;
      }
      let streams = null;
      try {
        streams = await icu.activityStreams(id);
      } catch { /* 流数据可选，拿不到就算了 */ }
      return buildDeepContext(a, streams);
    }
    if (name === "mark_reviewed") {
      const id = String(args.activity_id ?? "").trim();
      const a = await icu.activity(id).catch(() => null);
      staged.push({
        kind: "mark_reviewed",
        activity_id: Number(id) || id,
        source: "教练对话",
        label: `标记「${a?.name || id}」为已复盘`,
      });
      return {
        ok: true,
        staged: true,
        message: "已准备好写入标记，但**还没有写入**。请在回复里明确告诉用户：需要他点「确认写入 ICU」按钮才会落库。",
      };
    }
    if (name === "create_workout") {
      const date = String(args.start_date_local || args.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("日期格式不对，应为 YYYY-MM-DD（模型给的是：" + (args.start_date_local || args.date || "空") + "）");
      }
      let description = typeof args.description === "string" ? args.description.trim() : "";
      // 只有散文没有 "- 12m 90%" 这类结构化行时，用 steps 生成，否则 ICU 只当备注、不会生成结构
      if (!/\d+\s*m\s+\d/.test(description)) {
        const built = workoutTextFromSteps(args.steps);
        if (built) description = built;
      }
      if (!description) throw new Error("课表缺少结构化内容：请提供 description（ICU 文本）或 steps");
      const workout = {
        name: String(args.name || "训练课").slice(0, 120),
        type: args.type === "Rest" ? "Rest" : "Ride",
        start_date_local: date + "T00:00:00",
        description,
        moving_time: Number.isFinite(Number(args.moving_time)) ? Number(args.moving_time) : null,
      };
      staged.push({ kind: "workouts", workouts: [workout], source: "教练对话", label: `写入 1 节课：${workout.name}（${date}）` });
      return {
        ok: true,
        staged: true,
        message: "课表已准备好，但**还没有写入 ICU**。请告诉用户：需要他点下面的「确认写入 ICU」按钮才会写进日历。",
      };
    }
    if (name === "create_workouts") {
      const list = Array.isArray(args.workouts) ? args.workouts.slice(0, 7) : [];
      if (!list.length) throw new Error("没有可写入的课");
      const workouts = list.map((w) => {
        const date = String(w.start_date_local || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日期格式不对：" + w.start_date_local);
        return {
          name: String(w.name || "训练课").slice(0, 120),
          type: w.type === "Rest" ? "Rest" : "Ride",
          start_date_local: date + "T00:00:00",
          description: typeof w.description === "string" ? w.description : "",
          moving_time: Number.isFinite(Number(w.moving_time)) ? Number(w.moving_time) : null,
        };
      });
      staged.push({
        kind: "workouts",
        workouts,
        source: "教练对话",
        label: `写入 ${workouts.length} 节课：` + workouts.map((w) => `${w.name}（${w.start_date_local.slice(0, 10)}）`).join("、"),
      });
      return {
        ok: true,
        staged: true,
        message: `已准备好 ${workouts.length} 节课，但**还没有写入 ICU**。请告诉用户：需要他点下面的「确认写入 ICU」按钮才会写进日历。`,
      };
    }
    if (name === "remember") {
      const text = String(args.text || "").trim().slice(0, 200);
      if (!text) throw new Error("记忆内容不能为空");
      await appendMemory(icu, text, retention);
      return { ok: true, message: "已写入教练长期记忆" };
    }
    throw new Error("未知工具: " + name);
  }

  try {
    // 每次对话都拉最新数据，拼进系统提示词
    const [profile, fitness, wellness, activities, memory, baseline, events, histActs] = await Promise.all([
      icu.profile().catch(() => null),
      icu.latestFitness().catch(() => null),
      icu.wellness(7).catch(() => []),
      icu.activities({ oldest: daysAgo(14) }).catch(() => []),
      memoryContext(icu, retention).catch(() => ""),
      icu.wellnessBaseline(30).catch(() => null),
      icu.events({ oldest: daysAgo(0), newest: daysAgo(-7) }).catch(() => []),
      icu.activities({ oldest: daysAgo(45) }).catch(() => []),
    ]);

    // 持续能力（测试最长工作段 / 近 21 天最长高强段）：课程推荐必须看到它，否则只会按当天状态给通用课
    let hist = null;
    try {
      hist = await trainingHistory(icu, histActs, profile);
    } catch (e) {
      hist = null;
    }

    const custom = (req.body && req.body.customPrompt) || "";
    const persona = (req.body && req.body.persona) || "";
    const base = custom
      ? custom
      : coachSystem() + (persona ? "\n\n【教练人设补充（用户自定义）】\n" + persona : "");
    // 他在课表页/设置里选的时段与时长上限（没选就按晚上算）
    const W_LABEL = {
      day_am: "白天上午（9-11 点）",
      day_pm: "白天下午（14-16 点，孩子午睡窗口）",
      night: "晚上 21:30 之后",
    };
    const winHeader = String(req.headers["x-plan-windows"] || "");
    const wins = winHeader
      .split(",")
      .map((w) => w.trim())
      .filter((w) => W_LABEL[w]);
    const winText = (wins.length ? wins : ["night"]).map((w) => W_LABEL[w]).join(" / ");
    const maxDur = Number(req.headers["x-plan-duration"] || 0);
    const ignoreTime = String(req.headers["x-plan-ignore-time"] || "") === "1";

    const system =
      base +
      "\n\n（以下是随对话实时注入的运动员数据，回答训练问题必须基于这些数据，不要编造数字。）\n\n" +
      buildChatDataBlock({ profile, fitness, wellness, activities, baseline }) +
      `\n\n现在是 ${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ")}（UTC+8，${["周日","周一","周二","周三","周四","周五","周六"][new Date(Date.now() + 8 * 3600 * 1000).getUTCDay()]}）。所有日期、空窗、相对时间都按这个算；回答前先算最近一次训练结束到现在过了多久，刚收车不到 3 小时就不要问他几点睡着、次日恢复这类还没发生的事。` +
      (calendarLine(events) ? `\n\n【ICU 日历上已有的安排（优先尊重，不要重复排）】\n${calendarLine(events)}` : "") +
      (hist
        ? `\n\n【持续能力（ICU 区间字段，别重新估算）】${hist.basis}\n判定：${hist.weak_sustained ? "20 分钟连续输出是短板" : "20 分钟续航够用"}。规则：这只是事实，不是每次都强制改课——**解除限制打开时**，若短板成立才首选 **2×20 甜区（88-92%FTP）**去找补 20min 续航；**关闭时按常规状态排课，首推 3×8 阈值（193-196W，52min/TSS 51）或 Z2 85min，2×20 甜区最多作备选、不得作今天首推**。给课时必须引用上面的分钟数和日期，并说明这是从测试分段算出来的。`
        : "") +
      (ignoreTime
        ? `\n\n【解除限制模式（已开启）】忽略他的可用时段、单次时长上限、带娃与工作冲突，改为**按短板选课型**；关闭时仍按常规时段与状态排课，3×8 阈值这类常规课可以正常推荐。
**这个开关不是「把课更难」**：不许因为开了它而加功率、加组数、拉长主段，或把甜区升级成阈值。只允许换「练哪一种」。
选课依据：20 分钟续航弱（FTP 测试最长工作段 <20min，或近 21 天没有 ≥15min 的 ≥88%FTP 连续段）→ 2×20 甜区 88-92%；有氧底弱 → 90-120min 纯 Z2；VO2max 缺（近 14 天无 IF≥95%）→ 5×3 @110%；灰区 ≥50% → 只排两端。选中的课按它自己的标准剂量执行，不额外加码。
开关打开后必须说清楚「今天为什么选这个课型补短板」，并引用历史数字；如果选出的课型和关闭时一样，要说明为什么常规课已能覆盖短板，而不是硬换一节更难的课。`
        : "") +
      `\n\n【他的可用时段】${winText}${maxDur > 0 ? `；单次最长 ${maxDur} 分钟` : ""}\n晚间按强度×时长上限排：≤60 分钟可到阈值/VO2max，60-90 分钟最高甜区（FTP 85-90%），90-120 分钟只做 Z2（≤70%），>120 分钟晚间不给。长课与强度课优先白天；晚上只留 45-60 分钟轻课。` +
      (memory
        ? "\n\n【教练长期记忆（你此前记录过的要点，时间越近越可靠）】\n" + memory
        : "") +
      TOOL_INSTRUCTIONS;

    // 「自动」思考档位：按这轮问题的复杂度选档
    const historyArr = Array.isArray(history) ? history : [];
    const lastText = [...historyArr].reverse().find((m) => m.role === "user")?.content || "";
    const heavy =
      /复盘|课表|排课|计划|对比|分析|评估|生成|写入|为什么|这周|下周|怎么练|总结/.test(lastText) ||
      lastText.length > 120 ||
      historyArr.length >= 8;
    const light = lastText.length <= 12 && !heavy;
    const autoLv = heavy ? "max" : light ? "low" : "high";

    // 只有真需要“查详情/写课表/打标记”的请求才走工具阶段，闲聊直接答，省一轮模型时间
    const needTools =
      /复盘|写入|标记|排课|课表|哪次|哪节|哪一天|详情|明细|具体数据|补强|记录/.test(lastText) ||
      /那节|那次|这个活动/.test(lastText);
    const t0 = Date.now();

    const env = withAutoThinking(llmEnv(req.headers), autoLv);
    const baseMsgs = [{ role: "system", content: system }, ...historyArr];
    let msgs = baseMsgs;
    let preAnswer = "";
    let pendingSeen = false;

    // 工具阶段用低思考档，避免还没开始写就先烧掉 40 秒
    if (needTools) {
      const toolEnv = withAutoThinking(llmEnv(req.headers), "low");
      const r = await toolPhase(msgs, TOOLS, executeTool, toolEnv, elapsedMs(t0) > 20000 ? 1 : 2);
      msgs = r.msgs;
      preAnswer = r.answered;
      pendingSeen = staged.length > 0;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    // 心跳：每 8 秒一行注释，防止中间层把“长时间无数据”当超时
    const hb = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch { /* 连接已关就算了 */ } }, 8000);

    try {
      if (preAnswer) {
        // 模型已经在工具阶段答完，直接吐出去，不再多花一轮
        send({ type: "delta", text: stripDsml(preAnswer) });
      } else {
        // 已经等太久就别再上高档思考，先保证这轮能落地
        const finalEnv = elapsedMs(t0) > 25000 ? withAutoThinking(llmEnv(req.headers), "low") : env;
        const stripper = createDsmlStripper();
        await chatCompletionStream(msgs, finalEnv, (text) => {
          const clean = stripper(text);
          if (clean) send({ type: "delta", text: clean });
        });
      }
      send({ type: "done", pending: staged });
    } catch (e) {
      send({ type: "error", error: String(e.message || e) });
    } finally {
      clearInterval(hb);
      res.end();
    }
    return;
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

function elapsedMs(t0) {
  return Date.now() - t0;
}
