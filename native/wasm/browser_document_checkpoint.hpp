#pragma once
#include "browser_color_session.hpp"
#include "browser_alignment_session.hpp"
#include "browser_transform_session.hpp"
#include "browser_opacity_session.hpp"
#include "browser_duplicate.hpp"
#include "editing.hpp"
#include "resource_budget.hpp"
#include <array>
#include <memory>
#include <optional>
#include <span>

namespace preview::browser_checkpoint {
// Internal payload version; the external chunk/hash-tree owner is unchanged.
inline constexpr unsigned version=3;
inline constexpr size_t maximumChunkBytes=1024*1024;
inline constexpr uint64_t maximumIdentity=9007199254740991ULL;
// Scalar lifetime fences are deliberately outside SceneEdits/transaction state.
struct Identities {
    uint64_t document{};
    // Next color/alignment/floor/filter/transform/opacity identity, in that order.
    std::array<uint64_t,6> next{};
    uint64_t tolerance{},selectionMap{};
    std::array<std::array<uint64_t,2>,2> filterAttempts{},transformAttempts{},opacityAttempts{};
};
struct Source {
    const SceneEdits *edits{};
    std::shared_ptr<const Scene> geometry;
    const browser_color_metadata::BrowserColorSession *color{};
    const browser_alignment::Session *alignment{};
    const browser_alignment::Lineage *lineage{};
    const std::optional<browser_transform::Owner> *transform{};
    const std::optional<browser_opacity::Owner> *opacity{};
    Identities identities;
    // Informational: owners/jobs are not restored. Applied document/history and
    // numeric absolute-session bases remain; gizmo owners are normalized away
    // and a selection draft restores its baseline. Codec3 stays unchanged.
    uint32_t transientFlags{};
    // Marker lifetime belongs to each immutable Scene, including retained history
    // and tool bases. Keep this trailing field explicit at binding call sites.
    const browser_duplicate::Lineage *duplicateLineage{};
};
struct Description {
    size_t byteLength{},workspaceBytes{},sceneCount{},maskCount{};
    size_t currentLoadedCount{},maximumGraphSplats{1};
    uint64_t currentSourceCount{};
    std::optional<browser_duplicate::Range> currentDuplicateRange;
    uint32_t normalizationFlags{};
    uint64_t revision{},contentRevision{},nextContentRevision{};
    std::array<uint8_t,32> sha256{}; // Payload digest; header itself is explicit.
    std::array<uint8_t,32> headerSha256{};
};
class Plan final {
  public:
    Plan(const Source &,ResourceBudget);
    ~Plan();
    Plan(const Plan &)=delete;
    Plan &operator=(const Plan &)=delete;
    const Description &description() const noexcept;
    std::span<const uint8_t> read(size_t offset,size_t count);
  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
struct Candidate {
    explicit Candidate(ResourceBudget resources):budget(std::move(resources)) {}
    ResourceBudget budget;
    ResourceReservation metadata;
    std::unique_ptr<SceneEdits> edits;
    std::shared_ptr<const Scene> geometry;
    browser_color_metadata::BrowserColorSession color;
    browser_alignment::Session alignment;
    browser_alignment::Lineage lineage;
    browser_duplicate::Lineage duplicateLineage;
    std::optional<browser_transform::Owner> transform;
    std::optional<browser_opacity::Owner> opacity;
    Identities identities;
    uint32_t normalizationFlags{};
};
class Restore final {
  public:
    // Derived from the exact accepted plan plus the immutable import binding.
    // Counts may exceed the original loaded subset, but not this graph's exact
    // authenticated maximum. No unchecked size-only restore overload exists.
    struct Expected {
        unsigned codecVersion{version};
        size_t currentLoadedCount{},maximumGraphSplats{};
        uint64_t currentSourceCount{},originalSourceCount{};
        std::optional<browser_duplicate::Range> currentDuplicateRange;
        uint64_t revision{},contentRevision{},nextContentRevision{};
    };
    Restore(size_t totalBytes,const Expected &,unsigned budgetBytes,size_t previousBytes);
    ~Restore();
    Restore(const Restore &)=delete;
    Restore &operator=(const Restore &)=delete;
    void write(size_t offset,std::span<const uint8_t>);
    Candidate finish();
    size_t written() const noexcept;
    size_t total() const noexcept;
    size_t publicationRetiredBytes() const noexcept;
  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
// Access to browser-only session metadata. Portable-core access remains in the
// single BrowserSelectionAccess friend injected into the disposable overlay.
struct Access {
    struct Color {
        std::shared_ptr<const Scene> base;
        browser_color_metadata::Context acknowledged;
        ColorValues applied{neutralColor};
        uint64_t sessionId{},baseId{},baseContentRevision{},epochId{},valuesId{};
        bool selectedOnly{};
        MaskStorage effectiveStates;
    };
    struct Alignment {
        std::shared_ptr<const Scene> base;
        MaskStorage states;
        browser_alignment::Context acknowledged;
    };
    static Color color(const browser_color_metadata::BrowserColorSession &) noexcept;
    static void color(browser_color_metadata::BrowserColorSession &,Color) noexcept;
    static Alignment alignment(const browser_alignment::Session &) noexcept;
    static void alignment(browser_alignment::Session &,Alignment) noexcept;
    static uint64_t next(const browser_color_metadata::IdSequence &) noexcept;
    static uint64_t next(const browser_alignment::IdSequence &) noexcept;
    static void next(browser_color_metadata::IdSequence &,uint64_t) noexcept;
    static void next(browser_alignment::IdSequence &,uint64_t) noexcept;
};
} // namespace preview::browser_checkpoint
