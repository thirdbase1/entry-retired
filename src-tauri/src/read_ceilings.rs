//! Ported from entry-agents `packages/agent/tools/read-ceilings.ts`
//! (Command Code read-tool model). Every capability here is a token-budget
//! decision multiplied by the number of reads a session makes.

/// Ceiling 1: the line window (ordinary long files).
pub const READ_MAX_LINES: usize = 2_000;
/// Ceiling 2: the byte budget (logs and other wide-content files).
pub const READ_BYTE_CEILING: usize = 128 * 1024;
/// Ceiling 3: the per-line clamp (minified bundles that are one line).
pub const READ_MAX_LINE_CHARS: usize = 2_000;

#[derive(Debug, Clone, PartialEq)]
pub struct SelectedLines {
    /// 1-based line number of the first returned line.
    pub start_line: usize,
    /// 1-based line number of the LAST returned line (inclusive).
    pub end_line: usize,
    pub lines: Vec<String>,
    /// True when the window cut anything the file contains.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SelectParams {
    pub offset: i64,
    pub limit: usize,
}

impl Default for SelectParams {
    fn default() -> Self {
        Self {
            offset: 1,
            limit: READ_MAX_LINES,
        }
    }
}

/// Splits normalized content into lines WITHOUT the phantom trailing entry a
/// naive split produces. A trailing newline TERMINATES the last line; it does
/// not start a new one. Only ONE trailing empty entry is removed, so a
/// genuinely blank final line still survives.
pub fn split_lines(content: &str) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = content.split('\n').map(str::to_string).collect();
    if lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines
}

/// Strips a UTF-8 BOM and normalizes CRLF to LF.
pub fn normalize_file_content(content: &str) -> String {
    let without_bom = content.strip_prefix('\u{feff}').unwrap_or(content);
    without_bom.replace("\r\n", "\n")
}

/// NUL byte in the head of the content means it isn't text.
pub fn is_likely_binary(content: &str) -> bool {
    content.chars().take(8_192).any(|c| c == '\0')
}

/// Device and virtual file paths are refused before any I/O.
///
/// Upstream rule: a known device name in `/dev/`, OR *any* single-segment
/// `/dev/<name>` (which is how a block device like `/dev/sda` is caught --
/// matching only a hardcoded allowlist would let it through).
pub fn is_device_path(file_path: &str) -> bool {
    const KNOWN: [&str; 8] = [
        "stdin", "stdout", "stderr", "zero", "full", "random", "urandom", "null",
    ];

    if let Some(rest) = file_path.strip_prefix("/dev/") {
        let name = rest.split('/').next().unwrap_or("");
        if KNOWN.contains(&name) {
            return true;
        }
        // `^/dev/[^/]+$` -- exactly one path segment after /dev/.
        if !rest.contains('/') && !rest.is_empty() {
            return true;
        }
    }

    // `^/proc/<pid>/fd`
    if let Some(rest) = file_path.strip_prefix("/proc/") {
        let mut parts = rest.split('/');
        let pid = parts.next().unwrap_or("");
        if !pid.is_empty() && pid.chars().all(|c| c.is_ascii_digit()) {
            if parts.next() == Some("fd") {
                return true;
            }
        }
    }

    false
}

pub fn clamp_line(line: &str) -> (String, usize) {
    if line.chars().count() <= READ_MAX_LINE_CHARS {
        return (line.to_string(), 0);
    }
    let clamped: String = line.chars().take(READ_MAX_LINE_CHARS).collect();
    let extra = line.chars().count() - READ_MAX_LINE_CHARS;
    (
        format!("{clamped} … [line clamped: {extra} more chars]"),
        extra,
    )
}

/// Line-window selection with Command Code semantics:
/// - offset >= 1 (default): read from that line forward, up to `limit`.
/// - offset < 0: read the TAIL — offset=-50 means "the last 50 lines".
pub fn select_lines(lines: &[String], params: SelectParams) -> SelectedLines {
    let total = lines.len();
    let limit = if params.limit > 0 {
        params.limit
    } else {
        READ_MAX_LINES
    };

    let (start_idx, mut end_idx);
    if params.offset < 0 {
        start_idx = total.saturating_sub((-params.offset) as usize);
        end_idx = (start_idx + limit).min(total);
    } else {
        // Clamp to total, not just to 0: an offset past EOF is a legitimate
        // "read from here" that simply has nothing left (upstream bug fix).
        start_idx = ((params.offset as usize).saturating_sub(1)).min(total);
        end_idx = (start_idx + limit).min(total);
    }
    let _ = &mut end_idx;

    SelectedLines {
        start_line: start_idx + 1,
        end_line: end_idx,
        lines: lines[start_idx..end_idx].to_vec(),
        truncated: end_idx < total,
    }
}

/// Applies the byte ceiling AFTER the line window. Returns the (possibly
/// shorter) selection plus the precomputed resume offset — no pagination
/// arithmetic for the model to get wrong.
pub fn apply_byte_ceiling(
    selection: SelectedLines,
    max_bytes: usize,
) -> (SelectedLines, Option<usize>) {
    let mut used = 0usize;
    let mut kept: Vec<String> = Vec::new();

    for line in &selection.lines {
        let cost = line.len() + 1;
        if used + cost > max_bytes {
            break;
        }
        kept.push(line.clone());
        used += cost;
    }

    let truncated = kept.len() < selection.lines.len() || selection.truncated;
    let end_line = if kept.is_empty() {
        0
    } else {
        selection.start_line + kept.len() - 1
    };

    let next_offset = if kept.len() < selection.lines.len() {
        selection.start_line + kept.len()
    } else {
        selection.end_line + 1
    };

    (
        SelectedLines {
            lines: kept,
            end_line,
            truncated,
            ..selection
        },
        if truncated { Some(next_offset) } else { None },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_newline_terminates_not_starts() {
        assert_eq!(
            split_lines("one\ntwo\nthree\n"),
            vec!["one", "two", "three"]
        );
        // A genuinely blank final line survives.
        assert_eq!(split_lines("one\ntwo\n\n").len(), 3);
        assert!(split_lines("").is_empty());
    }

    #[test]
    fn offset_past_eof_is_empty_not_inverted() {
        let lines = split_lines("a\nb\nc");
        // Upstream bug fix: used to yield startLine 50, endLine 10.
        let sel = select_lines(
            &lines,
            SelectParams {
                offset: 50,
                limit: 10,
            },
        );
        assert_eq!(sel.start_line, 4);
        assert_eq!(sel.end_line, 3);
        assert!(sel.lines.is_empty());
        assert!(!sel.truncated);
    }

    #[test]
    fn negative_offset_reads_tail() {
        let lines = split_lines("1\n2\n3\n4\n5");
        let sel = select_lines(
            &lines,
            SelectParams {
                offset: -2,
                limit: 10,
            },
        );
        assert_eq!(sel.lines, vec!["4", "5"]);
        assert_eq!(sel.start_line, 4);
    }

    #[test]
    fn byte_ceiling_precomputes_resume_offset() {
        let lines = vec!["x".repeat(100); 10];
        let sel = select_lines(
            &lines,
            SelectParams {
                offset: 1,
                limit: 100,
            },
        );
        let (sel2, next) = apply_byte_ceiling(sel, 350);
        // 101 bytes per line -> 3 lines fit in 350.
        assert_eq!(sel2.lines.len(), 3);
        assert_eq!(next, Some(4));
        assert!(sel2.truncated);
    }

    #[test]
    fn device_paths_refused() {
        assert!(is_device_path("/dev/null"));
        assert!(is_device_path("/dev/zero"));
        assert!(is_device_path("/dev/sda"));
        assert!(is_device_path("/proc/123/fd/3"));
        assert!(!is_device_path("/dev"));
        assert!(!is_device_path("/work/dev/null"));
    }

    #[test]
    fn clamp_marks_excess() {
        let (line, extra) = clamp_line(&"x".repeat(3000));
        assert_eq!(extra, 1000);
        assert!(line.contains("line clamped: 1000 more chars"));
    }
}
