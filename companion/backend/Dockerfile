FROM node:20-alpine

WORKDIR /app

# Install build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --production

COPY . .

# DB will be stored in /app/data (mounted volume)
RUN mkdir -p /app/data

ENV NODE_ENV=production

EXPOSE 3001
CMD ["node", "server.js"]
