FROM node:18-alpine

WORKDIR /app

COPY package.json .
RUN npm install

COPY server.js .

# Create data directory for SQLite
RUN mkdir -p /data

EXPOSE 3456

CMD ["node", "server.js"]
