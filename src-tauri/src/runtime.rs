use serde::Serialize;
use std::{path::{Path, PathBuf}, sync::Arc};
use tokio::{process::Command, time::{timeout, Duration}};

const MAX_OUTPUT: usize = 50_000;
const BASH_TIMEOUT_MS: u64 = 120_000;
const READ_MAX_LINES: usize = 2_000;
const READ_MAX_BYTES: usize = 128 * 1024;
const READ_MAX_LINE_CHARS: usize = 2_000;

#[derive(Clone)]
pub struct LocalRuntimePlugin {
    workspace: Arc<PathBuf>,
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
        Self { workspace: Arc::new(workspace) }
    }

    pub fn id(&self) -> &'static str { "sandbox.local-desktop" }

    pub fn capabilities(&self) -> &'static [&'static str] {
        &["filesystem.read", "filesystem.write", "process.spawn", "workspace.inspect"]
    }

    pub fn workspace(&self) -> &Path { self.workspace.as_path() }

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
                let parent = dunce::canonicalize(parent).map_err(|_| "Parent path does not exist".to_string())?;
                parent.join(joined.file_name().ok_or_else(|| "Invalid path".to_string())?)
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
        let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
        if bytes.iter().take(8192).any(|b| *b == 0) {
            return Err("Binary files are not readable through read_file.".into());
        }
        let mut content = String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8.".to_string())?;
        if content.starts_with('\u{feff}') { content.remove(0); }
        content = content.replace("\r\n", "\n");
        let mut lines: Vec<&str> = content.split('\n').collect();
        if lines.last() == Some(&"") { lines.pop(); }

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
            if count >= safe_limit { break; }
            let clipped: String = line.chars().take(READ_MAX_LINE_CHARS).collect();
            let cost = clipped.len() + 1;
            if used + cost > READ_MAX_BYTES { break; }
            out.push_str(&format!("{:>6}: {}\n", start + count + 1, clipped));
            used += cost;
            count += 1;
        }
        if start + count < lines.len() {
            out.push_str(&format!("\n[truncated; nextOffset={}]\n", start + count + 1));
        }
        Ok(out)
    }

    pub async fn write_file(&self, path: &str, content: &str) -> Result<String, String> {
        let path = self.resolve(path)?;
        tokio::fs::write(&path, content).await.map_err(|e| e.to_string())?;
        Ok(format!("Wrote {}", path.display()))
    }

    pub async fn edit_file(&self, path: &str, old: &str, new: &str) -> Result<String, String> {
        let path = self.resolve(path)?;
        let content = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        let matches = content.matches(old).count();
        if matches != 1 {
            return Err(format!("edit_file expected exactly 1 match, found {matches}."));
        }
        let updated = content.replacen(old, new, 1);
        tokio::fs::write(&path, updated).await.map_err(|e| e.to_string())?;
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
            .args(if cfg!(windows) { vec!["/C", command] } else { vec!["-c", command] })
            .current_dir(working_dir.as_ref())
            .env("ENTRY_DESKTOP_WORKSPACE", self.workspace.as_os_str())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;

        let output = timeout(Duration::from_millis(BASH_TIMEOUT_MS), child.wait_with_output())
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

    fn resolve_workspace_dir(&self, requested: &str) -> Result<PathBuf, String> {
        let path = Path::new(requested);
        if path.is_absolute() { return Err("cwd must be workspace-relative.".into()); }
        let candidate = self.workspace.join(path);
        let canonical = dunce::canonicalize(&candidate).map_err(|_| "cwd does not exist.".to_string())?;
        if !canonical.starts_with(self.workspace.as_path()) { return Err("cwd escapes the workspace.".into()); }
        Ok(canonical)
    }
}

fn truncate(mut value: String) -> (String, bool) {
    if value.len() <= MAX_OUTPUT { return (value, false); }
    value.truncate(MAX_OUTPUT);
    value.push_str("\n[output truncated]");
    (value, true)
}

fn is_dotenv(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).map(|n| n.to_ascii_lowercase().starts_with(".env")).unwrap_or(false)
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
