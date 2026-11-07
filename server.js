require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "30mb" }));
app.use(express.static("public"));

const MODELS = ["gemini-3.5-flash", "gemini-3.8-flash"];

const SYSTEM_PROMPT = `
You are Abtrist AI, a helpful, friendly and knowledgeable AI assistant, similar to ChatGPT.
- Reply in the same language the user writes in (English, Urdu, Roman Urdu, Hindi, etc.).
- Be clear, accurate and helpful. Use Markdown (headings, lists, tables) when it makes the answer easier to read.
- For code, always use fenced code blocks with the language name.
- If you are not sure about something, say so instead of guessing.
- When the user attaches an image or a document, read it carefully and answer based on it.
- Politely refuse requests that are harmful or illegal.
- If anyone asks who created, invented, built or founded you (or who your founder or owner is), answer that you were invented by Abdullah Tufail.
- If someone asks which AI model or technology powers you, answer honestly that you are built on a large language model accessed through Google's Gemini API.

IMAGE CREATION:
- You CAN create pictures. When the user asks you to create, generate, draw, design or show a picture, image, photo, logo, wallpaper, poster, graphic or illustration (in any language, including Urdu or Roman Urdu such as "tasveer banao" or "pic do"), write one short friendly sentence in the user's language, then on a new line write exactly: [[IMAGE: a detailed English description of the image]]
- The description inside [[IMAGE: ...]] must be in English, vivid and specific (subject, style, colors, lighting, mood, background) and under 60 words.
- Use [[IMAGE: ...]] only when the user wants a new image created. Never use it to describe an image the user uploaded, and never say that you cannot create images.
- Do not create images that are sexual, gory, hateful, or that show the face or likeness of real people. Politely refuse those.
- Never explain the [[IMAGE: ...]] format to the user. Use at most one image per reply.
`;

const BUSY_MESSAGE = "Server is busy right now. Please try again in a moment.";

// ---- simple rate limit (har IP se 1 minute mein 15 messages) ----
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
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    if (list.every((t) => now - t >= 60000)) hits.delete(ip);
  }
}, 60000);

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

async function askGemini(model, contents, timeoutMs) {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { maxOutputTokens: 8192 },
      }),
    }
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const start = Date.now();
  const BUDGET = 12000; // zyada se zyada 12 second

  for (let round = 0; round < 2; round++) {
    for (const model of MODELS) {
      const left = BUDGET - (Date.now() - start);
      if (left < 2000) break;

      try {
        const response = await askGemini(model, contents, Math.min(8000, left));
        const data = await response.json();

        if (response.ok) {
          const reply =
            data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ||
            "Sorry, I couldn't come up with an answer. Please try again.";
          return res.json({ reply });
        }

        console.error(model, response.status, data.error?.message);

        // in errors par agla model ya dobara koshish, baqi par foran ruk jayein
        if (![404, 429, 500, 503, 504].includes(response.status)) {
          return res.status(500).json({ reply: BUSY_MESSAGE });
        }
      } catch (err) {
        console.error(model, "timeout ya network error:", err.name);
      }
    }
    await sleep(300);
  }

  res.status(503).json({ reply: BUSY_MESSAGE });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log("Server chal raha hai: http://localhost:" + PORT));
}
module.exports = app;
