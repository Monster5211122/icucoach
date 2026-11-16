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
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("view-" + name).classList.remove("hidden");
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === name)
  );
  if (name === "analyze") populateSingleSelect();
}

// ---------- 概览 ----------
let overviewActivities = [];

// 用概览返回的活动列表填充「单次复盘」下拉
function populateSingleSelect() {
  const sel = $("single-select");
  if (!sel) return;
  const rides = (overviewActivities || [])
    .filter((a) => /ride/i.test(a.type || ""))
    .slice()
    .sort((x, y) => String(y.start_date_local || "").localeCompare(String(x.start_date_local || "")))
    .slice(0, 15);
  if (rides.length === 0) return;
  sel.innerHTML = rides
    .map((a) => {
      const d = String(a.start_date_local || "").slice(5, 10).replace("-", "/");
      const mins = a.moving_time ? Math.round(a.moving_time / 60) + "min" : "";
      const tss = a.icu_training_load ? "TSS " + a.icu_training_load : "";
      return `<option value="${a.id}">${d} ${a.name || a.type || "训练"}${mins ? " · " + mins : ""}${tss ? " · " + tss : ""}</option>`;
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
  if (d.last_days == null) {
    lastEl.textContent = "—";
  } else {
    lastEl.textContent = d.last_days + " 天" + (d.last_days >= 2 ? "（别断练）" : "");
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

// ---------- 单次复盘 ----------
$("btn-single").addEventListener("click", async () => {
  const sel = $("single-select");
  const id = (sel && sel.value) || "";
  if (!id) {
    toast("先选一次训练；下拉是空的话，去概览页刷新一次再回来");
    return;
  }
  showLoading(true);
  try {
    const s = loadSettings();
    const d = await api("/api/coach", {
      method: "POST",
      body: JSON.stringify({
        action: "analyze_single",
        activityId: id,
        persona: s.persona || undefined,
        customPrompt: s.customPrompt || undefined,
      }),
    });
    const a = d.activity || {};
    $("single-title").textContent = "训练结果 · " + (a.name || "");
    const rows = [
      ["日期", a.date ? String(a.date).slice(0, 16).replace("T", " ") : "—"],
      ["场景", a.trainer ? "骑行台" : "户外"],
      ["时长 / 距离", `${a.duration_min ?? "—"} min${a.distance_km ? " / " + a.distance_km + " km" : ""}`],
      ["TSS / IF", `${a.tss ?? "—"}${a.intensity != null ? " / " + Math.round(a.intensity) + "%" : ""}`],
      ["NP / 平均功率", `${a.np ?? "—"} W / ${a.avg_power ?? "—"} W`],
      ["VI / EF", `${a.vi != null ? Number(a.vi).toFixed(2) : "—"} / ${a.ef != null ? Number(a.ef).toFixed(2) : "—"}`],
      ["平均 / 最大心率", `${a.avg_hr != null ? Math.round(a.avg_hr) : "—"} / ${a.max_hr ?? "—"} bpm`],
      ["心率漂移", a.decoupling != null ? Number(a.decoupling).toFixed(1) + "%" : "—"],
      ["W' 消耗", a.wbal_depletion != null ? Math.round(a.wbal_depletion) + " J" : "—"],
      ["踏频", a.cadence != null ? Math.round(a.cadence) + " rpm" : "—"],
    ];
    let zoneRow = "";
    if (Array.isArray(a.zones) && a.zones.length) {
      zoneRow =
        `<div class="kv-row"><span>功率分区时间</span><b>` +
        a.zones.map((z) => `${z.id} ${Math.round((z.secs || 0) / 60)}min`).join("　") +
        `</b></div>`;
    }
    $("single-stats").innerHTML =
      rows.map(([k, v]) => `<div class="kv-row"><span>${k}</span><b>${v}</b></div>`).join("") + zoneRow;
    $("single-result").innerHTML = renderMarkdown(d.analysis || "");
    $("single-result-card").classList.remove("hidden");
    toast("单次复盘完成");
  } catch (e) {
    toast("复盘失败：" + e.message);
  } finally {
    showLoading(false);
  }
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
      <span class="workout-type${isRest ? " rest" : ""}">${isRest ? "休息" : "骑行"}</span>
    </div>
    <div class="workout-date">${w.start_date_local.slice(0, 10)}</div>
    ${isRest ? "" : `<div class="workout-desc">${escapeHtml(w.description || "")}</div>`}
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
    .map((m) =>
      m.role === "user"
        ? `<div class="msg user">${escapeHtml(m.content)}</div>`
        : `<div class="msg ai"><div class="markdown">${renderMarkdown(m.content)}</div></div>`
    )
    .join("");
  wrap.scrollTop = wrap.scrollHeight;
}

async function sendChat() {
  if (chatSending) return;
  const text = $("chat-input").value.trim();
  if (!text) return;
  chatMessages.push({ role: "user", content: text });
  renderChat();
  $("chat-input").value = "";
  chatSending = true;
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
    chatMessages.push({ role: "assistant", content: d.reply });
    saveChat();
    renderChat();
  } catch (e) {
    chatMessages.push({ role: "assistant", content: "（发送失败：" + e.message + "）" });
    renderChat();
  } finally {
    typing.remove();
    chatSending = false;
  }
}

$("btn-chat-open").addEventListener("click", () => {
  $("chat-overlay").classList.remove("hidden");
  renderChat();
});
$("btn-chat-close").addEventListener("click", () => {
  $("chat-overlay").classList.add("hidden");
});
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
  const at = $("set-access-token").value.trim();
  if (at) s.accessToken = at;
  saveSettings(s);
  $("set-apikey").value = "";
  $("set-llm-key").value = "";
  $("set-access-token").value = "";
  toast("已保存");
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

// ---------- 初始化 ----------
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchView(t.dataset.view))
);
$("btn-refresh").addEventListener("click", loadOverview);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// 默认开始日期设为今天（当天可选课表模式）
$("plan-start").value = new Date().toISOString().slice(0, 10);

loadSettingsIntoForm();
switchView("overview");
loadOverview();
renderChat();
