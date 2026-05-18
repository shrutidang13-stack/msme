const env = require("../config/env");

async function chat(req, res, next) {
  try {
    const question = String(req.body?.question || "").trim();
    if (!question) return res.status(400).json({ success: false, error: "question is required" });
    if (!env.anthropicApiKey) {
      return res.status(503).json({
        success: false,
        error: "AI assistant is not configured. Set ANTHROPIC_API_KEY on the backend.",
      });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.anthropicChatModel,
        max_tokens: 1024,
        system:
          "You are an expert CA assistant specializing in MSME compliance in India. Do not classify a vendor as MSME by guessing from its name. For vendor MSME status, instruct users to verify Udyam registration or use stored vendor master data. Keep answers practical and concise.",
        messages: [{ role: "user", content: question }],
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ success: false, error: data.error?.message || "AI request failed" });
    res.json({ success: true, reply: data.content?.[0]?.text || "No response returned." });
  } catch (error) {
    next(error);
  }
}

module.exports = { chat };
