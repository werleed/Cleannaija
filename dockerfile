# Use a lightweight Node.js image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first (for better build caching)
COPY package*.json ./

# Install dependencies — includes node-fetch@2 for require() support
RUN npm install && npm install node-fetch@2

# Copy all project files
COPY . .

# Expose the bot's web server port
EXPOSE 8080

# Set environment variables (optional defaults)
ENV NODE_ENV=production
ENV PORT=8080

# Start the bot
CMD ["npm", "start"]
