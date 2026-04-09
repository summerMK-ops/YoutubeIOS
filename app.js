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
const CHANNEL_FAVORITES_STORAGE_KEY = "trancy-favorite-channels";
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
  transcriptTextMode: "both",
  activePopover: null,
  pendingResumeTime: 0,
  lastSavedSecond: -1,
  favorites: [],
  favoriteChannels: [],
  savedWords: [],
  savedLines: [],
  history: [],
  channelVideos: [],
  channelVideosSort: "latest",
  channelVideosSource: null,
  searchResults: [],
  recommendations: [],
  selectedVideoMeta: null,
  repeatMode: null,
  dictionaryEntry: null,
  dictionaryAudio: null,
  dictionaryResumePlayback: false,
  transcriptRequestId: 0,
  isSeekingWithSlider: false,
  initialBootstrapStarted: false,
  heargapOpen: false,
  heargapCueIndex: -1,
  heargapVisualEnabled: true,
  heargapLoopMode: "off",
  heargapIteration: 0,
  heargapPlaying: false,
  heargapPausedAt: null,
  heargapPauseAfterCueEnd: false,
  heargapPauseCueEnd: 0,
  heargapLoopTimer: null,
  heargapStopTimer: null,
  heargapMonitorTimer: null,
  heargapResumePlayback: false
};

let youtubeIframeApiPromise = null;

function syncViewportHeight() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${viewportHeight}px`);
}

function detectDeviceLayout() {
  const width = window.visualViewport?.width || window.innerWidth || 0;
  const touchPoints = navigator.maxTouchPoints || 0;
  const userAgent = navigator.userAgent || "";
  const isAppleTablet = /iPad/.test(userAgent) || (navigator.platform === "MacIntel" && touchPoints > 1);
  const isTouchDevice = touchPoints > 0 || /iPad|iPhone|iPod/.test(userAgent);
  const isCoarsePointer = typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;

  if (isAppleTablet) {
    return "tablet";
  }

  if (isCoarsePointer && width >= 768 && width <= 1600) {
    return "tablet";
  }

  if (isTouchDevice && width <= 860) {
    return width >= 768 ? "tablet" : "phone";
  }

  if (isTouchDevice && width <= 1440) {
    return "tablet";
  }

  return "desktop";
}

function applyDeviceLayout() {
  const deviceLayout = detectDeviceLayout();
  document.body.classList.remove("device-phone", "device-tablet", "device-desktop");
  document.body.classList.add(`device-${deviceLayout}`);
  if (typeof syncTabletContentLayout === "function") {
    syncTabletContentLayout(deviceLayout);
  }
}

function syncKeyboardOpenState() {
  const active = document.activeElement;
  const isTextInput = active instanceof HTMLElement
    && (
      active.matches('input[type="text"]')
      || active.matches('input[type="search"]')
      || active.matches('input:not([type])')
      || active.matches("textarea")
    );
  document.body.classList.toggle("keyboard-open", Boolean(isTextInput));
}

function enableDirectTextInput(input) {
  if (!(input instanceof HTMLElement)) {
    return;
  }

  const field = input.closest(".compact-load-field, .search-field, .field");

  const focusInput = () => {
    window.setTimeout(() => {
      input.focus({ preventScroll: true });
      if (typeof input.select === "function") {
        input.select();
      }
    }, 0);
  };

  const swallow = (event, shouldFocus = false) => {
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
    if (shouldFocus) {
      focusInput();
    }
  };

  const bindTarget = (target, shouldFocus = false) => {
    if (!(target instanceof HTMLElement)) {
      return;
    }
    target.addEventListener("pointerdown", (event) => swallow(event, shouldFocus));
    target.addEventListener("mousedown", (event) => swallow(event, shouldFocus));
    target.addEventListener("touchstart", (event) => swallow(event, shouldFocus), { passive: false });
    target.addEventListener("touchmove", (event) => swallow(event, false), { passive: false });
    target.addEventListener("click", (event) => swallow(event, shouldFocus));
  };

  bindTarget(field, false);
  bindTarget(input, true);
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
  toggleFavoriteChannel: document.getElementById("toggle-favorite-channel"),
  channelClose: document.getElementById("channel-close"),
  channelPanel: document.getElementById("channel-panel"),
  channelSort: document.getElementById("channel-sort"),
  channelVideosStatus: document.getElementById("channel-videos-status"),
  channelVideosList: document.getElementById("channel-videos-list"),
  favoriteChannelsClose: document.getElementById("favorite-channels-close"),
  favoriteChannelsPanel: document.getElementById("favorite-channels-panel"),
  favoriteChannelsList: document.getElementById("favorite-channels-list"),
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
  navChannelFavorites: document.getElementById("nav-channel-favorites"),
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
    openHearGapSheet: document.getElementById("open-heargap-sheet"),
  closeHearGapSheet: document.getElementById("close-heargap-sheet"),
  heargapBackdrop: document.getElementById("heargap-backdrop"),
  heargapSheet: document.getElementById("heargap-sheet"),
  heargapVisualToggle: document.getElementById("heargap-visual-toggle"),
  heargapOriginal: document.getElementById("heargap-original"),
  heargapHeardAs: document.getElementById("heargap-heard-as"),
  heargapKana: document.getElementById("heargap-kana"),
  heargapIpa: document.getElementById("heargap-ipa"),
  heargapTranslation: document.getElementById("heargap-translation"),
  heargapTags: document.getElementById("heargap-tags"),
  heargapNote: document.getElementById("heargap-note"),
  heargapPrev: document.getElementById("heargap-prev"),
  heargapPlay: document.getElementById("heargap-play"),
  heargapNext: document.getElementById("heargap-next"),
  heargapLoop: document.getElementById("heargap-loop"),
  heargapRate: document.getElementById("heargap-rate"),
  heargapRange: document.getElementById("heargap-range"),
  videoTitle: document.getElementById("video-title"),
  videoMeta: document.getElementById("video-meta"),
  aiSearchCurrent: document.getElementById("ai-search-current"),
  toggleFavorite: document.getElementById("toggle-favorite"),
  playbackRate: document.getElementById("playback-rate"),
  transcriptVisibilityToggle: document.getElementById("transcript-visibility-toggle"),
  seekBack10: document.getElementById("seek-back-10"),
  seekBack5: document.getElementById("seek-back-5"),
  togglePlayback: document.getElementById("toggle-playback"),
  seekForward5: document.getElementById("seek-forward-5"),
  seekForward10: document.getElementById("seek-forward-10"),
  repeatStatus: document.getElementById("repeat-status"),
  repeatCurrentCue: document.getElementById("repeat-current-cue"),
  repeatCurrentGroup: document.getElementById("repeat-current-group")
};

const layoutNodes = {
  playerPanel: document.querySelector(".player-panel"),
  controlPanel: document.querySelector(".control-panel"),
  playerWrap: document.querySelector(".player-wrap"),
  currentSubtitleBox: document.querySelector(".current-subtitle-box"),
  loadField: document.querySelector(".compact-load-field"),
  transportControls: document.querySelector(".player-controls.transport-controls"),
  secondaryControls: document.querySelector(".player-secondary-controls.compact-secondary-controls")
};

const layoutHomes = {
  currentSubtitleBox: layoutNodes.currentSubtitleBox
    ? { parent: layoutNodes.currentSubtitleBox.parentNode, nextSibling: layoutNodes.currentSubtitleBox.nextSibling }
    : null,
  loadField: layoutNodes.loadField
    ? { parent: layoutNodes.loadField.parentNode, nextSibling: layoutNodes.loadField.nextSibling }
    : null
};

function restoreLayoutNode(node, home) {
  if (!node || !home?.parent) {
    return;
  }

  if (home.nextSibling && home.nextSibling.parentNode === home.parent) {
    home.parent.insertBefore(node, home.nextSibling);
    return;
  }

  home.parent.appendChild(node);
}

function syncTabletContentLayout(deviceLayout = detectDeviceLayout()) {
  if (!layoutNodes.currentSubtitleBox || !layoutNodes.loadField) {
    return;
  }

  if (deviceLayout === "tablet") {
    if (layoutNodes.playerPanel && layoutNodes.playerWrap && layoutNodes.currentSubtitleBox.parentNode !== layoutNodes.playerPanel) {
      layoutNodes.playerPanel.insertBefore(layoutNodes.currentSubtitleBox, layoutNodes.playerWrap.nextSibling);
    }

    if (layoutNodes.controlPanel && layoutNodes.secondaryControls && layoutNodes.loadField.parentNode !== layoutNodes.controlPanel) {
      layoutNodes.controlPanel.insertBefore(layoutNodes.loadField, layoutNodes.secondaryControls.nextSibling);
    } else if (layoutNodes.controlPanel && layoutNodes.secondaryControls) {
      layoutNodes.controlPanel.insertBefore(layoutNodes.loadField, layoutNodes.secondaryControls.nextSibling);
    } else if (layoutNodes.controlPanel && layoutNodes.transportControls && layoutNodes.loadField.parentNode !== layoutNodes.controlPanel) {
      layoutNodes.controlPanel.insertBefore(layoutNodes.loadField, layoutNodes.transportControls.nextSibling);
    }
    return;
  }

  restoreLayoutNode(layoutNodes.currentSubtitleBox, layoutHomes.currentSubtitleBox);
  restoreLayoutNode(layoutNodes.loadField, layoutHomes.loadField);
}

const HEARGAP_TAG_OPTIONS = ["連結", "脱落", "弱形", "flap T", "省略", "強勢"];
const HEARGAP_WEAK_WORDS = new Set(["a", "an", "and", "are", "as", "at", "for", "from", "of", "or", "the", "to", "was", "were", "you"]);
const HEARGAP_LINK_PAIRS = new Set(["kind of", "right now", "sort of", "what are", "going to", "want to"]);
const HEARGAP_KANA_MAP = {
  oh: "オウ",
  yeah: "イェー",
  quit: "クウィッ",
  right: "ライト",
  now: "ナウ",
  what: "ワッ",
  are: "アー",
  you: "ユー",
  doing: "ドゥーイン",
  there: "ゼア",
  theres: "ゼアズ",
  some: "サム",
  honey: "ハニー",
  garlic: "ガーリック",
  and: "ン"
};
const HEARGAP_IPA_MAP = {
  oh: "oʊ",
  yeah: "jɛə",
  quit: "kwɪt",
  right: "raɪt",
  now: "naʊ",
  what: "wʌt",
  are: "ɑɚ",
  you: "jə",
  doing: "ˈduːɪŋ",
  there: "ðer",
  theres: "ðerz",
  some: "səm",
  honey: "ˈhʌni",
  garlic: "ˈɡɑrlɪk",
  and: "ən"
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

function normalizeHearGapWord(word) {
  return String(word || "").toLowerCase().replace(/[^a-z']/g, "").replace(/'/g, "");
}

function fallbackHearGapKana(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/qu/g, "ク")
    .replace(/th/g, "ズ")
    .replace(/sh/g, "シュ")
    .replace(/ch/g, "チ")
    .replace(/ee/g, "イー")
    .replace(/oo/g, "ウー")
    .replace(/ou/g, "アウ")
    .replace(/ow/g, "アウ")
    .replace(/a/g, "ア")
    .replace(/e/g, "エ")
    .replace(/i/g, "イ")
    .replace(/o/g, "オ")
    .replace(/u/g, "ウ")
    .replace(/b/g, "ブ")
    .replace(/c/g, "ク")
    .replace(/d/g, "ド")
    .replace(/f/g, "フ")
    .replace(/g/g, "グ")
    .replace(/h/g, "ハ")
    .replace(/j/g, "ジ")
    .replace(/k/g, "ク")
    .replace(/l/g, "ル")
    .replace(/m/g, "ム")
    .replace(/n/g, "ン")
    .replace(/p/g, "プ")
    .replace(/r/g, "ル")
    .replace(/s/g, "ス")
    .replace(/t/g, "ト")
    .replace(/v/g, "ヴ")
    .replace(/w/g, "ウ")
    .replace(/y/g, "イ")
    .replace(/z/g, "ズ");
}

function fallbackHearGapIpa(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/qu/g, "kw")
    .replace(/th/g, "θ")
    .replace(/sh/g, "ʃ")
    .replace(/ch/g, "tʃ")
    .replace(/ee/g, "iː")
    .replace(/oo/g, "uː")
    .replace(/ou/g, "aʊ")
    .replace(/ow/g, "aʊ")
    .replace(/a/g, "æ")
    .replace(/e/g, "e")
    .replace(/i/g, "ɪ")
    .replace(/o/g, "ɑ")
    .replace(/u/g, "ʌ");
}

function buildHearGapData(cue) {
  const text = String(cue?.text || "").trim();
  const translation = String(cue?.translation || "").trim();
  const tokens = text
    .replace(/([a-zA-Z])([,!?;:])([a-zA-Z])/g, "$1 $2 $3")
    .replace(/[^a-zA-Z0-9'\s]/g, " ")
    .split(/\s+/)
    .map(normalizeHearGapWord)
    .filter(Boolean);

  const heardTokens = [];
  const kanaTokens = [];
  const ipaTokens = [];
  const tags = [];
  const notes = [];

  for (let index = 0; index < tokens.length; ) {
    const first = tokens[index];
    const second = tokens[index + 1];

    if (first === "right" && second === "now") {
      heardTokens.push("right now");
      kanaTokens.push("ライナウ");
      ipaTokens.push("raɪt naʊ");
      tags.push("連結");
      notes.push("right now が切れずにまとまって聞こえる。");
      index += 2;
      continue;
    }

    if (first === "what" && second === "are" && tokens[index + 2] === "you") {
      heardTokens.push("whaddaya");
      kanaTokens.push("ワダヤ");
      ipaTokens.push("wʌɾəjə");
      tags.push("連結", "弱形", "脱落");
      notes.push("what are you が一塊で崩れて聞こえる。");
      index += 3;
      continue;
    }

    let heardWord = first;
    let kanaWord = HEARGAP_KANA_MAP[first] || fallbackHearGapKana(first);
    let ipaWord = HEARGAP_IPA_MAP[first] || fallbackHearGapIpa(first);

    if (first === "you") {
      heardWord = "ya";
      kanaWord = "ヤ";
      ipaWord = "jə";
      tags.push("弱形");
      notes.push("you が弱く ヤ に近づく。");
    } else if (first === "and") {
      heardWord = "n";
      kanaWord = "ン";
      ipaWord = "ən";
      tags.push("弱形");
      notes.push("and が短く弱くなる。");
    }

    heardTokens.push(heardWord);
    kanaTokens.push(kanaWord);
    ipaTokens.push(ipaWord);
    index += 1;
  }

  if (/\b[a-z]+t [aeiou]/i.test(text) || /\bright\b/i.test(text)) {
    tags.push("flap T");
    notes.push("t/d が軽く弾かれて聞こえる可能性がある。");
  }

  return {
    original: text || "No subtitles yet.",
    visualHtml: buildHearGapVisual(text),
    heardAs: heardTokens.join(" ").trim(),
    kana: kanaTokens.join(" ").trim(),
    ipa: ipaTokens.join(" ").trim(),
    translation: translation || "Translation will appear here.",
    tags: [...new Set(tags)].filter(Boolean),
    note: [...new Set(notes)].join(" "),
    start: Number(cue?.start || 0),
    end: Number(cue?.end || 0)
  };
}

function buildHearGapVisual(text) {
  const source = String(text || "").trim();
  if (!source) {
    return escapeHtml("No subtitles yet.");
  }

  const rawTokens = source.match(/[A-Za-z']+|\d+(?:[.:]\d+)*|[^A-Za-z\d\s]+|\s+/g) || [];
  const enrichedTokens = rawTokens.map((token) => ({
    value: token,
    isWord: /[A-Za-z']/.test(token),
    normalized: /[A-Za-z']/.test(token) ? normalizeHearGapWord(token) : ""
  }));
  const wordIndexes = enrichedTokens
    .map((token, index) => (token.isWord ? index : -1))
    .filter((index) => index >= 0);

  for (let wordOrder = 0; wordOrder < wordIndexes.length; wordOrder += 1) {
    const tokenIndex = wordIndexes[wordOrder];
    const current = enrichedTokens[tokenIndex];
    const nextTokenIndex = wordIndexes[wordOrder + 1];
    const next = typeof nextTokenIndex === "number" ? enrichedTokens[nextTokenIndex] : null;
    const classes = ["heargap-word"];

    if (HEARGAP_WEAK_WORDS.has(current.normalized)) {
      classes.push("heargap-weak");
    } else {
      classes.push("heargap-stress");
    }

    let content = escapeHtml(current.value);
    const hasFinalTD = /[td]$/i.test(current.value);
    if (hasFinalTD) {
      const stem = escapeHtml(current.value.slice(0, -1));
      const finalChar = escapeHtml(current.value.slice(-1));
      if (!next || !/^[aeiou]/i.test(next.normalized)) {
        content = `${stem}<span class="heargap-omit">(${finalChar})</span>`;
      } else {
        content = `${stem}<span class="heargap-flap">${finalChar}</span>`;
      }
    }

    current.rendered = `<span class="${classes.join(" ")}">${content}</span>`;
    if (next && HEARGAP_LINK_PAIRS.has(`${current.normalized} ${next.normalized}`)) {
      current.linkAfter = '<span class="heargap-link">~</span>';
    }
  }

  return enrichedTokens.map((token) => {
    if (!token.isWord) {
      return escapeHtml(token.value);
    }
    return `${token.rendered || escapeHtml(token.value)}${token.linkAfter || ""}`;
  }).join("");
}

function getHearGapCue() {
  if (
    Number.isInteger(state.heargapCueIndex)
    && state.heargapCueIndex >= 0
    && state.heargapCueIndex < state.subtitles.length
  ) {
    return state.subtitles[state.heargapCueIndex];
  }

  return getActiveCue();
}

function setPlayerPlaybackRate(preferredRate) {
  if (!state.playerReady || !state.player?.setPlaybackRate) {
    return 1;
  }

  const targetRate = Number(preferredRate || 1);
  const supportedRates = typeof state.player?.getAvailablePlaybackRates === "function"
    ? state.player.getAvailablePlaybackRates().filter((rate) => Number.isFinite(rate) && rate > 0)
    : [];

  const nextRate = supportedRates.length
    ? supportedRates.reduce((closest, rate) => (
      Math.abs(rate - targetRate) < Math.abs(closest - targetRate) ? rate : closest
    ), supportedRates[0])
    : targetRate;

  if (Number.isFinite(nextRate) && nextRate > 0) {
    state.player.setPlaybackRate(nextRate);
    return nextRate;
  }

  return 1;
}

function applyHearGapPlaybackRate() {
  if (!elements.heargapRate) {
    return 1;
  }

  const rate = Number(elements.heargapRate.value || 1);
  if (Number.isFinite(rate) && rate > 0) {
    return setPlayerPlaybackRate(rate);
  }

  return 1;
}

function getHearGapLoopCount() {
  if (state.heargapLoopMode === "x3") {
    return 3;
  }

  if (state.heargapLoopMode === "x10") {
    return 10;
  }

  return 1;
}

function updateHearGapControls() {
  if (elements.heargapPlay) {
    elements.heargapPlay.textContent = state.heargapPlaying ? "Pause" : "Play Line";
  }

  if (elements.heargapLoop) {
    const labelMap = {
      off: "LoopOff",
      x3: "LoopX3",
      x10: "LoopX10"
    };
    elements.heargapLoop.textContent = labelMap[state.heargapLoopMode] || "LoopOff";
    elements.heargapLoop.setAttribute("aria-pressed", String(state.heargapLoopMode !== "off"));
  }

  if (elements.heargapVisualToggle) {
    elements.heargapVisualToggle.textContent = state.heargapVisualEnabled ? "音変化 ON" : "音変化 OFF";
    elements.heargapVisualToggle.setAttribute("aria-pressed", String(state.heargapVisualEnabled));
  }

  const hasPrev = state.heargapCueIndex > 0;
  const hasNext = state.heargapCueIndex >= 0 && state.heargapCueIndex < state.subtitles.length - 1;
  if (elements.heargapPrev) {
    elements.heargapPrev.disabled = !hasPrev;
  }
  if (elements.heargapNext) {
    elements.heargapNext.disabled = !hasNext;
  }
}

function renderHearGapSheet() {
  const cue = getHearGapCue();
  const data = buildHearGapData(cue);

  if (state.heargapVisualEnabled) {
    elements.heargapOriginal.innerHTML = data.visualHtml;
  } else {
    elements.heargapOriginal.textContent = data.original;
  }
  elements.heargapHeardAs.textContent = data.heardAs && data.heardAs.toLowerCase() !== data.original.toLowerCase() ? data.heardAs : "";
  elements.heargapKana.textContent = data.kana || "";
  elements.heargapIpa.textContent = data.ipa || "";
  elements.heargapTranslation.textContent = data.translation;
  elements.heargapRange.textContent = `${formatTime(data.start)} - ${formatTime(data.end)}`;
  elements.heargapNote.textContent = data.note || "音の崩れ方をこの画面で確認できます。";
  elements.heargapTags.innerHTML = data.tags.map((tag) => `<span class="heargap-tag">${escapeHtml(tag)}</span>`).join("");
  updateHearGapControls();
}

function clearHearGapPlaybackTimers() {
  if (state.heargapStopTimer) {
    window.clearTimeout(state.heargapStopTimer);
    state.heargapStopTimer = null;
  }
  if (state.heargapLoopTimer) {
    window.clearTimeout(state.heargapLoopTimer);
    state.heargapLoopTimer = null;
  }
  if (state.heargapMonitorTimer) {
    window.clearInterval(state.heargapMonitorTimer);
    state.heargapMonitorTimer = null;
  }
}

function stopHearGapPlayback(shouldPause = true, preservePause = false) {
  clearHearGapPlaybackTimers();
  if (shouldPause && state.playerReady && state.player?.pauseVideo) {
    state.player.pauseVideo();
  }
  state.heargapPlaying = false;
  state.heargapPauseAfterCueEnd = false;
  state.heargapPauseCueEnd = 0;
  if (!preservePause) {
    state.heargapPausedAt = null;
    state.heargapIteration = 0;
  }
  updateHearGapControls();
}

function playHearGapCue() {
  const cue = getHearGapCue();
  if (!cue || !state.playerReady || !state.player?.seekTo || !state.player?.playVideo) {
    return;
  }

  if (state.heargapPlaying) {
    if (state.player?.getCurrentTime) {
      const currentTime = Number(state.player.getCurrentTime() || 0);
      state.heargapPausedAt = Number.isFinite(currentTime) ? currentTime : Number(cue.start || 0);
    }
    stopHearGapPlayback(true, true);
    return;
  }

  clearHearGapPlaybackTimers();
  const rate = applyHearGapPlaybackRate();
  const start = Math.max(0, Number(cue.start || 0) - 0.5);
  const end = Number(cue.end || cue.start || 0);
  const stopAt = Math.max(start, end + 0.5);
  const settleAt = Math.max(start, end);
  const initialStart = (
    typeof state.heargapPausedAt === "number"
    && state.heargapPausedAt > start
    && state.heargapPausedAt < end
  ) ? state.heargapPausedAt : start;

  if (!(end > start)) {
    return;
  }

  const finishIteration = () => {
    clearHearGapPlaybackTimers();
    state.player.pauseVideo();
    state.player.seekTo(settleAt, true);
    state.heargapPausedAt = null;
    state.heargapIteration += 1;

    if (state.heargapIteration < getHearGapLoopCount()) {
      state.heargapLoopTimer = window.setTimeout(() => {
        playOnce(start);
      }, 300);
      return;
    }

    stopHearGapPlayback(false);
  };

  const playOnce = (segmentStart) => {
    state.heargapPlaying = true;
    updateHearGapControls();
    state.player.seekTo(segmentStart, true);
    state.player.playVideo();
    window.setTimeout(applyHearGapPlaybackRate, 0);
    window.setTimeout(applyHearGapPlaybackRate, 120);

    const safetyDurationMs = Math.max((((stopAt - segmentStart) * 1000) / Math.max(rate, 0.1)) + 90, 240);
    state.heargapStopTimer = window.setTimeout(() => {
      finishIteration();
    }, safetyDurationMs);

    state.heargapMonitorTimer = window.setInterval(() => {
      if (!state.player?.getCurrentTime) {
        return;
      }

      const currentTime = Number(state.player.getCurrentTime() || 0);
      if (currentTime >= stopAt) {
        finishIteration();
      }
    }, 60);
  };

  if (initialStart <= start + 0.001) {
    state.heargapIteration = 0;
  }
  playOnce(initialStart);
}

function stepHearGapCue(delta) {
  if (!state.subtitles.length) {
    return;
  }

  const baseIndex = state.heargapCueIndex >= 0 ? state.heargapCueIndex : state.activeIndex;
  const nextIndex = Math.max(0, Math.min(state.subtitles.length - 1, baseIndex + delta));
  if (nextIndex === baseIndex) {
    return;
  }

  stopHearGapPlayback();
  state.heargapCueIndex = nextIndex;
  const cue = state.subtitles[nextIndex];
  updateActiveCue(nextIndex, true);
  if (cue && !state.repeatMode) {
    seekTo(cue.start, false);
  }
  renderHearGapSheet();
}

function openHearGapSheet() {
  const activeCue = getActiveCue();
  state.heargapOpen = true;
  state.heargapCueIndex = state.activeIndex;
  if (
    activeCue
    && state.playerReady
    && state.player?.getPlayerState
    && state.player.getPlayerState() === window.YT?.PlayerState?.PLAYING
  ) {
    state.heargapPauseAfterCueEnd = true;
    state.heargapPauseCueEnd = Number(activeCue.end || 0);
  } else {
    state.heargapPauseAfterCueEnd = false;
    state.heargapPauseCueEnd = 0;
  }
  renderHearGapSheet();
  elements.heargapBackdrop?.classList.remove("hidden");
  elements.heargapSheet?.classList.remove("hidden");
  requestAnimationFrame(() => {
    elements.heargapBackdrop?.classList.add("is-open");
    elements.heargapSheet?.classList.add("is-open");
  });
}

function closeHearGapSheet() {
  state.heargapOpen = false;
  stopHearGapPlayback();
  state.heargapCueIndex = -1;
  elements.heargapBackdrop?.classList.remove("is-open");
  elements.heargapSheet?.classList.remove("is-open");
  window.setTimeout(() => {
    if (!state.heargapOpen) {
      elements.heargapBackdrop?.classList.add("hidden");
      elements.heargapSheet?.classList.add("hidden");
    }
  }, 220);
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
state.favoriteChannels = readFavoriteChannels();
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

function readFavoriteChannels() {
  try {
    const raw = window.localStorage.getItem(CHANNEL_FAVORITES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_error) {
    return [];
  }
}

function writeFavoriteChannels(items) {
  try {
    window.localStorage.setItem(CHANNEL_FAVORITES_STORAGE_KEY, JSON.stringify(items));
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

function isFavoriteChannel(channelId) {
  return Boolean(channelId) && state.favoriteChannels.some((item) => item.channelId === channelId);
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

function getCueTextUntilBoundary(startIndex) {
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= state.subtitles.length) {
    return "";
  }

  const parts = [];
  const boundaryRe = /[.?!。！？]/;

  for (let index = startIndex; index < state.subtitles.length; index += 1) {
    const text = String(state.subtitles[index]?.text || "").trim();
    if (!text) {
      continue;
    }

    if (index <= startIndex + 1) {
      parts.push(text);
      continue;
    }

    const boundaryIndex = text.search(boundaryRe);
    if (boundaryIndex >= 0) {
      parts.push(text.slice(0, boundaryIndex + 1).trim());
      break;
    }

    parts.push(text);
  }

  return parts.join(" ").trim();
}

function getActiveCueGroupText() {
  if (state.activeIndex < 0) {
    return "";
  }

  return getCueTextUntilBoundary(state.activeIndex);
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

function updateFavoriteChannelButton() {
  if (!elements.toggleFavoriteChannel) {
    return;
  }

  const channelId = state.selectedVideoMeta?.channelId || "";
  const active = isFavoriteChannel(channelId);
  elements.toggleFavoriteChannel.classList.toggle("is-active", active);
  elements.toggleFavoriteChannel.setAttribute("aria-label", active ? "Saved favorite channel" : "Favorite current channel");
  elements.toggleFavoriteChannel.innerHTML = active ? "CH&#9733;" : "CH&#9734;";
}

function renderFavoriteChannels() {
  if (!elements.favoriteChannelsList) {
    return;
  }

  if (!state.favoriteChannels.length) {
    elements.favoriteChannelsList.innerHTML = '<div class="favorite-empty">お気に入りしたチャンネルがここに並びます。</div>';
    updateFavoriteChannelButton();
    return;
  }

  elements.favoriteChannelsList.innerHTML = state.favoriteChannels.map((item) => `
    <article class="favorite-item" data-channel-id="${escapeHtml(item.channelId)}">
      <img class="favorite-thumb" src="${escapeHtml(item.thumbnail || `https://i.ytimg.com/vi/${item.videoId || ""}/hqdefault.jpg`)}" alt="${escapeHtml(item.channelName || "Channel")}" />
      <div class="favorite-copy">
        <div class="favorite-head">
          <p class="favorite-title">${escapeHtml(item.channelName || "Channel")}</p>
          <button class="ghost favorite-remove" type="button" data-remove-channel-id="${escapeHtml(item.channelId)}">解除</button>
        </div>
        <p class="favorite-meta">${escapeHtml(item.videoTitle || "")}</p>
      </div>
    </article>
  `).join("");

  elements.favoriteChannelsList.querySelectorAll(".favorite-item").forEach((node) => {
    node.addEventListener("click", () => {
      const channelItem = state.favoriteChannels.find((item) => item.channelId === node.dataset.channelId);
      if (!channelItem) {
        return;
      }
      setPopoverOpen("favorite-channels", false);
      openChannelVideos(channelItem, state.channelVideosSort).catch(() => {});
    });
  });

  elements.favoriteChannelsList.querySelectorAll("[data-remove-channel-id]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      removeFavoriteChannel(node.dataset.removeChannelId || "");
    });
  });

  updateFavoriteChannelButton();
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

async function resolveCurrentChannelMeta() {
  if (!state.currentVideoId) {
    return null;
  }

  if (state.selectedVideoMeta?.channelId) {
    return state.selectedVideoMeta;
  }

  try {
    const payload = await fetchJson(`/api/video-meta?videoId=${encodeURIComponent(state.currentVideoId)}`);
    applyVideoMetaUpdate(state.currentVideoId, payload);
    return mergeVideoMeta(state.selectedVideoMeta || { videoId: state.currentVideoId }, payload);
  } catch (_error) {
    return state.selectedVideoMeta || null;
  }
}

async function toggleFavoriteCurrentChannel() {
  const channelMeta = await resolveCurrentChannelMeta();
  const channelId = channelMeta?.channelId || "";
  if (!channelId) {
    return;
  }

  if (isFavoriteChannel(channelId)) {
    state.favoriteChannels = state.favoriteChannels.filter((item) => item.channelId !== channelId);
  } else {
    state.favoriteChannels.unshift({
      channelId,
      channelName: channelMeta.channelName || "Channel",
      videoId: state.currentVideoId || channelMeta.videoId || "",
      videoTitle: channelMeta.title || "",
      thumbnail: channelMeta.thumbnail || `https://i.ytimg.com/vi/${state.currentVideoId || channelMeta.videoId || ""}/hqdefault.jpg`
    });
  }

  state.favoriteChannels = state.favoriteChannels.slice(0, 50);
  writeFavoriteChannels(state.favoriteChannels);
  renderFavoriteChannels();
}

function removeFavoriteChannel(channelId) {
  if (!channelId) {
    return;
  }

  state.favoriteChannels = state.favoriteChannels.filter((item) => item.channelId !== channelId);
  writeFavoriteChannels(state.favoriteChannels);
  renderFavoriteChannels();
}

async function openChannelVideos(source, sort = state.channelVideosSort) {
  setPopoverOpen("channel-videos", true);
  await loadChannelVideos(sort, source);
}

function setPopoverOpen(name, open) {
  state.activePopover = open ? name : (state.activePopover === name ? null : state.activePopover);

  const groups = [
    ["settings", elements.settingsPanel, elements.navSettings || elements.settingsToggle],
    ["favorites", elements.favoritesPanel, elements.navFavorites || elements.favoritesToggle],
    ["history", elements.historyPanel, elements.navHistory],
    ["channel-videos", elements.channelPanel, elements.channelVideosToggle],
    ["favorite-channels", elements.favoriteChannelsPanel, elements.navChannelFavorites],
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

function applyTranscriptVisibility(mode) {
  const nextMode = ["both", "english", "hidden"].includes(mode)
    ? mode
    : (mode === false ? "hidden" : "both");

  state.transcriptTextMode = nextMode;
  document.body.classList.toggle("transcript-hidden", nextMode === "hidden");
  document.body.classList.toggle("transcript-english-only", nextMode === "english");
  if (elements.transcriptVisibilityToggle) {
    const labels = {
      both: "文字ON",
      english: "英文のみ",
      hidden: "文字OFF"
    };
    elements.transcriptVisibilityToggle.textContent = labels[nextMode];
    elements.transcriptVisibilityToggle.setAttribute("aria-pressed", nextMode === "hidden" ? "true" : "false");
    elements.transcriptVisibilityToggle.setAttribute("aria-label", `Transcript mode: ${labels[nextMode]}`);
    elements.transcriptVisibilityToggle.classList.toggle("is-active", nextMode !== "both");
  }

  if (elements.transcriptList && nextMode === "hidden") {
    elements.transcriptList.scrollTop = 0;
  }

  if (nextMode !== "hidden" && state.activeIndex >= 0) {
    updateActiveCue(state.activeIndex, true);
  }
}

function cycleTranscriptVisibilityMode() {
  const order = ["both", "english", "hidden"];
  const currentIndex = order.indexOf(state.transcriptTextMode);
  const nextMode = order[(currentIndex + 1 + order.length) % order.length];
  applyTranscriptVisibility(nextMode);
}

function updatePipButton() {
  if (!elements.pipToggle) {
    return;
  }

  const video = getPlayerVideoElement();
  const supported = canUsePictureInPicture(video);
  let active = false;

  if (video && typeof video.webkitPresentationMode === "string") {
    active = video.webkitPresentationMode === "picture-in-picture";
  } else if (document.pictureInPictureElement) {
    active = document.pictureInPictureElement === video;
  }

  elements.pipToggle.disabled = !supported;
  elements.pipToggle.textContent = active ? "PiP中" : "PiP";
  elements.pipToggle.setAttribute("aria-pressed", active ? "true" : "false");
}

async function togglePictureInPicture() {
  const video = getPlayerVideoElement();
  if (!video || !canUsePictureInPicture(video)) {
    updatePipButton();
    return;
  }

  try {
    if (typeof video.webkitSupportsPresentationMode === "function" && typeof video.webkitSetPresentationMode === "function") {
      const nextMode = video.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture";
      video.webkitSetPresentationMode(nextMode);
    } else if (document.pictureInPictureElement === video && typeof document.exitPictureInPicture === "function") {
      await document.exitPictureInPicture();
    } else if (typeof video.requestPictureInPicture === "function") {
      await video.requestPictureInPicture();
    }
  } catch (_error) {
    // Keep this experimental and silent when browsers refuse PiP.
  }

  window.setTimeout(updatePipButton, 100);
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
    updateFavoriteChannelButton();
    return;
  }

  elements.videoTitle.textContent = meta.title || "動画タイトル";
  elements.videoMeta.textContent = [meta.channelName, meta.lengthText, meta.viewCountText, meta.publishedTimeText]
    .filter(Boolean)
    .join(" / ");
  updateFavoriteButton();
  updateFavoriteChannelButton();
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

function countTranslatedSubtitles(subtitles) {
  return (Array.isArray(subtitles) ? subtitles : []).filter((cue) => String(cue?.translation || "").trim()).length;
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
      const text = getCueTextUntilBoundary(index);
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

elements.openHearGapSheet?.addEventListener("click", () => {
  openHearGapSheet();
});

elements.closeHearGapSheet?.addEventListener("click", () => {
  closeHearGapSheet();
});

elements.heargapBackdrop?.addEventListener("click", () => {
  closeHearGapSheet();
});

elements.heargapPlay?.addEventListener("click", () => {
  playHearGapCue();
});

elements.heargapVisualToggle?.addEventListener("click", () => {
  state.heargapVisualEnabled = !state.heargapVisualEnabled;
  if (state.heargapOpen) {
    renderHearGapSheet();
  } else {
    updateHearGapControls();
  }
});

elements.heargapPrev?.addEventListener("click", () => {
  stepHearGapCue(-1);
});

elements.heargapNext?.addEventListener("click", () => {
  stepHearGapCue(1);
});

elements.heargapLoop?.addEventListener("click", () => {
  const nextLoopMode = {
    off: "x3",
    x3: "x10",
    x10: "off"
  };
  state.heargapLoopMode = nextLoopMode[state.heargapLoopMode] || "off";
  updateHearGapControls();
});

elements.heargapRate?.addEventListener("change", () => {
  applyHearGapPlaybackRate();
  if (state.heargapOpen) {
    renderHearGapSheet();
  }
});

function updateActiveCue(index, forceScroll = false) {
  if (state.activeIndex === index && !forceScroll) {
    return;
  }

  const previous = elements.transcriptList.querySelector(".cue.active");
  if (previous) {
    previous.classList.remove("active");
  }

  state.activeIndex = index;
  if (state.heargapOpen && !state.heargapPlaying) {
    state.heargapCueIndex = index;
  }
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
    const isTabletLayout = document.body.classList.contains("device-tablet");
    const listRect = elements.transcriptList.getBoundingClientRect();
    const activeRect = activeNode.getBoundingClientRect();

    if (isTabletLayout && !forceScroll) {
      const upperDeadZone = listRect.top + (listRect.height * 0.18);
      const lowerDeadZone = listRect.bottom - (listRect.height * 0.28);
      const staysInComfortZone = activeRect.top >= upperDeadZone && activeRect.bottom <= lowerDeadZone;

      if (staysInComfortZone) {
        return;
      }

      const targetTop = Math.max(
        elements.transcriptList.scrollTop + (activeRect.top - listRect.top) - (listRect.height * 0.34),
        0
      );
      elements.transcriptList.scrollTo({ top: targetTop, behavior: "auto" });
      return;
    }

    const anchorIndex = Math.max(index - 1, 0);
    const anchorNode = elements.transcriptList.querySelector(`[data-index="${anchorIndex}"]`) || activeNode;
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
    if (
      state.heargapPauseAfterCueEnd
      && playerState === window.YT?.PlayerState?.PLAYING
      && state.player?.getCurrentTime
    ) {
      const currentTime = Number(state.player.getCurrentTime() || 0);
      if (currentTime >= Math.max(0, state.heargapPauseCueEnd)) {
        state.player.pauseVideo();
        state.heargapPauseAfterCueEnd = false;
        state.heargapPauseCueEnd = 0;
      }
    }

    if (state.heargapPlaying) {
      updatePlaybackButton();
      updateTransportUI();
      return;
    }

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
  const origin = window.location.origin;
  state.player = new window.YT.Player("player", {
    host: "https://www.youtube.com",
    videoId,
    playerVars: {
      autoplay: 0,
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      enablejsapi: 1,
      origin
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
          window.setTimeout(updatePipButton, 600);
        },
        onStateChange: () => {
        if (state.pendingResumeTime > 0 && state.player?.getPlayerState?.() === window.YT?.PlayerState?.CUED) {
          seekTo(state.pendingResumeTime, false);
          state.pendingResumeTime = 0;
        }
        if (state.heargapPlaying) {
          applyHearGapPlaybackRate();
        } else {
          applyPlaybackRate();
        }
        if (!state.heargapPlaying) {
          syncActiveCue();
          }
          updatePlaybackButton();
          updateTransportUI();
          persistCurrentPlaybackTime();
          window.setTimeout(updatePipButton, 120);
        }
      }
    });
  }

function applyPlaybackRate() {
  if (!elements.playbackRate) {
    return;
  }

  const rate = Number(elements.playbackRate.value || 1);
  if (Number.isFinite(rate) && rate > 0) {
    setPlayerPlaybackRate(rate);
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
    channelId: nextMeta?.channelId || baseItem?.channelId || "",
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

let heargapTouchStartY = 0;
let heargapTouchStartX = 0;

elements.heargapSheet?.addEventListener("touchstart", (event) => {
  const touch = event.touches?.[0];
  if (!touch) {
    return;
  }
  heargapTouchStartY = touch.clientY;
  heargapTouchStartX = touch.clientX;
}, { passive: true });

elements.heargapSheet?.addEventListener("touchend", (event) => {
  const touch = event.changedTouches?.[0];
  if (!touch || !state.heargapOpen) {
    return;
  }

  const deltaY = touch.clientY - heargapTouchStartY;
  const deltaX = Math.abs(touch.clientX - heargapTouchStartX);
  if (deltaY > 90 && deltaY > deltaX * 1.2) {
    closeHearGapSheet();
  }
}, { passive: true });

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

function buildTranslationGroups(subtitles) {
  const { groups } = buildCueGroups(subtitles);
  return groups.map((group) => {
    const cueIndexes = Array.isArray(group.cueIndexes) ? group.cueIndexes : [];
    const cues = cueIndexes
      .map((index) => subtitles[index])
      .filter(Boolean);

    return {
      start: group.start,
      end: group.end,
      cueIndexes,
      lines: cues
        .map((cue) => (cue.text || "").trim())
        .filter(Boolean),
      text: cues
        .map((cue) => (cue.text || "").trim())
        .join("\n")
        .trim(),
      translation: ""
    };
  }).filter((group) => group.text);
}

function splitGroupedTranslation(translation, originalTexts) {
  const sourceTexts = Array.isArray(originalTexts) ? originalTexts : [];
  const expectedCount = sourceTexts.length;
  if (!expectedCount) {
    return [];
  }

  const normalized = String(translation || "").replace(/\r/g, "").trim();
  if (!normalized) {
    return Array.from({ length: expectedCount }, () => "");
  }

  const stripDisplayMarkers = (value) =>
    String(value || "")
      .replace(/【\d+】\s*/g, "")
      .replace(/\[\[(\d+)\]\]\s*/g, "")
      .replace(/__LINE_\d+__\s*/g, "")
      .replace(/^\[\d+\]\s*/g, "")
      .replace(/^\d+[\.\):：]\s*/g, "")
      .trim();
  const normalizePart = (part) => stripDisplayMarkers(String(part || "").replace(/\s+/g, " ").trim());
  const lineWeights = sourceTexts.map((text) => Math.max(1, normalizePart(text).length));
  const sentenceParts = normalized
    .split(/(?<=[。！？!?])\s+|\n+/)
    .map(normalizePart)
    .filter(Boolean);
  const clauseParts = normalized
    .split(/(?<=、)\s*|(?<=[。！？!?])\s*|\n+/)
    .map(normalizePart)
    .filter(Boolean);

  const refineClauseParts = (parts) =>
    parts.flatMap((part) => {
      const normalizedPart = normalizePart(part);
      if (!normalizedPart) {
        return [];
      }

      const topicMatch = normalizedPart.match(/^(.+?[はがをにへでと])、(.+)$/);
      if (!topicMatch) {
        return [normalizedPart];
      }

      const head = normalizePart(`${topicMatch[1]}、`);
      const tail = normalizePart(topicMatch[2]);
      return [head, tail].filter(Boolean);
    });

  const distributeSequentialParts = (parts) => {
    if (!parts.length) {
      return null;
    }

    return Array.from({ length: expectedCount }, (_value, index) => {
      const start = Math.floor((index * parts.length) / expectedCount);
      const end = Math.floor(((index + 1) * parts.length) / expectedCount);
      const safeEnd = Math.max(start + 1, end);
      return parts.slice(start, safeEnd).join("").trim();
    });
  };

  const splitByWeights = (text) => {
    const chars = Array.from(normalizePart(text));
    if (!chars.length) {
      return Array.from({ length: expectedCount }, () => "");
    }

    const totalWeight = lineWeights.reduce((sum, weight) => sum + weight, 0);
    let consumedWeight = 0;
    return lineWeights.map((weight, index) => {
      const start = Math.round((consumedWeight / totalWeight) * chars.length);
      consumedWeight += weight;
      const end =
        index === expectedCount - 1
          ? chars.length
          : Math.round((consumedWeight / totalWeight) * chars.length);
      return chars.slice(start, end).join("").trim();
    });
  };

  const scoreClauseAgainstLine = (lineText, clause, lineIndex, clauseIndex, clauseCount) => {
    const english = String(lineText || "").toLowerCase();
    const japanese = normalizePart(clause);
    const lineRatio = expectedCount > 1 ? lineIndex / (expectedCount - 1) : 0;
    const clauseRatio = clauseCount > 1 ? clauseIndex / (clauseCount - 1) : 0;
    let score = -Math.abs(lineRatio - clauseRatio) * 2;

    if (/especially|particularly|in particular/.test(english) && /特に|とりわけ|なかでも/.test(japanese)) {
      score += 6;
    }
    if (/\bthink\b|it'?s like|seems?/.test(english) && /思|考え|感じ|ようなもの|気が/.test(japanese)) {
      score += 9;
    }
    if (/\bthink\b|it'?s like|seems?/.test(english) && /です|ます|だった|だと思|ようなもの/.test(japanese)) {
      score += 7;
    }
    if (/\bquit\b|stop|give up|leave/.test(english) && /辞|やめ|止|離/.test(japanese)) {
      score += 5;
    }
    if (/\bkind\b|\bpeople\b|those|type/.test(english) && /人|タイプ|ような/.test(japanese)) {
      score += 4;
    }
    if (/\bjob\b|work|career/.test(english) && /仕事|職|勤/.test(japanese)) {
      score += 4;
    }
    if (/\bbig\b|huge|leap/.test(english) && /大き|飛躍/.test(japanese)) {
      score += 4;
    }
    if (/\bgirl\b|woman|lady/.test(english) && /女|女性|女子/.test(japanese)) {
      score += 3;
    }

    return score;
  };

  const assignClausesByAnchors = (clauses) => {
    if (!clauses.length) {
      return null;
    }

    if (clauses.length < expectedCount) {
      return null;
    }

    const scoreRange = (lineIndex, start, end) => {
      let total = 0;
      for (let clauseIndex = start; clauseIndex < end; clauseIndex += 1) {
        total += scoreClauseAgainstLine(sourceTexts[lineIndex], clauses[clauseIndex], lineIndex, clauseIndex, clauses.length);
      }
      return total;
    };

    const memo = new Map();
    const solve = (lineIndex, clauseStart) => {
      const key = `${lineIndex}:${clauseStart}`;
      if (memo.has(key)) {
        return memo.get(key);
      }

      if (lineIndex === expectedCount - 1) {
        const result = {
          score: scoreRange(lineIndex, clauseStart, clauses.length),
          groups: [clauses.slice(clauseStart)]
        };
        memo.set(key, result);
        return result;
      }

      let best = null;
      const minEnd = clauseStart + 1;
      const maxEnd = clauses.length - (expectedCount - lineIndex - 1);
      for (let clauseEnd = minEnd; clauseEnd <= maxEnd; clauseEnd += 1) {
        const rest = solve(lineIndex + 1, clauseEnd);
        if (!rest) {
          continue;
        }

        const currentScore = scoreRange(lineIndex, clauseStart, clauseEnd) + rest.score;
        if (!best || currentScore > best.score) {
          best = {
            score: currentScore,
            groups: [clauses.slice(clauseStart, clauseEnd), ...rest.groups]
          };
        }
      }

      memo.set(key, best);
      return best;
    };

    const solution = solve(0, 0);
    if (!solution?.groups || solution.groups.length !== expectedCount) {
      return null;
    }

    const rebalancedGroups = solution.groups.map((parts) => parts.slice());
    const hasPredicateClause = (parts) =>
      parts.some((part) => /大き|飛躍|思|考え|感じ|ようなもの|です|ます|だった|である/.test(normalizePart(part)));
    const hasEspeciallyClause = (parts) =>
      parts.some((part) => /特に|とりわけ|なかでも/.test(normalizePart(part)));

    const firstEnglish = String(sourceTexts[0] || "").toLowerCase();
    if (/\bthink\b|it'?s like|seems?|feel\b/.test(firstEnglish) && !hasPredicateClause(rebalancedGroups[0])) {
      for (let index = 1; index < rebalancedGroups.length; index += 1) {
        const clauseIndex = rebalancedGroups[index].findIndex((part) =>
          /大き|飛躍|思|考え|感じ|ようなもの|です|ます|だった|である/.test(normalizePart(part))
        );
        if (clauseIndex >= 0) {
          const [predicateClause] = rebalancedGroups[index].splice(clauseIndex, 1);
          rebalancedGroups[0].push(predicateClause);
          break;
        }
      }
    }

    const lastEnglish = String(sourceTexts[sourceTexts.length - 1] || "").toLowerCase();
    if (/especially|particularly|in particular/.test(lastEnglish) && !hasEspeciallyClause(rebalancedGroups[expectedCount - 1])) {
      for (let index = 0; index < rebalancedGroups.length - 1; index += 1) {
        const clauseIndex = rebalancedGroups[index].findIndex((part) =>
          /特に|とりわけ|なかでも/.test(normalizePart(part))
        );
        if (clauseIndex >= 0) {
          const [especiallyClause] = rebalancedGroups[index].splice(clauseIndex, 1);
          rebalancedGroups[expectedCount - 1].unshift(especiallyClause);
          break;
        }
      }
    }

    return rebalancedGroups.map((parts) => parts.join("").trim());
  };

  const reorderClausesForEnglishOrder = (clauses) => {
    const nextClauses = clauses.slice();
    if (!nextClauses.length || !sourceTexts.length) {
      return nextClauses;
    }

    const findClauseIndex = (predicate) => nextClauses.findIndex((clause) => predicate(normalizePart(clause)));
    const moveClause = (fromIndex, toIndex) => {
      if (fromIndex < 0 || fromIndex >= nextClauses.length || fromIndex === toIndex) {
        return;
      }
      const [clause] = nextClauses.splice(fromIndex, 1);
      nextClauses.splice(Math.max(0, Math.min(toIndex, nextClauses.length)), 0, clause);
    };

    const firstEnglish = String(sourceTexts[0] || "").toLowerCase();
    if (/\bthink\b|it'?s like|seems?|feel\b/.test(firstEnglish)) {
      const predicateIndex = findClauseIndex((clause) => /思|考え|感じ|ようなもの|です|ます|だった|である/.test(clause));
      moveClause(predicateIndex, 0);
    }

    const lastEnglish = String(sourceTexts[sourceTexts.length - 1] || "").toLowerCase();
    if (/especially|particularly|in particular/.test(lastEnglish)) {
      const especiallyIndex = findClauseIndex((clause) => /特に|とりわけ|なかでも/.test(clause));
      moveClause(especiallyIndex, nextClauses.length - 1);
    }

    return nextClauses;
  };

  const redistributeText = (text) => {
    const cleaned = normalizePart(text);
    if (!cleaned) {
      return Array.from({ length: expectedCount }, () => "");
    }

    const localClauseParts = reorderClausesForEnglishOrder(refineClauseParts(cleaned
      .split(/(?<=、)\s*|(?<=[。！？!?])\s*|\n+/)
      .map(normalizePart)
      .filter(Boolean)));
    if (localClauseParts.length === expectedCount) {
      return localClauseParts;
    }
    if (localClauseParts.length > 1) {
      const anchored = assignClausesByAnchors(localClauseParts);
      if (anchored) {
        return anchored;
      }
    }
    if (localClauseParts.length > 1) {
      return distributeSequentialParts(localClauseParts);
    }

    const localSentenceParts = cleaned
      .split(/(?<=[。！？!?])\s+|\n+/)
      .map(normalizePart)
      .filter(Boolean);
    if (localSentenceParts.length === expectedCount) {
      return localSentenceParts;
    }
    if (localSentenceParts.length > 1) {
      return distributeSequentialParts(localSentenceParts);
    }

    const localLineParts = cleaned
      .split("\n")
      .map(normalizePart)
      .filter(Boolean);
    if (localLineParts.length === expectedCount) {
      return localLineParts;
    }
    if (localLineParts.length > 1) {
      return distributeSequentialParts(localLineParts);
    }

    return splitByWeights(cleaned).map(normalizePart);
  };

  const markerRegex = /(?:__LINE_(\d+)__|\[\[(\d+)\]\]|【(\d+)】)\s*([\s\S]*?)(?=(?:\n?\s*(?:__LINE_\d+__|\[\[\d+\]\]|【\d+】))|$)/g;
  const markerMatches = Array.from(normalized.matchAll(markerRegex));
  if (markerMatches.length) {
    const parts = Array.from({ length: expectedCount }, () => "");
    markerMatches.forEach((match) => {
      const index = Number(match[1] || match[2] || match[3]) - 1;
      if (index >= 0 && index < expectedCount) {
        parts[index] = normalizePart(match[4]);
      }
    });
    const filledParts = parts.filter(Boolean);
    if (filledParts.length === expectedCount) {
      return parts;
    }
    return redistributeText(filledParts.join(" "));
  }

  const lineParts = normalized
    .split("\n")
    .map(normalizePart)
    .filter(Boolean);
  if (lineParts.length === expectedCount) {
    return lineParts;
  }
  if (sentenceParts.length === expectedCount) {
    return sentenceParts;
  }

  return redistributeText(normalized);
}

function mergeTranslatedGroups(currentSubtitles, translatedGroups, groupStartIndex, translationGroups) {
  const nextSubtitles = currentSubtitles.slice();
  translatedGroups.forEach((group, index) => {
    const targetGroup = translationGroups[groupStartIndex + index];
    if (!targetGroup?.cueIndexes?.length) {
      return;
    }

    const originalTexts = targetGroup.cueIndexes.map((cueIndex) => nextSubtitles[cueIndex]?.text || "");
    const directTranslations = Array.isArray(group?.translations)
      ? group.translations.map((value) => String(value || "").trim())
      : [];
    const translations = directTranslations.length === originalTexts.length && directTranslations.some(Boolean)
      ? directTranslations
      : splitGroupedTranslation(group?.translation || "", originalTexts);
    targetGroup.cueIndexes.forEach((cueIndex, cueOffset) => {
      const currentCue = nextSubtitles[cueIndex];
      if (!currentCue) {
        return;
      }

      nextSubtitles[cueIndex] = {
        ...currentCue,
        translation: translations[cueOffset] || currentCue.translation || ""
      };
    });
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
    const cueChunk = baseSubtitles.slice(startIndex, startIndex + TRANSLATION_CHUNK_SIZE).map((cue) => ({
      start: cue.start,
      end: cue.end,
      text: cue.text,
      translation: cue.translation || ""
    }));
    const translatedPayload = await translateCueChunk(cueChunk, {
      targetLanguage: requestedLanguage,
      sourceLanguage: "en",
      provider: requestedProvider
    });
    if (requestId !== state.transcriptRequestId || videoId !== state.currentVideoId) {
      return;
    }

    const mergedSubtitles = mergeSubtitleTranslations(state.subtitles, translatedPayload.subtitles || []);
    const hasMoreChunks = chunkIndex < totalChunks - 1;
    state.translationPending = hasMoreChunks;
    updateSubtitleTranslations(
      mergedSubtitles,
      hasMoreChunks
        ? `${basePayload.trackLabel} を読み込みました。句読点ごとに翻訳中です... ${Math.min(startIndex + TRANSLATION_CHUNK_SIZE, translationGroups.length)}/${translationGroups.length}`
        : buildTranscriptStatus({ ...basePayload, subtitles: mergedSubtitles }, requestedLanguage)
    );
  }
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
    const cueChunk = baseSubtitles.slice(startIndex, startIndex + TRANSLATION_CHUNK_SIZE).map((cue) => ({
      start: cue.start,
      end: cue.end,
      text: cue.text,
      translation: cue.translation || ""
    }));
    const translatedPayload = await translateCueChunk(cueChunk, {
      targetLanguage: requestedLanguage,
      sourceLanguage: "en",
      provider: requestedProvider
    });

    if (requestId !== state.transcriptRequestId || videoId !== state.currentVideoId) {
      return;
    }

    const mergedSubtitles = mergeSubtitleTranslations(state.subtitles, translatedPayload.subtitles || []);
    const hasMoreChunks = chunkIndex < totalChunks - 1;
    state.translationPending = hasMoreChunks;
    updateSubtitleTranslations(
      mergedSubtitles,
      hasMoreChunks
        ? `${basePayload.trackLabel} を読み込みました。翻訳中です... ${Math.min(startIndex + TRANSLATION_CHUNK_SIZE, baseSubtitles.length)}/${baseSubtitles.length}`
        : buildTranscriptStatus({ ...basePayload, subtitles: mergedSubtitles }, requestedLanguage)
    );
  }
}

async function loadChannelVideos(sort = state.channelVideosSort, source = null) {
  if (!elements.channelVideosList || !elements.channelVideosStatus) {
    return;
  }

  state.channelVideosSort = sort;
  state.channelVideosSource = source || {
    videoId: state.currentVideoId,
    channelId: state.selectedVideoMeta?.channelId || "",
    channelName: state.selectedVideoMeta?.channelName || ""
  };
  elements.channelVideosStatus.textContent = "チャンネル動画を読み込み中です...";
  const params = new URLSearchParams({ sort: String(sort || "latest") });
  if (state.channelVideosSource?.channelId) {
    params.set("channelId", state.channelVideosSource.channelId);
  } else {
    params.set("videoId", state.channelVideosSource?.videoId || state.currentVideoId || "");
  }
  if (state.channelVideosSource?.channelName) {
    params.set("channelName", state.channelVideosSource.channelName);
  }
  const payload = await fetchJson(`/api/channel-videos?${params.toString()}`);
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

    if (requestId !== state.transcriptRequestId || videoId !== state.currentVideoId) {
      return;
    }

    if (!countTranslatedSubtitles(state.subtitles) && requestedLanguage !== "en") {
      const fallbackPayload = await fetchTrackTranscript(videoId, trackIndex, {
        language: requestedLanguage,
        provider: requestedProvider
      });
      if (requestId !== state.transcriptRequestId || videoId !== state.currentVideoId) {
        return;
      }

      const mergedSubtitles = mergeSubtitleTranslations(state.subtitles, fallbackPayload.subtitles || []);
      state.translationPending = false;
      updateSubtitleTranslations(mergedSubtitles, buildTranscriptStatus({ ...payload, subtitles: mergedSubtitles }, requestedLanguage));
    }
  } catch (_error) {
    if (requestId !== state.transcriptRequestId || videoId !== state.currentVideoId) {
      return;
    }

    try {
      const fallbackPayload = await fetchTrackTranscript(videoId, trackIndex, {
        language: requestedLanguage,
        provider: requestedProvider
      });
      if (requestId !== state.transcriptRequestId || videoId !== state.currentVideoId) {
        return;
      }

      const mergedSubtitles = mergeSubtitleTranslations(state.subtitles, fallbackPayload.subtitles || []);
      state.translationPending = false;
      updateSubtitleTranslations(mergedSubtitles, buildTranscriptStatus({ ...payload, subtitles: mergedSubtitles }, requestedLanguage));
    } catch (_fallbackError) {
      state.translationPending = false;
      setSubtitleStatus(buildTranscriptStatus(payload, requestedLanguage, { translationFailed: true }));
    }
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
  renderFavoriteChannels();
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

  const transcriptPromise = state.autoFetch
    ? loadAutoTranscript(videoId, 0)
    : Promise.resolve();

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

  loadRecommendations(videoId).catch((error) => {
    elements.recommendationStatus.textContent = error.message || "おすすめ動画の取得に失敗しました。";
    renderEmptyState(elements.recommendations, "おすすめ動画を読み込めませんでした。");
  });
  if (state.activePopover === "channel-videos") {
    loadChannelVideos(state.channelVideosSort, {
      videoId,
      channelId: selectedItem.channelId || "",
      channelName: selectedItem.channelName || ""
    }).catch(() => {});
  }

  if (state.autoFetch) {
    try {
      await transcriptPromise;
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

elements.favoriteChannelsClose?.addEventListener("click", () => {
  setPopoverOpen("favorite-channels", false);
});

elements.historyClose?.addEventListener("click", () => {
  setPopoverOpen("history", false);
});

elements.channelVideosToggle?.addEventListener("click", () => {
  const shouldOpen = state.activePopover !== "channel-videos";
  setPopoverOpen("channel-videos", shouldOpen);
  if (shouldOpen) {
    openChannelVideos({
      videoId: state.currentVideoId,
      channelId: state.selectedVideoMeta?.channelId || "",
      channelName: state.selectedVideoMeta?.channelName || ""
    }, elements.channelSort?.value || state.channelVideosSort).catch((error) => {
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
    loadChannelVideos(state.channelVideosSort, state.channelVideosSource).catch((error) => {
      elements.channelVideosStatus.textContent = error.message || "チャンネル動画の取得に失敗しました。";
      renderEmptyState(elements.channelVideosList, "チャンネル動画を読み込めませんでした。");
    });
  }
});

elements.toggleFavoriteChannel?.addEventListener("click", () => {
  toggleFavoriteCurrentChannel().catch(() => {});
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
      || elements.favoriteChannelsPanel?.contains(target)
      || elements.savedLinesPanel?.contains(target)
      || elements.wordsPanel?.contains(target);
    const clickedToggle = elements.settingsToggle?.contains(target)
      || elements.favoritesToggle?.contains(target)
      || elements.channelVideosToggle?.contains(target)
      || elements.toggleFavoriteChannel?.contains(target)
      || elements.navHistory?.contains(target)
      || elements.navWords?.contains(target)
      || elements.navChannelFavorites?.contains(target)
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

elements.pipToggle?.addEventListener("click", () => {
  togglePictureInPicture();
});

elements.transcriptVisibilityToggle?.addEventListener("click", () => {
  cycleTranscriptVisibilityMode();
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

elements.navChannelFavorites?.addEventListener("click", () => {
  setPopoverOpen("favorite-channels", state.activePopover !== "favorite-channels");
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

function updatePipButton() {
  return;
}

async function togglePictureInPicture() {
  return;
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
  if (state.heargapOpen) {
    renderHearGapSheet();
  }

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
applyTranscriptVisibility(state.transcriptTextMode);
elements.currentCueTime.textContent = "00:00 - 00:00";
updateTransportUI();
syncViewportHeight();
applyDeviceLayout();
window.addEventListener("resize", syncViewportHeight);
window.addEventListener("resize", applyDeviceLayout);
window.visualViewport?.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("scroll", syncViewportHeight);
window.visualViewport?.addEventListener("resize", applyDeviceLayout);
document.addEventListener("focusin", syncKeyboardOpenState);
document.addEventListener("focusout", () => {
  window.setTimeout(syncKeyboardOpenState, 0);
});
enableDirectTextInput(elements.urlInput);
enableDirectTextInput(elements.searchQuery);
closeAllPopovers();
renderFavorites();
renderFavoriteChannels();
renderHistory();
renderSavedLines();
renderSavedWords();
updateSaveWordButton();
updateSaveCurrentLineButton();
updateRepeatButtons();
startInitialBootstrap();
elements.urlInput.value = `https://www.youtube.com/watch?v=${getInitialVideoMeta().videoId || DEFAULT_VIDEO_ID}`;
elements.searchQuery.value = "";
