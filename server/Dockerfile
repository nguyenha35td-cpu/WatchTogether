FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com && npm ci --omit=dev

# Copy server code
COPY index.js ./

EXPOSE 3001

# Environment variables will be passed via docker run -e or --env-file
CMD ["node", "index.js"]
