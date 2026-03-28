FROM python:3.11-slim AS yt_dlp_stage

RUN pip install --no-cache-dir yt-dlp

FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7860
ENV YT_DLP_BIN=/usr/local/bin/yt-dlp
ENV LD_LIBRARY_PATH=/usr/local/lib

WORKDIR /app

COPY --from=yt_dlp_stage /usr/local/bin/python /usr/local/bin/python
COPY --from=yt_dlp_stage /usr/local/bin/python3 /usr/local/bin/python3
COPY --from=yt_dlp_stage /usr/local/bin/python3.11 /usr/local/bin/python3.11
COPY --from=yt_dlp_stage /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=yt_dlp_stage /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=yt_dlp_stage /usr/local/lib/libpython3.11.so.1.0 /usr/local/lib/libpython3.11.so.1.0
COPY --from=yt_dlp_stage /usr/local/lib/libpython3.so /usr/local/lib/libpython3.so

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 7860

CMD ["npm", "start"]
