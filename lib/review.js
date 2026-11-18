// 复盘标记与单课深度数据（对话工具的支撑逻辑）

export const MARKER = "[AI复盘已完成]";

// 活动是否已做过 AI 复盘
export function isReviewed(a) {
  return typeof a.description === "string" && a.description.includes(MARKER);
}

// 活动列表摘要（给模型的精简版，含已复盘状态）
export function summarizeActivity(a) {
  return {
    id: a.id,
    name: a.name || a.type || "训练",
    date: a.start_date_local,
    type: a.type || null,
    tss: a.icu_training_load ?? a.tss ?? null,
    reviewed: isReviewed(a),
  };
}

// 从心率流计算 HRRc：峰值后 60 秒内回落多少 bpm
function computeHrrc(hrStream) {
  const arr = (hrStream || []).filter((v) => Number.isFinite(v) && v > 30);
  if (arr.length < 120) return null;
  let maxIdx = 0;
  for (let i = 1; i < arr.length - 60; i++) {
    if (arr[i] > arr[maxIdx]) maxIdx = i;
  }
  if (maxIdx > arr.length - 61) return null;
  const peak = arr[maxIdx];
  let min = Infinity;
  for (let i = maxIdx; i <= maxIdx + 60; i++) {
    if (arr[i] < min) min = arr[i];
  }
  return Math.round(peak - min);
}

// 单课深度数据上下文（把原始 JSON 精简成模型易读的指标）
export function buildDeepContext(activity, streams) {
  const a = activity || {};
  // ICU 详情接口的真实字段名：icu_weighted_avg_watts(NP)、icu_average_watts、average_heartrate
  const np = a.icu_weighted_avg_watts ?? a.icu_normalized_power ?? null;
  const avgP = a.icu_average_watts ?? a.avg_power ?? null;
  const avgHr = a.average_heartrate ?? a.icu_avg_hr ?? a.avg_hr ?? null;

  // ICU 区间接口的真实字段：moving_time / average_watts / average_heartrate / average_cadence
  // 之前按 duration/power/heart_rate 取，全是 null，导致对话复盘只能给整课大概数
  let cursor = 0;
  const intervals = Array.isArray(a.icu_intervals)
    ? a.icu_intervals.slice(0, 30).map((it, i) => {
        const secs = Number(it.moving_time) || 0;
        const from = Math.round((cursor / 60) * 10) / 10;
        cursor += secs;
        const to = Math.round((cursor / 60) * 10) / 10;
        return {
          index: i + 1,
          type: String(it.type || "").toUpperCase() || null,
          start_min: from,
          end_min: to,
          duration_min: Math.round((secs / 60) * 10) / 10,
          avg_w: it.average_watts != null ? Math.round(Number(it.average_watts)) : null,
          np_w: it.weighted_average_watts != null ? Math.round(Number(it.weighted_average_watts)) : null,
          hr_avg: it.average_heartrate != null ? Math.round(Number(it.average_heartrate)) : null,
          hr_min: it.min_heartrate != null ? Math.round(Number(it.min_heartrate)) : null,
          hr_max: it.max_heartrate != null ? Math.round(Number(it.max_heartrate)) : null,
          cadence: it.average_cadence != null ? Math.round(Number(it.average_cadence)) : null,
          decoupling: it.decoupling != null ? Math.round(it.decoupling * 100) / 100 : null,
          zone: it.zone ?? null,
        };
      })
    : [];

  const out = {
    id: a.id,
    name: a.name,
    date: a.start_date_local,
    type: a.type,
    duration_min: a.moving_time ? Math.round(a.moving_time / 60) : null,
    tss: a.icu_training_load ?? null,
    intensity: a.icu_intensity ?? null,
    np,
    avg_power: avgP,
    vi: a.icu_variability_index ?? (np && avgP ? Math.round((np / avgP) * 100) / 100 : null),
    avg_hr: avgHr,
    max_hr: a.max_heartrate ?? a.icu_max_hr ?? a.max_hr ?? null,
    ef: a.icu_efficiency_factor ?? (np && avgHr ? Math.round((np / avgHr) * 100) / 100 : null),
    decoupling: a.decoupling ?? a.icu_pw_hr ?? a.icu_hr_decoupling ?? null,
    wbal_depletion: a.icu_max_wbal_depletion ?? null,
    ftp_model: a.icu_pm_ftp_watts ?? a.icu_pm_ftp ?? a.icu_rolling_ftp ?? null,
    joules_above_ftp: a.icu_joules_above_ftp ?? null,
    hrr_c: a.icu_hrr_c ?? null,
    intervals,
    reviewed: isReviewed(a),
  };

  // 流数据可用时补算 HRRc
  if (out.hrr_c == null && streams && Array.isArray(streams.heartrate)) {
    out.hrr_c = computeHrrc(streams.heartrate);
  }

  return out;
}

// 把活动标记为已复盘（写入 description，幂等）
export async function markReviewed(icu, activity, opts = {}) {
  const desc = (activity.description || "").trim();
  if (desc.includes(MARKER)) {
    return { changed: false, activity_id: activity.id };
  }
  const stamp = opts.when || new Date().toISOString().slice(0, 16).replace("T", " ");
  const sourceLine = `来源：icucoach · ${opts.source || "教练对话"}（${stamp}）`;
  const newDesc = desc
    ? desc + "\n\n" + MARKER + "\n" + sourceLine
    : MARKER + "\n" + sourceLine;
  await icu.updateActivity(activity.id, { description: newDesc });
  return { changed: true, activity_id: activity.id };
}
