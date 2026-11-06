require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();
app.set("trust proxy", 1);
app.use(cors());
// Vercel request body limit ~4.5MB, isliye 4mb rakha hai
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODELS = ["gemini-3.5-flash", "gemini-3.8-flash"];

const SYSTEM_PROMPT = `
You are Abtrist AI, a helpful, friendly and knowledgeable AI assistant, similar to ChatGPT.
- Reply in the same language the user writes in (English, Urdu, Roman Urdu, Hindi, etc.).
- Be clear, accurate and helpful. Use Markdown (headings, lists, tables) when it makes the answer easier to read.
- For code, always use fenced code blocks with the language name.
- If you are not sure about something, say so instead of guessing.
- When the user attaches an image or a document, read it carefully and answer based on it.
- Politely refuse requests that are harmful or illegal.
- If anyone asks who created, invented, built or founded you (or who your founder or owner is), answer that you were invented by Abdullah Tufail. Do not say you were made by Google or any other company.
`;

const BUSY_MESSAGE = "Server is busy right now. Please try again in a moment.";

// ---- simple rate limit (har IP se 1 minute mein 15 messages) ----
// Note: Vercel serverless par ye memory mein hai, isliye sirf approximate kaam karta hai.
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 60000);
  if (list.length >= 15) {
    return res
      .status(429)
      .json({ reply: "Too many messages. Please wait a minute and try again." });
  }
  list.push(now);
  hits.set(req.ip, list);
  // purani entries saaf karna (setInterval serverless par bharosemand nahi)
  if (hits.size > 1000) {
    for (const [ip, l] of hits) {
      if (l.every((t) => now - t >= 60000)) hits.delete(ip);
    }
  }
  next();
}

// ---- history ko Gemini ke format mein badalna ----
function toContents(history) {
  const contents = history.slice(-20).map((m) => {
    const parts = [];
    const text = String(m.text || "").slice(0, 60000);
    if (text) parts.push({ text });

    if (m.role !== "model" && Array.isArray(m.files)) {
      for (const f of m.files.slice(0, 4)) {
        if (f && f.mime && f.data) {
          parts.push({
            inline_data: { mime_type: String(f.mime), data: String(f.data) },
          });
        }
      }
    }
    if (parts.length === 0) parts.push({ text: "(empty)" });
    return { role: m.role === "model" ? "model" : "user", parts };
  });

  while (contents.length && contents[0].role === "model") contents.shift();
  return contents;
}

async function askGemini(model, contents) {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
      }),
    }
  );
}

app.get("/health", (req, res) => res.send("ok"));

app.post("/chat", rateLimit, async (req, res) => {
  const { history } = req.body || {};

  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ reply: "Please type a message." });
  }

  const contents = toContents(history);
  if (contents.length === 0) {
    return res.status(400).json({ reply: "Please type a message." });
  }

  const started = Date.now();

  for (let attempt = 0; attempt < 2; attempt++) {
    for (const model of MODELS) {
      // Vercel ke time limit se pehle hi ruk jao
      if (Date.now() - started > 45000) {
        return res.status(503).json({ reply: BUSY_MESSAGE });
      }
      try {
        const response = await askGemini(model, contents);
        const data = await response.json();

        if (response.ok) {
          const reply =
            data.candidates?.[0]?.content?.parts
              ?.map((p) => p.text || "")
              .join("") ||
            "Sorry, I couldn't come up with an answer. Please try again.";
          return res.json({ reply });
        }

        console.error(model, response.status, data.error?.message);

        if (response.status !== 503 && response.status !== 429) {
          if (response.status === 404) continue;
          return res.status(500).json({ reply: BUSY_MESSAGE });
        }
      } catch (err) {
        console.error(model, "timeout ya network error:", err.name);
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  res.status(503).json({ reply: BUSY_MESSAGE });
});

// body bohat bara ho to HTML ke bajaye JSON jawab do
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res
      .status(413)
      .json({ reply: "File is too large. Please attach a smaller file (under about 3MB)." });
  }
  console.error(err);
  res.status(500).json({ reply: BUSY_MESSAGE });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log("Server running on " + PORT));
}
module.exports = app;
