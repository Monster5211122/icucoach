// 训练史里的「持续能力」：只看两类可核对的事实
// 1) 最近一次 FTP / CP20 测试：最长一段 WORK 有多长（判断 20 分钟撑不撑得住）
// 2) 最近 21 天里，≥88%FTP 的最长连续段（判断有没有真的连续输出）
// 数字全部来自 ICU 区间接口（icu_intervals），不做估算。
const TEST_RE = /(ftp\s*test|cp20|ftp\s*测试|功率测试|ftp测试)/i;

function minutes(sec) {
  return Math.round((Number(sec) || 0) / 6) / 10;
}
function watts(x) {
  return Math.round(Number(x) || 0);
}

export async function trainingHistory(icu, acts, profile) {
  const ftp = Number(profile?.indoor_ftp || profile?.ftp || 0) || 0;
  const list = (acts || [])
    .filter((a) => a && a.start_date_local)
    .sort((a, b) => String(b.start_date_local).localeCompare(String(a.start_date_local)));

  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const within = (a, n) => {
    const d = String(a.start_date_local).slice(0, 10);
    return (Date.parse(today) - Date.parse(d)) / 86400000 <= n;
  };

  // 最近一次测试（45 天内）
  const test = list.find((a) => TEST_RE.test(a.name || "") && within(a, 45)) || null;

  // 近 21 天最该看的几节高强度课（按 NP 排，最多 2 节，控制 API 调用）
  const hard = list
    .filter((a) => within(a, 21) && Number(a.icu_weighted_avg_watts) > 0)
    .sort((a, b) => Number(b.icu_weighted_avg_watts) - Number(a.icu_weighted_avg_watts))
    .slice(0, 2);

  const targets = [test, ...hard].filter(Boolean);
  const seen = new Set();
  const uniq = targets.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  const intervalSets = await Promise.all(
    uniq.map(async (a) => {
      try {
        const d = await icu.activityIntervals(a.id);
        return { act: a, intervals: Array.isArray(d?.icu_intervals) ? d.icu_intervals : [] };
      } catch (e) {
        return { act: a, intervals: [], error: String(e.message || e) };
      }
    })
  );

  let testLongest = null;
  let sustainedMax = null;
  const sustainedFloor = ftp ? ftp * 0.88 : 0;

  for (const set of intervalSets) {
    const isTest = test && set.act.id === test.id;
    for (const iv of set.intervals) {
      if (String(iv.type || "").toUpperCase() !== "WORK") continue;
      const m = minutes(iv.moving_time);
      const w = watts(iv.average_watts);
      if (isTest && (!testLongest || m > testLongest.min)) {
        testLongest = { min: m, watts: w, date: String(set.act.start_date_local).slice(0, 10) };
      }
      if (sustainedFloor && w >= sustainedFloor && (!sustainedMax || m > sustainedMax.min)) {
        sustainedMax = {
          min: m,
          watts: w,
          date: String(set.act.start_date_local).slice(0, 10),
          name: set.act.name || "",
        };
      }
    }
  }

  const thresholdSessions = list.filter(
    (a) => within(a, 21) && ftp && Number(a.icu_weighted_avg_watts) >= ftp * 0.85
  ).length;

  const weak = (testLongest && testLongest.min < 18) || (!sustainedMax || sustainedMax.min < 15);

  const basis = `FTP ${ftp || "?"}W；来源：ICU 区间接口；
测试${test ? ` ${String(test.start_date_local).slice(0, 10)}` : "无"}${testLongest ? ` 最长工作段 ${testLongest.min}min @${testLongest.watts}W` : ""}；
近21天 ≥88%FTP 最长连续段 ${sustainedMax ? `${sustainedMax.min}min @${sustainedMax.watts}W（${sustainedMax.date}）` : "无"}`;

  return {
    ftp,
    test: test
      ? {
          date: String(test.start_date_local).slice(0, 10),
          name: test.name || "",
          longest_min: testLongest ? testLongest.min : null,
          longest_w: testLongest ? testLongest.watts : null,
        }
      : null,
    sustained: sustainedMax,
    threshold_sessions_21d: thresholdSessions,
    weak_sustained: !!weak,
    basis,
  };
}
