#include "json_preflight.hpp"
#include <array>
#include <limits>

namespace {
thread_local bool parsedSogAuthority{};
using namespace sv_json;
bool utf8(std::string_view text) noexcept {
    for (std::size_t i=0;i<text.size();) {
        const auto a=static_cast<unsigned char>(text[i++]);
        if (a<0x80) continue;
        unsigned extra{},code{};
        if (a>=0xc2 && a<=0xdf) { extra=1; code=a&31; }
        else if (a>=0xe0 && a<=0xef) { extra=2; code=a&15; }
        else if (a>=0xf0 && a<=0xf4) { extra=3; code=a&7; }
        else return false;
        if (extra>text.size()-i) return false;
        for (unsigned j=0;j<extra;++j) {
            const auto b=static_cast<unsigned char>(text[i++]);
            if ((b&0xc0)!=0x80) return false;
            code=(code<<6)|(b&63);
        }
        if ((extra==1 && code<0x80) || (extra==2 && code<0x800) ||
            (extra==3 && code<0x10000) || code>0x10ffff || (code>=0xd800 && code<=0xdfff)) return false;
    }
    return true;
}
bool valid_limits(MetadataLimits l) noexcept {
    constexpr auto d=defaultMetadataLimits;
    return l.maxBytes && l.maxBytes<=d.maxBytes && l.maxDepth && l.maxDepth<=d.maxDepth &&
        l.maxTokens && l.maxTokens<=d.maxTokens && l.maxStringUnits && l.maxStringUnits<=d.maxStringUnits &&
        l.maxTotalStringUnits && l.maxTotalStringUnits<=d.maxTotalStringUnits &&
        l.maxNumberCharacters && l.maxNumberCharacters<=d.maxNumberCharacters;
}
// Exact nearest-binary64 overflow midpoint: 2^1024 - 2^970.
// <=128-character decimal lexemes cannot equal this309-significant-digit
// integer. Compare all309 digits, padding input with zeros. No libc conversion.
constexpr std::string_view overflow_midpoint=
    "179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792";
static_assert(overflow_midpoint.size()==309);
bool finite_number(std::string_view token) noexcept {
    std::array<char,128> digits{};
    std::size_t n{},fraction{}; bool dot{},significant{};
    std::size_t at=token[0]=='-'?1:0;
    for (;at<token.size() && token[at]!='e' && token[at]!='E';++at) {
        const auto c=token[at];
        if (c=='.') { dot=true; continue; }
        if (dot) ++fraction;
        if (c!='0' || significant) { significant=true; digits[n++]=c; }
    }
    if (!n) return true; // Signed/all-zero significand, even huge exponent.
    int exponent{}; bool negative{};
    if (at<token.size()) {
        ++at;
        if (token[at]=='+' || token[at]=='-') negative=token[at++]=='-';
        for (;at<token.size();++at) {
            if (exponent<10000) { exponent=exponent*10+(token[at]-'0'); if (exponent>10000) exponent=10000; }
        }
    }
    if (negative) exponent=-exponent;
    const int order=static_cast<int>(n)+exponent-static_cast<int>(fraction)-1;
    if (order!=308) return order<308;
    for (std::size_t i=0;i<overflow_midpoint.size();++i) {
        const auto digit=i<n?digits[i]:'0';
        if (digit!=overflow_midpoint[i]) return digit<overflow_midpoint[i];
    }
    return false;
}
enum class Kind : unsigned char { Array,Object };
enum class State : unsigned char { First,Value,Comma,Key,Colon };
struct Frame { Kind kind; State state; };
struct Parser {
    std::string_view text; MetadataLimits limits; MetadataCensus counts{};
    std::array<Frame,32> frames{}; std::size_t index{},depth{};
    PreflightStatus error{PreflightStatus::Ok};
    bool fail(PreflightStatus s=PreflightStatus::Structural) noexcept { error=s; return false; }
    char next() const noexcept { return index<text.size()?text[index]:'\0'; }
    void whitespace() noexcept {
        while (index<text.size() && (next()==' ' || next()=='\t' || next()=='\r' || next()=='\n')) ++index;
    }
    bool token() noexcept {
        if (counts.tokens==limits.maxTokens) return fail(PreflightStatus::TokenLimit);
        ++counts.tokens; return true;
    }
    bool hex(unsigned &value) noexcept {
        if (text.size()-index<4) return fail();
        value=0;
        for (unsigned part=0;part<4;++part) {
            const auto c=text[index++];
            const int digit=c>='0' && c<='9'?c-'0':c>='A' && c<='F'?c-'A'+10:c>='a' && c<='f'?c-'a'+10:-1;
            if (digit<0) return fail();
            value=value*16+static_cast<unsigned>(digit);
        }
        return true;
    }
    bool string() noexcept {
        if (next()!='"') return fail();
        ++index; std::size_t units{};
        while (index<text.size()) {
            const auto c=static_cast<unsigned char>(text[index++]);
            if (c=='"') { counts.stringUnits+=units; return true; }
            if (c<0x20) return fail();
            std::size_t added=1;
            if (c=='\\') {
                if (index==text.size()) return fail();
                const auto escape=text[index++];
                if (escape=='u') {
                    unsigned point{}; if (!hex(point)) return false;
                    if (point>=0xd800 && point<=0xdbff) {
                        if (text.size()-index<6 || text[index]!='\\' || text[index+1]!='u') return fail();
                        index+=2; unsigned low{}; if (!hex(low)) return false;
                        if (low<0xdc00 || low>0xdfff) return fail();
                        added=2;
                    } else if (point>=0xdc00 && point<=0xdfff) return fail();
                } else if (escape!='"' && escape!='\\' && escape!='/' && escape!='b' && escape!='f' &&
                           escape!='n' && escape!='r' && escape!='t') return fail();
            } else if (c>=0x80) {
                // Entire original byte input was independently UTF8-validated.
                const std::size_t extra=c<0xe0?1:c<0xf0?2:3;
                index+=extra; added=extra==3?2:1;
            }
            if (added>limits.maxStringUnits-units ||
                added>limits.maxTotalStringUnits-counts.stringUnits-units) return fail(PreflightStatus::StringLimit);
            units+=added;
        }
        return fail();
    }
    static bool digit(char c) noexcept { return c>='0' && c<='9'; }
    bool number() noexcept {
        const auto start=index;
        if (next()=='-') ++index;
        if (next()=='0') ++index;
        else {
            if (next()<'1' || next()>'9') return fail();
            do { ++index; } while (digit(next()));
        }
        if (next()=='.') {
            ++index; if (!digit(next())) return fail();
            do { ++index; } while (digit(next()));
        }
        if (next()=='e' || next()=='E') {
            ++index; if (next()=='+' || next()=='-') ++index;
            if (!digit(next())) return fail();
            do { ++index; } while (digit(next()));
        }
        if (index-start>limits.maxNumberCharacters) return fail(PreflightStatus::NumberLimit);
        if (!finite_number(std::string_view{text.data()+start,index-start})) return fail(PreflightStatus::Nonfinite);
        return true;
    }
    bool value() noexcept {
        if (!token()) return false;
        const auto c=next();
        if (c=='{' || c=='[') {
            if (depth==limits.maxDepth) return fail(PreflightStatus::Depth);
            frames[depth++]={c=='{'?Kind::Object:Kind::Array,State::First};
            if (depth>counts.maxDepth) counts.maxDepth=depth;
            ++index; return true;
        }
        if (c=='"') return string();
        if (c=='-' || digit(c)) return number();
        const std::string_view literal=c=='t'?std::string_view{"true",4}:c=='f'?std::string_view{"false",5}:
            c=='n'?std::string_view{"null",4}:std::string_view{};
        if (literal.empty() || literal.size()>text.size()-index ||
            std::string_view{text.data()+index,literal.size()}!=literal) return fail();
        index+=literal.size(); return true;
    }
    bool parse() noexcept {
        if (text.size()>=3 && static_cast<unsigned char>(text[0])==0xef &&
            static_cast<unsigned char>(text[1])==0xbb && static_cast<unsigned char>(text[2])==0xbf) index=3;
        whitespace(); if (!value()) return false;
        while (true) {
            whitespace();
            if (!depth) return index==text.size() || fail();
            auto &frame=frames[depth-1]; const auto c=next();
            if (frame.kind==Kind::Array) {
                if (frame.state==State::First && c==']') { --depth; ++index; }
                else if (frame.state==State::First || frame.state==State::Value) {
                    frame.state=State::Comma; if (!value()) return false;
                } else if (c==',') { frame.state=State::Value; ++index; }
                else if (c==']') { --depth; ++index; }
                else return fail();
            } else if (frame.state==State::First && c=='}') { --depth; ++index; }
            else if (frame.state==State::First || frame.state==State::Key) {
                if (!token() || !string()) return false;
                frame.state=State::Colon;
            } else if (frame.state==State::Colon) {
                if (c!=':') return fail();
                frame.state=State::Value; ++index;
            } else if (frame.state==State::Value) {
                frame.state=State::Comma; if (!value()) return false;
            } else if (c==',') { frame.state=State::Key; ++index; }
            else if (c=='}') { --depth; ++index; }
            else return fail();
        }
    }
};
}
namespace sv_json {
MetadataPreflight preflightSogJson(std::string_view text,MetadataLimits limits) noexcept {
    if (!valid_limits(limits)) return {PreflightStatus::InvalidLimits,{},0};
    if (text.size()>limits.maxBytes) return {PreflightStatus::ByteLimit,{},0};
    if (!utf8(text)) return {PreflightStatus::Utf8,{},0};
    Parser parser{text,limits};
    if (!parser.parse()) return {parser.error,{},parser.index};
    return {PreflightStatus::Ok,parser.counts,0};
}
std::size_t preflightFixedArrayBytes() noexcept { return sizeof(Parser::frames)+128; }
}

namespace sv_json {
ParsedSogMetadata::Authority::Authority(bool qualified) noexcept
    : previous_(parsedSogAuthority) {
    // Assignment, rather than an OR or nesting count, prevents an unqualified
    // nested compatibility parse from inheriting its outer owner's permission.
    parsedSogAuthority = qualified;
}
ParsedSogMetadata::Authority::~Authority() noexcept {
    parsedSogAuthority = previous_;
}
ParsedSogMetadata::ParsedSogMetadata(std::string_view bytes)
    : qualification_(preflightSogJson(bytes)),
      authority_(static_cast<bool>(qualification_)),
      dom_(nlohmann::json::parse(bytes.begin(), bytes.end())) {}
ParsedFilterCommand::Authority::Authority(bool qualified) noexcept :previous_(parsedSogAuthority) { parsedSogAuthority=qualified; }
ParsedFilterCommand::Authority::~Authority() noexcept { parsedSogAuthority=previous_; }
ParsedFilterCommand::ParsedFilterCommand(std::string_view bytes)
    :qualification_(preflightSogJson(bytes,MetadataLimits{4096,4,256,512,1024,128})),
     authority_(static_cast<bool>(qualification_)),dom_(nlohmann::json::parse(bytes.begin(),bytes.end())) {}
} // namespace sv_json

bool sv_json_bounded_recursive_destroy_active() noexcept {
    return parsedSogAuthority;
}
