//! File access scoped to the data folder.
//!
//! Every path the webview sends is relative to the data folder. It is resolved
//! to where it really is on disk, following symlinks, and refused if that is
//! anywhere outside the real data folder. This is strict on purpose: a link
//! inside the folder that points out of it can't be read, written or listed.
//!
//! Morning pages are private (SPEC §2). What is created under `pages/`, the
//! folder itself included, is readable and writable by the owner alone.

use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, ErrorKind, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub type Result<T> = std::result::Result<T, String>;

const OUTSIDE: &str = "Path must stay inside the data folder";
/// The folder morning pages are kept in.
const PRIVATE_DIR: &str = "pages";
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

/// Whether a data-folder-relative path is inside `pages/`: a file created
/// there is for its owner alone. The name is matched whatever its case, as
/// the file system matches it.
fn is_private(rel: &str) -> Result<bool> {
    let parts = parts(rel)?;
    Ok(parts.len() > 1 && parts[0].to_str().is_some_and(|first| first.eq_ignore_ascii_case(PRIVATE_DIR)))
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
    // A link back to the data folder itself names nothing inside it.
    if path == real_root {
        return Err(OUTSIDE.into());
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
    let private = is_private(rel)?;
    fs::create_dir_all(root).map_err(err)?;
    let root = real_root(root)?.ok_or("The data folder is missing")?;
    write_atomic_with(&resolve(&root, rel)?, contents.as_bytes(), private, unique_suffix)
}

/// Takes a file away, but only if it holds exactly `expected`: the webview
/// says what it has just read there, and a file that holds anything else is
/// left alone. A file that isn't there is already gone. A folder, and a file
/// marked read-only, are refused.
pub fn remove(root: &Path, rel: &str, expected: &str) -> Result<()> {
    parts(rel)?;
    let Some(root) = real_root(root)? else {
        return Ok(());
    };
    let path = resolve(&root, rel)?;
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let held = match fs::metadata(&path) {
        Ok(held) => held,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(err(e)),
    };
    if !held.is_file() {
        return Err(format!("{name} is not a file, so it was not removed"));
    }
    if held.permissions().readonly() {
        return Err(format!("{name} is read-only, so it was not removed"));
    }
    // What it holds is compared and never reported: not in the refusal, not anywhere.
    if fs::read(&path).map_err(err)? != expected.as_bytes() {
        return Err(format!("{name} has changed, so it was not removed"));
    }
    fs::remove_file(&path).map_err(err)?;
    if let Some(dir) = path.parent().and_then(|dir| File::open(dir).ok()) {
        let _ = dir.sync_all();
    }
    Ok(())
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

/// A folder for the file being written, if it isn't there yet. One made to
/// hold private files can be opened by its owner alone. A folder that is
/// already there is left as it is.
fn create_dir(dir: &Path, private: bool) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Create a new, empty temp file next to the file being written. `create_new`
/// fails if anything already has the name, link or not, so an existing file is
/// never overwritten and a link is never followed. A private file is the
/// owner's alone from the moment it exists, before a byte is written to it.
fn create_temp(
    dir: &Path,
    name: &OsStr,
    private: bool,
    mut suffix: impl FnMut() -> String,
) -> io::Result<(File, PathBuf)> {
    for _ in 0..TEMP_ATTEMPTS {
        let mut temp_name = OsString::from(".");
        temp_name.push(name);
        temp_name.push(format!(".{}.tmp", suffix()));
        let temp = dir.join(temp_name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temp) {
            Ok(file) => return Ok((file, temp)),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(ErrorKind::AlreadyExists, "Could not create a temporary file"))
}

/// Write via a temp file and rename, so neither a crash nor a second write can
/// leave a half-written file. The temp file has a name of its own, is flushed
/// to disk before the rename, and is removed if anything fails. Replacing a
/// file keeps its permissions; its extended attributes (Finder tags) are not
/// carried over.
pub fn write_atomic(path: &Path, contents: &[u8]) -> Result<()> {
    write_atomic_with(path, contents, false, unique_suffix)
}

/// `private`: a file this creates, and a folder it has to make for it, are
/// for the owner alone. A file that is already there keeps the permissions
/// it has, as any file does.
fn write_atomic_with(path: &Path, contents: &[u8], private: bool, suffix: impl FnMut() -> String) -> Result<()> {
    let dir = path.parent().ok_or("Path has no parent folder")?;
    let name = path.file_name().ok_or("Path has no file name")?;
    create_dir(dir, private).map_err(err)?;

    // The new file takes the place of the old one, so it keeps the old one's
    // permissions. A file marked read-only is left alone: renaming over it
    // would work, and would quietly undo the lock.
    let permissions = match fs::metadata(path) {
        Ok(existing) if existing.permissions().readonly() => {
            return Err(format!("{} is read-only, so it was not changed", name.to_string_lossy()));
        }
        Ok(existing) if existing.is_file() => Some(existing.permissions()),
        _ => None,
    };

    let (mut file, temp) = create_temp(dir, name, private, suffix).map_err(err)?;
    let written = file
        .write_all(contents)
        .and_then(|()| permissions.map_or(Ok(()), |p| file.set_permissions(p)))
        .and_then(|()| file.sync_all());
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
        write_atomic_with(&s.data.join("habits.yaml"), b"seed", false, || suffixes.next().unwrap().into()).unwrap();

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
        assert!(write_atomic_with(&s.data.join("habits.yaml"), b"x", false, || "same".into()).is_err());
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
        // One distinct character per writer, so a file holding anything but
        // 4096 copies of a single one of them was pieced together from two writes.
        let writers: Vec<String> = ('a'..='p').map(|c| c.to_string().repeat(4096)).collect();
        let threads: Vec<_> = writers
            .iter()
            .map(|contents| {
                let (root, contents) = (s.data.clone(), contents.clone());
                std::thread::spawn(move || write(&root, "habits.yaml", &contents))
            })
            .collect();
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        let text = fs::read_to_string(s.data.join("habits.yaml")).unwrap();
        assert!(writers.contains(&text), "a half-written file");
        assert_eq!(Scratch::names(&s.data), ["habits.yaml"]);
    }

    #[test]
    fn a_link_to_the_data_folder_itself_is_refused_before_anything_is_written() {
        let s = Scratch::new("selflink");
        symlink(&s.data, s.data.join("self")).unwrap();
        symlink(".", s.data.join("dot")).unwrap();
        for rel in ["self", "dot", "self/self", "self/dot"] {
            assert_eq!(write(&s.data, rel, "x").unwrap_err(), OUTSIDE, "write {rel:?}");
            assert_eq!(read(&s.data, rel).unwrap_err(), OUTSIDE, "read {rel:?}");
            assert_eq!(list(&s.data, rel).unwrap_err(), OUTSIDE, "list {rel:?}");
        }
        // Through the link and on to a real file is still inside, and still works.
        write(&s.data, "self/habits.yaml", "x").unwrap();
        assert_eq!(read(&s.data, "habits.yaml").unwrap().as_deref(), Some("x"));
        assert_eq!(Scratch::names(&s.base), ["data", "outside"]);
        assert_eq!(Scratch::names(&s.data), ["dot", "habits.yaml", "self"]);
    }

    #[test]
    fn replacing_a_file_keeps_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("mode");
        let mode = |name: &str| fs::metadata(s.data.join(name)).unwrap().permissions().mode() & 0o7777;
        fs::create_dir(s.data.join("pages")).unwrap();
        for (name, bits) in [("pages/private.md", 0o600), ("shared.md", 0o664), ("script.md", 0o755)] {
            fs::write(s.data.join(name), "old").unwrap();
            fs::set_permissions(s.data.join(name), fs::Permissions::from_mode(bits)).unwrap();
            write(&s.data, name, "new").unwrap();
            assert_eq!(fs::read_to_string(s.data.join(name)).unwrap(), "new");
            assert_eq!(mode(name), bits, "{name}");
        }
        // A new file gets the usual permissions, whatever its neighbours have.
        fs::write(s.data.join("usual.md"), "x").unwrap();
        write(&s.data, "fresh.md", "x").unwrap();
        assert_eq!(mode("fresh.md"), mode("usual.md"));
        assert_eq!(mode("fresh.md") & 0o600, 0o600);
    }

    #[test]
    fn what_is_created_under_pages_is_for_the_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("private");
        let mode = |name: &str| fs::metadata(s.data.join(name)).unwrap().permissions().mode() & 0o7777;
        // What this process gives a file and a folder it makes with no instructions.
        fs::write(s.data.join("usual.md"), "x").unwrap();
        fs::create_dir(s.data.join("usual")).unwrap();

        write(&s.data, "pages/2026-11-17.md", "private").unwrap();
        assert_eq!(mode("pages/2026-11-17.md"), 0o600);
        assert_eq!(mode("pages"), 0o700);
        // Written again, it is still the owner's alone, and no temp file is left beside it.
        write(&s.data, "pages/2026-11-17.md", "private, again").unwrap();
        assert_eq!(mode("pages/2026-11-17.md"), 0o600);
        assert_eq!(fs::read_to_string(s.data.join("pages/2026-11-17.md")).unwrap(), "private, again");
        assert_eq!(Scratch::names(&s.data.join("pages")), ["2026-11-17.md"]);
        // A folder below it, too.
        write(&s.data, "pages/2026/11-18.md", "private").unwrap();
        assert_eq!((mode("pages/2026"), mode("pages/2026/11-18.md")), (0o700, 0o600));

        // Everything else is created as it always was: day files, a file that is merely named `pages`.
        write(&s.data, "days/2026-11-17.md", "shared").unwrap();
        write(&s.data, "months/pages/2026-11.md", "shared").unwrap();
        assert_eq!((mode("days"), mode("days/2026-11-17.md")), (mode("usual"), mode("usual.md")));
        assert_eq!((mode("months/pages"), mode("months/pages/2026-11.md")), (mode("usual"), mode("usual.md")));
    }

    #[test]
    fn the_pages_folder_is_private_however_its_name_is_cased_or_reached() {
        use std::os::unix::fs::PermissionsExt;
        for rel in ["Pages/a.md", "PAGES/a.md", "pages/a.md"] {
            assert_eq!(is_private(rel), Ok(true), "{rel}");
        }
        for rel in ["pages", "pages.md", "days/pages/a.md", "pagesx/a.md", "days/2026-11-17.md"] {
            assert_eq!(is_private(rel), Ok(false), "{rel}");
        }
        assert!(is_private("").is_err());
        assert!(is_private("pages/../days/a.md").is_err());

        // A pages folder that was already there keeps its own permissions; a file created in it is still private.
        let s = Scratch::new("private-existing");
        let mode = |name: &str| fs::metadata(s.data.join(name)).unwrap().permissions().mode() & 0o7777;
        fs::create_dir(s.data.join("pages")).unwrap();
        fs::set_permissions(s.data.join("pages"), fs::Permissions::from_mode(0o755)).unwrap();
        write(&s.data, "pages/new.md", "private").unwrap();
        assert_eq!((mode("pages"), mode("pages/new.md")), (0o755, 0o600));
        // And a file that was already there, made by another app with permissions of its own, keeps them when it is replaced.
        fs::write(s.data.join("pages/theirs.md"), "old").unwrap();
        fs::set_permissions(s.data.join("pages/theirs.md"), fs::Permissions::from_mode(0o644)).unwrap();
        write(&s.data, "pages/theirs.md", "new").unwrap();
        assert_eq!(mode("pages/theirs.md"), 0o644);
        assert_eq!(mode("pages"), 0o755);
    }

    #[test]
    fn nothing_under_pages_is_ever_readable_by_anyone_else_even_while_it_is_being_written() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicBool, Ordering};
        let s = Scratch::new("private-watched");
        let pages = s.data.join("pages");
        write(&s.data, "pages/first.md", "x").unwrap();
        let done = std::sync::Arc::new(AtomicBool::new(false));
        // Someone else on the machine, looking at the folder as fast as they can for as long as the writes go on.
        let watcher = {
            let (pages, done) = (pages.clone(), done.clone());
            std::thread::spawn(move || {
                let mut seen = Vec::new();
                let mut looks = 0u64;
                while !done.load(Ordering::Relaxed) {
                    for entry in fs::read_dir(&pages).into_iter().flatten().flatten() {
                        if let Ok(held) = entry.metadata() {
                            let mode = held.permissions().mode() & 0o7777;
                            if mode & 0o077 != 0 {
                                seen.push(format!("{} {mode:o}", entry.file_name().to_string_lossy()));
                            }
                        }
                    }
                    looks += 1;
                }
                (seen, looks)
            })
        };
        // Long enough texts that the write itself takes a moment, to a few files, over and over.
        let text = "morning pages ".repeat(40_000);
        for round in 0..150 {
            write(&s.data, &format!("pages/day-{}.md", round % 5), &text).unwrap();
        }
        done.store(true, Ordering::Relaxed);
        let (seen, looks) = watcher.join().unwrap();
        assert!(looks > 100, "the watcher only looked {looks} times");
        assert!(seen.is_empty(), "readable by others at some moment: {:?}", &seen[..seen.len().min(5)]);
    }

    #[test]
    fn a_file_is_only_removed_if_it_holds_what_was_expected() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("remove");
        let stub = "---\ndate: 2026-11-17\n---\n";
        write(&s.data, "days/2026-11-17.md", stub).unwrap();
        write(&s.data, "days/2026-11-16.md", "---\ndate: 2026-11-16\nmood: 3\n---\n").unwrap();

        // Anything but exactly what is there, and it stays. The refusal names the file and quotes nothing.
        for expected in ["", "---\ndate: 2026-11-17\n---", "---\ndate: 2026-11-17\n---\n\n", "---\ndate: 2026-11-16\nmood: 3\n---\n"] {
            assert_eq!(remove(&s.data, "days/2026-11-17.md", expected), Err("2026-11-17.md has changed, so it was not removed".into()));
        }
        assert_eq!(read(&s.data, "days/2026-11-17.md").unwrap().as_deref(), Some(stub));
        // Exactly what is there, and it goes. Its neighbour and its folder stay.
        remove(&s.data, "days/2026-11-17.md", stub).unwrap();
        assert_eq!(Scratch::names(&s.data.join("days")), ["2026-11-16.md"]);
        // Already gone is gone: nothing to do, whatever was expected.
        remove(&s.data, "days/2026-11-17.md", stub).unwrap();
        remove(&s.data, "months/2026-11.md", "x").unwrap();

        // A folder is not a file, and a locked file is left locked.
        assert_eq!(remove(&s.data, "days", ""), Err("days is not a file, so it was not removed".into()));
        let locked = s.data.join("days/2026-11-16.md");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o444)).unwrap();
        assert_eq!(
            remove(&s.data, "days/2026-11-16.md", "---\ndate: 2026-11-16\nmood: 3\n---\n"),
            Err("2026-11-16.md is read-only, so it was not removed".into())
        );
        assert_eq!(Scratch::names(&s.data.join("days")), ["2026-11-16.md"]);
    }

    #[test]
    fn nothing_outside_the_data_folder_can_be_removed() {
        let s = Scratch::new("remove-outside");
        symlink(&s.outside, s.data.join("out")).unwrap();
        symlink(s.outside.join("secret.txt"), s.data.join("secret.md")).unwrap();
        for rel in ["../outside/secret.txt", "out/secret.txt", "secret.md", "", "/etc/hosts", "days/../../outside/secret.txt"] {
            assert_eq!(remove(&s.data, rel, "outside"), Err(OUTSIDE.into()), "{rel:?}");
        }
        assert_eq!(s.secret(), "outside");
        // A data folder that isn't there has nothing in it to remove.
        remove(&s.base.join("nowhere"), "days/a.md", "x").unwrap();
    }

    #[test]
    fn a_private_temp_file_is_private_before_anything_is_written_to_it() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("private-temp");
        let (file, temp) = create_temp(&s.data, OsStr::new("a.md"), true, unique_suffix).unwrap();
        assert_eq!(file.metadata().unwrap().permissions().mode() & 0o7777, 0o600);
        assert_eq!(file.metadata().unwrap().len(), 0);
        drop(file);
        fs::remove_file(temp).unwrap();
    }

    #[test]
    fn a_read_only_file_is_refused_not_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("readonly");
        let file = s.data.join("habits.yaml");
        fs::write(&file, "locked").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o444)).unwrap();

        let refusal = write(&s.data, "habits.yaml", "changed").unwrap_err();
        assert_eq!(refusal, "habits.yaml is read-only, so it was not changed");
        assert_eq!(fs::read_to_string(&file).unwrap(), "locked");
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o7777, 0o444);
        assert_eq!(Scratch::names(&s.data), ["habits.yaml"]);
        // It can still be read, and unlocking it makes it writable again.
        assert_eq!(read(&s.data, "habits.yaml").unwrap().as_deref(), Some("locked"));
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        write(&s.data, "habits.yaml", "changed").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "changed");
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
