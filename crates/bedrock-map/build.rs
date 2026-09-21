use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=BEDROCK_MAP_BUILD_COMMIT");
    let commit = env::var("BEDROCK_MAP_BUILD_COMMIT").unwrap_or_else(|_| "source".into());
    println!("cargo:rustc-env=BEDROCK_MAP_BUILD_COMMIT={commit}");
}
