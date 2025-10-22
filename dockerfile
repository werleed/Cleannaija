# Use official Node.js 18 runtime
FROM node:18

# Create app directory
WORKDIR /app

# Copy package.json and package-lock if present
COPY package*.json ./

# Install app dependencies (production only)
RUN npm install --omit=dev

# Copy source
COPY . .

# Expose port if you later need (not required for polling bots)
# EXPOSE 8080

# Start the bot
CMD ["npm", "start"]
