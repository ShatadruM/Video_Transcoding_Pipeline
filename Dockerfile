FROM node:18-alpine

# 1. Install FFmpeg
RUN apk add --no-cache ffmpeg

# 2. Set working directory
WORKDIR /app

# 3. Install dependencies
COPY package*.json ./
RUN npm install

# 4. Copy source code
COPY . .

# 5. Start the worker
CMD ["npm", "start"]