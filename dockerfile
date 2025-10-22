# Use Node.js 18 LTS
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy dependency files from your 'public' folder
COPY public/package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy all project files
COPY public .

# Expose port for Railway health check
EXPOSE 8080

# Start the bot
CMD ["npm", "start"]
