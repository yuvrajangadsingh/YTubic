//! Durable, race-free persistence for the two auth files: `accounts.json`
//! and each account's `accounts/<id>/cookies.enc`.
//!
//! Both used to be written with a bare `fs::write`, which truncates the
//! destination first. That is two separate bugs:
//!
//!   * A reader can see the half-written file. A torn `cookies.enc` reads
//!     back as "signed out" with no way home but a re-login, and a torn
//!     `accounts.json` degrades to an EMPTY index that the next sign-in
//!     then commits over the top of, taking every other account row with
//!     it.
//!   * Nothing orders the write against the rename, so a machine crash can
//!     leave a directory entry pointing at content that never landed.
//!
//! So: unique temp, write, fsync the file, rename, fsync the parent
//! directory. POSIX treats an atomic directory operation and a durable one
//! as separate guarantees, and only the second survives a power cut.
//!
//! The temp name is unique and created with `O_EXCL` on purpose. A fixed
//! `<name>.tmp` lets two writers share one inode: one can truncate it while
//! the other is syncing, and a descriptor opened before the rename keeps
//! writing into the file after it has become the destination.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Distinguishes concurrent writes from the same process; the pid
/// distinguishes them across processes (a second instance racing startup).
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Suffix every temp carries, so a crashed run's leftovers are recognizable
/// to [`sweep_stale_temps`] and never mistaken for a real jar.
const TEMP_SUFFIX: &str = ".ytubic-tmp";

fn temp_path(path: &Path) -> PathBuf {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("auth-file");
    path.with_file_name(format!("{name}.{}.{seq}{TEMP_SUFFIX}", std::process::id()))
}

/// Plain `fsync`, not `File::sync_all`: on macOS std asks for `F_FULLFSYNC`,
/// a device cache flush that costs milliseconds and would run on every
/// rotated cookie. What this needs is the bytes ordered ahead of the rename,
/// not survival of a power cut mid-rotation.
#[cfg(unix)]
fn sync_file(file: &std::fs::File) -> std::io::Result<()> {
    use std::os::unix::io::AsRawFd;
    // SAFETY: the fd is owned by `file` and stays open for the call.
    if unsafe { libc::fsync(file.as_raw_fd()) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn sync_dir(dir: &Path) -> std::io::Result<()> {
    let handle = std::fs::File::open(dir)?;
    sync_file(&handle)
}

/// Replace `path` with `bytes`, atomically and durably.
///
/// `mode` is the unix permission the temp is CREATED with, before a single
/// byte is written — the yt-dlp export is plaintext session cookies, and a
/// chmod that lands after the write leaves them world-readable in between.
///
/// Any failure leaves the previous file exactly as it was. Callers must not
/// translate that into "signed out": the old session is still on disk.
pub async fn write_atomic(path: PathBuf, bytes: Vec<u8>, mode: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || write_atomic_blocking(&path, &bytes, mode))
        .await
        .map_err(|e| format!("write task: {e}"))?
}

pub(crate) fn write_atomic_blocking(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    use std::io::Write;

    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let mut collisions = 0_u8;
    loop {
        let tmp = temp_path(path);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(mode);
        }
        let mut file = match opts.open(&tmp) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && collisions < 8 => {
                collisions += 1;
                continue;
            }
            Err(e) => return Err(format!("create temp beside {}: {e}", path.display())),
        };

        let written = file.write_all(bytes).and_then(|()| sync_file(&file));
        drop(file);
        if let Err(e) = written {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("write {}: {e}", tmp.display()));
        }
        if let Err(e) = std::fs::rename(&tmp, path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("swap in {}: {e}", path.display()));
        }
        // After the rename: it is the new directory entry that has to
        // survive, and it only exists once the rename has been made.
        return sync_dir(dir).map_err(|e| format!("sync {}: {e}", dir.display()));
    }
}

/// Delete temp files a crashed run left behind in `dir` (non-recursive).
///
/// Only ones older than an hour, so a write in flight in another process is
/// never pulled out from under it. A leftover temp is inert either way — it
/// is nothing's destination — this just stops them accumulating.
pub async fn sweep_stale_temps(dir: &Path) {
    const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(3600);
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(TEMP_SUFFIX))
        {
            continue;
        }
        let old = tokio::fs::metadata(&path)
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age > STALE_AFTER);
        if old {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
}

/// Serializes every mutation of the auth state.
///
/// Atomic replacement alone is not enough: five code paths write an
/// account's jar (the keeper snapshot, a response's `Set-Cookie` merge,
/// login completion, the dedup copy and the re-login copy) and seven do a
/// read-modify-write of `accounts.json`. Without a lock two of them can
/// simply lose each other's update, torn write or not.
///
/// LOCK ORDER: the index lock may be held while an account lock is taken
/// (dedup and the re-login copy both do). Never the other way round.
#[derive(Default)]
pub struct MutationLocks {
    accounts: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    index: tokio::sync::Mutex<()>,
}

impl MutationLocks {
    /// Exclusive access to one account's jar. Different accounts never wait
    /// on each other.
    pub async fn account(&self, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut map = self
                .accounts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            map.entry(id.to_string()).or_default().clone()
        };
        lock.lock_owned().await
    }

    /// Exclusive access to `accounts.json` for a read-modify-write.
    pub async fn index(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.index.lock().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ytubic-authfs-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn replaces_the_file_and_leaves_no_temp_behind() {
        let dir = scratch("replace");
        let path = dir.join("cookies.enc");
        write_atomic_blocking(&path, b"first", 0o600).unwrap();
        write_atomic_blocking(&path, b"second", 0o600).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(TEMP_SUFFIX))
            .collect();
        assert!(leftovers.is_empty(), "temp files must not survive a write");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The plaintext yt-dlp jar must never exist world-readable, not even
    /// for the length of one write.
    #[cfg(unix)]
    #[test]
    fn creates_the_file_with_the_requested_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("mode");
        let path = dir.join("cookies.txt");
        write_atomic_blocking(&path, b"# Netscape HTTP Cookie File\n", 0o600).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "got {mode:o}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A failed write must not be able to destroy the session that is
    /// already on disk.
    #[test]
    fn a_failed_write_keeps_the_previous_file() {
        let dir = scratch("failure");
        let path = dir.join("accounts.json");
        write_atomic_blocking(&path, b"{\"active\":\"acct-1\"}", 0o600).unwrap();
        // A path whose parent is a FILE: create_dir_all fails, so the write
        // errors before it can touch anything.
        let blocked = path.join("nested").join("accounts.json");
        assert!(write_atomic_blocking(&blocked, b"{}", 0o600).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"active\":\"acct-1\"}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn temp_names_do_not_repeat() {
        let path = PathBuf::from("/tmp/cookies.enc");
        let a = temp_path(&path);
        let b = temp_path(&path);
        assert_ne!(a, b);
        assert_eq!(a.parent(), path.parent(), "temp must be a sibling");
    }
}
