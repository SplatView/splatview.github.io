#include "browser_filter.hpp"
#include <algorithm>
#include <cmath>

namespace preview::browser_filter {
namespace {
constexpr float pi=3.14159265358979323846f;
void exactKeys(const nlohmann::json &value,std::initializer_list<const char *> keys) {
    if(!value.is_object() || value.size()!=keys.size()) throw std::runtime_error("Invalid filter parameters");
    for(const auto *key:keys) if(!value.contains(key)) throw std::runtime_error("Invalid filter parameters");
}
float scalar(const nlohmann::json &value,const char *key,double low,double high) {
    const auto &input=value.at(key);
    if(!input.is_number()) throw std::runtime_error("Invalid filter number");
    const auto number=input.get<double>();
    if(!std::isfinite(number) || number<low || number>high) throw std::runtime_error("Filter number exceeds its supported range");
    return float(number);
}
std::array<float,3> vector(const nlohmann::json &value,const char *key,double low=-1e12,double high=1e12) {
    const auto &input=value.at(key);
    if(!input.is_array() || input.size()!=3) throw std::runtime_error("Invalid filter vector");
    std::array<float,3> result;
    for(size_t i=0;i<3;++i) {
        if(!input[i].is_number()) throw std::runtime_error("Invalid filter vector number");
        const auto number=input[i].get<double>();
        if(!std::isfinite(number)||number<low||number>high) throw std::runtime_error("Filter vector exceeds its supported range");
        result[i]=float(number);
    }
    return result;
}
// Same float quaternion and double normalized matrix arithmetic as the frozen
// processing_detail::transform(axis_angle). No Euler reinterpretation occurs.
processing_detail::Affine axisAngle(const std::array<float,3> &degrees) {
    std::array<float,3> aa;
    for(size_t i=0;i<3;++i) aa[i]=degrees[i]*pi/180;
    const double angle=std::hypot(aa[0],aa[1],aa[2]),s=angle>1e-12 ? std::sin(angle/2)/angle : .5;
    const std::array<float,4> q{float(std::cos(angle/2)),float(aa[0]*s),float(aa[1]*s),float(aa[2]*s)};
    const double norm=std::sqrt(double(q[0])*q[0]+double(q[1])*q[1]+double(q[2])*q[2]+double(q[3])*q[3]);
    if(!std::isfinite(norm)||norm==0) throw std::runtime_error("Invalid filter rotation");
    const double w=q[0]/norm,x=q[1]/norm,y=q[2]/norm,z=q[3]/norm;
    processing_detail::Affine result;
    const double matrix[3][3]{{1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)},
        {2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)},
        {2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)}};
    for(size_t r=0;r<3;++r) for(size_t c=0;c<3;++c) result.a[r][c]=matrix[r][c];
    return result;
}
}
std::string_view name(Kind kind) noexcept {
    switch(kind) {
        case Kind::Sphere:return "sphere";case Kind::Box:return "box";case Kind::Ellipsoid:return "ellipsoid";
        case Kind::Frustum:return "frustum";case Kind::Opacity:return "opacity";case Kind::Scale:return "scale";
    }
    return {};
}
Kind kind(std::string_view name) {
    for(auto value:{Kind::Sphere,Kind::Box,Kind::Ellipsoid,Kind::Frustum,Kind::Opacity,Kind::Scale})
        if(browser_filter::name(value)==name) return value;
    throw std::runtime_error("Invalid selection filter kind");
}
Parameters parameters(Kind kind,const nlohmann::json &input) {
    Parameters value;
    switch(kind) {
        case Kind::Sphere:
            exactKeys(input,{"center","radius"});value.center=vector(input,"center");value.radius=scalar(input,"radius",0,1e12);break;
        case Kind::Box:case Kind::Ellipsoid:
            exactKeys(input,{"center","size","rotation"});value.center=vector(input,"center");
            value.size=vector(input,"size",0,1e12);value.rotation=vector(input,"rotation");
            if(kind==Kind::Ellipsoid && std::any_of(value.size.begin(),value.size.end(),[](float n){return n<=0;}))
                throw std::runtime_error("Ellipsoid radii must be positive");
            break;
        case Kind::Frustum:
            exactKeys(input,{"center","rotation","fov","aspect","near","far"});value.center=vector(input,"center");
            value.rotation=vector(input,"rotation");value.fov=scalar(input,"fov",0,180);
            value.aspect=scalar(input,"aspect",.001,1000);value.nearPlane=scalar(input,"near",0,1e12);
            value.farPlane=scalar(input,"far",.0001,1e12);
            if(value.fov*pi/180<.001f || value.fov*pi/180>pi-.001f || value.farPlane<=value.nearPlane)
                throw std::runtime_error("Invalid filter frustum bounds");
            break;
        case Kind::Opacity:case Kind::Scale:
            exactKeys(input,{"minimum","maximum"});value.minimum=scalar(input,"minimum",0,kind==Kind::Opacity?1:1e12);
            value.maximum=scalar(input,"maximum",0,kind==Kind::Opacity?1:1e12);
            if(input.at("minimum").get<double>()>input.at("maximum").get<double>())
                throw std::runtime_error("Filter minimum exceeds maximum");
            break;
    }
    return value;
}
// Source contract: captured Windows ProcessingUi::filterValues and the pinned
// portable src/core/processing.cpp Predicate. Centers and all bounds are inclusive;
// scale is maximum reconstructed principal axis; >=100 is the desktop sentinel.
Predicate::Predicate(Kind kind,Parameters values):kind_(kind),parameters_(values),rotation_(axisAngle(values.rotation)) {
    if(name(kind).empty()) throw std::runtime_error("Invalid selection filter kind");
    const auto vectorValid=[](const auto &a) {return std::all_of(a.begin(),a.end(),[](float n){return std::isfinite(n)&&std::abs(n)<=1e12f;});};
    if(!vectorValid(values.center)||!vectorValid(values.rotation)) throw std::runtime_error("Invalid filter position or rotation");
    if((kind==Kind::Box||kind==Kind::Ellipsoid) && (!vectorValid(values.size)||
       std::any_of(values.size.begin(),values.size.end(),[&](float n){return kind==Kind::Box?n<0:n<=0;})))
        throw std::runtime_error("Invalid filter size");
    if(kind==Kind::Sphere && (!std::isfinite(values.radius)||values.radius<0||values.radius>1e12f))
        throw std::runtime_error("Invalid filter radius");
    if((kind==Kind::Opacity||kind==Kind::Scale) && (!std::isfinite(values.minimum)||!std::isfinite(values.maximum)||
       values.minimum<0||values.maximum<values.minimum||values.maximum>(kind==Kind::Opacity?1:1e12f)))
        throw std::runtime_error("Invalid filter minimum or maximum");
    if(kind==Kind::Frustum && (!std::isfinite(values.fov)||values.fov*pi/180<.001f||values.fov*pi/180>pi-.001f||
       !std::isfinite(values.aspect)||values.aspect<.001f||values.aspect>1000||!std::isfinite(values.nearPlane)||
       values.nearPlane<0||values.nearPlane>1e12f||!std::isfinite(values.farPlane)||values.farPlane<.0001f||
       values.farPlane>1e12f||values.farPlane<=values.nearPlane)) throw std::runtime_error("Invalid filter frustum bounds");
    if(kind==Kind::Box) {
        for(size_t i=0;i<3;++i) {
            const float low=values.center[i]-values.size[i]/2,high=values.center[i]+values.size[i]/2;
            if(!std::isfinite(low)||!std::isfinite(high)||std::abs(low)>1e12f||std::abs(high)>1e12f||low>high)
                throw std::runtime_error("Invalid filter box bounds");
            rotation_.t[i]=(double(low)+high)/2;halfExtent_[i]=(double(high)-low)/2;
        }
    } else for(size_t i=0;i<3;++i) rotation_.t[i]=values.center[i];
    tanY_=std::tan(values.fov*pi/180/2);
}
bool Predicate::operator()(const Gaussian &g) const {
    if(g.positionOpacity[3]<0 || g.positionOpacity[3]>1) return false;
    if(kind_==Kind::Opacity) return g.positionOpacity[3]>=parameters_.minimum && g.positionOpacity[3]<=parameters_.maximum;
    if(kind_==Kind::Scale) {
        if(parameters_.minimum<=0 && parameters_.maximum>=100) return true;
        const auto axes=exportAxesRdf(g);
        const float scale=std::exp(*std::max_element(axes.logScales.begin(),axes.logScales.end()));
        return scale>=parameters_.minimum && (parameters_.maximum>=100 || scale<=parameters_.maximum);
    }
    const std::array<double,3> p{g.positionOpacity[0],g.positionOpacity[1],g.positionOpacity[2]};
    if(kind_==Kind::Sphere) return std::hypot(p[0]-parameters_.center[0],p[1]-parameters_.center[1],p[2]-parameters_.center[2])<=parameters_.radius;
    const auto q=rotation_.point(p,true);
    if(kind_==Kind::Box) {
        for(size_t i=0;i<3;++i) if(std::abs(q[i])>halfExtent_[i]) return false;
        return true;
    }
    if(kind_==Kind::Ellipsoid) {
        double squared=0;
        for(size_t i=0;i<3;++i) squared+=(q[i]/parameters_.size[i])*(q[i]/parameters_.size[i]);
        return squared<=1;
    }
    const double depth=-q[2];
    return depth>=parameters_.nearPlane && depth<=parameters_.farPlane &&
        std::abs(q[0])<=depth*tanY_*parameters_.aspect && std::abs(q[1])<=depth*tanY_;
}
bool current(const SceneEdits &edits,const Owner &owner,uint64_t generation) noexcept {
    return owner.id && owner.id<=maximumIdentity && owner.generation==generation &&
        BrowserSelectionAccess::filterCurrent(edits,owner.baseline,owner.revision);
}
Job::Pointer Job::create(const Owner &owner,Parameters values,SelectOperation operation,std::shared_ptr<SceneMemory> memory,browser_view_scope::Scope selectionView) {
    if(!memory||!owner.baseline.scene||owner.baseline.states.size()!=owner.baseline.scene->gaussians.size()||
       !owner.id||!owner.epoch||owner.id>maximumIdentity||owner.epoch>maximumIdentity||unsigned(operation)>3)
        throw std::runtime_error("Invalid filter preview owner");
    AdmittedAllocator<Job> allocator{memory};auto *value=allocator.allocate(1);
    try { std::construct_at(value,owner,values,operation,std::move(memory),selectionView); }
    catch(...) { allocator.deallocate(value,1);throw; }
    return Pointer(value,Deleter{allocator.memory()});
}
Job::Job(Owner owner,Parameters values,SelectOperation operation,std::shared_ptr<SceneMemory> memory,browser_view_scope::Scope selectionView)
    :owner_(std::move(owner)),predicate_(owner_.kind,values),selectionView_(selectionView),operation_(operation),memory_(std::move(memory)) {}
void Job::Deleter::operator()(Job *value) noexcept {
    if(value) { AdmittedAllocator<Job> allocator{memory};std::destroy_at(value);allocator.deallocate(value,1); }
}
void Job::retire(Pointer &job) noexcept { job.reset();job.get_deleter().memory.reset(); }
void Job::cancel() noexcept { resultPointer_=nullptr;result_.reset();status_=Status::Cancelled;phase_=Phase::Cancelled; }
Status Job::step(size_t maxWork,std::stop_token stop) {
    lastStepWork_=0;
    if(stop.stop_requested()) cancel();
    while(status_==Status::Working && lastStepWork_<maxWork) {
        if(stop.stop_requested()) { cancel();break; }
        if(phase_==Phase::Allocate) {
            result_.emplace(memory_,owner_.baseline.states.size());resultPointer_=result_->span().data();phase_=Phase::Evaluate;
        } else if(cursor_<owner_.baseline.states.size()) {
            const auto before=owner_.baseline.states[cursor_];
            if(before>2) throw std::runtime_error("Invalid filter baseline mask");
            auto after=before;
            if(!(before&2)) {
                const bool eligible=selectionView_.contains(owner_.baseline.scene->gaussians[cursor_]);
                const bool inside=eligible&&predicate_(owner_.baseline.scene->gaussians[cursor_]),selected=(before&1)!=0;
                after=uint8_t(operation_==SelectOperation::Set?inside:operation_==SelectOperation::Add?selected||inside:
                    operation_==SelectOperation::Remove?selected&&!inside:selected&&inside);
                if(!eligible)after=0;
            }
            // Accumulate once in the existing bounded evaluation pass. The
            // live owner keeps its previous accepted value until mask and
            // metadata publication have both passed their refusal gates.
            changed_|=((before^after)&1)!=0;
            result_->span()[cursor_++]=after;
        } else { status_=Status::Ready;phase_=Phase::Ready; }
        ++lastStepWork_;++workDone_;
    }
    return status_;
}
double Job::progress() const noexcept { return status_==Status::Ready?1:double(cursor_)/std::max(size_t(1),owner_.baseline.states.size()); }
std::span<const uint8_t> Job::result() const noexcept { return status_==Status::Ready && result_ ? std::span<const uint8_t>{resultPointer_,owner_.baseline.states.size()} : std::span<const uint8_t>{}; }
} // namespace preview::browser_filter
