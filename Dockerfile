FROM node:18-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY public ./public
COPY .env.example ./

EXPOSE 8787

CMD ["npm", "start"]
