//! A song-change peek at the MacBook camera housing.
//!
//! When a new track starts playing, a black shape grows out of the housing:
//! at rest it is the housing's own outline, which sits behind the hardware
//! and draws nothing, and fully open it is a rounded tab reaching `DROP`
//! points below the menu bar with a note glyph and "Title · Artist" on one
//! line. It holds for `HOLD_SECS`, springs back, and the panel is ordered
//! out again. Nothing is on screen while idle, and while open the only
//! black beside the housing at menu bar height is the two `EAR` slivers
//! at the very top edge.
//!
//! The panel is one borderless, click-through NSPanel sized to the open
//! shape. The outline is a CAShapeLayer used as the content layer's mask, so
//! the text is clipped by the outline as it moves. The path has one fixed
//! topology (two concave "ears" where it meets the screen edge, two convex
//! corners at the bottom) evaluated at a progress `t` in 0..=1, and a small
//! spring drives `t` from a 60 Hz timer on the main run loop.
//!
//! The screen is picked by `safeAreaInsets.top > 0`, which is only true of a
//! display with a camera housing. With no such screen (clamshell, external
//! display only, a pre-notch Mac) nothing is shown.
//!
//! Off macOS everything here is a no-op.
//!
//! The frame is recomputed on `NSApplicationDidChangeScreenParameters`, which
//! AppKit posts on any display reconfiguration: lid open, dock, undock,
//! resolution change. There is deliberately no separate wake observer.

// Off macOS the only consumer of the geometry below is the test module, so
// every item in it would warn in a Linux or Windows build.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// A rectangle in AppKit screen coordinates (origin bottom left).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The camera housing of one screen, in AppKit screen coordinates: its left
/// and right edges, the screen's top edge, and how far down it reaches.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Housing {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub height: f64,
}

/// Radius of the concave corners where the open shape meets the screen edge.
pub const EAR: f64 = 6.0;
/// Radius of the two bottom corners.
pub const BOTTOM_RADIUS: f64 = 14.0;
/// How far below the housing the open shape reaches.
pub const DROP: f64 = 32.0;
/// Horizontal padding inside the shape.
pub const PAD: f64 = 12.0;
/// Side of the note glyph.
pub const ICON: f64 = 16.0;
/// Gap between the glyph and the text.
pub const GAP: f64 = 8.0;
/// Fixed line box for the single line of text.
pub const LINE_HEIGHT: f64 = 16.0;
/// Point size of the text.
pub const FONT_SIZE: f64 = 12.0;
/// How long the open shape stays before it springs back.
pub const HOLD_SECS: f64 = 2.0;
/// Animation tick.
pub const TICK_SECS: f64 = 1.0 / 60.0;
/// Opening spring, mass 1: a little bounce.
pub const OPEN_STIFFNESS: f64 = 224.0;
pub const OPEN_DAMPING: f64 = 24.0;
/// Closing spring, mass 1: critically damped, no bounce back into the housing.
pub const CLOSE_STIFFNESS: f64 = 195.0;
pub const CLOSE_DAMPING: f64 = 28.0;

/// The housing of a screen, or None when it has none (external display,
/// clamshell, pre-notch MacBook).
pub fn housing(screen: Rect, safe_top: f64, aux_left: Rect, aux_right: Rect) -> Option<Housing> {
    if safe_top <= 0.0 {
        return None;
    }
    if aux_left.w <= 0.0 || aux_right.w <= 0.0 {
        return None;
    }
    let left = aux_left.x + aux_left.w;
    let right = aux_right.x;
    if right <= left {
        return None;
    }
    Some(Housing {
        left,
        right,
        top: screen.y + screen.h,
        height: safe_top,
    })
}

/// Frame of the panel in screen coordinates: the fully open silhouette.
pub fn panel_frame(h: Housing) -> Rect {
    let height = h.height + DROP;
    Rect {
        x: h.left - EAR,
        y: h.top - height,
        w: h.right - h.left + 2.0 * EAR,
        h: height,
    }
}

/// One segment of the outline.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Seg {
    Move(f64, f64),
    Line(f64, f64),
    /// Quadratic curve to (x, y) through the control point (cx, cy).
    Quad {
        cx: f64,
        cy: f64,
        x: f64,
        y: f64,
    },
}

/// Outline of the shape at progress `t` (0 = the bare housing, 1 = fully
/// open) in panel coordinates with y growing downward from the screen's top
/// edge. Every `t` yields the same nine segments in the same order, so a
/// path built from one can be swapped for another without a visible jump.
pub fn outline(body_w: f64, housing_h: f64, t: f64) -> [Seg; 9] {
    let t = t.clamp(0.0, 1.0);
    let ear = EAR * t;
    let h = housing_h + DROP * t;
    let rb = BOTTOM_RADIUS.min(h / 2.0);
    let x0 = EAR;
    let x1 = EAR + body_w;
    [
        Seg::Move(x0 - ear, 0.0),
        Seg::Quad {
            cx: x0,
            cy: 0.0,
            x: x0,
            y: ear,
        },
        Seg::Line(x0, h - rb),
        Seg::Quad {
            cx: x0,
            cy: h,
            x: x0 + rb,
            y: h,
        },
        Seg::Line(x1 - rb, h),
        Seg::Quad {
            cx: x1,
            cy: h,
            x: x1,
            y: h - rb,
        },
        Seg::Line(x1, ear),
        Seg::Quad {
            cx: x1,
            cy: 0.0,
            x: x1 + ear,
            y: 0.0,
        },
        Seg::Line(x0 - ear, 0.0),
    ]
}

/// Frame of the note glyph in the panel's content view (origin bottom left).
/// The content row is the `DROP` strip below the housing, centred.
pub fn icon_frame() -> Rect {
    Rect {
        x: EAR + PAD,
        y: (DROP - ICON) / 2.0,
        w: ICON,
        h: ICON,
    }
}

/// Frame of the text in the panel's content view (origin bottom left).
pub fn label_frame(body_w: f64) -> Rect {
    Rect {
        x: EAR + PAD + ICON + GAP,
        y: (DROP - LINE_HEIGHT) / 2.0,
        w: (body_w - 2.0 * PAD - ICON - GAP).max(0.0),
        h: LINE_HEIGHT,
    }
}

/// Opacity of the glyph and text at progress `t`: hidden until the shape has
/// half dropped, so the text never floats outside the black.
pub fn content_alpha(t: f64) -> f64 {
    ((t - 0.5) * 2.0).clamp(0.0, 1.0)
}

/// Whether audio is really running, from the media bridge's optional
/// `started` flag. A frontend that predates the flag sends none, and for
/// it a moving position is the only signal there is; when the flag is
/// present it wins, because a seek while a song is still loading moves the
/// position before any sound plays.
pub fn audio_started(started: Option<bool>, elapsed: f64) -> bool {
    started.unwrap_or(elapsed > 0.0)
}

/// The one line of text the peek shows.
pub fn pill_text(title: &str, artist: Option<&str>) -> String {
    let title = title.trim();
    match artist.map(str::trim) {
        Some(artist) if !artist.is_empty() => format!("{title} \u{00b7} {artist}"),
        _ => title.to_string(),
    }
}

/// A spring on one scalar, mass 1, stepped at a fixed rate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spring {
    pub x: f64,
    pub v: f64,
    pub target: f64,
    pub stiffness: f64,
    pub damping: f64,
}

impl Spring {
    /// Advance by `dt` seconds. Returns true once at rest on the target.
    pub fn step(&mut self, dt: f64) -> bool {
        let a = -self.stiffness * (self.x - self.target) - self.damping * self.v;
        self.v += a * dt;
        self.x += self.v * dt;
        let settled = (self.x - self.target).abs() < 0.002 && self.v.abs() < 0.02;
        if settled {
            self.x = self.target;
            self.v = 0.0;
        }
        settled
    }
}

/// Decides which media updates get a peek: the first update for a new
/// (title, artist) that has actually started playing, once. Pause, resume,
/// seeks and the periodic position pushes all repeat a key already shown and
/// so do nothing.
#[derive(Debug, Default)]
pub struct Tracker {
    shown: Option<(String, String)>,
}

impl Tracker {
    /// The text to peek for this update, if any.
    pub fn observe(
        &mut self,
        title: &str,
        artist: &str,
        paused: bool,
        started: bool,
    ) -> Option<String> {
        let key = (title.trim().to_string(), artist.trim().to_string());
        if key.0.is_empty() || paused || !started {
            return None;
        }
        if self.shown.as_ref() == Some(&key) {
            return None;
        }
        let text = pill_text(&key.0, Some(&key.1));
        self.shown = Some(key);
        Some(text)
    }

    /// Nothing is playing any more; the next track counts as new again.
    pub fn clear(&mut self) {
        self.shown = None;
    }
}

use tauri::AppHandle;

/// Turn the peek on or off. Song changes are tracked either way, so turning
/// it on later does not replay the current song.
#[tauri::command]
pub fn notch_set_enabled(app: AppHandle, enabled: bool) {
    let _ = app.run_on_main_thread(move || set_enabled(enabled));
}

#[cfg(target_os = "macos")]
pub use imp::{clear, on_media, set_enabled};

#[cfg(not(target_os = "macos"))]
pub fn set_enabled(_enabled: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn on_media(_title: &str, _artist: &str, _paused: bool, _started: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn clear() {}

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::{Cell, RefCell};
    use std::ptr::{null, NonNull};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{
        NSApplicationDidChangeScreenParametersNotification, NSBackingStoreType, NSColor, NSFont,
        NSFontWeightMedium, NSImage, NSImageView, NSLineBreakMode, NSPanel, NSScreen,
        NSStatusWindowLevel, NSTextField, NSView, NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    use objc2_core_graphics::{CGColor, CGMutablePath};
    use objc2_foundation::{
        NSNotification, NSNotificationCenter, NSOperationQueue, NSPoint, NSRect, NSRunLoop,
        NSRunLoopCommonModes, NSSize, NSString, NSTimer,
    };
    use objc2_quartz_core::{CAShapeLayer, CATransaction};

    use super::{Seg, Spring, Tracker};

    /// Everything the peek owns on screen. Built on first use, then reused.
    /// AppKit objects here are only ever touched on the main thread.
    struct Pill {
        panel: Retained<NSPanel>,
        shape: Retained<CAShapeLayer>,
        icon: Option<Retained<NSImageView>>,
        label: Retained<NSTextField>,
        /// Token from addObserverForName:. Held because passing it back to
        /// removeObserver: is the only way to unregister, and nothing does:
        /// the pill is a process-lifetime thread-local, so the registration
        /// lives as long as the process. Dropping this on its own would not
        /// unregister anything.
        _screens_observer: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    }

    /// Where the panel sits for the current screens.
    #[derive(Clone, Copy)]
    struct Layout {
        frame: super::Rect,
        body_w: f64,
        housing_h: f64,
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Phase {
        Idle,
        Opening,
        Holding,
        Closing,
    }

    struct Anim {
        phase: Phase,
        spring: Spring,
        layout: Option<Layout>,
        /// Bumped on every present and dismiss; a hold timer only acts if the
        /// generation it captured is still current.
        gen: u64,
        ticker: Option<Retained<NSTimer>>,
        hold: Option<Retained<NSTimer>>,
    }

    thread_local! {
        static PILL: RefCell<Option<Pill>> = const { RefCell::new(None) };
        static TRACKER: RefCell<Tracker> = RefCell::new(Tracker::default());
        static ENABLED: Cell<bool> = const { Cell::new(false) };
        static ANIM: RefCell<Anim> = const {
            RefCell::new(Anim {
                phase: Phase::Idle,
                spring: Spring {
                    x: 0.0,
                    v: 0.0,
                    target: 0.0,
                    stiffness: super::OPEN_STIFFNESS,
                    damping: super::OPEN_DAMPING,
                },
                layout: None,
                gen: 0,
                ticker: None,
                hold: None,
            })
        };
    }

    pub fn set_enabled(enabled: bool) {
        ENABLED.with(|e| e.set(enabled));
        if !enabled {
            dismiss();
        }
    }

    /// A media update from the frontend. `started` means audio is actually
    /// running, not just intended to.
    pub fn on_media(title: &str, artist: &str, paused: bool, started: bool) {
        let text = TRACKER.with(|t| t.borrow_mut().observe(title, artist, paused, started));
        if let Some(text) = text {
            if ENABLED.with(|e| e.get()) {
                present(&text);
            }
        }
    }

    /// Nothing is playing any more.
    pub fn clear() {
        TRACKER.with(|t| t.borrow_mut().clear());
        dismiss();
    }

    /// Show `text`, opening the shape if it is not already out.
    fn present(text: &str) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(layout) = layout_from_screens(mtm) else {
            return;
        };
        PILL.with(|p| {
            let mut slot = p.borrow_mut();
            let pill = match slot.as_ref() {
                Some(pill) => pill,
                None => slot.insert(build(mtm)),
            };
            apply_layout(pill, layout);
            pill.label.setStringValue(&NSString::from_str(text));
        });
        let gen = ANIM.with(|a| {
            let mut a = a.borrow_mut();
            a.gen += 1;
            a.layout = Some(layout);
            if let Some(hold) = a.hold.take() {
                hold.invalidate();
            }
            a.gen
        });
        let phase = ANIM.with(|a| a.borrow().phase);
        match phase {
            Phase::Holding => schedule_hold(gen),
            Phase::Opening => {}
            Phase::Idle | Phase::Closing => {
                ANIM.with(|a| {
                    let mut a = a.borrow_mut();
                    a.phase = Phase::Opening;
                    a.spring.target = 1.0;
                    a.spring.stiffness = super::OPEN_STIFFNESS;
                    a.spring.damping = super::OPEN_DAMPING;
                });
                if phase == Phase::Idle {
                    draw(0.0);
                    PILL.with(|p| {
                        if let Some(pill) = p.borrow().as_ref() {
                            pill.panel.orderFrontRegardless();
                        }
                    });
                }
                start_ticker();
            }
        }
    }

    /// Take everything down at once: the toggle went off, the queue emptied,
    /// or the notched screen went away.
    fn dismiss() {
        ANIM.with(|a| {
            let mut a = a.borrow_mut();
            a.gen += 1;
            a.phase = Phase::Idle;
            a.spring.x = 0.0;
            a.spring.v = 0.0;
            a.spring.target = 0.0;
            if let Some(hold) = a.hold.take() {
                hold.invalidate();
            }
            if let Some(ticker) = a.ticker.take() {
                ticker.invalidate();
            }
        });
        PILL.with(|p| {
            if let Some(pill) = p.borrow().as_ref() {
                pill.panel.orderOut(None);
            }
        });
    }

    /// One 60 Hz step of the spring.
    fn tick() {
        let (x, settled, phase, gen) = ANIM.with(|a| {
            let mut a = a.borrow_mut();
            let settled = a.spring.step(super::TICK_SECS);
            (a.spring.x, settled, a.phase, a.gen)
        });
        draw(x);
        if !settled {
            return;
        }
        match phase {
            Phase::Opening => {
                ANIM.with(|a| a.borrow_mut().phase = Phase::Holding);
                stop_ticker();
                schedule_hold(gen);
            }
            Phase::Closing => {
                ANIM.with(|a| a.borrow_mut().phase = Phase::Idle);
                stop_ticker();
                PILL.with(|p| {
                    if let Some(pill) = p.borrow().as_ref() {
                        pill.panel.orderOut(None);
                    }
                });
            }
            Phase::Idle | Phase::Holding => stop_ticker(),
        }
    }

    /// The hold ran out: spring back, unless something newer happened.
    fn hold_fired(gen: u64) {
        let go = ANIM.with(|a| {
            let mut a = a.borrow_mut();
            a.hold = None;
            if a.gen != gen || a.phase != Phase::Holding {
                return false;
            }
            a.phase = Phase::Closing;
            a.spring.target = 0.0;
            a.spring.stiffness = super::CLOSE_STIFFNESS;
            a.spring.damping = super::CLOSE_DAMPING;
            true
        });
        if go {
            start_ticker();
        }
    }

    fn start_ticker() {
        if ANIM.with(|a| a.borrow().ticker.is_some()) {
            return;
        }
        let block = RcBlock::new(move |_timer: NonNull<NSTimer>| tick());
        // SAFETY: the timer is added to the main run loop and only ever fires
        // there, which is the one thread the state it touches lives on.
        let timer = unsafe {
            let timer =
                NSTimer::timerWithTimeInterval_repeats_block(super::TICK_SECS, true, &block);
            NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes);
            timer
        };
        ANIM.with(|a| a.borrow_mut().ticker = Some(timer));
    }

    fn stop_ticker() {
        ANIM.with(|a| {
            if let Some(ticker) = a.borrow_mut().ticker.take() {
                ticker.invalidate();
            }
        });
    }

    fn schedule_hold(gen: u64) {
        let block = RcBlock::new(move |_timer: NonNull<NSTimer>| hold_fired(gen));
        // SAFETY: as for the ticker; common modes so a held-open menu does
        // not freeze the peek on screen.
        let timer = unsafe {
            let timer =
                NSTimer::timerWithTimeInterval_repeats_block(super::HOLD_SECS, false, &block);
            NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes);
            timer
        };
        ANIM.with(|a| {
            let mut a = a.borrow_mut();
            if let Some(old) = a.hold.replace(timer) {
                old.invalidate();
            }
        });
    }

    /// Write the outline and content opacity for progress `x`.
    fn draw(x: f64) {
        let Some(layout) = ANIM.with(|a| a.borrow().layout) else {
            return;
        };
        PILL.with(|p| {
            let Some(pill) = p.borrow().as_ref().map(|pill| PillRefs {
                shape: pill.shape.clone(),
                icon: pill.icon.clone(),
                label: pill.label.clone(),
            }) else {
                return;
            };
            let segs = super::outline(layout.body_w, layout.housing_h, x);
            let path = CGMutablePath::new();
            trace(&path, &segs, layout.frame.h);
            CATransaction::begin();
            CATransaction::setDisableActions(true);
            pill.shape.setPath(Some(&path));
            CATransaction::commit();
            let alpha = super::content_alpha(x);
            pill.label.setAlphaValue(alpha);
            if let Some(icon) = &pill.icon {
                icon.setAlphaValue(alpha);
            }
        });
    }

    struct PillRefs {
        shape: Retained<CAShapeLayer>,
        icon: Option<Retained<NSImageView>>,
        label: Retained<NSTextField>,
    }

    /// Trace the outline into `path` in the layer's coordinates (origin
    /// bottom left), from segments given with y growing downward.
    fn trace(path: &CGMutablePath, segs: &[Seg], height: f64) {
        let flip = |y: f64| height - y;
        for seg in segs {
            // SAFETY: a null transform is documented as "no transform", and
            // the path is a live mutable path we own.
            unsafe {
                match *seg {
                    Seg::Move(x, y) => CGMutablePath::move_to_point(Some(path), null(), x, flip(y)),
                    Seg::Line(x, y) => {
                        CGMutablePath::add_line_to_point(Some(path), null(), x, flip(y))
                    }
                    Seg::Quad { cx, cy, x, y } => CGMutablePath::add_quad_curve_to_point(
                        Some(path),
                        null(),
                        cx,
                        flip(cy),
                        x,
                        flip(y),
                    ),
                }
            }
        }
        CGMutablePath::close_subpath(Some(path));
    }

    /// Size the panel, its content view, the mask and the content for `l`.
    fn apply_layout(pill: &Pill, l: Layout) {
        pill.panel.setFrame_display(to_ns_rect(l.frame), true);
        let bounds = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(l.frame.w, l.frame.h));
        if let Some(view) = pill.panel.contentView() {
            view.setFrame(bounds);
        }
        pill.shape.setFrame(bounds);
        pill.label
            .setFrame(to_ns_rect(super::label_frame(l.body_w)));
        if let Some(icon) = &pill.icon {
            icon.setFrame(to_ns_rect(super::icon_frame()));
        }
    }

    /// The screens changed: move the panel, or take it down if the notched
    /// screen is gone.
    fn screens_changed() {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(layout) = layout_from_screens(mtm) else {
            dismiss();
            return;
        };
        let x = ANIM.with(|a| {
            let mut a = a.borrow_mut();
            a.layout = Some(layout);
            a.spring.x
        });
        PILL.with(|p| {
            if let Some(pill) = p.borrow().as_ref() {
                apply_layout(pill, layout);
            }
        });
        draw(x);
    }

    /// Layout for the first NSScreen with a camera housing.
    fn layout_from_screens(mtm: MainThreadMarker) -> Option<Layout> {
        let screens = NSScreen::screens(mtm);
        for i in 0..screens.count() {
            let screen = screens.objectAtIndex(i);
            // The three housing selectors arrived in macOS 12 and the app
            // still ships with a 10.15 floor; an older system has no notch.
            let has_housing_api = [
                sel!(safeAreaInsets),
                sel!(auxiliaryTopLeftArea),
                sel!(auxiliaryTopRightArea),
            ]
            .into_iter()
            .all(|s| screen.respondsToSelector(s));
            if !has_housing_api {
                return None;
            }
            let housing = super::housing(
                from_ns_rect(screen.frame()),
                screen.safeAreaInsets().top,
                from_ns_rect(screen.auxiliaryTopLeftArea()),
                from_ns_rect(screen.auxiliaryTopRightArea()),
            );
            if let Some(h) = housing {
                return Some(Layout {
                    frame: super::panel_frame(h),
                    body_w: h.right - h.left,
                    housing_h: h.height,
                });
            }
        }
        None
    }

    /// Build the panel once. It then lives in the main thread's thread-local
    /// for the rest of the process; there is no teardown hook to hang a close
    /// off, and `setReleasedWhenClosed(false)` keeps AppKit from freeing it
    /// behind the `Retained`.
    fn build(mtm: MainThreadMarker) -> Pill {
        let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
            mtm.alloc::<NSPanel>(),
            NSRect::ZERO,
            NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
            NSBackingStoreType::Buffered,
            false,
        );
        panel.setLevel(NSStatusWindowLevel + 1);
        panel.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        panel.setIgnoresMouseEvents(true);
        panel.setHidesOnDeactivate(false);
        // Cmd-H hides the app, not the music, so a peek in flight finishes.
        panel.setCanHide(false);
        panel.setHasShadow(false);
        panel.setOpaque(false);
        panel.setBackgroundColor(Some(&NSColor::clearColor()));
        // SAFETY: nothing closes this panel, and we hold the only strong
        // reference to it for the life of the process, so opting out of
        // release-on-close cannot leave a dangling Retained.
        unsafe { panel.setReleasedWhenClosed(false) };

        let view = NSView::initWithFrame(mtm.alloc::<NSView>(), NSRect::ZERO);
        view.setWantsLayer(true);
        let black = CGColor::new_generic_gray(0.0, 1.0);
        let shape = CAShapeLayer::new();
        shape.setFillColor(Some(&black));
        if let Some(layer) = view.layer() {
            layer.setBackgroundColor(Some(&black));
            // SAFETY: the mask is a layer we own for as long as the view.
            unsafe { layer.setMask(Some(&shape)) };
        }
        panel.setContentView(Some(&view));

        let icon = NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &NSString::from_str("music.note"),
            None,
        )
        .map(|image| {
            let icon = NSImageView::imageViewWithImage(&image, mtm);
            icon.setContentTintColor(Some(&NSColor::whiteColor()));
            view.addSubview(&icon);
            icon
        });

        let label = NSTextField::labelWithString(&NSString::from_str(""), mtm);
        label.setTextColor(Some(&NSColor::whiteColor()));
        // SAFETY: NSFontWeightMedium is an AppKit extern constant, initialised
        // before any code of ours runs.
        let weight = unsafe { NSFontWeightMedium };
        label.setFont(Some(&NSFont::systemFontOfSize_weight(
            super::FONT_SIZE,
            weight,
        )));
        label.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
        label.setDrawsBackground(false);
        label.setBezeled(false);
        view.addSubview(&label);

        let block = RcBlock::new(move |_note: NonNull<NSNotification>| {
            screens_changed();
        });
        // SAFETY: the notification name is an AppKit extern constant; the
        // block is only ever run on the main queue we pass here, which is
        // where every AppKit object it touches already lives.
        let observer = unsafe {
            let name = NSApplicationDidChangeScreenParametersNotification;
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(name),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        };

        Pill {
            panel,
            shape,
            icon,
            label,
            _screens_observer: observer,
        }
    }

    fn to_ns_rect(r: super::Rect) -> NSRect {
        NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.w, r.h))
    }

    fn from_ns_rect(r: NSRect) -> super::Rect {
        super::Rect {
            x: r.origin.x,
            y: r.origin.y,
            w: r.size.width,
            h: r.size.height,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn this_mac() -> Housing {
        housing(
            Rect {
                x: 0.0,
                y: 0.0,
                w: 1710.0,
                h: 1112.0,
            },
            38.0,
            Rect {
                x: 0.0,
                y: 1074.0,
                w: 751.0,
                h: 38.0,
            },
            Rect {
                x: 960.0,
                y: 1074.0,
                w: 750.0,
                h: 38.0,
            },
        )
        .expect("this Mac has a housing")
    }

    #[test]
    fn this_mac_housing_and_panel() {
        let h = this_mac();
        assert_eq!(
            h,
            Housing {
                left: 751.0,
                right: 960.0,
                top: 1112.0,
                height: 38.0
            }
        );
        assert_eq!(
            panel_frame(h),
            Rect {
                x: 745.0,
                y: 1042.0,
                w: 221.0,
                h: 70.0
            }
        );
    }

    #[test]
    fn no_safe_area_is_not_a_housing() {
        let screen = Rect {
            x: 0.0,
            y: 0.0,
            w: 2560.0,
            h: 1440.0,
        };
        let aux = Rect {
            x: 0.0,
            y: 1416.0,
            w: 1280.0,
            h: 24.0,
        };
        assert_eq!(housing(screen, 0.0, aux, aux), None);
    }

    #[test]
    fn empty_auxiliary_areas_are_not_a_housing() {
        let screen = Rect {
            x: 0.0,
            y: 0.0,
            w: 1710.0,
            h: 1112.0,
        };
        let empty = Rect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        };
        assert_eq!(housing(screen, 38.0, empty, empty), None);
    }

    #[test]
    fn screen_origin_is_respected() {
        let h = housing(
            Rect {
                x: -1710.0,
                y: 200.0,
                w: 1710.0,
                h: 1112.0,
            },
            38.0,
            Rect {
                x: -1710.0,
                y: 1274.0,
                w: 751.0,
                h: 38.0,
            },
            Rect {
                x: -750.0,
                y: 1274.0,
                w: 750.0,
                h: 38.0,
            },
        )
        .unwrap();
        assert_eq!(h.left, -959.0);
        assert_eq!(h.right, -750.0);
        assert_eq!(h.top, 1312.0);
    }

    fn points(segs: &[Seg]) -> Vec<(f64, f64)> {
        segs.iter()
            .map(|s| match *s {
                Seg::Move(x, y) | Seg::Line(x, y) => (x, y),
                Seg::Quad { x, y, .. } => (x, y),
            })
            .collect()
    }

    #[test]
    fn closed_outline_hides_inside_the_housing() {
        let segs = outline(209.0, 38.0, 0.0);
        for (x, y) in points(&segs) {
            assert!((EAR..=EAR + 209.0).contains(&x), "x {x}");
            assert!((0.0..=38.0).contains(&y), "y {y}");
        }
        assert_eq!(segs[0], Seg::Move(EAR, 0.0));
    }

    #[test]
    fn open_outline_fills_the_panel() {
        let segs = outline(209.0, 38.0, 1.0);
        let pts = points(&segs);
        let min_x = pts.iter().map(|p| p.0).fold(f64::MAX, f64::min);
        let max_x = pts.iter().map(|p| p.0).fold(f64::MIN, f64::max);
        let max_y = pts.iter().map(|p| p.1).fold(f64::MIN, f64::max);
        assert_eq!((min_x, max_x, max_y), (0.0, 221.0, 70.0));
    }

    #[test]
    fn outline_topology_never_changes() {
        let kind = |s: &Seg| match s {
            Seg::Move(..) => 0,
            Seg::Line(..) => 1,
            Seg::Quad { .. } => 2,
        };
        let closed: Vec<_> = outline(209.0, 38.0, 0.0).iter().map(kind).collect();
        for t in [0.1, 0.5, 0.99, 1.0, 1.7, -0.3] {
            let now: Vec<_> = outline(209.0, 38.0, t).iter().map(kind).collect();
            assert_eq!(now, closed, "t {t}");
        }
    }

    #[test]
    fn content_sits_in_the_dropped_strip() {
        let label = label_frame(209.0);
        assert_eq!(label.x, EAR + PAD + ICON + GAP);
        assert_eq!(label.w, 209.0 - 2.0 * PAD - ICON - GAP);
        assert_eq!(label.y + label.h / 2.0, DROP / 2.0);
        assert_eq!(icon_frame().y + ICON / 2.0, DROP / 2.0);
        assert_eq!(label_frame(10.0).w, 0.0);
    }

    #[test]
    fn content_fades_in_late() {
        assert_eq!(content_alpha(0.0), 0.0);
        assert_eq!(content_alpha(0.5), 0.0);
        assert_eq!(content_alpha(1.0), 1.0);
        assert!(content_alpha(0.8) > 0.0 && content_alpha(0.8) < 1.0);
    }

    fn run(mut s: Spring) -> (f64, f64, usize) {
        let mut peak = f64::MIN;
        let mut ticks = 0;
        loop {
            ticks += 1;
            let settled = s.step(TICK_SECS);
            peak = peak.max(s.x);
            if settled || ticks > 600 {
                return (s.x, peak, ticks);
            }
        }
    }

    #[test]
    fn open_spring_settles_within_a_second_with_a_small_bounce() {
        let (x, peak, ticks) = run(Spring {
            x: 0.0,
            v: 0.0,
            target: 1.0,
            stiffness: OPEN_STIFFNESS,
            damping: OPEN_DAMPING,
        });
        assert_eq!(x, 1.0);
        assert!(ticks < 60, "ticks {ticks}");
        assert!(peak > 1.0 && peak < 1.06, "peak {peak}");
    }

    #[test]
    fn close_spring_never_overshoots_into_the_housing() {
        let (x, _, ticks) = run(Spring {
            x: 1.0,
            v: 0.0,
            target: 0.0,
            stiffness: CLOSE_STIFFNESS,
            damping: CLOSE_DAMPING,
        });
        assert_eq!(x, 0.0);
        assert!(ticks < 60, "ticks {ticks}");
        let mut s = Spring {
            x: 1.0,
            v: 0.0,
            target: 0.0,
            stiffness: CLOSE_STIFFNESS,
            damping: CLOSE_DAMPING,
        };
        for _ in 0..120 {
            s.step(TICK_SECS);
            assert!(s.x >= 0.0, "x {}", s.x);
        }
    }

    #[test]
    fn tracker_peeks_a_new_song_once_it_starts() {
        let mut t = Tracker::default();
        assert_eq!(t.observe("Kabira", "Arijit Singh", false, false), None);
        assert_eq!(
            t.observe("Kabira", "Arijit Singh", false, true),
            Some("Kabira \u{00b7} Arijit Singh".to_string())
        );
        assert_eq!(t.observe("Kabira", "Arijit Singh", false, true), None);
        assert_eq!(t.observe("Kabira", "Arijit Singh", true, true), None);
        assert_eq!(t.observe("Kabira", "Arijit Singh", false, true), None);
    }

    #[test]
    fn tracker_waits_while_paused_and_ignores_empty_titles() {
        let mut t = Tracker::default();
        assert_eq!(t.observe("Piche Tere", "Kunwarr", true, true), None);
        assert_eq!(
            t.observe("Piche Tere", "Kunwarr", false, true),
            Some("Piche Tere \u{00b7} Kunwarr".to_string())
        );
        assert_eq!(t.observe("  ", "Kunwarr", false, true), None);
        assert_eq!(
            t.observe("Tasveer", "", false, true),
            Some("Tasveer".to_string())
        );
    }

    #[test]
    fn tracker_clear_makes_the_same_song_new_again() {
        let mut t = Tracker::default();
        assert!(t.observe("Kabira", "Arijit Singh", false, true).is_some());
        t.clear();
        assert!(t.observe("Kabira", "Arijit Singh", false, true).is_some());
    }

    #[test]
    fn the_started_flag_beats_a_moving_position() {
        assert!(!audio_started(Some(false), 12.0));
        assert!(audio_started(Some(true), 0.0));
        assert!(!audio_started(None, 0.0));
        assert!(audio_started(None, 0.5));
    }

    #[test]
    fn pill_text_joins_title_and_artist() {
        assert_eq!(
            pill_text(" Kabira ", Some("Arijit Singh")),
            "Kabira \u{00b7} Arijit Singh"
        );
        assert_eq!(pill_text("Kabira", None), "Kabira");
        assert_eq!(pill_text("Kabira", Some("  ")), "Kabira");
    }
}
