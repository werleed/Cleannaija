# Use Node 18 LTS (alpine)
FROM node:18-alpine

# set workdir
WORKDIR /app

# Install minimal build deps for some npm packages if necessary
# jimp and these deps usually work without extra packages but we include them quietly
RUN apk add --no-cache bash build-base

# Copy package files and install
COPY package.json package-lock.json* ./
RUN npm install --no-optional --production

# Copy app
COPY . .

# Create data dir
RUN mkdir -p /app/data
VOLUME [ "/app/data" ]

# Expose port used by Railway/Health checks
EXPOSE 8080

# start
CMD ["npm", "start"]
