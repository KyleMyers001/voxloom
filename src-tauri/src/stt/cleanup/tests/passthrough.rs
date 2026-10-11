//! Review blocker on #32: text is only touched where a tag was removed.

use super::*;

/// Tag-free inputs that must come back byte-identical, loud or quiet.
const UNTOUCHED: &[&str] = &[
    "call foo() and bar[] please",
    "let v = vec![1, 2]; f(x)[0]",
    ":) nice",
    ":( sad ;) wink",
    "... and then",
    "...",
    "first line\n\nsecond line\n\n\nthird",
    "two  spaces  kept",
    "  leading and trailing  ",
    "tab\tseparated\tvalues",
    "a , b . c",
    ", starts with a comma",
    "Hello ,world!!",
    "Use *really* bold, (maybe) [sic].",
    "x * y * z",
    "2 * 3 = 6",
    "",
];

#[test]
fn tag_free_text_is_byte_identical() {
    for s in UNTOUCHED {
        assert_eq!(loud(s), *s, "loud {s:?}");
        let q = quiet(s);
        assert_eq!(q.text, *s, "quiet {s:?}");
        assert_eq!(q.dropped, None, "quiet {s:?}");
    }
}

#[test]
fn tag_next_to_code_only_loses_the_tag() {
    assert_eq!(
        loud("call foo() [Music] and bar[] please"),
        "call foo() and bar[] please"
    );
    assert_eq!(loud("f(x)[NOISE] g[]"), "f(x) g[]");
    assert_eq!(loud(":) [laughs] nice"), ":) nice");
}

#[test]
fn tag_next_to_newlines_only_loses_the_tag() {
    assert_eq!(loud("line one\n[Music]\nline two"), "line one\n\nline two");
    assert_eq!(loud("line one [Music]\n\nline two"), "line one\n\nline two");
    assert_eq!(
        loud("line one\n\n(coughs) line two"),
        "line one\n\nline two"
    );
}

#[test]
fn unrelated_formatting_survives_a_removal_elsewhere() {
    assert_eq!(
        loud("... so  then,\n\nfoo() [Music] bar"),
        "... so  then,\n\nfoo() bar"
    );
    assert_eq!(loud("a  b [NOISE] c"), "a  b c");
}
