import { createIcuClient } from "../lib/icu.js";
import { getTodayDaily } from "../lib/daily.js";

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

  // 距上次训练天数（空窗提醒用）
  const acts = Array.isArray(out.activities) ? out.activities : [];
  const dates = acts
    .map((a) => new Date(a.start_date_local).getTime())
    .filter((t) => Number.isFinite(t));
  out.last_days =
    dates.length > 0 ? Math.floor((Date.now() - Math.max(...dates)) / 86400000) : null;

  return res.status(200).json(out);
}
