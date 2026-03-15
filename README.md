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

# Trancy

YouTube subtitle learning player optimized for iPhone Safari.

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
