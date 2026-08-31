FROM node:22
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js landing.html trust.html status.html relay.html approval-flow-motion.html admin-console.html admin-console.js admin-app.js ./
COPY examples ./examples
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/approvals.db
EXPOSE 3000
CMD ["node", "server.js"]
