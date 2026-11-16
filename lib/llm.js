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
function applyThinking(body, cfg, env) {
  const setting = String(env.LLM_THINKING || "").toLowerCase(); // off|low|high|max|default
  const effort = String(env.LLM_EFFORT || "").toLowerCase();
  const level = effort || setting;
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

export async function chatCompletionRaw(messages, env, { json = false, tools, tool_choice } = {}) {
  const cfg = resolveLlmConfig(env);
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";

  const body = {
    model: cfg.model,
    messages,
  };

  // 思考模式：按厂商能力分别处理（各家参数名不同，不能一套打天下）
  applyThinking(body, cfg, env);
  if (json) body.response_format = { type: "json_object" };
  if (tools) {
    body.tools = tools;
    if (tool_choice) body.tool_choice = tool_choice;
  }

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
