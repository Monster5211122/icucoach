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
    ["today_plan", () => icu.events({ oldest: daysAgo(0), newest: daysAgo(-2) })],
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
    out.empty_days = Number.isFinite(gap) ? Math.max(gap - 1, 0) : null; // 真正没训练的天数
    out.last_training_date = lastDate;
  } else {
    out.last_days = null;
    out.empty_days = null;
    out.last_training_date = null;
  }

  // 本周（周一至今）TSS 与已练天数：用于对话首页"教练现在看到什么"
  const nowLocalDate = new Date(Date.now() + 8 * 3600 * 1000);
  const dow = nowLocalDate.getUTCDay(); // 0=周日
  const sinceMonday = new Date(
    nowLocalDate.getTime() - ((dow + 6) % 7) * 86400000
  )
    .toISOString()
    .slice(0, 10);
  const weekActs = acts.filter((a) => {
    const d = String(a?.start_date_local || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= sinceMonday;
  });
  out.week_tss = Math.round(
    weekActs.reduce((s, a) => s + (Number(a.icu_training_load) || 0), 0)
  );
  out.week_days = new Set(weekActs.map((a) => String(a.start_date_local).slice(0, 10))).size;

  // 今天的日历安排（有课/休息日）
  const todayLocalDate = nowLocalDate.toISOString().slice(0, 10);
  const evs = Array.isArray(out.today_plan) ? out.today_plan : [];
  // 只取真正的课表事件（WORKOUT），排除便签/记忆/今日建议这类 NOTE
  const todays = evs.filter(
    (e) =>
      String(e.start_date_local || "").slice(0, 10) === todayLocalDate &&
      String(e.category || "").toUpperCase() === "WORKOUT"
  );
  out.today_workout = todays.length
    ? { name: todays[0].name || "", category: todays[0].category || "", type: todays[0].type || "" }
    : null;

  // 不对前端暴露原始事件列表（里面可能有记忆便签）
  delete out.today_plan;

  return res.status(200).json(out);
}
