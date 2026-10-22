#include "auto_color_analysis_job.hpp"
#include "resource_budget.hpp"
#include "allocation_census.hpp"
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <random>
#include <stdexcept>
#include <vector>

// Default-action oracle follows SplatView processing.cpp sample/Histogram/
// autoGrade (portable MIT source; captured Windows lines 500-587,649-772).
// It retains float samples and uses std::sort independently of the bounded
// radix implementation. No PlayCanvas color statistics are used here.
using namespace preview;
namespace ac = preview::browser_auto_color;
int autoColorMetadataContracts();
namespace {
size_t checks{}, cases{}, oracleFixtures{}, staleCases{}, refusalCases{}, callbackProgress{}, cancellationPhases{};
size_t observedAttempts{};
bool observe{};
void allocationObserved(const sv_allocation::Event &event) noexcept {
    if(observe && event.kind==sv_allocation::EventKind::NewAttempt) ++observedAttempts;
}
void require(bool condition,const char *message) {
    ++checks;
    if(!condition) throw std::runtime_error(message);
}
template<class F> void rejects(F &&f) {
    bool refused=false;
    try { f(); } catch(const std::exception &) { refused=true; }
    require(refused,"Expected Auto owner creation refusal");
}
float luminance(const std::array<float,3> &c) { return .299f*c[0]+.587f*c[1]+.114f*c[2]; }
bool same(float a,float b) { return std::bit_cast<uint32_t>(a)==std::bit_cast<uint32_t>(b); }
uint64_t hash(const void *start,size_t count) {
    const auto *bytes=static_cast<const uint8_t *>(start);uint64_t value=1469598103934665603ull;
    for(size_t i=0;i<count;++i) { value^=bytes[i];value*=1099511628211ull; }
    return value;
}
std::shared_ptr<Scene> fixture(size_t n,bool gray=false) {
    auto scene=std::make_shared<Scene>();scene->gaussians.reserve(n);scene->sourceCount=n;
    for(size_t i=0;i<n;++i) {
        Attributes a;a.position={float(i%17),float(i%13),float(i%11)};a.opacity=i%2?0.f:1.f;
        if(!gray) for(unsigned k=0;k<3;++k) a.sh[k]=float(int((i*(17+k*2))%103)-51)/20;
        for(size_t k=3;k<a.sh.size();++k) a.sh[k]=float(k%7)*.2f;
        scene->gaussians.push_back(packGaussian(a));
    }
    return scene;
}
ac::AnalysisSnapshot snapshot(std::shared_ptr<const Scene> scene,bool selected) {
    std::vector<uint8_t> mask(scene->gaussians.size());
    for(size_t i=0;i<mask.size();++i) mask[i]=static_cast<uint8_t>(i%7==0?2:(i%3==0?1:0));
    if(!mask.empty()) mask[0]=1;
    return {std::move(scene),MaskStorage::copy(mask),{71,19,5,23,101,102,0,103,selected},true};
}
struct Oracle {
    std::array<ColorValues,4> suggestions;
    std::array<float,4> percentiles;
    size_t eligible{},samples{},trimmed{};
};
Oracle oracle(const ac::AnalysisSnapshot &input) {
    size_t eligible=0;
    for(auto state:input.states) if(!(state&2)&&(!input.key.selectedOnly||(state&1))) ++eligible;
    if(!eligible) throw std::runtime_error("No eligible source color samples");
    const size_t desired=std::min(eligible,size_t(65536));
    std::vector<std::array<float,3>> colors;colors.reserve(desired);
    size_t ordinal=0,next=0;
    for(size_t i=0;i<input.states.size();++i) {
        const auto state=input.states[i];
        if((state&2)||(input.key.selectedOnly&&!(state&1))) continue;
        if(ordinal++!=uint64_t(next)*eligible/desired) continue;
        const auto &g=input.base->gaussians[i];
        colors.push_back({std::clamp(shValue(g,0,0)*.28209479177387814f+.5f,0.f,1.f),
                          std::clamp(shValue(g,0,1)*.28209479177387814f+.5f,0.f,1.f),
                          std::clamp(shValue(g,0,2)*.28209479177387814f+.5f,0.f,1.f)});
        if(++next==desired) break;
    }
    std::vector<float> sorted;sorted.reserve(colors.size());
    for(const auto &color:colors) sorted.push_back(luminance(color));
    std::sort(sorted.begin(),sorted.end());
    const auto percentile=[&](float p) {
        const double i=std::clamp(double(p),0.,100.)*.01*(sorted.size()-1);
        const size_t a=size_t(i),b=std::min(a+1,sorted.size()-1);
        return float(sorted[a]+(sorted[b]-sorted[a])*(i-a));
    };
    Oracle result;for(auto &values:result.suggestions) values=neutralColor;
    result.percentiles={percentile(.1f),percentile(1),percentile(99),percentile(100-.1f)};
    result.eligible=eligible;result.samples=colors.size();
    const float range=result.percentiles[3]-result.percentiles[0];
    if(range>.01f) result.suggestions[2][1]=std::clamp(.95f/range,.5f,3.f);
    float sum=0;std::array<float,3> average{};
    for(const auto &color:colors) {
        const float l=luminance(color);
        if(l>=result.percentiles[1]&&l<=result.percentiles[2]) {
            sum+=l;++result.trimmed;
            for(size_t k=0;k<3;++k) average[k]+=color[k];
        }
    }
    if(result.trimmed&&sum/float(result.trimmed)>.01f)
        result.suggestions[1][0]=std::clamp(.45f/(sum/float(result.trimmed)),.5f,2.5f);
    if(result.trimmed) {
        for(auto &v:average) v/=float(result.trimmed);
        const float target=(average[0]+average[1]+average[2])/3;
        std::array<float,3> gain{};
        for(size_t k=0;k<3;++k) gain[k]=std::clamp(target/(average[k]+1e-8f),.5f,2.f);
        result.suggestions[3][5]=std::clamp((gain[0]/gain[2]-1)*.5f,-1.f,1.f);
        result.suggestions[3][6]=std::clamp((1-gain[1]/((gain[0]+gain[2])/2))*.5f,-1.f,1.f);
    }
    const float strength=1,warmth=.5f;
    result.suggestions[0][0]=std::clamp(1+(result.suggestions[1][0]-1)*strength,.5f,2.f);
    result.suggestions[0][1]=std::clamp(1+(result.suggestions[2][1]-1)*strength*.7f,.7f,1.5f);
    result.suggestions[0][5]=result.suggestions[3][5]*strength*warmth;
    result.suggestions[0][6]=result.suggestions[3][6]*strength*warmth;
    return result;
}
void finish(ac::AnalysisOwner &owner,const ac::AnalysisSnapshot &now,size_t budget=4096) {
    size_t guard=0;double previous=0;
    while(owner.pending()) {
        require(owner.step(budget,now)<=std::min(budget,ac::maximumStepWork),"Analysis exceeded supplied bounded work");
        const auto progress=owner.progress();++callbackProgress;
        require(progress>=previous&&progress<=1,"Analysis progress callback regressed or overflowed");previous=progress;
        require(++guard<5'000'000,"Analysis failed to finish");
    }
}
void compare(size_t n,bool selected,size_t step=4096,bool gray=false) {
    ++cases;
    const auto input=snapshot(fixture(n,gray),selected);const auto expected=oracle(input);
    const auto sourceHash=hash(input.base->gaussians.data(),n*sizeof(Gaussian)),maskHash=hash(input.states.data(),n);
    ResourceBudget budget(ac::AnalysisOwner::payloadBytes(n));
    auto owner=ac::AnalysisOwner::create(input,sceneMemoryForBudget(budget,ResourceCategory::Work));
    require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==ac::AnalysisOwner::payloadBytes(n),
            "Analysis admission is not exact owner plus three arrays");
    require(owner->baseline().base==input.base&&owner->baseline().states.data()==input.states.data(),
            "Analysis copied immutable Gaussian/mask payload");
    const auto before=observedAttempts;observe=true;finish(*owner,input,step);observe=false;
    require(observedAttempts==before,"Bounded analysis step/callback allocated hidden C++ payload");
    const auto *actual=owner->result(input);require(actual&&owner->status()==ac::AnalysisStatus::Complete,"Analysis failed to complete");
    require(actual->samples==expected.samples&&actual->eligible==expected.eligible&&actual->trimmed==expected.trimmed,
            "Eligible/sample/trimmed counts differ from SplatView source oracle");
    for(size_t k=0;k<4;++k) require(same(actual->percentiles[k],expected.percentiles[k]),"Exact source percentile differs");
    for(size_t action=0;action<4;++action) for(size_t k=0;k<15;++k)
        require(same(actual->suggestions[action][k],expected.suggestions[action][k]),"Source default action grade differs bitwise");
    if(gray) require(same(actual->suggestions[1][0],.9f)&&actual->suggestions[2][1]==1&&
        actual->suggestions[3][5]==0&&actual->suggestions[3][6]==0,"Exact neutral-gray analytic fixture differs");
    require(hash(input.base->gaussians.data(),n*sizeof(Gaussian))==sourceHash&&hash(input.states.data(),n)==maskHash,
            "Read-only source color analysis mutated packed scene or mask");
    ac::AnalysisOwner::retire(owner);
    require(!owner&&!owner.get_deleter().memory&&budget.usage().totalBytes==0,"Analysis retirement leaked admitted Work/service");
    ++oracleFixtures;
}
struct DenyMemory final : SceneMemory {
    DenyMemory(std::shared_ptr<SceneMemory> delegate,size_t deny):delegate(std::move(delegate)),deny(deny) {}
    std::shared_ptr<void> admit(size_t bytes) override { if(++calls==deny) throw std::bad_alloc();return delegate->admit(bytes); }
    std::shared_ptr<SceneMemory> delegate;size_t calls{},deny{};
};
void refusalAndStale() {
    const auto input=snapshot(fixture(257),false);
    for(size_t deny=1;deny<=4;++deny) {
        ++cases;ResourceBudget budget(1'000'000);
        auto memory=std::make_shared<DenyMemory>(sceneMemoryForBudget(budget,ResourceCategory::Work),deny);
        rejects([&] { auto owner=ac::AnalysisOwner::create(input,memory); });
        require(budget.usage().totalBytes==0,"Partial admitted owner construction leaked grants");++refusalCases;
    }
    for(size_t variant=0;variant<12;++variant) {
        ++cases;auto now=input;
        switch(variant) {
        case 0:++now.key.documentId;break;case 1:++now.key.sourceGeneration;break;case 2:++now.key.contentRevision;break;
        case 3:++now.key.selectionRevision;break;case 4:++now.key.colorSessionId;break;case 5:++now.key.colorBaseId;break;
        case 6:++now.key.colorBaseContentRevision;break;case 7:++now.key.requestGeneration;break;
        case 8:now.key.selectedOnly=true;break;case 9:now.settled=false;break;
        case 10:now.base=fixture(257);break;case 11:now.states=input.states.clone();break;
        }
        ResourceBudget budget(1'000'000);auto owner=ac::AnalysisOwner::create(input,sceneMemoryForBudget(budget,ResourceCategory::Work));
        owner->step(4096,input);const auto work=owner->workDone();
        require(owner->step(4096,now)==0&&owner->workDone()==work,"Stale baseline performed more source work");
        require(owner->status()==ac::AnalysisStatus::Stale&&!owner->result(now)&&!owner->result(input),"Stale analysis exposed result");
        ac::AnalysisOwner::retire(owner);require(budget.usage().totalBytes==0,"Stale owner leaked Work");++staleCases;
    }
    ++cases;ResourceBudget budget(1'000'000);
    auto owner=ac::AnalysisOwner::create(input,sceneMemoryForBudget(budget,ResourceCategory::Work));finish(*owner,input);
    auto newer=input;++newer.key.requestGeneration;require(!owner->result(newer),"Completed result bypassed request identity");
    owner->cancel();require(!owner->result(input),"Cancel exposed already completed result");
    ac::AnalysisOwner::retire(owner);require(budget.usage().totalBytes==0,"Completed cancellation leaked Work");
}
void cooperativeCancellation() {
    const auto source=fixture(257);const auto input=snapshot(source,false);
    const auto sourceHash=hash(source->gaussians.data(),source->gaussians.size()*sizeof(Gaussian));
    const auto required=ac::scratchRequirements(source->gaussians.size());
    std::vector<float> first(required.samples),temporary(required.samples),bins(768);
    for(const auto target:{ac::Phase::ZeroBins,ac::Phase::Count,ac::Phase::Sample,ac::Phase::ZeroRadix,
        ac::Phase::CountRadix,ac::Phase::PrefixRadix,ac::Phase::ScatterRadix,ac::Phase::Quantiles,
        ac::Phase::Trim,ac::Phase::NormalizeBins,ac::Phase::Finish}) {
        ++cases;ac::Job job(source->gaussians,input.states.span(),false,{first,temporary,bins});
        while(job.pending()&&job.phase()!=target) require(job.step(1)==1,"Single-item cancellation step stuck");
        require(job.phase()==target,"Cancellation phase not reached");const auto work=job.workDone();job.cancel();
        require(!job.result()&&job.step(4096)==0&&job.workDone()==work,"Cancelled phase advanced or exposed result");++cancellationPhases;
    }
    ++cases;const auto large=snapshot(fixture(100000),false);ResourceBudget budget(1'000'000);
    auto owner=ac::AnalysisOwner::create(large,sceneMemoryForBudget(budget,ResourceCategory::Work));
    const auto before=observedAttempts;observe=true;
    owner->step(4096,large);++callbackProgress;require(owner->pending()&&owner->progress()>0,"Actual analysis progress callback not pending");
    owner->cancel();require(owner->step(4096,large)==0&&!owner->result(large),"Progress callback cancellation published later work");
    observe=false;require(observedAttempts==before,"Progress cancellation allocated C++ payload");
    ac::AnalysisOwner::retire(owner);require(budget.usage().totalBytes==0,"Progress cancellation leaked Work");
    require(hash(source->gaussians.data(),source->gaussians.size()*sizeof(Gaussian))==sourceHash,"Cancelled source mutated");
}
}
int main() {
    try {
        sv_allocation::setObserverForContracts(allocationObserved);
        compare(1,false,1,true);compare(13,true,7,true);
        for(size_t n:{size_t(2),size_t(211),size_t(65535),size_t(65536),size_t(65537),size_t(100000),size_t(1000000)})
            for(bool selected:{false,true}) compare(n,selected);
        refusalAndStale();cooperativeCancellation();
        sv_allocation::setObserverForContracts(nullptr);
        require(autoColorMetadataContracts()==0,"Color metadata contracts failed");
        std::printf("AUTO_COLOR_NATIVE_CONTRACTS_PASS cases=%zu checks=%zu sourceOracleFixtures=%zu staleCases=%zu admissionRefusals=%zu cancellationPhases=%zu progressCallbacks=%zu observedStepAllocations=%zu jobBytes=%zu ownerBytes=%zu typedResultBytes=%zu ownerScratchMax=%zu\n",
            cases,checks,oracleFixtures,staleCases,refusalCases,cancellationPhases,callbackProgress,observedAttempts,
            sizeof(ac::Job),sizeof(ac::AnalysisOwner),sizeof(ac::AnalysisResult),ac::AnalysisOwner::payloadBytes(1000000));
        return 0;
    } catch(const std::exception &error) {
        observe=false;sv_allocation::setObserverForContracts(nullptr);
        std::fprintf(stderr,"AUTO_COLOR_NATIVE_CONTRACTS_FAIL %s\n",error.what());return 1;
    }
}
