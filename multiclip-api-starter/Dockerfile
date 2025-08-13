# Node + ffmpeg + yt-dlp 설치 컨테이너
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     python3 python3-pip ffmpeg ca-certificates curl \
  && pip3 install --no-cache-dir yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev || npm i --omit=dev
COPY . .

ENV PORT=10000 NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
