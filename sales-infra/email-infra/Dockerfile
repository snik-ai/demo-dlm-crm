FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY inbound-poller.js .
CMD ["node", "inbound-poller.js"]
