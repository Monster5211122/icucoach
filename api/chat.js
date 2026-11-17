import { createIcuClient } from "../lib/icu.js";
import { chatCompletionRaw, llmEnv, withAutoThinking } from "../lib/llm.js";
import { coachSystem, buildChatDataBlock } from "../lib/prompts.js";
import { summarizeActivity, buildDeepContext, markReviewed } from "../lib/review.js";
import { appendMemory, memoryContext } from "../lib/memory.js";
import { authError } from "../lib/auth.js";

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
          start_date_local: { type: "string", description: "日期，格式 YYYY-MM-DD" },
          description: {
            type: "string",
            description:
              "ICU 原生 workout 文本，如：- 15m 55% 85-95rpm\\nMain set 2x\\n- 20m 95%\\n- 5m 50%；Rest 时留空",
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
- 用 get_activity_detail 拉取该活动的深度数据，再给出复盘；
- 每复盘完一个活动，调用 mark_reviewed 准备标记，并在回复末尾说明「已准备好标记，点下面的“确认写入 ICU”才会写回」；**绝不能说“已写入/已标记”**，因为工具只做暂存；
- 用户问“今天怎么练/今天练什么”时，不要只说方向：按「判决（练/降档练/不练）→ 今天这一节（热身/主段/组间/放松，每段写确切分钟数、瓦数区间、踏频）→ 体感校准（RPE 与心率红线）→ 降一档 → 停的条件 → 为什么」给，读完他能直接上台骑。
- 用户说“排这周课表/给我排几天”时：先把每天的课排好（按上面的时段、时长、强度两端分化、灰区占比规则），再调用 create_workouts 准备批量写入（同样要等用户点确认）；不要预排他练不了的天数，每周至少留 1-2 天恢复或休息。
- 用户明确要求写课表（如“把今天这节课写进 ICU”“帮我写一节甜区课”）时，调用 create_workout 准备课表，复述课表内容和日期，并说明「等你点下面的‘确认写入 ICU’按钮才会写进日历」；**禁止说已写入**；
- 遇到值得长期记住的用户特征、训练偏好、重要结论或伤病情况时，调用 remember 写入教练记忆；同样的内容不要重复记；
- 用户说出任何**训练约束**时必须 remember 一条（这类信息会进入课表与每日建议，不记就等于下次又要他重复一遍）：可用时段（如"白天午睡 13:00-15:30、晚上 21:30 后"）、单次时长上限、哪几天完全没空、身体问题（坐垫疼/膝痛/腰紧）、装备条件（没穿骑行裤、只有骑行台）、睡眠与工作安排；
- 已标记（reviewed=true）的活动可以略过或只用于趋势对比，重点复盘未标记的。`;

// 工具调用循环（最多 5 轮，防止死循环）
async function chatWithTools(messages, tools, executor, env) {
  const msgs = [...messages];
  for (let round = 0; round < 5; round++) {
    const msg = await chatCompletionRaw(msgs, env, { tools });
    msgs.push(msg);
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      if (!msg.content) throw new Error("模型未返回文本内容");
      return msg.content;
    }
    for (const tc of msg.tool_calls) {
      let result;
      try {
        const args = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        result = await executor(tc.function.name, args);
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      msgs.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }
  throw new Error("工具调用轮次过多，已中止");
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
      const a = await icu.activity(id);
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
      const date = String(args.start_date_local || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("日期格式不对，应为 YYYY-MM-DD");
      }
      const workout = {
        name: String(args.name || "训练课").slice(0, 120),
        type: args.type === "Rest" ? "Rest" : "Ride",
        start_date_local: date + "T00:00:00",
        description: typeof args.description === "string" ? args.description : "",
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
    const [profile, fitness, wellness, activities, memory, baseline, events] = await Promise.all([
      icu.profile().catch(() => null),
      icu.latestFitness().catch(() => null),
      icu.wellness(7).catch(() => []),
      icu.activities({ oldest: daysAgo(14) }).catch(() => []),
      memoryContext(icu, retention).catch(() => ""),
      icu.wellnessBaseline(30).catch(() => null),
      icu.events({ oldest: daysAgo(0), newest: daysAgo(-7) }).catch(() => []),
    ]);

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
      `\n\n今天是 ${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}（UTC+8），所有日期与空窗按这个算。` +
      (calendarLine(events) ? `\n\n【ICU 日历上已有的安排（优先尊重，不要重复排）】\n${calendarLine(events)}` : "") +
      (ignoreTime
        ? `\n\n【纯数据补强模式（已开启）】忽略他的可用时段、单次时长上限、带娃与工作冲突：只按数据里的短板给最该练的课，不要为了迁就晚上而降剂量。剂量按短板定：有氧底弱→90-120min 连续 Z2；阈值耐力弱→2x20 @93-95%；VO2max 缺→5x3 @110-115%；灰区≥50% 时只排两端。每节在理由里标一句"这节要整块时间（含热身约 X 小时），排不出来就拆两段、效果降级约三成"，但剂量不降。`
        : "") +
      `\n\n【他的可用时段】${winText}${maxDur > 0 ? `；单次最长 ${maxDur} 分钟` : ""}\n晚间按强度×时长上限排：≤60 分钟可到阈值/VO2max，60-90 分钟最高甜区（FTP 85-90%），90-120 分钟只做 Z2（≤70%），>120 分钟晚间不给。长课与强度课优先白天；晚上只留 45-60 分钟轻课。` +
      (memory
        ? "\n\n【教练长期记忆（你此前记录过的要点，时间越近越可靠）】\n" + memory
        : "") +
      TOOL_INSTRUCTIONS;

    // 「自动」思考档位：按这轮问题的复杂度选档
    const lastText = [...history].reverse().find((m) => m.role === "user")?.content || "";
    const heavy =
      /复盘|课表|排课|计划|对比|分析|评估|生成|写入|为什么|这周|下周|怎么练|总结/.test(lastText) ||
      lastText.length > 120 ||
      history.length >= 8;
    const light = lastText.length <= 12 && !heavy;
    const autoLv = heavy ? "max" : light ? "low" : "high";

    const reply = await chatWithTools(
      [{ role: "system", content: system }, ...history],
      TOOLS,
      executeTool,
      withAutoThinking(llmEnv(req.headers), autoLv)
    );
    return res.status(200).json({ ok: true, reply, pending: staged });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
