# Cloudflare Worker

`cloudflare-worker.js` is a subtitle-only endpoint for YouTube English captions.

## Deploy

1. Open Cloudflare Workers.
2. Create a new Worker.
3. Replace the default code with the contents of `cloudflare-worker.js`.
4. Deploy.

## Test

Open:

```text
https://YOUR-WORKER.workers.dev/?id=gLdgEYAxJ8A
```

If it works, it returns JSON like:

```json
{
  "videoId": "gLdgEYAxJ8A",
  "trackLabel": "English / worker",
  "subtitles": [
    { "start": 0, "end": 2.4, "text": "Hello" }
  ]
}
```

## Connect To Render

Set this environment variable on Render:

```text
CAPTION_WORKER_URL=https://YOUR-WORKER.workers.dev/
```

The existing `/api/transcript` route will automatically use the Worker as a fallback.
