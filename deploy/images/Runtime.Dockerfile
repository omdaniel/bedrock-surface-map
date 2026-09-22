FROM scratch
ARG APPLICATION_COMMIT
ARG COMMON_SHA256
ARG RELEASE_SHA256
LABEL org.opencontainers.image.source="https://github.com/omdaniel/bedrock-surface-map" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision=$APPLICATION_COMMIT \
      dev.bedrock-surface-map.common-sha256=$COMMON_SHA256 \
      dev.bedrock-surface-map.release-sha256=$RELEASE_SHA256
COPY runtime/ /opt/bedrock-map/
USER 65532:65532
WORKDIR /opt/bedrock-map
STOPSIGNAL SIGTERM
CMD ["/opt/bedrock-map/bedrock-map", "--help"]
