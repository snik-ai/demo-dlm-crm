FROM node:20-alpine
RUN apk add --no-cache python3 make g++ ca-certificates
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p public/screenshots
EXPOSE 3001
CMD ["node", "server.js"]
