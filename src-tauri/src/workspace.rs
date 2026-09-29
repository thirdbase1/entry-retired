//! Workspace as a first-class native capability (Phase 2).
//!
//! The agent never receives an arbitrary filesystem path. Everything routes
//! through a registered workspace: Rust owns the canonical root, resolution,
//! metadata, and boundary enforcement. Conceptually:
//!
//! ```text
//! Desktop
//! └── Workspace
//!     ├── root      — canonical path, the only execution ground
//!     ├── status    — registered / missing / invalid
//!     ├── metadata  — git state, project markers
//!     └── policy    — boundary enforcement rules
//! ```

use std::path::{Path, PathBuf};

use crate::path_security::{is_dotenv_file_path, resolve_workspace_path};

/// Lifecycle status of a registered workspace.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum WorkspaceStatus {
    /// Registered and verified on disk.
    Ready,
    /// The registered root no longer exists on disk (deleted/unmounted).
    Missing { registered_root: String },
    /// The registered root exists but is not a directory.
    Invalid { registered_root: String },
}

/// Workspace metadata — what Entry "understands" about the workspace.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetadata {
    pub is_git_repo: bool,
    pub git_branch: Option<String>,
    pub has_package_json: bool,
    pub has_cargo_toml: bool,
    pub has_pyproject_toml: bool,
    pub has_go_mod: bool,
}

/// Boundary policy: what the workspace allows. Phase 2 scope is read+execute;
/// write policy arrives with the write tool and is deny-by-default.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePolicy {
    /// Bash may execute inside the workspace (workspace-relative cwd only).
    pub allow_execute: bool,
    /// File reads are confined to the workspace (always true; not configurable).
    pub confine_reads: bool,
    /// File writes are refused in Phase 2 (deny-by-default per goal.md §13).
    pub allow_writes: bool,
}

impl Default for WorkspacePolicy {
    fn default() -> Self {
        Self {
            allow_execute: true,
            confine_reads: true,
            allow_writes: false,
        }
    }
}

/// The registered workspace. Constructed only through [`Workspace::register`],
/// which canonicalizes and verifies the root — there is no way to obtain a
/// Workspace pointing at a non-directory.
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
    policy: WorkspacePolicy,
}

impl Workspace {
    /// Register a workspace root. Fails for paths that don't exist or aren't
    /// directories; the stored root is always canonical (symlinks resolved).
    pub fn register(path: &str) -> Result<Self, String> {
        let canonical = std::fs::canonicalize(path)
            .map_err(|e| format!("cannot register workspace '{path}': {e}"))?;
        if !canonical.is_dir() {
            return Err(format!(
                "workspace root must be a directory: {}",
                canonical.display()
            ));
        }
        Ok(Self {
            root: canonical,
            policy: WorkspacePolicy::default(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn root_display(&self) -> String {
        self.root.display().to_string()
    }

    pub fn policy(&self) -> &WorkspacePolicy {
        &self.policy
    }

    /// Check the registered root still exists on disk. A workspace can vanish
    /// (unmount, rm -rf) after registration; every lifecycle entry point calls
    /// this before doing work.
    pub fn verify(&self) -> WorkspaceStatus {
        let path = Path::new(&self.root);
        if !path.exists() {
            return WorkspaceStatus::Missing {
                registered_root: self.root_display(),
            };
        }
        if !path.is_dir() {
            return WorkspaceStatus::Invalid {
                registered_root: self.root_display(),
            };
        }
        WorkspaceStatus::Ready
    }

    /// Resolve a workspace-relative path, refusing escapes. Returns None for
    /// absolute paths, traversal, or anything resolving outside the root.
    pub fn resolve(&self, relative: &str) -> Option<PathBuf> {
        resolve_workspace_path(relative, &self.root_display()).map(PathBuf::from)
    }

    /// Resolve a bash cwd: workspace-relative subdirectory only.
    pub fn resolve_cwd(&self, cwd: Option<&str>) -> Option<PathBuf> {
        crate::path_security::resolve_bash_working_directory(cwd, &self.root_display())
            .map(PathBuf::from)
    }

    /// Metadata scan: git state plus project markers.
    pub fn metadata(&self) -> WorkspaceMetadata {
        let has = |name: &str| self.root.join(name).exists();
        let is_git_repo = self.root.join(".git").exists();
        let git_branch = if is_git_repo {
            std::process::Command::new("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(&self.root)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        } else {
            None
        };
        WorkspaceMetadata {
            is_git_repo,
            git_branch,
            has_package_json: has("package.json"),
            has_cargo_toml: has("Cargo.toml"),
            has_pyproject_toml: has("pyproject.toml"),
            has_go_mod: has("go.mod"),
        }
    }

    /// Gate a read request through policy + boundary. Returns the resolved
    /// absolute path or a refusal reason.
    pub fn gate_read(&self, relative: &str) -> Result<PathBuf, String> {
        if !self.policy.confine_reads {
            // Unreachable in Phase 2 but the policy hook is the point.
            return Err("read confinement disabled by policy".to_string());
        }
        match self.verify() {
            WorkspaceStatus::Ready => {}
            WorkspaceStatus::Missing { registered_root } => {
                return Err(format!("workspace no longer exists: {registered_root}"))
            }
            WorkspaceStatus::Invalid { registered_root } => {
                return Err(format!(
                    "workspace root is no longer a directory: {registered_root}"
                ))
            }
        }
        if is_dotenv_file_path(relative) {
            return Err(format!(
                "approval_required: `{relative}` is a credential-bearing dotenv file"
            ));
        }
        let resolved = self
            .resolve(relative)
            .ok_or_else(|| format!("path escapes the workspace: {relative}"))?;
        // Lexical resolution can still land on a symlink pointing outside the
        // root. Canonicalize (follows links) and re-verify containment.
        let canonical = std::fs::canonicalize(&resolved)
            .map_err(|e| format!("cannot resolve {relative}: {e}"))?;
        if !crate::path_security::is_path_within_directory(
            &canonical.display().to_string(),
            &self.root_display(),
        ) {
            return Err(format!("path leaves the workspace via symlink: {relative}"));
        }
        Ok(canonical)
    }

    /// Gate an execute request through policy + boundary. Returns the resolved
    /// cwd or a refusal reason.
    pub fn gate_execute(&self, cwd: Option<&str>) -> Result<PathBuf, String> {
        // Re-verify the root on every gate entry: it can vanish mid-flight.
        match self.verify() {
            WorkspaceStatus::Ready => {}
            WorkspaceStatus::Missing { registered_root } => {
                return Err(format!("workspace no longer exists: {registered_root}"))
            }
            WorkspaceStatus::Invalid { registered_root } => {
                return Err(format!(
                    "workspace root is no longer a directory: {registered_root}"
                ))
            }
        }
        if !self.policy.allow_execute {
            return Err("execution disabled by workspace policy".to_string());
        }
        self.resolve_cwd(cwd).ok_or_else(|| {
            "Invalid cwd: must be a workspace-relative path inside the workspace.".to_string()
        })
    }

    /// Gate a write request. Phase 2: always refused (deny-by-default).
    pub fn gate_write(&self, relative: &str) -> Result<PathBuf, String> {
        if !self.policy.allow_writes {
            return Err(format!(
                "writes are not enabled in this phase; refused: {relative}"
            ));
        }
        self.resolve(relative)
            .ok_or_else(|| format!("path escapes the workspace: {relative}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ws() -> (std::path::PathBuf, Workspace) {
        let dir =
            std::env::temp_dir().join(format!("ed-ws2-{}-{}", std::process::id(), fastrand()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        let ws = Workspace::register(dir.to_str().unwrap()).unwrap();
        (dir, ws)
    }

    fn fastrand() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos() as u64
            ^ (std::process::id() as u64) << 32
    }

    #[test]
    fn register_canonicalizes_and_verifies() {
        let (dir, ws) = temp_ws();
        // Root is canonical (no `..`, no symlink segments).
        assert!(!ws.root_display().contains(".."));
        assert_eq!(ws.verify(), WorkspaceStatus::Ready);
        assert!(ws.metadata().has_package_json);
        assert!(!ws.metadata().is_git_repo);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn register_refuses_files_and_missing_paths() {
        let dir = std::env::temp_dir().join(format!("ed-nodir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(Workspace::register(dir.to_str().unwrap()).is_err());

        let f = std::env::temp_dir().join(format!("ed-file-{}", std::process::id()));
        std::fs::write(&f, "x").unwrap();
        assert!(Workspace::register(f.to_str().unwrap()).is_err());
        std::fs::remove_file(&f).ok();
    }

    #[test]
    fn verify_detects_vanished_workspace() {
        let (dir, ws) = temp_ws();
        assert_eq!(ws.verify(), WorkspaceStatus::Ready);
        std::fs::remove_dir_all(&dir).unwrap();
        match ws.verify() {
            WorkspaceStatus::Missing { registered_root } => {
                // Windows canonicalize yields a \\?\ verbatim prefix; compare
                // the canonical forms, not display strings.
                assert_eq!(
                    std::fs::canonicalize(&registered_root).ok(),
                    std::fs::canonicalize(&dir).ok()
                );
                assert!(std::fs::canonicalize(&registered_root).is_err());
            }
            other => panic!("expected Missing, got {other:?}"),
        }
    }

    #[test]
    fn gates_enforce_boundaries() {
        let (dir, ws) = temp_ws();
        // Read gate: interior ok, traversal refused, dotenv refused.
        assert!(ws.gate_read("sub").is_ok());
        assert!(ws.gate_read("../../etc/passwd").is_err());
        assert!(ws.gate_read(".env").is_err());
        assert!(ws.gate_read("src/../../../etc/passwd").is_err());

        // Execute gate: relative ok, absolute refused.
        assert!(ws.gate_execute(Some("sub")).is_ok());
        assert!(ws.gate_execute(Some("/etc")).is_err());
        assert!(ws.gate_execute(Some("../..")).is_err());
        assert!(ws.gate_execute(None).is_ok());

        // Write gate: deny-by-default in Phase 2.
        assert!(ws.gate_write("newfile.txt").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn policy_defaults_are_conservative() {
        let p = WorkspacePolicy::default();
        assert!(p.allow_execute);
        assert!(p.confine_reads);
        assert!(!p.allow_writes, "writes must be deny-by-default");
    }
}
