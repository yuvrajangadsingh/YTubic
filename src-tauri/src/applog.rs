//! Always-on, timestamped app log.
//!
//! Every diagnostic in this codebase is an `eprintln!` (fifty-odd in
//! lib.rs alone). That is fine when the app is launched from a terminal
//! with stderr captured, and useless the way it is actually used: opened
//! from the Dock, where stderr goes nowhere. Every playback failure
//! investigated in Aug 2026 depended on someone having relaunched the app
//! from a shell first, and one that happened on a Dock-launched instance
//! could not be diagnosed at all.
//!
//! Rather than touch every call site, this redirects fd 2 itself: a pipe
//! is spliced onto stderr, and a thread drains it line by line into
//! `~/Library/Logs/YTubic/ytubic.log` (the platform log dir), prefixing
//! each line with a local timestamp. The timestamp matters on its own:
//! the raw stream log has none, and adjacent lines were once misread as
//! a causal sequence when minutes separated them.
//!
//! Rotation is a single rename at ~5MB so the file cannot grow without
//! bound. Debug builds keep stderr on the terminal, where `tauri dev`
//! wants it. Unix only.

#[cfg(not(debug_assertions))]
pub fn init(app: &tauri::AppHandle) {
    use std::fs::{self, OpenOptions};
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::io::FromRawFd;
    use tauri::Manager;

    const ROTATE_AT: u64 = 5 * 1024 * 1024;

    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("ytubic.log");
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > ROTATE_AT {
            let _ = fs::rename(&path, dir.join("ytubic.log.1"));
        }
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };

    let mut fds = [0i32; 2];
    // SAFETY: plain libc pipe/dup2 on file descriptors this process owns.
    // fd 2 is replaced with the pipe's write end; the original stderr is
    // deliberately not kept, since in the Dock-launched case it points at
    // nothing anyway.
    unsafe {
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return;
        }
        if libc::dup2(fds[1], 2) < 0 {
            return;
        }
        libc::close(fds[1]);
    }
    // SAFETY: fds[0] is the read end we just created and own exclusively.
    let reader = unsafe { std::fs::File::from_raw_fd(fds[0]) };

    let _ = writeln!(
        file,
        "{} ==== launch pid={} ====",
        now(),
        std::process::id()
    );
    std::thread::Builder::new()
        .name("applog".into())
        .spawn(move || {
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                let _ = writeln!(file, "{} {}", now(), line);
                let _ = file.flush();
            }
        })
        .ok();
}

#[cfg(debug_assertions)]
pub fn init(_app: &tauri::AppHandle) {}

#[cfg(not(debug_assertions))]
fn now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    // Local time via libc so the log reads in the user's clock, not UTC.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let t: libc::time_t = secs as libc::time_t;
    // SAFETY: localtime_r writes into the tm we own.
    unsafe { libc::localtime_r(&t, &mut tm) };
    format!(
        "{:02}:{:02}:{:02}",
        tm.tm_hour, tm.tm_min, tm.tm_sec
    )
}
