# Use Node.js 18 LTS (Alpine for smaller image)
FROM node:18-alpine

# Create app dir and set permissions
WORKDIR /app

# Copy package files from public folder (your project is in public/ on GitHub)
COPY public/package*.json ./

# Install production deps only
RUN npm ci --only=production

# Copy everything from public into container
COPY public/ .

# Expose port (Railway health checks expect 8080 by default)
EXPOSE 8080

# Start
CMD ["npm", "start"]
