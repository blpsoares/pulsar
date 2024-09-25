FROM oven/bun:alpine

WORKDIR /app

COPY . /app/

RUN apk add --no-cache curl bash unzip mongodb-tools

RUN bun install

VOLUME [ "/data/temp-export" ]

CMD ["tail", "-f", "/dev/null"]