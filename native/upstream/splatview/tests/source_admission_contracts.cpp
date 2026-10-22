#include "source_admission_contracts.hpp"
#include "source_snapshot.hpp"
#include <fstream>
#include <memory>
#include <type_traits>
#include <utility>
#ifdef _WIN32
#include <windows.h>
#endif

namespace {
using namespace preview;
static_assert(!std::is_copy_constructible_v<FileSnapshot> &&
              std::is_nothrow_move_constructible_v<FileSnapshot> &&
              std::is_nothrow_move_assignable_v<FileSnapshot>);
static_assert(!std::is_copy_constructible_v<SourceSnapshot> &&
              std::is_nothrow_move_constructible_v<SourceSnapshot> &&
              std::is_nothrow_move_assignable_v<SourceSnapshot>);
void require(bool value,const char *message) {
    if(!value) throw std::runtime_error(message);
}
template<class Error=std::exception,class F> void rejects(F &&function,const char *message) {
    try { std::forward<F>(function)(); }
    catch(const Error &) { return; }
    throw std::runtime_error(message);
}
void write(const std::filesystem::path &file,const std::string &text) {
    std::ofstream output(file,std::ios::binary|std::ios::trunc);
    output.write(text.data(),std::streamsize(text.size()));
    require(bool(output),"Write source admission fixture");
}
std::string text(const FileSnapshot &snapshot) {
    return {snapshot.bytes().begin(),snapshot.bytes().end()};
}
void empty(const ResourceBudget &budget,const char *message) {
    const auto usage=budget.usage();
    require(usage.totalBytes==0,message);
    for(const auto bytes:usage.categoryBytes) require(bytes==0,message);
}
void charged(const ResourceBudget &budget,size_t bytes,const char *message) {
    const auto usage=budget.usage();
    require(usage.totalBytes==bytes &&
            usage.categoryBytes[size_t(ResourceCategory::Source)]==bytes,message);
    for(size_t i=1;i<resourceCategoryCount;++i) require(usage.categoryBytes[i]==0,message);
}
void fileLifetime(const std::filesystem::path &directory) {
    const auto path=directory/"payload.bin";
    const std::string payload="source-payload";
    write(path,payload);
    const auto modified=std::filesystem::last_write_time(path);
    const auto identity=fileIdentity(path);
    ResourceBudget budget(payload.size()*2);
    {
        FileSnapshot first(path,payload.size(),{},budget);
        require(text(first)==payload && first.identity()==identity,"An admitted file retains its exact source bytes and identity");
        charged(budget,payload.size(),"A file buffer owns its Source grant");
        FileSnapshot second(std::move(first));
        require(first.bytes().empty(),"A moved-from file snapshot must expose an empty byte span");
        charged(budget,payload.size(),"Move construction must not duplicate or release source accounting");
        FileSnapshot replacement(path,payload.size(),{},budget);
        charged(budget,payload.size()*2,"Separate file snapshots are separate physical allocations");
        replacement=std::move(second);
        charged(budget,payload.size(),"Move assignment frees the old byte array and its grant exactly once");
        auto *same=&replacement;
        replacement=std::move(*same);
        charged(budget,payload.size(),"Self move must preserve the source buffer and its grant");
        require(text(replacement)==payload,"Moves preserve captured bytes");
    }
    empty(budget,"All file grants release with their buffers");
    require(std::filesystem::last_write_time(path)==modified && fileIdentity(path)==identity,
            "Source capture must not modify the source file");
    std::unique_ptr<FileSnapshot> survivor;
    {
        ResourceBudget shortLived(payload.size());
        survivor=std::make_unique<FileSnapshot>(path,payload.size(),std::stop_token{},shortLived);
    }
    require(text(*survivor)==payload,"A file grant must safely outlive every budget handle");
    survivor.reset();
}
void fileRejection(const std::filesystem::path &directory) {
    const auto path=directory/"bounded.bin";
    write(path,"abcdef");
    ResourceBudget insufficient(5);
    rejects<ResourceBudgetExceeded>([&] { FileSnapshot source(path,6,{},insufficient); },
                                    "File admission must reject before the six-byte payload allocation");
    empty(insufficient,"Rejected file admission cannot retain a grant");
    require(insufficient.usage().peakBytes==0,"A failed file reservation cannot increase the peak charge");
    ResourceLimits limits{20};
    limits.categoryBytes[size_t(ResourceCategory::Source)]=5;
    ResourceBudget categoryBound(limits);
    rejects<ResourceBudgetExceeded>([&] { FileSnapshot source(path,6,{},categoryBound); },
                                    "Source category limits must apply independently of the total limit");
    empty(categoryBound,"Category rejection releases all state");
    ResourceBudget budget(6);
    rejects([&] { FileSnapshot source(path,5,{},budget); },"The explicit file-size bound must precede admission");
    rejects([&] { FileSnapshot source(directory/"missing.bin",6,{},budget); },"Missing source files must reject");
    require(budget.usage().peakBytes==0,"Size and open failures must precede byte admission");
    std::stop_source stop;
    stop.request_stop();
    rejects([&] { FileSnapshot source(path,6,stop.get_token(),budget); },"Pre-cancelled file reads must reject");
    require(budget.usage().peakBytes==0,"Pre-cancelled file reads cannot reserve source bytes");
    {
        FileSnapshot held(path,6,{},budget);
        rejects<ResourceBudgetExceeded>([&] { FileSnapshot competing(path,6,{},budget); },
                                        "Live source storage must compete for the same shared budget");
        charged(budget,6,"Rejected competing reads must preserve the existing snapshot's grant");
    }
    { FileSnapshot reused(path,6,{},budget); charged(budget,6,"Released source capacity must be reusable"); }
    empty(budget,"Successful retry must release its grant");
    write(directory/"empty.bin","");
    ResourceBudget zero(0);
    FileSnapshot emptyFile(directory/"empty.bin",0,{},zero);
    require(emptyFile.bytes().empty(),"A zero-byte file fits an explicit zero-byte budget");
    empty(zero,"Empty file storage incurs no positive payload charge");
}
std::string sog(const std::filesystem::path &directory) {
    std::filesystem::create_directories(directory);
    const std::string metadata=R"({"means":{"files":["lo.webp","hi.webp"]},"sh0":{"files":["lo.webp","color.webp"]}})";
    write(directory/"meta.json",metadata);
    write(directory/"lo.webp","low");
    write(directory/"hi.webp","high");
    write(directory/"color.webp","colors");
    return metadata;
}
void sogLifetime(const std::filesystem::path &directory) {
    const auto folder=directory/"sog-lifetime";
    const auto metadata=sog(folder);
    const size_t total=metadata.size()+3+4+6;
    ResourceBudget budget(total*2);
    const auto baseline=sourceStamp(folder);
    const auto modified=std::filesystem::last_write_time(folder/"meta.json");
    {
        SourceSnapshot first(folder,total,{},budget);
        require(first.stamp()==baseline && first.stamp().bytes==total && first.files().size()==4,
                "SOG admission must preserve fingerprint semantics and count duplicate member names once");
        charged(budget,total,"SOG source bytes include metadata plus each distinct member buffer");
        require(first.member("lo.webp").size()==3 && first.member("color.webp").size()==6,
                "Every declared SOG member remains available to the decoder");
        SourceSnapshot moved(std::move(first));
        charged(budget,total,"Moving a SOG snapshot must retain its aggregate grant");
        SourceSnapshot replacement(folder,total,{},budget);
        charged(budget,total*2,"Independent SOG snapshots must charge independent buffers");
        replacement=std::move(moved);
        charged(budget,total,"SOG move assignment releases only the replaced buffers");
        auto *same=&replacement;
        replacement=std::move(*same);
        require(replacement.stamp()==baseline && replacement.member("hi.webp").size()==4,
                "SOG self move preserves all member storage and its stamp");
    }
    empty(budget,"SOG snapshot destruction releases metadata and aggregate texture grants");
    require(sourceStamp(folder,{},budget)==baseline,"Budgeted sourceStamp preserves the existing identity contract");
    empty(budget,"A stamp-only call must release temporary source bytes before returning");
    require(sourceStamp(folder)==baseline && std::filesystem::last_write_time(folder/"meta.json")==modified,
            "SOG admission must not modify any captured source bytes");
}
void sogRejection(const std::filesystem::path &directory) {
    const auto folder=directory/"sog-rejection";
    const auto metadata=sog(folder);
    const size_t total=metadata.size()+13;
    ResourceBudget shortBudget(total-1);
    rejects<ResourceBudgetExceeded>([&] { SourceSnapshot source(folder,total,{},shortBudget); },
                                    "SOG texture admission must consider every member before the first texture allocation");
    empty(shortBudget,"SOG aggregate budget rejection must roll back metadata admission");
    require(shortBudget.usage().peakBytes==metadata.size(),
            "Aggregate SOG rejection must charge only the metadata needed to discover its members");
    ResourceBudget sizeBudget(total*2);
    rejects([&] { SourceSnapshot source(folder,total-1,{},sizeBudget); },
            "SOG remaining input-size bounds must reject the complete member set before texture reads");
    empty(sizeBudget,"SOG input-size rejection must release metadata");
    require(sizeBudget.usage().peakBytes==metadata.size(),"Input-size rejection must precede the aggregate texture grant");
    const auto missing=folder/"hi.webp";
    std::filesystem::remove(missing);
    ResourceBudget missingBudget(total);
    rejects([&] { SourceSnapshot source(folder,total,{},missingBudget); },"A missing declared SOG member must reject");
    empty(missingBudget,"Missing SOG members must release metadata and any partial state");
    require(missingBudget.usage().peakBytes==metadata.size(),"Member discovery must finish before texture admission");
    write(missing,"high");
    ResourceBudget retryBudget(total);
    { SourceSnapshot retry(folder,total,{},retryBudget); charged(retryBudget,total,"A valid SOG retry must succeed after rollback"); }
    empty(retryBudget,"Retried SOG buffers must release all charges");
#ifdef _WIN32
    {
        // Attribute-only preflight can succeed while the later snapshot open
        // rejects an existing writer. This deterministically exercises cleanup
        // after the entire SOG texture grant has already been acquired.
        struct Writer {
            HANDLE value;
            ~Writer() { if(value!=INVALID_HANDLE_VALUE) CloseHandle(value); }
        } writer{CreateFileW(platformFilePath(missing).c_str(),GENERIC_WRITE,
                             FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,
                             OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr)};
        require(writer.value!=INVALID_HANDLE_VALUE,"Open SOG member writer fixture");
        ResourceBudget raced(total);
        rejects([&] { SourceSnapshot source(folder,total,{},raced); },
                "A SOG member that becomes unreadable after preflight must reject");
        empty(raced,"A SOG read failure after aggregate admission must release every byte grant");
        require(raced.usage().peakBytes==total,"The failed read fixture must reach aggregate admission");
    }
#endif
    std::stop_source stop;
    stop.request_stop();
    ResourceBudget cancelled(total);
    rejects([&] { SourceSnapshot source(folder,total,stop.get_token(),cancelled); },"Pre-cancelled SOG snapshots must reject");
    require(cancelled.usage().peakBytes==0,"Pre-cancelled SOG snapshots must not allocate metadata or textures");
}
void malformedSog(const std::filesystem::path &directory) {
    const auto folder=directory/"sog-malformed";
    std::filesystem::create_directories(folder);
    for(const std::string &metadata:{std::string("{"),
            std::string(R"({"means":{"files":["../outside.webp"]}})"),
            std::string(R"({"means":{"files":["0","1","2","3","4","5","6","7","8"]}})")}) {
        write(folder/"meta.json",metadata);
        ResourceBudget budget(4096);
        rejects([&] { SourceSnapshot source(folder,4096,{},budget); },"Malformed, unsafe, or oversized SOG member lists must reject");
        empty(budget,"Invalid SOG metadata must release its admitted bytes");
        require(budget.usage().peakBytes==metadata.size(),"Invalid member lists cannot admit texture storage");
    }
}
void immutableDrift(const std::filesystem::path &directory) {
    const auto path=directory/"drift.bin";
    write(path,"original");
    ResourceBudget budget(64);
    {
        FileSnapshot file(path,64,{},budget);
        SourceSnapshot source(path,64,{},budget);
        const auto before=source.stamp();
        write(path,"changed and longer");
        require(text(file)=="original" && source.member("drift.bin").size()==8 && source.stamp()==before,
                "Source edits after capture cannot change immutable captured file bytes or stamp");
        require(sourceStamp(path).contentKey!=before.contentKey,"A later capture must detect source content drift");
        charged(budget,16,"Post-capture source growth must not change captured-storage accounting");
    }
    empty(budget,"Drifted source snapshots must still release their original exact grants");
}
} // namespace
void sourceAdmissionContracts(const std::filesystem::path &directory) {
    const auto fixtures=directory/"source-admission";
    std::filesystem::create_directories(fixtures);
    fileLifetime(fixtures);
    fileRejection(fixtures);
    sogLifetime(fixtures);
    sogRejection(fixtures);
    malformedSog(fixtures);
    immutableDrift(fixtures);
}
