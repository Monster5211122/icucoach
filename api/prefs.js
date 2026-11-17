import { createIcuClient } from "../lib/icu.js";
import { readPrefs, writePrefs } from "../lib/prefs.js";
import { authError } from "../lib/auth.js";

// GET  查服务端设置副本（cron 读的那份）
// POST 把 App 里的设置同步上去（每日自动建议开关、时段、时长、补强）
export default async function handler(req, res) {
  const authErr = authError(req);
  if (authErr) return res.status(authErr.status).json({ ok: false, error: authErr.error });

  const apiKey = req.headers["x-icu-api-key"] || process.env.ICU_API_KEY;
  if (!apiKey) return res.status(400).json({ ok: false, error: "未配置 ICU API Key" });
  const athleteId = req.headers["x-icu-athlete-id"] || process.env.ICU_ATHLETE_ID;
  const icu = createIcuClient(apiKey, athleteId);

  try {
    if (req.method === "GET") {
      const prefs = await readPrefs(icu);
      return res.status(200).json({ ok: true, prefs: prefs || null });
    }
    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const prefs = {
        dailyAuto: b.dailyAuto !== false,
        windows: Array.isArray(b.windows) ? b.windows : [],
        maxDuration: Number(b.maxDuration) || 0,
        ignoreTime: !!b.ignoreTime,
        updatedAt: new Date().toISOString(),
      };
      await writePrefs(icu, prefs);
      return res.status(200).json({ ok: true, prefs });
    }
    return res.status(405).json({ ok: false, error: "仅支持 GET/POST" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
