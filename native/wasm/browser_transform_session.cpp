// Session/bake ports the captured Viewer::beginOperationSession/autoProcess/
// resetOperation and portable processScene transform branch. Bounds phases are
// the exact Gaussian fitBounds policy from portable scene_math.cpp:86-163.
#include "browser_transform_session.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace preview::browser_transform {
std::string_view name(Kind value) noexcept { return value==Kind::Gizmo ? "gizmo" : "numeric"; }
Kind kind(std::string_view value) {if(value=="numeric")return Kind::Numeric;if(value=="gizmo")return Kind::Gizmo;throw std::runtime_error("Invalid transform session kind");}
Parameters parameters(const nlohmann::json &input) {
    if(!input.is_object())throw std::runtime_error("Invalid transform parameters");
    Parameters p;const auto mode=input.at("mode").get<std::string>();
    if(mode=="euler") {p.mode=Mode::Euler;processing_detail::keys(input,{"mode","translation","scale","pivot","flips","euler"});p.euler=processing_detail::array<3>(input,"euler",{});}
    else if(mode=="quaternion") {p.mode=Mode::Quaternion;processing_detail::keys(input,{"mode","translation","scale","pivot","flips","quaternion"});p.quaternion=processing_detail::array<4>(input,"quaternion",{});}
    else if(mode=="axis-angle") {p.mode=Mode::AxisAngle;processing_detail::keys(input,{"mode","translation","scale","pivot","flips","axis","angle"});p.axis=processing_detail::array<3>(input,"axis",{});p.angle=processing_detail::number(input,"angle",0);}
    else if(mode=="matrix") {p.mode=Mode::Matrix;processing_detail::keys(input,{"mode","pivot","flips","matrix"});p.matrix=processing_detail::array<16>(input,"matrix",{});}
    else throw std::runtime_error("Invalid transform entry mode");
    const size_t required=p.mode==Mode::Matrix?4:p.mode==Mode::AxisAngle?7:6;
    if(input.size()!=required)throw std::runtime_error("Missing transform parameter fields");
    for(const auto *key:{"pivot","flips"})if(!input.contains(key)||input.at(key).is_null())throw std::runtime_error("Missing transform parameter fields");
    p.pivot=processing_detail::array<3>(input,"pivot",{});
    if(p.mode!=Mode::Matrix) {
        for(const auto *key:{"translation","scale"})if(!input.contains(key)||input.at(key).is_null())throw std::runtime_error("Missing transform parameter fields");
        p.translation=processing_detail::array<3>(input,"translation",{});p.scale=processing_detail::array<3>(input,"scale",{});
    }
    const auto &flips=input.at("flips");if(!flips.is_array()||flips.size()!=3)throw std::runtime_error("Invalid transform flips");
    for(size_t i=0;i<3;++i) {if(!flips[i].is_boolean())throw std::runtime_error("Invalid transform flips");p.flips[i]=flips[i].get<bool>();}
    // Active arrays are mandatory and nonnull; portable array() defaults remain
    // useful for unrelated recipes but cannot silently neutralize this DTO.
    const auto *active=p.mode==Mode::Euler?"euler":p.mode==Mode::Quaternion?"quaternion":p.mode==Mode::AxisAngle?"axis":"matrix";
    if(!input.contains(active)||input.at(active).is_null()||(p.mode==Mode::AxisAngle&&(!input.contains("angle")||!input.at("angle").is_number())))
        throw std::runtime_error("Missing transform parameter fields");
    Plan validated;if(!plan(p,validated))throw std::runtime_error("Invalid transform parameters");return p;
}
bool valid(const Context &c) noexcept {
    return c.settled&&c.scene&&c.scene->isGaussian()&&!c.scene->gaussians.empty()&&c.scene->gaussians.size()<=1'000'000&&
        c.states.size()==c.scene->gaussians.size()&&c.generation;
}
bool same(const Context &a,const Context &b) noexcept {
    return a.scene==b.scene&&a.states.data()==b.states.data()&&a.states.size()==b.states.size()&&
        a.generation==b.generation&&a.revision==b.revision&&a.contentRevision==b.contentRevision;
}
bool current(const Owner &o,const Context &c) noexcept {return valid(c)&&o.base&&o.states.size()==c.states.size()&&same(o.acknowledged,c);}
Job::Job(Owner owner,Parameters parameters,Plan plan,std::shared_ptr<SceneMemory> memory)
    :owner_(std::move(owner)),parameters_(std::move(parameters)),plan_(std::move(plan)),memory_(std::move(memory)) {
    if(!memory_||!owner_.base||!valid(owner_.acknowledged)||owner_.states.size()!=owner_.base->gaussians.size())
        throw std::runtime_error("Invalid transform bake owners");
}
void Job::Deleter::operator()(Job *value) noexcept {if(value){value->~Job();AdmittedAllocator<Job>{memory}.deallocate(value,1);}}
Job::Pointer Job::create(const Owner &owner,Parameters parameters,Plan plan,std::shared_ptr<SceneMemory> memory) {
    if(!memory)throw std::runtime_error("Transform bake requires admission");AdmittedAllocator<Job> allocator{memory};auto *raw=allocator.allocate(1);
    try {::new(static_cast<void *>(raw)) Job(owner,std::move(parameters),std::move(plan),memory);}catch(...){allocator.deallocate(raw,1);throw;}
    return Pointer(raw,Deleter{std::move(memory)});
}
void Job::retire(Pointer &owner) noexcept {if(owner)owner->cancel();owner.reset();owner.get_deleter().memory.reset();}
void Job::cancel() noexcept {result_.reset();bounds_.reset();status_=Status::Cancelled;phase_=Phase::Cancelled;}
double Job::progress() const noexcept {
    if(status_==Status::Ready)return 1;if(phase_<=Phase::Copy)return double(cursor_)/std::max(size_t(1),owner_.states.size())*.8;return .8;
}
void Job::sort(size_t array,size_t count) {sortArray_=array;sortCount_=count;width_=1;run_=write_=0;left_=right_=middle_=end_=0;phase_=Phase::Sort;}
void Job::sorted() {
    if(sortArray_<2) {sort(sortArray_+1,samples_);return;}
    if(sortArray_==2) {phase_=Phase::AxisStats;return;}
    if(sortArray_==7) {
        const auto *distances=values(7);core_=distances[size_t((samples_-1)*.65f)];
        background_=distances[size_t((samples_-1)*.95f)]>3*std::max(core_,.05f);cursor_=footprints_=0;phase_=Phase::Footprints;return;
    }
    phase_=Phase::Finish;
}
void Job::action() {
    const size_t count=owner_.states.size();
    switch(phase_) {
    case Phase::AllocateScene: {
        const auto &base=*owner_.base;result_=std::allocate_shared<Scene>(AdmittedAllocator<Scene>{memory_},memory_);
        result_->type=base.type;result_->sourceFaces=base.sourceFaces;result_->sampledGeometry=base.sampledGeometry;
        result_->center=base.center;result_->radius=base.radius;result_->previewEye=base.previewEye;result_->defaultView.reset();
        result_->alignmentFrame=base.alignmentFrame;result_->sourceCount=base.sourceCount;result_->shDegree=base.shDegree;result_->yUp=base.yUp;
        result_->format=base.format;result_->sourceContentKey=base.sourceContentKey;result_->sourceFileIdentity=base.sourceFileIdentity;result_->sourceBytes=base.sourceBytes;
        result_->gaussians.reserve(count);cursor_=0;phase_=Phase::Copy;break;
    }
    case Phase::Copy: {
        auto value=owner_.base->gaussians[cursor_];const auto state=owner_.targetStates()[cursor_];
        if(!(state&2)&&(!owner_.selectedOnly||(state&1)))for(size_t step=0;step<plan_.count;++step)plan_.steps[step].apply(value);
        result_->gaussians.push_back(value);if(++cursor_==count)phase_=Phase::AllocateBounds;break;
    }
    case Phase::AllocateBounds:
        stride_=(count+16383)/16384;capacity_=(count+stride_-1)/stride_;bounds_.emplace(memory_,capacity_*9);
        cursor_=samples_=0;includeTransparent_=false;phase_=Phase::Sample;break;
    case Phase::Sample: {
        const auto &g=result_->gaussians[cursor_];
        if(includeTransparent_||g.positionOpacity[3]>=1.f/255) {
            for(size_t axis=0;axis<3;++axis)values(axis)[samples_]=values(3+axis)[samples_]=g.positionOpacity[axis];
            values(6)[samples_]=3*std::sqrt(std::max({g.covA[0],g.covA[3],g.covB[1],0.f}));++samples_;
        }
        cursor_+=stride_;if(cursor_>=count) {if(!samples_&&!includeTransparent_){includeTransparent_=true;cursor_=0;}else sort(0,samples_);}break;
    }
    case Phase::Sort: {
        if(width_>=sortCount_){sorted();break;}
        if(write_==end_) {
            if(run_>=sortCount_){cursor_=0;phase_=Phase::CopySorted;break;}
            left_=run_;middle_=std::min(run_+width_,sortCount_);right_=middle_;end_=std::min(run_+width_*2,sortCount_);write_=run_;run_=end_;
        }
        const auto *source=values(sortArray_);auto *merge=values(8);
        if(left_<middle_&&(right_==end_||source[left_]<=source[right_]))merge[write_++]=source[left_++];else merge[write_++]=source[right_++];break;
    }
    case Phase::CopySorted:
        values(sortArray_)[cursor_]=values(8)[cursor_];if(++cursor_==sortCount_){width_*=2;run_=write_=left_=middle_=right_=end_=0;phase_=Phase::Sort;}break;
    case Phase::AxisStats:
        for(size_t axis=0;axis<3;++axis){const auto *p=values(axis);const float low=p[samples_/100],high=p[samples_-1-samples_/100];
            center_[axis]=(low+high)*.5f;extent_[axis]=(high-low)*.5f;median_[axis]=p[samples_/2];}
        cursor_=0;phase_=Phase::Distances;break;
    case Phase::Distances:
        values(7)[cursor_]=std::hypot(values(3)[cursor_]-median_[0],values(4)[cursor_]-median_[1],values(5)[cursor_]-median_[2]);
        if(++cursor_==samples_)sort(7,samples_);break;
    case Phase::Footprints:
        if(!background_||std::hypot(values(3)[cursor_]-median_[0],values(4)[cursor_]-median_[1],values(5)[cursor_]-median_[2])<=core_)
            values(6)[footprints_++]=values(6)[cursor_];
        if(++cursor_==samples_)sort(6,footprints_);break;
    case Phase::Finish: {
        if(!footprints_)throw std::runtime_error("Transform bounds have no support");
        const float padding=values(6)[size_t((footprints_-1)*.9f)];
        Vec3 center{center_[0],center_[1],center_[2]};float rawRadius=std::hypot(extent_[0],extent_[1],extent_[2])+padding;
        float radius=std::max(.05f,rawRadius);std::optional<Vec3> eye;
        if(background_) {center={median_[0],median_[1],median_[2]};rawRadius=core_+padding;radius=std::max(.05f,rawRadius);
            const float distance=std::hypot(median_[0],median_[1],median_[2]);if(distance>radius*.25f&&distance<core_)eye=Vec3{};}
        if(!std::isfinite(rawRadius)||!std::isfinite(radius)||!std::isfinite(center.x)||!std::isfinite(center.y)||!std::isfinite(center.z))
            throw std::runtime_error("Scene bounds are too large to preview");
        result_->center=center;result_->radius=radius;result_->previewEye=eye;bounds_.reset();status_=Status::Ready;phase_=Phase::Ready;break;
    }
    default:break;
    }
}
Status Job::step(size_t maxWork,std::stop_token stop) {
    lastStepWork_=0;while(lastStepWork_<maxWork&&status_==Status::Working) {
        if(stop.stop_requested()){cancel();break;}action();++lastStepWork_;++workDone_;
    }
    return status_;
}
} // namespace preview::browser_transform
