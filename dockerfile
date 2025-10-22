# Use official Node.js 18 runtime
FROM node:18

# Create app directory
WORKDIR /app

# Copy package.json & package-lock if present
COPY package*.json ./

# Install dependencies (without dev)
RUN npm install --omit=dev

# Copy app source
COPY . .

# Ensure data directories exist and permissions ok
RUN mkdir -p /app/data /app/uploads && \
    chown -R node:node /app

USER node

# Start the bot
CMD ["npm", "start"]
