FROM python:3.11-bookworm AS yt_dlp_stage

RUN mkdir -p /tmp && chmod 1777 /tmp \
  && pip install --no-cache-dir yt-dlp

FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7860
ENV YT_DLP_BIN=/usr/local/bin/yt-dlp
ENV LD_LIBRARY_PATH=/usr/local/lib
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app

COPY --from=yt_dlp_stage /usr/local/bin/python /usr/local/bin/python
COPY --from=yt_dlp_stage /usr/local/bin/python3 /usr/local/bin/python3
COPY --from=yt_dlp_stage /usr/local/bin/python3.11 /usr/local/bin/python3.11
COPY --from=yt_dlp_stage /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=yt_dlp_stage /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=yt_dlp_stage /usr/local/lib/libpython3.11.so.1.0 /usr/local/lib/libpython3.11.so.1.0
COPY --from=yt_dlp_stage /usr/local/lib/libpython3.so /usr/local/lib/libpython3.so
COPY --from=yt_dlp_stage /usr/lib/x86_64-linux-gnu/libssl.so.3 /usr/lib/x86_64-linux-gnu/libssl.so.3
COPY --from=yt_dlp_stage /usr/lib/x86_64-linux-gnu/libcrypto.so.3 /usr/lib/x86_64-linux-gnu/libcrypto.so.3
COPY --from=yt_dlp_stage /etc/ssl/certs /etc/ssl/certs
COPY --from=yt_dlp_stage /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=yt_dlp_stage /usr/local/share/ca-certificates /usr/local/share/ca-certificates

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 7860

CMD ["npm", "start"]
