# ---------- Base image ----------
FROM node:18-alpine

# ---------- App setup ----------
WORKDIR /app
COPY package*.json ./

# Install production deps (and node-fetch for keep-alive)
RUN npm install --omit=dev && npm install node-fetch@2

COPY . .

# ---------- Runtime configuration ----------
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# ---------- Health check ----------
# Railway will ping this to verify your container is alive
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s \
  CMD wget -qO- http://localhost:8080/health || exit 1

# ---------- Start command ----------
CMD ["npm", "start"]
