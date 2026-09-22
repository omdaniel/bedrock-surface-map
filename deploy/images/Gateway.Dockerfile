FROM caddy:2.11.2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d
ARG APPLICATION_COMMIT
ARG COMMON_SHA256
ARG RELEASE_SHA256
LABEL org.opencontainers.image.source="https://github.com/omdaniel/bedrock-surface-map" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision=$APPLICATION_COMMIT \
      dev.bedrock-surface-map.common-sha256=$COMMON_SHA256 \
      dev.bedrock-surface-map.release-sha256=$RELEASE_SHA256
COPY gateway/ /opt/bedrock-map/
USER 65532:65532
WORKDIR /opt/bedrock-map
STOPSIGNAL SIGTERM
CMD ["caddy", "run", "--config", "/etc/bedrock-map/Caddyfile", "--adapter", "caddyfile"]
