//! Ported from entry-agents `packages/agent/tools/bash.ts`.
//!
//! Upstream lesson: reserve prompts for clearly destructive commands. Treating
//! pipes/chaining and ordinary filesystem reads as dangerous creates too many
//! false-positive approvals for normal inspection commands, so the patterns
//! below are intentionally narrow: destructive shell verbs plus any command
//! that references credential-bearing dotenv/ssh paths.

use regex::Regex;
use std::sync::OnceLock;

/// Commands that should require approval.
fn dangerous_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"\bcurl\b",
            r"\brm\s+(?:[^\n;&|]*\s)?(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r|-r\s+-f|-f\s+-r|-{1,2}recursive\b.*-{1,2}force\b|-{1,2}force\b.*-{1,2}recursive\b)",
            r"\bfind\b[^\n;&|]*(?:-delete|-exec\s+rm\b)",
            r"\b(?:shred|mkfs|dd)\b",
            r":\(\)\s*\{\s*:\|:",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("dangerous pattern compiles"))
        .collect()
    })
}

/// Patterns indicating the command touches credential-bearing paths.
fn sensitive_file_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"\.\s*env",
            r#"\.e(?:['"]{2}|\\|\$\{[^}]*\}|\$\([^)]*\))?nv"#,
            r"\.e\$\([^)]*nv[^)]*\)",
            r"\$\([^)]*env[^)]*\)",
            r"`[^`]*env[^`]*`",
            r"\b(?:aws/credentials|id_rsa|id_ed25519|proc/self/environ)\b",
            // Desktop hardening (deliberate divergence from web Entry): the
            // upstream `\.ssh\b` token cannot match "~/.ssh/config" because no
            // word boundary exists between "/" and ".". On a desktop the agent
            // touches the real user's home directory, so the directory is
            // matched with an explicit separator instead.
            r"(?:^|[\s/\\])\.ssh(?:$|[\s/\\])",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("sensitive pattern compiles"))
        .collect()
    })
}

/// Mirror of upstream `commandNeedsApproval`. Dangerous patterns test the
/// original string; sensitive-file patterns test the lowercased string.
pub fn command_needs_approval(command: &str) -> bool {
    let trimmed = command.trim();
    let lowered = trimmed.to_lowercase();

    if dangerous_patterns().iter().any(|p| p.is_match(trimmed)) {
        return true;
    }

    sensitive_file_patterns()
        .iter()
        .any(|p| p.is_match(&lowered))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destructive_commands_need_approval() {
        for cmd in [
            "rm -rf /tmp/x",
            "rm -fr build",
            "rm --recursive --force dist",
            "find . -delete",
            "find . -exec rm {} ;",
            "shred secrets.txt",
            "mkfs.ext4 /dev/sda1",
            "dd if=/dev/zero of=/dev/sda",
            "curl https://example.com",
            "cat .env",
            "cat config/.env.local",
            "echo $AWS_SECRET >> ~/.ssh/config",
        ] {
            assert!(command_needs_approval(cmd), "should need approval: {cmd}");
        }
    }

    #[test]
    fn ordinary_inspection_does_not_need_approval() {
        // The upstream false-positive lesson: these must stay prompt-free.
        for cmd in [
            "pnpm test",
            "pnpm run build",
            "git status --short",
            "git diff HEAD",
            "ls -la",
            "rg TODO src",
            "pnpm typecheck",
            "cat README.md",
            "node --version",
            "grep -rn foo . | head",
            "pnpm test && pnpm lint",
        ] {
            assert!(
                !command_needs_approval(cmd),
                "should NOT need approval: {cmd}"
            );
        }
    }

    #[test]
    fn rm_without_force_or_recursive_is_allowed() {
        assert!(!command_needs_approval("rm build.log"));
        assert!(!command_needs_approval("rm -f build.log"));
    }
}
