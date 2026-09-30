use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{
    process::Command,
    time::{timeout, Duration},
};

const MAX_OUTPUT: usize = 50_000;
const BASH_TIMEOUT_MS: u64 = 120_000;
const READ_MAX_LINES: usize = 2_000;
const READ_MAX_BYTES: usize = 128 * 1024;
const READ_MAX_LINE_CHARS: usize = 2_000;

#[derive(Clone)]
pub struct LocalRuntimePlugin {
    workspace: Arc<PathBuf>,
    /// DSH fs-observation-policy port: files observed via read_file, allowed
    /// to be written/edited afterwards (read-before-write freshness gate).
    observed: Arc<Mutex<HashSet<PathBuf>>>,
}

#[derive(Debug, Serialize)]
pub struct CommandResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

impl LocalRuntimePlugin {
    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace: Arc::new(workspace),
            observed: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn id(&self) -> &'static str {
        "sandbox.local-desktop"
    }

    pub fn capabilities(&self) -> &'static [&'static str] {
        &[
            "filesystem.read",
            "filesystem.write",
            "process.spawn",
            "workspace.inspect",
            "fs.search",
        ]
    }

    /// DSH ConfinedArgv port: sandbox enforcement is a *reported fact*.
    /// The desktop runner confines effects by workspace path resolution +
    /// approval gates; report `partial` honestly (no kernel-level
    /// confinement on Windows; Landlock/Seatbelt are future work).
    pub fn enforcement(&self) -> &'static str {
        if cfg!(target_os = "windows") {
            "partial"
        } else {
            "partial"
        }
    }

    pub fn workspace(&self) -> &Path {
        self.workspace.as_path()
    }

    fn resolve(&self, requested: &str) -> Result<PathBuf, String> {
        let path = Path::new(requested);
        if path.is_absolute() {
            return Err("Absolute paths are refused; use workspace-relative paths.".into());
        }
        let joined = self.workspace.join(path);
        let normalized = match dunce::canonicalize(&joined) {
            Ok(path) => path,
            Err(_) => {
                let parent = joined.parent().ok_or_else(|| "Invalid path".to_string())?;
                let parent = dunce::canonicalize(parent)
                    .map_err(|_| "Parent path does not exist".to_string())?;
                parent.join(
                    joined
                        .file_name()
                        .ok_or_else(|| "Invalid path".to_string())?,
                )
            }
        };
        if !normalized.starts_with(self.workspace.as_path()) {
            return Err("Path escapes the workspace.".into());
        }
        if is_dotenv(&normalized) {
            return Err("Access to .env files is refused.".into());
        }
        Ok(normalized)
    }

    pub async fn read_file(&self, path: &str, offset: i64, limit: usize) -> Result<String, String> {
        let path = self.resolve(path)?;
        self.observed
            .lock()
            .expect("observed lock")
            .insert(path.clone());
        let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
        if bytes.iter().take(8192).any(|b| *b == 0) {
            return Err("Binary files are not readable through read_file.".into());
        }
        let mut content =
            String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8.".to_string())?;
        if content.starts_with('\u{feff}') {
            content.remove(0);
        }
        content = content.replace("\r\n", "\n");
        let mut lines: Vec<&str> = content.split('\n').collect();
        if lines.last() == Some(&"") {
            lines.pop();
        }

        let safe_limit = limit.clamp(1, READ_MAX_LINES);
        let start = if offset < 0 {
            lines.len().saturating_sub(offset.unsigned_abs() as usize)
        } else {
            (offset.max(1) as usize).saturating_sub(1).min(lines.len())
        };
        let mut out = String::new();
        let mut count = 0usize;
        let mut used = 0usize;
        for line in lines.iter().skip(start) {
            if count >= safe_limit {
                break;
            }
            let clipped: String = line.chars().take(READ_MAX_LINE_CHARS).collect();
            let cost = clipped.len() + 1;
            if used + cost > READ_MAX_BYTES {
                break;
            }
            out.push_str(&format!("{:>6}: {}\n", start + count + 1, clipped));
            used += cost;
            count += 1;
        }
        if start + count < lines.len() {
            out.push_str(&format!(
                "\n[truncated; nextOffset={}]\n",
                start + count + 1
            ));
        }
        Ok(out)
    }

    pub async fn write_file(&self, path: &str, content: &str) -> Result<String, String> {
        let path = self.resolve(path)?;
        // DSH fs-observation-policy port: write/edit freshness is enforced by
        // the runtime gate — the file must have been read (or not exist) before
        // an overwrite. Fail closed with an explicit reason.
        if path.exists() && !self.observed.lock().expect("observed lock").contains(&path) {
            return Err(
                "Write refused: read the file with read_file before overwriting it (read-before-write policy)."
                    .into(),
            );
        }
        tokio::fs::write(&path, content)
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!("Wrote {}", path.display()))
    }

    pub async fn edit_file(&self, path: &str, old: &str, new: &str) -> Result<String, String> {
        let path = self.resolve(path)?;
        if !self.observed.lock().expect("observed lock").contains(&path) {
            return Err(
                "Edit refused: read the file with read_file before editing it (read-before-write policy)."
                    .into(),
            );
        }
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| e.to_string())?;
        let matches = content.matches(old).count();
        if matches != 1 {
            return Err(format!(
                "edit_file expected exactly 1 match, found {matches}."
            ));
        }
        let updated = content.replacen(old, new, 1);
        tokio::fs::write(&path, updated)
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!("Edited {}", path.display()))
    }

    pub async fn bash(&self, command: &str, cwd: Option<&str>) -> Result<CommandResult, String> {
        if command_needs_approval(command) {
            return Err("APPROVAL_REQUIRED: this command matches Entry's dangerous/sensitive command policy.".into());
        }
        let working_dir = match cwd {
            None | Some("") => self.workspace.clone(),
            Some(value) => self.resolve_workspace_dir(value)?.into(),
        };

        let child = Command::new(if cfg!(windows) { "cmd" } else { "bash" })
            .args(if cfg!(windows) {
                vec!["/C", command]
            } else {
                vec!["-c", command]
            })
            .current_dir(working_dir.as_ref())
            .env("ENTRY_DESKTOP_WORKSPACE", self.workspace.as_os_str())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;

        let output = timeout(
            Duration::from_millis(BASH_TIMEOUT_MS),
            child.wait_with_output(),
        )
        .await
        .map_err(|_| "Command timed out after 120 seconds and was killed.".to_string())?
        .map_err(|e| e.to_string())?;

        let (stdout, trunc_a) = truncate(String::from_utf8_lossy(&output.stdout).to_string());
        let (stderr, trunc_b) = truncate(String::from_utf8_lossy(&output.stderr).to_string());
        Ok(CommandResult {
            success: output.status.success(),
            exit_code: output.status.code(),
            stdout,
            stderr,
            truncated: trunc_a || trunc_b,
        })
    }

    /// Workspace directory listing (DSH fs discovery port).
    pub fn list_dir(&self, path: Option<&str>) -> Result<String, String> {
        let dir = match path {
            None | Some("") => (*self.workspace).clone(),
            Some(p) => {
                let resolved = self.resolve(p)?;
                if !resolved.is_dir() {
                    return Err(format!("Not a directory: {p}"));
                }
                resolved
            }
        };
        let mut entries: Vec<String> = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if e.path().is_dir() {
                    format!("{name}/")
                } else {
                    name
                }
            })
            .collect();
        entries.sort();
        if entries.len() > 500 {
            entries.truncate(500);
            entries.push("[truncated at 500 entries]".into());
        }
        Ok(if entries.is_empty() {
            String::from("(empty directory)")
        } else {
            entries.join("\n")
        })
    }

    /// Recursive glob (DSH fs-search port): patterns like `**/*.rs`, limited
    /// depth, workspace-relative results.
    pub fn glob(&self, pattern: &str) -> Result<String, String> {
        if pattern.contains("..")
            || pattern.starts_with('/')
            || pattern.contains(':') && pattern.len() == 2
        {
            return Err("Pattern must be workspace-relative.".into());
        }
        let mut matches: Vec<String> = Vec::new();
        let (dir_part, file_pat) = match pattern.rsplit_once('/') {
            Some((d, f)) => (d.to_string(), f.to_string()),
            None => (String::new(), pattern.to_string()),
        };
        let base = if dir_part.is_empty() {
            (*self.workspace).clone()
        } else {
            self.resolve(&dir_part)?
        };
        let matcher = glob_matcher(&file_pat);
        let mut stack = vec![base.clone()];
        let mut visited = 0usize;
        while let Some(dir) = stack.pop() {
            visited += 1;
            if visited > 5_000 || matches.len() >= 200 {
                break;
            }
            let Ok(read) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in read.filter_map(|e| e.ok()) {
                let p = entry.path();
                if p.is_dir() {
                    // skip heavy/vendor dirs
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
                        stack.push(p);
                    }
                } else if matcher(&entry.file_name().to_string_lossy()) {
                    let rel = p
                        .strip_prefix(self.workspace.as_path())
                        .unwrap_or(&p)
                        .to_string_lossy()
                        .to_string();
                    matches.push(rel);
                }
            }
        }
        matches.sort();
        if matches.len() >= 200 {
            matches.push("[capped at 200 matches]".into());
        }
        Ok(if matches.is_empty() {
            String::from("(no matches)")
        } else {
            matches.join("\n")
        })
    }

    /// Text search (DSH grep port): literal-substring scan of text files,
    /// byte-capped, workspace-relative results.
    pub fn grep(&self, pattern: &str, file_glob: Option<&str>) -> Result<String, String> {
        if pattern.is_empty() {
            return Err("pattern is required".into());
        }
        let matcher = file_glob.map(glob_matcher);
        let mut results: Vec<String> = Vec::new();
        let mut stack = vec![(*self.workspace).clone()];
        let mut visited = 0usize;
        while let Some(dir) = stack.pop() {
            visited += 1;
            if visited > 5_000 || results.len() >= 150 {
                break;
            }
            let Ok(read) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in read.filter_map(|e| e.ok()) {
                let p = entry.path();
                if p.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
                        stack.push(p);
                    }
                } else {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if let Some(m) = &matcher {
                        if !m(&name) {
                            continue;
                        }
                    }
                    if let Ok(meta) = p.metadata() {
                        if meta.len() > 1_048_576 {
                            continue; // skip >1MB
                        }
                    }
                    let Ok(content) = std::fs::read(&p) else {
                        continue;
                    };
                    if content.contains(&0u8) {
                        continue; // binary
                    }
                    let text = String::from_utf8_lossy(&content);
                    let rel = p
                        .strip_prefix(self.workspace.as_path())
                        .unwrap_or(&p)
                        .to_string_lossy()
                        .to_string();
                    for (i, line) in text.lines().enumerate().take(5_000) {
                        if line.contains(pattern) {
                            results.push(format!("{}:{}: {}", rel, i + 1, line.trim()));
                            if results.len() >= 150 {
                                break;
                            }
                        }
                    }
                }
            }
        }
        if results.len() >= 150 {
            results.push("[capped at 150 matches]".into());
        }
        Ok(if results.is_empty() {
            String::from("(no matches)")
        } else {
            results.join("\n")
        })
    }
}

/// Simple glob: `*` within a segment, `?` single char; `**` is not supported
/// at this layer (callers split directories before).
fn glob_matcher(pattern: &str) -> impl Fn(&str) -> bool + '_ {
    let pattern = pattern.to_string();
    move |name: &str| {
        let p: Vec<char> = pattern.chars().collect();
        let n: Vec<char> = name.chars().collect();
        fn rec(p: &[char], n: &[char]) -> bool {
            if p.is_empty() {
                return n.is_empty();
            }
            match p[0] {
                '*' => {
                    for i in 0..=n.len() {
                        if rec(&p[1..], &n[i..]) {
                            return true;
                        }
                    }
                    false
                }
                '?' => !n.is_empty() && rec(&p[1..], &n[1..]),
                c => !n.is_empty() && n[0] == c && rec(&p[1..], &n[1..]),
            }
        }
        rec(&p, &n)
    }
}

/// Spawn a bash command without waiting (background-job path). Output pipes
/// are kept; the caller polls the child and streams bytes into the job ring.
pub async fn spawn_bash(
    runtime: &LocalRuntimePlugin,
    command: &str,
    cwd: Option<&str>,
) -> Result<tokio::process::Child, String> {
    if command_needs_approval(command) {
        return Err(
            "APPROVAL_REQUIRED: this command matches Entry's dangerous/sensitive command policy."
                .into(),
        );
    }
    let working_dir = match cwd {
        None | Some("") => runtime.workspace.as_path().to_path_buf(),
        Some(value) => runtime.resolve_workspace_dir(value)?,
    };
    Command::new(if cfg!(windows) { "cmd" } else { "bash" })
        .args(if cfg!(windows) {
            vec!["/C", command]
        } else {
            vec!["-c", command]
        })
        .current_dir(working_dir)
        .env("ENTRY_DESKTOP_WORKSPACE", runtime.workspace.as_os_str())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())
}

/// Drain a finished child's pipes (best effort) into one string.
pub async fn collect_child_output(child: &mut tokio::process::Child) -> String {
    use tokio::io::AsyncReadExt;
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        out.push_str(&String::from_utf8_lossy(&buf));
    }
    if let Some(mut stderr) = child.stderr.take() {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        if !buf.is_empty() {
            out.push_str("\n[stderr]\n");
            out.push_str(&String::from_utf8_lossy(&buf));
        }
    }
    if out.len() > MAX_OUTPUT {
        out.truncate(MAX_OUTPUT);
        out.push_str("\n[output truncated]");
    }
    out
}

impl LocalRuntimePlugin {
    fn resolve_workspace_dir(&self, requested: &str) -> Result<PathBuf, String> {
        let path = Path::new(requested);
        if path.is_absolute() {
            return Err("cwd must be workspace-relative.".into());
        }
        let candidate = self.workspace.join(path);
        let canonical =
            dunce::canonicalize(&candidate).map_err(|_| "cwd does not exist.".to_string())?;
        if !canonical.starts_with(self.workspace.as_path()) {
            return Err("cwd escapes the workspace.".into());
        }
        Ok(canonical)
    }
}

fn truncate(mut value: String) -> (String, bool) {
    if value.len() <= MAX_OUTPUT {
        return (value, false);
    }
    value.truncate(MAX_OUTPUT);
    value.push_str("\n[output truncated]");
    (value, true)
}

fn is_dotenv(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_ascii_lowercase().starts_with(".env"))
        .unwrap_or(false)
}

fn command_needs_approval(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let dangerous = ["curl", "shred", "mkfs", "dd", ":(){", "rm -rf", "rm -fr"];
    dangerous.iter().any(|p| lower.contains(p))
        || lower.contains(".env")
        || lower.contains(".ssh")
        || lower.contains("aws/credentials")
        || lower.contains("id_rsa")
        || lower.contains("id_ed25519")
        || lower.contains("proc/self/environ")
}
