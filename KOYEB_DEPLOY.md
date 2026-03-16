# Deploy To Koyeb

This project can be deployed to Koyeb directly from GitHub using the existing `Dockerfile`.

## Before You Start

1. Push this repository to GitHub.
2. Make sure the repository root contains `Dockerfile`.

## Koyeb Dashboard Steps

1. Open the Koyeb dashboard.
2. Click `Create Web Service`.
3. Choose `GitHub`.
4. Select this repository and branch.
5. In build options, choose `Dockerfile`.
6. Keep the default start command from the Dockerfile.
7. Set the exposed HTTP port to `7860` if Koyeb asks for it explicitly.
8. Deploy.

## Runtime Settings

The app already listens on:

- `HOST=0.0.0.0`
- `PORT=7860`

If Koyeb injects a different `PORT`, the server will use it automatically because `server.js` reads `process.env.PORT`.

## Optional Environment Variables

- `YT_DLP_BIN=yt-dlp`
- `DEEPL_API_KEY=...`
- `CAPTION_WORKER_URL=...`
- `YT_DLP_COOKIES=...`
- `YT_DLP_COOKIES_BASE64=...`
- `YT_DLP_COOKIES_PATH=/app/secrets/youtube-cookies.txt`

You usually do not need to set `YT_DLP_BIN` on Koyeb if the Dockerfile is used as-is.

If Koyeb logs show `Sign in to confirm you're not a bot`, export your YouTube cookies in Netscape format and set one of these:

- `YT_DLP_COOKIES`: raw cookie file contents
- `YT_DLP_COOKIES_BASE64`: base64-encoded cookie file contents
- `YT_DLP_COOKIES_PATH`: path to a mounted cookie file

On Koyeb, the most reliable option is usually:

1. Open the `Files` tab in environment settings.
2. Upload `cookies.txt` there.
3. Mount it at a path like `/app/secrets/youtube-cookies.txt`.
4. Set `YT_DLP_COOKIES_PATH=/app/secrets/youtube-cookies.txt`.

## Expected Behavior

On Koyeb, subtitle fetching now tries `yt-dlp` first. If that fails, it falls back to the older YouTube fetch logic already in the app.

## Logs To Check

If subtitle fetching fails, look for these runtime logs:

- `yt-dlp subtitle lookup failed`
- `yt-dlp audio fallback failed`
- `youtubei track lookup failed`
- `ytdl caption fallback failed`

If `yt-dlp` works, you should stop seeing the old `youtubei 400` / `ytdl 410` path as the main failure mode.
