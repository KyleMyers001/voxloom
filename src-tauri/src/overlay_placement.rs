//! Pure placement math for the dictation overlay (BUS-177).
//! All values are logical points in tao's global top-left coordinate space.

/// A rectangle in logical points (top-left origin, y grows downwards).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Convert a physical work area (as reported by Tauri) into logical points,
/// using the scale factor of the monitor that reported it.
pub fn work_area_logical(x: i32, y: i32, width: u32, height: u32, scale: f64) -> Rect {
    Rect {
        x: x as f64 / scale,
        y: y as f64 / scale,
        width: width as f64 / scale,
        height: height as f64 / scale,
    }
}

/// Top-left origin that centres a `width` x `height` window horizontally in the
/// work area and rests it `margin_bottom` points above the work area's bottom
/// edge. The work area excludes a visible Dock and the menu bar, so the pill
/// stays clear of the Dock.
pub fn place(work: Rect, width: f64, height: f64, margin_bottom: f64) -> (f64, f64) {
    let x = work.x + (work.width - width) / 2.0;
    let y = work.y + work.height - height - margin_bottom;
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: f64 = 142.0;
    const H: f64 = 28.0;
    const MARGIN: f64 = 28.0;
    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
    };

    /// The pre-BUS-177 formula: it used the full monitor frame.
    fn old_full_frame(screen: Rect, width: f64, height: f64, margin: f64) -> (f64, f64) {
        (
            screen.x + (screen.width - width) / 2.0,
            screen.y + screen.height - height - margin,
        )
    }

    #[test]
    fn full_frame_without_dock_matches_old_position() {
        assert_eq!(place(SCREEN, W, H, MARGIN), (649.0, 844.0));
        assert_eq!(
            place(SCREEN, W, H, MARGIN),
            old_full_frame(SCREEN, W, H, MARGIN)
        );
    }

    #[test]
    fn bottom_dock_lifts_pill_above_dock() {
        let work = Rect {
            height: 900.0 - 80.0,
            ..SCREEN
        };
        assert_eq!(place(work, W, H, MARGIN), (649.0, 764.0));
    }

    #[test]
    fn left_dock_centres_in_visible_width() {
        let work = Rect {
            x: 70.0,
            width: 1440.0 - 70.0,
            ..SCREEN
        };
        assert_eq!(place(work, W, H, MARGIN), (684.0, 844.0));
    }

    #[test]
    fn right_dock_centres_in_visible_width() {
        let work = Rect {
            width: 1440.0 - 70.0,
            ..SCREEN
        };
        assert_eq!(place(work, W, H, MARGIN), (614.0, 844.0));
    }

    #[test]
    fn secondary_display_with_negative_origin() {
        let work = Rect {
            x: -1920.0,
            y: -120.0,
            width: 1920.0,
            height: 1080.0,
        };
        assert_eq!(place(work, W, H, MARGIN), (-1031.0, 904.0));
    }

    #[test]
    fn menu_bar_offset_does_not_move_a_bottom_pill() {
        let with_bar = Rect {
            y: 25.0,
            height: 875.0,
            ..SCREEN
        };
        assert_eq!(place(with_bar, W, H, MARGIN), (649.0, 844.0));
    }

    #[test]
    fn result_hud_is_centred_and_above_dock() {
        let work = Rect {
            height: 900.0 - 80.0,
            ..SCREEN
        };
        assert_eq!(place(work, 248.0, 40.0, MARGIN), (596.0, 752.0));
    }

    #[test]
    fn old_full_frame_formula_hides_behind_a_dock() {
        let work = Rect {
            height: 900.0 - 80.0,
            ..SCREEN
        };
        let (_, new_y) = place(work, W, H, MARGIN);
        let (_, old_y) = old_full_frame(SCREEN, W, H, MARGIN);
        assert_eq!(old_y - new_y, 80.0);
        // The old pill bottom edge sat inside the 80 pt Dock band.
        assert!(old_y + H > work.y + work.height);
        assert!(new_y + H <= work.y + work.height);
    }

    #[test]
    fn work_area_converts_with_the_monitors_own_scale() {
        let work = work_area_logical(-3840, -240, 3840, 2160, 2.0);
        assert_eq!(
            work,
            Rect {
                x: -1920.0,
                y: -120.0,
                width: 1920.0,
                height: 1080.0
            }
        );
        let one = work_area_logical(0, 0, 1920, 1080, 1.0);
        assert_eq!(one.width, 1920.0);
    }
}
