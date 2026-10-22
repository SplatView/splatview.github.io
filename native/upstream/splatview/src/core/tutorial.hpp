#pragma once
#include <array>
#include <functional>

namespace preview {
inline constexpr int tutorialVersion = 2;
enum class TutorialTarget {
    None,
    Open,
    Save,
    Navigation,
    Reset,
    AutoRotate,
    Flip,
    Lens,
    Capture,
    Copy,
    Thumbnail,
    Fullscreen,
    Tools,
    Modes,
    AutoColor,
    ColorSlider,
    Scope,
    Cleanup,
    DeleteClear,
    PickCenter,
    Floor,
    UndoRedo,
    Pro
};
using TutorialAnchor = std::function<void(TutorialTarget)>;
struct TutorialStep {
    const char *title;
    const char *text;
    TutorialTarget target;
    const char *section{};
    bool tools{};
};
inline constexpr std::array tutorialSteps{
    TutorialStep{"Open a scene", "Choose a local splat file to view or edit.", TutorialTarget::Open},
    TutorialStep{"Save a copy", "Export your edits to a new file. Choose the format in Save.",
                 TutorialTarget::Save},
    TutorialStep{"Orbit or Look", "Switch navigation modes. Drag to rotate; scroll to zoom.",
                 TutorialTarget::Navigation},
    TutorialStep{"Reset view", "Return to the saved default view. Shortcut: R.", TutorialTarget::Reset},
    TutorialStep{"Orbit center", "Start or stop slow rotation around the center. Shortcut: O.",
                 TutorialTarget::AutoRotate},
    TutorialStep{"Flip up", "Turn an upside-down scene upright. Shortcut: F.", TutorialTarget::Flip},
    TutorialStep{"Field of view", "Narrow or widen the lens without moving the camera.",
                 TutorialTarget::Lens},
    TutorialStep{"Capture image", "Save the rendered view as a JPEG at quality 95.", TutorialTarget::Capture},
    TutorialStep{"Copy image", "Copy the rendered view to the clipboard. Shortcut: Ctrl+C.",
                 TutorialTarget::Copy},
    TutorialStep{"Update Thumbnail", "Use this view for the thumbnail and the default camera. Shortcut: T.",
                 TutorialTarget::Thumbnail},
    TutorialStep{"Fullscreen", "Fill the screen. Press F11 to toggle or Esc to leave.",
                 TutorialTarget::Fullscreen},
    TutorialStep{"Tools", "Show or hide the editing panel.", TutorialTarget::Tools},
    TutorialStep{"Basic and Pro", "Basic keeps everyday tools simple. Pro shows every feature.",
                 TutorialTarget::Modes, nullptr, true},
    TutorialStep{"Auto color", "Balance brightness, contrast and white balance automatically.",
                 TutorialTarget::AutoColor, "Color", true},
    TutorialStep{"Color sliders", "Adjust color live. Right-click a slider to type an exact value.",
                 TutorialTarget::ColorSlider, "Color", true},
    TutorialStep{"Edit scope", "Edits affect selected splats. Clear selection to edit the whole scene.",
                 TutorialTarget::Scope, nullptr, true},
    TutorialStep{"Brush and Box",
                 "Choose Brush or Box. Shift adds; Ctrl subtracts; Alt+scroll resizes the brush.",
                 TutorialTarget::Cleanup, "Cleanup", true},
    TutorialStep{"Clear or delete", "Clear deselects splats. Delete removes them; Ctrl+Z undoes.",
                 TutorialTarget::DeleteClear, "Cleanup", true},
    TutorialStep{"Pick center", "Pick the highlighted point, then confirm Set center.",
                 TutorialTarget::PickCenter, "Alignment", true},
    TutorialStep{"Level floor", "Detect the floor, preview the result, then confirm leveling.",
                 TutorialTarget::Floor, "Alignment", true},
    TutorialStep{"Undo and redo", "Undo or redo edits. Shortcuts: Ctrl+Z / Ctrl+Y.", TutorialTarget::UndoRedo,
                 nullptr, true},
    TutorialStep{"More in Pro", "Switch to Pro for filters, gizmos, precise alignment and measurements.",
                 TutorialTarget::Pro, nullptr, true}};
} // namespace preview
