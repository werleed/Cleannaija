# Use official lightweight Node.js image
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package files first to leverage layer caching
COPY package.json package-lock.json* ./

# Install deps (no dev dependencies)
RUN npm ci --omit=dev

# Copy rest of the app
COPY . .

# Create data dir (persisted by container)
RUN mkdir -p /app/data && chown -R node:node /app/data

# Use non-root user
USER node

# Expose health port if needed (telegram uses outgoing)
EXPOSE 8080

# Start command
CMD ["node", "bot.js"]
