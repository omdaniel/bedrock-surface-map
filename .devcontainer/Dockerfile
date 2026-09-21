FROM node:26.8.1-bookworm

ENV CARGO_HOME=/home/node/.cargo RUSTUP_HOME=/home/node/.rustup
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential clang cmake pkg-config \
    libssl-dev libclang-dev libvulkan1 mesa-vulkan-drivers \
    && rm -rf /var/lib/apt/lists/*
USER node
RUN curl --fail --location --silent --show-error https://sh.rustup.rs \
      -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain 1.92.0 \
    && rm /tmp/rustup-init.sh \
    && /home/node/.cargo/bin/rustup component add rustfmt clippy \
    && /home/node/.cargo/bin/rustup target add wasm32-unknown-unknown
ENV PATH=/home/node/.cargo/bin:${PATH}
