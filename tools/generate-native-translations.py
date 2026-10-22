"""Verify and extract the pinned proprietary native language table.

Only Python's standard library is used. The accepted input is a bounded subset
of C++ initializers, never executable Python, JavaScript, or C++ expressions.
Generated catalog, provenance and license outputs have fixed repository paths.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any


CAPTURE_RELATIVE = Path("reference/targets/windows-r0-20261012-02")
CAPTURE_ID = "cc71f0df-8f38-4900-8aff-5c9ee0d6814c"
CAPTURE_MANIFEST = (149390, "0156c58d345ecf633d57a0ff339c8c07a270efb0575e6158e49d7d0840678fe4")
SOURCE_RECORDS = {
    "src/translations.inc": (195483, "cc87e6c8e130805f1edca9e96eb4c83c943116dd151234eda60912ddcb15940a"),
    "src/language.cpp": (8284, "19080c18f43393d66100e9a6294c238ddced911975f85a9b2d43d1e54c8c3d2f"),
    "src/language.hpp": (2233, "968dafa3bf92dfe3cc7f8e793154ba453c41ae84ba664be0822b50b587f02018"),
    "tests/language_contracts.cpp": (8374, "c7b4b25fca4df39a8fc1501604b898fa133fc84dfe76ade40d503d9f2fb23344"),
    "LICENSE": (1265, "ff39f450fd56ce98a7da38c5981e2f4661c55cdd404b6294eace5e805f9fc132"),
}
EXPECTED_KEYS = 592
EXPECTED_LOCALES = 8
EXPECTED_FORMAT_KEYS = 11
EXPECTED_MULTILINE_KEYS = 24
EXPECTED_NEWLINES_PER_LOCALE = 39
MAX_SOURCE_BYTES = 256 * 1024
MAX_CELL_BYTES = 4096
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
CATALOG_OUTPUT = "src/generated/native-translations.json"
PROVENANCE_OUTPUT = "src/generated/native-translations.provenance.json"
LICENSE_OUTPUT = "public/licenses/SplatView-translations.txt"
OUTPUT_PATHS = (CATALOG_OUTPUT, LICENSE_OUTPUT, PROVENANCE_OUTPUT)
COPYRIGHT = "Copyright (c) 2026 OpsiClear LLC. All rights reserved."


@dataclass(frozen=True)
class Language:
    enum: str
    code: str
    label: str


# Exact language.cpp order. System is a preference, not a ninth translation.
LANGUAGES = (
    Language("System", "system", "System default"),
    Language("English", "en", "English"),
    Language("Spanish", "es", "Español"),
    Language("French", "fr", "Français"),
    Language("German", "de", "Deutsch"),
    Language("Portuguese", "pt", "Português"),
    Language("ChineseSimplified", "zh-Hans", "简体中文"),
    Language("Japanese", "ja", "日本語"),
    Language("Korean", "ko", "한국어"),
)

# Matches source/tests/language_contracts.cpp exactly, including literal %%.
# Exact specifier equality is stronger than comparing conversion letters alone.
PRINTF_SPECIFIER = re.compile(
    r"%[-+ #0]*[0-9]*(?:\.[0-9]+)?(?:hh|ll|[hljztL])?[diuoxXfFeEgGaAcsp%]"
)
NEWLINE_RUN = re.compile(r"\n+")
SIMPLE_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", '"': '"', "\\": "\\"}


class CatalogError(ValueError):
    """A reviewed capture, its strict grammar, or its contracts did not match."""


class TableParser:
    """Linear, nonrecursive parser for `{{"a", ..., "h"}},` rows.

    Whitespace and C++ line/block comments are accepted between tokens. Only
    ordinary double-quoted strings and a small explicit escape set are accepted.
    Raw strings, prefixes, concatenation, macros, expressions, numeric/Unicode
    escapes, escaped physical newlines and every other C++ construct are rejected.
    Expanding this subset requires review; the pinned table uses only `\\n`.
    """

    def __init__(self, source: str, expected_rows: int = EXPECTED_KEYS):
        try:
            size = len(source.encode("utf-8", errors="strict"))
        except UnicodeEncodeError as error:
            raise CatalogError("Input contains a non-Unicode surrogate") from error
        if size > MAX_SOURCE_BYTES:
            raise CatalogError("Translation table exceeds the input byte limit")
        if not 0 < expected_rows <= EXPECTED_KEYS:
            raise CatalogError("Invalid expected row bound")
        self.source = source
        self.at = 0
        self.expected_rows = expected_rows

    def fail(self, message: str) -> None:
        line = self.source.count("\n", 0, self.at) + 1
        previous = self.source.rfind("\n", 0, self.at)
        raise CatalogError(f"{message} at line {line}, column {self.at - previous}")

    def skip(self) -> None:
        while self.at < len(self.source):
            if self.source[self.at] in " \t\r\n":
                self.at += 1
            elif self.source.startswith("//", self.at):
                end = self.source.find("\n", self.at + 2)
                self.at = len(self.source) if end < 0 else end + 1
            elif self.source.startswith("/*", self.at):
                end = self.source.find("*/", self.at + 2)
                if end < 0:
                    self.fail("Unterminated block comment")
                self.at = end + 2
            else:
                return

    def consume(self, token: str) -> None:
        self.skip()
        if not self.source.startswith(token, self.at):
            self.fail(f"Expected {token!r}")
        self.at += len(token)

    def string(self) -> str:
        self.consume('"')
        characters: list[str] = []
        while self.at < len(self.source):
            character = self.source[self.at]
            self.at += 1
            if character == '"':
                value = "".join(characters)
                if len(value.encode("utf-8")) > MAX_CELL_BYTES:
                    self.fail("String exceeds the decoded byte limit")
                return value
            if ord(character) < 0x20:
                self.fail("Raw control character inside string")
            if character == "\\":
                if self.at >= len(self.source):
                    self.fail("Unterminated escape")
                escaped = self.source[self.at]
                self.at += 1
                if escaped not in SIMPLE_ESCAPES:
                    self.fail(f"Unsupported C++ escape {escaped!r}")
                character = SIMPLE_ESCAPES[escaped]
            characters.append(character)
            if len(characters) > MAX_CELL_BYTES:
                self.fail("String exceeds the character limit")
        self.fail("Unterminated string")
        raise AssertionError("unreachable")

    def parse(self) -> list[tuple[str, ...]]:
        rows: list[tuple[str, ...]] = []
        self.skip()
        while self.at < len(self.source):
            if len(rows) >= self.expected_rows:
                self.fail("Unexpected trailing input or excess rows")
            self.consume("{")
            self.consume("{")
            cells = []
            for column in range(EXPECTED_LOCALES):
                if column:
                    self.consume(",")
                cells.append(self.string())
            self.consume("}")
            self.consume("}")
            self.consume(",")
            rows.append(tuple(cells))
            self.skip()
        if len(rows) != self.expected_rows:
            self.fail(f"Expected {self.expected_rows} rows, found {len(rows)}")
        return rows


def parse_table(data: bytes, expected_rows: int = EXPECTED_KEYS) -> list[tuple[str, ...]]:
    if len(data) > MAX_SOURCE_BYTES:
        raise CatalogError("Translation table exceeds the input byte limit")
    try:
        source = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise CatalogError("Translation table is not valid UTF-8") from error
    rows = TableParser(source, expected_rows).parse()
    validate_rows(rows)
    return rows


def printf_specifiers(value: str) -> tuple[str, ...]:
    return tuple(match.group(0) for match in PRINTF_SPECIFIER.finditer(value))


def newline_signature(value: str) -> tuple[int, ...]:
    return tuple(len(match.group(0)) for match in NEWLINE_RUN.finditer(value))


def validate_rows(rows: list[tuple[str, ...]]) -> None:
    keys: set[str] = set()
    for row in rows:
        if len(row) != EXPECTED_LOCALES:
            raise CatalogError("Each row must contain exactly eight values")
        key = row[0]
        if key in keys:
            raise CatalogError(f"Duplicate English source key: {key!r}")
        keys.add(key)
        expected_formats = printf_specifiers(key)
        expected_newlines = newline_signature(key)
        for column, value in enumerate(row):
            if not value or not value.strip():
                raise CatalogError(f"Empty value in column {column} for {key!r}")
            if "\r" in value or any(ord(char) < 0x20 and char not in "\n\t" for char in value):
                raise CatalogError(f"Disallowed control character for {key!r}")
            if any(ord(char) > 0xFFFF or 0xD800 <= ord(char) <= 0xDFFF for char in value):
                raise CatalogError(f"Value exceeds native BMP font-atlas contract for {key!r}")
            if printf_specifiers(value) != expected_formats:
                raise CatalogError(f"Printf specifier sequence differs in column {column} for {key!r}")
            if newline_signature(value) != expected_newlines:
                raise CatalogError(f"Escaped newline run sequence differs in column {column} for {key!r}")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_read(path: Path, boundary: Path, limit: int) -> bytes:
    if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(boundary.resolve()):
        raise CatalogError(f"Missing or unsafe file: {path}")
    with path.open("rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise CatalogError(f"File exceeds its byte limit: {path}")
    return data


def verify_digest(data: bytes, expected: tuple[int, str], label: str) -> None:
    if (len(data), sha256(data)) != expected:
        raise CatalogError(f"Pinned capture differs: {label}")


def verify_capture(root: Path) -> tuple[dict[str, bytes], dict[str, Any]]:
    capture = root / CAPTURE_RELATIVE
    manifest_data = safe_read(capture / "CAPTURE_MANIFEST.json", capture, CAPTURE_MANIFEST[0])
    verify_digest(manifest_data, CAPTURE_MANIFEST, "CAPTURE_MANIFEST.json")
    try:
        manifest = json.loads(manifest_data.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CatalogError("Capture manifest is not valid UTF-8 JSON") from error
    if manifest.get("schemaVersion") != 1 or manifest.get("captureId") != CAPTURE_ID:
        raise CatalogError("Unsupported native capture identity/schema")
    source_root = capture / "source"
    inputs: dict[str, bytes] = {}
    for relative, expected in SOURCE_RECORDS.items():
        entries = [entry for entry in manifest.get("files", []) if entry.get("path") == relative]
        if len(entries) != 1 or (entries[0].get("bytes"), entries[0].get("sha256")) != expected:
            raise CatalogError(f"Capture manifest differs: {relative}")
        data = safe_read(source_root / relative, source_root, expected[0])
        verify_digest(data, expected, relative)
        # Validate every reviewed textual input, including the license, as UTF-8.
        try:
            data.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise CatalogError(f"Captured file is not UTF-8: {relative}") from error
        inputs[relative] = data
    verify_language_order(inputs["src/language.cpp"].decode("utf-8"))
    if COPYRIGHT not in inputs["LICENSE"].decode("utf-8"):
        raise CatalogError("Missing OpsiClear ownership notice")
    return inputs, manifest


def verify_language_order(source: str) -> None:
    declaration = "constexpr LanguageInfo languages[] = {"
    if source.count(declaration) != 1:
        raise CatalogError("Native language declaration differs")
    start = source.index(declaration) + len(declaration)
    end = source.find("};", start)
    if end < 0:
        raise CatalogError("Native language declaration is unterminated")
    parser = TableParser(source[start:end], expected_rows=len(LANGUAGES))
    for item in LANGUAGES:
        parser.consume("{")
        parser.consume("Language::" + item.enum)
        parser.consume(",")
        code = parser.string()
        parser.consume(",")
        label = parser.string()
        parser.consume("}")
        parser.consume(",")
        if (code, label) != (item.code, item.label):
            raise CatalogError("Native language enum/code/label order differs")
    parser.skip()
    if parser.at != len(parser.source):
        raise CatalogError("Unexpected native language declaration tokens")


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def build_artifacts(root: Path) -> tuple[dict[str, bytes], dict[str, Any]]:
    inputs, manifest = verify_capture(root)
    rows = parse_table(inputs["src/translations.inc"])
    format_keys = [row[0] for row in rows if printf_specifiers(row[0])]
    multiline_keys = [row[0] for row in rows if "\n" in row[0]]
    newlines = sum(row[0].count("\n") for row in rows)
    if (len(format_keys), len(multiline_keys), newlines) != (
        EXPECTED_FORMAT_KEYS, EXPECTED_MULTILINE_KEYS, EXPECTED_NEWLINES_PER_LOCALE
    ):
        raise CatalogError("Pinned format/newline census differs")
    ownership = {
        "copyright": COPYRIGHT,
        "license": "LicenseRef-OpsiClear-Proprietary",
        "notice": "Contains proprietary SplatView native translations owned by OpsiClear LLC. "
        "No MIT license or additional redistribution permission is granted by generation.",
        "licenseFile": "/licenses/SplatView-translations.txt",
        "licenseRepositoryPath": LICENSE_OUTPUT,
        "sourceLicensePath": (CAPTURE_RELATIVE / "source/LICENSE").as_posix(),
        "sourceLicenseSha256": SOURCE_RECORDS["LICENSE"][1],
    }
    source = {
        "captureId": CAPTURE_ID,
        "capturePath": CAPTURE_RELATIVE.as_posix(),
        "capturedUtc": manifest["capturedUtc"],
        "manifestSha256": CAPTURE_MANIFEST[1],
        "tablePath": "source/src/translations.inc",
        "tableSha256": SOURCE_RECORDS["src/translations.inc"][1],
    }
    catalog = {
        "schemaVersion": 1,
        "generated": "Do not edit; run python -B tools/generate-native-translations.py after reviewing the pinned capture.",
        "ownership": ownership,
        "source": source,
        "languageOptions": [{"code": item.code, "label": item.label} for item in LANGUAGES],
        "catalogs": {
            language.code: {row[0]: row[column] for row in rows}
            for column, language in enumerate(LANGUAGES[1:])
        },
    }
    census = {
        "keyCount": len(rows),
        "catalogCount": EXPECTED_LOCALES,
        "translationCellCount": len(rows) * EXPECTED_LOCALES,
        "languageOptionCount": len(LANGUAGES),
        "formatBearingKeyCount": len(format_keys),
        "multilineKeyCount": len(multiline_keys),
        "newlineCountPerCatalog": newlines,
        "totalNewlineCount": newlines * EXPECTED_LOCALES,
    }
    outputs = {
        CATALOG_OUTPUT: json_bytes(catalog),
        LICENSE_OUTPUT: inputs["LICENSE"],
    }
    provenance = {
        "schemaVersion": 1,
        "status": "Generated from the verified native capture.",
        "ownership": ownership,
        "source": source,
        "verifiedInputs": [
            {"path": relative, "bytes": record[0], "sha256": record[1]}
            for relative, record in SOURCE_RECORDS.items()
        ],
        "contracts": {
            "lookup": "Exact decoded English source key; case sensitive; unknown-key behavior belongs to runtime.",
            "columnOrder": [item.code for item in LANGUAGES[1:]],
            "system": "Preference only; no system catalog, resolve to one of the eight locales at runtime.",
            "printf": "Exact ordered native-regex specifiers, including flags, width, precision, length and %%.",
            "newlines": "Decoded LF characters preserve every cell verbatim; newline run lengths/order match English.",
            "unicode": "Strict UTF-8, no unpaired surrogates, BMP-only native font-atlas range.",
            "strings": "No trimming, case folding, normalization, browser wording, plurals or RTL additions.",
        },
        "census": census,
        "formatBearingKeys": format_keys,
        "multilineKeys": multiline_keys,
        "outputs": [
            {"path": name, "bytes": len(data), "sha256": sha256(data)}
            for name, data in outputs.items()
        ],
    }
    outputs[PROVENANCE_OUTPUT] = json_bytes(provenance)
    return outputs, census


def find_repository() -> Path:
    if (REPOSITORY_ROOT / CAPTURE_RELATIVE / "CAPTURE_MANIFEST.json").is_file():
        return REPOSITORY_ROOT
    raise CatalogError("Cannot locate the pinned capture; pass --root")


def emit(outputs: dict[str, bytes], root: Path, check: bool) -> None:
    root = root.resolve()
    if set(outputs) != set(OUTPUT_PATHS):
        raise CatalogError("Unexpected generated output paths")
    for name in outputs:
        target = root / name
        if target.is_symlink() or not target.resolve().is_relative_to(root):
            raise CatalogError(f"Unsafe generated output: {target}")
    if check:
        for name, data in outputs.items():
            target = root / name
            if not target.is_file() or safe_read(target, root, len(data)) != data:
                raise CatalogError(f"Generated native translations differ: {target}")
        return
    for name, data in outputs.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_file() or safe_read(target, root, 1024 * 1024) != data:
            target.write_bytes(data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, help="Repository containing the reviewed capture")
    parser.add_argument("--check", action="store_true", help="Verify exact bytes without writing anything")
    args = parser.parse_args()
    try:
        root = args.root.resolve() if args.root else find_repository()
        outputs, census = build_artifacts(root)
        emit(outputs, root, args.check)
    except (CatalogError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f'{"Verified" if args.check else "Generated"} native catalog: '
          f'{census["keyCount"]} exact keys, {census["catalogCount"]} catalogs, '
          f'{census["formatBearingKeyCount"]} format-bearing keys, '
          f'{census["multilineKeyCount"]} multiline keys.')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
