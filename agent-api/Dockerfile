FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
EXPOSE 3000
CMD ["node", "src/server.js"]
