FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src
RUN npm install
RUN npm run build

EXPOSE 25 2525 587 80

CMD ["npm", "start"]
