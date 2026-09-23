// Tests for pasted-HTML cleaning and conversion. The fixtures under
// test/fixtures/html/ are modelled on what each source puts on the clipboard.
use super::*;

const WORD: &str = include_str!("../../../test/fixtures/html/word.html");
const GDOCS: &str = include_str!("../../../test/fixtures/html/gdocs.html");
const CHATGPT: &str = include_str!("../../../test/fixtures/html/chatgpt.html");
const GITHUB: &str = include_str!("../../../test/fixtures/html/github.html");
const MERGED: &str = include_str!("../../../test/fixtures/html/merged-table.html");

fn clean(html: &str) -> String {
    clean_html(html, &HtmlOptions::default())
}

fn clean_with(html: &str, f: impl FnOnce(&mut HtmlOptions)) -> String {
    let mut o = HtmlOptions::default();
    f(&mut o);
    clean_html(html, &o)
}

fn md(html: &str) -> String {
    html_to_markdown(html, &MarkdownOptions::default())
}

// --- security: every mode, every setting --------------------------------------

#[test]
fn scripts_handlers_and_js_urls_never_survive() {
    let all = |o: &mut HtmlOptions| {
        o.styles = Styles::All;
        o.classes = true;
        o.fonts = true;
    };
    for out in [clean(GITHUB), clean_with(GITHUB, all), md(GITHUB)] {
        assert!(!out.contains("<script"), "{out}");
        assert!(!out.contains("alert(1)"), "script content must go: {out}");
        assert!(!out.contains("onerror"), "{out}");
        assert!(!out.contains("onclick"), "{out}");
        assert!(!out.contains("javascript:"), "{out}");
    }
}

#[test]
fn iframes_forms_and_embeds_are_removed() {
    let html = "<p>a</p><iframe src=\"https://x\"></iframe><form action=\"/x\"><input type=\"text\" name=\"q\"></form><object data=\"x\"></object><embed src=\"x\">";
    let out = clean_with(html, |o| o.styles = Styles::All);
    for bad in ["<iframe", "<form", "<object", "<embed", "type=\"text\""] {
        assert!(!out.contains(bad), "{bad} survived: {out}");
    }
}

#[test]
fn unsafe_styles_are_dropped_even_under_all() {
    let html = "<p style=\"position:fixed;z-index:9;background-image:url(https://t.example/x.gif);color:red;margin-top:4px\">x</p>";
    let out = clean_with(html, |o| o.styles = Styles::All);
    assert!(!out.contains("position"), "{out}");
    assert!(!out.contains("z-index"), "{out}");
    assert!(!out.contains("url("), "{out}");
    assert!(out.contains("color: red"), "{out}");
    assert!(
        out.contains("margin-top"),
        "all keeps ordinary properties: {out}"
    );

    // Fetches spelled without a plain url(: a CSS escape, image-set(), and
    // image properties. SECURITY.md promises none survive "All".
    let sneaky = "<p style=\"background-image:\\75rl(https://t.example/a.gif);list-style-image:url(x);border-image:image-set('https://t.example/b.png' 1x);mask:url(#m);color:blue\">x</p>";
    let out = clean_with(sneaky, |o| o.styles = Styles::All);
    for bad in [
        "background",
        "list-style",
        "border-image",
        "mask",
        "t.example",
        "image-set",
        "\\",
    ] {
        assert!(!out.contains(bad), "{bad} survived: {out}");
    }
    assert!(out.contains("color: blue"), "{out}");
}

#[test]
fn data_urls_are_for_images_only() {
    let html = "<a href=\"data:text/html,<script>alert(1)</script>\">x</a><img src=\"data:image/png;base64,AAAA\" alt=\"i\">";
    let out = clean(html);
    assert!(!out.contains("data:text/html"), "{out}");
    assert!(out.contains("data:image/png"), "{out}");
    let no_data = clean_with(html, |o| o.images = Images::NoData);
    assert!(
        !no_data.contains("<img"),
        "an image with its src dropped goes: {no_data}"
    );
    let none = clean_with(html, |o| o.images = Images::Off);
    assert!(!none.contains("<img"), "{none}");
}

// --- Word ------------------------------------------------------------------------

#[test]
fn word_junk_is_removed() {
    let out = clean(WORD);
    for junk in [
        "mso-",
        "MsoNormal",
        "<o:p",
        "<style",
        "<meta",
        "@font-face",
        "xmlns",
        "StartFragment",
        "supportLists",
        "Symbol",
        "Times New Roman",
    ] {
        assert!(!out.contains(junk), "{junk} survived: {out}");
    }
}

#[test]
fn word_list_paragraphs_become_nested_lists() {
    let out = clean(WORD);
    assert!(
        out.contains(
            "<ul><li>First bullet<ul><li>Nested bullet</li></ul></li><li>Second bullet</li></ul>"
        ),
        "{out}"
    );
    assert!(
        out.contains("<ol><li>Step one</li><li>Step two</li></ol>"),
        "{out}"
    );
    let m = md(WORD);
    assert!(
        m.contains("- First bullet\n  - Nested bullet\n- Second bullet"),
        "{m}"
    );
    assert!(m.contains("1. Step one\n2. Step two"), "{m}");
}

#[test]
fn word_formatting_is_kept_as_the_settings_allow() {
    let out = clean(WORD);
    assert!(out.contains("<strong>bold</strong>"), "{out}");
    assert!(out.contains("<em>italic</em>"), "{out}");
    assert!(
        out.contains("color: #C00000"),
        "colours are kept by default: {out}"
    );
    assert!(
        !out.contains("font-family"),
        "fonts are dropped by default: {out}"
    );
    let no_colors = clean_with(WORD, |o| o.colors = false);
    assert!(!no_colors.contains("#C00000"), "{no_colors}");
    let fonts = clean_with(WORD, |o| o.fonts = true);
    assert!(fonts.contains("font-family"), "{fonts}");
    let none = clean_with(WORD, |o| o.styles = Styles::Off);
    assert!(!none.contains("style="), "{none}");
    assert!(
        none.contains("<strong>bold</strong>"),
        "semantic tags survive no-styles: {none}"
    );
}

#[test]
fn table_styling_toggles() {
    let styled = clean(WORD);
    assert!(styled.contains("border: solid"), "{styled}");
    let plain = clean_with(WORD, |o| o.table_style = false);
    assert!(!plain.contains("border"), "{plain}");
    assert!(!plain.contains("width"), "{plain}");
    assert!(plain.contains("<td><p>Alice</p></td>"), "{plain}");
}

#[test]
fn word_table_becomes_a_pipe_table() {
    let m = md(WORD);
    assert!(m.contains("| **Name** | **Score** |"), "{m}");
    assert!(m.contains("| Alice    | 92        |"), "{m}");
}

// --- Google Docs ------------------------------------------------------------------

#[test]
fn google_docs_wrapper_does_not_bold_everything() {
    let out = clean(GDOCS);
    assert!(!out.contains("docs-internal-guid"), "{out}");
    assert!(
        out.starts_with("<h2"),
        "the wrapper <b> must be unwrapped: {out}"
    );
    assert!(out.contains("<strong>Decision:</strong> ship it."), "{out}");
    assert!(
        !out.contains("#000000"),
        "default black is not pinned: {out}"
    );
    assert!(
        out.contains("background-color: #ffff00"),
        "a real highlight is kept: {out}"
    );
}

#[test]
fn google_docs_styled_spans_become_markdown() {
    let m = md(GDOCS);
    assert_eq!(
        m,
        "## Meeting notes\n\n**Decision:** ship it. *Maybe* later.\n\n- Item A\n- ~~Item B~~\n\n[the doc](https://docs.google.com/document/d/abc/edit?usp=sharing)"
    );
}

// --- Chat apps -------------------------------------------------------------------

#[test]
fn katex_becomes_tex() {
    let m = md(CHATGPT);
    assert!(m.contains("The area is $\\pi r^2$ for a circle"), "{m}");
    assert!(m.contains("$$\nE = mc^2\n$$"), "{m}");
    let text = html_to_markdown(
        CHATGPT,
        &MarkdownOptions {
            math: Math::Text,
            ..Default::default()
        },
    );
    assert!(text.contains("The area is \\pi r^2 for"), "{text}");
    let out = clean(CHATGPT);
    assert!(out.contains("$\\pi r^2$"), "{out}");
    assert!(!out.contains("katex"), "{out}");
}

#[test]
fn chat_code_blocks_lose_their_chrome() {
    let m = md(CHATGPT);
    assert!(
        m.contains("```python\ndef area(r):\n    return 3.14 * r ** 2\n```"),
        "{m}"
    );
    assert!(!m.contains("Copy code"), "{m}");
    let out = clean(CHATGPT);
    assert!(!out.contains("Copy code"), "{out}");
    assert!(!out.contains("<svg"), "{out}");
}

#[test]
fn highlight_strike_and_tasks_convert() {
    let m = md(CHATGPT);
    assert!(m.contains("Mark ==this== and ~~that~~"), "{m}");
    let g = md(GITHUB);
    assert!(g.contains("- [x] Write the plan\n- [ ] Build it"), "{g}");
}

#[test]
fn del_becomes_s_for_word() {
    let out = clean(CHATGPT);
    assert!(!out.contains("<del>"), "{out}");
    assert!(out.contains("<s>that</s>"), "{out}");
}

// --- links, tables, text -----------------------------------------------------------

#[test]
fn tracking_parameters_are_removed() {
    assert_eq!(
        strip_tracking("https://x.com/p?utm_source=a&id=7&fbclid=z#top"),
        "https://x.com/p?id=7#top"
    );
    assert_eq!(
        strip_tracking("https://x.com/p?utm_source=a"),
        "https://x.com/p"
    );
    assert_eq!(strip_tracking("https://x.com/p"), "https://x.com/p");
    let kept = clean_with(WORD, |o| o.strip_tracking = false);
    assert!(kept.contains("utm_source=word"), "{kept}");
}

#[test]
fn merged_cells_keep_html_or_expand() {
    let m = md(MERGED);
    assert!(m.contains("colspan=\"2\""), "kept as HTML by default: {m}");
    let pipe = html_to_markdown(
        MERGED,
        &MarkdownOptions {
            merged_tables: MergedTables::Pipe,
            ..Default::default()
        },
    );
    assert!(pipe.contains("| Region |         | Total |"), "{pipe}");
    assert!(
        pipe.contains("|        | Central | 3     |"),
        "rowspan must not shift columns: {pipe}"
    );
}

#[test]
fn nbsp_runs_collapse_and_unicode_junk_can_go() {
    assert_eq!(collapse_nbsp("a\u{a0}\u{a0}\u{a0}b\u{a0}c"), "a b\u{a0}c");
    let out = clean_with(CHATGPT, |o| o.strip_unicode = true);
    assert!(!out.contains('\u{1F4A1}'), "{out}");
    assert_eq!(strip_unicode("a\u{200B}b\u{FE0F}c\u{202A}d"), "abcd");
}

#[test]
fn empty_paragraphs_and_trailing_breaks_go() {
    let out = clean("<p>a</p><p>&nbsp;</p><p><span></span></p><br><br>");
    assert_eq!(out, "<p>a</p>");
}

#[test]
fn classes_are_opt_in_and_never_mso() {
    let html = "<p class=\"MsoNormal lead\" id=\"x\">a</p>";
    assert_eq!(clean(html), "<p>a</p>");
    assert_eq!(
        clean_with(html, |o| o.classes = true),
        "<p id=\"x\" class=\"lead\">a</p>"
    );
}

// --- the two modes, pinned together -----------------------------------------------
// One input through both modes, so a change aimed at one shows up here if it
// leaks into the other.

#[test]
fn one_input_both_modes() {
    let html = "<p style=\"color:#C00000;font-family:Arial\" class=\"MsoNormal\" dir=\"ltr\"><span style=\"font-weight:700\">Bold</span> and <u>under</u> <del>gone</del></p>";
    assert_eq!(
        clean(html),
        "<p dir=\"ltr\" style=\"color: #C00000\"><strong>Bold</strong> and <u>under</u> <s>gone</s></p>"
    );
    assert_eq!(md(html), "**Bold** and under ~~gone~~");
}

#[test]
fn a_rowspanned_header_keeps_the_columns_aligned() {
    let html = "<table><tr><th rowspan=\"2\">H</th><th>a</th></tr><tr><td>b</td></tr></table>";
    let pipe = html_to_markdown(
        html,
        &MarkdownOptions {
            merged_tables: MergedTables::Pipe,
            ..Default::default()
        },
    );
    assert!(pipe.contains("| H | a |"), "{pipe}");
    assert!(pipe.contains("|   | b |"), "{pipe}");
}

#[test]
fn unknown_option_values_are_rejected() {
    assert!(serde_json::from_str::<HtmlOptions>(r#"{"styles":"sometimes"}"#).is_err());
    assert!(serde_json::from_str::<HtmlOptions>(r#"{"stylez":"safe"}"#).is_err());
    assert!(serde_json::from_str::<MarkdownOptions>(r#"{"mergedTables":"grid"}"#).is_err());
    let o: HtmlOptions = serde_json::from_str(r#"{"styles":"none","images":"no-data"}"#).unwrap();
    assert_eq!((o.styles, o.images), (Styles::Off, Images::NoData));
}

#[test]
fn strip_unicode_matches_the_js_pass() {
    // The same fixture test/pipeline.test.js checks stripUnicode against.
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../test/fixtures/unicode-parity.json")).unwrap();
    let input = fixture["input"].as_str().unwrap();
    let expected = fixture["expected"].as_str().unwrap();
    assert_eq!(strip_unicode(input), expected);
}

#[test]
fn defaults_match_the_frontend() {
    // HTML_DEFAULTS in src/controls.js is what the app's controls start at and
    // what the CLI sends; serde fills anything a caller leaves out from
    // HtmlOptions::default(), so the two must agree.
    let js = include_str!("../../../src/controls.js");
    let start = js
        .find("export const HTML_DEFAULTS = {")
        .expect("HTML_DEFAULTS in controls.js");
    let body = &js[start..];
    let body = &body[body.find('{').unwrap() + 1..body.find("};").unwrap()];
    let json = format!(
        "{{{}}}",
        body.split(',')
            .filter_map(|kv| {
                let (k, v) = kv.split_once(':')?;
                Some(format!("\"{}\": {}", k.trim(), v.trim()))
            })
            .collect::<Vec<_>>()
            .join(", ")
    );
    let from_js: HtmlOptions = serde_json::from_str(&json).expect(&json);
    assert_eq!(from_js, HtmlOptions::default(), "{json}");
}
