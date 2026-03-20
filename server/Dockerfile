FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com && npm install --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
