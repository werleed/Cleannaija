# Use official Node.js 18 runtime
FROM node:18

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json if present
COPY package*.json ./

# Install dependencies (production)
RUN npm install --omit=dev

# Copy all source code
COPY . .

# Ensure data folders exist (redundant because the bot will create them, but okay)
RUN mkdir -p /app/data /app/data/uploads

# Start the bot
CMD ["npm", "start"]
