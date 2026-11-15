import { createIcuClient } from "../lib/icu.js";
import { generateAndStoreDaily } from "../lib/daily.js";

// Vercel Cron 入口：每天 UTC 00:00（北京时间 08:00）生成今日建议
// 注意：Cron 只能读服务器环境变量，所以 ICU_API_KEY 需配在 Vercel 环境变量里
export default async function handler(req, res) {
  if (
    process.env.CRON_SECRET &&
    req.headers.authorization !== "Bearer " + process.env.CRON_SECRET
  ) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  if (!process.env.ICU_API_KEY) {
    return res
      .status(200)
      .json({ ok: false, skipped: "未配置 ICU_API_KEY 环境变量，跳过（打开 App 时会兜底生成）" });
  }

  try {
    const icu = createIcuClient(process.env.ICU_API_KEY, process.env.ICU_ATHLETE_ID);
    const daily = await generateAndStoreDaily(icu, process.env);
    return res.status(200).json({ ok: true, daily });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
