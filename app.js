const sampleSubtitles = [
  { start: 0, end: 4.2, text: "Welcome back to the channel.", translation: "チャンネルへようこそ。" },
  { start: 4.2, end: 8.7, text: "Today we are building a subtitle-powered learning player.", translation: "今日は字幕連動の学習プレイヤーを作ります。" },
  { start: 8.7, end: 13.5, text: "You can search videos, open recommendations, and follow the transcript!", translation: "動画検索、おすすめ表示、字幕追従ができます。" }
];

const PUNCTUATION_END_RE = /([.?!]+|[。！？]+)["')\]]*$/;
const ACTIVE_CUE_LOOKAHEAD = 0.2;
const ACTIVE_CUE_HOLD = 0.28;
const DEFAULT_VIDEO_ID = "G2Yi-NQDBSM";
const INITIAL_BOOTSTRAP_DELAY_MS = 1200;
const INITIAL_SEARCH_QUERY = "English Vlog";
const TRANSLATION_CHUNK_SIZE = 12;
const PLAYBACK_STORAGE_KEY = "trancy-playback-positions";
const FAVORITES_STORAGE_KEY = "trancy-favorites";
const SAVED_WORDS_STORAGE_KEY = "trancy-saved-words";
const SAVED_LINES_STORAGE_KEY = "trancy-saved-lines";
const HISTORY_STORAGE_KEY = "trancy-history";
const LAST_VIDEO_STORAGE_KEY = "trancy-last-video";
const panelAnimationTimers = new WeakMap();

const state = {
  player: null,
  playerReady: false,
  subtitles: [],
  cueGroups: [],
  cueGroupMap: [],
  activeIndex: -1,
  syncTimer: null,
  displayMode: "both",
  autoScroll: true,
  highlightTranslation: true,
  autoFetch: true,
  trackOptions: [],
  currentVideoId: "",
  currentTrackIndex: 0,
  translationLanguage: "ja",
  translationProvider: "google",
  translationPending: false,
  fontSizeMode: "small",
  activePopover: null,
  pendingResumeTime: 0,
  lastSavedSecond: -1,
  favorites: [],
  savedWords: [],
  savedLines: [],
  history: [],
  channelVideos: [],
  channelVideosSort: "latest",
  searchResults: [],
  recommendations: [],
  selectedVideoMeta: null,
  repeatMode: null,
  dictionaryEntry: null,
  dictionaryAudio: null,
  dictionaryResumePlayback: false,
  transcriptRequestId: 0,
  isSeekingWithSlider: false,
  initialBootstrapStarted: false
};

let youtubeIframeApiPromise = null;

function syncViewportHeight() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${viewportHeight}px`);
}

function loadYouTubeIframeApi() {
  if (window.YT?.Player) {
    return Promise.resolve();
  }

  if (!youtubeIframeApiPromise) {
    youtubeIframeApiPromise = new Promise((resolve, reject) => {
      const existingScript = document.querySelector('script[data-youtube-iframe-api="true"]');
      if (existingScript) {
        existingScript.addEventListener("load", resolve, { once: true });
        existingScript.addEventListener("error", () => reject(new Error("Failed to load YouTube iframe API.")), { once: true });
        return;
      }

      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previousReady === "function") {
          previousReady();
        }
        resolve();
      };

      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.defer = true;
      script.dataset.youtubeIframeApi = "true";
      script.addEventListener("error", () => reject(new Error("Failed to load YouTube iframe API.")), { once: true });
      document.head.appendChild(script);
    });
  }

  return youtubeIframeApiPromise;
}

async function bootstrapInitialVideo() {
  const initialVideo = getInitialVideoMeta();
  await loadYouTubeIframeApi();
  try {
    await handleVideoSelection(initialVideo);
  } catch (_error) {
    createPlayer(initialVideo.videoId || DEFAULT_VIDEO_ID);
  }
}

function startInitialBootstrap() {
  if (state.initialBootstrapStarted) {
    return;
  }

  state.initialBootstrapStarted = true;
  window.setTimeout(() => {
    bootstrapInitialVideo().catch(() => {});
  }, INITIAL_BOOTSTRAP_DELAY_MS);
}

const elements = {
  searchQuery: document.getElementById("search-query"),
  searchButton: document.getElementById("search-button"),
  searchStatus: document.getElementById("search-status"),
  searchResults: document.getElementById("search-results"),
  urlInput: document.getElementById("youtube-url"),
  loadVideoButton: document.getElementById("load-video"),
  subtitleFile: document.getElementById("subtitle-file"),
  subtitleTrack: document.getElementById("subtitle-track"),
  displayMode: document.getElementById("display-mode"),
  translationLanguage: document.getElementById("translation-language"),
  translationProvider: document.getElementById("translation-provider"),
  fontSizeMode: document.getElementById("font-size-mode"),
  settingsToggle: document.getElementById("settings-toggle"),
  settingsClose: document.getElementById("settings-close"),
  settingsPanel: document.getElementById("settings-panel"),
  favoritesToggle: document.getElementById("favorites-toggle"),
  favoritesClose: document.getElementById("favorites-close"),
  favoritesPanel: document.getElementById("favorites-panel"),
  historyClose: document.getElementById("history-close"),
  historyPanel: document.getElementById("history-panel"),
  channelVideosToggle: document.getElementById("channel-videos-toggle"),
  channelClose: document.getElementById("channel-close"),
  channelPanel: document.getElementById("channel-panel"),
  channelSort: document.getElementById("channel-sort"),
  channelVideosStatus: document.getElementById("channel-videos-status"),
  channelVideosList: document.getElementById("channel-videos-list"),
  savedLinesToggle: document.getElementById("saved-lines-toggle"),
  savedLinesClose: document.getElementById("saved-lines-close"),
  savedLinesPanel: document.getElementById("saved-lines-panel"),
  wordsToggle: document.getElementById("words-toggle"),
  wordsClose: document.getElementById("words-close"),
  wordsPanel: document.getElementById("words-panel"),
  autoFetch: document.getElementById("auto-fetch"),
  autoScroll: document.getElementById("auto-scroll"),
  highlightTranslation: document.getElementById("highlight-translation"),
  transcriptList: document.getElementById("transcript-list"),
  subtitleStatus: document.getElementById("subtitle-status"),
  currentCueTime: document.getElementById("current-cue-time"),
  currentOriginal: document.getElementById("current-original"),
  currentTranslation: document.getElementById("current-translation"),
  aiSearchCurrentInline: document.getElementById("ai-search-current-inline"),
  copyCurrentEnglish: document.getElementById("copy-current-english"),
  copyCurrentGroup: document.getElementById("copy-current-group"),
  saveCurrentLine: document.getElementById("save-current-line"),
  currentTimeLabel: document.getElementById("current-time-label"),
  durationLabel: document.getElementById("duration-label"),
  seekSlider: document.getElementById("seek-slider"),
  jumpCurrent: document.getElementById("jump-current"),
  loadSample: document.getElementById("load-sample"),
  recommendations: document.getElementById("recommendations"),
  recommendationStatus: document.getElementById("recommendation-status"),
  favoritesList: document.getElementById("favorites-list"),
  historyList: document.getElementById("history-list"),
  savedLinesList: document.getElementById("saved-lines-list"),
  savedWordsList: document.getElementById("saved-words-list"),
  navHome: document.getElementById("nav-home"),
  navHistory: document.getElementById("nav-history"),
  navWords: document.getElementById("nav-words"),
  navFavorites: document.getElementById("nav-favorites"),
  navLines: document.getElementById("nav-lines"),
  navSettings: document.getElementById("nav-settings"),
  panelBackdrop: document.getElementById("panel-backdrop"),
  dictionaryBackdrop: document.getElementById("dictionary-backdrop"),
  dictionaryPopup: document.getElementById("dictionary-popup"),
  dictionaryClose: document.getElementById("dictionary-close"),
  dictionaryPlayAudio: document.getElementById("dictionary-play-audio"),
  dictionaryWord: document.getElementById("dictionary-word"),
  dictionaryPhonetic: document.getElementById("dictionary-phonetic"),
  dictionaryBody: document.getElementById("dictionary-body"),
  saveWord: document.getElementById("save-word"),
  videoTitle: document.getElementById("video-title"),
  videoMeta: document.getElementById("video-meta"),
  aiSearchCurrent: document.getElementById("ai-search-current"),
  toggleFavorite: document.getElementById("toggle-favorite"),
  playbackRate: document.getElementById("playback-rate"),
  seekBack10: document.getElementById("seek-back-10"),
  seekBack5: document.getElementById("seek-back-5"),
  togglePlayback: document.getElementById("toggle-playback"),
  seekForward5: document.getElementById("seek-forward-5"),
  seekForward10: document.getElementById("seek-forward-10"),
  repeatStatus: document.getElementById("repeat-status"),
  repeatCurrentCue: document.getElementById("repeat-current-cue"),
  repeatCurrentGroup: document.getElementById("repeat-current-group")
};

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderEmptyState(target, message) {
  target.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function setSubtitleStatus(message) {
  elements.subtitleStatus.textContent = message;
}

function setRepeatStatus(message) {
  elements.repeatStatus.textContent = message;
}

function updateTransportUI() {
  const currentTime = state.playerReady && state.player?.getCurrentTime
    ? state.player.getCurrentTime()
    : 0;
  const duration = state.playerReady && state.player?.getDuration
    ? state.player.getDuration()
    : 0;

  if (elements.currentTimeLabel) {
    elements.currentTimeLabel.textContent = formatTime(currentTime);
  }
  if (elements.durationLabel) {
    elements.durationLabel.textContent = formatTime(duration);
  }

  if (elements.seekSlider && !state.isSeekingWithSlider) {
    elements.seekSlider.max = String(Math.max(duration, 1));
    elements.seekSlider.value = String(Math.min(currentTime, Math.max(duration, 1)));
  }
}

function readPlaybackPositions() {
  try {
    const raw = window.localStorage.getItem(PLAYBACK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_error) {
    return {};
  }
}

function writePlaybackPositions(positions) {
  try {
    window.localStorage.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify(positions));
  } catch (_error) {
    // Ignore storage failures.
  }
}

function getSavedPlaybackTime(videoId) {
  const positions = readPlaybackPositions();
  const value = Number(positions[videoId] || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function savePlaybackTime(videoId, time) {
  if (!videoId || !Number.isFinite(time) || time < 0) {
    return;
  }

  const positions = readPlaybackPositions();
  positions[videoId] = Math.floor(time);
  writePlaybackPositions(positions);
}

state.favorites = readFavorites();
state.savedWords = readSavedWords();
state.savedLines = readSavedLines();
state.history = readHistory();

function readFavorites() {
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_error) {
    return [];
  }
}

function writeFavorites(items) {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(items));
  } catch (_error) {
    // Ignore storage failures.
  }
}

function readSavedWords() {
  try {
    const raw = window.localStorage.getItem(SAVED_WORDS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_error) {
    return [];
  }
}

function writeSavedWords(items) {
  try {
    window.localStorage.setItem(SAVED_WORDS_STORAGE_KEY, JSON.stringify(items));
  } catch (_error) {
    // Ignore storage failures.
  }
}

function readSavedLines() {
  try {
    const raw = window.localStorage.getItem(SAVED_LINES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_error) {
    return [];
  }
}

function writeSavedLines(items) {
  try {
    window.localStorage.setItem(SAVED_LINES_STORAGE_KEY, JSON.stringify(items));
  } catch (_error) {
    // Ignore storage failures.
  }
}

function readHistory() {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_error) {
    return [];
  }
}

function writeHistory(items) {
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items));
  } catch (_error) {
    // Ignore storage failures.
  }
}

function readLastVideoMeta() {
  try {
    const raw = window.localStorage.getItem(LAST_VIDEO_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_error) {
    return null;
  }
}

function writeLastVideoMeta(item) {
  try {
    window.localStorage.setItem(LAST_VIDEO_STORAGE_KEY, JSON.stringify(item));
  } catch (_error) {
    // Ignore storage failures.
  }
}

function isFavorite(videoId) {
  return state.favorites.some((item) => item.videoId === videoId);
}

function normalizeWord(value) {
  return String(value || "").toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gi, "");
}

function isWordSaved(word) {
  const normalized = normalizeWord(word);
  return state.savedWords.some((item) => normalizeWord(item.word) === normalized);
}

function buildLineId(cue, videoId = state.currentVideoId || "sample") {
  return [videoId, cue.start, cue.end, cue.text].join("::");
}

function isLineSaved(cue) {
  if (!cue?.text) {
    return false;
  }
  const lineId = buildLineId(cue);
  return state.savedLines.some((item) => item.id === lineId);
}

function getActiveCue() {
  return state.activeIndex >= 0 ? state.subtitles[state.activeIndex] || null : null;
}

function getActiveCueGroupText() {
  if (state.activeIndex < 0) {
    return "";
  }

  const groupIndex = state.cueGroupMap[state.activeIndex];
  const group = state.cueGroups[groupIndex];
  if (!group?.cueIndexes?.length) {
    return getActiveCue()?.text || "";
  }

  return group.cueIndexes
    .map((index) => state.subtitles[index]?.text || "")
    .filter(Boolean)
    .join(" ");
}

async function copyEnglishText(text, button) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    return;
  }

  try {
    await navigator.clipboard.writeText(normalizedText);
  } catch (_error) {
    const textarea = document.createElement("textarea");
    textarea.value = normalizedText;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }

  if (!button) {
    return;
  }

  const originalLabel = button.dataset.labelDefault || button.textContent || "Copy";
  button.textContent = button.dataset.feedbackLabel || "Copied";
  window.clearTimeout(Number(button.dataset.resetTimer || 0));
  const timerId = window.setTimeout(() => {
    button.textContent = originalLabel;
  }, 1400);
  button.dataset.resetTimer = String(timerId);
}

function openChatGptApp() {
  const fallbackUrl = "https://chatgpt.com/";
  const appUrl = "chatgpt://";
  const isIos = /iPad|iPhone|iPod/.test(window.navigator.userAgent || "");

  if (!isIos) {
    window.location.href = fallbackUrl;
    return;
  }

  const startedAt = Date.now();
  const fallbackTimer = window.setTimeout(() => {
    if (Date.now() - startedAt < 1600) {
      window.location.href = fallbackUrl;
    }
  }, 900);

  const clearFallback = () => {
    window.clearTimeout(fallbackTimer);
    document.removeEventListener("visibilitychange", clearFallback);
    window.removeEventListener("pagehide", clearFallback);
    window.removeEventListener("blur", clearFallback);
  };

  document.addEventListener("visibilitychange", clearFallback, { once: true });
  window.addEventListener("pagehide", clearFallback, { once: true });
  window.addEventListener("blur", clearFallback, { once: true });
  window.location.href = appUrl;
}

function updateSaveWordButton() {
  if (!elements.saveWord) {
    return;
  }

  const saved = isWordSaved(state.dictionaryEntry?.word || "");
  elements.saveWord.textContent = saved ? "保存解除" : "単語を保存";
  elements.saveWord.classList.toggle("is-saved", saved);
}

function removeSavedWord(word) {
  const normalized = normalizeWord(word);
  state.savedWords = state.savedWords.filter((item) => normalizeWord(item.word) !== normalized);
  writeSavedWords(state.savedWords);
  renderSavedWords();
  updateSaveWordButton();
}

function updateFavoriteButton() {
  if (!elements.toggleFavorite) {
    return;
  }

  const active = Boolean(state.currentVideoId) && isFavorite(state.currentVideoId);
  elements.toggleFavorite.classList.toggle("is-active", active);
  elements.toggleFavorite.textContent = active ? "お気に入り済み" : "お気に入り";
}

function renderFavorites() {
  if (!elements.favoritesList) {
    return;
  }

  if (!state.favorites.length) {
    elements.favoritesList.innerHTML = '<div class="favorite-empty">お気に入りした動画がここに並びます。</div>';
    updateFavoriteButton();
    return;
  }

  elements.favoritesList.innerHTML = state.favorites.map((item) => `
    <article class="favorite-item ${item.videoId === state.currentVideoId ? "is-active" : ""}" data-video-id="${escapeHtml(item.videoId)}">
      <img class="favorite-thumb" src="${escapeHtml(item.thumbnail || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`)}" alt="${escapeHtml(item.title || "動画")}" />
      <div class="favorite-copy">
        <div class="favorite-head">
          <p class="favorite-title">${escapeHtml(item.title || "動画")}</p>
          <button class="ghost favorite-remove" type="button" data-remove-video-id="${escapeHtml(item.videoId)}">解除</button>
        </div>
        <p class="favorite-meta">${escapeHtml(item.channelName || "")}</p>
      </div>
    </article>
  `).join("");

  elements.favoritesList.querySelectorAll(".favorite-item").forEach((node) => {
    node.addEventListener("click", () => {
      const favorite = state.favorites.find((item) => item.videoId === node.dataset.videoId);
      if (favorite) {
        closeAllPopovers();
        handleVideoSelection(favorite).catch(() => {});
      }
    });
  });

  elements.favoritesList.querySelectorAll(".favorite-remove").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      removeFavorite(node.dataset.removeVideoId || "");
    });
  });

  updateFavoriteButton();
}

function renderSavedWords() {
  if (!elements.savedWordsList) {
    return;
  }

  if (!state.savedWords.length) {
    elements.savedWordsList.innerHTML = '<div class="saved-word-empty">保存した単語がここに並びます。</div>';
    return;
  }

  elements.savedWordsList.innerHTML = state.savedWords.map((item) => `
    <article class="saved-word-item" data-word="${escapeHtml(item.word)}">
      <div class="saved-word-head">
        <p class="saved-word-title">${escapeHtml(item.word)}</p>
        <button class="ghost saved-word-remove" type="button" data-remove-word="${escapeHtml(item.word)}">解除</button>
      </div>
      <p class="saved-word-meta">${escapeHtml(item.meaning || "意味はまだありません。")}</p>
      <p class="saved-word-context">${escapeHtml(item.context || "保存時の英文はありません。")}</p>
    </article>
  `).join("");

  elements.savedWordsList.querySelectorAll(".saved-word-item").forEach((node) => {
    node.addEventListener("click", () => {
      closeAllPopovers();
      const savedItem = state.savedWords.find((item) => normalizeWord(item.word) === normalizeWord(node.dataset.word || ""));
      openDictionaryForWord(node.dataset.word || "", { savedItem });
    });
  });

  elements.savedWordsList.querySelectorAll(".saved-word-remove").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      removeSavedWord(node.dataset.removeWord || "");
    });
  });
}

function updateSaveCurrentLineButton() {
  if (!elements.saveCurrentLine) {
    return;
  }

  const cue = getActiveCue();
  const saved = isLineSaved(cue);
  elements.saveCurrentLine.classList.toggle("is-active", saved);
  elements.saveCurrentLine.innerHTML = `<span aria-hidden="true">${saved ? "★" : "✦"}</span>`;
  elements.saveCurrentLine.setAttribute("aria-label", saved ? "Saved current English line" : "Save current English line");
}

function renderSavedLines() {
  if (!elements.savedLinesList) {
    return;
  }

  if (!state.savedLines.length) {
    elements.savedLinesList.innerHTML = '<div class="saved-line-empty">Saved English lines will appear here.</div>';
    updateSaveCurrentLineButton();
    return;
  }

  elements.savedLinesList.innerHTML = state.savedLines.map((item) => `
    <article class="saved-line-item" data-line-id="${escapeHtml(item.id)}" data-start="${escapeHtml(item.start)}">
      <div class="saved-line-head">
        <p class="saved-line-time">${escapeHtml(formatTime(item.start || 0))}</p>
        <div class="saved-line-actions">
          <button class="ghost saved-line-copy" type="button" data-copy-line-id="${escapeHtml(item.id)}">Copy</button>
          <button class="ghost saved-line-remove" type="button" data-remove-line-id="${escapeHtml(item.id)}">Remove</button>
        </div>
      </div>
      <p class="saved-line-text">${escapeHtml(item.text || "")}</p>
      <p class="saved-line-translation">${escapeHtml(item.translation || "No translation available.")}</p>
      <p class="saved-line-meta">${escapeHtml(item.videoTitle || "Current video")}</p>
    </article>
  `).join("");

  elements.savedLinesList.querySelectorAll(".saved-line-item").forEach((node) => {
    node.addEventListener("click", async () => {
      const savedItem = state.savedLines.find((item) => item.id === node.dataset.lineId);
      if (!savedItem) {
        return;
      }
      closeAllPopovers();
      const targetStart = Number(savedItem.start || 0);
      if (savedItem.videoId && savedItem.videoId !== state.currentVideoId) {
        await handleVideoSelection(savedItem, { startSecondsOverride: targetStart });
        return;
      }
      seekTo(targetStart, true);
    });
  });

  elements.savedLinesList.querySelectorAll(".saved-line-copy").forEach((node) => {
    node.dataset.labelDefault = "Copy";
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const savedItem = state.savedLines.find((item) => item.id === node.dataset.copyLineId);
      await copyEnglishText(savedItem?.text || "", node);
    });
  });

  elements.savedLinesList.querySelectorAll(".saved-line-remove").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      removeSavedLine(node.dataset.removeLineId || "");
    });
  });

  updateSaveCurrentLineButton();
}

function toggleSaveLine(cue = getActiveCue()) {
  if (!cue?.text) {
    return;
  }

  const lineId = buildLineId(cue);
  if (isLineSaved(cue)) {
    state.savedLines = state.savedLines.filter((item) => item.id !== lineId);
  } else {
    state.savedLines.unshift({
      id: lineId,
      videoId: state.currentVideoId || "",
      videoTitle: state.selectedVideoMeta?.title || "",
      start: cue.start,
      end: cue.end,
      text: cue.text,
      translation: cue.translation || ""
    });
  }

  state.savedLines = state.savedLines.slice(0, 100);
  writeSavedLines(state.savedLines);
  renderSavedLines();
  const activeIndex = state.activeIndex;
  renderTranscript();
  state.activeIndex = -1;
  updateActiveCue(activeIndex, false);
}

function removeSavedLine(lineId) {
  if (!lineId) {
    return;
  }

  state.savedLines = state.savedLines.filter((item) => item.id !== lineId);
  writeSavedLines(state.savedLines);
  renderSavedLines();
  const activeIndex = state.activeIndex;
  renderTranscript();
  state.activeIndex = -1;
  updateActiveCue(activeIndex, false);
}

function toggleFavoriteCurrentVideo() {
  if (!state.currentVideoId) {
    return;
  }

  if (isFavorite(state.currentVideoId)) {
    state.favorites = state.favorites.filter((item) => item.videoId !== state.currentVideoId);
  } else {
    state.favorites.unshift({
      videoId: state.currentVideoId,
      title: state.selectedVideoMeta?.title || "YouTube動画",
      channelName: state.selectedVideoMeta?.channelName || "",
      thumbnail: state.selectedVideoMeta?.thumbnail || `https://i.ytimg.com/vi/${state.currentVideoId}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${state.currentVideoId}`
    });
  }

  state.favorites = state.favorites.slice(0, 50);
  writeFavorites(state.favorites);
  renderFavorites();
}

function removeFavorite(videoId) {
  if (!videoId) {
    return;
  }

  state.favorites = state.favorites.filter((item) => item.videoId !== videoId);
  writeFavorites(state.favorites);
  renderFavorites();
}

function setPopoverOpen(name, open) {
  state.activePopover = open ? name : (state.activePopover === name ? null : state.activePopover);

  const groups = [
    ["settings", elements.settingsPanel, elements.navSettings || elements.settingsToggle],
    ["favorites", elements.favoritesPanel, elements.navFavorites || elements.favoritesToggle],
    ["history", elements.historyPanel, elements.navHistory],
    ["channel-videos", elements.channelPanel, elements.channelVideosToggle],
    ["saved-lines", elements.savedLinesPanel, elements.navLines || elements.savedLinesToggle],
    ["words", elements.wordsPanel, elements.navWords || elements.wordsToggle]
  ];

  groups.forEach(([key, panel, toggle]) => {
    const isOpen = state.activePopover === key;
    togglePanelWindow(panel, isOpen);
    toggle?.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

  togglePanelWindow(elements.panelBackdrop, Boolean(state.activePopover));
  document.body.classList.toggle("window-panel-open", Boolean(state.activePopover));
}

function togglePanelWindow(element, open) {
  if (!element) {
    return;
  }

  const activeTimer = panelAnimationTimers.get(element);
  if (activeTimer) {
    window.clearTimeout(activeTimer);
    panelAnimationTimers.delete(element);
  }

  if (open) {
    element.classList.remove("hidden");
    requestAnimationFrame(() => {
      element.classList.add("is-open");
    });
    return;
  }

  element.classList.remove("is-open");
  const timer = window.setTimeout(() => {
    element.classList.add("hidden");
    panelAnimationTimers.delete(element);
  }, 220);
  panelAnimationTimers.set(element, timer);
}

function closeAllPopovers() {
  if (!state.activePopover) {
    return;
  }

  setPopoverOpen(state.activePopover, false);
}

function scrollWorkspaceToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function applyFontSizeMode(mode) {
  const normalizedMode = ["tiny", "small", "medium", "large"].includes(mode) ? mode : "medium";
  state.fontSizeMode = normalizedMode;
  document.body.classList.remove("font-tiny", "font-small", "font-medium", "font-large");
  document.body.classList.add(`font-${normalizedMode}`);
  if (elements.fontSizeMode) {
    elements.fontSizeMode.value = normalizedMode;
  }
}

function updateRepeatButtons() {
  const cueActive = state.repeatMode?.type === "cue" && state.repeatMode.index === state.activeIndex;
  const groupActive = state.repeatMode?.type === "pair"
    && state.repeatMode.index === state.activeIndex;

  elements.repeatCurrentCue.classList.toggle("is-active", Boolean(cueActive));
  elements.repeatCurrentGroup.classList.toggle("is-active", Boolean(groupActive));
}

function parseYouTubeId(input) {
  if (!input) {
    return "";
  }

  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.replace("/", "").slice(0, 11);
    }

    const directId = url.searchParams.get("v");
    if (directId) {
      return directId.slice(0, 11);
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const embedIndex = parts.findIndex((part) => part === "embed" || part === "shorts" || part === "live");
    if (embedIndex >= 0 && parts[embedIndex + 1]) {
      return parts[embedIndex + 1].slice(0, 11);
    }
  } catch (_error) {
    return "";
  }

  return "";
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function updateNowPlaying(meta = null) {
  state.selectedVideoMeta = meta;
  if (!meta) {
    elements.videoTitle.textContent = "動画を選ぶとタイトルがここに表示されます。";
    elements.videoMeta.textContent = "チャンネル名や再生時間などを表示します。";
    updateFavoriteButton();
    return;
  }

  elements.videoTitle.textContent = meta.title || "動画タイトル";
  elements.videoMeta.textContent = [meta.channelName, meta.lengthText, meta.viewCountText, meta.publishedTimeText]
    .filter(Boolean)
    .join(" / ");
  updateFavoriteButton();
}

function getInitialVideoMeta() {
  const lastVideo = readLastVideoMeta();
  if (lastVideo?.videoId) {
    return lastVideo;
  }

  const firstHistory = state.history[0];
  if (firstHistory?.videoId) {
    return firstHistory;
  }

  return {
    videoId: DEFAULT_VIDEO_ID,
    title: "YouTube動画",
    channelName: "",
    lengthText: "",
    viewCountText: "",
    publishedTimeText: "",
    thumbnail: `https://i.ytimg.com/vi/${DEFAULT_VIDEO_ID}/hqdefault.jpg`
  };
}

function normalizeSubtitleEntry(entry, index) {
  const start = Number(entry.start);
  const end = Number(entry.end);
  const text = `${entry.text ?? entry.original ?? ""}`.trim();
  const translation = `${entry.translation ?? entry.ja ?? ""}`.trim();

  if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
    throw new Error(`字幕 ${index + 1} 行目の形式が不正です。`);
  }

  return {
    start,
    end,
    text,
    translation
  };
}

function parseJsonSubtitles(content) {
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error("JSON は配列形式である必要があります。");
  }
  return parsed.map(normalizeSubtitleEntry).sort((a, b) => a.start - b.start);
}

function parseTimestamp(raw) {
  const normalized = raw.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some((value) => !Number.isFinite(value))) {
    throw new Error(`タイムスタンプを解釈できません: ${raw}`);
  }

  let seconds = 0;
  for (const value of parts) {
    seconds = seconds * 60 + value;
  }
  return seconds;
}

function parseVttLikeSubtitles(content, type) {
  const cleaned = content.replace(/\r/g, "").trim();
  const blocks = cleaned.split(/\n\s*\n/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) {
      continue;
    }

    const cueLines = [...lines];
    if (type === "vtt" && cueLines[0] === "WEBVTT") {
      continue;
    }
    if (!cueLines[0].includes("-->")) {
      cueLines.shift();
    }
    if (!cueLines[0] || !cueLines[0].includes("-->")) {
      continue;
    }

    const [startRaw, endRaw] = cueLines[0].split("-->").map((part) => part.trim().split(" ")[0]);
    const body = cueLines.slice(1).join("\n");
    if (!body) {
      continue;
    }

    const [originalLine, translationLine] = body.split("\n");
    cues.push({
      start: parseTimestamp(startRaw),
      end: parseTimestamp(endRaw),
      text: originalLine.trim(),
      translation: translationLine ? translationLine.trim() : ""
    });
  }

  return cues.sort((a, b) => a.start - b.start);
}

function buildCueGroups(subtitles) {
  const groups = [];
  const cueGroupMap = Array.from({ length: subtitles.length }, () => -1);
  let groupStart = 0;

  for (let index = 0; index < subtitles.length; index += 1) {
    const text = subtitles[index].text.trim();
    const isBoundary = PUNCTUATION_END_RE.test(text) || index === subtitles.length - 1;
    if (!isBoundary) {
      continue;
    }

    const cueIndexes = [];
    for (let cueIndex = groupStart; cueIndex <= index; cueIndex += 1) {
      cueIndexes.push(cueIndex);
      cueGroupMap[cueIndex] = groups.length;
    }

    groups.push({
      start: subtitles[groupStart].start,
      end: subtitles[index].end,
      cueIndexes
    });
    groupStart = index + 1;
  }

  return { groups, cueGroupMap };
}

function setTrackOptions(tracks) {
  state.trackOptions = tracks;
  if (!tracks.length) {
    elements.subtitleTrack.innerHTML = "<option value=\"\">利用可能な字幕トラックはありません</option>";
    return;
  }

  elements.subtitleTrack.innerHTML = tracks.map((track, index) => (
    `<option value="${index}" ${index === state.currentTrackIndex ? "selected" : ""}>${escapeHtml(track.label)}</option>`
  )).join("");
}

function clearRepeatMode(silent = false) {
  state.repeatMode = null;
  if (!silent) {
    setRepeatStatus("リピートはオフです。");
  }
  updateRepeatButtons();
}

function setRepeatMode(mode) {
  state.repeatMode = mode;
  if (!mode) {
    setRepeatStatus("リピートはオフです。");
    updateRepeatButtons();
    return;
  }

  if (mode.type === "cue") {
    setRepeatStatus(`字幕 ${mode.index + 1} をリピート中です。`);
    updateRepeatButtons();
    return;
  }

  setRepeatStatus(`句読点まとまり ${mode.index + 1} をリピート中です。`);
  updateRepeatButtons();
}

function seekTo(seconds, autoplay = false) {
  if (!state.playerReady || !state.player?.seekTo) {
    return;
  }

  state.player.seekTo(Math.max(0, seconds), true);
  if (autoplay && state.player.playVideo) {
    state.player.playVideo();
  }
}

function repeatCue(index) {
  const cue = state.subtitles[index];
  if (!cue) {
    return;
  }

  if (state.repeatMode?.type === "cue" && state.repeatMode.index === index) {
    clearRepeatMode();
    return;
  }

  activateCueRepeat(index);
}

function activateCueRepeat(index) {
  const cue = state.subtitles[index];
  if (!cue) {
    return;
  }

  setRepeatMode({
    type: "cue",
    index,
    start: cue.start,
    end: cue.end
  });
  seekTo(cue.start, true);
}

function repeatGroupByCueIndex(index) {
  const groupIndex = state.cueGroupMap[index];
  const group = state.cueGroups[groupIndex];
  if (!group) {
    return;
  }

  if (state.repeatMode?.type === "group" && state.repeatMode.index === groupIndex) {
    clearRepeatMode();
    return;
  }

  setRepeatMode({
    type: "group",
    index: groupIndex,
    start: group.start,
    end: group.end
  });
  seekTo(group.start, true);
}

function syncRepeatToCueSelection(index) {
  if (state.repeatMode) {
    activateCueRepeat(index);
  }
}

function applySubtitleData(subtitles, statusMessage) {
  state.subtitles = subtitles;
  state.activeIndex = -1;
  const { groups, cueGroupMap } = buildCueGroups(subtitles);
  state.cueGroups = groups;
  state.cueGroupMap = cueGroupMap;
  clearRepeatMode(true);
  setRepeatStatus("リピートはオフです。");
  setSubtitleStatus(statusMessage);
  renderTranscript();
  syncActiveCue(true);
}

function getTranslationPlaceholder() {
  return state.translationPending ? "翻訳を読み込み中..." : "翻訳はありません";
}

function mergeSubtitleTranslations(currentSubtitles, translatedSubtitles) {
  if (!Array.isArray(currentSubtitles) || !Array.isArray(translatedSubtitles) || !currentSubtitles.length) {
    return Array.isArray(currentSubtitles) ? currentSubtitles : [];
  }

  const buildCueKey = (cue) => `${Number(cue?.start || 0).toFixed(3)}::${Number(cue?.end || 0).toFixed(3)}::${cue?.text || ""}`;
  const translationByKey = new Map(
    translatedSubtitles.map((cue) => [buildCueKey(cue), cue?.translation || ""])
  );

  return currentSubtitles.map((cue, index) => {
    const indexedMatch = translatedSubtitles[index];
    const indexedTranslation = indexedMatch
      && indexedMatch.text === cue.text
      && Math.abs(Number(indexedMatch.start || 0) - Number(cue.start || 0)) < 0.05
      && Math.abs(Number(indexedMatch.end || 0) - Number(cue.end || 0)) < 0.05
      ? indexedMatch.translation || ""
      : "";
    const mergedTranslation = indexedTranslation || translationByKey.get(buildCueKey(cue)) || cue.translation || "";
    return mergedTranslation === cue.translation ? cue : { ...cue, translation: mergedTranslation };
  });
}

function updateSubtitleTranslations(subtitles, statusMessage) {
  const nextSubtitles = Array.isArray(subtitles) ? subtitles : [];
  const previousActiveIndex = state.activeIndex;
  state.subtitles = nextSubtitles;
  const { groups, cueGroupMap } = buildCueGroups(nextSubtitles);
  state.cueGroups = groups;
  state.cueGroupMap = cueGroupMap;
  state.activeIndex = previousActiveIndex >= 0 ? Math.min(previousActiveIndex, Math.max(nextSubtitles.length - 1, -1)) : -1;
  setSubtitleStatus(statusMessage);
  renderTranscript();
  syncActiveCue(true);
}

function renderTranscript() {
  if (!state.subtitles.length) {
    renderEmptyState(elements.transcriptList, "字幕を読み込むと、ここにタイムスタンプ一覧が表示されます。");
    return;
  }

  const items = state.subtitles.map((cue, index) => {
    const classes = ["cue"];
    if (state.displayMode === "original") {
      classes.push("hide-translation");
    }
    if (state.displayMode === "translation") {
      classes.push("hide-original");
    }
    if (state.highlightTranslation) {
      classes.push("translation-highlight");
    }

    return `
      <article class="${classes.join(" ")}" data-index="${index}">
        <div class="cue-meta">
          <div class="cue-time">${formatTime(cue.start)} - ${formatTime(cue.end)}</div>
          <div class="cue-action-group">
            <button class="ghost cue-save-symbol ${isLineSaved(cue) ? "is-active" : ""}" type="button" data-save-index="${index}" aria-label="Save highlighted English line">${isLineSaved(cue) ? "★" : "✦"}</button>
            <button class="ghost cue-group-copy-symbol" type="button" data-copy-group-index="${index}" aria-label="Copy current sentence group" data-label-default="¶" data-feedback-label="✓">¶</button>
            <button class="ghost cue-copy-symbol" type="button" data-copy-index="${index}" aria-label="Copy highlighted English line" data-label-default="⧉" data-feedback-label="✓">⧉</button>
          </div>
        </div>
        <p class="cue-original">${renderWordMarkup(cue.text)}</p>
        <p class="cue-translation">${escapeHtml(cue.translation || getTranslationPlaceholder())}</p>
      </article>
    `;
  }).join("");

  elements.transcriptList.innerHTML = items;
  elements.transcriptList.querySelectorAll(".cue").forEach((node) => {
    node.addEventListener("click", () => {
      const index = Number(node.dataset.index);
      const cue = state.subtitles[index];
      if (!cue) {
        return;
      }

      syncRepeatToCueSelection(index);
      if (!state.repeatMode) {
        seekTo(cue.start, true);
      }
      updateActiveCue(index, true);
    });
  });

  elements.transcriptList.querySelectorAll(".word-chip").forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const cueNode = node.closest(".cue");
      const cueIndex = Number(cueNode?.dataset.index ?? -1);
      const context = cueIndex >= 0 ? state.subtitles[cueIndex]?.text || "" : "";
      await openDictionaryForWord(node.dataset.word || "", { context });
    });
  });

  elements.transcriptList.querySelectorAll(".cue-copy-symbol").forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const cue = state.subtitles[Number(node.dataset.copyIndex || -1)];
      await copyEnglishText(cue?.text || "", node);
    });
  });

  elements.transcriptList.querySelectorAll(".cue-group-copy-symbol").forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const index = Number(node.dataset.copyGroupIndex || -1);
      const groupIndex = state.cueGroupMap[index];
      const group = state.cueGroups[groupIndex];
      const text = group?.cueIndexes?.map((cueIndex) => state.subtitles[cueIndex]?.text || "").filter(Boolean).join(" ") || "";
      await copyEnglishText(text, node);
    });
  });

  elements.transcriptList.querySelectorAll(".cue-save-symbol").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      const cue = state.subtitles[Number(node.dataset.saveIndex || -1)];
      toggleSaveLine(cue);
    });
  });
}

function renderHistory() {
  if (!elements.historyList) {
    return;
  }

  if (!state.history.length) {
    elements.historyList.innerHTML = '<div class="favorite-empty">視聴履歴がここに並びます。</div>';
    return;
  }

  elements.historyList.innerHTML = state.history.map((item) => `
    <article class="favorite-item ${item.videoId === state.currentVideoId ? "is-active" : ""}" data-video-id="${escapeHtml(item.videoId)}">
      <img class="favorite-thumb" src="${escapeHtml(item.thumbnail || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`)}" alt="${escapeHtml(item.title || "動画")}" />
      <div class="favorite-copy">
        <div class="favorite-head">
          <p class="favorite-title">${escapeHtml(item.title || "動画")}</p>
          <button class="ghost favorite-remove" type="button" data-remove-history-id="${escapeHtml(item.videoId)}">解除</button>
        </div>
        <p class="favorite-meta">${escapeHtml([item.channelName || "", item.resumeTime ? `${formatTime(item.resumeTime)} から再開` : ""].filter(Boolean).join(" / "))}</p>
      </div>
    </article>
  `).join("");

  elements.historyList.querySelectorAll(".favorite-item").forEach((node) => {
    node.addEventListener("click", () => {
      const historyItem = state.history.find((item) => item.videoId === node.dataset.videoId);
      if (historyItem) {
        closeAllPopovers();
        handleVideoSelection(historyItem).catch(() => {});
      }
    });
  });

  elements.historyList.querySelectorAll("[data-remove-history-id]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      removeHistoryItem(node.dataset.removeHistoryId || "");
    });
  });
}

function saveHistoryItem(item) {
  if (!item?.videoId) {
    return;
  }

  const resumeTime = getSavedPlaybackTime(item.videoId);
  const nextItem = {
    videoId: item.videoId,
    title: item.title || "YouTube動画",
    channelName: item.channelName || "",
    thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
    url: item.url || `https://www.youtube.com/watch?v=${item.videoId}`,
    lengthText: item.lengthText || "",
    viewCountText: item.viewCountText || "",
    publishedTimeText: item.publishedTimeText || "",
    resumeTime
  };

  state.history = [
    nextItem,
    ...state.history.filter((historyItem) => historyItem.videoId !== item.videoId)
  ].slice(0, 50);
  writeHistory(state.history);
  writeLastVideoMeta(nextItem);
  renderHistory();
}

function removeHistoryItem(videoId) {
  if (!videoId) {
    return;
  }

  state.history = state.history.filter((item) => item.videoId !== videoId);
  writeHistory(state.history);
  if (readLastVideoMeta()?.videoId === videoId) {
    writeLastVideoMeta(state.history[0] || null);
  }
  renderHistory();
}

function renderWordMarkup(text) {
  return String(text || "")
    .split(/(\s+)/)
    .map((token) => {
      if (!token.trim()) {
        return token;
      }

      const normalizedWord = normalizeWord(token);
      if (!normalizedWord) {
        return escapeHtml(token);
      }

      return `<button class="word-chip" type="button" data-word="${escapeHtml(normalizedWord)}">${escapeHtml(token)}</button>`;
    })
    .join("");
}

function bindWordLookup(container, context) {
  if (!container) {
    return;
  }

  container.querySelectorAll(".word-chip").forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      await openDictionaryForWord(node.dataset.word || "", { context });
    });
  });
}

function updatePlaybackButton() {
  if (!state.playerReady || !state.player?.getPlayerState) {
    elements.togglePlayback.textContent = "再生";
    return;
  }

  const playerState = state.player.getPlayerState();
  elements.togglePlayback.textContent = playerState === window.YT?.PlayerState?.PLAYING ? "一時停止" : "再生";
}

function updateActiveCue(index, forceScroll = false) {
  if (state.activeIndex === index && !forceScroll) {
    return;
  }

  const previous = elements.transcriptList.querySelector(".cue.active");
  if (previous) {
    previous.classList.remove("active");
  }

  state.activeIndex = index;
  const cue = state.subtitles[index];
  if (!cue) {
    elements.currentOriginal.textContent = "字幕はまだありません。";
    elements.currentTranslation.textContent = "動画を再生すると、ここに現在の字幕が表示されます。";
    updateRepeatButtons();
    return;
  }

  elements.currentOriginal.innerHTML = renderWordMarkup(cue.text);
  elements.currentTranslation.textContent = cue.translation || getTranslationPlaceholder();
  bindWordLookup(elements.currentOriginal, cue.text);

  const activeNode = elements.transcriptList.querySelector(`[data-index="${index}"]`);
  if (!activeNode) {
    updateRepeatButtons();
    return;
  }

  activeNode.classList.add("active");
  updateRepeatButtons();

  if (state.autoScroll || forceScroll) {
    const anchorIndex = Math.max(index - 1, 0);
    const anchorNode = elements.transcriptList.querySelector(`[data-index="${anchorIndex}"]`) || activeNode;
    const listRect = elements.transcriptList.getBoundingClientRect();
    const anchorRect = anchorNode.getBoundingClientRect();
    const top = Math.max(elements.transcriptList.scrollTop + (anchorRect.top - listRect.top) - 8, 0);
    elements.transcriptList.scrollTo({ top, behavior: "smooth" });
  }
}

function findActiveCueIndex(time) {
  for (let index = 0; index < state.subtitles.length; index += 1) {
    const cue = state.subtitles[index];
    const nextCue = state.subtitles[index + 1];
    const startsSoon = time >= cue.start - ACTIVE_CUE_LOOKAHEAD;
    const remainsActive = time < cue.end + ACTIVE_CUE_HOLD;
    const beforeNextCue = !nextCue || time < nextCue.start - 0.02;

    if (startsSoon && remainsActive && beforeNextCue) {
      return index;
    }
  }

  for (let index = state.subtitles.length - 1; index >= 0; index -= 1) {
    if (time >= state.subtitles[index].start - ACTIVE_CUE_LOOKAHEAD) {
      return index;
    }
  }

  return -1;
}

function seekBy(deltaSeconds) {
  if (!state.playerReady || !state.player?.getCurrentTime) {
    return;
  }

  seekTo(state.player.getCurrentTime() + deltaSeconds, false);
}

function jumpCue(delta) {
  if (!state.subtitles.length) {
    return;
  }

  const currentIndex = state.activeIndex >= 0
    ? state.activeIndex
    : findActiveCueIndex(state.playerReady && state.player?.getCurrentTime ? state.player.getCurrentTime() : 0);

  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = Math.max(0, Math.min(state.subtitles.length - 1, safeIndex + delta));
  const cue = state.subtitles[nextIndex];
  if (!cue) {
    return;
  }

  syncRepeatToCueSelection(nextIndex);
  if (!state.repeatMode) {
    seekTo(cue.start, true);
  }
  updateActiveCue(nextIndex, true);
}

function persistCurrentPlaybackTime() {
  if (!state.currentVideoId || !state.playerReady || !state.player?.getCurrentTime) {
    return;
  }

  const time = state.player.getCurrentTime();
  const rounded = Math.floor(time);
  if (rounded === state.lastSavedSecond) {
    return;
  }

  state.lastSavedSecond = rounded;
  savePlaybackTime(state.currentVideoId, time);
  let didUpdate = false;
  state.history = state.history.map((item) => {
    if (item.videoId !== state.currentVideoId) {
      return item;
    }
    didUpdate = true;
    return {
      ...item,
      resumeTime: rounded
    };
  });
  if (didUpdate) {
    writeHistory(state.history);
    if (state.history[0]?.videoId === state.currentVideoId) {
      writeLastVideoMeta(state.history[0]);
    }
    renderHistory();
  }
}

function togglePlayback() {
  if (!state.playerReady || !state.player?.getPlayerState) {
    return;
  }

  const playerState = state.player.getPlayerState();
  if (playerState === window.YT?.PlayerState?.PLAYING) {
    state.player.pauseVideo();
  } else {
    state.player.playVideo();
  }
  window.setTimeout(updatePlaybackButton, 50);
}

function enforceRepeatLoop() {
  if (!state.repeatMode || !state.playerReady || !state.player?.getCurrentTime) {
    return;
  }

  const time = state.player.getCurrentTime();
  if (time >= Math.max(state.repeatMode.end - 0.08, state.repeatMode.start)) {
    seekTo(state.repeatMode.start, true);
  }
}

function syncActiveCue(force = false) {
  if (!state.playerReady || !state.subtitles.length || !state.player?.getCurrentTime) {
    return;
  }

  const time = state.player.getCurrentTime();
  const nextIndex = findActiveCueIndex(time);
  if (nextIndex >= 0) {
    updateActiveCue(nextIndex, force);
  }
}

function startSyncLoop() {
  if (state.syncTimer) {
    window.clearInterval(state.syncTimer);
  }

  state.syncTimer = window.setInterval(() => {
    if (!state.playerReady || !state.player?.getPlayerState) {
      return;
    }

    const playerState = state.player.getPlayerState();
    if (playerState === window.YT?.PlayerState?.PLAYING || playerState === window.YT?.PlayerState?.PAUSED) {
      syncActiveCue();
      updatePlaybackButton();
      updateTransportUI();
      persistCurrentPlaybackTime();
    }

    if (playerState === window.YT?.PlayerState?.PLAYING) {
      enforceRepeatLoop();
    }
  }, 100);
}

function createPlayer(videoId) {
  state.player = new window.YT.Player("player", {
    videoId,
    playerVars: {
      autoplay: 0,
      rel: 0,
      modestbranding: 1,
      playsinline: 1
    },
    events: {
      onReady: () => {
        state.playerReady = true;
        applyPlaybackRate();
        if (state.pendingResumeTime > 0) {
          seekTo(state.pendingResumeTime, false);
          state.pendingResumeTime = 0;
        }
        startSyncLoop();
        syncActiveCue(true);
        updatePlaybackButton();
        updateTransportUI();
      },
      onStateChange: () => {
        if (state.pendingResumeTime > 0 && state.player?.getPlayerState?.() === window.YT?.PlayerState?.CUED) {
          seekTo(state.pendingResumeTime, false);
          state.pendingResumeTime = 0;
        }
        applyPlaybackRate();
        syncActiveCue();
        updatePlaybackButton();
        updateTransportUI();
        persistCurrentPlaybackTime();
      }
    }
  });
}

function applyPlaybackRate() {
  if (!state.playerReady || !state.player?.setPlaybackRate || !elements.playbackRate) {
    return;
  }

  const rate = Number(elements.playbackRate.value || 1);
  if (Number.isFinite(rate) && rate > 0) {
    state.player.setPlaybackRate(rate);
  }
}

async function fetchDictionaryEntry(word) {
  return fetchJson(`/api/dictionary?word=${encodeURIComponent(word)}&provider=${encodeURIComponent(state.translationProvider)}`);
}

function playDictionaryAudio(entry) {
  if (state.dictionaryAudio) {
    state.dictionaryAudio.pause();
    state.dictionaryAudio = null;
  }

  if (entry?.audioUrl) {
    const audio = new Audio(entry.audioUrl);
    state.dictionaryAudio = audio;
    audio.play().catch(() => {});
    return;
  }

  if (window.speechSynthesis && entry?.word) {
    const utterance = new SpeechSynthesisUtterance(entry.word);
    utterance.lang = "en-US";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }
}

function renderDictionaryEntry(entry) {
  const parts = [];
  const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
  if (entry.wordTranslation) {
    parts.push(`<p class="dictionary-translation">${escapeHtml(entry.wordTranslation)}</p>`);
  }

  if (meanings.length) {
    parts.push(`
      <div class="dictionary-meaning-list">
        ${meanings.map((meaning) => {
          const definitions = Array.isArray(meaning.definitions) ? meaning.definitions : [];
          const firstDefinition = definitions.find((definition) => (definition?.ja || definition?.en)) || {};
          return `
            <div class="dictionary-meaning-line">
              <span class="dictionary-part-label">${escapeHtml(meaning.partOfSpeech || "")}.</span>
              <span class="dictionary-meaning-text">${escapeHtml(firstDefinition.ja || firstDefinition.en || "")}</span>
            </div>
          `;
        }).join("")}
      </div>
    `);
    parts.push(meanings.map((meaning) => {
      const definitions = Array.isArray(meaning.definitions) ? meaning.definitions.slice(0, 2) : [];
      const defs = definitions.map((definition) => `
        <div class="dictionary-definition">
          <p class="dictionary-definition-en">${escapeHtml(definition.en || "")}</p>
          <p class="dictionary-definition-ja">${escapeHtml(definition.ja || "")}</p>
        </div>
      `).join("");
      if (!defs) {
        return "";
      }
      return `
        <section class="dictionary-meaning">
          <p class="dictionary-part">${escapeHtml(meaning.partOfSpeech || "")}</p>
          ${defs}
        </section>
      `;
    }).join(""));
  } else {
    parts.push("<p>意味は見つかりませんでした。</p>");
  }

  if (entry.context) {
    parts.push(`
      <section class="dictionary-example">
        <p class="dictionary-part">saved sentence</p>
        <p class="dictionary-definition-en">${escapeHtml(entry.context)}</p>
      </section>
    `);
  }

  elements.dictionaryBody.innerHTML = parts.join("");
}

function pauseForDictionary() {
  if (!state.playerReady || !state.player?.getPlayerState) {
    state.dictionaryResumePlayback = false;
    return;
  }

  const isPlaying = state.player.getPlayerState() === window.YT?.PlayerState?.PLAYING;
  state.dictionaryResumePlayback = isPlaying;
  if (isPlaying && state.player.pauseVideo) {
    state.player.pauseVideo();
  }
}

async function openDictionaryForWord(word, options = {}) {
  const normalizedWord = normalizeWord(word);
  if (!normalizedWord || !elements.dictionaryPopup) {
    return;
  }

  pauseForDictionary();
  elements.dictionaryPopup.classList.remove("hidden");
  elements.dictionaryWord.textContent = normalizedWord;
  elements.dictionaryPhonetic.textContent = "";
  elements.dictionaryBody.innerHTML = "<p>辞書を読み込んでいます...</p>";
  const context = options.context || options.savedItem?.context || state.subtitles[state.activeIndex]?.text || "";
  state.dictionaryEntry = {
    word: normalizedWord,
    phonetic: "",
    meaning: "",
    meanings: [],
    context
  };
  updateSaveWordButton();

  try {
    const entry = await fetchDictionaryEntry(normalizedWord);
    state.dictionaryEntry = {
      ...entry,
      context
    };
    elements.dictionaryWord.textContent = entry.word;
    elements.dictionaryPhonetic.textContent = entry.phonetic;
    renderDictionaryEntry(state.dictionaryEntry);
    updateSaveWordButton();
    playDictionaryAudio(state.dictionaryEntry);
  } catch (error) {
    elements.dictionaryBody.innerHTML = `<p>${escapeHtml(error.message || "辞書情報を取得できませんでした。")}</p>`;
    updateSaveWordButton();
  }
}

function closeDictionaryPopup() {
  if (state.dictionaryAudio) {
    state.dictionaryAudio.pause();
    state.dictionaryAudio = null;
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  elements.dictionaryPopup?.classList.add("hidden");

  if (state.dictionaryResumePlayback && state.playerReady && state.player?.playVideo) {
    state.player.playVideo();
  }
  state.dictionaryResumePlayback = false;
}

function saveCurrentWord() {
  const entry = state.dictionaryEntry;
  if (!entry?.word) {
    return;
  }

  const normalizedEntryWord = normalizeWord(entry.word);
  if (isWordSaved(entry.word)) {
    removeSavedWord(entry.word);
    return;
  }

  const nextItems = state.savedWords.filter((item) => normalizeWord(item.word) !== normalizedEntryWord);
  nextItems.unshift({
    word: entry.word,
    phonetic: entry.phonetic || "",
    meaning: entry.wordTranslation || entry.meaning || "",
    context: entry.context || state.subtitles[state.activeIndex]?.text || ""
  });
  state.savedWords = nextItems.slice(0, 200);
  writeSavedWords(state.savedWords);
  renderSavedWords();
  updateSaveWordButton();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "データ取得に失敗しました。");
  }
  return payload;
}

function shouldHydrateVideoMeta(item) {
  const title = String(item?.title || "").trim();
  return !title || (/^youtube/i.test(title) && !String(item?.channelName || "").trim());
}

async function hydrateVideoMeta(item, videoId) {
  return {
    ...item,
    videoId
  };
}

function mergeVideoMeta(baseItem, nextMeta) {
  return {
    ...baseItem,
    ...nextMeta,
    videoId: nextMeta?.videoId || baseItem?.videoId || "",
    title: nextMeta?.title || baseItem?.title || "YouTube動画",
    channelName: nextMeta?.channelName || baseItem?.channelName || "",
    thumbnail: nextMeta?.thumbnail || baseItem?.thumbnail || "",
    url: nextMeta?.url || baseItem?.url || ""
  };
}

function applyVideoMetaUpdate(videoId, nextMeta) {
  if (!videoId || !nextMeta) {
    return;
  }

  if (state.currentVideoId === videoId && state.selectedVideoMeta) {
    state.selectedVideoMeta = mergeVideoMeta(state.selectedVideoMeta, nextMeta);
    updateNowPlaying(state.selectedVideoMeta);
  }

  state.history = state.history.map((item) => item.videoId === videoId ? mergeVideoMeta(item, nextMeta) : item);
  writeHistory(state.history);
  if (readLastVideoMeta()?.videoId === videoId) {
    const latestMeta = state.history.find((item) => item.videoId === videoId) || mergeVideoMeta(readLastVideoMeta() || {}, nextMeta);
    writeLastVideoMeta(latestMeta);
  }
  renderHistory();

  if (state.favorites.some((item) => item.videoId === videoId)) {
    state.favorites = state.favorites.map((item) => item.videoId === videoId ? mergeVideoMeta(item, nextMeta) : item);
    writeFavorites(state.favorites);
    renderFavorites();
    updateFavoriteButton();
  }
}

async function enrichVideoMetaInBackground(item, videoId) {
  if (!videoId || !shouldHydrateVideoMeta(item)) {
    return;
  }

  try {
    const payload = await fetchJson(`/api/video-meta?videoId=${encodeURIComponent(videoId)}`);
    applyVideoMetaUpdate(videoId, payload);
  } catch (_error) {
    // Keep the placeholder title if metadata fetch fails.
  }
}

function renderVideoList(target, items, onSelect) {
  if (!items.length) {
    renderEmptyState(target, "動画がありません。");
    return;
  }

  target.innerHTML = items.map((item) => `
    <article class="video-card ${item.videoId === state.currentVideoId ? "active" : ""}" data-video-id="${escapeHtml(item.videoId)}">
      <img class="video-thumb" src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.title)}">
      <div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.channelName || "チャンネル情報なし")}</p>
        <p>${escapeHtml([item.lengthText, item.viewCountText, item.publishedTimeText].filter(Boolean).join(" / ") || "追加情報なし")}</p>
      </div>
    </article>
  `).join("");

  target.querySelectorAll(".video-card").forEach((node) => {
    node.addEventListener("click", () => {
      const selected = items.find((item) => item.videoId === node.dataset.videoId);
      if (selected) {
        onSelect(selected);
      }
    });
  });
}

async function loadSearch(query) {
  const trimmed = query.trim();
  if (!trimmed) {
    return;
  }

  elements.searchStatus.textContent = "検索しています...";
  const payload = await fetchJson(`/api/search?q=${encodeURIComponent(trimmed)}`);
  state.searchResults = payload.items || [];
  elements.searchStatus.textContent = `${payload.items.length} 件の動画が見つかりました。`;
  renderVideoList(elements.searchResults, state.searchResults, handleVideoSelection);
}

async function loadRecommendations(videoId) {
  elements.recommendationStatus.textContent = "おすすめ動画を読み込み中です...";
  try {
    const payload = await fetchJson(`/api/recommendations?videoId=${encodeURIComponent(videoId)}`);
    state.recommendations = payload.items || [];
    if (!state.recommendations.length) {
      elements.recommendationStatus.textContent = "おすすめ動画は見つかりませんでした。";
      renderEmptyState(elements.recommendations, "関連動画が見つかりませんでした。");
      return;
    }

    elements.recommendationStatus.textContent = `${state.recommendations.length} 件のおすすめ動画を表示しています。`;
    renderVideoList(elements.recommendations, state.recommendations, handleVideoSelection);
  } catch (error) {
    elements.recommendationStatus.textContent = error.message || "おすすめ動画の取得に失敗しました。";
    renderEmptyState(elements.recommendations, "おすすめ動画を読み込めませんでした。");
  }
}

function buildTranscriptStatus(payload, language, options = {}) {
  const subtitles = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
  const translatedCount = subtitles.filter((item) => item.translation).length;
  const messages = [
    `${payload.trackLabel} を読み込みました。`,
    `${subtitles.length} 件の字幕があります。`
  ];

  if (options.translationPending) {
    messages.push("英語字幕を先に表示しています。");
    messages.push(`${language} の翻訳を取得しています...`);
    return messages.join(" ");
  }

  if (options.translationFailed) {
    messages.push("英語字幕を表示中です。");
    messages.push(`${language} の翻訳はまだ取得できていません。`);
    return messages.join(" ");
  }

  messages.push(translatedCount ? `${language} の翻訳を表示できます。` : `${language} の翻訳はまだありません。`);
  return messages.join(" ");
}

async function fetchTrackTranscript(videoId, trackIndex, options = {}) {
  const language = options.language || state.translationLanguage;
  const provider = options.provider || state.translationProvider;
  return fetchJson(
    `/api/transcript?videoId=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(language)}&provider=${encodeURIComponent(provider)}&trackIndex=${encodeURIComponent(trackIndex)}`
  );
}

async function translateCueChunk(cues, options = {}) {
  return fetchJson("/api/translate-cues", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      cues,
      targetLanguage: options.targetLanguage || state.translationLanguage,
      sourceLanguage: options.sourceLanguage || "en",
      provider: options.provider || state.translationProvider
    })
  });
}

function mergeTranslatedChunk(currentSubtitles, translatedChunk, startIndex) {
  const nextSubtitles = currentSubtitles.slice();
  translatedChunk.forEach((cue, index) => {
    const targetIndex = startIndex + index;
    const currentCue = nextSubtitles[targetIndex];
    if (!currentCue) {
      return;
    }

    nextSubtitles[targetIndex] = {
      ...currentCue,
      translation: cue?.translation || currentCue.translation || ""
    };
  });
  return nextSubtitles;
}

async function translateSubtitlesProgressively(videoId, requestId, basePayload, options = {}) {
  const requestedLanguage = options.language || state.translationLanguage;
  const requestedProvider = options.provider || state.translationProvider;
  const baseSubtitles = Array.isArray(basePayload?.subtitles) ? basePayload.subtitles : [];
  const totalChunks = Math.ceil(baseSubtitles.length / TRANSLATION_CHUNK_SIZE);

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    if (requestId !== state.transcriptRequestId || videoId !== state.currentVideoId) {
      return;
    }

    const startIndex = chunkIndex * TRANSLATION_CHUNK_SIZE;
    const cues = baseSubtitles.slice(startIndex, startIndex + TRANSLATION_CHUNK_SIZE).map((cue) => ({
      start: cue.start,
      end: cue.end,
      text: cue.text,
      translation: ""
    }));
    const translatedPayload = await translateCueChunk(cues, {
      targetLanguage: requestedLanguage,
      sourceLanguage: "en",
      provider: requestedProvider
    });
    if (requestId !== state.transcriptRequestId || videoId !== state.currentVideoId) {
      return;
    }

    const mergedSubtitles = mergeTranslatedChunk(state.subtitles, translatedPayload.subtitles || [], startIndex);
    const hasMoreChunks = chunkIndex < totalChunks - 1;
    state.translationPending = hasMoreChunks;
    updateSubtitleTranslations(
      mergedSubtitles,
      hasMoreChunks
        ? `${basePayload.trackLabel} を読み込みました。先頭から翻訳中です... ${Math.min(startIndex + TRANSLATION_CHUNK_SIZE, baseSubtitles.length)}/${baseSubtitles.length}`
        : buildTranscriptStatus({ ...basePayload, subtitles: mergedSubtitles }, requestedLanguage)
    );
  }
}

async function loadChannelVideos(sort = state.channelVideosSort) {
  if (!state.currentVideoId || !elements.channelVideosList || !elements.channelVideosStatus) {
    return;
  }

  state.channelVideosSort = sort;
  elements.channelVideosStatus.textContent = "チャンネル動画を読み込み中です...";
  const payload = await fetchJson(`/api/channel-videos?videoId=${encodeURIComponent(state.currentVideoId)}&sort=${encodeURIComponent(sort)}`);
  state.channelVideos = payload.items || [];

  if (!state.channelVideos.length) {
    elements.channelVideosStatus.textContent = `${payload.channelName || "このチャンネル"} の動画は見つかりませんでした。`;
    renderEmptyState(elements.channelVideosList, "チャンネル動画を表示できませんでした。");
    return;
  }

  elements.channelVideosStatus.textContent = `${payload.channelName || "このチャンネル"} の動画を ${sort === "popular" ? "人気順" : "最新順"} で表示しています。`;
  renderVideoList(elements.channelVideosList, state.channelVideos, handleVideoSelection);
}

async function loadAutoTranscript(videoId, trackIndex = 0) {
  const requestId = ++state.transcriptRequestId;
  const requestedLanguage = state.translationLanguage;
  const requestedProvider = state.translationProvider;
  const shouldFetchTranslationAfterEnglish = requestedLanguage !== "en";
  const initialLanguage = shouldFetchTranslationAfterEnglish ? "en" : requestedLanguage;
  state.translationPending = shouldFetchTranslationAfterEnglish;

  setSubtitleStatus(shouldFetchTranslationAfterEnglish ? "英語字幕を取得しています..." : "字幕を取得しています...");
  const payload = await fetchTrackTranscript(videoId, trackIndex, {
    language: initialLanguage,
    provider: requestedProvider
  });
  if (requestId !== state.transcriptRequestId || videoId !== state.currentVideoId) {
    return;
  }

  state.currentTrackIndex = Number(payload.selectedTrackIndex || trackIndex);
  setTrackOptions(payload.availableTracks || []);
  elements.subtitleTrack.value = String(state.currentTrackIndex);

  if (!shouldFetchTranslationAfterEnglish) {
    state.translationPending = false;
    applySubtitleData(payload.subtitles, buildTranscriptStatus(payload, requestedLanguage));
    return;
  }

  applySubtitleData(payload.subtitles, buildTranscriptStatus(payload, requestedLanguage, { translationPending: true }));

  try {
    await translateSubtitlesProgressively(videoId, requestId, payload, {
      language: requestedLanguage,
      provider: requestedProvider
    });
  } catch (_error) {
    if (requestId !== state.transcriptRequestId || videoId !== state.currentVideoId) {
      return;
    }

    state.translationPending = false;
    setSubtitleStatus(buildTranscriptStatus(payload, requestedLanguage, { translationFailed: true }));
  }
}

async function handleVideoSelection(item, options = {}) {
  const videoId = parseYouTubeId(item.videoId || item.url || "");
  if (!videoId) {
    window.alert("動画 ID を取得できませんでした。");
    return;
  }

  const selectedItem = await hydrateVideoMeta(item, videoId);

  state.currentVideoId = videoId;
  state.lastSavedSecond = -1;
  state.transcriptRequestId += 1;
  closeDictionaryPopup();
  closeAllPopovers();
  scrollWorkspaceToTop();
  const resumeTime = Number.isFinite(options.startSecondsOverride)
    ? Math.max(0, Number(options.startSecondsOverride))
    : getSavedPlaybackTime(videoId);
  state.pendingResumeTime = resumeTime;
  elements.urlInput.value = `https://www.youtube.com/watch?v=${videoId}`;
  updateNowPlaying(selectedItem);
  renderFavorites();
  saveHistoryItem({
    ...selectedItem,
    videoId
  });
  enrichVideoMetaInBackground(item, videoId);
  state.subtitles = [];
  state.cueGroups = [];
  state.cueGroupMap = [];
  state.activeIndex = -1;
  setTrackOptions([]);
  renderEmptyState(elements.transcriptList, "字幕を読み込み中です。");
  elements.currentOriginal.textContent = "字幕を読み込み中です。";
  elements.currentTranslation.textContent = "翻訳を準備しています。";
  clearRepeatMode(true);
  setRepeatStatus("リピートはオフです。");

  if (state.playerReady && state.player?.loadVideoById) {
    state.player.loadVideoById({
      videoId,
      startSeconds: resumeTime || 0
    });
    applyPlaybackRate();
    state.pendingResumeTime = 0;
  } else if (window.YT?.Player) {
    createPlayer(videoId);
  } else {
    window.pendingVideoId = videoId;
  }

  if (state.searchResults.length) {
    renderVideoList(elements.searchResults, state.searchResults, handleVideoSelection);
  }
  if (state.recommendations.length) {
    renderVideoList(elements.recommendations, state.recommendations, handleVideoSelection);
  }

  loadRecommendations(videoId);
  if (state.activePopover === "channel-videos") {
    loadChannelVideos(state.channelVideosSort).catch(() => {});
  }

  if (state.autoFetch) {
    try {
      await loadAutoTranscript(videoId, 0);
    } catch (error) {
      setTrackOptions([]);
      renderEmptyState(elements.transcriptList, "字幕を自動取得できませんでした。手動字幕ファイルも使えます。");
      setSubtitleStatus(error.message || "字幕を自動取得できませんでした。");
    }
  }
}

async function loadVideoFromInput() {
  const videoId = parseYouTubeId(elements.urlInput.value);
  if (!videoId) {
    window.alert("有効な YouTube URL または 11 文字の Video ID を入力してください。");
    return;
  }

  await handleVideoSelection({
    videoId,
    title: "YouTube動画",
    channelName: "",
    lengthText: "",
    viewCountText: "",
    publishedTimeText: "",
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  });
}

async function handleSubtitleFile(file) {
  const content = await file.text();
  const extension = file.name.split(".").pop()?.toLowerCase();
  let subtitles;

  if (extension === "json") {
    subtitles = parseJsonSubtitles(content);
  } else if (extension === "srt") {
    subtitles = parseVttLikeSubtitles(content, "srt");
  } else {
    subtitles = parseVttLikeSubtitles(content, "vtt");
  }

  applySubtitleData(subtitles, `${file.name} を読み込みました。${subtitles.length} 件の字幕があります。`);
}

elements.searchButton.addEventListener("click", () => {
  loadSearch(elements.searchQuery.value).catch((error) => {
    elements.searchStatus.textContent = error.message || "検索に失敗しました。";
    renderEmptyState(elements.searchResults, "検索結果を取得できませんでした。");
  });
});

elements.searchQuery.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    loadSearch(elements.searchQuery.value).catch((error) => {
      elements.searchStatus.textContent = error.message || "検索に失敗しました。";
      renderEmptyState(elements.searchResults, "検索結果を取得できませんでした。");
    });
  }
});

elements.loadVideoButton.addEventListener("click", () => {
  loadVideoFromInput().catch((error) => {
    setSubtitleStatus(error.message || "動画の読み込みに失敗しました。");
  });
});

elements.urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    loadVideoFromInput().catch((error) => {
      setSubtitleStatus(error.message || "動画の読み込みに失敗しました。");
    });
  }
});

elements.subtitleFile.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  try {
    await handleSubtitleFile(file);
  } catch (error) {
    window.alert(error.message || "字幕ファイルを読み込めませんでした。");
  }
});

elements.subtitleTrack.addEventListener("change", async (event) => {
  if (!state.currentVideoId) {
    return;
  }

  try {
    await loadAutoTranscript(state.currentVideoId, Number(event.target.value));
  } catch (error) {
    setSubtitleStatus(error.message || "字幕トラックの切り替えに失敗しました。");
  }
});

elements.translationLanguage.addEventListener("change", async (event) => {
  state.translationLanguage = event.target.value;
  if (!state.currentVideoId || !state.autoFetch) {
    return;
  }

  try {
    await loadAutoTranscript(state.currentVideoId, state.currentTrackIndex);
  } catch (error) {
    setSubtitleStatus(error.message || "翻訳言語の切り替えに失敗しました。");
  }
});

elements.translationProvider.addEventListener("change", async (event) => {
  state.translationProvider = event.target.value;
  if (!state.currentVideoId || !state.autoFetch) {
    return;
  }

  try {
    await loadAutoTranscript(state.currentVideoId, state.currentTrackIndex);
  } catch (error) {
    setSubtitleStatus(error.message || "翻訳手段の切り替えに失敗しました。");
  }
});

elements.fontSizeMode.addEventListener("change", (event) => {
  applyFontSizeMode(event.target.value);
});

elements.settingsToggle?.addEventListener("click", () => {
  setPopoverOpen("settings", state.activePopover !== "settings");
});

elements.settingsClose.addEventListener("click", () => {
  setPopoverOpen("settings", false);
});

elements.favoritesToggle?.addEventListener("click", () => {
  setPopoverOpen("favorites", state.activePopover !== "favorites");
});

elements.favoritesClose?.addEventListener("click", () => {
  setPopoverOpen("favorites", false);
});

elements.historyClose?.addEventListener("click", () => {
  setPopoverOpen("history", false);
});

elements.channelVideosToggle?.addEventListener("click", () => {
  const shouldOpen = state.activePopover !== "channel-videos";
  setPopoverOpen("channel-videos", shouldOpen);
  if (shouldOpen) {
    loadChannelVideos(elements.channelSort?.value || state.channelVideosSort).catch((error) => {
      elements.channelVideosStatus.textContent = error.message || "チャンネル動画の取得に失敗しました。";
      renderEmptyState(elements.channelVideosList, "チャンネル動画を読み込めませんでした。");
    });
  }
});

elements.channelClose?.addEventListener("click", () => {
  setPopoverOpen("channel-videos", false);
});

elements.channelSort?.addEventListener("change", (event) => {
  state.channelVideosSort = event.target.value;
  if (state.activePopover === "channel-videos") {
    loadChannelVideos(state.channelVideosSort).catch((error) => {
      elements.channelVideosStatus.textContent = error.message || "チャンネル動画の取得に失敗しました。";
      renderEmptyState(elements.channelVideosList, "チャンネル動画を読み込めませんでした。");
    });
  }
});

elements.savedLinesToggle?.addEventListener("click", () => {
  setPopoverOpen("saved-lines", state.activePopover !== "saved-lines");
});

elements.savedLinesClose?.addEventListener("click", () => {
  setPopoverOpen("saved-lines", false);
});

elements.wordsToggle?.addEventListener("click", () => {
  setPopoverOpen("words", state.activePopover !== "words");
});

elements.wordsClose?.addEventListener("click", () => {
  setPopoverOpen("words", false);
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }

  if (state.activePopover) {
    const clickedInsidePanel = elements.settingsPanel?.contains(target)
      || elements.favoritesPanel?.contains(target)
      || elements.historyPanel?.contains(target)
      || elements.channelPanel?.contains(target)
      || elements.savedLinesPanel?.contains(target)
      || elements.wordsPanel?.contains(target);
    const clickedToggle = elements.settingsToggle?.contains(target)
      || elements.favoritesToggle?.contains(target)
      || elements.channelVideosToggle?.contains(target)
      || elements.navHistory?.contains(target)
      || elements.navWords?.contains(target)
      || elements.savedLinesToggle?.contains(target)
      || elements.wordsToggle?.contains(target)
      || elements.navFavorites?.contains(target)
      || elements.navLines?.contains(target)
      || elements.navSettings?.contains(target);
    if (!clickedInsidePanel && !clickedToggle) {
      closeAllPopovers();
    }
  }

  const clickedDictionary = elements.dictionaryPopup?.contains(target);
  const clickedWord = target instanceof Element && target.closest(".word-chip");
  if (!clickedDictionary && !clickedWord) {
    closeDictionaryPopup();
  }
});

elements.displayMode.addEventListener("change", (event) => {
  state.displayMode = event.target.value;
  renderTranscript();
  updateActiveCue(state.activeIndex, true);
});

elements.autoFetch.addEventListener("change", (event) => {
  state.autoFetch = event.target.checked;
});

elements.autoScroll.addEventListener("change", (event) => {
  state.autoScroll = event.target.checked;
});

elements.highlightTranslation.addEventListener("change", (event) => {
  state.highlightTranslation = event.target.checked;
  renderTranscript();
  updateActiveCue(state.activeIndex, true);
});

elements.playbackRate?.addEventListener("change", () => {
  applyPlaybackRate();
});

elements.jumpCurrent.addEventListener("click", () => {
  if (state.activeIndex >= 0) {
    updateActiveCue(state.activeIndex, true);
  }
});

elements.loadSample.addEventListener("click", () => {
  setTrackOptions([]);
  applySubtitleData(sampleSubtitles, `サンプル字幕を読み込みました。${sampleSubtitles.length} 件の字幕があります。`);
});

elements.seekBack10.addEventListener("click", () => seekBy(-10));
elements.seekBack5.addEventListener("click", () => jumpCue(-1));
elements.seekForward5.addEventListener("click", () => jumpCue(1));
elements.seekForward10.addEventListener("click", () => seekBy(10));
elements.togglePlayback.addEventListener("click", togglePlayback);
elements.repeatCurrentCue.addEventListener("click", () => {
  if (state.activeIndex >= 0) {
    repeatCue(state.activeIndex);
  }
});
elements.repeatCurrentGroup.addEventListener("click", () => {
  if (state.activeIndex >= 0) {
    repeatGroupByCueIndex(state.activeIndex);
  }
});
elements.toggleFavorite.addEventListener("click", () => {
  toggleFavoriteCurrentVideo();
});

elements.navHome?.addEventListener("click", () => {
  closeAllPopovers();
  scrollWorkspaceToTop();
});

elements.navHistory?.addEventListener("click", () => {
  setPopoverOpen("history", state.activePopover !== "history");
});

elements.navWords?.addEventListener("click", () => {
  setPopoverOpen("words", state.activePopover !== "words");
});

elements.navFavorites?.addEventListener("click", () => {
  setPopoverOpen("favorites", state.activePopover !== "favorites");
});

elements.navLines?.addEventListener("click", () => {
  setPopoverOpen("saved-lines", state.activePopover !== "saved-lines");
});

elements.navSettings?.addEventListener("click", () => {
  setPopoverOpen("settings", state.activePopover !== "settings");
});

elements.panelBackdrop?.addEventListener("click", () => {
  closeAllPopovers();
});

elements.copyCurrentEnglish?.addEventListener("click", async (event) => {
  const cue = getActiveCue();
  await copyEnglishText(cue?.text || "", event.currentTarget);
});

elements.copyCurrentGroup?.addEventListener("click", async (event) => {
  await copyEnglishText(getActiveCueGroupText(), event.currentTarget);
});

elements.aiSearchCurrentInline?.addEventListener("click", () => {
  openChatGptApp();
});

elements.aiSearchCurrent?.addEventListener("click", () => {
  openChatGptApp();
});

elements.saveCurrentLine?.addEventListener("click", () => {
  toggleSaveLine();
});

elements.dictionaryClose?.addEventListener("click", () => {
  closeDictionaryPopup();
});

elements.dictionaryPlayAudio?.addEventListener("click", () => {
  if (state.dictionaryEntry) {
    playDictionaryAudio(state.dictionaryEntry);
  }
});

elements.saveWord?.addEventListener("click", () => {
  saveCurrentWord();
});

function updateFavoriteButton() {
  if (!elements.toggleFavorite) {
    return;
  }

  const active = Boolean(state.currentVideoId) && isFavorite(state.currentVideoId);
  elements.toggleFavorite.classList.toggle("is-active", active);
  elements.toggleFavorite.setAttribute("aria-label", active ? "お気に入り済み" : "お気に入り");
  elements.toggleFavorite.innerHTML = `<span aria-hidden="true">${active ? "♥" : "♡"}</span>`;
}

function updatePlaybackButton() {
  const isPlaying = state.playerReady
    && state.player?.getPlayerState
    && state.player.getPlayerState() === window.YT?.PlayerState?.PLAYING;

  elements.togglePlayback?.setAttribute("aria-label", isPlaying ? "一時停止" : "再生");
  if (elements.togglePlayback) {
    elements.togglePlayback.innerHTML = `<span class="transport-play-icon" aria-hidden="true">${isPlaying ? "❚❚" : "▶"}</span>`;
  }
}

function updateActiveCue(index, forceScroll = false) {
  if (state.activeIndex === index && !forceScroll) {
    return;
  }

  const previous = elements.transcriptList.querySelector(".cue.active");
  if (previous) {
    previous.classList.remove("active");
  }

  state.activeIndex = index;
  const cue = state.subtitles[index];
  if (!cue) {
    elements.currentCueTime.textContent = "00:00 - 00:00";
    elements.currentOriginal.textContent = "字幕はまだありません。";
    elements.currentTranslation.textContent = "動画を再生すると、ここに現在の字幕が表示されます。";
    updateRepeatButtons();
    updateTransportUI();
    return;
  }

  elements.currentCueTime.textContent = `${formatTime(cue.start)} - ${formatTime(cue.end)}`;
  elements.currentOriginal.innerHTML = renderWordMarkup(cue.text);
  elements.currentTranslation.textContent = cue.translation || "翻訳はありません。";
  bindWordLookup(elements.currentOriginal, cue.text);

  const activeNode = elements.transcriptList.querySelector(`[data-index="${index}"]`);
  if (!activeNode) {
    updateRepeatButtons();
    updateTransportUI();
    return;
  }

  activeNode.classList.add("active");
  updateRepeatButtons();
  updateTransportUI();

  if (state.autoScroll || forceScroll) {
    const anchorIndex = Math.max(index - 1, 0);
    const anchorNode = elements.transcriptList.querySelector(`[data-index="${anchorIndex}"]`) || activeNode;
    const listRect = elements.transcriptList.getBoundingClientRect();
    const anchorRect = anchorNode.getBoundingClientRect();
    const top = Math.max(elements.transcriptList.scrollTop + (anchorRect.top - listRect.top) - 8, 0);
    elements.transcriptList.scrollTo({ top, behavior: "smooth" });
  }
}

async function openDictionaryForWord(word, options = {}) {
  const normalizedWord = normalizeWord(word);
  if (!normalizedWord || !elements.dictionaryPopup) {
    return;
  }

  pauseForDictionary();
  elements.dictionaryBackdrop?.classList.remove("hidden");
  elements.dictionaryPopup.classList.remove("hidden");
  elements.dictionaryWord.textContent = normalizedWord;
  elements.dictionaryPhonetic.textContent = "";
  elements.dictionaryBody.innerHTML = "<p>辞書を読み込み中です...</p>";
  const context = options.context || options.savedItem?.context || state.subtitles[state.activeIndex]?.text || "";
  state.dictionaryEntry = {
    word: normalizedWord,
    phonetic: "",
    meaning: "",
    meanings: [],
    context
  };
  updateSaveWordButton();

  try {
    const entry = await fetchDictionaryEntry(normalizedWord);
    state.dictionaryEntry = {
      ...entry,
      context
    };
    elements.dictionaryWord.textContent = entry.word;
    elements.dictionaryPhonetic.textContent = entry.phonetic;
    renderDictionaryEntry(state.dictionaryEntry);
    updateSaveWordButton();
    playDictionaryAudio(state.dictionaryEntry);
  } catch (error) {
    elements.dictionaryBody.innerHTML = `<p>${escapeHtml(error.message || "辞書情報の取得に失敗しました。")}</p>`;
    updateSaveWordButton();
  }
}

function closeDictionaryPopup() {
  if (state.dictionaryAudio) {
    state.dictionaryAudio.pause();
    state.dictionaryAudio = null;
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }

  elements.dictionaryBackdrop?.classList.add("hidden");
  elements.dictionaryPopup?.classList.add("hidden");

  if (state.dictionaryResumePlayback && state.playerReady && state.player?.playVideo) {
    state.player.playVideo();
  }
  state.dictionaryResumePlayback = false;
}

elements.seekSlider?.addEventListener("input", (event) => {
  state.isSeekingWithSlider = true;
  const nextTime = Number(event.target.value || 0);
  if (elements.currentTimeLabel) {
    elements.currentTimeLabel.textContent = formatTime(nextTime);
  }
});

elements.seekSlider?.addEventListener("change", (event) => {
  const nextTime = Number(event.target.value || 0);
  seekTo(nextTime, false);
  state.isSeekingWithSlider = false;
  updateTransportUI();
});

elements.seekSlider?.addEventListener("pointerup", () => {
  state.isSeekingWithSlider = false;
});

elements.dictionaryBackdrop?.addEventListener("click", () => {
  closeDictionaryPopup();
});

function updateFavoriteButton() {
  if (!elements.toggleFavorite) {
    return;
  }

  const active = Boolean(state.currentVideoId) && isFavorite(state.currentVideoId);
  elements.toggleFavorite.classList.toggle("is-active", active);
  elements.toggleFavorite.setAttribute("aria-label", active ? "Saved favorite" : "Favorite");
  elements.toggleFavorite.innerHTML = `<span aria-hidden="true">${active ? "&#9829;" : "&#9825;"}</span>`;
}

function updatePlaybackButton() {
  const isPlaying = state.playerReady
    && state.player?.getPlayerState
    && state.player.getPlayerState() === window.YT?.PlayerState?.PLAYING;

  elements.togglePlayback?.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
  if (elements.togglePlayback) {
    elements.togglePlayback.innerHTML = `<span class="transport-play-icon" aria-hidden="true">${isPlaying ? "||" : "&#9654;"}</span>`;
  }
}

function updateActiveCue(index, forceScroll = false) {
  if (state.activeIndex === index && !forceScroll) {
    return;
  }

  const previous = elements.transcriptList.querySelector(".cue.active");
  if (previous) {
    previous.classList.remove("active");
  }

  state.activeIndex = index;
  const cue = state.subtitles[index];
  if (!cue) {
    elements.currentCueTime.textContent = "00:00 - 00:00";
    elements.currentOriginal.textContent = "No subtitles yet.";
    elements.currentTranslation.textContent = "The current subtitle will appear here while the video plays.";
    updateRepeatButtons();
    updateSaveCurrentLineButton();
    updateTransportUI();
    return;
  }

  elements.currentCueTime.textContent = `${formatTime(cue.start)} - ${formatTime(cue.end)}`;
  elements.currentOriginal.innerHTML = renderWordMarkup(cue.text);
  elements.currentTranslation.textContent = cue.translation || "No translation available.";
  bindWordLookup(elements.currentOriginal, cue.text);
  updateSaveCurrentLineButton();

  const activeNode = elements.transcriptList.querySelector(`[data-index="${index}"]`);
  if (!activeNode) {
    updateRepeatButtons();
    updateTransportUI();
    return;
  }

  activeNode.classList.add("active");
  updateRepeatButtons();
  updateTransportUI();

  if (state.autoScroll || forceScroll) {
    const anchorIndex = Math.max(index - 1, 0);
    const anchorNode = elements.transcriptList.querySelector(`[data-index="${anchorIndex}"]`) || activeNode;
    const listRect = elements.transcriptList.getBoundingClientRect();
    const anchorRect = anchorNode.getBoundingClientRect();
    const top = Math.max(elements.transcriptList.scrollTop + (anchorRect.top - listRect.top) - 8, 0);
    elements.transcriptList.scrollTo({ top, behavior: "smooth" });
  }
}

async function openDictionaryForWord(word, options = {}) {
  const normalizedWord = normalizeWord(word);
  if (!normalizedWord || !elements.dictionaryPopup) {
    return;
  }

  pauseForDictionary();
  elements.dictionaryBackdrop?.classList.remove("hidden");
  elements.dictionaryPopup.classList.remove("hidden");
  elements.dictionaryWord.textContent = normalizedWord;
  elements.dictionaryPhonetic.textContent = "";
  elements.dictionaryBody.innerHTML = "<p>Loading dictionary...</p>";
  const context = options.context || options.savedItem?.context || state.subtitles[state.activeIndex]?.text || "";
  state.dictionaryEntry = {
    word: normalizedWord,
    phonetic: "",
    meaning: "",
    meanings: [],
    context
  };
  updateSaveWordButton();

  try {
    const entry = await fetchDictionaryEntry(normalizedWord);
    state.dictionaryEntry = {
      ...entry,
      context
    };
    elements.dictionaryWord.textContent = entry.word;
    elements.dictionaryPhonetic.textContent = entry.phonetic;
    renderDictionaryEntry(state.dictionaryEntry);
    updateSaveWordButton();
    playDictionaryAudio(state.dictionaryEntry);
  } catch (error) {
    elements.dictionaryBody.innerHTML = `<p>${escapeHtml(error.message || "Failed to load dictionary.")}</p>`;
    updateSaveWordButton();
  }
}

function closeDictionaryPopup() {
  if (state.dictionaryAudio) {
    state.dictionaryAudio.pause();
    state.dictionaryAudio = null;
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }

  elements.dictionaryBackdrop?.classList.add("hidden");
  elements.dictionaryPopup?.classList.add("hidden");

  if (state.dictionaryResumePlayback && state.playerReady && state.player?.playVideo) {
    state.player.playVideo();
  }
  state.dictionaryResumePlayback = false;
}

function updateRepeatButtons() {
  const cueActive = state.repeatMode?.type === "cue" && state.repeatMode.index === state.activeIndex;
  const groupActive = state.repeatMode?.type === "pair" && state.repeatMode.index === state.activeIndex;

  elements.repeatCurrentCue.classList.toggle("is-active", Boolean(cueActive));
  elements.repeatCurrentGroup.classList.toggle("is-active", Boolean(groupActive));
}

function setRepeatMode(mode) {
  state.repeatMode = mode;
  if (!mode) {
    setRepeatStatus("リピートはオフです。");
    updateRepeatButtons();
    return;
  }

  if (mode.type === "cue") {
    setRepeatStatus(`字幕 ${mode.index + 1} をリピート中です。`);
    updateRepeatButtons();
    return;
  }

  setRepeatStatus(`字幕 ${mode.index + 1} と次の字幕をリピート中です。`);
  updateRepeatButtons();
}

function repeatGroupByCueIndex(index) {
  const cue = state.subtitles[index];
  if (!cue) {
    return;
  }

  const nextCue = state.subtitles[index + 1];
  const loopEnd = nextCue?.end ?? cue.end;

  if (state.repeatMode?.type === "pair" && state.repeatMode.index === index) {
    clearRepeatMode();
    return;
  }

  setRepeatMode({
    type: "pair",
    index,
    start: cue.start,
    end: loopEnd
  });
  seekTo(cue.start, true);
}

function repeatCue(index) {
  const cue = state.subtitles[index];
  if (!cue) {
    return;
  }

  if (state.repeatMode?.type === "cue" && state.repeatMode.index === index) {
    clearRepeatMode();
    return;
  }

  setRepeatMode({
    type: "cue",
    index,
    start: cue.start,
    end: cue.end
  });
  seekTo(cue.start, true);
}

renderEmptyState(elements.searchResults, "検索結果はここに表示されます。");
renderEmptyState(elements.recommendations, "おすすめ動画はここに表示されます。");
renderEmptyState(elements.channelVideosList, "この動画のチャンネル一覧はここに表示されます。");
renderEmptyState(elements.transcriptList, "字幕を読み込むと、ここにタイムスタンプ一覧が表示されます。");
updateNowPlaying();
setTrackOptions([]);
setRepeatStatus("リピートはオフです。");
applyFontSizeMode(state.fontSizeMode);
elements.currentCueTime.textContent = "00:00 - 00:00";
updateTransportUI();
syncViewportHeight();
window.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("scroll", syncViewportHeight);
closeAllPopovers();
renderFavorites();
renderHistory();
renderSavedLines();
renderSavedWords();
updateSaveWordButton();
updateSaveCurrentLineButton();
updateRepeatButtons();
startInitialBootstrap();
elements.urlInput.value = `https://www.youtube.com/watch?v=${getInitialVideoMeta().videoId || DEFAULT_VIDEO_ID}`;
elements.searchQuery.value = "";
