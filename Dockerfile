FROM oven/bun:alpine

USER root

WORKDIR /app

COPY . /app/

RUN apk add --no-cache curl bash nano mongodb-tools

RUN bun install
RUN bun bin
RUN cp /app/dist/pulsar /usr/local/bin/pulsar && chmod +x /usr/local/bin/pulsar

CMD ["tail", "-f", "/dev/null"]
