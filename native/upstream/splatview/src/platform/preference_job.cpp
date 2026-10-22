#include "preference_job.hpp"
#include <stdexcept>
#include <utility>

namespace preview {
PreferenceSaveSnapshot::PreferenceSaveSnapshot(std::filesystem::path source,
                                               const Scene &loaded, SavedView camera,
                                               std::filesystem::path directory,
                                               std::optional<FrameCaptureSnapshot> thumbnail,
                                               std::optional<ResourceBudget> resources)
    : source_(std::move(source)), directory_(std::move(directory)), camera_(camera),
      thumbnail_(std::move(thumbnail)),resources_(std::move(resources)) {
    if(source_.empty() || directory_.empty())
        throw std::invalid_argument("Preference save needs source and storage paths");
    if(loaded.sourceContentKey.empty() || loaded.sourceFileIdentity.empty())
        throw std::invalid_argument("Preference save needs verified loaded source provenance");
    (void)encodeSavedView(camera_);
    provenance_.sourceContentKey=loaded.sourceContentKey;
    provenance_.sourceFileIdentity=loaded.sourceFileIdentity;
    provenance_.sourceBytes=loaded.sourceBytes;
}
PreferenceSaveCompletion PreferenceSaveSnapshot::run(std::stop_token stop) const {
    if(stop.stop_requested()) throw std::runtime_error("Preference save cancelled");
    std::optional<Image> image;
    std::optional<CapturedFrame> admitted;
    if(thumbnail_) {
        if(thumbnail_->budgeted()) admitted=thumbnail_->runAdmitted(stop);
        else image=thumbnail_->run(stop);
    }
    const Image *pixels=admitted ? &admitted->image() : image ? &*image : nullptr;
    FilePreferences(directory_).save(source_,provenance_,camera_,pixels,stop,resources_);
    // FilePreferences returns only after the authoritative manifest commit.
    // A subsequent stop must not turn this successful write into cancellation.
    return {source_,camera_,thumbnail_.has_value()};
}
} // namespace preview
