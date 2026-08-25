FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js landing.html ./
ENV PORT=3000 DB_PATH=/data/approvals.db
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
