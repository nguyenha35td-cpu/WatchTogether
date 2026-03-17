FROM node:20-bookworm-slim

# Install ffmpeg for subtitle extraction from remote MKV files
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com && npm install --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
