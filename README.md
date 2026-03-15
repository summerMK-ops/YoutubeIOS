---
title: Trancy
emoji: "📺"
colorFrom: indigo
colorTo: gray
sdk: docker
app_port: 7860
fullWidth: true
header: mini
short_description: YouTube subtitle learning player for iPhone Safari
---

# EnglishIOS

YouTube subtitle learning player optimized for iPhone Safari.

## Render + Worker

Render alone is often blocked by YouTube for subtitle access. This repo supports using a Cloudflare Worker as a subtitle-only proxy.

1. Deploy [cloudflare-worker.js](/C:/Users/bkiqq/OneDrive/デスクトップ/YoutubeIOS/cloudflare-worker.js) to Cloudflare Workers.
2. Set `CAPTION_WORKER_URL=https://YOUR-WORKER.workers.dev/` on Render.
3. Redeploy Render.

Details are in [CLOUDFLARE_WORKER.md](/C:/Users/bkiqq/OneDrive/デスクトップ/YoutubeIOS/CLOUDFLARE_WORKER.md).

## Fly.io + yt-dlp

This repository now prefers `yt-dlp` for subtitle and audio extraction when it is available. The included [Dockerfile](/C:/Users/bkiqq/OneDrive/デスクトップ/YoutubeIOS/Dockerfile) installs both `yt-dlp` and `ffmpeg`, which makes it a better fit for Fly.io than Render.

Deploying on Fly.io means:

1. Build with the included Dockerfile.
2. Expose port `7860`.
3. Start with `npm start`.

## Koyeb

Koyeb is a good fit for this repository because it can build the existing Dockerfile directly from GitHub.

1. Push the repo to GitHub.
2. In Koyeb, create a `Web Service`.
3. Choose `GitHub` as the source.
4. Choose `Dockerfile` as the build method.
5. Deploy the app.

Detailed steps are in [KOYEB_DEPLOY.md](/C:/Users/bkiqq/OneDrive/デスクトップ/YoutubeIOS/KOYEB_DEPLOY.md).

If Koyeb logs show `Sign in to confirm you're not a bot`, set `YT_DLP_COOKIES` or `YT_DLP_COOKIES_BASE64` in the Koyeb environment.

## Hugging Face Spaces

This repository is prepared for a Docker Space.

### Required files

- `README.md` with the YAML block above
- `Dockerfile`
- `manifest.webmanifest`
- `sw.js`

### Runtime

The app listens on:

- `HOST=0.0.0.0`
- `PORT=7860`

## Deploy to Hugging Face Spaces

1. Create a new Space on Hugging Face.
2. Choose `Docker` as the SDK.
3. Push this repository to the Space repo.
4. Wait for the Docker build to finish.

## Local Run

```powershell
npm start
```

Open `http://localhost:3000`.
