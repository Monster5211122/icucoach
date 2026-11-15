import { createIcuClient } from "../lib/icu.js";
import { chatCompletionRaw } from "../lib/llm.js";
import { coachSystem, buildChatDataBlock } from "../lib/prompts.js";
import { summarizeActivity, buildDeepContext, markReviewed } from "../lib/review.js";

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
];

const TOOL_INSTRUCTIONS = `\n\n【工具使用规则】
你拥有四个工具，只在必要时调用（闲聊或一般咨询不要调用）：
- 用户要求复盘某次/某段时间的训练时：先调用 list_activities 找出还没有复盘标记的活动；
- 用 get_activity_detail 拉取该活动的深度数据，再给出复盘；
- 每复盘完一个活动，调用 mark_reviewed 标记它，并在回复末尾告诉用户“已标记”；
- 用户明确要求写课表（如“把今天这节课写进 ICU”“帮我写一节甜区课”）时，调用 create_workout 写入，然后在回复里复述课表内容和日期，告诉用户已写入；
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

  const cfg = getEnv(req);
  if (cfg.error) return res.status(cfg.status).json({ ok: false, error: cfg.error });

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: "messages 不能为空" });
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

  // 工具执行器（闭包持有 icu 客户端）
  async function executeTool(name, args) {
    if (name === "list_activities") {
      const days = Math.min(30, Math.max(1, Number(args.days) || 14));
      const acts = await icu.activities({ oldest: daysAgo(days) });
      const rides = acts.filter((a) => /ride/i.test(a.type || ""));
      return {
        count: rides.length,
        activities: rides.slice(-15).map(summarizeActivity),
      };
    }
    if (name === "get_activity_detail") {
      const id = Number(args.activity_id);
      const a = await icu.activity(id);
      let streams = null;
      try {
        streams = await icu.activityStreams(id);
      } catch { /* 流数据可选，拿不到就算了 */ }
      return buildDeepContext(a, streams);
    }
    if (name === "mark_reviewed") {
      const id = Number(args.activity_id);
      const a = await icu.activity(id);
      const r = await markReviewed(icu, a);
      return r.changed
        ? { ok: true, message: `已把活动「${a.name || id}」标记为已复盘` }
        : { ok: true, message: "该活动已经是已复盘状态，无需重复标记" };
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
      const created = await icu.writeWorkouts([workout]);
      const ev = created[0];
      return {
        ok: true,
        message: "已写入 ICU 日历",
        workout: {
          id: ev.id,
          name: ev.name,
          date: ev.start_date_local,
          tss: ev.icu_training_load ?? null,
        },
      };
    }
    throw new Error("未知工具: " + name);
  }

  try {
    // 每次对话都拉最新数据，拼进系统提示词
    const [profile, fitness, wellness, activities] = await Promise.all([
      icu.profile().catch(() => null),
      icu.latestFitness().catch(() => null),
      icu.wellness(7).catch(() => []),
      icu.activities({ oldest: daysAgo(14) }).catch(() => []),
    ]);

    const custom = (req.body && req.body.customPrompt) || "";
    const persona = (req.body && req.body.persona) || "";
    const base = custom
      ? custom
      : coachSystem() + (persona ? "\n\n【教练人设补充（用户自定义）】\n" + persona : "");
    const system =
      base +
      "\n\n（以下是随对话实时注入的运动员数据，回答训练问题必须基于这些数据，不要编造数字。）\n\n" +
      buildChatDataBlock({ profile, fitness, wellness, activities }) +
      TOOL_INSTRUCTIONS;

    const reply = await chatWithTools(
      [{ role: "system", content: system }, ...history],
      TOOLS,
      executeTool,
      process.env
    );
    return res.status(200).json({ ok: true, reply });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
