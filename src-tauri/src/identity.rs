//! One-time migration off the upstream bundle identifier.
//!
//! The fork ran under the original author's id (`com.github.ivasy.ytubic`)
//! long after it stopped tracking upstream, and the identifier names
//! everything the OS keeps for the app: the data/cache/log directories,
//! the WKWebView website data (localStorage, so the queue and every
//! zustand-persisted store), the preferences plist and the keychain
//! item. Renaming the identifier without this module would present a
//! factory-reset app: signed out, empty queue, cold caches.
//!
//! `migrate` runs as the first line of setup, before anything opens
//! those paths, and renames each old-id location to its new-id sibling
//! when the new one does not exist yet. Every pair shares a parent
//! directory, so each rename is a single atomic volume operation; a
//! partially-migrated install keeps whichever side exists and only
//! fills the gaps. Report lines come back to the caller because the
//! log redirect isn't up yet when this runs.
//!
//! The keychain item is migrated separately in
//! `keyring_encryption_key`, the one place that reads it.

use std::path::PathBuf;

use tauri::Manager;

/// The upstream identifier every pre-rename install used.
pub const OLD_ID: &str = "com.github.ivasy.ytubic";

pub fn migrate(app: &tauri::AppHandle) -> Vec<String> {
    let paths = app.path();
    let mut pairs: Vec<(PathBuf, PathBuf)> = Vec::new();

    // Directories tauri derives from the identifier. Several resolve to
    // the same place (config == data on macOS); the dedup folds them.
    let derived = [
        paths.app_data_dir().ok(),
        paths.app_local_data_dir().ok(),
        paths.app_config_dir().ok(),
        paths.app_cache_dir().ok(),
        paths.app_log_dir().ok(),
    ];
    for new in derived.into_iter().flatten() {
        if let Some(parent) = new.parent() {
            pairs.push((parent.join(OLD_ID), new.clone()));
        }
    }

    // macOS keeps more per-identifier state than the derived five: the
    // WKWebView website-data store and network storage, the defaults
    // plist, and the window-restoration state.
    //
    // Granularity matters. macOS pre-creates `Library/WebKit/<id>/` and
    // `Library/Caches/<id>/` for the NEW identifier during process
    // startup, before this runs — measured 2026-08-31 15:39: both
    // existed by setup time, so a directory-level pair tripped the
    // never-overwrite guard and stranded the localStorage (queue,
    // settings, the refresh keeper's session). The real payload is one
    // level down (`WebsiteData`), which nothing creates until a webview
    // stores something, so pair at that level. HTTPStorages is a flat
    // FILE named `<id>.binarycookies`, not a directory.
    #[cfg(target_os = "macos")]
    if let Ok(home) = paths.home_dir() {
        let id = app.config().identifier.clone();
        pairs.push((
            home.join("Library/WebKit").join(OLD_ID).join("WebsiteData"),
            home.join("Library/WebKit").join(&id).join("WebsiteData"),
        ));
        pairs.push((
            home.join("Library/HTTPStorages")
                .join(format!("{OLD_ID}.binarycookies")),
            home.join("Library/HTTPStorages")
                .join(format!("{id}.binarycookies")),
        ));
        pairs.push((
            home.join("Library/Preferences")
                .join(format!("{OLD_ID}.plist")),
            home.join("Library/Preferences").join(format!("{id}.plist")),
        ));
        pairs.push((
            home.join("Library/Saved Application State")
                .join(format!("{OLD_ID}.savedState")),
            home.join("Library/Saved Application State")
                .join(format!("{id}.savedState")),
        ));
    }

    pairs.sort();
    pairs.dedup();
    migrate_pairs(&pairs)
}

fn migrate_pairs(pairs: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut report = Vec::new();
    for (old, new) in pairs {
        if old == new || !old.exists() {
            continue;
        }
        if new.exists() {
            report.push(format!(
                "both {old:?} and {new:?} exist; left the old one untouched"
            ));
            continue;
        }
        // The WebsiteData pair sits one level inside a directory macOS
        // may not have created yet on a genuinely fresh machine.
        if let Some(parent) = new.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::rename(old, new) {
            Ok(()) => report.push(format!("migrated {old:?} -> {new:?}")),
            Err(e) => report.push(format!("could not migrate {old:?}: {e}")),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ytubic-identity-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn old_moves_when_new_is_missing() {
        let root = scratch("move");
        let old = root.join(OLD_ID);
        let new = root.join("com.example.new");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("marker"), "x").unwrap();

        let report = migrate_pairs(&[(old.clone(), new.clone())]);
        assert!(!old.exists());
        assert!(new.join("marker").exists());
        assert_eq!(report.len(), 1);
    }

    #[test]
    fn existing_new_is_never_overwritten() {
        let root = scratch("keep");
        let old = root.join(OLD_ID);
        let new = root.join("com.example.new");
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&new).unwrap();
        std::fs::write(new.join("marker"), "keep").unwrap();

        migrate_pairs(&[(old.clone(), new.clone())]);
        assert!(old.exists());
        assert_eq!(std::fs::read_to_string(new.join("marker")).unwrap(), "keep");
    }

    #[test]
    fn destination_parent_is_created_when_missing() {
        let root = scratch("parent");
        let old = root.join(OLD_ID).join("WebsiteData");
        let new = root.join("com.example.new").join("WebsiteData");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("marker"), "x").unwrap();

        migrate_pairs(&[(old.clone(), new.clone())]);
        assert!(new.join("marker").exists());
    }

    #[test]
    fn missing_old_is_a_silent_no_op() {
        let root = scratch("noop");
        let report = migrate_pairs(&[(root.join(OLD_ID), root.join("com.example.new"))]);
        assert!(report.is_empty());
    }
}
