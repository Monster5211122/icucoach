// 访问控制：防止陌生人打开你的网页后恶意调用后端（烧模型额度、读写 ICU）
// 规则：
// - 服务器配了 ACCESS_TOKEN 环境变量时，所有 API 要求请求头 x-access-token 与之匹配；
//   App「设置」页填写同一个口令即可（同样只存在手机浏览器本地）。
// - 未配 ACCESS_TOKEN 时不校验（方便初次部署调试），但限流仍然生效。
// - 限流：同一个口令（或 IP）10 分钟内最多 120 次请求（单实例内存，简单防滥用兜底）。

const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 120;
const hits = new Map(); // key -> 时间戳数组

export function authError(req) {
  const expect = process.env.ACCESS_TOKEN || "";
  const token = String(req.headers["x-access-token"] || "");

  if (expect && token !== expect) {
    return {
      status: 401,
      error:
        "访问口令不正确：请在 App「设置」页填写与服务器 ACCESS_TOKEN 一致的访问口令",
    };
  }

  const key = expect && token ? token : String(req.headers["x-forwarded-for"] || "unknown");
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_HITS) {
    hits.set(key, arr);
    return { status: 429, error: "请求过于频繁，请稍后再试" };
  }
  arr.push(now);
  hits.set(key, arr);
  return null;
}
