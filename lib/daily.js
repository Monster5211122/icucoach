import { chatCompletion } from "./llm.js";
import { buildDailyPrompt } from "./prompts.js";
import { memoryContext } from "./memory.js";

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
export async function generateAndStoreDaily(icu, env, retentionDays = 48) {
  const t = todayLocal();
  const daysAgo14 = new Date(Date.now() - 14 * 86400000)
    .toISOString()
    .slice(0, 10);

  const [profile, fitness, wellness, activities, memory] = await Promise.all([
    icu.profile().catch(() => null),
    icu.latestFitness().catch(() => null),
    icu.wellness(7).catch(() => []),
    icu.activities({ oldest: daysAgo14 }).catch(() => []),
    memoryContext(icu, retentionDays).catch(() => ""),
  ]);

  let prompt = buildDailyPrompt({ profile, fitness, wellness, activities }, t);
  if (memory) {
    prompt +=
      "\n\n【教练长期记忆（你此前记录过的要点，时间越近越可靠）】\n" + memory;
  }
  const text = await chatCompletion(
    [
      {
        role: "system",
        content:
          "你是一位专业的自行车骑行教练，表达简洁口语化，像教练贴在训练计划上的小纸条。" +
          "判断“今天练不练”时遵循：发烧/发冷/胸闷/静息心悸/全身酸痛→建议休息；HRV 一晚偏低不砍课，连续 2 天偏低且主观也差才降档；看空气质量用 PM2.5 数值（35-75 质量课改室内或砍轻松，75 以上不户外高强度）；恢复骑也是负荷不是休息。",
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
