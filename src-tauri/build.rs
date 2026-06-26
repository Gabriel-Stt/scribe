use std::path::PathBuf;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let sidecar_dir = PathBuf::from(&manifest_dir).join("../sidecars/parakeet_server");
    let sidecar_dir = sidecar_dir
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(&manifest_dir).join("../sidecars/parakeet_server"));
    println!("cargo:rustc-env=SIDECAR_DIR={}", sidecar_dir.display());
    tauri_build::build()
}
