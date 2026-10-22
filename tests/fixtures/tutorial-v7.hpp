#pragma once
#include "tools_mode.hpp"
#include <array>
#include <functional>

namespace preview {
inline constexpr int tutorialVersion = 7;
enum class TutorialTarget {
    Open,
    Save,
    Navigation,
    AutoRotate,
    Guides,
    Lens,
    Capture,
    Thumbnail,
    Tools,
    UndoRedo,
    Settings,
    AgentAccess,
    Modes,
    Scope,
    Histogram,
    Single,
    Brushes,
    Area,
    ColorSelect,
    Fill,
    Combine,
    Refine,
    Actions,
    SelectionEdits,
    Duplicate,
    CurrentView,
    Options,
    Range,
    SelectionFinish,
    CleanupReset,
    Filter,
    AutoColor,
    Presets,
    ColorSlider,
    ProColor,
    ColorReset,
    PickCenter,
    ScaleAlign,
    PlaneAlign,
    Floor,
    Gizmo,
    TransformMode,
    Coordinates,
    SnapFlips,
    Pivot,
    TransformValues,
    TransformReset
};
using TutorialAnchor = std::function<void(TutorialTarget)>;
struct TutorialStep {
    const char *title;
    const char *text;
    TutorialTarget target;
    const char *section{};
    bool tools{};
    ToolsMode mode{ToolsMode::Pro}; // One complete preview; never changes the user's mode.
};
inline constexpr std::array tutorialSteps{
    TutorialStep{"Open a scene", "Open a splat to edit, or another PLY to view.", TutorialTarget::Open},
    TutorialStep{"Save scene",
                 "Save edits and the current view. Choose a file and format; use a new name to keep the "
                 "original. Overwriting asks first.",
                 TutorialTarget::Save},
    TutorialStep{"Set Explorer thumbnail",
                 "Frame the view, then click Set thumbnail (T). Saves the Explorer thumbnail, default view "
                 "and background.",
                 TutorialTarget::Thumbnail},
    TutorialStep{"Capture and copy", "Capture saves an image. Copy sends it to the clipboard (Ctrl+C).",
                 TutorialTarget::Capture},
    TutorialStep{"Navigate",
                 "Drag to orbit, right-drag to pan, scroll to zoom. V: Orbit/Look. R: reset view.",
                 TutorialTarget::Navigation},
    TutorialStep{"Orbit and flip", "O: auto orbit. F: flip the camera's up direction.",
                 TutorialTarget::AutoRotate},
    TutorialStep{
        "Guides and background",
        "Cycle grid/axes and the black, gray or white background swatch. Guides stay out of saved images.",
        TutorialTarget::Guides},
    TutorialStep{"Lens and fullscreen",
                 "Adjust field of view. F11: fullscreen. Esc: exit. Page Up/Down: browse files.",
                 TutorialTarget::Lens},
    TutorialStep{"Agent access",
                 "Click the robot to enable access and copy a prompt. Paste it into your agent terminal. "
                 "Normal launches start off; agents save new files only.",
                 TutorialTarget::AgentAccess},
    TutorialStep{"Tools", "Selection, Transform and Color tools.", TutorialTarget::Tools},
    TutorialStep{"Undo and redo", "Ctrl+Z: undo. Ctrl+Y: redo.", TutorialTarget::UndoRedo, nullptr, true},
    TutorialStep{"Settings", "Choose language, theme, text size and privacy. Replay the tour in Help.",
                 TutorialTarget::Settings, nullptr, true},
    TutorialStep{
        "Basic and Pro",
        "Basic has selection, alignment, gizmos and color. Pro adds filters and precise controls. This tour "
        "shows Pro without changing your mode.",
        TutorialTarget::Modes, nullptr, true},
    TutorialStep{"Edit scope",
                 "Color and manual transforms use the selection, or the whole scene when empty. Alignment "
                 "always moves the whole scene.",
                 TutorialTarget::Scope, nullptr, true},
    TutorialStep{"Histogram", "RGB distribution of the current view: shadows left, highlights right.",
                 TutorialTarget::Histogram, nullptr, true},
    TutorialStep{"Reset cleanup", "Restore hidden splats and clear selection.", TutorialTarget::CleanupReset,
                 "Selection", true},
    TutorialStep{"Single splat",
                 "Click the rendered surface to select its strongest splat. Middle-drag to orbit.",
                 TutorialTarget::Single, "Selection", true},
    TutorialStep{"Brushes", "B: screen brush. Shift+B: 3D brush. Alt+scroll: brush size.",
                 TutorialTarget::Brushes, "Selection", true},
    TutorialStep{"Rectangle and polygon",
                 "X: drag a rectangle. P: click or draw a polygon. Enter: close. Backspace: undo point.",
                 TutorialTarget::Area, "Selection", true},
    TutorialStep{
        "Color picker",
        "Pick matching colors (Ctrl+E). Connected colors stays in one region. Tolerance updates live.",
        TutorialTarget::ColorSelect, "Selection", true},
    TutorialStep{
        "Fill select",
        "Click a connected patch in the current view (Ctrl+G). Lower tolerance keeps the selection tighter.",
        TutorialTarget::Fill, "Selection", true},
    TutorialStep{"Filters in Pro", "Choose one filter at a time. A new filter replaces the draft.",
                 TutorialTarget::Filter, "Selection", true},
    TutorialStep{"Combine selections",
                 "1-4: Replace, Add, Subtract, Intersect. Shift adds, Ctrl subtracts; both intersect.",
                 TutorialTarget::Combine, "Selection", true},
    TutorialStep{"Grow and shrink",
                 "Grow adds neighbors; Shrink removes boundary splats. Choose Volume or Sigma. Hover the "
                 "slider: blue adds, red removes.",
                 TutorialTarget::Refine, "Selection", true, ToolsMode::Pro},
    TutorialStep{"Selection options",
                 "Options follows the tool: size, tolerance, visibility or live selection. Highlighted "
                 "icons are on.",
                 TutorialTarget::Options, "Selection", true},
    TutorialStep{"Selection range",
                 "Turn on the sphere in Options. Preview follows the cursor before clicking; Radius updates "
                 "the same selection.",
                 TutorialTarget::Range, "Selection", true},
    TutorialStep{"Selection actions", "All selects every splat. None clears. Invert swaps selected splats.",
                 TutorialTarget::Actions, "Selection", true},
    TutorialStep{"Current view only",
                 "Toggle the frustum beside Invert to limit selection and selected edits to the current "
                 "view. Starts off.",
                 TutorialTarget::CurrentView, "Selection", true},
    TutorialStep{"Delete and keep", "Delete hides selected splats. Keep hides everything else. Ctrl+Z: undo.",
                 TutorialTarget::SelectionEdits, "Selection", true},
    TutorialStep{"Duplicate selection",
                 "Pro: duplicate selected splats, then move the green copy. Editing it turns it yellow.",
                 TutorialTarget::Duplicate, "Selection", true},
    TutorialStep{"Confirm a filter",
                 "Adjust limits or a volume. Volume filters have a target icon to pick the center. Check "
                 "confirms; Esc restores the starting selection.",
                 TutorialTarget::Filter, "Selection", true, ToolsMode::Pro},
    TutorialStep{"Finish, undo or clear",
                 "Check keeps the selection and exits. Undo reverses the last action. X clears. Right-click "
                 "clears, then exits when empty.",
                 TutorialTarget::SelectionFinish, "Selection", true},
    TutorialStep{
        "Reset transform",
        "Reset alignment, axis flips and transforms. Ctrl+Z restores them. Save a copy when finished.",
        TutorialTarget::TransformReset, "Transform", true},
    TutorialStep{"1-point center",
                 "Pick a point, then confirm. The whole scene moves; the view stays framed.",
                 TutorialTarget::PickCenter, "Transform", true},
    TutorialStep{"2-point scale", "Pick two points, enter their target distance in meters, then confirm.",
                 TutorialTarget::ScaleAlign, "Transform", true},
    TutorialStep{"3-point align", "Pick three points. Check the normal arrow, flip if needed, then confirm.",
                 TutorialTarget::PlaneAlign, "Transform", true},
    TutorialStep{"Level floor",
                 "Detect the floor, check its normal, then confirm. Use 3-point align if needed.",
                 TutorialTarget::Floor, "Transform", true},
    TutorialStep{"Rotation format", "Pro: choose Euler angles, quaternion, axis-angle or matrix entry.",
                 TutorialTarget::TransformMode, "Transform", true},
    TutorialStep{
        "Move, rotate and scale",
        "Choose a gizmo, then drag a handle. Check keeps edits; Undo reverses a drag; X cancels the session.",
        TutorialTarget::Gizmo, "Transform", true},
    TutorialStep{"Transform axes", "Pro: switch between world and local axes. Basic uses world axes.",
                 TutorialTarget::Coordinates, "Transform", true},
    TutorialStep{
        "Snap and axis flips",
        "Use the magnet or hold Ctrl to snap. Flip X/Y/Z changes orientation. Available in Basic and Pro.",
        TutorialTarget::SnapFlips, "Transform", true},
    TutorialStep{"Transform pivot", "Pro: cycle the pivot through scene center, selection center and origin.",
                 TutorialTarget::Pivot, "Transform", true},
    TutorialStep{"Exact transforms",
                 "Pro: type translation, scale, pivot and rotation values. Distances are in meters.",
                 TutorialTarget::TransformValues, "Transform", true, ToolsMode::Pro},
    TutorialStep{"Reset color", "Reset color and opacity. Ctrl+Z restores the previous values.",
                 TutorialTarget::ColorReset, "Color", true},
    TutorialStep{"Auto color",
                 "Hover to preview the image and histogram. Click to apply and update the sliders.",
                 TutorialTarget::AutoColor, "Color", true},
    TutorialStep{"Color presets",
                 "Hover to preview; click to apply. A dot marks the active preset. Pro offers more.",
                 TutorialTarget::Presets, "Color", true},
    TutorialStep{"Color sliders",
                 "Right-click a slider to type a value. Temperature: -100 cool, 0 neutral, +100 warm.",
                 TutorialTarget::ColorSlider, "Color", true},
    TutorialStep{"More color controls",
                 "Pro adds gamma, vibrance, tint, shadows, highlights, hue and Fade / boost. They stay "
                 "active in Basic.",
                 TutorialTarget::ProColor, "Color", true, ToolsMode::Pro}};
} // namespace preview
