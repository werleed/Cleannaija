# --- Stage 1: Base Image ---
FROM node:20-alpine AS base

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies first (for better caching)
COPY package*.json ./
RUN npm install --production

# Copy the rest of your bot files
COPY . .

# Expose the port your Express keep-alive server uses
EXPOSE 8080

# Define environment variables (these will be overwritten by Railway or your .env)
ENV NODE_ENV=production

# --- Stage 2: Run Bot ---
CMD ["npm", "start"]
