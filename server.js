const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const ENV_PATH = path.join(ROOT, ".env.local");
const SKILL_DIR = path.join(process.env.USERPROFILE || "", ".codex", "skills", "twitter-content-rewriter");
const PORT = Number(process.env.PORT || 3000);
const generationCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
const COMMON_WORDS = new Set([
  "about", "after", "again", "also", "from", "have", "into", "just", "more", "nothing",
  "post", "that", "their", "them", "then", "there", "this", "through", "with", "your",
  "successfully", "thank", "thanks", "kudos"
]);
const BANNED_POST_PHRASES = [
  "unsung heroes",
  "logistics rockstars",
  "human ingenuity",
  "let's give it up",
  "excited to share",
  "i'm excited to share",
  "thrilled to announce",
  "game changer",
  "in today's fast-paced world",
  "the future is here",
  "follow for more"
];
const GENERIC_HASHTAGS = new Set(["#success", "#motivation", "#business", "#inspiration", "#growth", "#mindset"]);

loadEnv(ENV_PATH);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      return sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    }

    if (req.method === "GET" && req.url.startsWith("/public/")) {
      const filePath = path.normalize(path.join(ROOT, req.url));
      if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Blocked path." });
      return sendFile(res, filePath);
    }

    if (req.method === "POST" && req.url === "/api/generate") {
      const body = await readJson(req);
      const result = await generatePackage(body.url);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && req.url === "/api/regenerate-post") {
      const body = await readJson(req);
      const result = await regeneratePost(body.generationId);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && req.url === "/api/regenerate-image") {
      const body = await readJson(req);
      const result = await regenerateImage(body.generationId, body.imageNumber);
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    sendJson(res, 500, { error: friendlyError(error) });
  }
});

server.listen(PORT, () => {
  console.log(`Twitter Content Machine is running at http://localhost:${PORT}`);
});

async function generatePackage(sourceUrl) {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error("NVIDIA_API_KEY is missing. Check .env.local.");
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing. Check .env.local.");
  }

  const cleanUrl = validateTwitterUrl(sourceUrl);
  const source = await fetchPost(cleanUrl);
  const research = await researchSource(source);
  const skill = readSkill();
  const contentPackage = await rewriteWithSkill(skill, source, research);

  const [image1, image2Background] = await Promise.all([
    generateImage(buildImagePrompt(contentPackage.image1.prompt, contentPackage.post, 1)),
    generateImage(buildImagePrompt(contentPackage.image2.prompt, contentPackage.post, 2))
  ]);
  const image2 = composeImage2Card(image2Background, contentPackage.image2.headline, contentPackage.image2.supportingText);

  const generationId = createGenerationId();
  const result = {
    generationId,
    source,
    post: contentPackage.post,
    image1: {
      ...contentPackage.image1,
      dataUrl: image1
    },
    image2: {
      ...contentPackage.image2,
      dataUrl: image2
    },
    insights: contentPackage.insights,
    researchUsed: research,
    originality: contentPackage.originality
  };

  generationCache.set(generationId, {
    source,
    research,
    post: contentPackage.post,
    hashtags: contentPackage.hashtags,
    image1: result.image1,
    image2: result.image2,
    insights: contentPackage.insights,
    originality: contentPackage.originality,
    createdAt: Date.now()
  });

  pruneGenerationCache();
  return result;
}

async function regeneratePost(generationId) {
  const cached = getCachedGeneration(generationId);
  const skill = readSkill();
  const contentPackage = await rewriteWithSkill(skill, cached.source, cached.research);

  cached.post = contentPackage.post;
  cached.hashtags = contentPackage.hashtags;
  cached.insights = contentPackage.insights;
  cached.originality = contentPackage.originality;

  return {
    generationId,
    post: cached.post,
    insights: cached.insights,
    researchUsed: cached.research,
    originality: cached.originality
  };
}

async function regenerateImage(generationId, imageNumber) {
  const cached = getCachedGeneration(generationId);
  const key = Number(imageNumber) === 2 ? "image2" : "image1";
  const prompt = buildImagePrompt(cached[key].prompt, cached.post, Number(imageNumber) === 2 ? 2 : 1);
  const generatedImage = await generateImage(prompt);
  const freshImage = key === "image2"
    ? composeImage2Card(generatedImage, cached.image2.headline, cached.image2.supportingText)
    : generatedImage;

  cached[key] = {
    ...cached[key],
    dataUrl: freshImage
  };

  return {
    generationId,
    imageNumber: Number(imageNumber) === 2 ? 2 : 1,
    [key]: cached[key]
  };
}

function readSkill() {
  const skillPath = path.join(SKILL_DIR, "SKILL.md");
  const voicePath = path.join(SKILL_DIR, "references", "voice-profile.md");

  if (!fs.existsSync(skillPath) || !fs.existsSync(voicePath)) {
    throw new Error("The twitter-content-rewriter skill was not found in your Codex skills folder.");
  }

  return {
    instructions: fs.readFileSync(skillPath, "utf8"),
    voice: fs.readFileSync(voicePath, "utf8")
  };
}

async function fetchPost(sourceUrl) {
  const endpoint = `https://publish.x.com/oembed?omit_script=true&url=${encodeURIComponent(sourceUrl)}`;
  const response = await fetch(endpoint, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "TwitterContentMachine/1.0"
    }
  });

  if (!response.ok) {
    throw new Error("I could not read that public X post. Try another public post URL.");
  }

  const embed = await response.json();
  const text = extractTweetText(embed.html || "");

  if (!text) {
    throw new Error("I could not find readable text in that X post.");
  }

  return {
    url: embed.url || sourceUrl,
    author: embed.author_name || "Unknown author",
    text
  };
}

async function rewriteWithSkill(skill, source, research) {
  const compactResearch = formatResearchBrief(research);
  const prompt = [
    "Use the installed twitter-content-rewriter skill for originality, source handling, and visual concept rules.",
    "App override: create one universal final post for both X/Twitter and LinkedIn.",
    "Return only valid JSON with this exact shape:",
    '{"post":"...","hashtags":["#...","#...","#..."],"image1":{"concept":"...","prompt":"...","explanation":"..."},"image2":{"concept":"...","prompt":"...","headline":"...","supportingText":"...","explanation":"..."},"insights":["..."],"originality":"..."}',
    "The post field must contain the COMPLETE rewritten social post body, not a title, not a caption, and not a headline.",
    "image2.headline is only for the Image 2 visual overlay. Never use image2.headline or image2.supportingText as post.",
    "",
    "Core skill rules:",
    compactSkillInstructions(skill.instructions),
    "",
    "Voice:",
    skill.voice,
    "",
    "Source post:",
    `Author: ${source.author}`,
    `URL: ${source.url}`,
    `Text: ${source.text}`,
    "",
    "Compact research brief:",
    compactResearch || "No extra verified context found. Do not invent context.",
    "",
    "Requirements:",
    "- Write one punchy universal final post for both X/Twitter and LinkedIn.",
    "- Target 100-180 words.",
    "- The post field must be the full 100-180 word body with multiple short paragraphs.",
    "- Do not return a title or headline in the post field.",
    "- The first 1-2 lines must create curiosity immediately.",
    "- Use short paragraphs for readability.",
    "- Be sharp, specific, conversational, informative, human-sounding, and slightly opinionated when appropriate.",
    "- Focus on ONE strong idea rather than repeatedly summarizing the source.",
    "- Add a clear insight or takeaway beyond summary.",
    "- Keep important facts accurate.",
    "- Use verified/current context only when it improves the post.",
    "- If a claim is not verified, do not present it as confirmed.",
    "- Make the structure and wording clearly different from the source.",
    "- Return 3-5 genuinely relevant hashtags in the hashtags array.",
    "- Do not put hashtags inside post; the app will append them.",
    "- Avoid emojis unless they genuinely fit; default to no emojis.",
    "- Avoid Twitter-specific language such as thread, RT, follow for more, repost, or viral.",
    "- Avoid corporate LinkedIn language such as I'm thrilled to announce, excited to share, game changer, revolutionary, or in today's fast-paced world.",
    "- Avoid generic AI phrases like unsung heroes, logistics rockstars, human ingenuity, let's give it up, unlock the power of, and the future is here.",
    "- Never invent first-person experiences or relationships such as we spoke to, we interviewed, our team, or we learned from unless the source explicitly says so.",
    "- If a company or person was involved, report it neutrally.",
    "- Create two concise, structured, visually different concepts.",
    "- Image 1 must be a premium editorial photography/cinematic documentary scene showing the real-world situation.",
    "- Image 2 must be a premium editorial infographic or visual explainer background only; the app will add readable overlay text.",
    "- Image 2 headline must be 3-7 words; supportingText must be 5-12 words.",
    "- Both image prompts must say the image model must not create any text.",
    "- Do not copy source wording, source image composition, branding, logos, or layout."
  ].join("\n");

  const response = await nvidiaJson("/chat/completions", {
    model: process.env.NVIDIA_TEXT_MODEL || "meta/llama-3.1-8b-instruct",
    messages: [
      {
        role: "system",
        content: "You are a careful social-content rewriting assistant. Return only valid JSON with no markdown."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    temperature: 0.7,
    max_tokens: 1200
  });

  const text = extractChatText(response);
  const parsed = parseJson(text);

  const rawPost = extractPostBody(parsed);

  if (!rawPost || !parsed.image1?.prompt || !parsed.image2?.prompt) {
    throw new Error("The rewrite response was incomplete. Please try again.");
  }

  const hashtags = normalizeHashtags(parsed.hashtags, source, research);
  const postBody = isCompletePostBody(rawPost) ? rawPost : buildFallbackPostBody(source, research);
  const post = finalizePost(postBody, hashtags);

  return {
    post,
    hashtags,
    image1: normalizeImageConcept(parsed.image1, 1),
    image2: normalizeImageConcept(parsed.image2, 2),
    insights: Array.isArray(parsed.insights) ? parsed.insights.slice(0, 3) : [],
    originality: parsed.originality || "Rebuilt from the underlying idea, not copied sentence-by-sentence."
  };
}

async function researchSource(source) {
  const query = buildResearchQuery(source);
  if (!query) return [];

  try {
    const results = await searchDuckDuckGo(query);
    return results.slice(0, 2).map(result => ({
      fact: result.snippet,
      source: result.title,
      url: result.url,
      date: ""
    })).filter(item => item.fact && item.source && item.url);
  } catch {
    return [];
  }
}

function buildResearchQuery(source) {
  const text = `${source.author} ${source.text}`;
  const words = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@]/g, " ")
    .replace(/[^A-Za-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(word => word.length > 3 && !COMMON_WORDS.has(word.toLowerCase()));

  return Array.from(new Set(words)).slice(0, 8).join(" ");
}

async function searchDuckDuckGo(query) {
  const endpoint = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, {
    headers: {
      "Accept": "text/html",
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) return [];
  const html = await response.text();
  const results = [];
  const pattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = pattern.exec(html)) && results.length < 4) {
    const url = normalizeSearchUrl(decodeHtml(match[1]));
    const title = cleanText(match[2]);
    const snippet = cleanText(match[3]);
    if (url && title && snippet) results.push({ title, url, snippet });
  }

  return results;
}

function normalizeSearchUrl(url) {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return "";
  }
}

async function generateImage(prompt) {
  const response = await openaiJson("/v1/images/generations", {
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
    prompt,
    size: "1536x1024",
    quality: "medium",
    output_format: "png"
  });

  const image = response.data?.[0]?.b64_json;
  if (!image) throw new Error("Image generation finished without an image.");
  return `data:image/png;base64,${image}`;
}

function buildImagePrompt(basePrompt, finalPost, imageNumber) {
  const role = imageNumber === 2
    ? "Create a premium editorial infographic or visual explainer BACKGROUND ONLY. The application will add the readable text overlay later."
    : "Create a clean professional editorial visual. Documentary-style, realistic, specific, and publication-quality.";
  const imageSpecificRules = imageNumber === 2
    ? [
      "- Image 2 should be a premium editorial infographic or visual explainer background, with clear negative space for a text overlay.",
      "- Use a different visual interpretation, composition, or metaphor from Image 1.",
      "- Do not include generated text, labels, numbers, signs, or fake data because the application will add readable text later."
    ]
    : [
      "- Image 1 should feel like premium editorial photography or cinematic documentary reporting, not a generic stock image.",
      "- Prioritize visual storytelling, real-world detail, believable machinery, natural human posture, and grounded lighting.",
      "- Avoid posed groups looking at camera, excessive symmetry, overly perfect people, and generic stock-photo composition."
    ];

  return [
    role,
    "",
    "Final post context:",
    trimText(finalPost, 900),
    "",
    "Visual direction:",
    trimText(basePrompt, 900),
    "",
    "Style requirements:",
    "- Professional editorial visual suitable for both X/Twitter and LinkedIn.",
    ...imageSpecificRules,
    "- Use realistic environments, realistic people where needed, accurate machinery, believable proportions, natural lighting, and strong composition.",
    "- Avoid posed groups looking at camera, excessive symmetry, fantasy environments, obvious AI-art aesthetics, excessive glow, random futuristic interfaces, unnecessary 3D elements, distorted objects, unrealistic hands or faces, clutter, fake statistics, fake brands, fake logos, and watermarks.",
    "- Never copy the source author's image, artwork, branding, or composition.",
    "- Create a clean professional editorial visual. Do not render any text, words, letters, numbers, captions, labels, logos, watermarks, or typography."
  ].join("\n");
}

function normalizeHashtags(rawHashtags, source, research) {
  const provided = Array.isArray(rawHashtags) ? rawHashtags : [];
  const normalized = provided
    .map(tag => String(tag || "").trim())
    .filter(Boolean)
    .map(tag => tag.startsWith("#") ? tag : `#${tag}`)
    .map(tag => tag.replace(/[^#A-Za-z0-9_]/g, ""))
    .filter(tag => tag.length > 1 && !GENERIC_HASHTAGS.has(tag.toLowerCase()));

  const tags = Array.from(new Set(normalized));
  for (const tag of deriveHashtags(source, research)) {
    if (tags.length >= 5) break;
    if (!tags.includes(tag)) tags.push(tag);
  }

  return tags.slice(0, 5);
}

function deriveHashtags(source, research) {
  const text = `${source.text} ${research.map(item => `${item.source} ${item.fact}`).join(" ")}`.toLowerCase();
  const tags = [];
  const add = tag => {
    if (!tags.includes(tag)) tags.push(tag);
  };

  if (text.includes("logistics")) add("#Logistics");
  if (text.includes("supply chain") || text.includes("supplychain")) add("#SupplyChain");
  if (text.includes("freight")) add("#FreightForwarding");
  if (text.includes("project cargo") || text.includes("project logistics")) add("#ProjectLogistics");
  if (text.includes("oversized") || text.includes("heavy cargo")) add("#OversizedCargo");
  if (text.includes("shipping") || text.includes("sea") || text.includes("port")) add("#Shipping");
  if (text.includes("transport")) add("#Transportation");
  if (text.includes("manufacturing") || text.includes("industrial")) add("#Industrial");

  for (const fallback of ["#Logistics", "#SupplyChain", "#ProjectLogistics"]) {
    if (tags.length >= 3) break;
    add(fallback);
  }

  return tags;
}

function finalizePost(post, hashtags) {
  let cleanPost = String(post || "").trim();
  cleanPost = cleanPost.replace(/(?:\s*#[A-Za-z0-9_]+){2,}\s*$/g, "").trim();

  for (const phrase of BANNED_POST_PHRASES) {
    const pattern = new RegExp(escapeRegExp(phrase), "ig");
    cleanPost = cleanPost.replace(pattern, "");
  }

  cleanPost = cleanPost
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return `${cleanPost}\n\n${hashtags.join(" ")}`.trim();
}

function extractPostBody(parsed) {
  const candidates = [
    parsed.post,
    parsed.final_post,
    parsed.finalPost,
    parsed.body,
    parsed.content
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }

  return "";
}

function isCompletePostBody(post) {
  const body = stripHashtags(String(post || "")).trim();
  const words = body.split(/\s+/).filter(Boolean);
  const paragraphs = body.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  const sentences = body.split(/[.!?]+/).map(part => part.trim()).filter(Boolean);

  if (words.length < 80) return false;
  if (words.length > 230) return false;
  if (paragraphs.length < 2 && sentences.length < 4) return false;
  if (looksLikeTitle(body)) return false;

  return true;
}

function looksLikeTitle(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean);
  if (lines.length === 1 && words.length <= 14) return true;
  if (lines.length === 1 && /:\s+[A-Z]/.test(text) && words.length <= 18) return true;
  return false;
}

function buildFallbackPostBody(source, research) {
  const sourceText = cleanText(source.text);
  const combined = `${sourceText} ${research.map(item => item.fact).join(" ")}`.toLowerCase();

  if (/(inclusion|diversity|disability|handicap|duoday|equal opportunit|accessibility)/i.test(combined)) {
    return [
      "Inclusion is easy to talk about. It is much harder to make it practical.",
      "That is the useful part of this story: it points to inclusion as something people can actually experience, not just something a company writes into a policy.",
      "In logistics and transport, the work is physical, operational, and highly coordinated. Opening that world to more people matters because visibility often comes before opportunity.",
      "The stronger takeaway is simple: inclusion becomes credible when it moves from language to access, exposure, and real participation.",
      "That is where the conversation should be."
    ].join("\n\n");
  }

  if (/(oversized|cargo|freight|logistics|supply chain|shipment|transport|port|ice|storm)/i.test(combined)) {
    return [
      "Some logistics stories are not about speed. They are about staying calm when the route gets complicated.",
      "Oversized cargo, harsh weather, ice, disruption, and tight coordination all change the job. At that point, transport is no longer a simple movement from one place to another.",
      "It becomes planning under pressure.",
      "The real value is not just the equipment. It is the judgment behind every decision: when to move, when to wait, how to reduce risk, and how to keep people aligned when conditions shift.",
      "That is what makes project logistics interesting. The hard part is rarely the distance. It is everything that happens along the way."
    ].join("\n\n");
  }

  const topic = extractTopicPhrase(sourceText);
  return [
    `${topic} is more interesting when you look past the announcement.`,
    "The useful question is not only what happened, but what it reveals about the way the work actually gets done.",
    "Good execution usually sits behind the scenes: planning, coordination, trade-offs, and decisions that are easy to miss from the outside.",
    "That is the angle worth paying attention to. The visible result may be simple, but the process behind it often carries the real lesson.",
    "Strong work usually looks obvious only after someone has already done the hard part."
  ].join("\n\n");
}

function stripHashtags(value) {
  return String(value || "").replace(/#[A-Za-z0-9_]+/g, " ").replace(/\s+/g, " ");
}

function extractTopicPhrase(text) {
  const words = cleanText(text)
    .split(/\s+/)
    .filter(word => word.length > 3 && !COMMON_WORDS.has(word.toLowerCase()))
    .slice(0, 5);

  return words.length ? words.join(" ") : "This story";
}

function normalizeImageConcept(image, imageNumber) {
  const basePrompt = String(image.prompt || "").trim();
  const requiredPrompt = imageNumber === 2
    ? "Premium editorial infographic or visual explainer background only, different from Image 1, with clean negative space for a programmatic text overlay. No fake statistics, fake logos, fake brands, or watermarks. Create a clean professional editorial visual. Do not render any text, words, letters, numbers, captions, labels, logos, watermarks, or typography."
    : "Premium editorial photography or cinematic documentary-style scene with realistic environment, believable people and machinery, accurate proportions, natural lighting, and strong composition. No fake logos, fake brands, fake statistics, or watermarks. Create a clean professional editorial visual. Do not render any text, words, letters, numbers, captions, labels, logos, watermarks, or typography.";
  const normalized = {
    concept: String(image.concept || image.explanation || "").trim(),
    prompt: `${basePrompt} ${requiredPrompt}`.trim(),
    explanation: String(image.explanation || image.concept || "").trim()
  };

  if (imageNumber === 2) {
    normalized.headline = sanitizeOverlayText(image.headline, "WHEN THE ROUTE GETS TOUGH", 7);
    normalized.supportingText = sanitizeOverlayText(image.supportingText, "Project logistics is problem-solving under pressure.", 12);
  }

  return normalized;
}

function composeImage2Card(backgroundDataUrl, headline, supportingText) {
  const safeHeadline = escapeXml(sanitizeOverlayText(headline, "WHEN THE ROUTE GETS TOUGH", 7).toUpperCase());
  const safeSupport = escapeXml(sanitizeOverlayText(supportingText, "Project logistics is problem-solving under pressure.", 12));
  const safeImage = escapeXml(backgroundDataUrl);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024" viewBox="0 0 1536 1024">
  <image href="${safeImage}" width="1536" height="1024" preserveAspectRatio="xMidYMid slice"/>
  <rect x="0" y="0" width="1536" height="1024" fill="rgba(8,18,28,0.28)"/>
  <rect x="86" y="650" width="980" height="248" rx="22" fill="rgba(255,255,255,0.92)"/>
  <rect x="86" y="650" width="12" height="248" fill="#0f766e"/>
  <text x="132" y="742" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="800" letter-spacing="0" fill="#17202a">${safeHeadline}</text>
  <text x="132" y="815" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="500" letter-spacing="0" fill="#384557">${safeSupport}</text>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function sanitizeOverlayText(value, fallback, maxWords) {
  const text = String(value || fallback)
    .replace(/[#*_`~<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = text.split(/\s+/).filter(Boolean).slice(0, maxWords);
  return words.join(" ") || fallback;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatResearchBrief(research) {
  return research.map(item => {
    const date = item.date ? ` Date: ${item.date}.` : "";
    return `- Verified/context fact: ${trimText(item.fact, 240)} Source: ${item.source}. URL: ${item.url}.${date}`;
  }).join("\n");
}

function compactSkillInstructions(instructions) {
  const sections = [
    "Transform the idea, not the wording.",
    "Do not paraphrase sentence-by-sentence or copy distinctive phrasing.",
    "Separate facts from opinions.",
    "Create an original angle and structure.",
    "Do not imitate a living creator's distinctive voice.",
    "Never invent personal experiences.",
    "Keep factual claims accurate.",
    "Create two genuinely different visual directions.",
    "Never recreate source images, branding, artwork, or layout.",
    "Default publishing boundary: user reviews and manually publishes."
  ];

  return sections.join("\n");
}

function createGenerationId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getCachedGeneration(generationId) {
  const cached = generationCache.get(String(generationId || ""));
  if (!cached) throw new Error("This generation is no longer available. Please click Generate again.");
  return cached;
}

function pruneGenerationCache() {
  const now = Date.now();
  for (const [id, item] of generationCache.entries()) {
    if (now - item.createdAt > CACHE_TTL_MS) generationCache.delete(id);
  }
}

async function openaiJson(endpoint, payload) {
  const response = await fetch(`https://api.openai.com${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data.error?.message || `OpenAI API request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return data;
}

async function nvidiaJson(endpoint, payload) {
  const baseUrl = (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data.error?.message || `NVIDIA API request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return data;
}

function extractChatText(response) {
  return response.choices?.[0]?.message?.content?.trim() || "";
}

function cleanText(value) {
  return decodeHtml(String(value || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function extractTweetText(html) {
  const match = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const raw = match ? match[1] : html;
  return decodeHtml(raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "-");
}

function parseJson(text) {
  const cleanJsonText = String(text || "").replace(/[\u0000-\u001f\u007f]/g, " ");
  try {
    return JSON.parse(cleanJsonText);
  } catch {
    const match = cleanJsonText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("The rewrite response was not valid JSON. Please try again.");
    return JSON.parse(match[0]);
  }
}

function validateTwitterUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Please paste a valid X/Twitter post URL.");
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(host) || !url.pathname.includes("/status/")) {
    throw new Error("Please paste a direct X/Twitter post URL that contains /status/.");
  }

  return url.toString();
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 20000) reject(new Error("Request is too large."));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid request."));
      }
    });
  });
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "File not found." });
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function friendlyError(error) {
  const message = error && error.message ? error.message : "Something went wrong.";
  return message
    .replace(process.env.OPENAI_API_KEY || "__no_openai_key__", "[hidden]")
    .replace(process.env.NVIDIA_API_KEY || "__no_nvidia_key__", "[hidden]");
}
