//! Ported from entry-agents `packages/agent/tools/path-security.ts` and
//! `utils.ts::isPathWithinDirectory`.
//!
//! The workspace is the security boundary. The model may only name paths
//! inside it; anything that resolves outside is refused before any I/O.

use std::path::{Component, Path, PathBuf};

/// Lexical normalization with Node `path.resolve` semantics: collapse `.`,
/// resolve `..` against preceding components, no symlink resolution.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Mirror of upstream `isPathWithinDirectory`: component-wise containment, so
/// `/work/abc` is NOT within `/work/ab` (the bug a naive string prefix check
/// would introduce).
pub fn is_path_within_directory(file_path: &str, directory: &str) -> bool {
    let resolved_dir = lexical_normalize(&PathBuf::from(directory));
    let raw = PathBuf::from(file_path);
    let resolved_path = if raw.is_absolute() {
        lexical_normalize(&raw)
    } else {
        lexical_normalize(&resolved_dir.join(&raw))
    };
    resolved_path == resolved_dir || resolved_path.starts_with(&resolved_dir)
}

/// Mirror of upstream `resolveWorkspacePath`: absolute or workspace-relative
/// input, refused when it escapes the workspace.
pub fn resolve_workspace_path(file_path: &str, working_directory: &str) -> Option<String> {
    let raw = PathBuf::from(file_path);
    let absolute = if raw.is_absolute() {
        lexical_normalize(&raw)
    } else {
        lexical_normalize(&PathBuf::from(working_directory).join(&raw))
    };
    if is_path_within_directory(&absolute.to_string_lossy(), working_directory) {
        Some(absolute.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// Mirror of upstream `resolveBashWorkingDirectory`: the public contract
/// accepts only workspace-relative subdirectories. An absolute `cwd` is a
/// contract violation, not a convenience.
pub fn resolve_bash_working_directory(
    cwd: Option<&str>,
    working_directory: &str,
) -> Option<String> {
    let Some(cwd) = cwd else {
        return Some(working_directory.to_string());
    };
    if PathBuf::from(cwd).is_absolute() {
        return None;
    }
    let resolved = lexical_normalize(&PathBuf::from(working_directory).join(cwd));
    if is_path_within_directory(&resolved.to_string_lossy(), working_directory) {
        Some(resolved.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// Mirror of upstream `isDotEnvFilePath`: `.env`, `.env.local`, `.env.production`…
pub fn is_dotenv_file_path(file_path: &str) -> bool {
    let normalized = file_path.replace('\\', "/");
    let basename = normalized.rsplit('/').next().unwrap_or("").to_lowercase();
    basename.starts_with(".env")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment_is_component_wise_not_prefix() {
        assert!(is_path_within_directory("/work/repo", "/work/repo"));
        assert!(is_path_within_directory(
            "/work/repo/src/a.ts",
            "/work/repo"
        ));
        // The prefix trap: "/work/repo-evil" must NOT pass for "/work/repo".
        assert!(!is_path_within_directory(
            "/work/repo-evil/a.ts",
            "/work/repo"
        ));
    }

    #[test]
    fn traversal_is_refused() {
        assert_eq!(
            resolve_workspace_path("../../etc/passwd", "/work/repo"),
            None
        );
        assert_eq!(resolve_workspace_path("../sibling", "/work/repo"), None);
        assert_eq!(
            resolve_workspace_path("src/../../outside", "/work/repo"),
            None
        );
    }

    #[test]
    fn interior_paths_resolve() {
        // Platform-agnostic: the expected value is whatever lexical
        // normalization of root.join(rel) renders as on this OS.
        let root = if cfg!(windows) {
            PathBuf::from("C:\\work\\repo")
        } else {
            PathBuf::from("/work/repo")
        };
        let root_s = root.to_string_lossy();
        assert_eq!(
            resolve_workspace_path("src/index.ts", &root_s).as_deref(),
            Some(root.join("src/index.ts").to_string_lossy().as_ref())
        );
        assert_eq!(
            resolve_workspace_path("src/./a/../b.ts", &root_s).as_deref(),
            Some(root.join("src/b.ts").to_string_lossy().as_ref())
        );
    }

    #[test]
    fn bash_cwd_rejects_absolute() {
        let (root, abs_outside) = if cfg!(windows) {
            (
                PathBuf::from("C:\\work\\repo"),
                PathBuf::from("C:\\Windows"),
            )
        } else {
            (PathBuf::from("/work/repo"), PathBuf::from("/etc"))
        };
        let root_s = root.to_string_lossy();
        assert_eq!(
            resolve_bash_working_directory(None, &root_s).as_deref(),
            Some(root_s.as_ref())
        );
        assert_eq!(
            resolve_bash_working_directory(Some("apps/web"), &root_s).as_deref(),
            Some(root.join("apps/web").to_string_lossy().as_ref())
        );
        assert_eq!(
            resolve_bash_working_directory(Some(abs_outside.to_str().unwrap()), &root_s),
            None
        );
        assert_eq!(
            resolve_bash_working_directory(Some("../../etc"), &root_s),
            None
        );
    }

    #[test]
    fn dotenv_detection() {
        assert!(is_dotenv_file_path(".env"));
        assert!(is_dotenv_file_path("/work/repo/.env.local"));
        assert!(is_dotenv_file_path(r"C:\repo\.env"));
        assert!(!is_dotenv_file_path("src/env.ts"));
        assert!(!is_dotenv_file_path("environment.md"));
    }
}
