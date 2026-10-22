#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <string_view>
#include <type_traits>

// Live-worker proof only. This fixed storage cannot reconstruct a terminated
// module. No receipt operation allocates or changes the frozen edit algorithms.
namespace sv_operation {
inline constexpr std::uint64_t maximumIdentity=9007199254740991ULL;
struct Uuid {
    std::array<char,36> bytes{};
    std::string_view view() const noexcept { return {bytes.data(),bytes.size()}; }
    friend bool operator==(const Uuid &,const Uuid &)=default;
};
inline bool validUuid(std::string_view text) noexcept {
    if(text.size()!=36) return false;
    for(std::size_t i=0;i<text.size();++i) {
        if(i==8||i==13||i==18||i==23) { if(text[i]!='-') return false; }
        else if(!((text[i]>='0'&&text[i]<='9')||(text[i]>='a'&&text[i]<='f')||(text[i]>='A'&&text[i]<='F'))) return false;
    }
    return true;
}
struct Scope {
    Uuid documentId,clientGeneration;
    std::uint64_t sourceGeneration{};
    friend bool operator==(const Scope &,const Scope &)=default;
};
struct Owner {
    Scope scope;
    std::uint64_t operationId{};
    friend bool operator==(const Owner &,const Owner &)=default;
};
inline bool valid(const Scope &s) noexcept {
    return validUuid(s.documentId.view())&&validUuid(s.clientGeneration.view())&&s.sourceGeneration&&s.sourceGeneration<=maximumIdentity;
}
inline bool valid(const Owner &o) noexcept { return valid(o.scope)&&o.operationId&&o.operationId<=maximumIdentity; }
struct State {
    std::uint64_t revision{},contentRevision{};
    std::size_t count{};
    std::uint64_t sourceCount{};
    bool hasDuplicateRange{};
    std::size_t duplicateFirst{},duplicateCount{};
    std::size_t selected{},visible{};
    bool canUndo{},canRedo{},transaction{},selectionDraft{},pending{};
    std::optional<std::uint64_t> toleranceSessionId,toleranceMapId,selectionMapId,pendingSelectionMapId;
    std::array<std::uint64_t,5> selectionMapRetainedIds{};
    std::size_t selectionMapRetainedCount{};
    friend bool operator==(const State &,const State &)=default;
};
inline bool valid(const State &s) noexcept {
    if(s.count>std::numeric_limits<uint32_t>::max()||s.sourceCount>std::numeric_limits<uint32_t>::max()||
       s.sourceCount<s.count||s.selected>s.visible||s.visible>s.count||
       (s.hasDuplicateRange?(!s.duplicateCount||s.duplicateFirst>s.count||s.duplicateCount!=s.count-s.duplicateFirst):
                            (s.duplicateFirst||s.duplicateCount)))return false;
    if(s.revision>maximumIdentity||s.contentRevision>maximumIdentity||s.selected>maximumIdentity||s.visible>maximumIdentity||
       s.selectionMapRetainedCount>s.selectionMapRetainedIds.size()) return false;
    for(const auto &id:{s.toleranceSessionId,s.toleranceMapId,s.selectionMapId,s.pendingSelectionMapId})
        if(id&&(!*id||*id>maximumIdentity)) return false;
    for(std::size_t i=0;i<s.selectionMapRetainedCount;++i) {
        const auto id=s.selectionMapRetainedIds[i];if(!id||id>maximumIdentity) return false;
        for(std::size_t j=0;j<i;++j) if(s.selectionMapRetainedIds[j]==id) return false;
    }
    return true;
}
enum class Outcome { Active,Committed,RolledBack,NotStarted,ExpiredConflict };
inline std::string_view name(Outcome o) noexcept {
    switch(o) {
    case Outcome::Active:return "active";
    case Outcome::Committed:return "committed";
    case Outcome::RolledBack:return "rolled-back";
    case Outcome::NotStarted:return "not-started";
    default:return "expired-conflict";
    }
}
struct Receipt {
    Owner owner;
    Outcome outcome{Outcome::ExpiredConflict};
    std::optional<State> before,terminal;
};
inline bool valid(const Receipt &r) noexcept {
    if(!valid(r.owner)) return false;
    if(r.outcome==Outcome::ExpiredConflict) return !r.before&&!r.terminal;
    if(!r.before||!valid(*r.before)||r.before->transaction) return false;
    if(r.outcome==Outcome::Active) return !r.terminal;
    return (r.outcome==Outcome::Committed||r.outcome==Outcome::RolledBack||r.outcome==Outcome::NotStarted)&&
        r.terminal&&valid(*r.terminal)&&!r.terminal->transaction;
}
class Ledger final {
  public:
    bool bind(const Scope &scope,std::uint64_t nativeGeneration) noexcept {
        if(!valid(scope)||!nativeGeneration) return false;
        if(bound_) return nativeGeneration_==nativeGeneration&&scope_==scope;
        // One module belongs to one client/document. A replacement source may
        // only advance that scope; delayed old bind messages cannot rebind it.
        if(everBound_&&(scope.documentId!=scope_.documentId||scope.clientGeneration!=scope_.clientGeneration||
                        scope.sourceGeneration<=scope_.sourceGeneration)) return false;
        scope_=scope;nativeGeneration_=nativeGeneration;bound_=everBound_=true;
        return true;
    }
    bool matches(const Owner &owner,std::uint64_t generation) const noexcept {
        return bound_&&nativeGeneration_==generation&&valid(owner)&&owner.scope==scope_;
    }
    bool blocks() const noexcept { return hasReceipt_&&!retired_; }
    bool active() const noexcept { return blocks()&&receipt_.outcome==Outcome::Active; }
    bool owns(const Owner &owner,std::uint64_t generation) const noexcept {
        return matches(owner,generation)&&active()&&receipt_.owner==owner;
    }
    // Consume before fallible checkpoint preparation. A rejected preparation
    // remains proven not-started and can never be retried as a fresh begin.
    bool admit(const Owner &owner,std::uint64_t generation,const State &before) noexcept {
        if(!matches(owner,generation)||blocks()||owner.operationId<=highWater_||!valid(before)||before.transaction) return false;
        highWater_=owner.operationId;receipt_={owner,Outcome::NotStarted,before,before};hasReceipt_=true;retired_=false;return true;
    }
    bool activate(const Owner &owner) noexcept {
        if(!hasReceipt_||retired_||receipt_.owner!=owner||receipt_.outcome!=Outcome::NotStarted) return false;
        receipt_.outcome=Outcome::Active;receipt_.terminal.reset();return true;
    }
    bool complete(const Owner &owner,Outcome outcome,const State &terminal) noexcept {
        if(!active()||receipt_.owner!=owner||(outcome!=Outcome::Committed&&outcome!=Outcome::RolledBack)||!valid(terminal)||terminal.transaction) return false;
        receipt_.terminal=terminal;receipt_.outcome=outcome;return true;
    }
    Receipt status(const Owner &owner,std::uint64_t generation,const State &current) noexcept {
        if(!matches(owner,generation)) return {owner};
        if(hasReceipt_&&receipt_.owner==owner&&!retired_) return receipt_;
        // Sealing proof consumes this sequence before replying. In particular,
        // a delayed begin cannot execute after a not-started status was sent.
        if(!blocks()&&owner.operationId>highWater_&&admit(owner,generation,current)) return receipt_;
        return {owner};
    }
    bool retire(const Owner &owner,std::uint64_t generation) noexcept {
        if(!matches(owner,generation)||!hasReceipt_||receipt_.owner!=owner||receipt_.outcome==Outcome::Active) return false;
        retired_=true;return true;
    }
    void sourceChanged() noexcept { bound_=false;hasReceipt_=false;retired_=true; }
    const Receipt &receipt() const noexcept { return receipt_; }
  private:
    Scope scope_;
    std::uint64_t nativeGeneration_{},highWater_{};
    Receipt receipt_;
    bool bound_{},everBound_{},hasReceipt_{},retired_{true};
};
static_assert(std::is_trivially_copyable_v<Receipt> && std::is_trivially_copyable_v<Ledger>);
} // namespace sv_operation
