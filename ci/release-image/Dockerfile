ARG NODE_IMAGE
FROM ${NODE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/opt/cargo \
    RUSTUP_HOME=/opt/rustup \
    PATH=/opt/ziglang/bin:/opt/cargo/bin:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git tar gzip python3 python3-venv \
    build-essential clang cmake pkg-config libssl-dev libclang-dev \
    libvulkan1 mesa-vulkan-drivers xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --silent --show-error https://sh.rustup.rs \
      -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain 1.92.0 \
    && rm /tmp/rustup-init.sh \
    && rustup component add rustfmt clippy \
    && rustup target add wasm32-unknown-unknown \
      x86_64-unknown-linux-musl aarch64-unknown-linux-musl \
    && cargo install cargo-zigbuild --version 0.20.1 --locked \
    && cargo install wasm-bindgen-cli --version 0.2.127 --locked

RUN python3 -m venv /opt/ziglang \
    && /opt/ziglang/bin/pip install --no-cache-dir ziglang==0.15.2 \
    && python-zig version

WORKDIR /work
