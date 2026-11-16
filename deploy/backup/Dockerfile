# gantry-backup: pg_dump/pg_restore of the same Postgres major as the server, and mc for the object store.
#   docker build -f deploy/backup/Dockerfile -t gantry-backup:<version> .
ARG POSTGRES_IMAGE=postgres:17.12-alpine@sha256:d3244e8ce3f165ee3c93d9c4a4b1d0fe48b3a89e2287b717fdcbbde92d405065
ARG MINIO_IMAGE=pgsty/minio:RELEASE.2026-08-04T00-00-00Z@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372

FROM ${MINIO_IMAGE} AS minio

FROM ${POSTGRES_IMAGE}
# hadolint ignore=DL3018
RUN apk add --no-cache bash coreutils findutils
COPY --from=minio /usr/bin/mcli /usr/local/bin/mc
COPY deploy/backup/gantry-backup.sh /usr/local/bin/gantry-backup.sh
USER 70:70
ENTRYPOINT ["/usr/local/bin/gantry-backup.sh"]
CMD ["schedule"]
