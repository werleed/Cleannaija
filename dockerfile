# Dockerfile
FROM node:18

# Create app directory
WORKDIR /app

# copy package files first (cache layer)
COPY package.json package-lock.json* ./

# install dependencies (production)
RUN npm ci --omit=dev || npm install --omit=dev

# copy rest of the app
COPY . .

# ensure directories exist
RUN mkdir -p /app/data /app/uploads && touch /app/data/users.json

# expose nothing needed; use Railway env for start
CMD ["npm", "start"]
