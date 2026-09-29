FROM node:24-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN groupmod -g 996 node && usermod -u 996 -g 996 node
USER node

CMD [ "node", "server.js" ]
