//! The seed phrase lives in the operating system keychain: Keychain Services on
//! macOS, Credential Manager on Windows, Secret Service on Linux. It is never
//! written to the app's own files.

use keyring::Entry;

const SERVICE: &str = "xyz.unpair.desktop";
const USER: &str = "seed-phrase";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, USER).map_err(|e| format!("keychain: {e}"))
}

/// The stored phrase, or `None` when no wallet has been created on this device.
pub fn load_phrase() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain: {e}")),
    }
}

pub fn store_phrase(phrase: &str) -> Result<(), String> {
    entry()?
        .set_password(phrase)
        .map_err(|e| format!("keychain: {e}"))
}

#[allow(dead_code)]
pub fn delete_phrase() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain: {e}")),
    }
}
