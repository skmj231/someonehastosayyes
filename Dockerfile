FROM node:22
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js landing.html approval-flow-motion.html ./
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/approvals.db
EXPOSE 3000
CMD ["node", "server.js"]
