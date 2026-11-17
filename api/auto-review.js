import { createIcuClient } from "../lib/icu.js";
import { chatCompletion, llmEnv, withAutoThinking } from "../lib/llm.js";
import { buildSingleAnalyzePrompt, coachSystem } from "../lib/prompts.js";
import { memoryContext } from "../lib/memory.js";
import { isReviewed } from "../lib/review.js";
import { authError } from "../lib/auth.js";

// 训练后自动复盘：找最近还没复盘的骑行，复盘一节，然后把「AI复盘已完成」写回 ICU
// 每次只处理 1 节（控制时长与费用），重复调用不会重复复盘（靠 marker 去重）
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "仅支持 POST" });
  }
  const authErr = authError(req);
  if (authErr) return res.status(authErr.status).json({ ok: false, error: authErr.error });

  const apiKey = req.headers["x-icu-api-key"] || process.env.ICU_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: "未配置 ICU API Key" });
  }
  const athleteId = req.headers["x-icu-athlete-id"] || process.env.ICU_ATHLETE_ID;
  const icu = createIcuClient(apiKey, athleteId);

  const retention = Math.max(
    1,
    Math.min(
      365,
      Number(req.headers["x-memory-days"] || (req.body && req.body.memoryDays) || 48)
    )
  );

  try {
    // 只看最近 5 天的骑行（太久以前的补复盘没有指导意义，也容易一开门就烧一堆额度）
    const acts = await icu.activities({ oldest: daysAgo(5) }).catch(() => []);
    const rides = (Array.isArray(acts) ? acts : []).filter(
      (a) => /ride/i.test(a.type || "") && !isReviewed(a)
    );
    if (!rides.length) return res.status(200).json({ ok: true, reviewed: null, reason: "没有待复盘的骑行" });

    const target = rides[0]; // ICU 按时间倒序，第一条就是最近一节
    // 上一节已经复盘过（只是没点确认写标记）→ 不重复花钱
    const lastId = String((req.body && req.body.lastId) || "").trim();
    if (lastId && String(target.id) === lastId) {
      return res.status(200).json({ ok: true, reviewed: null, reason: "最近一节已复盘过，未写入标记" });
    }
    const [profile, fitness, wellness, baseline, memory] = await Promise.all([
      icu.profile().catch(() => null),
      icu.latestFitness().catch(() => null),
      icu.wellness(14).catch(() => []),
      icu.wellnessBaseline(30).catch(() => null),
      memoryContext(icu, retention).catch(() => ""),
    ]);

    let detail = target;
    try {
      detail = { ...target, ...(await icu.activity(target.id)) };
    } catch { /* 详情拿不到就用列表里的字段 */ }

    let prompt = buildSingleAnalyzePrompt(
      { profile, fitness, wellness, baseline },
      detail,
      ""
    );
    if (memory) {
      prompt += "\n\n【教练长期记忆（他当面说过的情况，比数据更能解释主观感受）】\n" + memory;
    }

    const content = await chatCompletion(
      [
        { role: "system", content: coachSystem() },
        { role: "user", content: prompt },
      ],
      withAutoThinking(llmEnv(req.headers), "high")
    );

    // 不自动写回：标记也交给用户点「确认写入 ICU」再落库
    return res.status(200).json({
      ok: true,
      reviewed: {
        id: target.id,
        name: target.name || "",
        date: String(target.start_date_local || "").slice(0, 10),
        analysis: content,
        marked: false,
      },
      pending: [{ kind: "mark_reviewed", activity_id: target.id, source: "训练后自动复盘", label: `标记「${target.name || target.id}」为已复盘` }],
      pending: Math.max(rides.length - 1, 0),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
