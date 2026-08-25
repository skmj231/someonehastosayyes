FROM node:22
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --build-from-source=false || npm install --omit=dev
COPY server.js landing.html ./
ENV PORT=3000 DB_PATH=/data/approvals.db
EXPOSE 3000
CMD ["node", "server.js"]
