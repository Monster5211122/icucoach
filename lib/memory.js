// 教练长期记忆：把复盘/对话中的重要结论记在 ICU「AI 教练记忆」便签里
// 每次写入自动清理超过保留天数的旧条目；读取时也按保留天数过滤（改设置立即生效）

export const MEMORY_NOTE_NAME = "AI 教练记忆";
export const MEMORY_EXTERNAL_ID = "ai-coach-memory";
const MAX_ENTRIES = 40; // 便签里最多保留的条数（防止无限膨胀）

// 本地日期（Asia/Shanghai，北京时间）
export function todayLocal() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function daysAgoDate(n) {
  return new Date(Date.now() - n * 86400000 + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
}

// 解析记忆文本："YYYY-MM-DD | 内容" 每行一条
export function parseEntries(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d{4}-\d{2}-\d{2})\s*[|｜]\s*(.+)$/);
      return m ? { date: m[1], text: m[2] } : { date: "", text: l };
    })
    .filter((e) => e.text);
}

export function formatEntries(entries) {
  return entries.map((e) => `${e.date} | ${e.text}`).join("\n");
}

// 读记忆便签（不存在返回 null）
export async function getMemory(icu) {
  const oldest = daysAgoDate(400);
  const evs = await icu.events({ oldest });
  if (!Array.isArray(evs)) return null;
  const note = evs.find(
    (e) => e.external_id === MEMORY_EXTERNAL_ID || e.name === MEMORY_NOTE_NAME
  );
  return note ? { text: note.description || "" } : null;
}

// 追加一条记忆（自动加日期、去重、按保留天数清理）
export async function appendMemory(icu, text, retentionDays = 48) {
  const t = todayLocal();
  const clean = String(text || "").trim().slice(0, 200);
  if (!clean) return null;

  const existing = await getMemory(icu).catch(() => null);
  let entries = existing ? parseEntries(existing.text) : [];
  const cutoff = daysAgoDate(retentionDays);
  entries = entries.filter((e) => e.date >= cutoff);

  // 去重：同一天完全相同的内容不重复记
  const dup = entries.some((e) => e.date === t && e.text === clean);
  if (!dup) entries.push({ date: t, text: clean });
  entries = entries.slice(-MAX_ENTRIES);

  const desc = formatEntries(entries);
  await icu.upsertEvents([
    {
      category: "NOTE",
      name: MEMORY_NOTE_NAME,
      description: desc,
      start_date_local: t + "T00:00:00",
      external_id: MEMORY_EXTERNAL_ID,
      color: "orange",
    },
  ]);
  return desc;
}

// 给模型用的记忆上下文（保留天数内的最近若干条）
export async function memoryContext(icu, retentionDays = 48) {
  const m = await getMemory(icu).catch(() => null);
  if (!m || !m.text) return "";
  const cutoff = daysAgoDate(retentionDays);
  const entries = parseEntries(m.text).filter((e) => e.date >= cutoff);
  if (entries.length === 0) return "";
  return entries
    .slice(-12)
    .map((e) => `${e.date} | ${e.text}`)
    .join("\n");
}
