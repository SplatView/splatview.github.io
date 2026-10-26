# Live native allocation census packet

This implementation specification was updated 2026-10-13; the original is dated
2026-10-12. The historical observational first
packet is implemented in the live native/worker/client boundary at core ABI7,
protocol11/UI-worker6 and camera ABI1. Native, unit, affected development and
production validation pass within the focused local scope recorded below. Census
introduces no quotas or additional admission credit. SPZ stream cleanup and
transactional export ownership are now integrated as separate prerequisites.
Bounded exact-input SOG JSON cleanup authority and fixed-buffer content-key
formatting now have focused local qualification below. Candidate-only quotas
and raw codec/filesystem accounting remain later work. These increments do not
enable grouped inputs.

The user's bounded-input scope retains SplatView's 256 MiB (268,435,456-byte)
per-scene input policy and one million loaded preview splats. COLMAPView supplies
format-specific limit/warning patterns, not this numeric hard cap. Central checks
before reads/candidate staging and independently in the already initialized
worker are implemented and have focused local qualification below. The worker
guard precedes source-specific native allocation/decoding, not bootstrap WASM
initialization. Intrinsic Blob size is authoritative across the browser entries.
Checked expansion, metadata/texture/count/decoded size, GPU/device limits and
old-plus-candidate admission stay required. Compressed bytes do not bound decoded
memory. General raw allocator/codec/filesystem quotas are deferred unless a
concrete supported path needs them, and no longer block desktop UI/features or
one bounded unpacked SOG by default. Future groups sum unique original resources
under the same scene cap while retaining per-resource bounds. These scope changes
do not alter sealed receipts or turn the observational census into a quota.

## Absolute grading and Auto Color allocation boundary; bounded local qualification

The October 13 implementation uses core ABI8/protocol12/UI-worker8/camera ABI1 with `absoluteColorSession:1`, `autoColor:1` and `colorBaseStream:1`. Bounded local qualification is recorded below. Native color metadata retains one immutable base, captured masks/scope, 15 current/applied absolute grade values and monotonic safe-integer identities. Analysis owns admitted scratch but mutates no SceneEdits/history. Completed Auto merges its action-owned fields and retires scratch before allocating a writable bake.

Executed WASM32 layout is Job 1,404 bytes, full analysis owner 1,912 bytes, typed result 344 bytes and color-session metadata 680 bytes. Three scratch arrays total `8*min(N,65536) + 3072`: 527,360 bytes at the one-million preview limit; analysis owner plus scratch is 529,272 bytes. Retained shared scene/mask references do not duplicate physical payload charges. The owner and its scratch receive actual grants from the existing admission service before allocation and retire the associated service when released. Inline metadata, JSON/request storage, allocator envelopes and other runtime remainder are not additional census payload credit.

Grade/Auto and end boundaries with unapplied values reserve twice existing `historyBytes` for the outer rollback checkpoint and staged native publication copy, plus the existing scene allowance. An already-applied end boundary reserves one history copy plus the scene allowance. Auto adds `8*min(N,65536) + 3072 + 1912 + 4 MiB`. These estimates cover policy overlap rather than establishing a closed raw allocator/codec/filesystem quota. Actual allocations/grants, retained H/C/R accounting, GPU staging and old-owner retirement remain distinct; shared base references must not be charged as a second physical scene.

Native final publication stages SceneEdits and color metadata before no-throw swaps. The controller holds their transaction through admission, the GPU fence and commit, joining rollback on refused bake/materialization. During the session, baked native records and the one retained base GPU display owner coexist. Boundaries settle pending values, stream the bake and end the session; recovery streams the typed base under matching source/session/base/epoch identity. Settled native export reads the bake without changing the active base/session/history, while pending export is refused and is not operation-preserving. Manual equal-applied no-ops preserve Redo; neutral restoration and nonneutral quantized-equal bakes follow their distinct history rules.

Desktop hover overlays, inactive-control automatic commit and deferred busy presses remain open; whole W18/full-plan acceptance is not claimed. The [pinned MIT PlayCanvas review](third-party/PLAYCANVAS_REFERENCES.md) is reference-only with no adapted production code. Existing 256 MiB/one-million-preview limits and the browser-only/no-Mac-gate scope remain unchanged; no browser-performance guarantee follows from these sizes or allowances.

The [sealed local receipt](validation/README.md#auto-color-20261013-01) passes **1,968 units/48 files, 19 focused browser cases/one file, 239 affected development cases/13 files and 66 production cases/two files**, counted separately. Browser cohorts have zero failures/skips/flaky results/retries. Final units03/typecheck03/web-build03/native-build03/source04 and post-cohort source05/test-inputs04 pass. The 1,562,199-byte receipt has SHA-256 `538dc5f9b6accede25a2d08e728814e8ae5c4b053273a76edf598bc689517509`, binding 2,642 exact files, 161 application inputs and 92 runtime artifacts. This is bounded local acceptance; whole W18/full-plan acceptance remains open, with no fresh complete 718-case development run claimed.

Current app/native/deployment IDs are `1aa41fe2798dd9d1ed03dedc008739f2bc60dc507f5affc7f8fd9bd08fc10d4c`, `71b5d759b66f6a55afbe0e767b5caa1260aaebabd9fd9a968e6efbf6aef00311` and `f93fc1aee842691d82c3d5392c4950d347082eaab9f35e8f182e7150faf05b82`. [Final native execution](validation/README.md#auto-color-20261013-01) passes 11 actual linked mains after the 146-target build: Auto analysis 45 cases/52,212 checks; metadata nine suites/287 assertions; actual color bindings 27 cases/9,096 checks, including colored White balance, settled active export and four terminal publication refusals. The [independent audit](../.build/auto-color-tests/receipt-audit-01/audit.json) passes 2,642 observed files/222,730 assertions with zero issues and rehashes five archives/1,234 files. Its 1,492,472-byte report has SHA-256 `413be58567a51a7d6ab4c6085248c41c5f66c33ad288c19311c24cb081a516db`.

Failed regression01 remains **68 passed/five failed/165 unrun**; regression02 remains **235 passed/three failed/all 238 executed**; regression03 remains **237 passed/two failed/all 239 executed**. The latter's HTTP/source-map evidence identified an older served morphology harness matching archived input01; excluding generated/reference/native/WASM trees from Vite watching and restarting established the final app identity. Native identity stayed unchanged across that watcher correction. Initial unit/runner/focus diagnostics, earlier focus02/03 passes and all historical receipts retain their original scope and do not contribute a current passing union.

[Preflight01](../.build/auto-color-tests/preflight-01/verification.json) passes 21 selected HTTP modules/source maps (29,522 bytes/SHA-256 `751532cebe8ada78f30e683699f2ca4bb285c803e7b77eb26101fcea94d89479`). The 179-file browser-input snapshots03/04 and source snapshots04/05 remain exact before/after the final cohorts. These observations do not establish execution-time transitive dependency/toolchain closure or deployed-host bytes.

[Actual-App observation01](validation/README.md#auto-color-20261013-01) records four root-reviewed PNGs: Basic Auto menu/applied at 1280 × 720, Pro White balance/all 15 fields at 1280 × 900 and compact Pro at 640 × 300. The 105,839-byte report has SHA-256 `65679f73c1f5238423420b2da7e595a3276cd9560a7a9bde446072e1d5b5c0ae`. Scope is local Windows Chromium 156, default Small font/DPR1, with actual native actions; matched native camera/font/DPR, hosted/offline and performance acceptance remain open. No Mac gate applies.

## Historical Grow/Shrink allocation boundary; bounded runtime qualification

The following sealed packet retains its original counts, identities and scope. “Current” within it describes the captured-icon successor before the October 13 contract.

The [current captured-icon successor](validation/README.md#morphology-icons-20261012-01) passes 1,879 units/44 files, 27 focused browser cases/two files (21 morphology plus six Settings) and 66 production cases/two files, without failures/skips/flaky results/retries; typecheck01, build and source verification pass. Its 451,367-byte receipt has SHA-256 `95de0c7fa57d4fea9f8a672bfd7ae984cb59f27c9d23a45fc65f769f3e649d6e`, with 822 exact-file bindings including 457 archived originals, 158 current app inputs and 92 runtime artifacts. Independent audit passes 822 bindings/1,428 checks with zero issues. Current app/deployment IDs are `b17472926563b9141f44f027782c194061a397eb4816fe796923e1ff9a75cf2c` and `eda78712d36034e8f41afbaadfe6ea0bffe00b63416cfdfb731ff120ca857b28`. Native source/provenance and five artifact leaves are unchanged at `351867cd57f9edfac461810e83b573f48d08b335fc46a75aca7c02f72c008431`, ABI7/protocol11/UI-worker7/camera ABI1/`selectionMorphology:1`; nine-main execution is reused, with no new native build/execution.

Captured-target Grow/Shrink SVGs now resolve before the legacy palette; generation verifies pinned `icons.def`, both SVG records/hashes and mapping. Seven added asset tests cover actual Icon rendering, tamper refusal and the new capture. The 73-icon baseline remains unchanged at 34,538 bytes/SHA-256 `aac4e0622fcd225a06ac70831effbdaedb1373ff4ad61325d29428ac9541b313`. [Current App observation](validation/README.md#morphology-icons-20261012-01) is 59,521 bytes/SHA-256 `593ae3495c9699313c6e4b4c2a8fff89d19a14dced7fe469ae62042d923fa957`, with exact SVG DOM checks before PNGs for Basic/Pro at 1280 × 720 and compact Pro at 640 × 300. All three corrected states were visually reviewed, without matched native camera/font/DPR, host/offline or performance acceptance.

The [original-packet archive](validation/README.md#morphology-20261012-01) preserves all 457 original bindings and was independently rehashed. Original runtime counts, the 700-case passing union and fallback-icon observations below remain historical; the current focused/production qualification is not a fresh full 700-case run. Icon changes add no native grant, census payload, admission credit or quota. Whole W30/full-plan acceptance remains open; no Mac gate applies.

Current Grow/Shrink runs exact anisotropic ellipsoid contact against an immutable entry mask, with six lifetime-admitted POD arrays and a stable owner. Actual WASM32 full-owner size is 6,168 bytes, including the 6,024-byte job and array-owner metadata. Six scratch payloads are `S = 37*N + 44*M`: 42,767,124 bytes for one million splats/131,071 nodes. The existing generated AdmittedAllocator census hooks tag physical payload after an actual grant; admission precedes allocation and physical release precedes grant retirement. Scene/mask references do not create duplicate payload charges.

Controller operation policy reserves `S + 6168 + 24*N + 4 MiB`, with existing `historyBytes` added separately for transaction-copy overlap. Publication retains full scratch, exact sparse Changes (`8*K`), old/new N-byte mask COW and actual history/deque storage; renderer state staging adds its separately owned buffers. Allocator envelopes/control blocks, exception storage and fragmentation remain outside payload sums. The allowance and observed census are not a closed raw allocator, codec or MEMFS quota, and add no admission credit. There is no retained free BVH cache. Input limits remain 256 MiB/one million loaded preview splats.

BrowserSelectionAccess validates captured scene/revisions/mask identity and sorted live overrides before one atomic native commit. Empty results preserve executable Redo and revisions. Cancellation, completion, rollback and replacement retire arrays and also clear the empty global pointer's deleter-held Work service; the latter fixes a metadata-retention gap that did not retain scratch payload. Cooperative traversal uses MessageChannel task yields and 4,096-work steps in batches capped at 8 ms or 256 steps with a coarse/frozen clock. Final O(K) conversion/history application plus O(N) COW remains synchronous publication work, without a maximum-latency or browser-performance claim.

The [historical original runtime receipt](validation/README.md#morphology-20261012-01) gives bounded local qualification: 1,872 units/43 files, 66 production cases/two files and exact passing coverage of 700 unique development cases/33 files. Original all-browser01 remains **699 passed/one failed**; settings-correction01 passes six, overlapping five prior passes. Focus21 overlaps and is counted separately. Final typecheck03, source01, web-build01, native-build02 and nine fresh actual mains in native-execution01 pass, including morphology 27 cases/294 assertions/6,168-byte owner. The receipt is 206,122 bytes/SHA-256 `d3c9d488f95f9e094f7ed276101050dc4e78c99019ac155c973e30d421c23cec`, binding 457 observed exact files, 157 app inputs and 92 runtime artifacts.

Original development failure occurred before Settings opened: roughly 6.2-second startup outlasted three-second idle hide; canvas intercepted 105 Tools clicks over about 53.7 seconds. A real pointer wake/visibility wait corrects only the e2e helper, with no product/App/native/UI change. Original test bytes, trace, error context and the 10,381-byte diagnosis/SHA-256 `0051afdd4a49792d18975d14200fecaccd4f2fc2b753bd5c1106ec6a77de9e64` remain bound. Initial Windows-launcher SyntaxError executed no main. Native assertion diagnostics corrected legitimate 4-to-2 context consolidation/48-byte decrease with payload/live blocks unchanged; valid map envelopes now exercise busy guards. Failed attempts retain their original outcomes.

[Original actual-App observation](validation/README.md#morphology-20261012-01), 55,280 bytes/SHA-256 `1196618177b584a9c629469007d3a46152ff90b9c1a3fe7993bd360f544d5394`, records Basic/Pro at 1280 × 720 and compact Pro at 640 × 300; all three states were visually reviewed. Review detected Help fallback glyphs on Grow/Shrink because legacy generated assets lack their names; the successor above corrects and locally qualifies them. Original runtime evidence remains unchanged historical limited evidence, without matched native camera/font/DPR, host/offline or browser-performance acceptance. Whole W30/full-plan acceptance remains open.

Sealed-packet native ID is `351867cd57f9edfac461810e83b573f48d08b335fc46a75aca7c02f72c008431`, app ID `c0f5ba40795f4d3167cecec18004718980194601def339b60acc714d148efe6b` and deployment ID `749a10a8bebd354f89d638106aae9f5b0618f33391bcef2f9ecb6ed5d1c4189c`. Requirements are core ABI7/protocol11/UI-worker7/camera ABI1 plus `selectionMorphology:1`. No dedicated Mac test gate applies. The [histogram archive](validation/README.md#histogram-20261012-01) preserves all 343 exact-file bindings; original receipt IDs/counts and exclusions below remain unchanged.

The histogram/stats implementation has bounded local qualification. Desktop
contracts are `src/app_ui.cpp:1012–1142`, `src/renderer.cpp:1900` and
`src/shaders/histogram.hlsl`: actual display RGB includes background, grade,
selection highlights and deleted-source removal, unlike clean capture/source DC.
Stats are selected/visible splats and `SH{min(degree,3)}`, with visible equal to
loaded minus deleted. The pinned 54-pixel field/4-pixel inset uses three 256-bin lines,
shared `log1p` peak and palette `#ec6464`/`#7dd292`/`#69a5f5` at opacity 0.82, with
no axes/legend. WebGPU samples the real `TEXTURE_BINDING` canvas texture on a
center grid bounded by 256 × 144, rounds clamped RGB to byte bins and asynchronously
reads 3,072 bytes at most 5 Hz only on changed views, without idle polling. Optional
sampler failure is sticky for that renderer. A separate 12,304-byte GPU/CPU-overlap
reservation adds no native admission credit; hide/Close/replacement/recovery guard
against stale publication. Native/WASM/census and 256 MiB/one-million-preview
policy are unchanged.

[Focused histogram qualification](validation/README.md#histogram-20261012-01) passes 1,834 unit cases/40 files and 66 production cases/two files. Exact file/project/title coverage verifies 679 unique development-browser cases/32 files across three runs: initial01 remains 444 passed/five failed/230 unrun, remainder01 remains 261 passed/one failed, and final checkpoint-correction01 passes two. The latter runs overlap prior passing coverage by 27 and one cases respectively; failed runs retain their outcomes. Focus03 passes 13 overlapping cases/one file and is counted separately. Final typecheck05, web-build01 and source02 pass. The receipt binds 343 observed exact files, 153 application inputs and 92 runtime artifacts, is 142,470 bytes and has SHA-256 `ac6beb64bc722ca6a250e6d382bfc804dda7ba372208cfa7c10dd57f27553ad1`.

The histogram packet app input ID is `27eb08fb538d95522cfab75f424206a184ac34adccf008ef716d9f785d8eb3f0`; its deployment ID is `dacef8c72fdb7f309b088d20dd9cb685c4931799d6dba86ba7e6642334835d2c`. Native remains `d10f9d7f72adf377da2a14827a3b175ce31ba444b043acaf31d6fa088a41e7a5`, at core ABI7/protocol11/UI-worker6/camera ABI1. The five exact native artifact/provenance leaves match the prior Settings receipt; this packet claims no fresh native build or execution. Earlier receipts retain their exact identities and scope.

[Actual-App observation](validation/README.md#histogram-20261012-01) covers Basic/Pro at 1280 ? 720 and compact Pro at 640 ? 300; Basic and compact Pro were visually reviewed. The 29,577-byte observation has SHA-256 `da0bc244feaac7e1144a5d7539d23101307d029b2d27984c81f005e0446c2c19`. These are local Windows Chromium observations, without matched native camera/font/DPR visual acceptance, deployed-host/offline qualification or a performance guarantee. The receipt does not assert a portable test/helper execution-source closure or a fresh full historical A/B/C cohort.

The pre-integration `.build/morphology-port-draft` remains supporting CPU/standalone-WASM evidence with 612 host jobs, 100 desktop comparisons and million-splat fixtures. Its 6,120-byte host/6,024-byte WASM job measurements describe those isolated observations. Current integrated ownership and qualification are recorded above; Auto Color, alignments, Pro filters/transforms, Language/Theme, grouped SOG, recovery, visuals and hosting remain active work without a Mac gate.

The locally qualified Settings implementation is extracted into
[SettingsDialog](../src/ui/SettingsDialog.tsx): a viewport-clamped panel matching
Tools at widths 300/336/375 pixels, 12 pixels from the top and beside Tools with a
12-pixel gap (otherwise 12 pixels from the left), with a fixed
header, joined 24-pixel General/Privacy/Help tabs and active-content-only scrolling.
Real font/Close/saved-view transfer/cancel/status/recovery actions retain guards;
inactive contents unmount to cancel preview while tab choice persists on reopen.
ARIA roving Arrow/Home/End tabs, consumed outside presses through a transparent
shield and retained modal focus/shortcuts are explicit browser adaptations from
the native popup. Privacy/Help describe the browser truthfully; missing desktop
settings/content remain future work without simulated controls.
[Focused Settings qualification](validation/README.md#settings-panel-20261012-01)
passes 1,825 units/38 files, 157 development-browser cases/14 files and 66
production cases/two files; focus01/13 cases/three files overlaps and is counted
separately. Browser runs have zero retries/skips/flaky results; final build01 and
typecheck02 pass. The receipt binds 420 distinct exact files/819 bindings and 92
runtime artifacts, is 182,982 bytes and has SHA-256
`cd3312d180a5732f3b6d00c3c69262a7e22e07a3774c5ca4068234076416aaf8`.
[Capture01](validation/README.md#settings-panel-20261012-01) passes
six helper-checked states: Small General/Privacy/Help at 1280 × 720, Medium commit,
uncommitted Large hover and compact 640 × 240. Placement/width/tab bounds match
the native contract; failed native versus loaded browser scene and visibly
different font metrics remain observations, not matched full visual parity.
The Settings packet app input ID is
`4766b537dc5e00a36aa033d7a098af1c1f1538c9192aff908babe468a8b11433`;
deployment ID is
`244879d5ce54609c5c48f75f4a60abff6fbca7d92e49ff43d6d7b78483326d36`.
Native remains
`d10f9d7f72adf377da2a14827a3b175ce31ba444b043acaf31d6fa088a41e7a5`,
at ABI7/protocol11/UI-worker6/camera ABI1, reusing unchanged eight-main closure
without fresh native build/execution. No census or 256 MiB/one-million-preview
policy change is introduced. Histogram/stats were outside that packet and are
separately qualified above. Language/Theme, richer Help, Guides,
Grow/Shrink, Pro filters and full visual comparison remain pending; no Mac hardware
gate applies. Historical receipts keep their exact identities and scope.

The frozen viewer-shell implementation follows captured desktop 0.12.116
(`src/app_ui.cpp`, lines 816–859): 36-pixel cells/22-pixel glyphs/6-pixel group gaps,
five file/five navigation without Guides/three lens-fullscreen/one Tools-or-Settings
actions, one Settings cell for geometry without spare Tools width, a 32/48 linked
brand, joined 24/16 Undo/Redo, equal-width Basic/Pro with an 18 × 10 switch and
Selection → Color → Transform order. The empty viewer has the functional silver
154 × 28 Open/18-pixel Folder glyph, 28-pixel heading/15-pixel detail and limit
caption; Background is one 14 × 14 swatch. SVG paint inheritance restores missing
Fullscreen/ExitFullscreen strokes without changing frozen assets. This is App/CSS
work: native/census/limits and command logic remain unchanged. Floating Settings
tabs were outside this viewer-shell packet and are delivered by the successor
above. The rendered histogram/stats also have separate successor qualification
above. Language/Theme, richer Help, Guides, Grow/Shrink, filters and full UI parity
remain future work without placeholder buttons.

[Focused viewer-shell qualification](validation/README.md#viewer-shell-20261012-01)
passes 1,825 units/38 files, 151 development-browser cases/13 files and 66
production cases/two files, counted separately. Both browser cohorts have zero
retries/skips/flaky results; typecheck03, final web-build03 and the separately
named benchmark typecheck pass. The receipt binds 433 observed files/855 bindings,
92 runtime artifacts and HTML integrity, is 212,035 bytes and has SHA-256
`0a0dc57f1d4f1f81d8a65a48383148a1185bf2d2e68853c1714c3cd4baa81c84`.
[Capture02](validation/README.md#viewer-shell-20261012-01) passes
four actual-App states at 1920 × 1080/DPR1 with before/after workspace app/native
bindings and source-matched demo1728 reference observations. Empty/Basic/Pro and
visible Fullscreen were reviewed locally in Windows Chromium. This does not
verify deployed bytes or matched native DPR/fonts/camera/full visual acceptance.
Preserve capture01's missing stroke, affected01 at 149 passed/two failed, focus01
at three passed/one failed and superseded pre-icon-correction affected02/151.
The viewer-shell packet app input ID is
`550294701ea428dd85c540eb94ccc9dbe483e5629a3f3fdb3829c04f321d9341`;
deployment ID is
`c6eb0e45f7321ecf8952fb0fef18b67f438d67bc6e89b795b370e8aa942099a4`.
Native input remains
`d10f9d7f72adf377da2a14827a3b175ce31ba444b043acaf31d6fa088a41e7a5`,
with eight mains reused through unchanged exact native source/artifact/compile
closure and no native rebuild/new execution. The shell has bounded local
acceptance; floating Settings tabs are delivered by the successor above, while
Rendered histogram/stats have separate successor qualification above.
Language/Theme, richer Help, Guides, Grow/Shrink, Pro filters,
wrapped-row corners and complete visuals remain pending. The central 256 MiB/
one-million-preview policy is unchanged.

[The bounded-input receipt](validation/README.md#limited-input-20261012-01)
passes 1,825 units/38 files, 128 development-browser cases/ten files and 66
production cases/two files, counted separately; both browser cohorts have zero
retries/skips/flaky results. Final web-build02, full post-correction typecheck02
and the separately labeled benchmark typecheck pass. Eight native mains are
reused through unchanged exact source/artifact/compile closure from the sealed
JSON-cleanup receipt; no new native build/execution occurred. Development01's
124-pass/four-failure banner-timing diagnostic is retained; test-only corrections
precede passing development02. The receipt binds 399 observed files and 92 runtime
artifacts, is 184,502 bytes and has SHA-256
`9b44af09f33b262216f4bc807dce9416c05cfca82a2bcddc84db33951942cca7`.

The bounded-input packet app input ID is
`bec10c2738119b0a7cd47b0d6524ca2731825f74e579e306c0c9a864eb92fcae`;
deployment ID is
`a46b0544c252278d06b6dc4463673242e798a1c18e667cea97178efc8a068ceb`.
Native input ID remains
`d10f9d7f72adf377da2a14827a3b175ce31ba444b043acaf31d6fa088a41e7a5`,
at core ABI7/protocol11/UI-worker6/camera ABI1. This focused local packet does not
accept a fresh full A/B/C cohort, complete test/helper execution-source capture,
matched visuals, deployed host, performance or whole-operation memory guarantees.
Visible desktop viewer/UI work is active; bounded unpacked SOG remains a separate
input extension with complete original-resource identity and atomic publication.

The active delivery is a browser web app. Validate this packet through actual
native bindings, local available browsers and the coherent production web build.
Dedicated Mac hardware, shipping Safari and VoiceOver-on-Mac tests are optional
and do not gate this packet. Compatibility claims remain limited to observed
environments; this scope does not establish Mac/Safari compatibility.

## Bounded SOG JSON cleanup authority

The maintained [scanner and owner](../native/wasm/json_preflight.hpp),
[implementation](../native/wasm/json_preflight.cpp) and
[overlay generator](../tools/json_cleanup_overlay.py) adapt only the actual
`loadSog` parse of the exact borrowed `meta.json` byte span. The scanner is
nonrecursive and allocation-free. It validates complete UTF-8/JSON grammar and
qualifies at most 16 MiB, depth32, 65,536 tokens, 1,048,576 decoded UTF-16 units
per string, 4,194,304 string units in total and 128 characters per numeric lexeme,
including finite binary64 range. Duplicate keys and overwritten values remain
in the census. The existing 16 MiB loader input bound stays in force; the other
qualification bounds select destruction behavior and introduce no rejection,
quota, coverage credit or command limit.

`ParsedSogMetadata` privately owns qualification, authority and its DOM in that
declaration order. DOM storage and parse temporaries retire before authority,
including exceptional construction. Qualified destruction takes the reviewed
recursive route without nlohmann's heap flatten stack. An unqualified nested
owner saves the outer state, sets authority false and restores the saved state
on retirement; ordinary parsing/destruction remains the compatibility fallback.
The read-only hook cannot activate authority, and callers cannot supply a census,
mutable DOM or custom owner bounds. The actual SOG callgraph borrows the const
DOM without constructing unrelated JSON under its lifetime; this reviewed
borrowing convention is not a general authority for arbitrary DOMs.

The generator creates one pinned-header adaptation in the disposable overlay.
The core and every linked JSON translation unit must resolve it before the
ordinary dependency header. Frozen source/header bytes stay unchanged; original
and generated inputs join provenance and the overlay's pre/post verification.
Separate SourceSnapshot metadata parses, command/live-preview request DOMs and
constructed SOG export DOMs remain unqualified. Fixed native replies need no
JSON authority. In particular, the metadata token bound is not imported into
the existing 65,536-point command path.

The same exact-path overlay helper replaces `contentKey` stream formatting.
After the unchanged SHA-256/cancellation work, it stores the 32-byte digest and
complete 64-character lowercase hexadecimal text in fixed arrays, then creates
one owning string. Allocation failure in that final construction propagates
before candidate publication. The old vendor stream formatter could swallow
allocation failure and return an incomplete digest after metadata authority had
already retired. Independent Python `hashlib` hashes of contract ZIP bytes
provide the identity oracle; the scanner and formatter do not redefine source
identity.

[Fresh linked native execution02](validation/README.md#native-json-cleanup-20261012-01) passes all eight mains. The JSON suite reports 13 cases/3,838 assertions, 68 scans, 46 qualification refusals, six qualified destructions, 98 parse and 247 candidate allocation refusals, six ordinary refusals, five accepted fallback variants and the retained 65,536-point command path. It observes zero C++ allocation attempts/backend events after injected refusal through the observed unwind boundaries and a maximum sampled destructor stack delta of 1,056 bytes; independent archive identity checks total four.

[Fresh focused local validation](validation/README.md#json-cleanup-20261012-01) passes 1,808 unit cases across 38 files, 117 development-browser cases across eight files and 66 production compatibility/initialization cases across two files. Both browser runs have zero retries, skips or flaky results. Clean native02, production web build01, typechecks, the 30-case toolchain-protection suite and 19 Node build-protection cases pass. Counts remain separate and overlap historical inventories. The receipt verifies 395 observed files, all 92 deployment artifacts and HTML integrity; it is 174,454 bytes with SHA-256 `3b8fe2e21c057374fb5877f261ba9c7146bb93330afb96a22012c2ab95c08af3`. It does not establish a fresh complete A/B/C cohort, complete execution-source capture for test/helper imports, matched visuals, deployed-host or performance acceptance.

The receipt preserves native01's swallowed content-key allocation failure, the superseded first native build, diagnostic incremental build, direct module execution that invoked no main, explicit factory diagnostic and the protection-test source-spelling failure. Later results do not relabel those attempts or upgrade older sealed receipts. The final census records 18,867 allocation attempts/18,864 blocks after removal of the stream-formatting allocations; its remaining contract counts and the SPZ/export results are unchanged.

The JSON-cleanup packet native input ID is `d10f9d7f72adf377da2a14827a3b175ce31ba444b043acaf31d6fa088a41e7a5`; app input ID is `d27f6502d5cab6a6de2e44df06fce725507ef90b20f4871fbc7d470809b63232`; deployment ID is `39e88df3a3bed5c994917ee74db2872a0f2f07878f82216a0a5e019cce5a20f8`. Core ABI7/protocol11/UI-worker6/camera ABI1 are unchanged. The focused receipt binds these identities; historical receipts retain their original bytes and scope.

The [actual linked contracts](../native/wasm/json_cleanup_contracts.cpp) cover
independent grammar/census expectations, maximum depth and width, duplicate keys,
nested fallback, constructor unwind, parse/candidate allocation refusals,
retained owners/bytes/history and accepted out-of-qualification metadata. Their
stack samples are regression observations, not an exhaustive high-water or
universal stack guarantee. Qualified C++ allocation observations exclude raw C
codecs, MEMFS/JS and exception ABI storage. The unqualified iterative destructor
can still allocate; no command-wide closed-refusal safety is established.

Bounded unpacked/grouped SOG requires explicit aggregate input, resource,
metadata/texture/decoded limits and candidate admission. Define headroom from
actual old/new owner coexistence and setup costs; do not infer a quota from
qualification bounds, existing Work grants, `budgetBytes` or the observational
census. General raw codec/filesystem accounting and quota enforcement remain a
deferred hardening lane unless a concrete supported path needs them. Complete
UI, matched desktop visuals, deployed-host and performance acceptance remain
separate.

## Planned W11e grouped staging ownership

This is a proposed first flat selected `meta.json` plus declared-Files v1 SH0 slice; current source contracts/native capability still support single-source Open only. Admit/read original metadata under its 16 MiB bound first because the complete graph/aggregate is not available beforehand. Authenticate the graph, then sum unique ORIGINAL metadata/resources/extras under the existing 256 MiB cap before any texture-body read/native staging. Exclude unrelated selected neighbors; acquire/hash/stage declared extras even if the decoder does not use them. Compressed aliases count once, but all five consumed SH0 RGBA role outputs require their own decoded storage. Keep one global outstanding range of at most 1 MiB across brokers and the one-million loaded-preview limit.

Rewritten metadata needs an independent 16 MiB bound and exact-input qualification after filename splicing; original JSON authority cannot authorize the transformed DOM. The proposed SVSG span-table `_sv_open_group` validates finite integral JS doubles before casts, subtraction-based heap bounds, disjoint descriptor/input spans and exact lengths/totals. Its candidate-only `loadSog` wrapper uses a checked disposable model overlay, retains `sv_json::ParsedSogMetadata` cleanup authority and leaves frozen sources unchanged. Inspect WebP features/dimensions and admit per-role output before allocating the five planes; current reader checks after allocation cannot establish that order. COLMAPView header/pixel-slack patterns may inform checks, without adopting its 50-million count or 1 MiB metadata policy.

Account original staging, rewritten metadata/descriptor, preparation/range/hash owners, codec workspace, scene/history and old/new GPU owners through the actual completion fence. Only actual native payload contributes census coverage; estimates, grants and freed staging do not become physical headroom or a codec/heap/MEMFS quota. Held Blob reads, exact original/rewritten bounds, oversized-group zero-texture-read, independent attributes/keys and failed-candidate executable Redo require real integration evidence. UI source eligibility and a coherent future group wire/capability must ship with that bridge; no group implementation or acceptance is claimed here.

## Historical pre-integration Auto color ownership preparation

Before the October 13 increment, shipping web grading had transient GPU settings and committed from the current native scene, without compiled desktop `colorBase_`/`appliedColor_` session state. Exact repeated Auto/bake behavior required retained native pregrade/applied metadata, the matching GPU display owner and transaction snapshots across rollback, Undo/Redo, replacement, cancellation and recovery. Desktop processing updates the native bake while the renderer continues displaying the pregrade scene with absolute settings until session end. Retaining absolute settings over the former web baked GPU scene would grade twice. Its neutral grade still created/replaced a scene and cleared Redo, so it could not stand in for a session owner. The October 13 increment above implements those ownership prerequisites; this historical preparation does not itself qualify that integration.

Historical isolated host-02 read-only Auto analysis reports 109 bitwise captured-source fixtures, 129 jobs/91,474 assertions, all 11 cancellation phases and zero observed job heap allocations. Its MSVC `/fp:strict` source oracle does not invoke a desktop binary. One-million caller scratch is 527,360 bytes; host Job/analysis-owner/result are 1,504/2,080/344 bytes and owner plus scratch is 529,440 bytes. Analysis-only bridge-host02 reports 10 source-oracle fixtures/25 owners/896 assertions, 12 stale-key/owner variants, four admission refusals and zero observed step/cancel/result allocations.

The private [WASM layout receipt](../.build/auto-color-draft/wasm-layout-01/verification.json) is 19,303 bytes/SHA-256 `a848e3b3ec0d6a47442b50900e049196a4f023710e61244779fad72b9826f5ec`, with unchanged sources/cache. It measures Job/analysis-owner/result at 1,404/1,912/344 bytes and owner plus scratch at 529,272 bytes. Layout reporting alone does not execute the WASM algorithm or qualify native grants/census, shipping session/bake or browser/UI behavior. Admit retained pregrade/baked scenes, transaction/history copies and old/new GPU ownership separately before enabling the four actions; scratch-only measurements cannot establish that peak.

## Historical SPZ/export cleanup evidence

The [SPZ overlay helper](../tools/spz_stream_cleanup.py) installs a nonthrowing
stream guard immediately after successful inflate/deflate initialization.
Production and the [SPZ contracts](../native/wasm/spz_cleanup_contracts.cpp)
link the same adapted vendor source; frozen inputs remain unchanged. Actual
legacy-gzip v2/v3 contracts pass 18 cases/2,898 assertions, with 37 successful
initializations/37 guard closures and 103 observed zlib raw allocations/103 frees.
The two reserve/two insert counters identify paired path cases; eight additional
insert refusals each recover successfully and participate in the lifetime totals.
This establishes cleanup, not raw codec accounting or low-level output atomicity.

The export contracts (`../native/wasm/export_cleanup_contracts.cpp`) exercise
actual bindings across eight current format IDs: 14 cases/1,345 assertions,
130 filesystem refusals, two invalid requests, one candidate-vector refusal
and 24 successes. Tests retain exact scene/mask/output owners and bytes, full
summaries, scoped-C++ counters and executable Redo. Successful retries agree
byte-for-byte. One successful nested-request CSV boundary observes zero C++
allocation attempts/backend events after output publication; raw C and JS
allocation are outside that observation. Creation/oversized-output probes are
CSV-only. Close-error injection reports failure after descriptor retirement.
Unlink failure, close failure before retirement, SPZ v4/Zstd, full independent
format decoding and command-wide closed-refusal safety remain unqualified.

[Fresh local validation](validation/README.md#cleanup-20261012-01) passes all seven linked native mains, 1,808 unit cases across 38 files, 117 development-browser cases across eight files and 66 production compatibility/initialization cases across two files. Browser runs have zero retries, skips or flaky results; counts remain separate. Legacy-gzip SPZ has 18 cases/2,898 assertions with 37 initialized/37 ended streams and 103 raw allocations/103 frees. Export has 14 cases/1,345 assertions, 130 filesystem refusals, two invalid requests, one candidate-vector refusal and 24 successes. Typechecks and the clean native/production web builds pass. The receipt verifies 367 observed files, all 92 deployment artifacts and HTML integrity; SHA-256 `1737cac62f768f1686b43082ad287ad8ec31e810200a14adf4a4354f62ad15ed`. This is focused local qualification, excluding a fresh complete A/B/C cohort, matched desktop visuals, deployed-host and performance acceptance.

The historical SPZ/export cleanup snapshot has native input ID `68666aa16bc3ecc26195bd142a1bbb9ce3b1992dc0c16ddbda70e47550666119`; app input ID is `d97689ddd01df8db0becd246d50230558205c1d628f12d33ed4a0f7bdabbd385`; deployment ID is `0a1659daee739f3721114020f541a4afef2465fe5753d381467cda2a073bde5a`. Core ABI7/protocol11/UI-worker6/camera ABI1 are unchanged. Older census, response/font and portable receipts retain their own source identities and scopes.

The [seven-main native execution](validation/README.md#native-cleanup-20261012-01)
retains exact pre/post artifact hashes and expected SPZ diagnostics. The older
census snapshot below remains historical evidence for its original bytes.

## Census implementation and prior evidence

The maintained [census implementation](../native/wasm/allocation_census.cpp),
[bindings](../native/wasm/bindings.cpp),
[worker](../src/workers/document.worker.ts),
[reader](../src/document/allocationCensus.ts) and
[client](../src/document/coreClient.ts) implement the observational contract
below. Raw C++ blocks, tracking headers and context setup are counted while
escaped blocks retain their owning context. Both scene and admitted-history
allocators tag exact granted payload once. The worker copies the fixed borrowed
snapshot after request/output cleanup, then authenticates schema, advancing
sequence and physical union against measured heap. Bootstrap `null` is confined
to pre-module state. Invalid census is fatal on every response family, including
progress. Ordinary measured native refusals remain recoverable. H/C/R admission,
coverage credit and existing ResourceBudget policy are unchanged.

The [census native receipt](validation/README.md#native-census-20261012-01)
passes all five linked source-hash, geometry, live-selection, response and
allocation-census mains. Census reports 15 cases/2,351 assertions, 371
allocation-free observations, 106 binding queries and 20 ordinary refusals.
The final raw union is 845 bytes for an intentionally surviving two-vertex
fixture with 32 payload bytes; this is not a zero-live-storage assertion.
Response remains 13 cases/435 assertions, 136 observations with zero operator-new
calls, 16,549 static bytes and 16 ordinary refusals.

Full units02 passes 1,808/1,808 across 38 files; affected development validation
passes 117/117 across eight files with zero retries/skips. Actual-worker cases
exercise a fresh stable census after real 40 MiB source staging, no additional
admission credit and retained edited state, executable Redo and joined retirement.
Typechecks and web build01 pass. The [combined local receipt](validation/README.md#census-20261012-01)
also records production02 at 66/66 across two files, with zero retries/skips/flaky
results. Unit, development, production and native counts remain separate. It
verifies 367 observed files, 92 deployment artifacts, exact source/runtime
identities and HTML integrity. Receipt SHA-256 is
`9d77cd348e88ba83425935dd75d4a321e9911af8a94a0be1ff8e059fa62da9d2`.
The earlier fullunits01 diagnostic retains 1,757 passed/one failed/50 unexecuted;
only stale current-core ABI expectations were corrected. Production01 retains
65 passed/one failed from an old legacy-core error-message expectation: ABI6
legacy bytes are correctly refused earlier by the ABI7 gate. Only the test
title/error expectation changed before production02; legacy bytes and the
production runtime are unchanged. These results do not
establish new quotas, complete A/B/C runtime acceptance, visuals, performance or
compatibility outside the observed local browser environment.

Census snapshot native input ID is
`dd6d9fc7f891abaadba02779fb38a6505ba062239067e0d352053ed2b4a3fa69`;
app input ID is
`a77a69cdcb6c14952e99b4b0f0bc714c3ef510c778b69b98d3d525fc6bdb7110`;
deployment ID is
`3e77f973d7589635b7c2217e9c52134cecd614baf70b65c4750dee0bd248959b`.
The implementation/version status here supersedes proposal tense in the retained
contract below; it does not rewrite that contract or older receipt facts.

The earlier response/font snapshot uses core ABI6/protocol10/UI-worker5 and has
its own [native receipt](validation/README.md#native-response-20261012-02)
and [targeted browser receipt](validation/README.md#response-ui-20261012-01).
Portable01 and those receipts retain their original source identities and scopes.
[response.hpp](../native/wasm/response.hpp) and
[response.cpp](../native/wasm/response.cpp) still provide two fixed 8,192-byte reply
buffers, bounded UTF-8 serialization and literal failure replies. The exact
canonical `{"command":"summary"}` request bypasses request parsing; the worker's
module-lifetime [summary query](../src/workers/summaryQuery.ts) avoids allocating
a new native request string for each observation. Fixed replies remove response
DOM allocation from this boundary. They do not remove other request, codec or
filesystem allocations.

The sibling draft contains separately executed
[primitive/metadata](../../splatview-web-native-quota-draft-20261012/runs/quota-primitive-09/execution.json),
[WebP](../../splatview-web-native-quota-draft-20261012/runs/quota-webp-04/execution.json),
[typed-response](../../splatview-web-native-quota-draft-20261012/runs/quota-response-01/execution.json)
and [composed-authority](../../splatview-web-native-quota-draft-20261012/runs/quota-composed-01/execution.json)
receipts. Those receipts qualify their isolated executables, not live quota
integration, complete codecs or browser application enforcement.

## Packet one: authenticated census, without enforcement

Keep `sv_open(bytes, length, format, maxSplats, budgetBytes)` and its existing
ResourceBudget policy unchanged. Introduce no new quota value, allocation
ceiling or closed-on-refusal latch in this packet. Existing backend allocation
failure still follows the binding's failure handling. Census bookkeeping must
not introduce a configured refusal inside an otherwise accepted operation.

The initial measurement scope is explicitly `scoped-cxx-v1`: actual C++ blocks
owned by observed core operation contexts and actual context setup allocations.
It is a subset of native storage. Raw C codec workspaces, allocator metadata,
fragmentation, exception ABI records, JS filesystem buffers, GPU memory and
linear-memory capacity are outside this scope. The worker continues measuring
the real linear heap independently.

Do not use the new census to create additional host coverage credit in packet
one. The existing ledger and `H-C` remainder calculation remain authoritative for
admission. This makes measurement, its live integration and its limitations
reviewable before changing enforcement or redistributing credit.

### Maintained changes

| File | Responsibility in packet one |
| --- | --- |
| New `native/wasm/allocation_census.hpp/.cpp` | Own allocation headers, context references, an allocation-free registry/snapshot, exact payload tags and all matching global new/delete forms. Adapt the draft ownership mechanics; do not import its quota ceilings or refusal latch. |
| [bindings.cpp](../native/wasm/bindings.cpp) | Enter observed contexts at allocating work boundaries; add the allocation-free snapshot entry; keep canonical summary and idle-step fast paths allocation-free. |
| [response.hpp](../native/wasm/response.hpp), [response.cpp](../native/wasm/response.cpp) | Add a fixed-topology census reply. Include any new static storage in runtime reserve; never report static buffers as owned scene allocations. |
| [build-core.py](../tools/build-core.py) | Generate uniquely anchored SceneAllocator and AdmittedAllocator tags in the disposable desktop overlay. Record and verify original inputs and generated outputs. |
| [CMakeLists.txt](../native/wasm/CMakeLists.txt) | Link the maintained census into the real core and relevant binding contracts; export the new query. |
| New `native/wasm/allocation_census_contracts.cpp` | Exercise the real bindings and allocation implementation, outside public assets, with nonshipping observations. |
| [response_contracts.cpp](../native/wasm/response_contracts.cpp) | Coordinate its existing global-new observation with the census implementation. Link exactly one replacement implementation; preserve the fixed-response regressions. |
| [wasm.ts](../src/workers/wasm.ts), [document.worker.ts](../src/workers/document.worker.ts), [types.ts](../src/document/types.ts), [coreClient.ts](../src/document/coreClient.ts) | Read, pair and validate a fresh census in the initialized worker envelope. Retain existing allocation fields and admission behavior. |
| [runtime-contract.json](../native/wasm/runtime-contract.json), [verify-toolchain.py](../tools/verify-toolchain.py) and generated identities | Version the new export/wire capability coherently when implementation is accepted. |

These are future implementation files, not authorization to modify frozen
sources. [build-core.py](../tools/build-core.py) already copies
`native/upstream/splatview` into `.build/desktop-package`; apply adaptations only
there. Keep frozen packages, reference captures and existing receipts unchanged.
Build/public output handling remains limited to the established five exact
allowed WASM files; this packet requires no public-directory traversal.

### Allocation ownership and context setup

Each tracked physical C++ allocation has one header retaining its original
context, raw backend request size and exact admitted-payload overlap. Its owner
does not change when a vector, scene, map, history entry or response-independent
object escapes an operation scope. A context remains in the registry while a
scope, handle or surviving allocation retains it. Removing the last handle must
not hide escaped blocks.

The draft [quota.hpp](../../splatview-web-native-quota-draft-20261012/quota.hpp),
[quota.cpp](../../splatview-web-native-quota-draft-20261012/quota.cpp) and
[overlay generator](../../splatview-web-native-quota-draft-20261012/generate.py)
are source inputs for review, not files to compile unchanged. In particular,
the draft's individual context snapshot is not a deduplicated module registry,
and its closure/enforcement behavior belongs to the later packet.

Use an intrusive registry or equivalent bookkeeping that requires no allocation
to observe, release or unlink. Count each context once, independently of the
number of references to its objects. Record the actual setup allocation request
for each live context. The draft allocates its State directly with `malloc` and
reports `sizeof(State)` separately; packet one must include that actual request
in the union rather than silently omitting it. If setup fails before entering an
operation, preserve existing authoritative owners and return the bounded error.

Install a consistent header/free route even for C++ allocations made outside an
observed context. Such blocks may remain runtime storage outside the reported
subset; their deletion must still use the correct header and backend pointer.
Do not inspect a guessed header before a foreign C allocation. Account every
scalar/array, aligned, nothrow and sized-delete form used by the linked build.

Maintain checked live counters; diagnostic attempt counts may saturate but may
not wrap. Registration, allocation and deletion update counters in an order that
cannot publish a nonexistent block or erase a still-live owner. The observer
must not invoke application callbacks. Querying a snapshot allocates no context,
DOM, string or temporary container.

Observe `sv_open`, noncanonical `sv_command`, `sv_live_preview`, allocating
selection-map work, active `sv_step` work and `sv_pack`. Include allocations that
escape into `job`, `packed`, `output`, current/previous scenes, masks, checkpoints,
history and retained maps. Pointer getters, canonical summary, idle step and the
new census query must not create observation contexts. The fixed source-hash
slot and the separate camera module remain runtime storage, with their existing
boundaries and identities.

### Both admitted allocator tags are required

[SceneAllocator](../native/upstream/splatview/src/core/scene_storage.hpp) admits a
payload through `SceneMemory` and then allocates an envelope plus that payload.
Insert its disposable tag after `admit(bytes)` returns and immediately before
the direct ordinary/aligned `operator new`. The tag describes only `bytes`, not
the envelope, allocator header, alignment padding or grant control block. Its
first direct allocation consumes it once; exceptions restore nested tag state.
Do not tag the unbudgeted/rebound paths.

[AdmittedAllocator](../native/upstream/splatview/src/core/admitted_storage.hpp)
separately admits rebound nodes, buckets, deque blocks and change arrays. Give
its granted direct allocation the same exact tag treatment. Only a real
admission contributes payload overlap; the unadmitted/debug-proxy paths do not.
The tag must begin after grant creation, so allocation of the grant's own control
block cannot consume payload overlap. The isolated generator currently adapts
SceneAllocator alone; copying that adapter is insufficient for the live core.

The direct-new size includes an envelope, whereas the overlap is exactly the
payload charged by that allocation's grant. Free the physical block before
releasing its grant, as both existing allocators already do. At the externally
observed boundary, payload and raw-block counters must describe the same live
storage. Copying shared owners contributes neither a second payload nor a
second raw block.

### Physical union and reservation accounting

Use these meanings throughout implementation and tests:

| Symbol | Actual same-boundary measurement |
| --- | --- |
| `S` | Live admitted payload represented by authenticated physical-allocation tags in this measurement scope, including both allocator types. |
| `U` | Live raw backend requests of tracked C++ blocks, including their envelopes/headers/padding, plus actual live context setup requests. |
| `O` | Exact bytes simultaneously present in `S` and tracked raw blocks in `U`. Context setup contributes no overlap. |
| `N` | The checked physical union `S + (U - O)` for `scoped-cxx-v1`. |
| `H` | Actual current linear-memory capacity sampled from the initialized module's buffer. |
| `C` | Host coverage backed by existing admission for distinct actual native portions; it must not exceed the eligible physical storage it covers. |
| `R` | The host remainder `max(0, H-C)`, including uncredited runtime/native storage. |

For a payload block captured by this implementation, its tag contributes to
both `S` and `O`, while its complete backend request contributes to `U`. All
captured payloads therefore have complete overlap coverage; the arithmetic must
still validate `O<=S`, `O<=U`, setup inclusion and overflow. Returning a caller's
requested size, budget limit, grant, peak or future reservation as `N` is invalid.
`N` is a scoped physical union, not permission to credit that entire number to
an arbitrary host lease.

[ResourceBudget](../native/upstream/splatview/src/core/resource_budget.hpp)
is an admission ledger. In `sv_open`, its previous-owner reservation includes old
ledger usage and packet/output/job capacities; its Source grant represents
borrowed browser staging; and [browserPlyAdmission](../native/wasm/browser_geometry.hpp)
reserves a conservative parser envelope. Those grants are useful policy inputs
but are not measurements of actual physical `S`. Keep `memoryBytes` as its
existing ledger field. Do not derive the census from `usage().totalBytes`, even
when a successful final summary happens to contain only retained grants.

Source staging is separately allocated through the JS bridge and covered by its
source lease. It is not a scoped C++ raw block. Do not add the borrowed input
length to `N`, then cover the same bytes again through the source owner.

[BrowserSelectionMap](../native/wasm/selection_map.hpp) has five admitted arrays,
including its deleted-membership array. Its arrays and C++ owner/control block
are already represented in the census when captured. Current map payload credit
is handled separately in [coreClient.ts](../src/document/coreClient.ts). A later
coverage adoption must either carve those exact native portions out of the
aggregate owner or transfer them; adding full `N` alongside existing map credit
double-counts storage. Deduplicate physical owners retained by active, pending,
transaction and tolerance references. Map IDs authenticate semantic owners but
do not stand in for allocation identity.

## Final telemetry and versioned query

The proposed entry is `const char *sv_allocation_snapshot() noexcept`, exported
as `_sv_allocation_snapshot`. It takes no caller-supplied census, owner or size.
It returns a borrowed fixed-buffer UTF-8 packet, to be copied before the next
response-producing native call. A proposed exact packet is:

```json
{
  "ok": true,
  "version": 1,
  "sequence": 1,
  "scope": "scoped-cxx-v1",
  "scenePayloadBytes": 0,
  "ownedRawBytes": 0,
  "overlapBytes": 0,
  "contextBytes": 0,
  "unionBytes": 0,
  "liveBlocks": 0,
  "liveContexts": 0
}
```

`scenePayloadBytes` means `S`, including AdmittedAllocator payload, rather than
only the current Scene's vector. `ownedRawBytes` is `U` and already includes
`contextBytes`; never add that field again. `liveBlocks` counts tracked C++
blocks, while `liveContexts` counts actual setup owners. The registry issues
monotonic query sequences without allocation or silent wrap. Invalid counters
produce a bounded failure, not a fabricated zero census.

Keep this packet separate from the ordinary operation's NativeSummary. Today
`sv_command` forms its reply while its request DOM still lives; its destructor
then runs during return. `sv_open` also retires previous owners and temporary
grants around publication. Reporting raw `U` in either intermediate reply would
disagree with a fresh query after return. The worker must complete native work,
unwind all native temporaries, free bridge staging as appropriate and copy any
borrowed result bytes before querying final summary, census and `H` in one
synchronous observation sequence. No awaited callback or intervening native
mutation may separate those observations.

Add the census as a versioned field of the initialized worker allocation
envelope. Validate its exact keys, integer ranges, arithmetic, scope/version,
monotonic sequence and initialized-module identity before retaining it. Continue
comparing existing primary-summary allocation fields through `sameAllocation`;
do not compare an intermediate raw census with the final one. Error and
cancellation envelopes require fresh post-cleanup telemetry too. A failed or
missing census cannot authorize publication or coverage; the client must use its
existing fatal retirement path when it cannot authenticate the observation.

Byte/count fields are nonnegative safe integers; the query sequence is in
`1..9007199254740991` and refuses exhaustion without wrapping. Validate
`contextBytes<=ownedRawBytes`, both overlap inequalities, the exact union and
`unionBytes<=H` in the paired sample. These are requested physical-storage
measurements, not malloc usable-size or whole-process measurements.

The proposed export and allocation-envelope schema addition should ship together
as core ABI 7, worker protocol 11 and UI-worker contract 6, with a census
capability version in the runtime contract.
Update ABI checks, identity validation, generated descriptors and coherent
fixtures together. These are planned versions, not changes to the current
ABI-6/protocol-10/UI-worker-contract-5 artifacts. Camera ABI 1 can remain unchanged. Packet one still
uses no new census-based coverage credit and changes no quota policy.

## Actual binding acceptance for packet one

Acceptance requires the maintained census linked into the actual core/bindings,
not a second standalone scene or serializer implementation. Keep all observation
and injection controls in nonshipping contract code.

| Contract | Required actual observation |
| --- | --- |
| Header and setup ownership | Every observed raw request is counted once, including context setup. Escaped vectors/scenes survive scope/handle exit, remain visible and debit their original owners only when physically freed. Nested scopes restore their previous owner. |
| Both allocator types | Real SceneAllocator vectors and AdmittedAllocator history/deque/change allocations produce exact payload overlap. Grant/control-block/envelope overhead stays in `U`, not `O`. Rebound and unadmitted allocations cannot invent overlap. |
| Successful live operations | Open supported existing fixtures, edit, create/adopt/release maps, begin/rollback/commit transactions, Undo/Redo, process a job and pack/export through actual C ABI entry points. Validate census changes against independently observed physical allocations; do not use the implementation's own totals as the expected oracle. |
| Refused existing operations | Retain the real edited scene, masks, output and executable content Redo across ordinary prepublication refusals. Compare complete bytes and retained owners, then execute Redo and compare analytic geometry/masks/exports. Packet one does not claim arbitrary postmutation allocation rollback. |
| Final boundary | Parse the result independently outside allocation observation, finish native/bridge cleanup and query census. Request DOM/scratch/context setup is absent unless a real owner escaped. Repeated quiescent queries differ only in sequence and allocate nothing. |
| Available telemetry | Canonical summary, idle step, literal errors and the census query remain allocation-free. Observe setup/backend allocation as well as operator-new attempts; zero-new alone does not prove zero-malloc. |
| Physical union | Independently verify `S`, `U`, `O`, setup inclusion, shared-owner deduplication and checked arithmetic. Larger Source/Work/previous-owner grants cannot increase physical counters without an actual allocation. |
| Worker envelope | Exact schema and sequence/module binding; fresh postfailure/postcancel samples; no stale fallback; no extra coverage credit; no source/map double-count; stopped-worker retirement retains its existing joined ownership rules. |
| Build evidence | Actual command/start/end/exit/stdout receipts, source/tool/overlay/artifact pre/post hashes and real invoked contract mains. Keep first failures and subsequent run IDs distinct. |

Global replacement new in the existing response contract main must be reconciled
with the maintained allocation route. Do not link duplicate replacements, bypass
census headers in one fixture, or free their pointers with an incompatible
observer implementation. Preserve the current response-schema, UTF-8, numeric,
prepared-publication and zero-allocation regressions.

## Later packet: candidate-open enforcement

This section preserves the design for a stronger allocation-refusal guarantee.
It is deferred under the bounded-input product scope and is not a prerequisite
for every new viewer/UI feature or one bounded unpacked-SOG path. A concrete
supported path with an unjustified allocation/expansion envelope may require
this work, tighter format limits or an explicit refusal. The 256 MiB original
input cap and existing decoded/device/admission checks do not themselves provide
the closed-refusal or physical-memory guarantees described here.

Enforcement begins only after the census packet passes and a separate policy
defines the enforced domain, caller admission and headroom relative to live old
owners. Do not infer a new quota from an existing Work grant or silently
reinterpret `budgetBytes`. Only explicitly qualified paths may enforce it.
Other existing format capabilities remain unchanged without broader claims.

Candidate open is the first useful publication boundary: prepare a new scene and
edits while old edited owners/history/Redo remain intact, then publish only after
all required candidate work and reply preparation have succeeded. A failed
candidate scope may close, but a subsequent recovery attempt needs a fresh scope
while original block ownership remains visible. Actual old/new owner coexistence
and setup costs must participate in the defined headroom; retained ceilings do
not participate in physical coverage.

The non-enforcing [bounded SOG cleanup prerequisite](#bounded-sog-json-cleanup-authority)
now has focused local qualification. Its private
`ParsedSogMetadata` lifetime owns exact-input preflight, authority and the actual
`loadSog` DOM; the shared generated header, nested masking and exceptional unwind
remain required invariants. The fallback deliberately retains ordinary iterative
destruction, which can allocate. A later closed-on-refusal scope must establish
qualification or refuse before DOM construction under an explicit policy; it
cannot assume the compatibility fallback is allocation-safe.

Command/live-preview request DOMs need their own bounds; the metadata
65,536-token default is too small for the existing 65,536-point selection path.
No unrelated `{}` or caller census may authorize destruction.
[sog_export.cpp](../native/upstream/splatview/src/core/sog_export.cpp) constructs
another DOM and cannot borrow parsed-request authority for its unreviewed
construction. SourceSnapshot parses remain separate, too. Fixed native replies
need no JSON authority. A depth bound and sampled stack delta alone do not
establish safe stack use for arbitrary construction. Define the candidate policy
separately after this prerequisite's actual linked qualification.

Codec and filesystem closure are separate prerequisites for extending the claim:

- Global C++ new does not capture libdeflate, zlib, Zstd or WebP's raw C
  allocations. Use reviewed per-codec hooks/custom-memory contexts and matching
  frees. The exact WebP utility shim must resolve in the real link, with the
  original allocator utility member excluded. Extend actual fixtures beyond
  the isolated four 2x2 VP8L inputs before broader codec qualification.
- [SPZ load-spz.cc](../native/upstream/splatview/third_party/spz/src/cc/load-spz.cc)
  in the frozen package initializes zlib streams before throwing vector
  `reserve`/`insert` work, then calls `inflateEnd`/`deflateEnd` only on normal
  return. The [browser overlay helper](../tools/spz_stream_cleanup.py) now
  installs RAII immediately after each successful initialization, leaving the
  frozen source unchanged. This closes stream lifetime on ordinary codec errors
  and vector exceptions; it does not account for raw zlib allocation. Existing libdeflate decoder paths have
  unique_ptr cleanup; SOG WebPPicture has RAII and its writer catches exceptions.
- Export now serializes into a private `AtomicFile` owner, validates a complete
  read into a candidate vector and retires file/request temporaries before
  replacing the previous output owner. Both old and new output intentionally
  coexist until the final nonthrowing swap. Native failure contracts cover
  write/commit/read/close and candidate allocation failures; arbitrary unlink
  failure remains outside that qualification because `AtomicFile` ignores its
  cleanup error code.
  MEMFS storage may be JS buffers outside `H`; neither global new nor `H-C`
  proves its coverage. Define separate filesystem ownership/admission or a
  reviewed bounded sink before making an export quota claim.
- Command code can change selection baselines or consume session/map IDs before
  later work. Native history commit methods provide useful staged boundaries,
  but they do not prove whole-binding atomicity. Review and test those owners
  before enabling command-wide refusal. Retained jobs and final `sv_step`
  publication require their own old-state/Redo contracts.

Full codec/MEMFS closure, whole-command atomicity, real App/navigation/GPU
cancellation, grouped inputs and cross-platform acceptance remain later work.
