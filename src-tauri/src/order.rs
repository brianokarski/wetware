//! Order at the door.
//!
//! Two things here keep what the webview asks for in the order it asked:
//!
//! - `Turns`: writes to one file land one at a time, in the order they
//!   reached the shell. A write that is slow to land holds up the ones behind
//!   it for the same file and no others, and a later write can never land
//!   before an earlier one, or be written over by it.
//! - `Leaving`: a window asked to close, or an app asked to quit, is held
//!   until the webview says that what was typed is on disk, or a short limit
//!   passes. Quitting is never held for longer than that.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Condvar, Mutex, MutexGuard},
    time::Duration,
};

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic elsewhere while the lock was held leaves the bookkeeping as it was, which is still good.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Where one file's line stands: the next ticket to hand out, and the one whose turn it is.
#[derive(Default)]
struct Line {
    next: u64,
    serving: u64,
}

/// Work on one file, one piece at a time, in the order it was asked for.
#[derive(Default)]
pub struct Turns {
    lines: Mutex<HashMap<PathBuf, Line>>,
    moved: Condvar,
}

/// Ends a turn when it goes out of scope, however the work ended.
struct Done<'a> {
    turns: &'a Turns,
    path: &'a Path,
}

impl Drop for Done<'_> {
    fn drop(&mut self) {
        let mut lines = locked(&self.turns.lines);
        if let Some(line) = lines.get_mut(self.path) {
            line.serving += 1;
            // Nobody is waiting: the line is forgotten, so the map holds only files being written now.
            if line.serving == line.next {
                lines.remove(self.path);
            }
        }
        drop(lines);
        self.turns.moved.notify_all();
    }
}

impl Turns {
    /// Runs `work` for `path` once everything asked for that path before it
    /// has finished. The place in line is taken the moment this is called.
    pub fn in_turn<T>(&self, path: &Path, work: impl FnOnce() -> T) -> T {
        let mut lines = locked(&self.lines);
        let line = lines.entry(path.to_path_buf()).or_default();
        let ticket = line.next;
        line.next += 1;
        while lines.get(path).is_some_and(|line| line.serving != ticket) {
            lines = self.moved.wait(lines).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        drop(lines);
        let _done = Done { turns: self, path };
        work()
    }

    /// How many pieces of work for `path` have been asked for and not finished.
    #[cfg(test)]
    pub fn in_line(&self, path: &Path) -> u64 {
        locked(&self.lines).get(path).map_or(0, |line| line.next - line.serving)
    }

    /// How many files have work asked for and not finished.
    #[cfg(test)]
    pub fn files(&self) -> usize {
        locked(&self.lines).len()
    }
}

/// Where the app stands on closing.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Leave {
    /// Nothing has asked it to close.
    #[default]
    Staying,
    /// The webview has been asked to save what was typed, and hasn't answered.
    Asked,
    /// It has answered, and the one waiting has not yet woken to it.
    Answered,
    /// The wait is over, one way or the other. From here a close goes through.
    Going,
}

/// What to do with a request to close.
#[derive(Debug, PartialEq)]
pub enum Request {
    /// The first: hold it, ask the webview to save, and wait.
    Ask,
    /// One is already held and waiting: hold this one too, and ask nothing.
    Wait,
    /// The wait is over: let it through.
    Go,
}

/// A close held until the webview has saved what was typed.
#[derive(Default)]
pub struct Leaving {
    state: Mutex<Leave>,
    answered: Condvar,
}

impl Leaving {
    /// A window was asked to close, or the app to quit.
    pub fn request(&self) -> Request {
        let mut state = locked(&self.state);
        match *state {
            Leave::Staying => {
                *state = Leave::Asked;
                Request::Ask
            }
            Leave::Asked | Leave::Answered => Request::Wait,
            Leave::Going => Request::Go,
        }
    }

    /// The webview says everything is saved. Only an answer to a question that was asked counts.
    pub fn answer(&self) {
        let mut state = locked(&self.state);
        if *state == Leave::Asked {
            *state = Leave::Answered;
            self.answered.notify_all();
        }
    }

    /// Waits for the answer, for `limit` at most. Says whether it came. Either way the wait is over.
    pub fn wait(&self, limit: Duration) -> bool {
        let state = locked(&self.state);
        let (mut state, _) = self
            .answered
            .wait_timeout_while(state, limit, |state| *state == Leave::Asked)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let answered = *state == Leave::Answered;
        *state = Leave::Going;
        answered
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{mpsc, Arc},
        thread,
        time::Instant,
    };

    /// Waits until `count` pieces of work are in line for `path`.
    fn until_in_line(turns: &Turns, path: &Path, count: u64) {
        let began = Instant::now();
        while turns.in_line(path) != count {
            assert!(began.elapsed() < Duration::from_secs(5), "never saw {count} in line for {path:?}");
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn work_on_one_file_runs_in_the_order_it_was_asked_for_however_long_the_first_takes() {
        let turns = Arc::new(Turns::default());
        let path = Path::new("/data/pages/2026-11-17.md");
        let landed = Arc::new(Mutex::new(Vec::new()));
        let (release, held) = mpsc::channel::<()>();

        // The first is stuck: it has its turn and does not finish.
        let stuck = {
            let (turns, landed) = (turns.clone(), landed.clone());
            thread::spawn(move || {
                turns.in_turn(path, || {
                    held.recv().unwrap();
                    landed.lock().unwrap().push("first");
                })
            })
        };
        until_in_line(&turns, path, 1);
        // Two more are asked for behind it, one after the other.
        let mut later = Vec::new();
        for (i, name) in ["second", "third"].into_iter().enumerate() {
            let (theirs, landed) = (turns.clone(), landed.clone());
            later.push(thread::spawn(move || theirs.in_turn(path, || landed.lock().unwrap().push(name))));
            until_in_line(&turns, path, i as u64 + 2);
        }
        // Neither has run: a later write does not overtake a stuck one.
        thread::sleep(Duration::from_millis(50));
        assert!(landed.lock().unwrap().is_empty());

        release.send(()).unwrap();
        stuck.join().unwrap();
        for thread in later {
            thread.join().unwrap();
        }
        assert_eq!(*landed.lock().unwrap(), ["first", "second", "third"]);
        assert_eq!(turns.files(), 0);
    }

    #[test]
    fn many_asked_for_at_once_still_land_in_the_order_they_were_asked_for() {
        let turns = Arc::new(Turns::default());
        let path = Path::new("/data/days/2026-11-17.md");
        let landed = Arc::new(Mutex::new(Vec::new()));
        let (release, held) = mpsc::channel::<()>();
        let first = {
            let turns = turns.clone();
            thread::spawn(move || turns.in_turn(path, || held.recv().unwrap()))
        };
        until_in_line(&turns, path, 1);
        let mut threads = Vec::new();
        for n in 0..40u64 {
            let (theirs, landed) = (turns.clone(), landed.clone());
            threads.push(thread::spawn(move || theirs.in_turn(path, || landed.lock().unwrap().push(n))));
            until_in_line(&turns, path, n + 2);
        }
        release.send(()).unwrap();
        first.join().unwrap();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(*landed.lock().unwrap(), (0..40).collect::<Vec<_>>());
    }

    #[test]
    fn a_file_that_is_stuck_holds_up_no_other_file() {
        let turns = Arc::new(Turns::default());
        let (release, held) = mpsc::channel::<()>();
        let stuck = {
            let turns = turns.clone();
            thread::spawn(move || turns.in_turn(Path::new("/data/pages/a.md"), || held.recv().unwrap()))
        };
        until_in_line(&turns, Path::new("/data/pages/a.md"), 1);
        assert_eq!(turns.in_turn(Path::new("/data/pages/b.md"), || "landed"), "landed");
        assert_eq!(turns.in_turn(Path::new("/data/days/a.md"), || "landed"), "landed");
        assert_eq!(turns.files(), 1);
        release.send(()).unwrap();
        stuck.join().unwrap();
        assert_eq!(turns.files(), 0);
    }

    #[test]
    fn work_that_fails_or_panics_still_gives_up_its_turn() {
        let turns = Arc::new(Turns::default());
        let path = Path::new("/data/pages/a.md");
        let failed: Result<(), String> = turns.in_turn(path, || Err("No space left on device".into()));
        assert!(failed.is_err());
        let panicked = {
            let turns = turns.clone();
            thread::spawn(move || turns.in_turn(path, || panic!("in the middle of a write"))).join()
        };
        assert!(panicked.is_err());
        assert_eq!(turns.in_turn(path, || "the next one runs"), "the next one runs");
        assert_eq!(turns.files(), 0);
    }

    #[test]
    fn the_first_request_to_close_is_held_and_asks_and_the_answer_lets_it_go() {
        let leaving = Arc::new(Leaving::default());
        assert_eq!(leaving.request(), Request::Ask);
        // Asked again while that one waits (the window's close, then the app's exit): held, and not asked twice.
        assert_eq!(leaving.request(), Request::Wait);
        let waiting = {
            let leaving = leaving.clone();
            thread::spawn(move || {
                let began = Instant::now();
                (leaving.wait(Duration::from_secs(30)), began.elapsed())
            })
        };
        thread::sleep(Duration::from_millis(30));
        leaving.answer();
        let (answered, took) = waiting.join().unwrap();
        assert!(answered);
        assert!(took < Duration::from_secs(5), "the answer was not heard for {took:?}");
        // The wait is over: the close that follows goes through, and so does every one after it.
        assert_eq!(leaving.request(), Request::Go);
        assert_eq!(leaving.request(), Request::Go);
    }

    #[test]
    fn an_answer_that_came_before_the_wait_began_is_still_heard() {
        let leaving = Leaving::default();
        assert_eq!(leaving.request(), Request::Ask);
        leaving.answer();
        assert_eq!(leaving.request(), Request::Wait);
        let began = Instant::now();
        assert!(leaving.wait(Duration::from_secs(30)));
        assert!(began.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn with_no_answer_the_close_goes_through_when_the_limit_passes_and_not_before() {
        let leaving = Leaving::default();
        assert_eq!(leaving.request(), Request::Ask);
        let began = Instant::now();
        assert!(!leaving.wait(Duration::from_millis(200)));
        let took = began.elapsed();
        assert!(took >= Duration::from_millis(190), "gave up after {took:?}, before its time");
        assert!(took < Duration::from_secs(5), "held the close for {took:?}");
        assert_eq!(leaving.request(), Request::Go);
        // An answer that comes after that changes nothing.
        leaving.answer();
        assert_eq!(leaving.request(), Request::Go);
    }

    #[test]
    fn an_answer_nobody_asked_for_does_not_answer_the_next_question() {
        let leaving = Leaving::default();
        leaving.answer();
        assert_eq!(leaving.request(), Request::Ask);
        assert!(!leaving.wait(Duration::from_millis(50)));
    }
}
