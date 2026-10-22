#include "source_snapshot.hpp"
#include <nlohmann/json.hpp>
#include <limits>
#include <set>
#include <stdexcept>

namespace preview {
namespace {
std::set<std::string> textureNames(const nlohmann::json &json) {
    std::set<std::string> names;
    for(const char *property:{"means","scales","quats","sh0","shN"}) {
        if(!json.contains(property) || json.at(property).is_null()) continue;
        const auto &files=json.at(property).at("files");
        if(!files.is_array() || files.size()>8) throw std::runtime_error("Invalid SOG member list");
        for(const auto &value:files) {
            const auto name=value.get<std::string>();
            if(name.empty() || name.size()>255 || name.find("..")!=std::string::npos || name.find_first_of("/\\:")!=std::string::npos || name=="meta.json")
                throw std::runtime_error("Unsafe SOG texture filename");
            names.insert(name);
        }
    }
    return names;
}
} // namespace
SourceSnapshot::SourceSnapshot(const std::filesystem::path &source,size_t limit,std::stop_token stop,
                               std::optional<ResourceBudget> budget) {
    const auto checkCancelled=[&] { if(stop.stop_requested()) throw std::runtime_error("Loading canceled"); };
    checkCancelled();
    const bool directory=std::filesystem::is_directory(source), sog=directory || source.filename()=="meta.json";
    const auto file=directory?source/"meta.json":source;
    folder_=file.parent_path();
    auto metadata=std::make_unique<FileSnapshot>(file,sog?std::min<size_t>(limit,16*1024*1024):limit,stop,budget);
    stamp_.identity=metadata->identity(); stamp_.bytes=metadata->bytes().size();
    if(!sog) {
        stamp_.contentKey=contentKey(metadata->bytes(),stop); members_.emplace(pathUtf8(file.filename()),std::move(metadata)); return;
    }
    const auto json=nlohmann::json::parse(metadata->bytes());
    members_.emplace("meta.json",std::move(metadata));
    const auto names=textureNames(json);
    struct PlannedMember { std::string name,identity; size_t bytes; };
    std::vector<PlannedMember> planned;
    size_t aggregate=0;
    const auto remaining=limit-size_t(stamp_.bytes);
    for(const auto &name:names) {
        checkCancelled();
        const auto path=folder_/pathFromUtf8(name);
        const auto count=std::filesystem::file_size(platformFilePath(path));
        if(count>512ull*1024*1024 || count>std::numeric_limits<size_t>::max())
            throw std::runtime_error("SOG texture exceeds the previewer's memory budget");
        // Subtraction checks keep both the sum and remaining-input bound safe.
        if(count>remaining-aggregate) throw std::runtime_error("SOG input files exceed memory budget");
        aggregate+=size_t(count);
        planned.push_back({name,fileIdentity(path),size_t(count)});
    }
    checkCancelled();
    if(budget) memberBytes_=budget->reserve(ResourceCategory::Source,aggregate);
    for(const auto &entry:planned) {
        checkCancelled();
        auto member=std::make_unique<FileSnapshot>(folder_/pathFromUtf8(entry.name),entry.bytes,stop);
        if(member->bytes().size()!=entry.bytes || member->identity()!=entry.identity)
            throw std::runtime_error("SOG source changed while loading; reopen it");
        stamp_.bytes+=entry.bytes; members_.emplace(entry.name,std::move(member));
    }
    std::string manifest="SplatView SOG snapshot 1\n";
    for(const auto &[name,member]:members_) manifest+=std::to_string(name.size())+":"+name+":"+std::to_string(member->bytes().size())+":"+contentKey(member->bytes(),stop)+"\n";
    stamp_.contentKey=contentKey({reinterpret_cast<const uint8_t *>(manifest.data()),manifest.size()},stop);
}
SourceSnapshot &SourceSnapshot::operator=(SourceSnapshot &&other) noexcept {
    if(this!=&other) {
        SourceSnapshot replacement(std::move(other));
        folder_.swap(replacement.folder_);
        std::swap(memberBytes_,replacement.memberBytes_);
        members_.swap(replacement.members_);
        std::swap(stamp_,replacement.stamp_);
    }
    return *this;
}
std::span<const uint8_t> SourceSnapshot::member(const std::string &name) const {
    auto i=members_.find(name); if(i==members_.end()) throw std::runtime_error("SOG archive is missing "+name); return i->second->bytes();
}
std::vector<std::filesystem::path> SourceSnapshot::files() const {
    std::vector<std::filesystem::path> paths;
    for(const auto &[name,unused]:members_) paths.push_back(folder_/pathFromUtf8(name));
    return paths;
}
SourceStamp sourceStamp(const std::filesystem::path &source,std::stop_token stop,std::optional<ResourceBudget> budget) {
    return SourceSnapshot(source,LoadOptions{}.maxBytes,stop,std::move(budget)).stamp();
}
std::vector<std::filesystem::path> sourceMemberPaths(const std::filesystem::path &source,
                                                   std::stop_token stop,std::optional<ResourceBudget> budget) {
    if(stop.stop_requested()) throw std::runtime_error("Loading canceled");
    const bool directory=std::filesystem::is_directory(source);
    if(!directory && source.filename()!="meta.json") return {source};
    const auto file=directory?source/"meta.json":source;
    FileSnapshot metadata(file,16*1024*1024,stop,std::move(budget));
    const auto names=textureNames(nlohmann::json::parse(metadata.bytes()));
    if(stop.stop_requested()) throw std::runtime_error("Loading canceled");
    std::vector<std::filesystem::path> paths{file};
    paths.reserve(names.size()+1);
    for(const auto &name:names) paths.push_back(file.parent_path()/pathFromUtf8(name));
    return paths;
}
} // namespace preview
