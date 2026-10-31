FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache ffmpeg font-dejavu openssh-client
ENV XDG_CACHE_HOME=/tmp/tellybox-cache
RUN npm ci --omit=dev
COPY *.mjs ./
COPY public ./public
COPY homelab ./homelab
RUN mkdir /config && chown node:node /config
ENV HOMELAB_DATA=/config SETUP_BIND=0.0.0.0
USER node
EXPOSE 8082 8083 8990
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8082/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "homelab/launch.mjs"]
