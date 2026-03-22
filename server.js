const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");
const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");
const ytdl = require("ytdl-core");

const rootDir = path.resolve(process.cwd());
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const cacheDir = path.join(rootDir, ".cache");
const transcriptCacheDir = path.join(cacheDir, "transcripts");
const ytDlpBinary = process.env.YT_DLP_BIN || "yt-dlp";
const transcriptRequestCache = new Map();
const searchResponseCache = new Map();
const recommendationResponseCache = new Map();
const dictionaryResponseCache = new Map();
const searchRequestCache = new Map();
const recommendationRequestCache = new Map();
const dictionaryRequestCache = new Map();
const SEARCH_CACHE_TTL_MS = 1000 * 60 * 10;
const RECOMMENDATION_CACHE_TTL_MS = 1000 * 60 * 10;
const DICTIONARY_CACHE_TTL_MS = 1000 * 60 * 60 * 12;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

let transformersModulePromise = null;
let youtubeiModulePromise = null;
let innertubePromise = null;
const asrPipelineCache = new Map();

function createRequestHeaders(extraHeaders = {}) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Origin": "https://www.youtube.com",
    "Referer": "https://www.youtube.com/",
    ...extraHeaders
  };
}

function createYoutubePageHeaders(extraHeaders = {}) {
  return createRequestHeaders({
    "Cookie": process.env.YOUTUBE_COOKIE || "CONSENT=YES+1",
    ...extraHeaders
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function createStaticEtag(stat) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function getMemoryCache(cache, key) {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setMemoryCache(cache, key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

function extractVideoId(input) {
  if (!input) {
    return "";
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  try {
    const parsed = new URL(input);
    if (parsed.searchParams.get("v")) {
      return parsed.searchParams.get("v").slice(0, 11);
    }
    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.replace("/", "").slice(0, 11);
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    const embedIndex = parts.findIndex((part) => part === "embed" || part === "shorts" || part === "live");
    if (embedIndex >= 0 && parts[embedIndex + 1]) {
      return parts[embedIndex + 1].slice(0, 11);
    }
  } catch (_error) {
    return "";
  }

  return "";
}

function decodeHtmlEntities(text) {
  return String(text)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", "\"");
}

function decodeXmlEntities(text) {
  return decodeHtmlEntities(String(text))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(parseInt(decimal, 10)));
}

function textFromRuns(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return decodeHtmlEntities(value);
  }

  if (Array.isArray(value.runs)) {
    return decodeHtmlEntities(value.runs.map((run) => run.text || "").join(""));
  }

  if (value.simpleText) {
    return decodeHtmlEntities(value.simpleText);
  }

  return "";
}

function normalizeCueText(text) {
  return decodeHtmlEntities(text)
    .replace(/\s+/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim();
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]);
}

function parseCaptionEvents(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const cues = [];

  for (const event of events) {
    const start = Number(event?.tStartMs) / 1000;
    const duration = Number(event?.dDurationMs) / 1000;
    const segments = Array.isArray(event?.segs) ? event.segs : [];
    const text = normalizeCueText(segments.map((segment) => segment.utf8 || "").join(""));
    if (!Number.isFinite(start) || !Number.isFinite(duration) || !text) {
      continue;
    }

    cues.push({
      start,
      end: start + duration,
      text
    });
  }

  return cues;
}

function parseTranscriptXml(xml) {
  const cues = [];
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match = pattern.exec(xml);

  while (match) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    const startMatch = attrs.match(/\bstart="([^"]+)"/i);
    const durationMatch = attrs.match(/\bdur="([^"]+)"/i);
    const start = Number(startMatch?.[1]);
    const duration = Number(durationMatch?.[1]);
    const text = normalizeCueText(decodeXmlEntities(body));

    if (Number.isFinite(start) && Number.isFinite(duration) && text) {
      cues.push({
        start,
        end: start + duration,
        text,
        translation: ""
      });
    }

    match = pattern.exec(xml);
  }

  return cues;
}

function parseTranscriptVtt(vtt) {
  const blocks = String(vtt)
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines[0] === "WEBVTT") {
      continue;
    }

    const timeLine = lines[0].includes("-->") ? lines[0] : lines[1];
    if (!timeLine || !timeLine.includes("-->")) {
      continue;
    }

    const [startRaw, endRaw] = timeLine.split("-->").map((part) => part.trim().split(" ")[0]);
    const start = parseVttTimestamp(startRaw);
    const end = parseVttTimestamp(endRaw);
    const bodyStartIndex = lines[0].includes("-->") ? 1 : 2;
    const text = normalizeCueText(lines.slice(bodyStartIndex).join(" "));

    if (Number.isFinite(start) && Number.isFinite(end) && text) {
      cues.push({
        start,
        end,
        text,
        translation: ""
      });
    }
  }

  return cues;
}

function parseVttTimestamp(value) {
  const match = String(value).match(/(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?/);
  if (!match) {
    return NaN;
  }

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const milliseconds = Number((match[4] || "0").padEnd(3, "0").slice(0, 3));
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function parseSubtitlePayload(raw, extension = "") {
  const normalizedExtension = extension.toLowerCase();
  const trimmed = String(raw).trim();

  if (!trimmed) {
    return [];
  }

  if (normalizedExtension === "json3" || normalizedExtension === "srv3" || trimmed.startsWith("{")) {
    return parseCaptionEvents(JSON.parse(trimmed));
  }

  if (normalizedExtension === "vtt" || trimmed.startsWith("WEBVTT")) {
    return parseTranscriptVtt(trimmed);
  }

  return parseTranscriptXml(trimmed);
}

function normalizeProxySubtitleEntry(entry) {
  const start = Number(entry?.start);
  const end = Number(entry?.end ?? start + Number(entry?.dur || 0));
  const text = normalizeCueText(entry?.text || entry?.utf8 || entry?.original || "");
  const translation = normalizeCueText(entry?.translation || entry?.ja || "");

  if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
    return null;
  }

  return {
    start,
    end: end > start ? end : start + 2,
    text,
    translation
  };
}

async function fetchTranscriptFromProxy(videoId, targetLanguage, provider = "google") {
  const proxyBaseUrl = process.env.CAPTION_WORKER_URL || process.env.TRANSCRIPT_PROXY_URL || "";
  if (!proxyBaseUrl) {
    return null;
  }

  const proxyUrl = new URL(proxyBaseUrl);
  if (!proxyUrl.searchParams.has("id")) {
    proxyUrl.searchParams.set("id", videoId);
  }

  const response = await fetch(proxyUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 Codex Transcript Proxy Client",
      "Accept": "application/json,text/xml,text/plain,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`Caption proxy failed: ${response.status}`);
  }

  const raw = await response.text();
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Caption proxy returned an empty body.");
  }

  let subtitles = [];
  if (trimmed.startsWith("<")) {
    subtitles = parseTranscriptXml(trimmed);
  } else {
    const parsed = JSON.parse(trimmed);
    subtitles = Array.isArray(parsed)
      ? parsed.map(normalizeProxySubtitleEntry).filter(Boolean)
      : [];
  }

  if (!subtitles.length) {
    throw new Error("Caption proxy returned no subtitle cues.");
  }

  const translatedSubtitles = await translateCues(subtitles, targetLanguage, "en", provider);
  return {
    source: "proxy",
    videoId,
    selectedTrackIndex: 0,
    trackLabel: "English / proxy",
    availableTracks: [
      {
        label: "English / proxy",
        languageCode: "en",
        kind: "proxy"
      }
    ],
    subtitles: translatedSubtitles
  };
}

function mergeTracks(originalCues, translatedCues) {
  return originalCues.map((cue, index) => {
    const translated = translatedCues[index];
    const translation = translated && Math.abs(translated.start - cue.start) < 1.5 ? translated.text : "";
    return {
      start: cue.start,
      end: cue.end,
      text: cue.text,
      translation
    };
  });
}

async function translateTextWithGoogle(text, targetLanguage, sourceLanguage = "") {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", sourceLanguage || "auto");
  url.searchParams.set("tl", targetLanguage);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 Codex Transcript App"
    }
  });

  if (!response.ok) {
      throw new Error(`Google翻訳の取得に失敗しました: ${response.status}`);
  }

  const payload = await response.json();
  const translated = Array.isArray(payload?.[0])
    ? payload[0].map((part) => part?.[0] || "").join("")
    : "";
  return normalizeCueText(translated);
}

async function translateTextWithDeepL(text, targetLanguage, sourceLanguage = "") {
  const apiKey = process.env.DEEPL_API_KEY || "";
  if (!apiKey) {
    throw new Error("DeepL API key is not configured");
  }

  const params = new URLSearchParams();
  params.set("text", text);
  params.set("target_lang", String(targetLanguage).split("-")[0].toUpperCase());
  if (sourceLanguage) {
    params.set("source_lang", String(sourceLanguage).split("-")[0].toUpperCase());
  }

  const response = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`DeepL translation failed: ${response.status}`);
  }

  const payload = await response.json();
  return normalizeCueText(payload?.translations?.[0]?.text || "");
}

async function translateBatchWithOpenAI(cues, targetLanguage, sourceLanguage = "") {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const model = process.env.OPENAI_TRANSLATION_MODEL || "gpt-4.1-mini";
  const languageName = String(targetLanguage || "ja");
  const sourceName = sourceLanguage || "English";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: {
        type: "json_object"
      },
      messages: [
        {
          role: "system",
          content: "You are a subtitle translator. Return only valid JSON with a translations array. Preserve line order. Keep translations natural, concise, and suitable for subtitle display."
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Translate subtitle lines",
            source_language: sourceName,
            target_language: languageName,
            lines: cues.map((cue) => cue.text)
          })
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI translation failed: ${response.status}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  const translations = Array.isArray(parsed?.translations) ? parsed.translations : [];

  return cues.map((cue, index) => ({
    ...cue,
    translation: normalizeCueText(translations[index] || cue.translation || "")
  }));
}

async function translateCues(cues, targetLanguage, sourceLanguage = "", provider = "google") {
  if (!targetLanguage || targetLanguage === sourceLanguage) {
    return cues;
  }

  if (provider === "openai") {
    const batchSize = 20;
    const translated = [];
    for (let index = 0; index < cues.length; index += batchSize) {
      const batch = cues.slice(index, index + batchSize);
      try {
        const result = await translateBatchWithOpenAI(batch, targetLanguage, sourceLanguage);
        translated.push(...result);
      } catch (_error) {
        translated.push(...batch.map((cue) => ({
          ...cue,
          translation: cue.translation || ""
        })));
      }
    }
    return translated;
  }

  const concurrency = provider === "deepl" ? 4 : 8;
  const results = Array.from({ length: cues.length });
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < cues.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const cue = cues[currentIndex];

      try {
        const translation = provider === "deepl"
          ? await translateTextWithDeepL(cue.text, targetLanguage, sourceLanguage)
          : await translateTextWithGoogle(cue.text, targetLanguage, sourceLanguage);
        results[currentIndex] = {
          ...cue,
          translation
        };
      } catch (_error) {
        results[currentIndex] = {
          ...cue,
          translation: cue.translation || ""
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(cues.length, 1)) }, () => worker()));
  return results;
}

function trackLabelFrom(track) {
  const language = track.name?.simpleText || track.name?.text || track.languageCode || track.language_code || "unknown";
  const kind = track.kind === "asr" ? "auto-generated" : "standard";
  return `${language} / ${kind}`;
}

function extractJsonObjectAfterMarker(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const startIndex = html.indexOf("{", markerIndex);
  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  let endIndex = -1;
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        endIndex = index + 1;
        break;
      }
    }
  }

  if (endIndex < 0) {
    return null;
  }

  return JSON.parse(html.slice(startIndex, endIndex));
}

function extractAnyJsonObject(html, markers) {
  for (const marker of markers) {
    const parsed = extractJsonObjectAfterMarker(html, marker);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: createYoutubePageHeaders()
  });

  if (!response.ok) {
    throw new Error("YouTubeページを取得できませんでした。");
  }

  return response.text();
}

function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) {
    return "";
  }
  return thumbnails[thumbnails.length - 1].url || thumbnails[0].url || "";
}

function mapVideoRenderer(renderer) {
  const videoId = renderer.videoId;
  if (!videoId) {
    return null;
  }

  return {
    videoId,
    title: textFromRuns(renderer.title),
    channelName: textFromRuns(renderer.ownerText || renderer.longBylineText || renderer.shortBylineText),
    viewCountText: textFromRuns(renderer.viewCountText || renderer.shortViewCountText),
    publishedTimeText: textFromRuns(renderer.publishedTimeText),
    lengthText: textFromRuns(renderer.lengthText),
    thumbnail: pickThumbnail(renderer.thumbnail?.thumbnails),
    url: `https://www.youtube.com/watch?v=${videoId}`
  };
}

function walkForKey(node, key, results = []) {
  if (!node || typeof node !== "object") {
    return results;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      walkForKey(item, key, results);
    }
    return results;
  }

  if (Object.prototype.hasOwnProperty.call(node, key)) {
    results.push(node[key]);
  }

  for (const value of Object.values(node)) {
    walkForKey(value, key, results);
  }

  return results;
}

function uniqueVideos(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.videoId || seen.has(item.videoId)) {
      return false;
    }
    seen.add(item.videoId);
    return true;
  });
}

function mapInnertubeSearchResult(item) {
  const videoId = item?.video_id || item?.id || "";
  if (!videoId) {
    return null;
  }

  return {
    videoId,
    title: item?.title?.toString?.() || "",
    channelName: item?.author?.name?.toString?.() || item?.author?.toString?.() || "",
    viewCountText: item?.short_view_count?.toString?.() || item?.view_count?.toString?.() || "",
    publishedTimeText: item?.published?.toString?.() || "",
    lengthText: item?.duration?.text || item?.length_text?.toString?.() || "",
    thumbnail: item?.best_thumbnail?.url || item?.thumbnails?.[0]?.url || "",
    url: `https://www.youtube.com/watch?v=${videoId}`
  };
}

async function searchVideos(query) {
  try {
    const innertube = await getInnertube();
    const search = await innertube.search(query, { type: "video" });
    const items = Array.isArray(search?.results) ? search.results : [];
    const mapped = uniqueVideos(items.map(mapInnertubeSearchResult).filter(Boolean)).slice(0, 20);
    if (mapped.length) {
      return mapped;
    }
  } catch (error) {
    console.warn(`[search] innertube search failed for "${query}": ${String(error?.message || error)}`);
  }

  const html = await fetchPage(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
  const data = extractAnyJsonObject(html, ["var ytInitialData = ", "window['ytInitialData'] = "]);
  if (!data) {
    throw new Error("検索結果を解析できませんでした。");
  }

  const renderers = walkForKey(data, "videoRenderer");
  return uniqueVideos(renderers.map(mapVideoRenderer).filter(Boolean)).slice(0, 20);
}

async function fetchRecommendations(videoId) {
  const html = await fetchPage(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
  const data = extractAnyJsonObject(html, ["var ytInitialData = ", "window['ytInitialData'] = "]);
  const playerResponse = extractJsonObjectAfterMarker(html, "var ytInitialPlayerResponse = ");

  const compactRenderers = data ? walkForKey(data, "compactVideoRenderer") : [];
  const gridRenderers = data ? walkForKey(data, "videoRenderer") : [];
  const directItems = uniqueVideos([...compactRenderers, ...gridRenderers].map(mapVideoRenderer).filter(Boolean))
    .filter((item) => item.videoId !== videoId)
    .slice(0, 16);

  if (directItems.length) {
    return directItems;
  }

  const title = playerResponse?.videoDetails?.title || "";
  const author = playerResponse?.videoDetails?.author || "";
  const fallbackQuery = [title, author].filter(Boolean).join(" ").trim();
  if (!fallbackQuery) {
    return [];
  }

  const fallbackItems = await searchVideos(fallbackQuery);
  return fallbackItems.filter((item) => item.videoId !== videoId).slice(0, 16);
}

async function fetchCaptionTracksFromYoutubei(videoId, client) {
  const innertube = await getInnertube();
  const info = await innertube.getBasicInfo(videoId, { client });
  const tracks = Array.isArray(info?.captions?.caption_tracks) ? info.captions.caption_tracks : [];

  return {
    defaultTrackIndex: 0,
    tracks: tracks.map((track) => ({
      baseUrl: track.base_url,
      languageCode: track.language_code,
      kind: track.kind || "",
      isTranslatable: Boolean(track.is_translatable),
      label: trackLabelFrom(track)
    }))
  };
}

async function fetchCaptionTracks(videoId) {
  for (const client of ["IOS", "WEB"]) {
    try {
      const trackData = await fetchCaptionTracksFromYoutubei(videoId, client);
      if (trackData.tracks.length) {
        return trackData;
      }
    } catch (error) {
      console.warn(`[transcript] youtubei track lookup failed for ${videoId} client=${client}: ${String(error?.message || error)}`);
      // Fall through to the next client or HTML parsing.
    }
  }

  const html = await fetchPage(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
  const playerResponse = extractJsonObjectAfterMarker(html, "var ytInitialPlayerResponse = ");
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) {
    throw new Error("利用可能な字幕トラックが見つかりませんでした。");
  }

  const defaultTrackIndex = playerResponse?.captions?.playerCaptionsTracklistRenderer?.audioTracks?.[0]?.defaultCaptionTrackIndex ?? 0;
  return {
    defaultTrackIndex,
    tracks: tracks.map((track) => ({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode,
      kind: track.kind || "",
      isTranslatable: Boolean(track.isTranslatable),
      label: trackLabelFrom(track)
    }))
  };
}

function buildTrackUrl(baseUrl, options = {}) {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("fmt", "json3");
  if (options.targetLanguage) {
    parsed.searchParams.set("tlang", options.targetLanguage);
  }
  return parsed.toString();
}

function buildTimedTextTrack(videoId, languageCode, kind = "") {
  const parsed = new URL("https://www.youtube.com/api/timedtext");
  parsed.searchParams.set("v", videoId);
  parsed.searchParams.set("lang", languageCode);
  parsed.searchParams.set("fmt", "json3");
  if (kind) {
    parsed.searchParams.set("kind", kind);
  }

  return {
    baseUrl: parsed.toString(),
    languageCode,
    kind,
    isTranslatable: false,
    label: `${languageCode} / ${kind === "asr" ? "auto-generated" : "timedtext"}`
  };
}

async function fetchTrackCues(track, targetLanguage, provider = "google") {
  const originalResponse = await fetch(buildTrackUrl(track.baseUrl), {
    headers: createYoutubePageHeaders({
      "Accept": "application/json,text/plain,*/*"
    })
  });

  if (!originalResponse.ok) {
    throw new Error("字幕本体を取得できませんでした。");
  }

  const originalText = await originalResponse.text();
  if (!originalText.trim()) {
    throw new Error("empty-caption-body");
  }

  const originalCues = parseCaptionEvents(JSON.parse(originalText));
  if (!originalCues.length) {
    throw new Error("字幕イベントを解析できませんでした。");
  }

  const mergedCues = mergeTracks(originalCues, []);
  return translateCues(mergedCues, targetLanguage, track.languageCode, provider);
}

function chooseDefaultTrackIndex(tracks, fallbackIndex = 0) {
  const englishIndex = tracks.findIndex((track) => track.languageCode === "en" && track.kind !== "asr");
  if (englishIndex >= 0) {
    return englishIndex;
  }

  const manualIndex = tracks.findIndex((track) => track.kind !== "asr");
  if (manualIndex >= 0) {
    return manualIndex;
  }

  return fallbackIndex;
}

async function ensureCacheDirs() {
  await fsp.mkdir(transcriptCacheDir, { recursive: true });
}

function sanitizeCachePart(value) {
  return String(value || "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    || "default";
}

function buildTranscriptCacheKey(videoId, language, provider = "google", trackIndex = 0) {
  return [
    sanitizeCachePart(videoId),
    sanitizeCachePart(language),
    sanitizeCachePart(provider),
    sanitizeCachePart(trackIndex)
  ].join(".");
}

function cachePathFor(cacheKey) {
  return path.join(transcriptCacheDir, `${cacheKey}.json`);
}

async function readCachedTranscript(cacheKey) {
  try {
    const raw = await fsp.readFile(cachePathFor(cacheKey), "utf8");
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

async function writeCachedTranscript(cacheKey, payload) {
  await ensureCacheDirs();
  await fsp.writeFile(cachePathFor(cacheKey), JSON.stringify(payload), "utf8");
}

async function loadTransformersModule() {
  if (!transformersModulePromise) {
    transformersModulePromise = import("@xenova/transformers").then((mod) => {
      mod.env.cacheDir = path.join(cacheDir, "transformers");
      mod.env.allowLocalModels = true;
      return mod;
    });
  }
  return transformersModulePromise;
}

async function loadYoutubeiModule() {
  if (!youtubeiModulePromise) {
    youtubeiModulePromise = import("youtubei.js");
  }
  return youtubeiModulePromise;
}

async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = (async () => {
      const youtubeiModule = await loadYoutubeiModule();
      const Innertube = youtubeiModule.default || youtubeiModule.Innertube;
      return Innertube.create();
    })();
  }
  return innertubePromise;
}

async function getAsrPipeline(language) {
  const modelId = language === "en" ? "Xenova/whisper-tiny.en" : "Xenova/whisper-tiny";
  if (!asrPipelineCache.has(modelId)) {
    asrPipelineCache.set(modelId, (async () => {
      const { pipeline } = await loadTransformersModule();
      return pipeline("automatic-speech-recognition", modelId, { quantized: true });
    })());
  }
  return asrPipelineCache.get(modelId);
}

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stderrBuffer = Buffer.concat(stderrChunks);
      const stdout = stdoutBuffer.toString("utf8");
      const stderr = stderrBuffer.toString("utf8");

      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`.trim()));
        return;
      }

      resolve({ stdout, stderr, stdoutBuffer, stderrBuffer });
    });
  });
}

async function withTempDir(callback) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "yt-ios-"));
  try {
    return await callback(tempDir);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runYtDlp(args, options = {}) {
  return runCommand(ytDlpBinary, args, options);
}

async function logYtDlpDiagnostics(videoId, cookieArgs) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  for (const diagnosticArgs of [
    ["--list-subs"],
    ["--list-formats"]
  ]) {
    try {
      const { stdout, stderr } = await runYtDlp([
        ...cookieArgs,
        "--no-playlist",
        "--no-warnings",
        "--extractor-args", "youtube:player_client=android,web",
        ...diagnosticArgs,
        videoUrl
      ]);
      const output = (stdout || stderr || "").trim();
      if (output) {
        console.warn(`[transcript] yt-dlp diagnostic ${diagnosticArgs[0]} for ${videoId}:\n${output}`);
      }
    } catch (error) {
      console.warn(`[transcript] yt-dlp diagnostic ${diagnosticArgs[0]} failed for ${videoId}: ${String(error?.message || error)}`);
    }
  }
}

async function getYtDlpCookieArgs(tempDir) {
  const cookiePathFromEnv = process.env.YT_DLP_COOKIES_PATH || process.env.YOUTUBE_COOKIES_PATH || "";
  const cookieText = process.env.YT_DLP_COOKIES || process.env.YOUTUBE_COOKIES || "";
  const cookieBase64 = process.env.YT_DLP_COOKIES_BASE64 || "";

  if (cookiePathFromEnv) {
    try {
      const stat = await fsp.stat(cookiePathFromEnv);
      console.log(`[transcript] yt-dlp cookies path ready: ${cookiePathFromEnv} (${stat.size} bytes)`);
    } catch (error) {
      console.warn(`[transcript] yt-dlp cookies path unavailable: ${cookiePathFromEnv} (${String(error?.message || error)})`);
    }
    return ["--cookies", cookiePathFromEnv];
  }

  let resolvedCookieText = cookieText;
  if (!resolvedCookieText && cookieBase64) {
    resolvedCookieText = Buffer.from(cookieBase64, "base64").toString("utf8");
  }

  if (!resolvedCookieText.trim()) {
    return [];
  }

  const cookiePath = path.join(tempDir, "youtube-cookies.txt");
  await fsp.writeFile(cookiePath, resolvedCookieText, "utf8");
  return ["--cookies", cookiePath];
}

async function findFirstFile(directory, predicate) {
  const names = await fsp.readdir(directory);
  const match = names.find(predicate);
  return match ? path.join(directory, match) : "";
}

function pickYtDlpSubtitleCandidate(metadata) {
  const sources = [
    metadata?.subtitles || {},
    metadata?.automatic_captions || {}
  ];
  const languageKeys = [];

  for (const source of sources) {
    for (const key of Object.keys(source)) {
      if (key === "live_chat") {
        continue;
      }
      if (key === "en" || key.startsWith("en-") || key.startsWith("en_") || key.includes("en")) {
        languageKeys.push([source, key]);
      }
    }
  }

  for (const [source, key] of languageKeys) {
    const tracks = Array.isArray(source[key]) ? source[key] : [];
    for (const preferredExt of ["json3", "srv3", "ttml", "vtt"]) {
      const candidate = tracks.find((track) => track?.url && String(track.ext || "").toLowerCase() === preferredExt);
      if (candidate) {
        return candidate;
      }
    }
    const fallback = tracks.find((track) => track?.url);
    if (fallback) {
      return fallback;
    }
  }

  return null;
}

async function fetchTranscriptWithYtDlp(videoId, language, provider = "google") {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  return withTempDir(async (tempDir) => {
    const cookieArgs = await getYtDlpCookieArgs(tempDir);
    try {
      const { stdout } = await runYtDlp([
        ...cookieArgs,
        "--skip-download",
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        "--extractor-args", "youtube:player_client=android,web",
        videoUrl
      ]);
      const metadata = JSON.parse(stdout || "{}");
      const candidate = pickYtDlpSubtitleCandidate(metadata);
      if (candidate?.url) {
        const response = await fetch(candidate.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 Codex Transcript App",
            "Accept": "application/json,text/plain,text/vtt,text/xml,*/*"
          }
        });
        const raw = await response.text();
        const parsedSubtitles = parseSubtitlePayload(raw, candidate.ext || "");
        const subtitles = await translateCues(parsedSubtitles, language, "en", provider);
        if (subtitles.length) {
          return {
            source: "yt-dlp",
            videoId,
            selectedTrackIndex: 0,
            trackLabel: "English / yt-dlp",
            availableTracks: [
              {
                label: "English / yt-dlp",
                languageCode: "en",
                kind: "yt-dlp"
              }
            ],
            subtitles
          };
        }
      }
    } catch (_error) {
      // Fall through to file-based subtitle extraction.
    }

    let subtitlePath = "";

    for (const subtitleFormat of ["json3", "srv3", "vtt"]) {
      try {
        await runYtDlp([
          ...cookieArgs,
          "--skip-download",
          "--no-playlist",
          "--no-warnings",
          "--extractor-args", "youtube:player_client=android,web",
          "--write-subs",
          "--write-auto-subs",
          "--sub-langs", "en.*,en",
          "--sub-format", subtitleFormat,
          "--output", "%(id)s.%(ext)s",
          "--paths", tempDir,
          videoUrl
        ]);

        subtitlePath = await findFirstFile(
          tempDir,
          (name) => name.startsWith(`${videoId}.`) && (name.endsWith(".json3") || name.endsWith(".srv3") || name.endsWith(".vtt"))
        );

        if (subtitlePath) {
          break;
        }
      } catch (_error) {
        // Try the next subtitle format.
      }
    }

    if (!subtitlePath) {
      const files = await fsp.readdir(tempDir).catch(() => []);
      console.warn(`[transcript] yt-dlp subtitle files for ${videoId}: ${files.join(", ") || "(none)"}`);
      await logYtDlpDiagnostics(videoId, cookieArgs);
      throw new Error("yt-dlp did not produce an English subtitle file.");
    }

    const raw = await fsp.readFile(subtitlePath, "utf8");
    const parsedSubtitles = parseSubtitlePayload(raw, path.extname(subtitlePath).replace(".", ""));

    const subtitles = await translateCues(parsedSubtitles, language, "en", provider);
    if (!subtitles.length) {
      throw new Error("yt-dlp subtitle file contained no cues.");
    }

    return {
      source: "yt-dlp",
      videoId,
      selectedTrackIndex: 0,
      trackLabel: "English / yt-dlp",
      availableTracks: [
        {
          label: "English / yt-dlp",
          languageCode: "en",
          kind: "yt-dlp"
        }
      ],
      subtitles
    };
  });
}

async function downloadAudioWithYtDlp(videoId) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  return withTempDir(async (tempDir) => {
    const cookieArgs = await getYtDlpCookieArgs(tempDir);
    let lastError = null;

    for (const audioArgs of [
      ["--extractor-args", "youtube:player_client=android,web", "-f", "ba"],
      ["--extractor-args", "youtube:player_client=android,web"],
      []
    ]) {
      try {
        await runYtDlp([
          ...cookieArgs,
          "--no-playlist",
          "--no-warnings",
          "--output", "%(id)s.%(ext)s",
          "--paths", tempDir,
          ...audioArgs,
          videoUrl
        ]);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      await logYtDlpDiagnostics(videoId, cookieArgs);
      throw lastError;
    }

    const audioPath = await findFirstFile(
      tempDir,
      (name) => name.startsWith(`${videoId}.`) && !name.endsWith(".part")
    );

    if (!audioPath) {
      throw new Error("yt-dlp did not produce an audio file.");
    }

    const { stdoutBuffer } = await runCommand(ffmpegPath, [
      "-i", audioPath,
      "-ac", "1",
      "-ar", "16000",
      "-f", "f32le",
      "pipe:1"
    ], {
      cwd: tempDir
    });

    const buffer = stdoutBuffer;
    const sampleCount = Math.floor(buffer.byteLength / 4);
    const audio = new Float32Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      audio[index] = buffer.readFloatLE(index * 4);
    }
    return audio;
  });
}

async function downloadAudioAsFloat32(videoId) {
  try {
    return await downloadAudioWithYtDlp(videoId);
  } catch (error) {
    console.warn(`[transcript] yt-dlp audio fallback failed for ${videoId}: ${String(error?.message || error)}`);
  }

  return new Promise((resolve, reject) => {
    (async () => {
      const innertube = await getInnertube();
      const audioStream = await innertube.download(videoId, {
        client: "ANDROID",
        type: "audio",
        quality: "best",
        format: "mp4",
        codec: "mp4a"
      });

      const reader = audioStream.getReader();
      const ffmpeg = spawn(ffmpegPath, [
        "-i", "pipe:0",
        "-ac", "1",
        "-ar", "16000",
        "-f", "f32le",
        "pipe:1"
      ], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      const stdoutChunks = [];
      const stderrChunks = [];

      ffmpeg.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      ffmpeg.stderr.on("data", (chunk) => stderrChunks.push(chunk));
      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg failed: ${Buffer.concat(stderrChunks).toString("utf8")}`));
          return;
        }

        const buffer = Buffer.concat(stdoutChunks);
        const sampleCount = Math.floor(buffer.byteLength / 4);
        const audio = new Float32Array(sampleCount);
        for (let index = 0; index < sampleCount; index += 1) {
          audio[index] = buffer.readFloatLE(index * 4);
        }
        resolve(audio);
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        ffmpeg.stdin.write(Buffer.from(value));
      }

      ffmpeg.stdin.end();
    })().catch(reject);
  });
}

function normalizeAsrChunks(output) {
  const chunks = Array.isArray(output?.chunks) && output.chunks.length
    ? output.chunks
    : [{ timestamp: [0, 0], text: output?.text || "" }];

  let lastEnd = 0;
  return chunks
    .map((chunk) => {
      const start = Number(chunk?.timestamp?.[0] ?? lastEnd);
      const end = Number(chunk?.timestamp?.[1] ?? start + 3);
      lastEnd = Number.isFinite(end) ? end : start + 3;
      const text = normalizeCueText(chunk?.text || "");
      if (!text || !Number.isFinite(start)) {
        return null;
      }

      return {
        start,
        end: Number.isFinite(end) && end > start ? end : start + 3,
        text,
        translation: ""
      };
    })
    .filter(Boolean);
}

async function transcribeWithAsr(videoId, language, provider = "google") {
  const targetLanguage = language || "ja";
  const cacheKey = buildTranscriptCacheKey(videoId, targetLanguage, provider, "asr");
  const cached = await readCachedTranscript(cacheKey);
  if (cached) {
    return cached;
  }

  const audio = await downloadAudioAsFloat32(videoId);
  const transcriber = await getAsrPipeline(language === "en" ? "en" : "multi");
  const result = await transcriber(audio, {
    chunk_length_s: 25,
    stride_length_s: 4,
    return_timestamps: true,
    ...(language === "en" ? { language: "english" } : {})
  });

  const subtitles = await translateCues(
    normalizeAsrChunks(result),
    targetLanguage,
    language === "en" ? "en" : "",
    provider
  );
  const payload = {
    source: "asr",
    trackLabel: "ASR fallback",
    availableTracks: [],
    subtitles
  };

  await writeCachedTranscript(cacheKey, payload);
  return payload;
}

async function getTranscriptWithFallback(videoId, trackIndex, language, provider = "google") {
  try {
    const trackData = await fetchCaptionTracks(videoId);
    const tracks = trackData.tracks;
    const fallbackIndex = chooseDefaultTrackIndex(tracks, trackData.defaultTrackIndex);
    const normalizedTrackIndex = Number.isInteger(trackIndex) && trackIndex >= 0 ? trackIndex : fallbackIndex;
    const selectedTrack = tracks[normalizedTrackIndex] || tracks[fallbackIndex] || tracks[0];
    const selectedTrackIndex = tracks.findIndex((track) => track.baseUrl === selectedTrack.baseUrl);
    const subtitles = await fetchTrackCues(selectedTrack, language, provider);

    return {
      source: "youtube",
      videoId,
      selectedTrackIndex,
      trackLabel: selectedTrack.label,
      availableTracks: tracks.map((track) => ({
        label: track.label,
        languageCode: track.languageCode,
        kind: track.kind
      })),
      subtitles
    };
  } catch (error) {
    const message = String(error?.message || error);
    const shouldTryAsr = message === "empty-caption-body"
      || message.includes("字幕本体")
      || message.includes("empty-caption-body")
      || message.includes("利用可能な字幕トラック")
      || message.includes("字幕イベント");

    if (!shouldTryAsr) {
      throw error;
    }

    const asrPayload = await transcribeWithAsr(videoId, language, provider);
    return {
      source: "asr",
      videoId,
      selectedTrackIndex: 0,
      trackLabel: asrPayload.trackLabel,
      availableTracks: [],
      subtitles: asrPayload.subtitles
    };
  }
}

async function getYoutubeTranscriptOnly(videoId, trackIndex, language, provider = "google") {
  try {
    return await fetchTranscriptWithYtDlp(videoId, language, provider);
  } catch (error) {
    console.warn(`[transcript] yt-dlp subtitle lookup failed for ${videoId}: ${String(error?.message || error)}`);
  }

  try {
    const trackData = await fetchCaptionTracks(videoId);
    const tracks = trackData.tracks;
    const fallbackIndex = chooseDefaultTrackIndex(tracks, trackData.defaultTrackIndex);
    const normalizedTrackIndex = Number.isInteger(trackIndex) && trackIndex >= 0 ? trackIndex : fallbackIndex;
    const selectedTrack = tracks[normalizedTrackIndex] || tracks[fallbackIndex] || tracks[0];
    const selectedTrackIndex = tracks.findIndex((track) => track.baseUrl === selectedTrack.baseUrl);
    const subtitles = await fetchTrackCues(selectedTrack, language, provider);

    return {
      source: "youtube",
      videoId,
      selectedTrackIndex,
      trackLabel: selectedTrack.label,
      availableTracks: tracks.map((track) => ({
        label: track.label,
        languageCode: track.languageCode,
        kind: track.kind
      })),
      subtitles
    };
  } catch (error) {
    const proxyPayload = await fetchTranscriptFromProxy(videoId, language, provider).catch(() => null);
    if (proxyPayload) {
      return proxyPayload;
    }
    throw error;
  }
}

async function getTranscriptWithAggressiveFallback(videoId, trackIndex, language, provider = "google") {
  try {
    return await withTimeout(
      getYoutubeTranscriptOnly(videoId, trackIndex, language, provider),
      8000,
      "Caption lookup timed out."
    );
  } catch (error) {
    const captionErrorMessage = String(error?.message || error);

    try {
      const asrPayload = await withTimeout(
        transcribeWithAsr(videoId, language, provider),
        12000,
        "ASR timed out."
      );
      return {
        source: "asr",
        videoId,
        selectedTrackIndex: 0,
        trackLabel: asrPayload.trackLabel,
        availableTracks: [],
        subtitles: asrPayload.subtitles
      };
    } catch (asrError) {
      const asrErrorMessage = String(asrError?.message || asrError);
      throw new Error(
        `字幕取得とASRフォールバックの両方に失敗しました。caption=${captionErrorMessage} / asr=${asrErrorMessage}`
      );
    }
  }
}

async function fetchCaptionTracks(videoId) {
  for (const client of ["ANDROID", "WEB", "IOS"]) {
    try {
      const trackData = await fetchCaptionTracksFromYoutubei(videoId, client);
      if (trackData.tracks.length) {
        return trackData;
      }
    } catch (error) {
      console.warn(`[transcript] youtubei track lookup failed for ${videoId} client=${client}: ${String(error?.message || error)}`);
    }
  }

  try {
    const html = await fetchPage(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    const playerResponse = extractJsonObjectAfterMarker(html, "var ytInitialPlayerResponse = ");
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (tracks.length) {
      const defaultTrackIndex = playerResponse?.captions?.playerCaptionsTracklistRenderer?.audioTracks?.[0]?.defaultCaptionTrackIndex ?? 0;
      return {
        defaultTrackIndex,
        tracks: tracks.map((track) => ({
          baseUrl: track.baseUrl,
          languageCode: track.languageCode,
          kind: track.kind || "",
          isTranslatable: Boolean(track.isTranslatable),
          label: trackLabelFrom(track)
        }))
      };
    }
  } catch (error) {
    console.warn(`[transcript] html caption fallback failed for ${videoId}: ${String(error?.message || error)}`);
  }

  for (const track of [
    buildTimedTextTrack(videoId, "en"),
    buildTimedTextTrack(videoId, "en", "asr")
  ]) {
    try {
      const response = await fetch(track.baseUrl, {
        headers: createYoutubePageHeaders({
          "Accept": "application/json,text/plain,*/*"
        })
      });
      const body = await response.text();
      if (!response.ok || !body.trim()) {
        continue;
      }

      const cues = parseCaptionEvents(JSON.parse(body));
      if (cues.length) {
        return {
          defaultTrackIndex: 0,
          tracks: [track]
        };
      }
    } catch (error) {
      console.warn(`[transcript] timedtext fallback failed for ${videoId} lang=${track.languageCode} kind=${track.kind || "default"}: ${String(error?.message || error)}`);
    }
  }

  try {
    const info = await ytdl.getInfo(videoId, {
      requestOptions: {
        headers: createRequestHeaders()
      }
    });
    const ytdlTracks = info?.player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (ytdlTracks.length) {
      const defaultTrackIndex = info?.player_response?.captions?.playerCaptionsTracklistRenderer?.audioTracks?.[0]?.defaultCaptionTrackIndex ?? 0;
      return {
        defaultTrackIndex,
        tracks: ytdlTracks.map((track) => ({
          baseUrl: track.baseUrl,
          languageCode: track.languageCode,
          kind: track.kind || "",
          isTranslatable: Boolean(track.isTranslatable),
          label: trackLabelFrom(track)
        }))
      };
    }
  } catch (error) {
    console.warn(`[transcript] ytdl caption fallback failed for ${videoId}: ${String(error?.message || error)}`);
  }

  throw new Error("No caption tracks were available for this video on the deployed server.");
}

async function handleTranscriptApi(requestUrl, response) {
  const videoId = extractVideoId(requestUrl.searchParams.get("videoId"));
  const trackIndex = Number(requestUrl.searchParams.get("trackIndex") || "0");
  const language = requestUrl.searchParams.get("lang") || "ja";
  const provider = requestUrl.searchParams.get("provider") || "google";

  if (!videoId) {
    sendJson(response, 400, { error: "Missing or invalid videoId." });
    return;
  }

  const cacheKey = buildTranscriptCacheKey(videoId, language, provider, trackIndex);

  try {
    const cached = await readCachedTranscript(cacheKey);
    if (cached) {
      sendJson(response, 200, cached);
      return;
    }

    if (transcriptRequestCache.has(cacheKey)) {
      const pendingPayload = await transcriptRequestCache.get(cacheKey);
      sendJson(response, 200, pendingPayload);
      return;
    }

    const pendingRequest = (async () => {
      const payload = await getTranscriptWithAggressiveFallback(videoId, trackIndex, language, provider);
      await writeCachedTranscript(cacheKey, payload);
      return payload;
    })();

    transcriptRequestCache.set(cacheKey, pendingRequest);
    const payload = await pendingRequest;
    sendJson(response, 200, payload);
  } catch (error) {
    console.error(`[transcript] failed for videoId=${videoId} trackIndex=${trackIndex} lang=${language} provider=${provider}`, error);
    sendJson(response, 500, {
      error: error.message || "Failed to fetch transcript."
    });
  } finally {
    transcriptRequestCache.delete(cacheKey);
  }
}

async function handleSearchApi(requestUrl, response) {
  const query = requestUrl.searchParams.get("q")?.trim();
  if (!query) {
    sendJson(response, 400, { error: "検索ワードを指定してください。" });
    return;
  }

  try {
    const items = await searchVideos(query);
    sendJson(response, 200, { query, items });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "検索に失敗しました。" });
  }
}

async function handleRecommendationsApi(requestUrl, response) {
  const videoId = extractVideoId(requestUrl.searchParams.get("videoId"));
  if (!videoId) {
    sendJson(response, 400, { error: "有効な videoId を指定してください。" });
    return;
  }

  try {
    const items = await fetchRecommendations(videoId);
    sendJson(response, 200, { videoId, items });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "おすすめ動画の取得に失敗しました。" });
  }
}

async function handleTranscriptApi(requestUrl, response) {
  const videoId = extractVideoId(requestUrl.searchParams.get("videoId"));
  const trackIndex = Number(requestUrl.searchParams.get("trackIndex") || "0");
  const language = requestUrl.searchParams.get("lang") || "ja";
  const provider = requestUrl.searchParams.get("provider") || "google";

  if (!videoId) {
    sendJson(response, 400, { error: "有効な videoId を指定してください。" });
    return;
  }

  try {
    const payload = await getTranscriptWithAggressiveFallback(videoId, trackIndex, language, provider);
    sendJson(response, 200, payload);
  } catch (error) {
    sendJson(response, 500, {
      error: error.message || "字幕の取得に失敗しました。"
    });
  }
}

async function handleDictionaryApi(requestUrl, response) {
  const word = String(requestUrl.searchParams.get("word") || "").trim();
  const provider = requestUrl.searchParams.get("provider") || "google";
  const cacheKey = `${provider}:${word.toLowerCase()}`;

  if (!word) {
    sendJson(response, 400, { error: "word を指定してください。" });
    return;
  }

  try {
    const cached = getMemoryCache(dictionaryResponseCache, cacheKey);
    if (cached) {
      sendJson(response, 200, cached);
      return;
    }

    if (dictionaryRequestCache.has(cacheKey)) {
      const pendingPayload = await dictionaryRequestCache.get(cacheKey);
      sendJson(response, 200, pendingPayload);
      return;
    }

    const pendingRequest = (async () => {
    const dictionaryResponse = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 Codex Transcript App"
      }
    });

    if (!dictionaryResponse.ok) {
      throw new Error("辞書情報を取得できませんでした。");
    }

    const payload = await dictionaryResponse.json();
    const entry = Array.isArray(payload) ? payload[0] : null;
    if (!entry) {
      throw new Error("辞書情報を取得できませんでした。");
    }

    const phonetic = entry.phonetic || entry.phonetics?.find((item) => item.text)?.text || "";
    const audioUrl = entry.phonetics?.find((item) => item.audio)?.audio || "";
    const meanings = Array.isArray(entry.meanings) ? entry.meanings.slice(0, 3) : [];
    const translate = provider === "deepl" ? translateTextWithDeepL : translateTextWithGoogle;
    const wordTranslationPromise = translate(entry.word || word, "ja", "en").catch(() => "");

    const translatedMeanings = await Promise.all(
      meanings.map(async (meaning) => {
        const definitions = Array.isArray(meaning.definitions) ? meaning.definitions.slice(0, 2) : [];
        const translatedDefinitions = await Promise.all(
          definitions.map(async (definition) => {
            const english = normalizeCueText(definition.definition || "");
            const japanese = english
              ? await translate(english, "ja", "en").catch(() => "")
              : "";
            return {
              en: english,
              ja: japanese
            };
          })
        );

        return {
          partOfSpeech: meaning.partOfSpeech || "",
          definitions: translatedDefinitions
        };
      })
    );

    const result = {
      word: entry.word || word,
      phonetic,
      audioUrl,
      wordTranslation: await wordTranslationPromise,
      meaning: translatedMeanings[0]?.definitions?.[0]?.ja || "",
      meanings: translatedMeanings
    };

    setMemoryCache(dictionaryResponseCache, cacheKey, result, DICTIONARY_CACHE_TTL_MS);
    return result;
    })();

    dictionaryRequestCache.set(cacheKey, pendingRequest);
    const result = await pendingRequest;
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 500, {
      error: error.message || "辞書情報の取得に失敗しました。"
    });
  } finally {
    dictionaryRequestCache.delete(cacheKey);
  }
}

async function serveStatic(request, requestUrl, response) {
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const targetPath = path.resolve(rootDir, `.${pathname}`);
  if (!targetPath.startsWith(rootDir)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const stat = await fsp.stat(targetPath);
    if (stat.isDirectory()) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(targetPath).toLowerCase();
    const cacheControl = pathname === "/sw.js"
      ? "no-store"
      : ext === ".js" || ext === ".css"
        ? "public, max-age=3600, must-revalidate"
        : ext === ".html"
          ? "no-cache"
      : ext === ".png" || ext === ".svg" || ext === ".ico"
        ? "public, max-age=86400"
        : "no-store";
    const etag = createStaticEtag(stat);
    const lastModified = stat.mtime.toUTCString();

    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, {
        "Cache-Control": cacheControl,
        "ETag": etag,
        "Last-Modified": lastModified
      });
      response.end();
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": cacheControl,
      "ETag": etag,
      "Last-Modified": lastModified
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const fileBuffer = await fsp.readFile(targetPath);
    response.end(fileBuffer);
  } catch (error) {
    console.error(`[static] failed path=${pathname} target=${targetPath}`, error);
    sendJson(response, 404, { error: "Not found" });
  }
}

async function handleTranscriptApi(requestUrl, response) {
  const videoId = extractVideoId(requestUrl.searchParams.get("videoId"));
  const trackIndex = Number(requestUrl.searchParams.get("trackIndex") || "0");
  const language = requestUrl.searchParams.get("lang") || "ja";
  const provider = requestUrl.searchParams.get("provider") || "google";

  if (!videoId) {
    sendJson(response, 400, { error: "Missing or invalid videoId." });
    return;
  }

  try {
    const payload = await getTranscriptWithAggressiveFallback(videoId, trackIndex, language, provider);
    sendJson(response, 200, payload);
  } catch (error) {
    console.error(`[transcript] failed for videoId=${videoId} trackIndex=${trackIndex} lang=${language} provider=${provider}`, error);
    sendJson(response, 500, {
      error: error.message || "Failed to fetch transcript."
    });
  }
}

async function handleSearchApi(requestUrl, response) {
  const query = requestUrl.searchParams.get("q")?.trim();
  if (!query) {
    sendJson(response, 400, { error: "検索ワードを指定してください。" });
    return;
  }

  const cacheKey = query.toLowerCase();

  try {
    const cached = getMemoryCache(searchResponseCache, cacheKey);
    if (cached) {
      sendJson(response, 200, cached);
      return;
    }

    if (searchRequestCache.has(cacheKey)) {
      const pendingPayload = await searchRequestCache.get(cacheKey);
      sendJson(response, 200, pendingPayload);
      return;
    }

    const pendingRequest = (async () => {
      const items = await searchVideos(query);
      const payload = { query, items };
      setMemoryCache(searchResponseCache, cacheKey, payload, SEARCH_CACHE_TTL_MS);
      return payload;
    })();

    searchRequestCache.set(cacheKey, pendingRequest);
    const payload = await pendingRequest;
    sendJson(response, 200, payload);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "検索に失敗しました。" });
  } finally {
    searchRequestCache.delete(cacheKey);
  }
}

async function handleRecommendationsApi(requestUrl, response) {
  const videoId = extractVideoId(requestUrl.searchParams.get("videoId"));
  if (!videoId) {
    sendJson(response, 400, { error: "有効な videoId を指定してください。" });
    return;
  }

  const cacheKey = videoId;

  try {
    const cached = getMemoryCache(recommendationResponseCache, cacheKey);
    if (cached) {
      sendJson(response, 200, cached);
      return;
    }

    if (recommendationRequestCache.has(cacheKey)) {
      const pendingPayload = await recommendationRequestCache.get(cacheKey);
      sendJson(response, 200, pendingPayload);
      return;
    }

    const pendingRequest = (async () => {
      const items = await fetchRecommendations(videoId);
      const payload = { videoId, items };
      setMemoryCache(recommendationResponseCache, cacheKey, payload, RECOMMENDATION_CACHE_TTL_MS);
      return payload;
    })();

    recommendationRequestCache.set(cacheKey, pendingRequest);
    const payload = await pendingRequest;
    sendJson(response, 200, payload);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "おすすめ動画の取得に失敗しました。" });
  } finally {
    recommendationRequestCache.delete(cacheKey);
  }
}

async function handleTranscriptApi(requestUrl, response) {
  const videoId = extractVideoId(requestUrl.searchParams.get("videoId"));
  const trackIndex = Number(requestUrl.searchParams.get("trackIndex") || "0");
  const language = requestUrl.searchParams.get("lang") || "ja";
  const provider = requestUrl.searchParams.get("provider") || "google";

  if (!videoId) {
    sendJson(response, 400, { error: "Missing or invalid videoId." });
    return;
  }

  const cacheKey = buildTranscriptCacheKey(videoId, language, provider, trackIndex);

  try {
    const cached = await readCachedTranscript(cacheKey);
    if (cached) {
      sendJson(response, 200, cached);
      return;
    }

    if (transcriptRequestCache.has(cacheKey)) {
      const pendingPayload = await transcriptRequestCache.get(cacheKey);
      sendJson(response, 200, pendingPayload);
      return;
    }

    const pendingRequest = (async () => {
      const payload = await getTranscriptWithAggressiveFallback(videoId, trackIndex, language, provider);
      await writeCachedTranscript(cacheKey, payload);
      return payload;
    })();

    transcriptRequestCache.set(cacheKey, pendingRequest);
    const payload = await pendingRequest;
    sendJson(response, 200, payload);
  } catch (error) {
    console.error(`[transcript] failed for videoId=${videoId} trackIndex=${trackIndex} lang=${language} provider=${provider}`, error);
    sendJson(response, 500, {
      error: error.message || "Failed to fetch transcript."
    });
  } finally {
    transcriptRequestCache.delete(cacheKey);
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (requestUrl.pathname === "/api/search") {
    await handleSearchApi(requestUrl, response);
    return;
  }

  if (requestUrl.pathname === "/api/recommendations") {
    await handleRecommendationsApi(requestUrl, response);
    return;
  }

  if (requestUrl.pathname === "/api/transcript") {
    await handleTranscriptApi(requestUrl, response);
    return;
  }

  if (requestUrl.pathname === "/api/dictionary") {
    await handleDictionaryApi(requestUrl, response);
    return;
  }

  await serveStatic(request, requestUrl, response);
});

function getLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

server.listen(port, host, () => {
  const lanAddress = getLanAddress();
  console.log(`Server running at http://localhost:${port}`);
  if (process.env.YT_DLP_COOKIES_PATH || process.env.YOUTUBE_COOKIES_PATH) {
    console.log(`[transcript] configured yt-dlp cookies path: ${process.env.YT_DLP_COOKIES_PATH || process.env.YOUTUBE_COOKIES_PATH}`);
  }
  if (host === "0.0.0.0" && lanAddress) {
    console.log(`Open on iPhone Safari: http://${lanAddress}:${port}`);
  }
});
