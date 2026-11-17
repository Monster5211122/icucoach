// 把「App 设置」同步到 ICU 日历里的一条 NOTE，供 Vercel 定时任务读取
// （手机上的设置存在浏览器里，cron 读不到，所以要落到 ICU 上做服务端副本）
const PREF_NAME = "AI 教练设置";
const PREF_EXT = "ai-coach-prefs";

function todayStr() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  return new Date(d.getTime() + off * 60000).toISOString().slice(0, 10);
}

export async function readPrefs(icu) {
  try {
    const d = new Date();
    const oldest = new Date(d.getTime() - 365 * 86400000).toISOString().slice(0, 10);
    const evs = await icu.events({ oldest, newest: todayStr() });
    const note = (evs || []).find(
      (e) => e.category === "NOTE" && (e.external_id === PREF_EXT || e.name === PREF_NAME)
    );
    if (!note || !note.description) return null;
    return JSON.parse(note.description);
  } catch {
    return null;
  }
}

export async function writePrefs(icu, prefs) {
  const t = todayStr();
  return icu.upsertEvents([
    {
      category: "NOTE",
      name: PREF_NAME,
      description: JSON.stringify(prefs),
      start_date_local: t + "T00:00:00",
      external_id: PREF_EXT,
      color: "blue",
    },
  ]);
}
