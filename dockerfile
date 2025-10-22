# --- Clean9ja Bot Dockerfile ---
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first for caching
COPY package*.json ./

# Install all dependencies (including dev, then prune dev)
RUN npm install && npm prune --omit=dev

# Copy the rest of the application
COPY . .

# Set environment to production
ENV NODE_ENV=production

# Expose port for Express
EXPOSE 8080

# Start the bot (only one instance)
CMD ["npm", "start"]
