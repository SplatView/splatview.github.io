// Private contracts against the actual shipping dispatch and fixed native
// ledger. Reply failure seams exist only in this executable, never app exports.
#include "operation_receipt.hpp"
#include "response.hpp"
#include "allocation_census.hpp"
#include "model.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
unsigned sv_abi_version();
const char *sv_build_identity();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);
const char *sv_live_preview(const char *);
const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();
const uint8_t *sv_states_ptr();
}
namespace {
using Json=nlohmann::json;
using Bytes=std::vector<uint8_t>;
size_t cases{},checks{},terminalReplyRefusals{},preparationRefusals{},newAttempts{};
void require(bool value,const char *message) {++checks;if(!value)throw std::runtime_error(message);}
template<class F>void test(F action){action();++cases;}
void observe(const sv_allocation::Event &event) noexcept {if(event.kind==sv_allocation::EventKind::NewAttempt)++newAttempts;}
Json parsed(const char *text){return Json::parse(text);}
Json command(const Json &request){const auto text=request.dump();return parsed(sv_command(text.c_str()));}
Json live(const Json &request){const auto text=request.dump();return parsed(sv_live_preview(text.c_str()));}
Json summary(){return parsed(sv_command("{\"command\":\"summary\"}"));}
Json scope(unsigned generation=1){return {{"version",1},{"documentId","11111111-1111-4111-8111-111111111111"},
    {"sourceGeneration",generation},{"clientGeneration","22222222-2222-4222-8222-222222222222"}};}
Json owner(uint64_t id,unsigned generation=1){auto value=scope(generation);value["operationId"]=id;return value;}
Json owned(std::string_view name,const Json &identity){return {{"command",name},{"operationOwner",identity}};}
Json call(std::string_view name,const Json &identity){return command(owned(name,identity));}
Json receipt(std::string_view name,const Json &identity,std::string_view outcome){
    const auto result=call(name,identity);
    require(result.at("ok")==true&&result.at("kind")=="operation-receipt"&&result.at("version")==2&&result.at("receipt").at("version")==2,"Native receipt wrapper differs");
    require(result.at("receipt").at("owner")==identity&&result.at("receipt").at("outcome")==outcome,"Native receipt ownership/outcome differs");
    return result;
}
void retire(const Json &identity){
    const auto result=call("operationRetire",identity);
    require(result==Json({{"ok",true},{"kind","operation-retired"},{"version",1},{"owner",identity}}),"Native receipt retirement differs");
}
Json finish(Json result){
    for(unsigned steps=0;result.value("pending",false);++steps){require(steps<128,"Tiny operation failed to finish");result=parsed(sv_step(65536));}
    require(result.at("ok")==true,"Native cooperative operation failed");return result;
}
Json state(const Json &s){
    Json result=Json::object();
    for(const auto *key:{"revision","contentRevision","count","sourceCount","duplicateRange","selected","visible","canUndo","canRedo","transaction","selectionDraft","pending",
        "toleranceSessionId","toleranceMapId","selectionMapId","pendingSelectionMapId","selectionMapRetainedIds"})result[key]=s.at(key);
    return result;
}
Bytes input(){
    std::ostringstream text;
    text<<"ply\nformat ascii 1.0\nelement vertex 5\nproperty float x\nproperty float y\nproperty float z\n"
        "property float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\n"
        "property float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n";
    for(unsigned i=0;i<45;++i)text<<"property float f_rest_"<<i<<'\n';
    text<<"end_header\n";
    for(unsigned i=0;i<5;++i){text<<int(i)-2<<" 0 1 -3 -3 -3 1 0 0 0 1 ";text<<float(i)*.1f<<" .2 -.3 ";
        for(unsigned j=0;j<45;++j)text<<float(int((i+j)%9)-4)*.03125f<<' ';text<<'\n';}
    const auto value=text.str();return {value.begin(),value.end()};
}
std::array<preview::Gaussian,5> scene(){std::array<preview::Gaussian,5> value{};std::memcpy(value.data(),sv_scene_ptr(),sizeof(value));return value;}
std::array<uint8_t,5> mask(){std::array<uint8_t,5> value{};std::memcpy(value.data(),sv_states_ptr(),value.size());return value;}
void single(unsigned index){require(command({{"command","single"},{"index",index},{"operation",0}}).at("ok")==true,"Fixture single failed");}
void fixture(){
    const auto bytes=input();require(parsed(sv_open(bytes.data(),bytes.size(),0,100,64*1024*1024)).at("ok")==true,"SH3 fixture failed");
    single(4);require(command({{"command","delete"}}).at("ok")==true,"Fixture deletion failed");single(1);single(2);
    require(command({{"command","undo"}}).at("canRedo")==true,"Fixture lacks executable Redo");
    require(mask()==std::array<uint8_t,5>{0,1,0,0,2},"Independent initial mask differs");
    const auto bound=command({{"command","operationBind"},{"operationScope",scope()}});
    require(bound==Json({{"ok",true},{"kind","operation-bound"},{"version",1},{"scope",scope()}}),"Native scope binding differs");
}
void ledgerContracts(){
    test([]{
        sv_operation::State state;state.count=7;state.sourceCount=9;state.selected=2;state.visible=6;
        state.hasDuplicateRange=true;state.duplicateFirst=5;state.duplicateCount=2;
        require(sv_operation::valid(state),"Valid topology snapshot rejected");
        auto changed=state;++changed.count;require(changed!=state&&!sv_operation::valid(changed),"Count/range change escaped exact equality");
        changed=state;++changed.sourceCount;require(changed!=state,"Source count omitted from exact equality");
        changed=state;changed.hasDuplicateRange=false;require(!sv_operation::valid(changed),"Absent marker retained hidden scalars");
        changed=state;changed.duplicateCount=0;require(!sv_operation::valid(changed),"Empty marker accepted");
        changed=state;changed.duplicateFirst=0;require(!sv_operation::valid(changed),"Interior marker accepted");
        changed=state;changed.sourceCount=6;require(!sv_operation::valid(changed),"Source smaller than loaded accepted");
    });
    sv_operation::Scope s;const auto doc=scope().at("documentId").get<std::string>(),client=scope().at("clientGeneration").get<std::string>();
    std::copy(doc.begin(),doc.end(),s.documentId.bytes.begin());std::copy(client.begin(),client.end(),s.clientGeneration.bytes.begin());s.sourceGeneration=1;
    test([&]{
        sv_operation::Ledger ledger;sv_operation::State before;before.revision=9;before.contentRevision=4;before.canRedo=true;
        const sv_operation::Owner a{s,1},b{s,2};const auto allocationBefore=newAttempts;
        require(ledger.bind(s,1)&&ledger.admit(a,1,before)&&ledger.activate(a),"Fixed ledger could not activate owner");
        auto terminal=before;terminal.revision=13;terminal.canUndo=true;
        require(ledger.complete(a,sv_operation::Outcome::Committed,terminal),"Fixed ledger did not commit");
        require(!ledger.admit(b,1,before),"Unretired receipt was overwritten");
        const auto proof=ledger.status(a,1,terminal);require(proof.terminal==terminal&&proof.before==before,"Fixed proof changed snapshots");
        require(ledger.retire(a,1)&&ledger.retire(a,1),"Fixed retirement was not idempotent");
        require(ledger.status(a,1,terminal).outcome==sv_operation::Outcome::ExpiredConflict,"Retired identity became not-started");
        require(ledger.admit(b,1,terminal)&&ledger.activate(b),"Retired slot could not accept next owner");
        require(newAttempts==allocationBefore,"Fixed proof transition allocated");
    });
    test([&]{
        sv_operation::Ledger ledger;sv_operation::State current;sv_operation::Owner a{s,7};require(ledger.bind(s,1),"Scope failed");
        require(ledger.status(a,1,current).outcome==sv_operation::Outcome::NotStarted,"Fresh status lacks not-started proof");
        require(!ledger.admit(a,1,current),"Late begin bypassed not-started fence");require(ledger.retire(a,1),"Not-started retirement failed");
        require(ledger.status({s,6},1,current).outcome==sv_operation::Outcome::ExpiredConflict,"Skipped old identity became not-started");
        ledger.sourceChanged();require(!ledger.bind(s,2),"Old source scope rebound after replacement");s.sourceGeneration=2;
        require(ledger.bind(s,2)&&ledger.status({s,8},2,current).outcome==sv_operation::Outcome::NotStarted,"Advanced source scope failed");s.sourceGeneration=1;
    });
}
void nativeContracts(){
    fixture();uint64_t id=0;
    test([&]{require(sv_abi_version()==24&&parsed(sv_build_identity()).at("capabilities").at("transactionReceipt")==2&&parsed(sv_build_identity()).at("capabilities").at("recoveryCheckpoint")==2&&parsed(sv_build_identity()).at("capabilities").at("duplicate")==1,"ABI24 topology receipt/recovery capability missing");
        auto wrong=scope();wrong["clientGeneration"]="33333333-3333-4333-8333-333333333333";
        require(command({{"command","operationBind"},{"operationScope",wrong}}).at("ok")==false,"Native scope was rebound");});
    test([&]{
        const auto a=owner(++id),before=summary();const auto baseline=mask();const auto native=scene();
        auto begun=receipt("beginTransaction",a,"active");require(begun.at("receipt").at("before")==state(before)&&begun.at("receipt").at("terminal").is_null(),"Active receipt lost baseline");
        require(command({{"command","selectAll"}}).at("ok")==false&&mask()==baseline,"Bare mutation bypassed identified owner");
        auto wrong=a;wrong["operationId"]=id+100;require(call("selectAll",wrong).at("ok")==false,"Foreign mutation bypassed owner");
        require(receipt("operationStatus",wrong,"expired-conflict").at("receipt").at("before").is_null(),"Conflicting status manufactured baseline");
        require(call("selectAll",a).at("selected")==4,"Identified select-all failed");const auto staged=summary();
        const auto committed=receipt("commitTransaction",a,"committed");require(committed.at("receipt").at("terminal")==state(committed.at("summary")),"Commit receipt differs from terminal summary");
        require(committed.at("receipt").at("before")==state(before)&&!committed.at("summary").at("transaction"),"Commit lost before/checkpoint state");
        require(mask()==std::array<uint8_t,5>{1,1,1,1,2}&&!std::memcmp(scene().data(),native.data(),sizeof(native)),"Selection commit changed attributes/SH");
        require(summary().at("revision")==staged.at("revision"),"Commit added a revision");
        const auto proof=receipt("operationStatus",a,"committed");require(proof.at("receipt")==committed.at("receipt"),"Commit proof changed after dropped reply");
        require(call("commitTransaction",a).at("ok")==false&&call("rollbackTransaction",a).at("ok")==false,"Terminal operation replayed");
        require(command({{"command","undo"}}).at("ok")==false,"Unretired proof allowed competing history");
        const auto bytes=input();require(parsed(sv_open(bytes.data(),bytes.size(),0,100,64*1024*1024)).at("ok")==false,"Replacement erased unretired proof");
        retire(a);retire(a);receipt("operationStatus",a,"expired-conflict");
        require(command({{"command","undo"}}).at("ok")==true&&mask()==baseline,"Commit Undo differs from independent baseline");
        require(command({{"command","redo"}}).at("ok")==true&&mask()==std::array<uint8_t,5>{1,1,1,1,2},"Commit Redo differs");
        require(command({{"command","undo"}}).at("ok")==true&&mask()==baseline,"Could not restore baseline with Redo");
    });
    test([&]{
        const auto a=owner(++id),before=summary();const auto baseline=mask();const auto native=scene();receipt("beginTransaction",a,"active");
        call("selectNone",a);const auto rolled=receipt("rollbackTransaction",a,"rolled-back");
        require(mask()==baseline&&!std::memcmp(scene().data(),native.data(),sizeof(native))&&state(summary())==state(before),"Rollback did not restore exact SH/mask/history/revisions");
        require(rolled.at("receipt").at("terminal")==state(before),"Rollback proof differs from baseline");retire(a);
    });
    test([&]{
        const auto a=owner(++id),before=summary();const auto proof=receipt("operationStatus",a,"not-started");
        require(proof.at("receipt").at("before")==state(before)&&proof.at("receipt").at("terminal")==state(before),"Not-started snapshot differs");
        require(call("beginTransaction",a).at("ok")==false,"Delayed begin ran after not-started proof");retire(a);
    });
    test([&]{
        const auto a=owner(++id),before=summary();sv_response::refuseNextSummaryForContracts();
        require(call("beginTransaction",a).at("ok")==false,"Refused begin unexpectedly published");++preparationRefusals;
        require(state(summary())==state(before),"Refused begin changed native document");receipt("operationStatus",a,"not-started");retire(a);
    });
    for(const bool rollback:{false,true})test([&]{
        const auto a=owner(++id),before=summary();const auto baseline=mask();receipt("beginTransaction",a,"active");call("selectNone",a);
        sv_response::refuseNextOperationPublicationForContracts();
        require(call(rollback?"rollbackTransaction":"commitTransaction",a).at("ok")==false,"Post-release terminal publication was not refused");++terminalReplyRefusals;
        const auto proof=receipt("operationStatus",a,rollback?"rolled-back":"committed");
        require(!summary().at("transaction")&&proof.at("receipt").at("terminal")==state(summary()),"Lost terminal response erased native proof");
        require(rollback?mask()==baseline:mask()==std::array<uint8_t,5>{0,0,0,0,2},"Lost terminal reply has wrong mask");retire(a);
        if(!rollback)require(command({{"command","undo"}}).at("ok")==true&&mask()==baseline,"Lost commit added wrong history");
        else require(state(summary())==state(before),"Lost rollback changed history/revision");
    });
    test([&]{
        const auto a=owner(++id);const auto baseline=mask();receipt("beginTransaction",a,"active");call("selectNone",a);
        sv_response::refuseNextSummaryForContracts();require(call("commitTransaction",a).at("ok")==false,"Commit preparation gate was not refused");++preparationRefusals;
        require(receipt("operationStatus",a,"active").at("summary").at("transaction")==true,"Refused commit lost checkpoint");
        receipt("rollbackTransaction",a,"rolled-back");require(mask()==baseline,"Refused commit rollback lost baseline");retire(a);
    });
    for(const auto name:{"selectAll","undo","redo"})test([&]{
        const auto a=owner(++id),before=summary();receipt("beginTransaction",a,"active");require(call(name,a).at("ok")==true,"History/no-op mutation refused");
        const auto staged=summary(),proof=receipt("commitTransaction",a,"committed");
        require(proof.at("receipt").at("before")==state(before)&&proof.at("receipt").at("terminal").at("revision")==staged.at("revision"),"History/no-op receipt inferred outcome from revision");retire(a);
    });
    test([&]{
        const auto a=owner(++id);receipt("beginTransaction",a,"active");require(call("beginSelection",a).at("selectionDraft")==true,"Draft begin refused");
        auto pick=owned("single",a);pick["index"]=0;pick["operation"]=0;require(command(pick).at("ok")==true,"Draft pick refused");
        const auto committed=receipt("commitTransaction",a,"committed");require(committed.at("receipt").at("terminal").at("selectionDraft")==true,"Commit receipt collapsed unfinished draft");retire(a);
        require(command({{"command","cancelSelection"}}).at("selectionDraft")==false,"Draft fixture cleanup failed");
    });
    test([&]{
        const auto a=owner(++id),before=summary();const auto baseline=mask();receipt("beginTransaction",a,"active");call("beginSelection",a);
        auto request=owned("rectangle",a);request["camera"]=summary().at("camera");request["width"]=256;request["height"]=256;
        request["rectangle"]={0,0,256,256};request["operation"]=0;request["fromBaseline"]=true;request["visibleOnly"]=false;request["overlap"]=false;
        auto foreign=request;foreign["operationOwner"]["operationId"]=id+1;
        require(live(foreign).at("ok")==false&&mask()==baseline,"Foreign live preview bypassed owner");
        require(live(request).at("kind")=="published","Identified live preview failed");
        receipt("rollbackTransaction",a,"rolled-back");retire(a);
        require(mask()==baseline&&state(summary())==state(before),"Live preview rollback changed original history/draft");
    });
    test([&]{
        const auto begun=command({{"command","beginFilter"},{"kind","sphere"}});require(begun.at("ok")==true,"Filter entry fixture failed");
        const auto filter=begun.at("filter"),before=summary();const auto baseline=mask();const auto a=owner(++id);receipt("beginTransaction",a,"active");
        auto preview=owned("previewFilter",a);preview["id"]=filter.at("id");preview["epoch"]=1;preview["kind"]="sphere";
        preview["parameters"]={{"center",{0,0,1}},{"radius",0}};preview["operation"]=0;finish(command(preview));
        const auto proof=receipt("rollbackTransaction",a,"rolled-back");retire(a);
        require(mask()==baseline&&summary().at("filter")==filter&&state(summary())==state(before),"Identified filter rollback lost draft/history metadata");
        require(proof.at("receipt").at("terminal")==state(summary()),"Filter terminal snapshot differs");
        require(command({{"command","cancelFilter"},{"id",filter.at("id")}}).at("ok")==true,"Filter cleanup failed");
    });
    test([&]{
        const auto begun=command({{"command","beginOpacity"},{"selectedOnly",false}});require(begun.at("ok")==true,"Opacity entry fixture failed");
        const auto opacity=begun.at("opacitySession"),before=summary();const auto native=scene();const auto baseline=mask();
        const auto a=owner(++id);receipt("beginTransaction",a,"active");auto apply=owned("applyOpacity",a);
        apply["id"]=opacity.at("id");apply["epoch"]=1;apply["scale"]=.5;auto pending=command(apply);
        require(pending.at("pending")==true,"Opacity fixture did not execute real bake");auto foreign=a;foreign["operationId"]=id+1;
        require(call("cancel",foreign).at("ok")==false&&summary().at("pending")==true,"Foreign owner cancelled native job");finish(pending);
        require(sv_scene_ptr()[0].positionOpacity[3]==native[0].positionOpacity[3]*.5f,"Independent opacity bake oracle differs");
        const auto proof=receipt("rollbackTransaction",a,"rolled-back");retire(a);
        require(!std::memcmp(scene().data(),native.data(),sizeof(native))&&mask()==baseline&&summary().at("opacitySession")==opacity&&state(summary())==state(before),
                "Identified opacity rollback lost exact scene/SH/owner/history");
        require(proof.at("receipt").at("terminal")==state(summary()),"Opacity terminal snapshot differs");
        require(command({{"command","endOpacity"},{"id",opacity.at("id")}}).at("ok")==true,"Opacity cleanup failed");
    });
    test([&]{
        const auto before=summary();const auto baseline=mask();const auto a=owner(++id);receipt("beginTransaction",a,"active");
        auto begin=owned("beginTransform",a);begin["kind"]="numeric";begin["selectedOnly"]=false;
        const auto result=command(begin);require(result.at("ok")==true&&result.at("transformSession").is_object(),"Identified transform entry failed");
        receipt("rollbackTransaction",a,"rolled-back");retire(a);
        require(mask()==baseline&&summary().at("transformSession").is_null()&&state(summary())==state(before),"Transform rollback retained new session or changed baseline");
    });
    test([&]{
        const auto before=summary();const auto native=scene();const auto baseline=mask();const auto a=owner(++id);receipt("beginTransaction",a,"active");
        auto grade=owned("grade",a);grade["values"]={1.5,1,1,1,1,0,0,0,0,0,0,0,0,0,0};grade["selectedOnly"]=false;
        const auto changed=finish(command(grade));require(changed.at("colorSession").is_object()&&std::memcmp(scene().data(),native.data(),sizeof(native)),"Identified grade did not run real SH3 bake");
        const auto proof=receipt("rollbackTransaction",a,"rolled-back");retire(a);
        require(!std::memcmp(scene().data(),native.data(),sizeof(native))&&mask()==baseline&&state(summary())==state(before),"Color rollback lost exact scene/SH/mask/history");
        require(proof.at("summary").at("colorSession")==summary().at("colorSession"),"Rollback reply retained the cancelled color owner");
    });
    test([&]{
        auto a=owner(++id),wrong=a;wrong["sourceGeneration"]=2;
        receipt("operationStatus",wrong,"expired-conflict");require(call("beginTransaction",wrong).at("ok")==false,"Stale source began edit");
        auto invalid=a;invalid["operationId"]=0;require(call("operationStatus",invalid).at("ok")==false,"Zero operation identity accepted");
    });
}
} // namespace
int main(){
    try {
        sv_allocation::setObserverForContracts(observe);ledgerContracts();nativeContracts();
        std::printf("SPLATVIEW_OPERATION_RECEIPT_CONTRACTS_PASS cases=%zu checks=%zu terminalReplyRefusals=%zu preparationRefusals=%zu receiptBytes=%zu ledgerBytes=%zu\n",
            cases,checks,terminalReplyRefusals,preparationRefusals,sizeof(sv_operation::Receipt),sizeof(sv_operation::Ledger));return 0;
    }catch(const std::exception &error){std::fprintf(stderr,"SPLATVIEW_OPERATION_RECEIPT_CONTRACTS_FAIL %s\n",error.what());return 1;}
}
