import { createIcuClient } from "../lib/icu.js";
import { getTodayDaily, generateAndStoreDaily } from "../lib/daily.js";
import { llmEnv } from "../lib/llm.js";
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

// 生成/读取今日建议（前端打开 App 时兜底调用，已有则不重复生成）
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "仅支持 POST" });
  }
  const authErr = authError(req);
  if (authErr) return res.status(authErr.status).json({ ok: false, error: authErr.error });
  const cfg = getEnv(req);
  if (cfg.error) return res.status(cfg.status).json({ ok: false, error: cfg.error });

  const icu = createIcuClient(cfg.apiKey, cfg.athleteId);
  const force = !!(req.body && req.body.force);
  // 记忆保留天数：页面设置 > 环境变量 > 默认 48
  const retention = Math.max(
    1,
    Math.min(
      365,
      Number(
        req.headers["x-memory-days"] || process.env.MEMORY_DAYS || 48
      )
    )
  );

  try {
    if (!force) {
      const existing = await getTodayDaily(icu).catch(() => null);
      if (existing) {
        return res.status(200).json({ ok: true, daily: existing, generated: false });
      }
    }
    const winHeader = String(req.headers["x-plan-windows"] || "");
    const windows = winHeader
      .split(",")
      .map((w) => w.trim())
      .filter((w) => ["day_am", "day_pm", "night"].includes(w));
    const maxDurHeader = Number(req.headers["x-plan-duration"] || 0);
    const daily = await generateAndStoreDaily(icu, llmEnv(req.headers), retention, {
      windows: windows.length ? windows : undefined,
      maxDuration: Number.isFinite(maxDurHeader) ? maxDurHeader : 0,
    });
    return res.status(200).json({ ok: true, daily, generated: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
