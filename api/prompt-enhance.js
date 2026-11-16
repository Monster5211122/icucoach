import { chatCompletion, llmEnv } from "../lib/llm.js";
import { authError } from "../lib/auth.js";

const SYSTEM = `你是一位提示词工程专家，擅长把简短的想法扩展成高质量、可直接使用的 AI 系统提示词。

用户的场景：这是一个接入 Intervals.icu 的个人 AI 骑行教练。这段提示词会作为系统提示词使用，系统会自动注入运动员的真实数据（FTP、体重、CTL/ATL/Form、恢复状态、训练记录），并且教练可以调用工具（查活动列表、拉单课深度数据、标记已复盘、写入课表到 ICU 日历）。

请把用户输入的想法扩展成一份完整的中文教练系统提示词，必须包含以下部分：
1. 角色与目标：教练是谁、服务谁、核心使命；
2. 表达风格：语气、句式、用数字说话等；
3. 训练复盘流程：固定结构与步骤（结合用户提到的主观感受、体感询问等偏好）；
4. 课表生成规则：如何安排强度与休息（遵循用户给出的规则，用户没提的不编造）；
5. 安全红线：避免过度训练、恢复优先等；
6. 输出格式要求：复盘与课表的输出规范（课表用 ICU 原生 workout 文本）。

要求：
- 保留用户原话中的全部关键偏好，不要删减或改变；
- 用户没说到的内容，按骑行教练的通用最佳实践合理补全；
- 直接输出提示词正文，不要任何解释、前后缀或 Markdown 代码块。`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "仅支持 POST" });
  }
  const authErr = authError(req);
  if (authErr) return res.status(authErr.status).json({ ok: false, error: authErr.error });
  const { input } = req.body || {};
  if (!input || typeof input !== "string" || input.trim().length < 4) {
    return res
      .status(400)
      .json({ ok: false, error: "请先输入一些想法（至少几个字）" });
  }

  try {
    const prompt = await chatCompletion(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: "我的想法是：\n" + input.trim() },
      ],
      llmEnv(req.headers)
    );
    return res.status(200).json({ ok: true, prompt });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
