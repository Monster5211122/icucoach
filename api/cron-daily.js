import { createIcuClient } from "../lib/icu.js";
import { generateAndStoreDaily, getTodayDaily } from "../lib/daily.js";
import { withAutoThinking } from "../lib/llm.js";
import { readPrefs } from "../lib/prefs.js";

// Vercel Cron：北京时间 08:00-20:00 每小时检查一次（UTC 0-12 点）
// 只在「今天还没有建议」且「HRV 已填 或 已过 12 点」时才真正生成，
// 其余时间直接返回，不消耗模型额度。写的是 ICU 便签，不写结构化课表。
function beijingHour() {
  return (new Date().getUTCHours() + 8) % 24;
}

export default async function handler(req, res) {
  if (
    process.env.CRON_SECRET &&
    req.headers.authorization !== "Bearer " + process.env.CRON_SECRET
  ) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  if (!process.env.ICU_API_KEY) {
    return res.status(200).json({
      ok: false,
      skipped: "未配置 ICU_API_KEY 环境变量，跳过（打开 App 时会兜底生成）",
    });
  }

  try {
    const icu = createIcuClient(process.env.ICU_API_KEY, process.env.ICU_ATHLETE_ID);

    // 1) 用户在设置里关掉了每日自动建议 → 什么都不做
    const prefs = await readPrefs(icu);
    if (prefs && prefs.dailyAuto === false) {
      return res.status(200).json({ ok: true, skipped: "设置里已关闭每日自动建议" });
    }

    // 2) 今天已经有了 → 直接返回，不再调模型
    const existing = await getTodayDaily(icu).catch(() => null);
    if (existing && existing.text) {
      return res.status(200).json({ ok: true, skipped: "今天已有建议", daily: existing });
    }

    // 3) HRV 是手动填的：早上多半还没有，等到 12 点再生成
    const latest = (await icu.wellness(1).catch(() => []))[0];
    const hasHrv = latest && typeof latest.hrv === "number" && latest.hrv > 0;
    if (!hasHrv && beijingHour() < 12) {
      return res.status(200).json({
        ok: true,
        skipped: "今天还没填 HRV，12 点后再生成",
        hour: beijingHour(),
      });
    }

    const retention = Math.max(
      1,
      Math.min(365, Number(process.env.MEMORY_DAYS || 48))
    );
    const daily = await generateAndStoreDaily(
      icu,
      withAutoThinking(process.env, "high"),
      retention,
      {
        windows: prefs && Array.isArray(prefs.windows) && prefs.windows.length ? prefs.windows : undefined,
        maxDuration: prefs && Number(prefs.maxDuration) ? Number(prefs.maxDuration) : 0,
        ignoreTime: !!(prefs && prefs.ignoreTime),
        hrvMissing: !hasHrv,
        source: "每日自动建议",
      }
    );
    return res.status(200).json({ ok: true, daily, hrv: hasHrv ? "已填" : "未填（按 12 点兜底生成）" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
