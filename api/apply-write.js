import { createIcuClient } from "../lib/icu.js";
import { markReviewed } from "../lib/review.js";
import { authError } from "../lib/auth.js";

// 用户在对话里点「确认写入 ICU」后，才真正落库
// 支持：写入课表（1-N 节）、把活动标记为已复盘
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "仅支持 POST" });
  const authErr = authError(req);
  if (authErr) return res.status(authErr.status).json({ ok: false, error: authErr.error });

  const apiKey = req.headers["x-icu-api-key"] || process.env.ICU_API_KEY;
  if (!apiKey) return res.status(400).json({ ok: false, error: "未配置 ICU API Key" });
  const athleteId = req.headers["x-icu-athlete-id"] || process.env.ICU_ATHLETE_ID;
  const icu = createIcuClient(apiKey, athleteId);

  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  try {
    if (b.kind === "workouts") {
      const list = Array.isArray(b.workouts) ? b.workouts.slice(0, 7) : [];
      if (!list.length) throw new Error("没有可写入的课");
      const source = String(b.source || "教练对话").slice(0, 20);
      const stamp = new Date(Date.now() + 8 * 3600 * 1000)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ");
      const srcLine = `\n\n来源：icucoach · ${source}（${stamp} UTC+8）`;
      const workouts = list.map((w) => {
        const date = String(w.start_date_local || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日期格式不对：" + w.start_date_local);
        const base = typeof w.description === "string" ? w.description.trim() : "";
        return {
          name: String(w.name || "训练课").slice(0, 120),
          type: w.type === "Rest" ? "Rest" : "Ride",
          start_date_local: date + "T00:00:00",
          description: base + srcLine,
          moving_time: Number.isFinite(Number(w.moving_time)) ? Number(w.moving_time) : null,
        };
      });
      const created = await icu.writeWorkouts(workouts);
      return res.status(200).json({
        ok: true,
        written: created.map((ev) => ({
          id: ev.id,
          name: ev.name,
          date: String(ev.start_date_local || "").slice(0, 10),
          tss: ev.icu_training_load ?? null,
        })),
      });
    }
    if (b.kind === "mark_reviewed") {
      const id = String(b.activity_id || "").trim();
      if (!id) throw new Error("缺少活动 ID");
      const a = await icu.activity(id);
      const r = await markReviewed(icu, a, {
        source: String(b.source || "教练对话").slice(0, 20),
      });
      return res.status(200).json({
        ok: true,
        changed: !!r.changed,
        message: r.changed ? "已写回标记" : "该活动已经是已复盘状态",
      });
    }
    throw new Error("未知写入类型");
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
