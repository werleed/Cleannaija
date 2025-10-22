# Use official Node.js 18 runtime
FROM node:18

# Create app directory
WORKDIR /app

# Copy package.json and package-lock if present
COPY package*.json ./

# Install dependencies (production only)
RUN npm install --omit=dev

# Copy all source code
COPY . .

# Create runtime dirs
RUN mkdir -p /app/data /app/uploads

# Start the bot
CMD ["npm", "start"]
