FROM node:18-alpine

# Create app dir
WORKDIR /app

# copy package information and install dependencies first (cache)
COPY package.json package-lock.json* ./

RUN apk add --no-cache --virtual .gyp python3 make g++ \
 && npm ci --production \
 && apk del .gyp

# copy app
COPY . .

# ensure data directory exists
RUN mkdir -p /app/data

# port for health check (match code)
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]
