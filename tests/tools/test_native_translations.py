"""Pure parser and pinned-capture checks for generated native translations."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_translation_generator", ROOT / "tools/generate-native-translations.py"
)
assert SPEC is not None and SPEC.loader is not None
generator = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = generator
SPEC.loader.exec_module(generator)


def table(*rows: tuple[str, ...]) -> bytes:
    return ("\n".join("{{" + ", ".join(json.dumps(cell, ensure_ascii=False) for cell in row) + "}},"
                      for row in rows) + "\n").encode("utf-8")


class NativeTranslationParserTests(unittest.TestCase):
    def parse(self, data: bytes, count: int = 1) -> list[tuple[str, ...]]:
        return generator.parse_table(data, expected_rows=count)

    def test_verbatim_unicode_quotes_backslashes_and_newlines(self) -> None:
        row = ('Line "one"\\path\nLine two',) * 8
        data = b"// heading\n/* block */\n" + table(row) + b"// tail"
        self.assertEqual(self.parse(data), [row])

    def test_rejects_invalid_utf8_and_bom(self) -> None:
        for data in (b"\xff", b"\xef\xbb\xbf" + table(("a",) * 8)):
            with self.subTest(data=data[:4]), self.assertRaises(generator.CatalogError):
                self.parse(data)

    def test_requires_exact_number_of_rows_and_columns(self) -> None:
        for data in (b"", table(("a",) * 7), table(("a",) * 9), table(("a",) * 8, ("b",) * 8)):
            with self.subTest(data=data[:40]), self.assertRaises(generator.CatalogError):
                self.parse(data)

    def test_rejects_every_truncated_prefix(self) -> None:
        data = table(("a",) * 8).rstrip()
        for end in range(len(data)):
            with self.subTest(end=end), self.assertRaises(generator.CatalogError):
                self.parse(data[:end])

    def test_rejects_expressions_concatenation_prefixes_and_trailing_code(self) -> None:
        good = table(("a",) * 8)
        samples = (
            good.replace(b'"a"', b'"a" "b"', 1),
            good.replace(b'"a"', b'u8"a"', 1),
            good.replace(b'"a"', b'R"(a)"', 1),
            good.replace(b'"a"', b'CALL()', 1),
            good + b"danger()",
            good + b"/* unterminated",
            b"#include <anything>\n" + good,
        )
        for data in samples:
            with self.subTest(data=data[:40]), self.assertRaises(generator.CatalogError):
                self.parse(data)

    def test_duplicate_source_keys_rejected_and_case_retained(self) -> None:
        with self.assertRaisesRegex(generator.CatalogError, "Duplicate"):
            self.parse(table(("key",) * 8, ("key",) * 8), count=2)
        result = self.parse(table(("key",) * 8, ("Key",) * 8), count=2)
        self.assertEqual([row[0] for row in result], ["key", "Key"])

    def test_empty_and_whitespace_only_values_rejected(self) -> None:
        for blank in ("", " ", "\t", "\n"):
            with self.subTest(blank=blank), self.assertRaises(generator.CatalogError):
                self.parse(table(("key", blank) + ("value",) * 6))

    def test_format_type_order_flags_precision_and_escaped_percent(self) -> None:
        source = "%s %.1f%% %zu %u"
        self.assertEqual(self.parse(table((source,) * 8))[0][0], source)
        for changed in ("%u %.1f%% %zu %s", "%s %.2f%% %zu %u", "%s %.1f %zu %u", "%s %.1f%% %u %u"):
            with self.subTest(changed=changed), self.assertRaisesRegex(generator.CatalogError, "Printf"):
                self.parse(table((source, changed) + (source,) * 6))

    def test_percent_prose_is_not_a_format_placeholder(self) -> None:
        row = ("0.01%–100%. Exact matching: 0%.",) * 8
        self.assertEqual(generator.printf_specifiers(row[0]), ())
        self.assertEqual(self.parse(table(row)), [row])

    def test_newline_count_and_run_order_are_preserved(self) -> None:
        source = "a\n\nb\nc"
        for changed in ("a\nb\nc", "a\nb\n\nc", "a\\nb\\nc"):
            with self.subTest(changed=changed), self.assertRaisesRegex(generator.CatalogError, "newline"):
                self.parse(table((source, changed) + (source,) * 6))

    def test_rejects_raw_controls_unsupported_escapes_and_non_bmp(self) -> None:
        good = table(("a",) * 8)
        for replacement in (b'"raw\nline"', b'"\\x41"', b'"\\u0041"', b'"\\0"', b'"\\q"', b'"\\\n"'):
            with self.subTest(replacement=replacement), self.assertRaises(generator.CatalogError):
                self.parse(good.replace(b'"a"', replacement, 1))
        for value in ("\r", "\x00", "\U0001f642"):
            with self.subTest(value=ascii(value)), self.assertRaises(generator.CatalogError):
                self.parse(table((value,) * 8))
        with self.assertRaises(generator.CatalogError):
            generator.TableParser("\ud800")

    def test_enforces_input_and_string_bounds(self) -> None:
        with self.assertRaises(generator.CatalogError):
            self.parse(b" " * (generator.MAX_SOURCE_BYTES + 1))
        with self.assertRaises(generator.CatalogError):
            self.parse(table(("a" * (generator.MAX_CELL_BYTES + 1),) * 8))
        with self.assertRaises(generator.CatalogError):
            self.parse(table(("界" * (generator.MAX_CELL_BYTES // 3 + 1),) * 8))

    def test_language_order_changes_rejected(self) -> None:
        source = "constexpr LanguageInfo languages[] = {" + "".join(
            f'{{Language::{item.enum}, "{item.code}", "{item.label}"}},' for item in generator.LANGUAGES
        ) + "};"
        generator.verify_language_order(source)
        with self.assertRaises(generator.CatalogError):
            generator.verify_language_order(source.replace('"es"', '"mx"'))
        with self.assertRaises(generator.CatalogError):
            generator.verify_language_order(source.replace('"System default"', '"Systemdefault"'))

    def test_source_digest_size_and_content_are_both_pinned(self) -> None:
        generator.verify_digest(b"source", (6, generator.sha256(b"source")), "test")
        for data, expected in ((b"source", (5, generator.sha256(b"source"))),
                               (b"Source", (6, generator.sha256(b"source")))):
            with self.subTest(data=data), self.assertRaisesRegex(generator.CatalogError, "Pinned"):
                generator.verify_digest(data, expected, "test")

    def test_rejects_unexpected_output_paths(self) -> None:
        with self.assertRaisesRegex(generator.CatalogError, "Unexpected generated output"):
            generator.emit({"../unowned.json": b""}, ROOT, check=True)

    def test_pinned_capture_and_deterministic_artifacts(self) -> None:
        root = generator.find_repository()
        first, census = generator.build_artifacts(root)
        second, second_census = generator.build_artifacts(root)
        self.assertEqual(first, second)
        self.assertEqual(census, second_census)
        self.assertEqual(census, {
            "keyCount": 592, "catalogCount": 8, "translationCellCount": 4736,
            "languageOptionCount": 9, "formatBearingKeyCount": 11, "multilineKeyCount": 24,
            "newlineCountPerCatalog": 39, "totalNewlineCount": 312,
        })
        catalog = json.loads(first[generator.CATALOG_OUTPUT])
        self.assertEqual(list(catalog["catalogs"]), [item.code for item in generator.LANGUAGES[1:]])
        for code, values in catalog["catalogs"].items():
            self.assertEqual(len(values), 592, code)
        self.assertTrue(all(key == value for key, value in catalog["catalogs"]["en"].items()))
        self.assertEqual(catalog["catalogs"]["zh-Hans"]["Settings"], "设置")
        self.assertEqual(generator.sha256(first[generator.LICENSE_OUTPUT]), generator.SOURCE_RECORDS["LICENSE"][1])


if __name__ == "__main__":
    unittest.main()
