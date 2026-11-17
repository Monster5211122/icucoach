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
export async function generateAndStoreDaily(icu, env, retentionDays = 48, opts = {}) {
  const t = todayLocal();
  const daysAgo14 = new Date(Date.now() - 14 * 86400000)
    .toISOString()
    .slice(0, 10);

  const [profile, fitness, wellness, activitiesRaw, memory, baseline] = await Promise.all([
    icu.profile().catch(() => null),
    icu.latestFitness().catch(() => null),
    icu.wellness(7).catch(() => []),
    icu.activities({ oldest: daysAgo14 }).catch(() => []),
    memoryContext(icu, retentionDays).catch(() => ""),
    icu.wellnessBaseline(30).catch(() => null),
  ]);

  // 给最近 3 次骑行拉单课详情（NP/EF/VI/心率漂移只在详情接口），让每日建议也有针对性
  const rideDetails = await Promise.all(
    (activitiesRaw || [])
      .filter((a) => /ride/i.test(a.type || ""))
      .slice(0, 3)
      .map(async (a) => {
        try {
          const d = await icu.activity(a.id);
          return { ...a, ...d };
        } catch (e) {
          return a;
        }
      })
  );
  const detailMap = new Map(rideDetails.map((a) => [a.id, a]));
  const activities = (activitiesRaw || []).map((a) => detailMap.get(a.id) || a);

  let prompt = buildDailyPrompt(
    {
      profile,
      fitness,
      wellness,
      activities,
      baseline,
      windows: opts.windows,
      maxDuration: opts.maxDuration,
      ignoreTime: !!opts.ignoreTime,
    },
    t
  );
  if (memory) {
    prompt +=
      "\n\n【教练长期记忆（你此前记录过的要点，时间越近越可靠）】\n" + memory;
  }
  const text = await chatCompletion(
    [
      {
        role: "system",
        content:
          "你是一位要求严格的自行车教练，为业余骑友写每日训练建议。先挑问题、再给方案，禁止任何没有数据支撑的夸赞与鼓励套话（不写“很棒/不错/继续保持”），结尾不给安慰只给动作。要求：直接、有判断、不客套；每条判断都要「引用他的真实数字 → 下结论 → 今天具体怎么做」；抓主要矛盾，只挑最有信息量的 2-3 个数字，不要逐项念指标；必须针对最近一次训练暴露的具体短板安排课程，不要给万能 Z2；功率一律换算成瓦数区间，骑行台用室内 FTP、户外用 FTP；禁止编造数据。" +
          (opts.ignoreTime
            ? "本次为纯数据补强模式：不要因为时段或带娃限制压低剂量，按短板给最该练的课；只在时段那一行注明这节需要整块时间。"
            : "") +
          "排课时必须同时检查强度与时长：晚间（21:30 起）不超过 60 分钟可上到阈值或 VO2max，60-90 分钟最高到甜区（FTP 的 85-90），90-120 分钟只做 Z2（FTP 的 70 以内），超过 120 分钟晚间不给，想骑 120 分钟就挪白天或午睡窗口。不要默认 60 分钟，也不要所有课都一个时长。" +
          "输出必须落到可执行：给逐段清单（热身/主段/组间/放松，每段写确切分钟数、瓦数区间、踏频），读者照着骑不准需要自己换算；禁止只写“Z2 40 分钟”而不给瓦数。" +
          "判断“今天练不练”时遵循：发烧/发冷/胸闷/静息心悸/全身酸痛→建议休息；HRV 一晚偏低不砍课，连续 2 天偏低且主观也差才降档；空气质量看 PM2.5 数值（35-75 质量课改室内或砍轻松，75 以上不户外高强度）；恢复骑也是负荷不是休息。",
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
