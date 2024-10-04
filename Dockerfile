FROM oven/bun:alpine

WORKDIR /app

COPY . /app/

RUN apk add --no-cache curl bash mongodb-tools

RUN bun install
RUN bun link
RUN bun link pulsar

CMD ["tail", "-f", "/dev/null"]