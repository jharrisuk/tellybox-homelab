FROM node:24-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& install -d -m 700 -o node -g node /data
WORKDIR /app
COPY server/dispatcharr-player.mjs server/vod-player.mjs server/catchup-player.mjs server/playback-profile.mjs server/subtitle-choice.mjs server/vod-captions.mjs /app/server/
COPY server/relay-media/protocol.mjs server/relay-media/keys.mjs /app/server/relay-media/
COPY relay/worker /app/relay/worker
USER node
ENV RELAY_DATA_DIR=/data
EXPOSE 18086 18087
ENTRYPOINT ["node", "/app/relay/worker/index.mjs"]
