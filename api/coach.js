import { createIcuClient } from "../lib/icu.js";
import { chatCompletion, parseJson } from "../lib/llm.js";
import { buildAnalyzePrompt, buildPlanPrompt, coachSystem } from "../lib/prompts.js";

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
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "仅支持 POST" });
  }

  const cfg = getEnv(req);
  if (cfg.error) return res.status(cfg.status).json({ ok: false, error: cfg.error });

  const { action } = req.body || {};
  if (!["analyze", "plan"].includes(action)) {
    return res.status(400).json({ ok: false, error: "action 必须是 analyze 或 plan" });
  }

  const icu = createIcuClient(cfg.apiKey, cfg.athleteId);

  // 提示词优先级：自定义提示词（整段覆盖）> 内置人设 + 用户人设补充
  const custom = (req.body && req.body.customPrompt) || "";
  const persona = (req.body && req.body.persona) || "";
  const systemContent = custom
    ? custom
    : coachSystem() + (persona ? "\n\n【教练人设补充（用户自定义）】\n" + persona : "");

  try {
    // 读取公共上下文（profile + fitness + wellness）
    const [profile, fitness, wellness] = await Promise.all([
      icu.profile().catch(() => null),
      icu.latestFitness().catch(() => null),
      icu.wellness(14).catch(() => []),
    ]);

    if (action === "analyze") {
      const { days = 14, focus, rideOnly = true } = req.body;
      let activities = await icu
        .activities({ oldest: daysAgo(days) })
        .catch(() => []);
      // 只看骑行：排除徒步等非骑行活动，避免其 TSS 污染负荷判断
      if (rideOnly) {
        activities = activities.filter((a) => /ride/i.test(a.type || ""));
      }
      const prompt = buildAnalyzePrompt(
        { profile, fitness, wellness, activities, focus },
        custom
      );
      const content = await chatCompletion(
        [
          { role: "system", content: systemContent },
          { role: "user", content: prompt },
        ],
        process.env
      );
      return res.status(200).json({ ok: true, result: content });
    }

    // action === "plan"
    const { goal, days = 7, startDate, constraints } = req.body;
    const start =
      startDate || new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const prompt = buildPlanPrompt(
      { profile, fitness, goal, days, startDate: start, constraints },
      custom
    );
    const content = await chatCompletion(
      [
        { role: "system", content: systemContent },
        { role: "user", content: prompt },
      ],
      process.env,
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
