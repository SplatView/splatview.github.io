#include "floor_detection_job.hpp"
#include "admitted_raw_array.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace preview::browser_floor {
namespace {
using D3=std::array<double,3>;
D3 minus(D3 a,D3 b) { return {a[0]-b[0],a[1]-b[1],a[2]-b[2]}; }
double dot(D3 a,D3 b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
D3 cross(D3 a,D3 b) { return {a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]}; }
double length(D3 a) { return std::sqrt(dot(a,a)); }
Vec3 vec(D3 a) { return {float(a[0]),float(a[1]),float(a[2])}; }
}
Job::Job(std::shared_ptr<const Scene> scene,MaskStorage states,bool selectedOnly,FloorOptions options,
    std::shared_ptr<SceneMemory> scratch)
    :scene_(std::move(scene)),states_(std::move(states)),selectedOnly_(selectedOnly),options_(options),
    points_(SceneAllocator<D3>{scratch}),axis_(SceneAllocator<double>{scratch}),merge_(SceneAllocator<double>{std::move(scratch)}) {
    if(!scene_) throw std::runtime_error("Floor requires an immutable scene owner.");
    if(!states_.empty()&&states_.size()!=scene_->gaussians.size()) throw std::runtime_error("Floor selection does not match the scene.");
    if(!std::isfinite(options_.threshold)||options_.threshold<0||!options_.iterations||options_.iterations>10000||options_.samples<3||options_.samples>100000)
        throw std::runtime_error("Invalid floor detection settings.");
    retainedCapacity_=std::min<size_t>(options_.samples,scene_->gaussians.size());
    // Browser admission, separate from the captured source's setting grammar.
    if(!scene_->isGaussian()||scene_->gaussians.size()>maximumSources||retainedCapacity_>maximumRetained)
        throw std::runtime_error("Floor exceeds its admitted Gaussian/sample domain.");
    if(!points_.get_allocator().memory()) throw std::invalid_argument("Floor analysis requires an admission service");
    threshold_=options_.threshold;
}
void Job::Deleter::operator()(Job *value) noexcept {
    if(!value) return;
    value->~Job();AdmittedAllocator<Job>{memory}.deallocate(value,1);
}
Job::Pointer Job::create(std::shared_ptr<const Scene> scene,MaskStorage states,bool selectedOnly,
                        FloorOptions options,std::shared_ptr<SceneMemory> memory) {
    if(!memory) throw std::invalid_argument("Floor analysis requires an admission service");
    AdmittedAllocator<Job> allocator{memory};auto *raw=allocator.allocate(1);
    try { ::new(static_cast<void *>(raw)) Job(std::move(scene),std::move(states),selectedOnly,options,memory); }
    catch(...) { allocator.deallocate(raw,1);throw; }
    return Pointer(raw,Deleter{std::move(memory)});
}
void Job::retire(Pointer &owner) noexcept {
    if(owner) owner->cancel();owner.reset();owner.get_deleter().memory.reset();
}
CandidatePointer retain(Candidate value,std::shared_ptr<SceneMemory> memory) {
    if(!memory) throw std::invalid_argument("Floor candidate requires an admission service");
    AdmittedAllocator<Candidate> allocator{memory};auto *raw=allocator.allocate(1);
    try { ::new(static_cast<void *>(raw)) Candidate(std::move(value)); }
    catch(...) { allocator.deallocate(raw,1);throw; }
    return CandidatePointer(raw,[memory=std::move(memory)](const Candidate *candidate) noexcept {
        auto *mutableCandidate=const_cast<Candidate *>(candidate);
        mutableCandidate->~Candidate();AdmittedAllocator<Candidate>{memory}.deallocate(mutableCandidate,1);
    });
}
bool validPlane(const FloorPlane &p,size_t loadedCount) noexcept {
    const auto finite=[](Vec3 v) { return std::isfinite(v.x)&&std::isfinite(v.y)&&std::isfinite(v.z); };
    const double length=std::sqrt(double(p.normal.x)*p.normal.x+double(p.normal.y)*p.normal.y+double(p.normal.z)*p.normal.z);
    return finite(p.normal)&&finite(p.center)&&std::isfinite(p.radius)&&p.radius>0&&
        std::isfinite(p.rms)&&p.rms>=0&&std::abs(length-1)<=1e-4&&p.inliers>=3&&
        p.inliers<=p.tested&&p.tested<=std::min<size_t>(Job::maximumRetained,loadedCount);
}
size_t Job::scratchBytes() const noexcept { return points_.capacity()*sizeof(D3)+(axis_.capacity()+merge_.capacity())*sizeof(double); }
void Job::updateScratch() noexcept { progress_.peakScratchBytes=std::max(progress_.peakScratchBytes,scratchBytes()); }
void Job::finish(Status status) noexcept {
    SceneVector<D3>(points_.get_allocator()).swap(points_);
    SceneVector<double>(axis_.get_allocator()).swap(axis_);
    SceneVector<double>(merge_.get_allocator()).swap(merge_);
    if(status!=Status::Candidate) result_.reset();
    status_=status;phase_=Phase::Terminal;
}
void Job::cancel() noexcept { finish(Status::Cancelled); }
bool Job::draw() { ++progress_.rawDraws;const bool accepted=mapper_.attempt(random_);if(accepted)++progress_.mappedDraws;return accepted; }
Status Job::step(size_t maxWork,std::stop_token stop) {
    progress_.lastStepActions=0;
    if(status_!=Status::Working) return status_;
    if(stop.stop_requested()) { cancel();return status_; }
    try {
        while(progress_.lastStepActions<maxWork&&status_==Status::Working) {
            if(stop.stop_requested()) { cancel();break; }
            advance();++progress_.lastStepActions;++progress_.actions;
            if(stop.stop_requested()) { cancel();break; }
        }
    } catch(...) { finish(Status::Refused);throw; }
    return status_;
}
void Job::advance() {
    switch(phase_) {
    case Phase::AllocatePoints:
        points_.reserve(retainedCapacity_);updateScratch();phase_=Phase::Scan;break;
    case Phase::Scan: {
        if(source_==scene_->gaussians.size()) {
            progress_.sampleCount=points_.size();
            if(points_.size()<3) { finish(Status::None);break; }
            phase_=threshold_?Phase::RansacStart:Phase::AllocateAxis;break;
        }
        const auto state=states_.empty()?0:states_[source_];const auto &p=scene_->gaussians[source_++].positionOpacity;
        progress_.sourcesScanned=source_;
        if((state&2)||(selectedOnly_&&!(state&1))||p[3]<1.f/255||!std::isfinite(p[0])||!std::isfinite(p[1])||!std::isfinite(p[2])) break;
        ++eligible_;progress_.eligible=eligible_;pending_={p[0],p[1],p[2]};
        if(points_.size()<options_.samples) points_.push_back(pending_);
        else { mapper_.begin(uint32_t(eligible_-1));phase_=Phase::ReservoirDraw; }
        break;
    }
    case Phase::ReservoirDraw:
        if(draw()) { if(mapper_.value()<points_.size()) points_[mapper_.value()]=pending_;phase_=Phase::Scan; }break;
    case Phase::AllocateAxis:
        axis_.reserve(points_.size());updateScratch();phase_=Phase::AllocateMerge;break;
    case Phase::AllocateMerge:
        merge_.reserve(points_.size());updateScratch();cursor_=0;phase_=Phase::AxisFill;break;
    case Phase::AxisFill:
        if(cursor_==points_.size()) { width_=1;run_=0;phase_=Phase::MergeSetup;break; }
        if(!axisNumber_) { axis_.push_back(points_[cursor_][axisNumber_]);merge_.push_back(0); }
        else axis_[cursor_]=points_[cursor_][axisNumber_];
        ++cursor_;break;
    case Phase::MergeSetup:
        if(width_>=points_.size()) { phase_=Phase::AxisExtent;break; }
        if(run_>=points_.size()) { axis_.swap(merge_);width_*=2;run_=0;break; }
        left_=run_;middle_=std::min(run_+width_,points_.size());right_=middle_;end_=std::min(run_+2*width_,points_.size());write_=run_;phase_=Phase::MergeWrite;break;
    case Phase::MergeWrite:
        if(write_==end_) { run_=end_;phase_=Phase::MergeSetup;break; }
        merge_[write_++]=(right_==end_||(left_<middle_&&!(axis_[right_]<axis_[left_])))?axis_[left_++]:axis_[right_++];break;
    case Phase::AxisExtent: {
        const size_t trim=(axis_.size()-1)/20;
        extent_[axisNumber_]=axis_[axis_.size()-1-trim]-axis_[trim];
        magnitude_=std::max({magnitude_,std::abs(axis_[trim]),std::abs(axis_[axis_.size()-1-trim])});
        if(++axisNumber_==3) phase_=Phase::Threshold;else { cursor_=0;phase_=Phase::AxisFill; }break;
    }
    case Phase::Threshold:
        threshold_=std::max(length(extent_)*.0025,magnitude_*std::numeric_limits<float>::epsilon()*2);
        if(!(threshold_>0)) finish(Status::None);else phase_=Phase::RansacStart;break;
    case Phase::RansacStart:
        if(iteration_==options_.iterations) { if(support_<std::max<size_t>(3,points_.size()/20))finish(Status::None);else { cursor_=0;phase_=Phase::Center; }break; }
        mapper_.begin(uint32_t(points_.size()-1));phase_=Phase::DrawA;break;
    case Phase::DrawA: case Phase::DrawB: case Phase::DrawC:
        if(draw()) {
            const auto which=phase_==Phase::DrawA?0:phase_==Phase::DrawB?1:2;triple_[which]=mapper_.value();
            if(which==0)phase_=Phase::DrawB;else if(which==1)phase_=Phase::DrawC;else phase_=Phase::Hypothesis;
        }break;
    case Phase::Hypothesis: {
        const auto [a,b,c]=triple_;
        if(a==b||b==c||a==c) { ++iteration_;phase_=Phase::RansacStart;break; }
        const auto ab=minus(points_[b],points_[a]),ac=minus(points_[c],points_[a]);normal_=cross(ab,ac);
        const double norm=length(normal_);
        if(norm<=length(ab)*length(ac)*1e-6) { ++iteration_;phase_=Phase::RansacStart;break; }
        for(auto &v:normal_)v/=norm;
        d_=-dot(normal_,points_[a]);inliers_=0;error_=0;cursor_=0;phase_=Phase::Score;break;
    }
    case Phase::Score:
        if(cursor_==points_.size()) { phase_=Phase::Winner;break; }
        { const double distance=std::abs(dot(normal_,points_[cursor_++])+d_);if(distance<=threshold_) { ++inliers_;error_+=distance*distance; } }break;
    case Phase::Winner:
        if(inliers_>support_||(inliers_==support_&&error_<bestError_)) { support_=inliers_;best_=normal_;bestD_=d_;bestError_=error_; }
        ++iteration_;
        if(support_>=size_t(points_.size()*.8)) { if(support_<std::max<size_t>(3,points_.size()/20))finish(Status::None);else { cursor_=0;phase_=Phase::Center; } }
        else phase_=Phase::RansacStart;break;
    case Phase::Center:
        if(cursor_==points_.size()) { cursor_=0;phase_=Phase::Covariance;break; }
        { const auto &p=points_[cursor_++];if(std::abs(dot(best_,p)+bestD_)<=threshold_)for(int k=0;k<3;++k)center_[k]+=p[k]/support_; }break;
    case Phase::Covariance:
        if(cursor_==points_.size()) { phase_=Phase::Jacobi;break; }
        { const auto &p=points_[cursor_++];if(std::abs(dot(best_,p)+bestD_)<=threshold_) { const auto v=minus(p,center_);for(int r=0;r<3;++r)for(int c=0;c<3;++c)covariance_[r][c]+=v[r]*v[c]; } }break;
    case Phase::Jacobi: {
        if(jacobiIteration_==32) { phase_=Phase::RefinedNormal;break; }
        int a=0,b=1;
        for(int r=0;r<3;++r)for(int c=r+1;c<3;++c)if(std::abs(covariance_[r][c])>std::abs(covariance_[a][b])) { a=r;b=c; }
        if(std::abs(covariance_[a][b])<=1e-14*std::max({covariance_[0][0],covariance_[1][1],covariance_[2][2]})) { phase_=Phase::RefinedNormal;break; }
        const double angle=.5*std::atan2(2*covariance_[a][b],covariance_[b][b]-covariance_[a][a]);
        const double cs=std::cos(angle),sn=std::sin(angle);
        for(int k=0;k<3;++k) {
            const double u=covariance_[k][a],v=covariance_[k][b];covariance_[k][a]=cs*u-sn*v;covariance_[k][b]=sn*u+cs*v;
            const double x=axes_[k][a],y=axes_[k][b];axes_[k][a]=cs*x-sn*y;axes_[k][b]=sn*x+cs*y;
        }
        for(int k=0;k<3;++k) { const double u=covariance_[a][k],v=covariance_[b][k];covariance_[a][k]=cs*u-sn*v;covariance_[b][k]=sn*u+cs*v; }
        ++jacobiIteration_;break;
    }
    case Phase::RefinedNormal: {
        int smallest=0;for(int i=1;i<3;++i)if(covariance_[i][i]<covariance_[smallest][smallest])smallest=i;
        std::array<double,3> variance{covariance_[0][0],covariance_[1][1],covariance_[2][2]};std::sort(variance.begin(),variance.end());
        if(!(variance[1]>variance[2]*1e-10)) { finish(Status::None);break; }
        best_={axes_[0][smallest],axes_[1][smallest],axes_[2][smallest]};const double norm=length(best_);
        if(!std::isfinite(norm)||norm<=0)throw std::runtime_error("Choose distinct points on the scene.");
        for(auto &v:best_)v/=norm;
        bestD_=-dot(best_,center_);positive_=negative_=inliers_=0;error_=radius_=0;cursor_=0;phase_=Phase::FinalSupport;break;
    }
    case Phase::FinalSupport:
        if(cursor_==points_.size()) { phase_=Phase::Finish;break; }
        { const auto &p=points_[cursor_++];const double d=dot(best_,p)+bestD_;if(d>threshold_)++positive_;else if(d<-threshold_)++negative_;else { ++inliers_;error_+=d*d;radius_=std::max(radius_,length(minus(p,center_))); } }break;
    case Phase::Finish: {
        if(inliers_<std::max<size_t>(3,points_.size()/20)||!(radius_>threshold_*2)) { finish(Status::None);break; }
        const double cameraSide=options_.viewpoint?dot(best_,minus({options_.viewpoint->x,options_.viewpoint->y,options_.viewpoint->z},center_)):0;
        if(cameraSide<-threshold_||(std::abs(cameraSide)<=threshold_&&(negative_>positive_||(negative_==positive_&&best_[1]<0))))for(auto &v:best_)v=-v;
        const FloorPlane candidate{vec(best_),vec(center_),float(radius_),float(std::sqrt(error_/std::max<size_t>(1,inliers_))),inliers_,points_.size()};
        finish(Status::Candidate);result_=candidate;break;
    }
    case Phase::Terminal: break;
    }
}
} // namespace preview::browser_floor
