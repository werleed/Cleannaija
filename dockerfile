# ---------- Base image ----------
FROM node:18-alpine

# ---------- Working directory ----------
WORKDIR /app

# ---------- Copy package files first ----------
COPY package*.json ./

# ---------- Install dependencies ----------
# Use --omit=dev for production and include node-fetch@2 for compatibility
RUN npm install --omit=dev && npm install node-fetch@2

# ---------- Copy all source code ----------
COPY . .

# ---------- Environment setup ----------
ENV NODE_ENV=production
ENV PORT=8080

# ---------- Expose port ----------
EXPOSE 8080

# ---------- Health check ----------
# Railway uses this to verify your container is healthy.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

# ---------- Prevent duplicate bot instances ----------
# Create a lock file check before starting bot.js
CMD ["/bin/sh", "-c", "if [ -f /tmp/bot.lock ]; then echo 'Bot already running, exiting...'; exit 0; else touch /tmp/bot.lock && node bot.js; fi"]
