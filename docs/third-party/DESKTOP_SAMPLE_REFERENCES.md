# Desktop sample and Mip-NeRF 360

The web demo uses the exact desktop tutorial resource, `bench.sog`, supplied by
the app owner as `Model_40000-bike_gone-preview.sog` on October 15, 2026. On
October 19 the owner identified the source dataset as Mip-NeRF 360 and requested
its use in the public web demo with attribution. The original desktop record
did not identify the dataset; this newer statement supplies that lineage.

- Size: 5,124,962 bytes; 262,556 splats, SOG v2, SH degree 3.
- SHA-256: `a4f0b3d623a10a3d15cf4179c44a54ae88258ef66dbaddbf67009a40b44b1570`.
- [Public sample provenance and authored view](../../public/examples/bench.json).
- [Distributed dataset attribution](../../public/licenses/Mip-NeRF-360-NOTICE.txt).
- Dataset license: [Creative Commons Attribution 4.0 International (CC-BY-4.0)](https://creativecommons.org/licenses/by/4.0/).
- [Bundled full license text](../../public/licenses/CC-BY-4.0.txt), copied exactly
  from the [canonical legal text](https://creativecommons.org/licenses/by/4.0/legalcode.txt).
- [Mip-NeRF 360 project and original data](https://jonbarron.info/mipnerf360/).
- [Paper](https://arxiv.org/abs/2111.12077): Jonathan T. Barron, Ben Mildenhall,
  Dor Verbin, Pratul P. Srinivasan and Peter Hedman, CVPR 2022.

The original dataset images are not included. This is an owner-supplied edited
Gaussian-splat reconstruction adapted from the original photographs and
encoded as SOG using the SplatView CPU encoder. The exact desktop SOG is
copied into this checkout; browser builds never depend on a live desktop sibling
or a user's Downloads directory. Source identities are captured in the feature
review's validation evidence; no frozen native or generated source pin changes.

The [official SMERF data declaration](https://smerf-3d.github.io/#data) lists
Mip-NeRF 360 and releases the listed datasets and teacher checkpoints under
CC BY 4.0. SMERF author Daniel Duckworth added this declaration on June 18, 2024,
in [commit f4fd7c9978164b2cd7eaa718fa19bc6ec62551e8](https://github.com/smerf-3d/smerf-3d.github.io/commit/f4fd7c9978164b2cd7eaa718fa19bc6ec62551e8).
The supplied SOG is the app owner's adaptation of source photographs; it is
separate from SMERF's released checkpoints. The distributed notice credits the
dataset authors, links the source and license, and identifies the changes.

This author-issued declaration corrects the earlier conclusion based only on
the original download archives. Dataset terms remain separate from SplatView's
application and dependency licenses, including MultiNeRF's software license.
Application terms do not restrict rights granted by CC BY 4.0 in this dataset
content. Retain attribution, license information and the change notice when
sharing the adapted content; no dataset-author endorsement is implied.

The current controller owns sample acquisition, supersession and publication.
The authored camera is resolved before the initial recovery checkpoint, with a
matching remembered view retaining normal priority. Start and empty-viewer Help
replay use this same scene; an already loaded user scene stays in place.
