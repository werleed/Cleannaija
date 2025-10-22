# ---- Base Node Image ----
FROM node:18-alpine

# ---- App Directory ----
WORKDIR /app

# ---- Copy Dependencies ----
COPY package*.json ./

# ---- Install Production Dependencies ----
RUN npm install --omit=dev

# ---- Copy Source ----
COPY . .

# ---- Expose Port ----
EXPOSE 3000

# ---- Start the Bot ----
CMD ["npm", "start"]
