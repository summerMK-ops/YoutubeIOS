function createYoutubeHeaders(extraHeaders = {}) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Origin": "https://www.youtube.com",
    "Referer": "https://www.youtube.com/",
    "Cookie": "CONSENT=YES+1",
    ...extraHeaders
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });
}

function normalizeCueText(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCaptionEvents(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const cues = [];

  for (const event of events) {
    const start = Number(event?.tStartMs) / 1000;
    const duration = Number(event?.dDurationMs) / 1000;
    const text = normalizeCueText(
      Array.isArray(event?.segs) ? event.segs.map((segment) => segment?.utf8 || "").join("") : ""
    );

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
  let escaped = false;

  for (let index = startIndex; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
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

function buildTrackUrl(baseUrl) {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("fmt", "json3");
  return parsed.toString();
}

function pickEnglishTrack(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) {
    return null;
  }

  return (
    tracks.find((track) => track.languageCode === "en" && track.kind !== "asr") ||
    tracks.find((track) => track.languageCode === "en") ||
    tracks.find((track) => track.kind !== "asr") ||
    tracks[0]
  );
}

async function fetchTrack(baseUrl) {
  const response = await fetch(buildTrackUrl(baseUrl), {
    headers: createYoutubeHeaders({
      "Accept": "application/json,text/plain,*/*"
    })
  });

  if (!response.ok) {
    throw new Error(`caption-track-${response.status}`);
  }

  const payload = await response.json();
  const cues = parseCaptionEvents(payload);
  if (!cues.length) {
    throw new Error("caption-track-empty");
  }

  return cues;
}

async function fetchFromWatchPage(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    headers: createYoutubeHeaders()
  });

  if (!response.ok) {
    throw new Error(`watch-page-${response.status}`);
  }

  const html = await response.text();
  const playerResponse = extractJsonObjectAfterMarker(html, "var ytInitialPlayerResponse = ");
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const track = pickEnglishTrack(tracks);
  if (!track?.baseUrl) {
    throw new Error("watch-page-no-captions");
  }

  return fetchTrack(track.baseUrl);
}

async function fetchFromTimedText(videoId) {
  const candidates = [
    `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}&fmt=json3`,
    `https://www.youtube.com/api/timedtext?lang=en&kind=asr&v=${encodeURIComponent(videoId)}&fmt=json3`
  ];

  for (const url of candidates) {
    const response = await fetch(url, {
      headers: createYoutubeHeaders({
        "Accept": "application/json,text/plain,*/*"
      })
    });

    if (!response.ok) {
      continue;
    }

    const text = await response.text();
    if (!text.trim()) {
      continue;
    }

    try {
      const cues = parseCaptionEvents(JSON.parse(text));
      if (cues.length) {
        return cues;
      }
    } catch (_error) {
      // Try the next source.
    }
  }

  throw new Error("timedtext-no-captions");
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    const url = new URL(request.url);
    const videoId = url.searchParams.get("id");

    if (!videoId) {
      return jsonResponse({ error: "missing id" }, 400);
    }

    try {
      const subtitles = await fetchFromWatchPage(videoId).catch(() => fetchFromTimedText(videoId));
      return jsonResponse({
        videoId,
        trackLabel: "English / worker",
        subtitles
      });
    } catch (error) {
      return jsonResponse({
        error: "no subtitles",
        detail: String(error?.message || error)
      }, 404);
    }
  }
};
