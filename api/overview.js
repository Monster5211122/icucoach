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

// 按“完成的活动”重算 CTL/ATL/Form（42d / 7d 指数加权），
// 用来对照 ICU 自己那套数字——ICU 的 CTL/ATL 会把日历里的计划课一起算进曲线，
// 计划一写就抬数，但它还没发生，不能当已完成负荷。
function actualLoad(acts, days = 63, todayStr) {
  const byDate = new Map();
  for (const a of acts || []) {
    const d = a && a.start_date_local ? String(a.start_date_local).slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    byDate.set(d, (byDate.get(d) || 0) + (Number(a.icu_training_load) || 0));
  }
  let ctl = 0;
  let atl = 0;
  let last = { date: todayStr, tss: 0, ctl: 0, atl: 0 };
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.parse(todayStr) - i * 86400000).toISOString().slice(0, 10);
    const tss = byDate.get(d) || 0;
    ctl += (tss - ctl) / 42;
    atl += (tss - atl) / 7;
    last = { date: d, tss, ctl, atl };
  }
  return {
    ctl: Math.round(last.ctl * 10) / 10,
    atl: Math.round(last.atl * 10) / 10,
    form: Math.round((last.ctl - last.atl) * 10) / 10,
    tss_today: Math.round(last.tss),
    basis: `${days} 天已完成活动`,
  };
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
    ["activities", () => icu.activities({ oldest: daysAgo(180) })],
    ["daily", () => getTodayDaily(icu)],
    ["today_plan", () => icu.events({ oldest: daysAgo(14), newest: daysAgo(-14) })],
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

  // 日历区分「计划」与「已练」：
  // WORKOUT 事件有 paired_activity_id = 已被某次活动完成（训练后）；
  // 没有 = 只是计划，还没发生，但它会进 ICU 的 CTL/ATL 曲线（本应用不把它算作已完成负荷）。
  const todayLocalDate = nowLocalDate.toISOString().slice(0, 10);
  const evs = Array.isArray(out.today_plan) ? out.today_plan : [];
  const workouts = evs
    .filter((e) => String(e.category || "").toUpperCase() === "WORKOUT")
    .map((e) => {
      const date = String(e.start_date_local || "").slice(0, 10);
      const load = Number(e.icu_training_load) || 0;
      const paired = e.paired_activity_id || null;
      return {
        id: e.id,
        date,
        name: e.name || "",
        load,
        paired,
        status: paired ? "completed" : "planned",
        // 事件是否被 ICU 画进 fitness 曲线（默认 true；本应用写入的计划是 false）
        on_chart: e.not_on_fitness_chart === false,
        type: e.type || "",
      };
    });

  const todayEvents = workouts.filter((w) => w.date === todayLocalDate);
  const todayDone = todayEvents.filter((w) => w.status === "completed");
  const todayPlanned = todayEvents.filter((w) => w.status === "planned");
  out.today_workout = todayEvents.length
    ? { ...todayEvents[0], has_completed: todayDone.length > 0, has_planned: todayPlanned.length > 0 }
    : null;

  // 今日已练 / 今日计划（未练）分开给前端
  out.today_completed = todayDone.map((w) => ({ name: w.name, load: w.load, paired: w.paired }));
  out.today_planned = todayPlanned.map((w) => ({
    name: w.name, load: w.load, id: w.id, on_chart: w.on_chart,
  }));
  out.today_planned_load = todayPlanned.reduce((s, w) => s + w.load, 0);

  // 未来 14 天的计划（只含未完成的），用于提示“这些数字还没发生”
  out.upcoming_planned = workouts
    .filter((w) => w.status === "planned" && w.date > todayLocalDate && w.date <= daysAgo(-14))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, 10)
    .map((w) => ({ id: w.id, date: w.date, name: w.name, load: w.load, on_chart: w.on_chart }));

  // 完成的活动重算负荷，与 ICU 的 fitness 并排展示
  out.fitness_actual = actualLoad(acts, 182, todayLocalDate);
  // ICU 自己的数字（可能把计划课算进去），保留原字段不动
  if (out.fitness) out.fitness_planned_included = true;

  // 不管计划是谁写的（本人、本应用、别的 AI、训练计划库），只要没被活动认领且仍在曲线上，就要报出来
  const chartPlans = workouts.filter(
    (w) => w.status === "planned" && w.on_chart && w.date >= todayLocalDate && w.date <= daysAgo(-14)
  );
  const chartPlanLoad = chartPlans.reduce((s, w) => s + w.load, 0);
  out.plans_on_chart = {
    count: chartPlans.length,
    load: chartPlanLoad,
    items: chartPlans.slice(0, 10).map((w) => ({ id: w.id, date: w.date, name: w.name, load: w.load })),
  };
  // 两套数字的差距：差距持续明显 = ICU 曲线被计划抬高（或历史窗口不同）
  const gap = out.fitness && out.fitness_actual
    ? {
        ctl: Math.round((out.fitness.ctl - out.fitness_actual.ctl) * 10) / 10,
        atl: Math.round((out.fitness.atl - out.fitness_actual.atl) * 10) / 10,
        form: Math.round((out.fitness.form - out.fitness_actual.form) * 10) / 10,
      }
    : null;
  out.fitness_gap = gap;

  // 不对前端暴露原始事件列表（里面可能有记忆便签）
  delete out.today_plan;

  return res.status(200).json(out);
}
