import { createIcuClient } from "../lib/icu.js";
import { getTodayDaily } from "../lib/daily.js";
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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "仅支持 GET" });
  }
  const authErr = authError(req);
  if (authErr) return res.status(authErr.status).json({ ok: false, error: authErr.error });
  const cfg = getEnv(req);
  if (cfg.error) return res.status(cfg.status).json({ ok: false, error: cfg.error });

  const icu = createIcuClient(cfg.apiKey, cfg.athleteId);
  const out = { ok: true };

  // 每个字段独立容错，避免某一项失败拖垮整页
  const jobs = [
    ["profile", () => icu.profile()],
    ["fitness", () => icu.latestFitness()],
    ["wellness", () => icu.wellness(14)],
    ["activities", () => icu.activities({ oldest: daysAgo(30) })],
    ["daily", () => getTodayDaily(icu)],
  ];
  await Promise.all(
    jobs.map(async ([key, fn]) => {
      try {
        out[key] = await fn();
      } catch (e) {
        out[key] = null;
        out[key + "_error"] = String(e.message || e);
      }
    })
  );

  // 距上次训练天数（空窗提醒用）：按日期差算（UTC+8），不能用小时差向下取整，
  // 否则晚上训练在次日白天会少算一天（前天训练被当成昨天）
  const acts = Array.isArray(out.activities) ? out.activities : [];
  let lastDate = null;
  for (const a of acts) {
    const d = a && a.start_date_local ? String(a.start_date_local).slice(0, 10) : null;
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!lastDate || d > lastDate) lastDate = d;
  }
  if (lastDate) {
    const nowLocal = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const gap = Math.round((Date.parse(nowLocal) - Date.parse(lastDate)) / 86400000);
    out.last_days = Number.isFinite(gap) ? gap : null;
    out.last_training_date = lastDate;
  } else {
    out.last_days = null;
    out.last_training_date = null;
  }

  return res.status(200).json(out);
}
