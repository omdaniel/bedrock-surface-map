FROM caddy:2.11.4-alpine@sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e
# Low ports are enabled only inside this container's network namespace.
# Remove the inherited executable capability before dropping all capabilities.
RUN setcap -r /usr/bin/caddy
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
