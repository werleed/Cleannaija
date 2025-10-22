# Use official Node.js 18 runtime
FROM node:18

# Create app directory
WORKDIR /app

# Copy package.json and package-lock if present
COPY package*.json ./

# Install dependencies (production)
RUN npm install --omit=dev

# Copy all source code
COPY . .

# Expose port for keep-alive endpoint (Railway uses $PORT env)
EXPOSE 3000

# Start the bot
CMD ["npm", "start"]
