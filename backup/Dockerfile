FROM alpine:3.19

RUN apk add --no-cache bash postgresql-client tar gzip tzdata

WORKDIR /app

COPY backup/backup-loop.sh /app/backup-loop.sh
COPY backup.sh /app/backup.sh

RUN chmod +x /app/backup-loop.sh /app/backup.sh

ENTRYPOINT ["/app/backup-loop.sh"]
