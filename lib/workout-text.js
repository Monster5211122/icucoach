// 把 steps 数组转成 ICU 能解析的结构化课表文本（一段一行：# 段名 / - 12m 90%）
// 日历里只接受这种格式，散文一律拒绝。
export function workoutTextFromSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return "";
  return steps
    .map((sg) => {
      const mins = Number(sg && (sg.minutes != null ? sg.minutes : sg.min));
      if (!Number.isFinite(mins) || mins <= 0) return "";
      const raw = sg.pct != null ? sg.pct : sg.power != null ? sg.power : sg.percent;
      let power = "";
      if (Array.isArray(raw) && raw.length >= 2) {
        const a = Number(raw[0]);
        const b = Number(raw[1]);
        power = Number.isFinite(a) && Number.isFinite(b) && a !== b ? `ramp ${a}-${b}%` : `${a}%`;
      } else if (raw != null && Number.isFinite(Number(raw))) {
        power = `${Number(raw)}%`;
      }
      if (!power) return "";
      const label = sg.label ? `# ${String(sg.label).slice(0, 40)}\n` : "";
      return `${label}- ${mins}m ${power}`;
    })
    .filter(Boolean)
    .join("\n");
}
