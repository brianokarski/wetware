//! File access scoped to the data folder.
//!
//! Every path the webview sends is relative to the data folder. It is resolved
//! to where it really is on disk, following symlinks, and refused if that is
//! anywhere outside the real data folder. This is strict on purpose: a link
//! inside the folder that points out of it can't be read, written or listed.

use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, ErrorKind, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub type Result<T> = std::result::Result<T, String>;

const OUTSIDE: &str = "Path must stay inside the data folder";
const TEMP_ATTEMPTS: usize = 16;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// The parts of a data-folder-relative path. Empty paths, absolute paths,
/// `.` and `..` are refused.
fn parts(rel: &str) -> Result<Vec<&OsStr>> {
    let parts: Option<Vec<&OsStr>> = Path::new(rel)
        .components()
        .map(|c| match c {
            Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect();
    match parts {
        Some(parts) if !parts.is_empty() => Ok(parts),
        _ => Err(OUTSIDE.into()),
    }
}

/// Where the data folder really is, or `None` if it doesn't exist.
fn real_root(root: &Path) -> Result<Option<PathBuf>> {
    match fs::canonicalize(root) {
        Ok(real) => Ok(Some(real)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

/// Resolve `rel` under `real_root` (which must already be canonical) to its
/// real location. Each part that exists is followed to where it really is and
/// must still be inside the data folder; parts that don't exist yet are taken
/// as written.
fn resolve(real_root: &Path, rel: &str) -> Result<PathBuf> {
    let mut parts = parts(rel)?.into_iter();
    let mut path = real_root.to_path_buf();
    while let Some(part) = parts.next() {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                // A link that leads nowhere can't be shown to stay inside, so it is refused too.
                path = fs::canonicalize(&path).map_err(|e| match e.kind() {
                    ErrorKind::NotFound => OUTSIDE.to_string(),
                    _ => err(e),
                })?;
                if !path.starts_with(real_root) {
                    return Err(OUTSIDE.into());
                }
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {
                path.extend(parts);
                break;
            }
            Err(e) => return Err(err(e)),
        }
    }
    Ok(path)
}

/// `None` if the file (or the data folder) doesn't exist.
pub fn read(root: &Path, rel: &str) -> Result<Option<String>> {
    parts(rel)?;
    let Some(root) = real_root(root)? else {
        return Ok(None);
    };
    match fs::read_to_string(resolve(&root, rel)?) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

/// Creates the data folder and any parent folders as needed.
pub fn write(root: &Path, rel: &str, contents: &str) -> Result<()> {
    parts(rel)?;
    fs::create_dir_all(root).map_err(err)?;
    let root = real_root(root)?.ok_or("The data folder is missing")?;
    write_atomic(&resolve(&root, rel)?, contents.as_bytes())
}

/// Names of the files directly inside a folder, sorted. Hidden files, folders
/// and links that lead out of the data folder are left out.
pub fn list(root: &Path, rel: &str) -> Result<Vec<String>> {
    parts(rel)?;
    let Some(root) = real_root(root)? else {
        return Ok(vec![]);
    };
    let entries = match fs::read_dir(resolve(&root, rel)?) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(err(e)),
    };
    let mut names: Vec<String> = entries
        .filter_map(std::result::Result::ok)
        .filter(|entry| match entry.file_type() {
            Ok(kind) if kind.is_file() => true,
            Ok(kind) if kind.is_symlink() => fs::canonicalize(entry.path())
                .is_ok_and(|real| real.starts_with(&root) && real.is_file()),
            _ => false,
        })
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    Ok(names)
}

/// A suffix no other write is using: process, a counter, and the clock.
fn unique_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{}-{}-{nanos}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Create a new, empty temp file next to the file being written. `create_new`
/// fails if anything already has the name, link or not, so an existing file is
/// never overwritten and a link is never followed.
fn create_temp(
    dir: &Path,
    name: &OsStr,
    mut suffix: impl FnMut() -> String,
) -> io::Result<(File, PathBuf)> {
    for _ in 0..TEMP_ATTEMPTS {
        let mut temp_name = OsString::from(".");
        temp_name.push(name);
        temp_name.push(format!(".{}.tmp", suffix()));
        let temp = dir.join(temp_name);
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => return Ok((file, temp)),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(ErrorKind::AlreadyExists, "Could not create a temporary file"))
}

/// Write via a temp file and rename, so neither a crash nor a second write can
/// leave a half-written file. The temp file has a name of its own, is flushed
/// to disk before the rename, and is removed if anything fails.
pub fn write_atomic(path: &Path, contents: &[u8]) -> Result<()> {
    write_atomic_with(path, contents, unique_suffix)
}

fn write_atomic_with(path: &Path, contents: &[u8], suffix: impl FnMut() -> String) -> Result<()> {
    let dir = path.parent().ok_or("Path has no parent folder")?;
    let name = path.file_name().ok_or("Path has no file name")?;
    fs::create_dir_all(dir).map_err(err)?;

    let (mut file, temp) = create_temp(dir, name, suffix).map_err(err)?;
    let written = file.write_all(contents).and_then(|()| file.sync_all());
    drop(file);
    let renamed = written.and_then(|()| fs::rename(&temp, path));
    if renamed.is_err() {
        let _ = fs::remove_file(&temp);
    }
    renamed.map_err(err)?;

    // Make the rename itself durable. Not every filesystem lets a folder be synced.
    if let Ok(folder) = File::open(dir) {
        let _ = folder.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// A scratch folder holding `data/` (the data folder) and `outside/`.
    struct Scratch {
        base: PathBuf,
        data: PathBuf,
        outside: PathBuf,
    }

    impl Scratch {
        fn new(name: &str) -> Self {
            let base = std::env::temp_dir().join(format!("wetware-{name}-{}", unique_suffix()));
            let (data, outside) = (base.join("data"), base.join("outside"));
            fs::create_dir_all(&data).unwrap();
            fs::create_dir_all(&outside).unwrap();
            fs::write(outside.join("secret.txt"), "outside").unwrap();
            Scratch { base, data, outside }
        }

        fn secret(&self) -> String {
            fs::read_to_string(self.outside.join("secret.txt")).unwrap()
        }

        fn names(dir: &Path) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn reads_writes_and_lists_inside_the_data_folder() {
        let s = Scratch::new("basic");
        assert_eq!(read(&s.data, "days/2026-11-17.md").unwrap(), None);
        write(&s.data, "days/2026-11-17.md", "hello").unwrap();
        write(&s.data, "days/2026-11-17.md", "hello again").unwrap();
        write(&s.data, "habits.yaml", "habits: []\n").unwrap();
        assert_eq!(read(&s.data, "days/2026-11-17.md").unwrap().as_deref(), Some("hello again"));
        assert_eq!(list(&s.data, "days").unwrap(), ["2026-11-17.md"]);
        assert_eq!(list(&s.data, "months").unwrap(), Vec::<String>::new());
        // No temp files are left behind.
        assert_eq!(Scratch::names(&s.data), ["days", "habits.yaml"]);
        assert_eq!(Scratch::names(&s.data.join("days")), ["2026-11-17.md"]);
    }

    #[test]
    fn empty_paths_are_refused_and_write_nothing() {
        let s = Scratch::new("empty");
        for rel in ["", ".", "./"] {
            assert!(read(&s.data, rel).is_err(), "read {rel:?}");
            assert!(write(&s.data, rel, "x").is_err(), "write {rel:?}");
            assert!(list(&s.data, rel).is_err(), "list {rel:?}");
        }
        assert_eq!(Scratch::names(&s.base), ["data", "outside"]);
        assert_eq!(Scratch::names(&s.data), Vec::<String>::new());
    }

    #[test]
    fn paths_that_climb_out_are_refused() {
        let s = Scratch::new("climb");
        let absolute = s.outside.join("secret.txt");
        for rel in ["../outside/secret.txt", "days/../../outside/secret.txt", absolute.to_str().unwrap(), "./habits.yaml"] {
            assert!(read(&s.data, rel).is_err(), "read {rel:?}");
            assert!(write(&s.data, rel, "x").is_err(), "write {rel:?}");
            assert!(list(&s.data, rel).is_err(), "list {rel:?}");
        }
        assert_eq!(s.secret(), "outside");
        assert_eq!(Scratch::names(&s.outside), ["secret.txt"]);
    }

    #[test]
    fn a_symlinked_folder_pointing_outside_is_refused() {
        let s = Scratch::new("dirlink");
        symlink(&s.outside, s.data.join("days")).unwrap();
        assert!(read(&s.data, "days/secret.txt").is_err());
        assert!(write(&s.data, "days/new.md", "escaped").is_err());
        assert!(write(&s.data, "days/sub/new.md", "escaped").is_err());
        assert!(write(&s.data, "days/secret.txt", "escaped").is_err());
        assert!(list(&s.data, "days").is_err());
        assert_eq!(Scratch::names(&s.outside), ["secret.txt"]);
        assert_eq!(s.secret(), "outside");
    }

    #[test]
    fn a_symlinked_file_pointing_outside_is_refused() {
        let s = Scratch::new("filelink");
        symlink(s.outside.join("secret.txt"), s.data.join("habits.yaml")).unwrap();
        assert!(read(&s.data, "habits.yaml").is_err());
        assert!(write(&s.data, "habits.yaml", "escaped").is_err());
        assert_eq!(s.secret(), "outside");
        // The listing leaves it out rather than fail for the whole folder.
        fs::write(s.data.join("settings.yaml"), "").unwrap();
        fs::create_dir(s.data.join("sub")).unwrap();
        fs::write(s.data.join("sub/a.md"), "").unwrap();
        symlink(s.outside.join("secret.txt"), s.data.join("sub/b.md")).unwrap();
        assert_eq!(list(&s.data, "sub").unwrap(), ["a.md"]);
    }

    #[test]
    fn a_link_that_leads_nowhere_is_refused() {
        let s = Scratch::new("dangling");
        symlink(s.outside.join("not-there.md"), s.data.join("habits.yaml")).unwrap();
        assert!(read(&s.data, "habits.yaml").is_err());
        assert!(write(&s.data, "habits.yaml", "escaped").is_err());
        assert_eq!(Scratch::names(&s.outside), ["secret.txt"]);
    }

    #[test]
    fn links_that_stay_inside_work() {
        let s = Scratch::new("inside");
        fs::create_dir(s.data.join("real")).unwrap();
        fs::write(s.data.join("real/a.md"), "a").unwrap();
        symlink(s.data.join("real"), s.data.join("days")).unwrap();
        symlink(s.data.join("real/a.md"), s.data.join("alias.md")).unwrap();

        assert_eq!(read(&s.data, "days/a.md").unwrap().as_deref(), Some("a"));
        assert_eq!(list(&s.data, "days").unwrap(), ["a.md"]);
        write(&s.data, "days/b.md", "b").unwrap();
        assert_eq!(fs::read_to_string(s.data.join("real/b.md")).unwrap(), "b");
        // Writing through a file link changes the real file and keeps the link.
        write(&s.data, "alias.md", "changed").unwrap();
        assert_eq!(fs::read_to_string(s.data.join("real/a.md")).unwrap(), "changed");
        assert!(fs::symlink_metadata(s.data.join("alias.md")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn a_data_folder_reached_through_a_link_works() {
        let s = Scratch::new("rootlink");
        let linked = s.base.join("linked");
        symlink(&s.data, &linked).unwrap();
        write(&linked, "habits.yaml", "x").unwrap();
        assert_eq!(read(&linked, "habits.yaml").unwrap().as_deref(), Some("x"));
        assert_eq!(fs::read_to_string(s.data.join("habits.yaml")).unwrap(), "x");
    }

    #[test]
    fn a_missing_data_folder_reads_as_empty_and_is_created_on_write() {
        let s = Scratch::new("missing");
        let root = s.base.join("not-yet");
        assert_eq!(read(&root, "habits.yaml").unwrap(), None);
        assert_eq!(list(&root, "days").unwrap(), Vec::<String>::new());
        assert!(!root.exists());
        write(&root, "days/2026-11-17.md", "x").unwrap();
        assert_eq!(read(&root, "days/2026-11-17.md").unwrap().as_deref(), Some("x"));
    }

    #[test]
    fn an_existing_temp_file_that_is_a_symlink_is_never_followed() {
        let s = Scratch::new("templink");
        // The name the first write used to use, and the first name this write will try.
        symlink(s.outside.join("secret.txt"), s.data.join(".habits.yaml.tmp")).unwrap();
        symlink(s.outside.join("secret.txt"), s.data.join(".habits.yaml.a.tmp")).unwrap();
        fs::write(s.data.join(".habits.yaml.b.tmp"), "someone else's").unwrap();

        let mut suffixes = ["a", "b", "c"].into_iter();
        write_atomic_with(&s.data.join("habits.yaml"), b"seed", || suffixes.next().unwrap().into()).unwrap();

        assert_eq!(fs::read_to_string(s.data.join("habits.yaml")).unwrap(), "seed");
        assert_eq!(s.secret(), "outside");
        // Nothing that was already there was overwritten or removed.
        assert_eq!(fs::read_to_string(s.data.join(".habits.yaml.b.tmp")).unwrap(), "someone else's");
        assert_eq!(
            Scratch::names(&s.data),
            [".habits.yaml.a.tmp", ".habits.yaml.b.tmp", ".habits.yaml.tmp", "habits.yaml"]
        );
        // And through the public entry point, with real suffixes.
        write(&s.data, "habits.yaml", "again").unwrap();
        assert_eq!(s.secret(), "outside");
    }

    #[test]
    fn gives_up_when_every_temp_name_is_taken() {
        let s = Scratch::new("taken");
        fs::write(s.data.join(".habits.yaml.same.tmp"), "").unwrap();
        assert!(write_atomic_with(&s.data.join("habits.yaml"), b"x", || "same".into()).is_err());
        assert!(!s.data.join("habits.yaml").exists());
    }

    #[test]
    fn a_failed_write_leaves_nothing_behind() {
        let s = Scratch::new("failed");
        // The destination is a folder with something in it, so the rename fails.
        fs::create_dir_all(s.data.join("days/2026-11-17.md")).unwrap();
        fs::write(s.data.join("days/2026-11-17.md/keep"), "").unwrap();
        assert!(write(&s.data, "days/2026-11-17.md", "x").is_err());
        assert_eq!(Scratch::names(&s.data.join("days")), ["2026-11-17.md"]);
        assert_eq!(Scratch::names(&s.data.join("days/2026-11-17.md")), ["keep"]);
        // A parent that is a file, not a folder, fails before any temp file exists.
        fs::write(s.data.join("habits.yaml"), "h").unwrap();
        assert!(write(&s.data, "habits.yaml/x.md", "x").is_err());
        assert_eq!(Scratch::names(&s.data), ["days", "habits.yaml"]);
        assert_eq!(fs::read_to_string(s.data.join("habits.yaml")).unwrap(), "h");
    }

    #[test]
    fn writes_in_flight_together_each_use_their_own_temp_file() {
        let s = Scratch::new("together");
        let threads: Vec<_> = (0..16)
            .map(|i| {
                let root = s.data.clone();
                std::thread::spawn(move || write(&root, "habits.yaml", &format!("{i}").repeat(4096)))
            })
            .collect();
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        let text = fs::read_to_string(s.data.join("habits.yaml")).unwrap();
        assert_eq!(text.len() % 4096, 0);
        assert!(text.chars().all(|c| c == text.chars().next().unwrap()), "a half-written file");
        assert_eq!(Scratch::names(&s.data), ["habits.yaml"]);
    }

    #[test]
    fn listings_leave_out_hidden_files_and_folders() {
        let s = Scratch::new("list");
        fs::create_dir_all(s.data.join("days/sub")).unwrap();
        for name in ["b.md", "a.md", ".a.md.1-2-3.tmp", ".DS_Store"] {
            fs::write(s.data.join("days").join(name), "").unwrap();
        }
        assert_eq!(list(&s.data, "days").unwrap(), ["a.md", "b.md"]);
    }
}
