# Use Node.js 18 LTS
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package metadata first (to leverage Docker cache)
COPY public/package*.json ./

# Install dependencies (production)
RUN npm install --omit=dev

# Copy app source (assumes your project files are in public/)
COPY public .

# Ensure data and uploads folders exist (optional, done at runtime too)
RUN mkdir -p data uploads

# Expose port for Railway health checks
EXPOSE 8080

# Start the bot
CMD ["npm", "start"]
