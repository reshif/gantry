# Production Keycloak for Gantry: an optimized build (no augmentation at boot) for Postgres, served under /idp, with
# health and metrics on the management port. The root filesystem can then be read-only (deploy/compose.prod.yml).
#   docker build -f deploy/keycloak/Dockerfile -t gantry-keycloak:<version> .
ARG KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.4.7@sha256:9409c59bdfb65dbffa20b11e6f18b8abb9281d480c7ca402f51ed3d5977e6007

FROM ${KEYCLOAK_IMAGE} AS build
ENV KC_DB=postgres \
    KC_HTTP_RELATIVE_PATH=/idp \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM ${KEYCLOAK_IMAGE}
COPY --from=build /opt/keycloak/ /opt/keycloak/
USER 1000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
