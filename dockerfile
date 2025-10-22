# Use Node.js 18 LTS
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package.json and package-lock if present
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application code
COPY . .

# Ensure data dir exists
RUN mkdir -p data

# Expose port for health checks and admin UI
EXPOSE 8080

# Default env (can be overridden in Railway)
ENV PORT=8080

# Start
CMD ["npm", "start"]
