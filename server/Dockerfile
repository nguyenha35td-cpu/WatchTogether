FROM node:20-bookworm-slim

WORKDIR /app

# Install ffmpeg for subtitle extraction from MKV files
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com && npm install --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
