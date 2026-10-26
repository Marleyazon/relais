FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY relay.js ./
ENV HOST=0.0.0.0
USER node
CMD ["node", "relay.js"]
