//! Non-macOS stub — Accessibility insert is not available.

use super::types::TargetSnapshotDto;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn snapshot_target() -> Result<TargetSnapshotDto, String> {
    Ok(TargetSnapshotDto::unavailable(
        "Accessibility insert is macOS-only in this build",
        now_ms(),
    ))
}

pub fn validate_target(
    intended: TargetSnapshotDto,
) -> Result<TargetSnapshotDto, String> {
    Ok(TargetSnapshotDto {
        insertable: false,
        kind: if intended.kind == "insertable" {
            "unavailable".into()
        } else {
            intended.kind
        },
        reason: Some(
            intended
                .reason
                .unwrap_or_else(|| {
                    "Accessibility insert is macOS-only in this build".into()
                }),
        ),
        ..intended
    })
}

pub fn insert_text(
    _text: &str,
    _intended: &TargetSnapshotDto,
) -> Result<(), String> {
    Err("insert unavailable on this platform (macOS AX adapter required)".into())
}
