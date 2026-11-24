//! intervals.icu API key, stored in the macOS Keychain and nowhere else.
//!
//! The key goes in from the webview but never comes back out: the UI can only
//! ask whether one exists. Sync reads it on the Rust side, with
//! `intervals_key`, and sends it to intervals.icu from there (`net`).

use keyring::{Entry, Error};

use crate::trace;

const SERVICE: &str = "com.brianokarski.wetware";
const ACCOUNT: &str = "intervals.icu-api-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

/// For Rust-side callers only. Not a Tauri command on purpose.
pub fn intervals_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn intervals_key_set(key: String) -> Result<(), String> {
    trace("intervals_key_set");
    let key = key.trim();
    if key.is_empty() {
        return Err("API key is empty".into());
    }
    entry()?.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn intervals_key_exists() -> Result<bool, String> {
    trace("intervals_key_exists");
    Ok(intervals_key()?.is_some())
}

#[tauri::command]
pub fn intervals_key_delete() -> Result<(), String> {
    trace("intervals_key_delete");
    match entry()?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
