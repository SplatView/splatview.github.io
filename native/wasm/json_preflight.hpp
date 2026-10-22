#pragma once

#include <cstddef>
#include <string_view>
#include <nlohmann/json.hpp>

namespace sv_json {

enum class PreflightStatus {
    Ok, ByteLimit, Utf8, Depth, Structural, InvalidLimits,
    TokenLimit, StringLimit, NumberLimit, Nonfinite
};

// These are qualification bounds for one parsed SOG owner, not new input or
// command limits. Inputs outside them retain the ordinary iterative JSON path.
struct MetadataLimits {
    std::size_t maxBytes{16 * 1024 * 1024}, maxDepth{32}, maxTokens{65536};
    std::size_t maxStringUnits{1048576}, maxTotalStringUnits{4194304};
    std::size_t maxNumberCharacters{128};
};
inline constexpr MetadataLimits defaultMetadataLimits{};

struct MetadataCensus {
    std::size_t tokens{}, stringUnits{}, maxDepth{};
};
struct MetadataPreflight {
    PreflightStatus status{PreflightStatus::Ok};
    MetadataCensus census{}; // Published only after the entire input qualifies.
    std::size_t errorOffset{};
    explicit operator bool() const noexcept { return status == PreflightStatus::Ok; }
};

// Complete nonrecursive, allocation-free UTF-8/JSON grammar and decoded UTF-16
// census, including duplicate keys and values that a later parse overwrites.
// Custom bounds may only tighten the qualification defaults.
MetadataPreflight preflightSogJson(std::string_view, MetadataLimits = {}) noexcept;
std::size_t preflightFixedArrayBytes() noexcept;

// The actual SOG parser's sole metadata owner. No supplied census, activation
// guard or mutable DOM accessor can authorize recursive destruction. The actual
// loadSog callgraph borrows get() without copying or constructing other DOMs.
// Unqualified compatibility parsing explicitly masks any outer authority.
class ParsedSogMetadata final {
  public:
    explicit ParsedSogMetadata(std::string_view);
    ~ParsedSogMetadata() = default;
    ParsedSogMetadata(const ParsedSogMetadata &) = delete;
    ParsedSogMetadata &operator=(const ParsedSogMetadata &) = delete;
    ParsedSogMetadata(ParsedSogMetadata &&) = delete;
    ParsedSogMetadata &operator=(ParsedSogMetadata &&) = delete;

    const nlohmann::json &get() const noexcept { return dom_; }
    const MetadataPreflight &qualification() const noexcept { return qualification_; }

  private:
    class Authority final {
      public:
        explicit Authority(bool) noexcept;
        ~Authority() noexcept;
        Authority(const Authority &) = delete;
        Authority &operator=(const Authority &) = delete;
        Authority(Authority &&) = delete;
        Authority &operator=(Authority &&) = delete;
      private:
        bool previous_;
    };

    const MetadataPreflight qualification_;
    // Declaration order is part of the cleanup contract. Parse temporaries and
    // dom_ must be destroyed before their qualified or masked authority retires.
    const Authority authority_;
    const nlohmann::json dom_;
};

// The six-filter adapter borrows this owner's DOM. Complete bounded grammar is
// proved before parsing, so request cleanup performs no stack-vector allocation.
// Nonfilter legacy commands may still use the unqualified iterative path.
class ParsedFilterCommand final {
  public:
    explicit ParsedFilterCommand(std::string_view);
    ~ParsedFilterCommand()=default;
    ParsedFilterCommand(const ParsedFilterCommand &)=delete;
    ParsedFilterCommand &operator=(const ParsedFilterCommand &)=delete;
    const nlohmann::json &get() const noexcept { return dom_; }
    bool qualified() const noexcept { return static_cast<bool>(qualification_); }
  private:
    class Authority final {
      public:
        explicit Authority(bool) noexcept;
        ~Authority() noexcept;
        Authority(const Authority &)=delete;
        Authority &operator=(const Authority &)=delete;
      private: bool previous_;
    };
    const MetadataPreflight qualification_;
    const Authority authority_;
    const nlohmann::json dom_;
};

} // namespace sv_json

// Read-only hook used by the single reviewed generated nlohmann header. This
// cannot activate authority. Outside a ParsedSogMetadata lifetime it is false.
bool sv_json_bounded_recursive_destroy_active() noexcept;
