# Use Node.js 18
FROM node:18-alpine

# Set working directory to /app/public
WORKDIR /app/public

# Copy package.json and install dependencies
COPY public/package*.json ./
RUN npm install --omit=dev

# Copy all files from public folder
COPY public .

# Expose port for Railway (8080)
EXPOSE 8080

# Start the bot
CMD ["npm", "start"]
