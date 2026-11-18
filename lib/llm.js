// 可替换的大模型客户端。
// 通过环境变量切换，不改代码：LLM_PROVIDER 决定用哪家，均可走 OpenAI 兼容协议。

const PROVIDERS = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-flash",
    keyEnv: "DEEPSEEK_API_KEY",
  },
  volcano: {
    // 火山方舟（豆包）：model 填“推理接入点 ID”，如 ep-xxxxxxxx
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "",
    keyEnv: "VOLCANO_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    keyEnv: "OPENAI_API_KEY",
  },
  moonshot: {
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    keyEnv: "MOONSHOT_API_KEY",
  },
  custom: {
    baseUrl: "",
    defaultModel: "",
    keyEnv: "CUSTOM_API_KEY",
  },
};

export function resolveLlmConfig(env) {
  const provider = (env.LLM_PROVIDER || "deepseek").toLowerCase();
  const p = PROVIDERS[provider] || PROVIDERS.deepseek;

  const apiKey = env.LLM_API_KEY || env[p.keyEnv];
  if (!apiKey) {
    throw new Error(
      `未配置模型密钥：请在 App「设置」页填写模型密钥（本机保存），或设置环境变量 ${p.keyEnv}（当前 provider=${provider}）`
    );
  }

  const baseUrl = env.LLM_BASE_URL || p.baseUrl;
  const model = env.LLM_MODEL || p.defaultModel;
  if (!baseUrl || !model) {
    throw new Error(
      `provider=${provider} 需要 LLM_BASE_URL 和 LLM_MODEL（custom 或 volcano 必填）`
    );
  }

  return { provider, baseUrl, model, apiKey };
}

// 页面设置 > 服务器环境变量：把请求头里的模型配置合并进 env（模型密钥可在手机本地填，不配服务器）
export function llmEnv(headers) {
  const env = { ...process.env };
  const h = headers || {};
  if (h["x-llm-provider"]) env.LLM_PROVIDER = h["x-llm-provider"];
  if (h["x-llm-api-key"]) env.LLM_API_KEY = h["x-llm-api-key"];
  if (h["x-llm-base-url"]) env.LLM_BASE_URL = h["x-llm-base-url"];
  if (h["x-llm-model"]) env.LLM_MODEL = h["x-llm-model"];
  if (h["x-llm-thinking"]) env.LLM_THINKING = h["x-llm-thinking"];
  if (h["x-llm-effort"]) env.LLM_EFFORT = h["x-llm-effort"];
  return env;
}

// 思考开关 + 思考强度：厂商能力不同，按 model 前缀判断
// - deepseek：thinking{type} + reasoning_effort(low/high/max)
// - 火山方舟：thinking{type} + reasoning_effort(none/low/medium/high/max)
// - moonshot：K3 系列只能用顶层 reasoning_effort；K2.6/K2.7 用 thinking{type}
// - openai：只有推理模型(o1/o3/o4/gpt-5…)认 reasoning_effort，其余模型不传
// - custom / 未知：不传，避免 400

// 「自动」档位：调用方按任务复杂度先算出具体档位（off/low/high/max），再交给 applyThinking
export function withAutoThinking(env, level) {
  if (!env) return env;
  const t = String(env.LLM_THINKING || "").toLowerCase();
  const e = String(env.LLM_EFFORT || "").toLowerCase();
  if (t !== "auto" && e !== "auto") return env;
  const lv = ["off", "low", "high", "max"].includes(level) ? level : "high";
  return { ...env, LLM_THINKING: lv, LLM_EFFORT: lv === "off" ? "" : lv };
}

function applyThinking(body, cfg, env) {
  const setting = String(env.LLM_THINKING || "").toLowerCase(); // off|low|high|max|default
  const effort = String(env.LLM_EFFORT || "").toLowerCase();
  const rawLevel = effort || setting;
  // 没被 withAutoThinking 处理到的 auto 一律退化为 high，避免发出非法的 reasoning_effort
  const level = rawLevel === "auto" ? "high" : rawLevel;
  const want = level && level !== "default";
  const provider = cfg.provider;
  const model = String(cfg.model || "").toLowerCase();

  const off = setting === "off";

  if (provider === "deepseek") {
    if (off) {
      body.thinking = { type: "disabled" };
      body.temperature = 0.4; // 非思考模式 temperature 才生效
    } else if (want) {
      body.thinking = { type: "enabled" };
      if (["low", "high", "max"].includes(level)) body.reasoning_effort = level;
    }
    return;
  }

  if (provider === "volcano") {
    if (off) {
      body.thinking = { type: "disabled" };
      body.reasoning_effort = "none";
      body.temperature = 0.4;
    } else if (want) {
      body.thinking = { type: "enabled" };
      const map = { low: "low", high: "high", max: "max" };
      if (map[level]) body.reasoning_effort = map[level];
    }
    return;
  }

  if (provider === "moonshot") {
    const isK3 = model.includes("k3");
    if (isK3) {
      // K3 始终开思考，只认顶层 effort，不支持关闭
      if (want && ["low", "high", "max"].includes(level)) body.reasoning_effort = level;
      return;
    }
    if (off) {
      body.thinking = { type: "disabled" };
      body.temperature = 0.4;
      return;
    }
    if (want && ["low", "high", "max"].includes(level)) body.reasoning_effort = level;
    return;
  }

  if (provider === "openai") {
    const isReasoning = /^(o[1-9]|gpt-5|gpt-5-mini|gpt-4\.1|chatgpt-5)/.test(model) || model.includes("o3") || model.includes("o4");
    if (isReasoning && want) {
      body.reasoning_effort = level === "max" ? "high" : level;
    } else {
      body.temperature = 0.4;
    }
    return;
  }

  // custom / 未知厂商：只发通用参数
  body.temperature = 0.4;
}

function buildRequestBody(cfg, messages, env, { json = false, tools, tool_choice, stream = false } = {}) {
  const body = { model: cfg.model, messages };
  // 思考模式：按厂商能力分别处理（各家参数名不同，不能一套打天下）
  applyThinking(body, cfg, env);
  if (json) body.response_format = { type: "json_object" };
  if (tools) {
    body.tools = tools;
    if (tool_choice) body.tool_choice = tool_choice;
  }
  if (stream) body.stream = true;
  return body;
}

// 流式输出：边生成边把增量交给 onDelta，连接不断就不会被平台按“长时间无响应”掐掉
export async function chatCompletionStream(messages, env, onDelta, opts = {}) {
  const cfg = resolveLlmConfig(env);
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.apiKey,
    },
    body: JSON.stringify(buildRequestBody(cfg, messages, env, { ...opts, stream: true })),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 600)}`);
  }
  if (!res.body) throw new Error("模型未返回流式内容");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const delta = obj?.choices?.[0]?.delta || {};
      if (delta.content) {
        out += delta.content;
        if (onDelta) onDelta(delta.content);
      }
    }
  }
  if (!out.trim()) throw new Error("模型未返回文本内容");
  return out;
}

export async function chatCompletionRaw(messages, env, { json = false, tools, tool_choice } = {}) {
  const cfg = resolveLlmConfig(env);
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const body = buildRequestBody(cfg, messages, env, { json, tools, tool_choice });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 600)}`);
  }

  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error("模型未返回内容");
  return msg;
}

export async function chatCompletion(messages, env, opts = {}) {
  const msg = await chatCompletionRaw(messages, env, opts);
  if (!msg.content) throw new Error("模型未返回文本内容");
  return msg.content;
}

// 从模型输出中稳健地解析 JSON（容忍 markdown 代码块包裹）
export function parseJson(content) {
  const text = String(content).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch {
    // 尝试截取第一个 { 到最后一个 }
    const s = candidate.indexOf("{");
    const e = candidate.lastIndexOf("}");
    if (s >= 0 && e > s) return JSON.parse(candidate.slice(s, e + 1));
    throw new Error("模型返回内容不是合法 JSON");
  }
}

// ── DSML 兜底 ────────────────────────────────────────────────
// 火山方舟的部分模型会把工具调用渲染成 <| | DSML | | calls> 这类标记文本，
// 而不是 OpenAI 的 tool_calls。这里把它解析成真正的调用，并把标记从可见文本里剔掉。
export function stripDsml(text) {
  let out = String(text || "");
  if (!/DSML/.test(out)) return out;
  let guard = 0;
  while (/DSML/.test(out) && guard++ < 8) {
    const hit = out.indexOf("DSML");
    const start = out.lastIndexOf("<", hit);
    if (start < 0) break;
    const lastHit = out.lastIndexOf("DSML");
    const end = out.indexOf(">", lastHit);
    if (end < 0) { out = out.slice(0, start); break; }
    out = out.slice(0, start) + out.slice(end + 1);
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function extractDsmlCalls(content) {
  const text = String(content || "");
  if (!/DSML/.test(text)) return { text, calls: [] };
  const calls = [];
  const invokes = text.split(/invoke\s+name=/).slice(1);
  for (const chunk of invokes) {
    const name = (chunk.match(/^"([^"]+)"/) || [])[1];
    if (!name) continue;
    const args = {};
    const re = /parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\s*\/\s*[|｜][^<>]*parameter>/g;
    let m;
    while ((m = re.exec(chunk))) {
      const raw = String(m[2] || "").trim();
      let val = raw;
      if (!raw) val = "";
      else if (/^\{/.test(raw) || /^\[/.test(raw)) {
        try { val = JSON.parse(raw); } catch { /* 保持字符串 */ }
      } else if (/^true$|^false$/i.test(raw)) val = /^true$/i.test(raw);
      else if (/^-?\d+(.\d+)?$/.test(raw)) val = Number(raw);
      args[m[1]] = val;
    }
    calls.push({ name, args });
  }
  return { text: stripDsml(text), calls };
}

// 流式输出时把整段 DSML 调用块吞掉（不只标签，连参数值也不能露到屏幕上）
export function createDsmlStripper() {
  let pending = "";
  let suppress = false;
  let loose = "";
  return (delta) => {
    pending += delta || "";
    let out = "";
    for (;;) {
      const lt = pending.indexOf("<");
      if (lt === -1) {
        if (!suppress) out += pending;
        pending = "";
        break;
      }
      if (!suppress) out += pending.slice(0, lt);
      const gt = pending.indexOf(">", lt);
      if (gt === -1) { pending = pending.slice(lt); break; }
      const tag = pending.slice(lt, gt + 1);
      if (/DSML/i.test(tag)) {
        if (/\/.*?(calls|invoke).*>/i.test(tag)) suppress = false;
        else suppress = true;
        pending = pending.slice(gt + 1);
        continue;
      }
      if (suppress) { pending = pending.slice(gt + 1); continue; }
      out += tag;
      pending = pending.slice(gt + 1);
    }
    if (pending.length > 200) {
      if (!suppress) loose += pending;
      pending = "";
    }
    return out + loose ? out + loose : out;
  };
}
