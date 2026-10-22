#pragma once
#include "selection_consumer.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <utility>

namespace preview {
// Only a selector that explicitly diagnoses a computation failure may emit this
// type. The current portable algorithms do not emit it. Allocation, admission,
// cancellation, protocol and publication failures retain their ordinary errors.
class BrowserSelectionComputationFailure final : public std::runtime_error {
  public:
    BrowserSelectionComputationFailure() : std::runtime_error("Selection computation failed") {}
};
enum class BrowserLiveSelectionOutcome { Published, ComputationFailed };
enum class BrowserLiveSelectionKind { Rectangle, Polygon, Brush, Volume };

// This owns the admitted path, borrowed-map copies and sampled volume work.
// Its creation and the disposable SceneEdits construction are outside the one
// narrow computation catch below. No browser fault-injection command exists.
struct BrowserLiveSelectionRequest {
    BrowserLiveSelectionKind kind{};
    Camera camera;
    browser_view_scope::Scope selectionView;
    unsigned width{},height{};
    SelectOperation operation{};
    SelectionOptions options;
    RectI rectangle{};
    float radius{};
    SceneVector<PointI> points;
    std::optional<SelectionMap> map;
    SceneVector<VolumeSample> samples;
};

namespace browser_live_selection_detail {
using Json = nlohmann::json;
inline int32_t coordinate(const Json &value) {
    if(!value.is_number_integer() ||
       (value.is_number_unsigned() && value.get<uint64_t>()>uint64_t(INT32_MAX)) ||
       (!value.is_number_unsigned() && (value.get<int64_t>()<INT32_MIN || value.get<int64_t>()>INT32_MAX)))
        throw std::runtime_error("Selection path coordinates must be int32");
    return value.get<int32_t>();
}
inline unsigned dimension(const Json &value) {
    if(!value.is_number_integer() ||
       (!value.is_number_unsigned() && value.get<int64_t>()<=0) ||
       value.get<uint64_t>()>uint64_t(INT32_MAX))
        throw std::runtime_error("Invalid live selection viewport");
    const auto result=value.get<unsigned>();
    if(!result) throw std::runtime_error("Invalid live selection viewport");
    return result;
}
inline uint64_t mapId(const Json &value) {
    if(!value.is_number_integer() ||
       (!value.is_number_unsigned() && value.get<int64_t>()<=0) ||
       value.get<uint64_t>()>9007199254740991ULL)
        throw std::runtime_error("Invalid selection map ID");
    const auto result=value.get<uint64_t>();
    if(!result) throw std::runtime_error("Invalid selection map ID");
    return result;
}
} // namespace browser_live_selection_detail

inline BrowserLiveSelectionRequest admitBrowserLiveSelection(
    const nlohmann::json &input,const SceneEdits &edits,
    std::shared_ptr<SceneMemory> scratch,const BrowserSelectionMap *source) {
    using namespace browser_live_selection_detail;
    if(!edits.selectionDraft() || !input.value("fromBaseline",false))
        throw std::runtime_error("An absolute live selection gesture is required");
    BrowserLiveSelectionRequest request;
    request.selectionView=browser_view_scope::parse(input);
    const auto command=input.at("command").get<std::string>();
    if(command=="rectangle") request.kind=BrowserLiveSelectionKind::Rectangle;
    else if(command=="polygon") request.kind=BrowserLiveSelectionKind::Polygon;
    else if(command=="brush") request.kind=BrowserLiveSelectionKind::Brush;
    else if(command=="volume") request.kind=BrowserLiveSelectionKind::Volume;
    else throw std::runtime_error("Unsupported live selection command");
    request.width=dimension(input.at("width")); request.height=dimension(input.at("height"));
    const auto values=input.at("camera").get<std::vector<float>>();
    if(values.size()<10 || std::any_of(values.begin(),values.end(),[](float value){return !std::isfinite(value);}) ||
       values[5]<=0 || values[6]<=0 || values[7]<10 || values[7]>120)
        throw std::runtime_error("Invalid live selection camera");
    request.camera.target={values[0],values[1],values[2]};
    request.camera.yaw=values[3]; request.camera.pitch=values[4]; request.camera.distance=values[5];
    request.camera.radius=values[6]; request.camera.fieldOfView=values[7];
    request.camera.yUp=values[8]!=0; request.camera.roll=values[9];
    const auto &combine=input.at("operation");
    if(!combine.is_number_integer() ||
       (combine.is_number_unsigned() && combine.get<uint64_t>()>3) ||
       (!combine.is_number_unsigned() && (combine.get<int64_t>()<0 || combine.get<int64_t>()>3)))
        throw std::runtime_error("Invalid selection combination");
    request.operation=static_cast<SelectOperation>(combine.get<unsigned>());
    request.options={input.value("visibleOnly",false),input.value("overlap",false)};
    const bool volume=request.kind==BrowserLiveSelectionKind::Volume;
    const bool mapped=volume || (request.kind==BrowserLiveSelectionKind::Brush && request.options.visibleOnly);
    if(request.options.visibleOnly && !mapped)
        throw std::runtime_error("A visibility query is required for this selection");
    if(mapped) {
        const auto id=mapId(input.at("mapId"));
        if(!source || source->header.mapId!=id || !source->current(edits))
            throw std::runtime_error("Selection map is stale");
        if(source->header.fullWidth!=request.width || source->header.fullHeight!=request.height)
            throw std::runtime_error("Selection viewport does not match the adopted map");
        if(request.options.visibleOnly && !(source->header.channels&BrowserSelectionMap::visibleChannel))
            throw std::runtime_error("A global visibility channel is required for this selection");
        // The active binding only supplies committed owners. Validate complete
        // payloads here too so standalone callers share the same admission.
        source->validateComplete();
        request.map.emplace(borrowedSelectionMap(*source));
    }
    if(request.kind==BrowserLiveSelectionKind::Rectangle) {
        const auto &rectangle=input.at("rectangle");
        if(!rectangle.is_array() || rectangle.size()!=4)
            throw std::runtime_error("Invalid selection rectangle");
        request.rectangle={coordinate(rectangle[0]),coordinate(rectangle[1]),
                           coordinate(rectangle[2]),coordinate(rectangle[3])};
    } else {
        const auto &points=input.at("points");
        const auto limit=request.kind==BrowserLiveSelectionKind::Polygon ? 4096u : 65536u;
        if(!points.is_array() || points.size()>limit)
            throw std::runtime_error("Selection path exceeds point budget");
        request.points=SceneVector<PointI>{SceneAllocator<PointI>{scratch}};
        request.points.reserve(points.size());
        for(const auto &point:points) {
            if(!point.is_array() || point.size()!=2) throw std::runtime_error("Invalid selection path point");
            request.points.push_back({coordinate(point[0]),coordinate(point[1])});
        }
    }
    if(request.kind==BrowserLiveSelectionKind::Brush || volume) {
        request.radius=input.value("radius",16.f);
        if(!std::isfinite(request.radius) || request.radius<=0 || (!volume && request.radius>4096))
            throw std::runtime_error("Invalid selection radius");
    }
    if(volume) {
        request.samples=volumeStrokeSamples(request.camera,*request.map,request.width,request.height,
            request.points,request.radius,{},std::move(scratch));
        for(const auto &sample:request.samples) if(sample.radius>1e12f)
            throw std::runtime_error("Volume sample radius exceeds the native limit");
    }
    return request;
}

struct BrowserLiveSelectionEvaluator {
    bool operator()(SceneEdits &candidate,const BrowserLiveSelectionRequest &request) const {
        const auto *map=request.map ? &*request.map : nullptr;
        switch(request.kind) {
        case BrowserLiveSelectionKind::Rectangle:
            return candidate.selectRectangle(request.camera,request.width,request.height,request.rectangle,
                request.operation,request.options,map);
        case BrowserLiveSelectionKind::Polygon:
            return candidate.selectPolygon(request.camera,request.width,request.height,request.points,
                request.operation,request.options,map);
        case BrowserLiveSelectionKind::Brush:
            return candidate.selectBrush(request.camera,request.width,request.height,request.points,request.radius,
                request.operation,request.options,map);
        case BrowserLiveSelectionKind::Volume:
            return candidate.selectVolumeBrush(request.samples,request.operation,request.options,map);
        }
        throw std::runtime_error("Unsupported live selection kind");
    }
};
struct BrowserLiveSelectionPublisher {
    void operator()(SceneEdits &edits,const SceneEdits &candidate) const {
        // Same-scene replaceScene stages the authoritative delta/COW while
        // preserving the gesture baseline, history and Redo until confirmation.
        edits.replaceScene(edits.scene(),candidate.states());
    }
};

// The evaluator/publisher parameters are C++ adapter seams, instantiated by the
// standalone contracts. Shipping calls use the real defaults exclusively.
template<class Evaluate=BrowserLiveSelectionEvaluator,class Publish=BrowserLiveSelectionPublisher>
BrowserLiveSelectionOutcome browserLiveSelection(SceneEdits &edits,const BrowserLiveSelectionRequest &request,
    Evaluate evaluate={},Publish publish={}) {
    auto candidate=BrowserSelectionAccess::selectionCandidate(edits,true);
    BrowserSelectionAccess::selectionView(candidate,request.selectionView);
    try {
        // false is a completed no-op/degenerate selector, never a failure.
        (void)evaluate(candidate,request);
    } catch(const BrowserSelectionComputationFailure &) {
        return BrowserLiveSelectionOutcome::ComputationFailed;
    }
    publish(edits,candidate);
    return BrowserLiveSelectionOutcome::Published;
}
} // namespace preview
