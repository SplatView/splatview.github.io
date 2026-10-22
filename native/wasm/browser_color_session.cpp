#include "browser_color_session.hpp"
#include <cmath>
#include <utility>

namespace preview::browser_color_metadata {
namespace {
bool validContext(const Context &context) noexcept {
    return context.settled && context.scene && context.scene->isGaussian() &&
        context.scene->gaussians.size() <= 1'000'000 && context.states.size() == context.scene->gaussians.size() &&
        context.documentId && context.sourceGeneration;
}
bool sameContext(const Context &a, const Context &b) noexcept {
    return a.documentId == b.documentId && a.sourceGeneration == b.sourceGeneration &&
        a.revision == b.revision && a.contentRevision == b.contentRevision &&
        a.scene == b.scene && a.states.data() == b.states.data() && a.states.size() == b.states.size();
}
bool validMethod(Method method) noexcept {
    return method == Method::Enhance || method == Method::Exposure ||
        method == Method::Contrast || method == Method::WhiteBalance;
}
}
std::optional<uint64_t> IdSequence::take() noexcept {
    if (!next_ || next_ > maximumIdentity) return {};
    return next_++;
}
bool BrowserColorSession::validValues(const ColorValues &values) noexcept {
    for (size_t k = 0; k < values.size(); ++k)
        if (!std::isfinite(values[k]) || values[k] < colorFields[k].low || values[k] > colorFields[k].high)
            return false;
    return true;
}
bool BrowserColorSession::matches(const Context &context) const noexcept {
    return active() && validContext(context) && sameContext(state_.acknowledged, context);
}
bool BrowserColorSession::ensure(const Context &context, bool selectedOnly, IdSequence &ids) noexcept {
    if (!validContext(context)) return refuse(Failure::InvalidContext);
    if (active()) {
        if (!matches(context)) return refuse(Failure::StaleContext);
        if (selectedOnly != state_.selectedOnly) return refuse(Failure::ScopeBoundaryRequired);
        return true;
    }
    const auto sessionId = ids.take(), baseId = ids.take(), epochId = ids.take(), valuesId = ids.take();
    if (!sessionId || !baseId || !epochId || !valuesId) return refuse(Failure::IdentityExhausted);
    State staged;
    staged.base = context.scene; staged.acknowledged = context;
    staged.sessionId = *sessionId; staged.baseId = *baseId; staged.epochId = *epochId;
    staged.baseContentRevision = context.contentRevision; staged.valuesId = *valuesId;
    staged.selectedOnly = selectedOnly;
    state_ = std::move(staged);
    return true;
}
bool BrowserColorSession::preview(const Context &context, const ColorValues &values,
                                 bool selectedOnly, IdSequence &ids) noexcept {
    failure_ = Failure::None;
    if (!validValues(values)) return refuse(Failure::InvalidValues);
    if (pending_ && pending_->kind == Kind::Auto) return refuse(Failure::Busy);
    const auto before = state_;
    if (!ensure(context, selectedOnly, ids)) return false;
    if (state_.values != values) {
        const auto id = ids.take();
        if (!id) { state_ = before; return refuse(Failure::IdentityExhausted); }
        state_.values = values; state_.valuesId = *id;
    }
    return true;
}
bool BrowserColorSession::begin(const Context &context,bool selectedOnly,MaskStorage effective,IdSequence &ids) noexcept {
    failure_=Failure::None;
    if(active())return matches(context)&&selectedOnly==state_.selectedOnly ? true:refuse(Failure::ScopeBoundaryRequired);
    if(effective.hasStorage()&&(!selectedOnly||effective.size()!=context.states.size()))return refuse(Failure::InvalidContext);
    if(!ensure(context,selectedOnly,ids))return false;
    state_.effectiveStates=std::move(effective);return true;
}
Capture BrowserColorSession::capture(const Context &context, Kind kind, Method method, IdSequence &ids) noexcept {
    if (!matches(context)) return {CaptureDisposition::Refused, {}, Failure::StaleContext};
    if (pending_) return {CaptureDisposition::Refused, {}, Failure::Busy};
    if (kind == Kind::Manual && state_.values == state_.applied)
        return {CaptureDisposition::ManualNoop, {}, Failure::None};
    const auto id = ids.take();
    if (!id) return {CaptureDisposition::Refused, {}, Failure::IdentityExhausted};
    Key key{context.documentId, context.sourceGeneration, context.revision, context.contentRevision,
        state_.sessionId, state_.baseId, state_.baseContentRevision, state_.epochId, *id,
        state_.valuesId, state_.selectedOnly};
    Request request{state_.base, context.scene, context.states, state_.values, key, kind, method};
    request.effectiveStates=state_.effectiveStates;
    pending_ = request;
    return {CaptureDisposition::Captured, std::move(request), Failure::None};
}
Capture BrowserColorSession::captureManual(const Context &context, IdSequence &ids) noexcept {
    failure_ = Failure::None;
    if (!active()) return {CaptureDisposition::ManualNoop, {}, Failure::None};
    auto outcome = capture(context, Kind::Manual, Method::Enhance, ids); failure_ = outcome.failure;
    return outcome;
}
Capture BrowserColorSession::captureAuto(const Context &context, Method method, bool selectedOnly, IdSequence &ids) noexcept {
    failure_ = Failure::None;
    if (!validMethod(method)) { failure_ = Failure::InvalidMethod; return {CaptureDisposition::Refused, {}, failure_}; }
    if (pending_) { failure_ = Failure::Busy; return {CaptureDisposition::Refused, {}, failure_}; }
    const auto before = state_;
    if (!ensure(context, selectedOnly, ids)) return {CaptureDisposition::Refused, {}, failure_};
    // An explicit desktop Auto never uses the manual equal-applied early return.
    auto outcome = capture(context, Kind::Auto, method, ids); failure_ = outcome.failure;
    if (outcome.disposition == CaptureDisposition::Refused) state_ = before;
    return outcome;
}
bool BrowserColorSession::current(const Request &request, const Context &context) const noexcept {
    if (!pending_ || !matches(context)) return false;
    return request.key == pending_->key && request.base == state_.base &&
        request.expectedCurrentScene == context.scene && request.states.data() == context.states.data() &&
        request.states.size() == context.states.size() && request.kind == pending_->kind &&
        request.method == pending_->method && request.capturedValues == pending_->capturedValues &&
        request.key.sessionId == state_.sessionId && request.key.baseId == state_.baseId &&
        request.key.epochId == state_.epochId && request.effectiveStates.data()==state_.effectiveStates.data() &&
        request.effectiveStates.size()==state_.effectiveStates.size();
}
std::optional<BakePlan> BrowserColorSession::plan(const Request &request, const Context &context,
                                               const ColorValues &values) noexcept {
    failure_ = Failure::None;
    if (!current(request, context)) { refuse(Failure::StaleContext); return {}; }
    if (!validValues(values) || (request.kind == Kind::Manual && values != request.capturedValues) ||
        (request.kind == Kind::Auto && values != merge(request.capturedValues, values, request.method))) {
        refuse(Failure::InvalidValues); return {};
    }
    const bool neutral = values == neutralColor;
    return BakePlan{values, neutral ? ScenePolicy::RetainBase : ScenePolicy::NewWritableScene,
        !neutral || context.scene != state_.base, neutral && context.scene == state_.base};
}
bool BrowserColorSession::markApplied(const Request &request, const Context &before, const Context &after,
                                     const ColorValues &values, bool maskValuesPreserved) noexcept {
    const auto proposed = plan(request, before, values);
    if (!proposed) return false;
    if (!validContext(after) || !maskValuesPreserved || after.documentId != before.documentId ||
        after.sourceGeneration != before.sourceGeneration || after.states.size() != before.states.size())
        return refuse(Failure::InvalidPublication);
    if (proposed->scenePolicy == ScenePolicy::RetainBase) {
        if (after.scene != state_.base) return refuse(Failure::InvalidPublication);
    } else if (after.scene == state_.base || after.scene == before.scene)
        return refuse(Failure::InvalidPublication);
    if (proposed->sceneReplacementRequired) {
        if (after.revision <= before.revision || after.contentRevision == before.contentRevision)
            return refuse(Failure::InvalidPublication);
    } else if (request.targetStates()!=before.states) {
        if(after.scene!=before.scene||after.revision<=before.revision||after.contentRevision!=before.contentRevision)
            return refuse(Failure::InvalidPublication);
    } else if (!sameContext(before, after)) return refuse(Failure::InvalidPublication);
    state_.acknowledged = after; state_.applied = values;
    // Manual completion retains a newer preview; Auto completion owns the UI
    // result because newer manual edits were fenced during that automatic job.
    if (request.kind == Kind::Auto) { state_.values = values; state_.valuesId = request.key.requestId; }
    pending_.reset(); failure_ = Failure::None;
    return true;
}
bool BrowserColorSession::cancel(const Request &request, const Context &context, IdSequence &ids) noexcept {
    if (!current(request, context)) return refuse(Failure::StaleContext);
    const auto id = ids.take();
    if (!id) return refuse(Failure::IdentityExhausted);
    state_.values = state_.applied; state_.valuesId = *id; pending_.reset();
    failure_ = Failure::None; return true;
}
EndDisposition BrowserColorSession::end(const Context &context, IdSequence &ids, bool pointerBarrier) noexcept {
    failure_ = Failure::None;
    if (!active()) return EndDisposition::AlreadyEnded;
    if (!matches(context)) { refuse(Failure::StaleContext); return EndDisposition::Refused; }
    if (pointerBarrier && manualPending()) return EndDisposition::PreserveNewerPointerPreview;
    if (pending_) return EndDisposition::WaitForJob;
    if (manualPending()) return EndDisposition::NeedsBake;
    const auto epoch = ids.take();
    if (!epoch) { refuse(Failure::IdentityExhausted); return EndDisposition::Refused; }
    state_ = {}; state_.epochId = *epoch;
    return EndDisposition::Ended;
}
void BrowserColorSession::abandon() noexcept { pending_.reset(); transaction_.reset(); state_ = {}; failure_ = Failure::None; }
BrowserColorSession::Snapshot BrowserColorSession::snapshot() const noexcept {
    Snapshot snapshot; snapshot.state_ = state_; snapshot.valid_ = true; return snapshot;
}
bool BrowserColorSession::swapMetadata(Snapshot &snapshot, IdSequence &ids) noexcept {
    if (!snapshot.valid_) return refuse(Failure::NoTransaction);
    const auto epoch = ids.take();
    if (!epoch) return refuse(Failure::IdentityExhausted);
    // No allocating operation follows ID reservation. The snapshot takes the
    // abandoned state so shared payloads retire only when its owner releases it.
    pending_.reset(); std::swap(state_, snapshot.state_); state_.epochId = *epoch;
    failure_ = Failure::None; return true;
}
bool BrowserColorSession::beginTransaction() noexcept {
    if (transaction_ || pending_) return refuse(Failure::Busy);
    transaction_.emplace(snapshot()); failure_ = Failure::None; return true;
}
bool BrowserColorSession::commitTransaction() noexcept {
    if (!transaction_) return refuse(Failure::NoTransaction);
    if (pending_) return refuse(Failure::Busy);
    transaction_.reset(); failure_ = Failure::None; return true;
}
bool BrowserColorSession::rollbackTransaction(IdSequence &ids) noexcept {
    if (!transaction_) return refuse(Failure::NoTransaction);
    if (!swapMetadata(*transaction_, ids)) return false;
    transaction_.reset(); return true;
}
ColorValues BrowserColorSession::merge(const ColorValues &current, const ColorValues &suggestion, Method method) noexcept {
    auto values = current;
    for (size_t k = 0; k < values.size(); ++k) {
        const bool adjust = ((method == Method::Enhance || method == Method::Exposure) && k == 0) ||
            ((method == Method::Enhance || method == Method::Contrast) && k == 1) ||
            ((method == Method::Enhance || method == Method::WhiteBalance) && (k == 5 || k == 6));
        if (adjust) values[k] = suggestion[k];
    }
    return values;
}
} // namespace preview::browser_color_metadata
