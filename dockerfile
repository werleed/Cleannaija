# Use official Node.js 18 runtime
FROM node:18

# Create app directory
WORKDIR /app

# Copy package files and install production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Expose port (webhook mode)
EXPOSE 8080

# Start the bot
CMD ["npm", "start"]
