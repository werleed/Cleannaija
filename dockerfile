# Use Node.js 18 LTS
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy dependencies
COPY public/package*.json ./
RUN npm install --omit=dev

# Copy all code
COPY public .

# Expose port for Railway health checks
EXPOSE 8080

# Start the bot
CMD ["npm", "start"]
