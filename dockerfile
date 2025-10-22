# Use official Node.js 18 runtime
FROM node:18

# Create app directory
WORKDIR /app

# Copy package.json and package-lock if exists
COPY package*.json ./

# Install dependencies (production)
RUN npm install --omit=dev

# Copy all source code
COPY . .

# Expose port for health checks
EXPOSE 8080

# Start the bot
CMD ["npm", "start"]
