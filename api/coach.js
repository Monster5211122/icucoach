import { createIcuClient } from "../lib/icu.js";
import { chatCompletion, parseJson, llmEnv } from "../lib/llm.js";
import { buildAnalyzePrompt, buildPlanPrompt, coachSystem } from "../lib/prompts.js";
import { appendMemory, memoryContext } from "../lib/memory.js";
import { authError } from "../lib/auth.js";

// 记忆保留天数：页面设置 > 服务器环境变量 > 默认 48 天
function getRetention(req) {
  return Math.max(
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
}

// 从复盘内容里提取值得长期记住的要点（0-2 条）
async function extractMemoryEntries(reviewText, env) {
  const content = await chatCompletion(
    [
      {
        role: "system",
        content: `你是教练的记忆整理助手。从下面的骑行训练复盘中提取 0-2 条值得长期记住的要点（用户特征、训练偏好、重要结论、伤病情况等）。要求：
- 每条 15-40 字，是“将来有用的结论”，不要复述当天数据本身；
- 与训练无关的客套话、通用建议不要提取；
- 没有值得记的就返回空数组；
- 只输出 JSON：{"entries":["要点1","要点2"]}`,
      },
      { role: "user", content: reviewText.slice(0, 6000) },
    ],
    env,
    { json: true }
  );
  const parsed = parseJson(content);
  return (Array.isArray(parsed.entries) ? parsed.entries : [])
    .filter((t) => typeof t === "string" && t.trim().length >= 6)
    .map((t) => t.trim().slice(0, 100))
    .slice(0, 2);
}

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

// 计算 N 天前的本地日期（YYYY-MM-DD）
function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  // GET：设置页「载入内置提示词」用——返回后台当前完整的教练提示词，方便用户查看/续写
  if (req.method === "GET") {
    const authErr = authError(req);
    if (authErr) return res.status(authErr.status).json({ ok: false, error: authErr.error });
    const q = String(req.url || "").split("?")[1] || "";
    if (new URLSearchParams(q).get("action") !== "default_prompt") {
      return res.status(400).json({ ok: false, error: "action 必须是 default_prompt" });
    }
    return res.json({ ok: true, prompt: coachSystem() });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "仅支持 POST" });
  }

  const authErr = authError(req);
  if (authErr) return res.status(authErr.status).json({ ok: false, error: authErr.error });

  const cfg = getEnv(req);
  if (cfg.error) return res.status(cfg.status).json({ ok: false, error: cfg.error });

  const { action } = req.body || {};
  if (!["analyze", "plan"].includes(action)) {
    return res.status(400).json({ ok: false, error: "action 必须是 analyze 或 plan" });
  }

  const llm = llmEnv(req.headers);
  const icu = createIcuClient(cfg.apiKey, cfg.athleteId);

  // 提示词优先级：自定义提示词（整段覆盖）> 内置人设 + 用户人设补充
  const custom = (req.body && req.body.customPrompt) || "";
  const persona = (req.body && req.body.persona) || "";
  const systemContent = custom
    ? custom
    : coachSystem() + (persona ? "\n\n【教练人设补充（用户自定义）】\n" + persona : "");

  try {
    // 读取公共上下文（profile + fitness + wellness + 恢复基线）
    const [profile, fitness, wellness, baseline] = await Promise.all([
      icu.profile().catch(() => null),
      icu.latestFitness().catch(() => null),
      icu.wellness(14).catch(() => []),
      icu.wellnessBaseline(30).catch(() => null),
    ]);

    if (action === "analyze") {
      const { days = 14, focus, rideOnly = true } = req.body;
      const retention = getRetention(req);
      const [activitiesRaw, memory] = await Promise.all([
        icu.activities({ oldest: daysAgo(days) }).catch(() => []),
        memoryContext(icu, retention).catch(() => ""),
      ]);
      // 只看骑行：排除徒步等非骑行活动，避免其 TSS 污染负荷判断
      let activities = activitiesRaw;
      if (rideOnly) {
        activities = activities.filter((a) => /ride/i.test(a.type || ""));
      }
      // 给最近 5 次骑行拉单课详情（NP/EF/VI/心率漂移等只存在于详情接口），让分析有据可依
      const recent = activities.slice(0, 5);
      const enriched = await Promise.all(
        recent.map(async (a) => {
          try {
            const d = await icu.activity(a.id);
            return { ...a, ...d };
          } catch (e) {
            return a;
          }
        })
      );
      activities = enriched.concat(activities.slice(5));
      let prompt = buildAnalyzePrompt(
        { profile, fitness, wellness, baseline, activities, focus },
        custom
      );
      if (memory) {
        prompt +=
          "\n\n【教练长期记忆（你此前记录过的要点，时间越近越可靠）】\n" + memory;
      }
      const content = await chatCompletion(
        [
          { role: "system", content: systemContent },
          { role: "user", content: prompt },
        ],
        llm
      );

      // 复盘后自动提取要点写入长期记忆（失败不影响复盘结果）
      let memError = null;
      try {
        const entries = await extractMemoryEntries(content, llm);
        for (const t of entries) await appendMemory(icu, t, retention);
      } catch (e) {
        memError = String(e.message || e);
      }
      return res.status(200).json({ ok: true, result: content, memError });
    }

    // action === "plan"
    const { goal, days = 7, startDate, constraints, mode = "indoor" } = req.body;
    const start =
      startDate || new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const prompt = buildPlanPrompt(
      { profile, fitness, wellness, baseline, goal, days, startDate: start, constraints, mode },
      custom
    );
    const content = await chatCompletion(
      [
        { role: "system", content: systemContent },
        { role: "user", content: prompt },
      ],
      llm,
      { json: true }
    );
    const plan = parseJson(content);

    if (!Array.isArray(plan.workouts) || plan.workouts.length === 0) {
      return res.status(502).json({ ok: false, error: "模型未返回有效课表" });
    }

    // 校验每条课表字段，避免脏数据写回 ICU
    const workouts = plan.workouts.map((w, i) => ({
      name: String(w.name || `第${i + 1}天`).slice(0, 120),
      type: w.type === "Rest" ? "Rest" : "Ride",
      start_date_local: /^\d{4}-\d{2}-\d{2}/.test(w.start_date_local || "")
        ? w.start_date_local.slice(0, 10) + "T00:00:00"
        : null,
      description: typeof w.description === "string" ? w.description : "",
      moving_time: Number.isFinite(Number(w.moving_time)) ? Number(w.moving_time) : null,
    })).filter((w) => w.start_date_local);

    return res.status(200).json({
      ok: true,
      summary: plan.summary || "",
      workouts,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
