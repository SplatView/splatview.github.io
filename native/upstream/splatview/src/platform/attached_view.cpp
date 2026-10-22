#include "attached_view.hpp"
#include "file_preferences.hpp"
#include "file_io.hpp"
#include <nlohmann/json.hpp>
#ifdef __APPLE__
#include <sys/xattr.h>
#endif
namespace preview {
namespace {
[[maybe_unused]] constexpr char attribute[]="com.opsiclear.splatview.default-view";
[[maybe_unused]] std::filesystem::path sourceFile(const std::filesystem::path &p) { return std::filesystem::is_directory(p)?p/"meta.json":p; }
}
std::optional<SavedView> readAttachedView(const std::filesystem::path &source,std::string_view fingerprint) {
#ifdef __APPLE__
    try {
        const auto file=sourceFile(source);
        const auto length=getxattr(file.c_str(),attribute,nullptr,0,0,0);
        if(length<=0 || length>65536) return {};
        std::string text(size_t(length),'\0');
        if(getxattr(file.c_str(),attribute,text.data(),text.size(),0,0)!=length) return {};
        auto record=nlohmann::json::parse(text);
        if(record.at("contentKey").get<std::string>()!=fingerprint || record.at("identity").get<std::string>()!=fileIdentity(file)) return {};
        return decodeSavedView(record.at("camera").dump());
    } catch(...) {}
#else
    (void)source; (void)fingerprint;
#endif
    return {};
}
void writeAttachedView(const std::filesystem::path &source,const SavedView &view,std::string_view fingerprint) noexcept {
#ifdef __APPLE__
    try {
        const auto file=sourceFile(source);
        const auto text=nlohmann::json{{"version",1},{"identity",fileIdentity(file)},{"contentKey",fingerprint},{"camera",nlohmann::json::parse(encodeSavedView(view))}}.dump();
        // Read-only volumes and unsupported filesystems retain the shared-cache
        // record; an attached attribute is a best-effort additional location.
        setxattr(file.c_str(),attribute,text.data(),text.size(),0,0);
    } catch(...) {}
#else
    (void)source; (void)view; (void)fingerprint;
#endif
}
} // namespace preview
