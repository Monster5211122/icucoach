// ICU AI 教练 —— 前端逻辑（零依赖）

const $ = (id) => document.getElementById(id);

// ---------- 通用 ----------
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

function showLoading(on) {
  $("loading").classList.toggle("hidden", !on);
}

// ---------- 设置存取（ICU API Key 只存在本机浏览器） ----------
const SETTINGS_KEY = "icucoach-settings";
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function requestHeaders(extra = {}) {
  const s = loadSettings();
  const h = { "Content-Type": "application/json", ...extra };
  if (s.apiKey) h["x-icu-api-key"] = s.apiKey;
  if (s.athleteId) h["x-icu-athlete-id"] = s.athleteId;
  if (s.memoryDays) h["x-memory-days"] = String(s.memoryDays);
  if (Array.isArray(s.planWindows) && s.planWindows.length && s.planWindows.join(",") !== "night")
    h["x-plan-windows"] = s.planWindows.join(",");
  if (s.planDuration != null) h["x-plan-duration"] = String(s.planDuration);
  if (s.ignoreTime) h["x-plan-ignore-time"] = "1";
  if (s.llmThinking) {
    if (s.llmThinking === "auto") {
      h["x-llm-thinking"] = "auto";
      h["x-llm-effort"] = "auto";
    } else {
      h["x-llm-thinking"] = s.llmThinking === "off" ? "off" : "on";
      h["x-llm-effort"] = s.llmThinking === "off" ? "" : s.llmThinking;
    }
  }
  // 模型配置（页面设置 > 服务器环境变量）与访问口令（防他人恶意调用）
  if (s.llmProvider) h["x-llm-provider"] = s.llmProvider;
  if (s.llmApiKey) h["x-llm-api-key"] = s.llmApiKey;
  if (s.llmBaseUrl) h["x-llm-base-url"] = s.llmBaseUrl;
  if (s.llmModel) h["x-llm-model"] = s.llmModel;
  if (s.accessToken) h["x-access-token"] = s.accessToken;
  return h;
}

async function api(path, opts = {}) {
  // 90 秒超时保护：后端卡住时不再无限转圈，明确报错
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: requestHeaders(opts.headers),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("请求超时（90 秒无响应），请下拉刷新后重试");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || `请求失败（${res.status}）`);
  }
  return data;
}

// 极简 Markdown 渲染（标题/列表/加粗/行内代码）
function renderMarkdown(text) {
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = "";
  const lines = String(text).split("\n");
  let inList = false;
  for (let line of lines) {
    const l = line.trimEnd();
    if (/^##\s+/.test(l)) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h2>${esc(l.replace(/^##\s+/, ""))}</h2>`;
    } else if (/^###\s+/.test(l)) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h3>${esc(l.replace(/^###\s+/, ""))}</h3>`;
    } else if (/^\s*[-*]\s+/.test(l)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`;
    } else if (/^\s*\d+\.\s+/.test(l)) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${inline(l)}</p>`;
    } else if (l.trim() === "") {
      if (inList) { html += "</ul>"; inList = false; }
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${inline(l)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}
function inline(s) {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

// ---------- 标签页切换 ----------
function switchView(name) {
  document.body.classList.toggle("chat-mode", name === "chat");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("view-" + name).classList.remove("hidden");
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === name)
  );
  if (name === "analyze") populateSingleSelect();
  if (name === "chat" && typeof renderThinkButton === "function") renderThinkButton();
}

// ---------- 概览 ----------
let overviewActivities = [];

// 用概览返回的活动列表填充「单次/多次复盘」的多选列表
function populateSingleSelect() {
  const box = $("single-list");
  if (!box) return;
  const rides = (overviewActivities || [])
    .filter((a) => /ride/i.test(a.type || ""))
    .slice()
    .sort((x, y) => String(y.start_date_local || "").localeCompare(String(x.start_date_local || "")))
    .slice(0, 15);
  if (rides.length === 0) return;
  const prev = new Set(
    Array.from(box.querySelectorAll("input[type=checkbox]"))
      .filter((b) => b.checked)
      .map((b) => b.value)
  );
  box.innerHTML = rides
    .map((a) => {
      const d = String(a.start_date_local || "").slice(5, 10).replace("-", "/");
      const mins = a.moving_time ? Math.round(a.moving_time / 60) + "min" : "";
      const tss = a.icu_training_load ? "TSS " + a.icu_training_load : "";
      const np = a.icu_weighted_avg_watts ? a.icu_weighted_avg_watts + "W" : "";
      const checked = prev.has(a.id) ? " checked" : "";
      return `<label class="pick-item"><input type="checkbox" value="${a.id}"${checked} /><span>${d} ${escapeHtml(
        a.name || a.type || "训练"
      )}${mins ? " · " + mins : ""}${tss ? " · " + tss : ""}${np ? " · NP " + np : ""}</span></label>`;
    })
    .join("");
}

async function loadOverview() {
  try {
    const d = await api("/api/overview");
    overviewActivities = d.activities || [];
    populateSingleSelect();
    renderOverview(d);
  } catch (e) {
    $("overview-hint").textContent = "加载失败：" + e.message;
  }
}

function renderOverview(d) {
  if (typeof renderStatusStrip === "function") renderStatusStrip(d);
  const f = d.fitness || {};
  $("stat-ctl").textContent = f.ctl ?? "—";
  $("stat-atl").textContent = f.atl ?? "—";
  const form = f.form;
  const formEl = $("stat-form");
  formEl.textContent = form ?? "—";
  formEl.className = "stat-num" + (typeof form === "number" ? (form >= 0 ? " form-pos" : " form-neg") : "");

  $("stat-ftp").textContent = d.profile?.ftp ? d.profile.ftp + " W" : "—";
  $("stat-weight").textContent = d.profile?.weight ? d.profile.weight + " kg" : "—";

  const w = d.wellness && d.wellness[0];
  $("stat-readiness").textContent = w?.readiness != null ? w.readiness + "%" : "—";
  $("stat-rhr").textContent = w?.restingHR != null ? w.restingHR + " bpm" : "—";

  const lastEl = $("stat-last");
  if (d.empty_days == null) {
    lastEl.textContent = "—";
  } else {
    const date = d.last_training_date ? d.last_training_date.slice(5).replace("-", "/") + " " : "";
    lastEl.textContent =
      date + "· 空窗 " + d.empty_days + " 天" + (d.empty_days >= 2 ? "（别断练）" : "");
  }

  const errs = ["profile", "fitness", "wellness", "activities"].filter((k) => d[k + "_error"]);
  $("overview-hint").textContent = errs.length
    ? "部分数据获取失败：" + d[errs[0] + "_error"]
    : "数据来自 Intervals.icu";

  renderDaily(d.daily);
}

// 今日建议
function renderDaily(daily) {
  if (daily && daily.text) {
    $("daily-text").innerHTML = renderMarkdown(daily.text);
    $("daily-date").textContent = daily.date ? "（" + daily.date + "）" : "";
    $("daily-hint").classList.add("hidden");
  } else {
    $("daily-text").textContent = "今日建议还没生成";
    $("daily-hint").textContent = "正在后台生成（约十几秒），稍后点右上角「刷新」查看。";
    $("daily-hint").classList.remove("hidden");
    ensureDaily();
  }
}

let dailyGenerating = false;
async function ensureDaily() {
  if (dailyGenerating) return;
  dailyGenerating = true;
  try {
    await api("/api/daily-suggestion", { method: "POST", body: "{}" });
    renderOverview(await api("/api/overview"));
  } catch (e) {
    $("daily-hint").textContent = "今日建议生成失败：" + e.message;
    $("daily-hint").classList.remove("hidden");
  } finally {
    dailyGenerating = false;
  }
}

$("btn-daily-regen").addEventListener("click", async () => {
  showLoading(true);
  try {
    await api("/api/daily-suggestion", {
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    renderOverview(await api("/api/overview"));
    toast("已重新生成今日建议");
  } catch (e) {
    toast("生成失败：" + e.message);
  } finally {
    showLoading(false);
  }
});

// ---------- 单次 / 多次复盘 ----------
$("btn-single").addEventListener("click", async () => {
  const boxes = Array.from(document.querySelectorAll("#single-list input[type=checkbox]"));
  const ids = boxes.filter((b) => b.checked).map((b) => b.value);
  if (!ids.length) {
    toast("先勾至少一次训练；列表是空的话，去概览页刷新一次再回来");
    return;
  }
  if (ids.length > 6) {
    toast("最多选 6 节，先少选几节");
    return;
  }
  showLoading(true);
  try {
    const s = loadSettings();
    const d = await api("/api/coach", {
      method: "POST",
      body: JSON.stringify({
        action: "analyze_single",
        activityIds: ids,
        persona: s.persona || undefined,
        customPrompt: s.customPrompt || undefined,
      }),
    });
    const list = d.activities && d.activities.length ? d.activities : [d.activity].filter(Boolean);
    $("single-title").textContent =
      list.length === 1 ? "训练结果 · " + (list[0].name || "") : `训练结果 · 已选 ${list.length} 节`;

    const block = (a) => {
      const rows = [
        ["日期", a.date ? String(a.date).slice(0, 16).replace("T", " ") : "—"],
        ["场景 / 时长", `${a.trainer ? "骑行台" : "户外"} · ${a.duration_min ?? "—"} min${a.distance_km ? " / " + a.distance_km + " km" : ""}`],
        ["TSS / IF", `${a.tss ?? "—"}${a.intensity != null ? " / " + Math.round(a.intensity) + "%" : ""}`],
        ["NP / 均功率", `${a.np ?? "—"} W / ${a.avg_power ?? "—"} W`],
        ["VI / EF", `${a.vi != null ? Number(a.vi).toFixed(2) : "—"} / ${a.ef != null ? Number(a.ef).toFixed(2) : "—"}`],
        ["平均 / 最大心率", `${a.avg_hr != null ? Math.round(a.avg_hr) : "—"} / ${a.max_hr ?? "—"} bpm`],
        ["心率漂移", a.decoupling != null ? Number(a.decoupling).toFixed(1) + "%" : "—"],
        ["W' 消耗", a.wbal_depletion != null ? Math.round(a.wbal_depletion) + " J" : "—"],
        ["踏频", a.cadence != null ? Math.round(a.cadence) + " rpm" : "—"],
      ];
      const zoneRow =
        Array.isArray(a.zones) && a.zones.length
          ? `<div class="kv-row"><span>功率分区</span><b>${a.zones
              .map((z) => `${z.id} ${Math.round((z.secs || 0) / 60)}min`)
              .join("　")}</b></div>`
          : "";
      const html = rows.map(([k, v]) => `<div class="kv-row"><span>${k}</span><b>${v}</b></div>`).join("") + zoneRow;
      if (list.length === 1) return html;
      return `<div class="stat-block"><div class="stat-block-title">${a.date ? String(a.date).slice(5, 10).replace("-", "/") : ""} ${escapeHtml(a.name || "")}</div>${html}</div>`;
    };

    $("single-stats").innerHTML = list.map(block).join("");
    $("single-result").innerHTML = renderMarkdown(d.analysis || "");
    $("single-result-card").classList.remove("hidden");
    toast(list.length === 1 ? "单课复盘完成" : `多课复盘完成（${list.length} 节）`);
  } catch (e) {
    toast("复盘失败：" + e.message);
  } finally {
    showLoading(false);
  }
});

$("btn-single-clear").addEventListener("click", () => {
  document.querySelectorAll("#single-list input[type=checkbox]").forEach((b) => (b.checked = false));
});

// ---------- 复盘 ----------
$("btn-analyze").addEventListener("click", async () => {
  showLoading(true);
  try {
    const s = loadSettings();
    const body = {
      action: "analyze",
      days: Number($("analyze-days").value),
      focus: $("analyze-focus").value.trim() || undefined,
      rideOnly: $("analyze-rideonly").checked,
      persona: s.persona || undefined,
      customPrompt: s.customPrompt || undefined,
      memoryDays: s.memoryDays || undefined,
    };
    s.planWindows = body.windows;
    s.planDuration = body.maxDuration;
    saveSettings(s);
    const d = await api("/api/coach", { method: "POST", body: JSON.stringify(body) });
    $("analyze-result").innerHTML = renderMarkdown(d.result);
    $("analyze-result-card").classList.remove("hidden");
    toast("复盘已生成");
  } catch (e) {
    toast("生成失败：" + e.message);
  } finally {
    showLoading(false);
  }
});

// ---------- 课表 ----------
let pendingPlan = null; // { workouts, today, selected }

// 课表场景：骑行台(默认) / 路骑
// 元素不存在时静默跳过（防止旧缓存页面 + 新脚本混用时整页报错卡死）
let planMode = "indoor";
const modeIndoor = $("plan-mode-indoor");
const modeOutdoor = $("plan-mode-outdoor");
if (modeIndoor && modeOutdoor) {
  modeIndoor.addEventListener("click", () => {
    planMode = "indoor";
    modeIndoor.classList.add("active");
    modeOutdoor.classList.remove("active");
  });
  modeOutdoor.addEventListener("click", () => {
    planMode = "outdoor";
    modeOutdoor.classList.add("active");
    modeIndoor.classList.remove("active");
  });
}

// 课表可用时段（多选）：白天上午 / 白天下午 / 晚上 21:30 后
const windowsBox = $("plan-windows");
if (windowsBox) {
  windowsBox.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => btn.classList.toggle("active"));
  });
}
function applyPlanSettings() {
  const s = loadSettings();
  if (windowsBox && Array.isArray(s.planWindows) && s.planWindows.length) {
    windowsBox.querySelectorAll(".seg-btn").forEach((b) =>
      b.classList.toggle("active", s.planWindows.includes(b.dataset.w))
    );
  }
  const durSel = $("plan-duration");
  if (durSel && s.planDuration != null) durSel.value = String(s.planDuration);
}
function getPlanWindows() {
  if (!windowsBox) return ["night"];
  const picked = Array.from(windowsBox.querySelectorAll(".seg-btn.active")).map((b) => b.dataset.w);
  return picked.length ? picked : ["night"];
}

if (windowsBox) applyPlanSettings();

$("btn-plan").addEventListener("click", async () => {
  showLoading(true);
  try {
    const s = loadSettings();
    const daysValue = Number($("plan-days").value);
    const body = {
      action: "plan",
      goal: $("plan-goal").value.trim() || undefined,
      days: daysValue,
      startDate: $("plan-start").value || undefined,
      constraints: $("plan-constraints").value.trim() || undefined,
      mode: planMode,
      windows: getPlanWindows(),
      maxDuration: Number($("plan-duration") ? $("plan-duration").value : 0),
      persona: s.persona || undefined,
      customPrompt: s.customPrompt || undefined,
    };
    const d = await api("/api/coach", { method: "POST", body: JSON.stringify(body) });
    pendingPlan = { workouts: d.workouts, today: daysValue === 1, selected: null };
    $("plan-summary").innerHTML = d.summary ? renderMarkdown("**思路：** " + d.summary) : "";
    renderPlanList();
    $("plan-preview-card").classList.remove("hidden");
    toast(pendingPlan.today ? "已生成 3 节可选课，请按体感选一节" : "课表已生成，请预览");
  } catch (e) {
    toast("生成失败：" + e.message);
  } finally {
    showLoading(false);
  }
});

function renderWorkoutItem(w, i) {
  const isRest = w.type === "Rest";
  const today = pendingPlan && pendingPlan.today;
  const selected = pendingPlan && pendingPlan.selected === i;
  return `<div class="workout-item${selected ? " selected" : ""}">
    <div class="workout-head">
      <span class="workout-name">${escapeHtml(w.name)}</span>
      <span class="workout-type${isRest ? " rest" : ""}">${
        isRest ? "休息" : escapeHtml(w.intensity_label || "骑行")
      }</span>
    </div>
    <div class="workout-date">${w.start_date_local.slice(0, 10)}${w.intensity_label && !isRest ? " · " + escapeHtml(w.intensity_label) : ""}${w.moving_time ? " · 约 " + Math.round(w.moving_time / 60) + " 分钟" : ""}</div>
    ${isRest ? "" : `<div class="workout-desc">${escapeHtml(w.description || "")}</div>`}
    ${w.reason ? `<div class="workout-reason">为什么：${escapeHtml(w.reason)}</div>` : ""}
    ${today ? `<button class="pick-btn" data-i="${i}">${selected ? "已选这节 ✓" : "选这节"}</button>` : ""}
  </div>`;
}

function renderPlanList() {
  if (!pendingPlan) return;
  $("plan-list").innerHTML = pendingPlan.workouts
    .map((w, i) => renderWorkoutItem(w, i))
    .join("");
  $("btn-write").disabled = pendingPlan.today && pendingPlan.selected == null;
}

$("plan-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".pick-btn");
  if (!btn || !pendingPlan) return;
  pendingPlan.selected = Number(btn.dataset.i);
  renderPlanList();
});

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

$("btn-write").addEventListener("click", async () => {
  if (!pendingPlan) return;
  let list = pendingPlan.workouts;
  if (pendingPlan.today) {
    if (pendingPlan.selected == null) {
      toast("请先选一节课");
      return;
    }
    list = [list[pendingPlan.selected]];
  }
  if (list.length === 0) return;
  if (!confirm(`确定把这 ${list.length} 节课写回 Intervals.icu 日历吗？`)) return;
  showLoading(true);
  try {
    const d = await api("/api/workouts", {
      method: "POST",
      body: JSON.stringify({ workouts: list }),
    });
    toast(`已写入 ${d.count} 节课`);
    $("btn-write").disabled = true;
  } catch (e) {
    toast("写入失败：" + e.message);
  } finally {
    showLoading(false);
  }
});

// ---------- 对话 ----------
const CHAT_KEY = "icucoach-chat";
function loadChat() {
  try {
    const arr = JSON.parse(localStorage.getItem(CHAT_KEY));
    return Array.isArray(arr)
      ? arr.filter((m) => m && m.role && typeof m.content === "string").slice(-40)
      : [];
  } catch { return []; }
}
function saveChat() {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatMessages.slice(-40))); } catch { /* ignore */ }
}
let chatMessages = loadChat();
let chatSending = false;

function renderChat() {
  const wrap = $("chat-wrap");
  $("chat-hint").style.display = chatMessages.length ? "none" : "block";
  wrap.innerHTML = chatMessages
    .map((m, i) =>
      m.role === "user"
        ? `<div class="msg user" data-idx="${i}"><div class="msg-body">${escapeHtml(
            m.content
          )}</div><div class="msg-ops"><button class="msg-op" data-op="undo" data-idx="${i}">撤回</button><button class="msg-op" data-op="edit" data-idx="${i}">修改</button></div></div>`
        : `<div class="msg ai"><div class="markdown">${renderMarkdown(m.content)}</div>${pendingHtml(m, i)}</div>`
    )
    .join("");
  wrap.scrollTop = wrap.scrollHeight;
}

function pendingHtml(m, i) {
  if (!m || !Array.isArray(m.pending) || !m.pending.length || m.pendingDone) return "";
  const label = m.pending.map((p) => p.label || "写入").join("；");
  return `<div class="confirm-row"><button class="confirm-btn" data-confirm="${i}">确认写入 ICU</button><span class="confirm-note">${escapeHtml(
    label
  )}</span></div>`;
}

async function confirmWrite(idx) {
  const m = chatMessages[idx];
  if (!m || !Array.isArray(m.pending) || m.pendingDone) return;
  const items = m.pending.slice();
  const btn = document.querySelector(`[data-confirm="${idx}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "写入中…";
  }
  const results = [];
  try {
    for (const p of items) {
      const d = await api("/api/apply-write", { method: "POST", body: JSON.stringify(p) });
      if (p.kind === "workouts") {
        results.push(`已写入 ${d.written.length} 节：` + d.written.map((w) => `${w.name}（${w.date}，TSS ${w.tss ?? "?"}）`).join("、"));
      } else {
        results.push(d.changed ? "已写回「AI复盘已完成」标记" : "已经是已复盘状态");
      }
    }
    m.content += "\n\n**写入结果**\n\n" + results.map((r) => "- " + r).join("\n");
    m.pendingDone = true;
    toast("已写入 ICU");
  } catch (e) {
    m.content += "\n\n写入失败：" + e.message;
    toast("写入失败：" + e.message);
  } finally {
    saveChat();
    renderChat();
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest ? e.target.closest("[data-confirm]") : null;
  if (!b) return;
  confirmWrite(Number(b.dataset.confirm));
});

async function sendChat() {
  if (chatSending) return;
  const text = $("chat-input").value.trim();
  if (!text) return;
  chatMessages.push({ role: "user", content: text });
  renderChat();
  $("chat-input").value = "";
  chatSending = true;
  [chipsBox, checkinBox].forEach((b) => b && b.querySelectorAll(".chip").forEach((c) => (c.disabled = true)));
  const typing = document.createElement("div");
  typing.className = "msg ai typing";
  typing.textContent = "教练正在思考…";
  $("chat-wrap").appendChild(typing);
  $("chat-wrap").scrollTop = $("chat-wrap").scrollHeight;
  try {
    const s = loadSettings();
    const d = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: chatMessages.slice(-20),
        persona: s.persona || undefined,
        customPrompt: s.customPrompt || undefined,
        memoryDays: s.memoryDays || undefined,
      }),
    });
    chatMessages.push({
      role: "assistant",
      content: d.reply,
      pending: Array.isArray(d.pending) && d.pending.length ? d.pending : null,
    });
    saveChat();
    renderChat();
  } catch (e) {
    chatMessages.push({ role: "assistant", content: "（发送失败：" + e.message + "）" });
    renderChat();
  } finally {
    typing.remove();
    chatSending = false;
    [chipsBox, checkinBox].forEach((b) => b && b.querySelectorAll(".chip").forEach((c) => (c.disabled = false)));
  }
}

// 对话即主界面，不再需要浮层开关
const chipsBox = $("chat-chips");
const checkinBox = $("chat-checkin");
[...(chipsBox ? [chipsBox] : []), ...(checkinBox ? [checkinBox] : [])].forEach((box) => {
  box.querySelectorAll(".chip[data-say]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const say = chip.dataset.say || chip.textContent;
      const input = $("chat-input");
      if (input) input.value = say;
      sendChat();
    });
  });
});

// 长按消息 → 显示「撤回 / 修改」；点别处收起
let lpTimer = null;
const clearLp = () => {
  if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
};
const hideMsgOps = () =>
  document.querySelectorAll(".msg.show-ops").forEach((m) => m.classList.remove("show-ops"));

const chatWrap = $("chat-wrap");
chatWrap.addEventListener("pointerdown", (e) => {
  const msg = e.target.closest(".msg.user");
  if (!msg) return;
  clearLp();
  lpTimer = setTimeout(() => {
    hideMsgOps();
    msg.classList.add("show-ops");
    if (navigator.vibrate) navigator.vibrate(10);
  }, 450);
});
chatWrap.addEventListener("pointerup", clearLp);
chatWrap.addEventListener("pointercancel", clearLp);
chatWrap.addEventListener("pointermove", clearLp);
chatWrap.addEventListener("scroll", clearLp);

// 鼠标右键（电脑上）同样弹出「撤回 / 修改」
chatWrap.addEventListener("contextmenu", (e) => {
  const msg = e.target.closest(".msg.user");
  if (!msg) return; // 非消息区域保留系统菜单（如粘贴）
  e.preventDefault();
  hideMsgOps();
  msg.classList.add("show-ops");
});

document.addEventListener("click", (e) => {
  if (e.target.closest(".msg-op")) return;
  if (e.target.closest(".msg.show-ops")) return;
  hideMsgOps();
});

// 撤回（删掉这条及之后的对话）与修改（放回输入框再改）
$("chat-wrap").addEventListener("click", (e) => {
  const btn = e.target.closest(".msg-op");
  if (!btn || chatSending) return;
  const idx = Number(btn.dataset.idx);
  if (!Number.isFinite(idx) || idx < 0 || idx >= chatMessages.length) return;
  const text = chatMessages[idx].content;

  if (btn.dataset.op === "edit") {
    // 修改：把这条放回输入框，并把它和它之后的回复一起撤掉
    chatMessages = chatMessages.slice(0, idx);
    saveChat();
    renderChat();
    $("chat-input").value = text;
    $("chat-input").focus();
    toast("已放回输入框，改完再发");
    return;
  }

  // 撤回：删掉这条及其后的所有消息
  if (!confirm("撤回这条？它后面的对话也会一起删掉。")) return;
  chatMessages = chatMessages.slice(0, idx);
  saveChat();
  hideMsgOps();
  renderChat();
});

// 对话页的「补强」开关：切换即时生效，写入设置并作用于后续提问
const chatIgnore = $("chat-ignore-time");
function syncChatIgnore() {
  if (!chatIgnore) return;
  chatIgnore.checked = !!loadSettings().ignoreTime;
}
if (chatIgnore) {
  chatIgnore.addEventListener("change", () => {
    const s = loadSettings();
    s.ignoreTime = chatIgnore.checked;
    saveSettings(s);
    if (typeof syncPrefs === "function") syncPrefs();
    toast(chatIgnore.checked ? "补强模式已开：只按短板给课" : "补强模式已关：按你的可用时段排");
  });
}

// ---------- 模型思考等级（按厂商只给支持的档位） ----------
const THINK_LABEL = {
  auto: "自动（按复杂度选档）",
  default: "跟随模型默认",
  off: "关闭思考",
  low: "低",
  high: "高",
  max: "最高",
};
let llmInfo = null; // {provider, model}

function thinkCapability(provider, model) {
  const p = String(provider || "").toLowerCase();
  const m = String(model || "").toLowerCase();
  if (p === "deepseek") {
    return {
      levels: ["auto", "default", "off", "low", "high", "max"],
      note: "DeepSeek：关闭=不思考（更快更省）；低/高/最高对应 reasoning_effort。思考模式下 temperature 不生效。",
    };
  }
  if (p === "volcano") {
    return {
      levels: ["auto", "default", "off", "low", "high", "max"],
      note: "火山方舟（豆包）：关闭=thinking none；低/高/最高对应 reasoning_effort。",
    };
  }
  if (p === "moonshot") {
    const isK3 = m.includes("k3");
    return isK3
      ? {
          levels: ["auto", "default", "low", "high", "max"],
          note: "Kimi K3 始终思考、不能关闭，只能调档；选「关闭」不会生效。",
        }
      : {
          levels: ["auto", "default", "off", "low", "high", "max"],
          note: "Kimi K2.x：可以关闭思考；开启时可调 reasoning_effort。",
        };
  }
  if (p === "openai") {
    const isReasoning =
      /^(o[1-9]|gpt-5|chatgpt-5)/.test(m) || m.includes("o3") || m.includes("o4");
    return isReasoning
      ? { levels: ["auto", "default", "low", "high"], note: "o 系列 / gpt-5 支持 reasoning_effort；「最高」会自动降为 high。" }
      : { levels: [], note: "当前模型（如 gpt-4o）没有思考参数，档位不会生效；换 o 系列或 gpt-5 才有用。" };
  }
  return {
    levels: [],
    note: "自定义厂商只发通用参数，思考档位不生效（除非它自己兼容 reasoning_effort）。",
  };
}

function thinkLevel() {
  const v = loadSettings().llmThinking || "default";
  return THINK_LABEL[v] ? v : "default";
}

function renderThinkButton() {
  const btn = $("btn-chat-think");
  if (!btn) return;
  const provider = (llmInfo && llmInfo.provider) || loadSettings().llmProvider || "deepseek";
  const model = (llmInfo && llmInfo.model) || loadSettings().llmModel || "";
  const cap = thinkCapability(provider, model);
  const lv = thinkLevel();
  if (!cap.levels.length) {
    btn.textContent = "思考·不支持";
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  btn.textContent =
    "思考·" +
    (lv === "auto" ? "自动" : lv === "default" ? "默认" : THINK_LABEL[lv]);
}

function renderThinkSheet() {
  const provider = (llmInfo && llmInfo.provider) || loadSettings().llmProvider || "deepseek";
  const model = (llmInfo && llmInfo.model) || loadSettings().llmModel || "";
  const cap = thinkCapability(provider, model);
  const lv = thinkLevel();
  $("think-provider").textContent = `当前：${provider}${model ? " · " + model : ""}`;
  $("think-note").textContent = cap.note;
  const box = $("think-opts");
  if (!cap.levels.length) {
    box.innerHTML = `<button class="think-opt" disabled>这个模型没有思考档位</button>`;
    return;
  }
  box.innerHTML = cap.levels
    .map(
      (k) => `<button class="think-opt${k === lv ? " active" : ""}" data-level="${k}">
        <span>${THINK_LABEL[k]}</span>${k === lv ? "<i>已选</i>" : ""}
      </button>`
    )
    .join("");
  box.querySelectorAll(".think-opt").forEach((b) => {
    b.addEventListener("click", () => {
      const s = loadSettings();
      s.llmThinking = b.dataset.level;
      saveSettings(s);
      const sel = $("set-thinking");
      if (sel) sel.value = b.dataset.level;
      renderThinkButton();
      closeSheet();
      toast("思考等级：" + THINK_LABEL[b.dataset.level]);
    });
  });
}

function openSheet() {
  renderThinkSheet();
  $("think-sheet").classList.remove("hidden");
}
function closeSheet() {
  $("think-sheet").classList.add("hidden");
}
if ($("btn-chat-think")) {
  $("btn-chat-think").addEventListener("click", openSheet);
  $("think-sheet").addEventListener("click", (e) => {
    if (e.target.dataset.close) closeSheet();
  });
}

// 启动时问后端当前真正生效的厂商/模型（设置选「跟随服务器」也能判断对）
api("/api/coach?action=llm_info")
  .then((d) => {
    if (d && d.ok) llmInfo = { provider: d.provider, model: d.model };
  })
  .catch(() => {})
  .then(() => renderThinkButton());

$("btn-chat-send").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
$("btn-chat-clear").addEventListener("click", () => {
  if (chatMessages.length === 0 || confirm("清空当前对话？")) {
    chatMessages = [];
    saveChat();
    renderChat();
  }
});

// ---------- 模型选择 ----------
// 常用模型列表（下拉选择）；火山方舟的模型是用户自建「推理接入点」，无法枚举，保持手动输入
const MODEL_OPTIONS = {
  deepseek: [
    { v: "deepseek-flash", t: "deepseek-flash（V4.1，推荐）" },
    { v: "deepseek-v4-pro", t: "deepseek-v4-pro（旗舰，更贵）" },
    { v: "deepseek-chat", t: "deepseek-chat（旧名，非思考·更快）" },
    { v: "deepseek-reasoner", t: "deepseek-reasoner（旧名，深度思考）" },
  ],
  openai: [
    { v: "gpt-4o-mini", t: "gpt-4o-mini（默认，性价比）" },
    { v: "gpt-4o", t: "gpt-4o" },
    { v: "gpt-4.1", t: "gpt-4.1" },
    { v: "gpt-4.1-mini", t: "gpt-4.1-mini" },
  ],
  moonshot: [
    { v: "moonshot-v1-8k", t: "moonshot-v1-8k（默认）" },
    { v: "moonshot-v1-32k", t: "moonshot-v1-32k" },
    { v: "moonshot-v1-128k", t: "moonshot-v1-128k" },
    { v: "kimi-k2-0711-preview", t: "kimi-k2-0711-preview（K2）" },
  ],
};

// 根据所选服务商刷新模型下拉框（无列表的服务商显示手动输入框）
function updateModelSelect(saved) {
  const provider = $("set-llm-provider").value;
  const list = MODEL_OPTIONS[provider];
  const sel = $("set-llm-model-select");
  const txt = $("set-llm-model");
  if (!list) {
    sel.classList.add("hidden");
    txt.classList.remove("hidden");
    if (saved) txt.value = saved;
    return;
  }
  sel.classList.remove("hidden");
  txt.classList.add("hidden");
  const opts = [
    { v: "", t: "留空用默认模型" },
    ...list,
    { v: "__custom__", t: "手动输入其它模型名…" },
  ];
  sel.innerHTML = opts.map((o) => `<option value="${o.v}">${o.t}</option>`).join("");
  if (saved && list.some((o) => o.v === saved)) {
    sel.value = saved;
  } else if (saved) {
    sel.value = "__custom__";
    txt.value = saved;
    txt.classList.remove("hidden");
  } else {
    sel.value = "";
  }
}

// 读取最终模型名（下拉值或手动输入）
function readModelValue() {
  const sel = $("set-llm-model-select");
  if (!sel.classList.contains("hidden")) {
    if (sel.value === "__custom__") return $("set-llm-model").value.trim();
    return sel.value;
  }
  return $("set-llm-model").value.trim();
}

$("set-llm-provider").addEventListener("change", () => updateModelSelect());

// 密码框「显示/隐藏」：点显示时若框里没内容，先把本机已保存的值填进去
document.querySelectorAll(".btn-eye").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.for);
    const saved = loadSettings()[btn.dataset.key] || "";
    if (input.type === "text") {
      if (saved && input.value === saved) input.value = "";
      input.type = "password";
      btn.textContent = "显示";
    } else {
      if (!input.value && saved) input.value = saved;
      input.type = "text";
      btn.textContent = "隐藏";
    }
  });
});

// ---------- 设置 ----------
function loadSettingsIntoForm() {
  const s = loadSettings();
  if (s.athleteId) $("set-athlete").value = s.athleteId;
  if (s.persona) $("set-persona").value = s.persona;
  if (s.customPrompt) $("set-custom-prompt").value = s.customPrompt;
  if (s.memoryDays) $("set-memory-days").value = s.memoryDays;
  if (s.llmProvider) $("set-llm-provider").value = s.llmProvider;
  if (s.llmBaseUrl) $("set-llm-base").value = s.llmBaseUrl;
  const thinkSel = $("set-thinking");
  if (thinkSel && s.llmThinking) thinkSel.value = s.llmThinking;
  const ignoreBox = $("set-ignore-time");
  if (ignoreBox) ignoreBox.checked = !!s.ignoreTime;
  const autoReviewBox = $("set-auto-review");
  if (autoReviewBox) autoReviewBox.checked = !!s.autoReview;
  const dailyAutoBox = $("set-daily-auto");
  if (dailyAutoBox) dailyAutoBox.checked = s.dailyAuto !== false;
  updateModelSelect(s.llmModel || "");
  $("set-apikey").placeholder = s.apiKey
    ? "已保存（留空则不变，重新输入可更换）"
    : "留空则用服务器配置的 Key";
  $("set-llm-key").placeholder = s.llmApiKey
    ? "已保存（留空则不变，重新输入可更换）"
    : "留空则用服务器配置的密钥";
  $("set-access-token").placeholder = s.accessToken
    ? "已保存（留空则不变，重新输入可更换）"
    : "与服务器 ACCESS_TOKEN 一致；服务器没配就不用填";
}
$("btn-save-set").addEventListener("click", () => {
  const s = loadSettings();
  const k = $("set-apikey").value.trim();
  if (k) s.apiKey = k;
  if ($("set-athlete").value.trim()) s.athleteId = $("set-athlete").value.trim();
  s.persona = $("set-persona").value.trim();
  s.customPrompt = $("set-custom-prompt").value.trim();
  const md = Number($("set-memory-days").value);
  if (md >= 7 && md <= 365) s.memoryDays = md;
  // 模型与访问口令（同样只存本机）
  s.llmProvider = $("set-llm-provider").value;
  const lk = $("set-llm-key").value.trim();
  if (lk) s.llmApiKey = lk;
  if ($("set-llm-base").value.trim()) s.llmBaseUrl = $("set-llm-base").value.trim();
  const modelVal = readModelValue();
  if (modelVal) s.llmModel = modelVal;
  const thinkSel = $("set-thinking");
  if (thinkSel) s.llmThinking = thinkSel.value || "high";
  // 课表页的可用时段/时长上限也存下来，供每日建议复用
  if (windowsBox) s.planWindows = getPlanWindows();
  if ($("plan-duration")) s.planDuration = Number($("plan-duration").value);
  const ignoreBox = $("set-ignore-time");
  if (ignoreBox) s.ignoreTime = !!ignoreBox.checked;
  const autoReviewBox = $("set-auto-review");
  if (autoReviewBox) s.autoReview = !!autoReviewBox.checked;
  const dailyAutoBox = $("set-daily-auto");
  if (dailyAutoBox) s.dailyAuto = !!dailyAutoBox.checked;
  const at = $("set-access-token").value.trim();
  if (at) s.accessToken = at;
  saveSettings(s);
  $("set-apikey").value = "";
  $("set-llm-key").value = "";
  $("set-access-token").value = "";
  if (typeof syncPrefs === "function") syncPrefs(true);
  toast("已保存（设置已同步给定时任务）");
  loadSettingsIntoForm();
});

// 载入后台内置提示词到输入框，方便查看/续写
const btnLoadPrompt = $("btn-load-default-prompt");
if (btnLoadPrompt) {
  btnLoadPrompt.addEventListener("click", async () => {
    showLoading(true);
    try {
      const d = await api("/api/coach?action=default_prompt");
      if (d && d.prompt) {
        $("set-custom-prompt").value = d.prompt;
        toast("已载入内置提示词，可继续修改，记得点「保存」");
      }
    } catch (e) {
      toast("载入失败：" + e.message);
    } finally {
      showLoading(false);
    }
  });
}

$("btn-prompt-enhance").addEventListener("click", async () => {
  const seed = $("set-custom-prompt").value.trim();
  if (!seed) {
    toast("先在上面写几句你的想法，比如：教练严格、注重功率、多问体感");
    return;
  }
  showLoading(true);
  try {
    const d = await api("/api/prompt-enhance", {
      method: "POST",
      body: JSON.stringify({ input: seed }),
    });
    $("set-custom-prompt").value = d.prompt;
    toast("已生成完整提示词，可继续修改，记得点「保存」");
  } catch (e) {
    toast("生成失败：" + e.message);
  } finally {
    showLoading(false);
  }
});

// ---------- 把设置同步到 ICU（供 Vercel 定时任务读取） ----------
let prefsTimer = null;
function syncPrefs(immediate = false) {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(async () => {
    const s = loadSettings();
    try {
      await api("/api/prefs", {
        method: "POST",
        body: JSON.stringify({
          dailyAuto: s.dailyAuto !== false,
          windows: Array.isArray(s.planWindows) ? s.planWindows : [],
          maxDuration: Number(s.planDuration) || 0,
          ignoreTime: !!s.ignoreTime,
        }),
      });
    } catch (e) {
      // 同步失败不影响本地设置
    }
  }, immediate ? 0 : 800);
}

// ---------- 训练后自动复盘（设置里开才跑） ----------
let autoReviewRunning = false;
async function autoReviewOnce() {
  const s = loadSettings();
  if (!s.autoReview || autoReviewRunning) return;
  // 同一次打开 App 只跑一次
  if (sessionStorage.getItem("autoReviewDone") === "1") return;
  // 上次已复盘过的同一节不再重复花钱（标记没写回时靠这个去重）
  
  sessionStorage.setItem("autoReviewDone", "1");
  autoReviewRunning = true;

  const tip = document.createElement("div");
  tip.className = "msg ai typing";
  tip.textContent = "自动复盘最近一节训练…";
  $("chat-wrap").appendChild(tip);
  $("chat-wrap").scrollTop = $("chat-wrap").scrollHeight;

  try {
    const d = await api("/api/auto-review", {
      method: "POST",
      body: JSON.stringify({ lastId: localStorage.getItem("autoReviewedId") || null }),
    });
    if (d && d.reviewed && d.reviewed.analysis) {
      const head =
        `**自动复盘｜${d.reviewed.date} ${d.reviewed.name}**` +
        (d.reviewed.marked ? "（已在 ICU 标记为已复盘）" : "");
      chatMessages.push({
        role: "assistant",
        content: head.replace("（已在 ICU 标记为已复盘）", "") + "\n\n" + d.reviewed.analysis,
        pending: Array.isArray(d.pending) && d.pending.length ? d.pending : null,
      });
      localStorage.setItem("autoReviewedId", String(d.reviewed.id));
      saveChat();
    } else if (d && d.reason) {
      // 没有待复盘的，不打扰
    }
  } catch (e) {
    // 自动任务失败不弹错，避免开屏就被打断
  } finally {
    tip.remove();
    renderChat();
    autoReviewRunning = false;
    loadOverview();
  }
}

// ---------- 对话主界面 ----------
function renderStatusStrip(d) {
  const f = d?.fitness || {};
  const setVal = (id, v, digits) => {
    const el = $(id);
    if (!el) return;
    el.textContent = v == null ? "—" : digits ? Number(v).toFixed(digits) : String(v);
  };
  setVal("ss-ctl", f.ctl, 1);
  setVal("ss-atl", f.atl, 1);
  setVal("ss-form", f.form, 1);
  const week = $("ss-week");
  if (week) {
    const tss = d?.week_tss;
    const days = d?.week_days;
    week.textContent =
      tss == null
        ? "本周 TSS —"
        : `本周 TSS ${tss}${days ? ` · ${days} 天` : ""}`;
    week.className = "ss-item" + (typeof tss === "number" && tss < 120 ? " warn" : "");
  }
  const plan = $("ss-plan");
  if (plan) {
    const w = d?.today_workout;
    plan.textContent = w && w.name
      ? `今日：${w.name}`
      : "今日：日历空";
  }
  const last = $("ss-last");
  if (last) {
    if (d?.empty_days != null) {
      last.textContent =
        d.empty_days === 0
          ? "今天已练"
          : `空窗 ${d.empty_days} 天${d.empty_days >= 3 ? "（别断练）" : ""}`;
      last.className = "ss-item" + (d.empty_days >= 3 ? " warn" : "");
    } else {
      last.textContent = "—";
    }
  }
}

// ---------- 初始化 ----------
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchView(t.dataset.view))
);
$("btn-refresh").addEventListener("click", loadOverview);
$("btn-open-settings").addEventListener("click", () => switchView("settings"));
$("btn-open-review").addEventListener("click", () => switchView("analyze"));
$("btn-back-chat").addEventListener("click", () => switchView("chat"));
$("btn-back-chat-2").addEventListener("click", () => switchView("chat"));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// 默认开始日期设为今天（当天可选课表模式）
$("plan-start").value = new Date().toISOString().slice(0, 10);

loadSettingsIntoForm();
syncChatIgnore();
switchView("chat");
loadOverview();
autoReviewOnce();
renderChat();
