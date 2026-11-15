import { chatCompletion } from "./llm.js";
import { buildDailyPrompt } from "./prompts.js";

// 本地日期（Asia/Shanghai，北京时间）
export function todayLocal() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// 读今天的「AI 今日建议」便签（不存在返回 null）
export async function getTodayDaily(icu) {
  const t = todayLocal();
  const evs = await icu.events({ oldest: t, newest: t });
  if (!Array.isArray(evs)) return null;
  const note = evs.find(
    (e) => e.category === "NOTE" && /今日建议/.test(e.name || "")
  );
  return note ? { date: t, text: note.description || "" } : null;
}

// 生成今日建议并写回 ICU 日历（便签形式，external_id 幂等）
export async function generateAndStoreDaily(icu, env) {
  const t = todayLocal();
  const daysAgo14 = new Date(Date.now() - 14 * 86400000)
    .toISOString()
    .slice(0, 10);

  const [profile, fitness, wellness, activities] = await Promise.all([
    icu.profile().catch(() => null),
    icu.latestFitness().catch(() => null),
    icu.wellness(7).catch(() => []),
    icu.activities({ oldest: daysAgo14 }).catch(() => []),
  ]);

  const prompt = buildDailyPrompt({ profile, fitness, wellness, activities }, t);
  const text = await chatCompletion(
    [
      {
        role: "system",
        content:
          "你是一位专业的自行车骑行教练，表达简洁口语化，像教练贴在训练计划上的小纸条。",
      },
      { role: "user", content: prompt },
    ],
    env
  );

  await icu.upsertEvents([
    {
      category: "NOTE",
      name: "AI 今日建议",
      description: text,
      start_date_local: t + "T00:00:00",
      external_id: "ai-coach-daily-" + t,
      color: "green",
    },
  ]);

  return { date: t, text };
}
