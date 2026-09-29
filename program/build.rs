use std::{env, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let key = manifest.join("../zk-v2-artifacts/verification_key.json");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    groth16_solana::vk::circom::generate_vk_file(&key, &out, "verifying_key.rs").unwrap();
    println!("cargo:rerun-if-changed={}", key.display());
}
