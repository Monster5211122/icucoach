// 把 steps 数组转成 ICU 能解析的结构化课表文本（一段一行：# 段名 / - 12m 90%）
// 日历里只接受这种格式，散文一律拒绝。
// ICU 训练格式（MyWhoosh / 码表都能解析）：段名单独一行，动作行以 - 开头，段与段之间空行
// Warm-up
// - 12m ramp 48-70% 88rpm
export function workoutTextFromSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return "";
  const blocks = steps
    .map((sg) => {
      const mins = Number(sg && (sg.minutes != null ? sg.minutes : sg.min));
      if (!Number.isFinite(mins) || mins <= 0) return "";
      const raw = sg.pct != null ? sg.pct : sg.power != null ? sg.power : sg.percent;
      let power = "";
      if (Array.isArray(raw) && raw.length >= 2) {
        const a = Number(raw[0]);
        const b = Number(raw[1]);
        if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
          // 只有递进段写 ramp a-b%；固定强度一律写单值（区间取中点），不给 ICU/码表留模糊区间
          power = sg.ramp ? `ramp ${a}-${b}%` : `${Math.round((a + b) / 2)}%`;
        } else power = `${a}%`;
      } else if (raw != null && Number.isFinite(Number(raw))) {
        power = `${Number(raw)}%`;
      }
      if (!power) return "";
      const cad = Number(sg.cad != null ? sg.cad : sg.cadence);
      const cadTxt = Number.isFinite(cad) && cad > 0 ? ` ${Math.round(cad)}rpm` : "";
      const label = String(sg.label || "").slice(0, 40).trim();
      return `${label ? label + "\n" : ""}- ${mins}m ${power}${cadTxt}`;
    })
    .filter(Boolean);
  return blocks.join("\n\n");
}
