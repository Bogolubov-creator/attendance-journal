FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
# Серверные скрипты доступа: первый код администратора и снятие режима личных паролей.
COPY --chown=node:node scripts/invite-admin.mjs scripts/allow-shared-password.mjs ./scripts/
USER node
EXPOSE 3100
CMD ["node", "src/server.js"]
