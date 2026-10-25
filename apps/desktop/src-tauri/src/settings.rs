//! Small non-secret settings next to the wallet database.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Settings {
    /// The user has confirmed that the phrase is written down.
    pub backed_up: bool,
    /// Block height the wallet was created or restored at.
    pub birthday_height: Option<u32>,
    /// `main` or `test`.
    #[serde(default = "default_network")]
    pub network: String,
}

fn default_network() -> String {
    "main".into()
}

fn file(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

pub fn load(dir: &Path) -> Result<Settings, String> {
    match std::fs::read(file(dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("settings: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings {
            network: default_network(),
            ..Default::default()
        }),
        Err(e) => Err(format!("settings: {e}")),
    }
}

pub fn save(dir: &Path, s: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("settings: {e}"))?;
    let bytes = serde_json::to_vec_pretty(s).map_err(|e| format!("settings: {e}"))?;
    std::fs::write(file(dir), bytes).map_err(|e| format!("settings: {e}"))
}
