import { createIcuClient } from "../lib/icu.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "仅支持 POST" });
  }

  // ICU Key / 运动员 ID：优先取页面「设置」里带过来的请求头，兜底用服务器环境变量
  const apiKey = req.headers["x-icu-api-key"] || process.env.ICU_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      ok: false,
      error: "未配置 ICU API Key：请在 App「设置」页填写，或在 Vercel 环境变量里配置 ICU_API_KEY",
    });
  }

  const { workouts } = req.body || {};
  if (!Array.isArray(workouts) || workouts.length === 0) {
    return res.status(400).json({ ok: false, error: "workouts 不能为空" });
  }

  // 二次校验，防止误写
  const clean = workouts.filter(
    (w) =>
      w &&
      typeof w.name === "string" &&
      /^\d{4}-\d{2}-\d{2}/.test(w.start_date_local || "")
  );
  if (clean.length === 0) {
    return res.status(400).json({ ok: false, error: "课表数据不完整" });
  }

  const icu = createIcuClient(
    apiKey,
    req.headers["x-icu-athlete-id"] || process.env.ICU_ATHLETE_ID
  );

  try {
    const created = await icu.writeWorkouts(clean);
    return res.status(200).json({
      ok: true,
      count: created.length,
      created: created.map((e) => ({
        id: e.id,
        name: e.name,
        start_date_local: e.start_date_local,
        icu_training_load: e.icu_training_load ?? null,
      })),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
