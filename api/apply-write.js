import { createIcuClient } from "../lib/icu.js";
import { markReviewed } from "../lib/review.js";
import { workoutTextFromSteps } from "../lib/workout-text.js";
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
      const workouts = list.map((w) => {
        const date = String(w.start_date_local || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日期格式不对：" + w.start_date_local);
        const base = typeof w.description === "string" ? w.description.trim() : "";
        // 日历里只放 ICU 结构化课（每段一行），散文/来源标注一概不写进去
        // 优先用 steps 重新生成 ICU 训练格式（MyWhoosh/码表只认这种结构）
        let structured = Array.isArray(w.steps) && w.steps.length ? workoutTextFromSteps(w.steps) : "";
        if (!structured) {
          const lines = base.split("\n").map((l) => l.trim()).filter(Boolean);
          const kept = [];
          let pendingLabel = "";
          for (const l of lines) {
            if (/^-/.test(l)) {
              if (pendingLabel) kept.push(pendingLabel);
              pendingLabel = "";
              kept.push(l);
              continue;
            }
            // 只把紧挨动作行、短且不带句号的段名留下；散文与来源说明全部丢弃
            if (l.length <= 24 && !/[。：:，,]/.test(l) && !/来源|icucoach|AI\s*教练/i.test(l)) {
              pendingLabel = l;
            } else {
              pendingLabel = "";
            }
          }
          structured = kept.join("\n");
        }
        if (!structured) {
          throw new Error(`「${w.name || "训练课"}」没有可解析的分段（steps 或 - 行），请让教练给出逐段结构再写`);
        }
        // 保留用户/前端给的时段（默认 21:30），不要一律抹成 00:00
        const raw = String(w.start_date_local || "");
        const timePart = /T(\d{2}:\d{2})(?::\d{2})?/.exec(raw);
        const hhmm = timePart ? timePart[1] + ":00" : "21:30:00";
        // 时长按 steps 实际求和，避免 3x 之类没展开时对不上
        let seconds = Number.isFinite(Number(w.moving_time)) ? Number(w.moving_time) : 0;
        if (Array.isArray(w.steps) && w.steps.length) {
          seconds = w.steps.reduce((sum, sg) => {
            const m = Number(sg && (sg.minutes != null ? sg.minutes : sg.min));
            return sum + (Number.isFinite(m) && m > 0 ? m * 60 : 0);
          }, 0);
        }
        return {
          name: String(w.name || "训练课").slice(0, 120),
          type: w.type === "Rest" ? "Rest" : "Ride",
          start_date_local: date + "T" + hhmm,
          description: structured,
          moving_time: seconds > 0 ? seconds : null,
        };
      });
      const created = await icu.writeWorkouts(workouts);
      // 写完回读一次：确认事件真的在 ICU 日历里，而不是「接口返回 200 但没落库」
      let verified = true;
      try {
        const dates = workouts.map((w) => String(w.start_date_local).slice(0, 10)).sort();
        const evs = await icu.events({ oldest: dates[0], newest: dates[dates.length - 1] });
        const ids = new Set((evs || []).map((e) => String(e.id)));
        verified = created.every((ev) => ids.has(String(ev.id)));
      } catch {
        verified = false;
      }
      return res.status(200).json({
        ok: true,
        verified,
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
