// Markdown -> HTML for the Rendered preview and Copy HTML.
//
// A real CommonMark parser (pulldown-cmark) replaces the hand-rolled regex
// converter the JS side used to carry. The frontend sends already-cleaned
// markdown (the non-destructive passes of src/pipeline.js `cleanToMarkdown`)
// and this renders it, so the Rendered view and Copy HTML are the same bytes:
// one source of truth for the rich paste.
//
// Two deliberate departures from a plain render:
//   1. Raw HTML in the input is dropped, not passed through. The result goes
//      straight into a preview div's innerHTML and onto the clipboard, so a
//      pasted `<script>` must never survive. Filtering the Html/InlineHtml
//      events before the writer is the whole sanitization; no DOM scrubber.
//      Link and image schemes are filtered too, so a paste cannot make the app
//      reach the network or run script (the CSP is the hard backstop).
//   2. Strikethrough is emitted as an inline style, not `<del>`. Word's HTML
//      importer treats `<del>` as a tracked deletion and removes the text from
//      the document body; Outlook does not render it struck at all. An inline
//      style survives both. Verified 2026-09-20 against the retired JS path.

use pulldown_cmark::{html, Event, Options, Parser, Tag};

/// Whether a link or image URL is safe to keep. Textmint promises text never
/// leaves the machine, so a pasted link or image must not be able to make the
/// app reach the network on its own or run script. Relative references are
/// kept; a real scheme must be on the allowlist. The CSP is the hard backstop
/// (it blocks remote fetches and inline script regardless); this drops the
/// dangerous URL at the source so the copied HTML carries no `javascript:` href
/// either.
fn is_safe_url(url: &str, is_image: bool) -> bool {
    match url.split_once(':') {
        None => true, // relative path or `#fragment`
        Some((prefix, _)) => {
            // A real scheme is letters/digits/+/- starting with a letter and no
            // path characters. If the part before the colon is not that shape,
            // the colon sits inside a relative reference (e.g. `a/b:c`), so keep
            // it.
            let is_scheme = !prefix.is_empty()
                && prefix
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic())
                && prefix
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-');
            if !is_scheme {
                return true;
            }
            match prefix.to_ascii_lowercase().as_str() {
                "http" | "https" | "mailto" => true,
                "data" => is_image, // inline images only, never `data:` navigation
                _ => false,         // javascript, vbscript, file, ...
            }
        }
    }
}

/// Replace an unsafe URL with an empty one, keeping its lifetime.
fn sanitize_url(url: pulldown_cmark::CowStr<'_>, is_image: bool) -> pulldown_cmark::CowStr<'_> {
    if is_safe_url(&url, is_image) {
        url
    } else {
        "".into()
    }
}

/// Render already-cleaned markdown to HTML. Pure and browser-free, so the tests
/// below drive it directly.
pub fn render(markdown: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);

    // Drop raw-HTML events so pasted markup never reaches the div's innerHTML or
    // the clipboard (push_html writes Html/InlineHtml verbatim with no escaping,
    // so removing them from the stream is the sanitization), and strip any
    // unsafe link or image scheme.
    let parser = Parser::new_ext(markdown, options).filter_map(|event| match event {
        Event::Html(_) | Event::InlineHtml(_) => None,
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => Some(Event::Start(Tag::Link {
            link_type,
            dest_url: sanitize_url(dest_url, false),
            title,
            id,
        })),
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => Some(Event::Start(Tag::Image {
            link_type,
            dest_url: sanitize_url(dest_url, true),
            title,
            id,
        })),
        other => Some(other),
    });

    let mut out = String::new();
    html::push_html(&mut out, parser);

    // The only `<del>` in the output is from strikethrough: raw HTML is already
    // dropped and any user angle bracket is escaped to `&lt;`, so a plain
    // replace cannot touch anything else.
    out.replace("<del>", "<span style=\"text-decoration: line-through\">")
        .replace("</del>", "</span>")
}

#[tauri::command]
pub fn render_markdown(input: String) -> String {
    render(&input)
}

#[cfg(test)]
mod tests {
    use super::render;

    #[test]
    fn renders_headings_lists_and_code() {
        assert!(render("# Hi").contains("<h1>Hi</h1>"));
        let list = render("- a\n- b");
        assert!(
            list.contains("<ul>") && list.contains("<li>a</li>") && list.contains("<li>b</li>")
        );
        assert!(render("```\nx\n```").contains("<pre><code>"));
    }

    #[test]
    fn pipe_tables_render_as_a_table() {
        let html = render("| a | b |\n|---|---|\n| 1 | 2 |");
        assert!(html.contains("<table>"), "{html}");
        assert!(html.contains("<th>a</th>"), "{html}");
        assert!(html.contains("<td>1</td>"), "{html}");
    }

    #[test]
    fn strikethrough_is_a_style_not_del() {
        // <del> makes Word file the text as a tracked deletion and drop it.
        let html = render("a ~~struck~~ word");
        assert!(!html.contains("<del>"), "must not emit <del>: {html}");
        assert!(
            html.contains("line-through"),
            "must strike via inline style: {html}"
        );
        assert!(html.contains("struck"), "the text must survive: {html}");
    }

    #[test]
    fn raw_html_tags_are_dropped() {
        // The tags are what matter: with them gone nothing executes. The text
        // between them survives as harmless plain text, which is fine.
        let html = render("before <script>alert(1)</script> after");
        assert!(
            !html.contains("<script"),
            "the script tag must be dropped: {html}"
        );
        assert!(!html.contains("</script>"), "{html}");
        assert!(html.contains("before") && html.contains("after"), "{html}");

        // An attribute-bearing tag is one event and goes whole, so no event
        // handler can ride in on it.
        let img = render("<img src=x onerror=\"alert(1)\">");
        assert!(
            !img.contains("onerror"),
            "the whole tag must be dropped: {img}"
        );
        assert!(!img.contains("<img"), "{img}");
    }

    #[test]
    fn underscores_inside_words_are_not_emphasis() {
        // The commonest false positive: identifiers and versioned filenames.
        let html = render("Keep snake_case and Textmint_0.1.0_aarch64 here.");
        assert!(
            !html.contains("<em>"),
            "intra-word underscores must not italicise: {html}"
        );
        assert!(html.contains("snake_case"), "{html}");
        assert!(html.contains("Textmint_0.1.0_aarch64"), "{html}");
    }

    #[test]
    fn real_emphasis_still_renders() {
        assert!(render("an _italic_ word").contains("<em>italic</em>"));
        assert!(render("a **bold** word").contains("<strong>bold</strong>"));
    }

    #[test]
    fn link_target_is_left_intact() {
        // A URL is not markdown: underscores or asterisks in it must not become
        // emphasis inside the href, which would produce a dead link.
        let html = render("[link](https://x.com/path/_to_/file)");
        assert!(
            html.contains("href=\"https://x.com/path/_to_/file\""),
            "the href must survive verbatim: {html}"
        );
        assert!(!html.contains("<em>"), "{html}");
    }

    #[test]
    fn unsafe_url_schemes_are_dropped() {
        // A pasted link or image must not run script or reach the network on its
        // own. Dangerous schemes are stripped to an empty URL; the CSP is the
        // hard backstop, this keeps the copied HTML clean too.
        let js = render("[click](javascript:alert(1))");
        assert!(
            !js.contains("javascript:"),
            "javascript: href must go: {js}"
        );
        let data_nav = render("[x](data:text/html,<h1>hi</h1>)");
        assert!(
            !data_nav.contains("data:text/html"),
            "data: navigation must go: {data_nav}"
        );

        // Safe schemes and relative references survive.
        assert!(render("[x](https://example.com)").contains("href=\"https://example.com\""));
        assert!(render("[x](mailto:a@b.com)").contains("href=\"mailto:a@b.com\""));
        assert!(render("[x](/local/path)").contains("href=\"/local/path\""));
        assert!(render("[x](./rel:with:colon)").contains("href=\"./rel:with:colon\""));
    }

    #[test]
    fn images_keep_safe_src_for_copy_but_data_nav_does_not_leak() {
        // The engine keeps http(s) and inline data: image src so Copy HTML can
        // carry the image into Word; the CSP is what stops the Rendered preview
        // fetching a remote one.
        assert!(render("![x](https://e.com/a.png)").contains("src=\"https://e.com/a.png\""));
        assert!(render("![x](data:image/png;base64,AAAA)")
            .contains("src=\"data:image/png;base64,AAAA\""));
    }

    #[test]
    fn renders_a_full_document() {
        // A corpus-shaped document end to end: the coverage the JS snapshot gave
        // the HTML path before rendering moved to Rust.
        let md = "# Title\n\nA para with **bold**, _em_, ~~gone~~ and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n> a quote\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
        let html = render(md);
        for needle in [
            "<h1>Title</h1>",
            "<strong>bold</strong>",
            "<em>em</em>",
            "line-through",
            "<code>code</code>",
            "<ul>",
            "<ol>",
            "<blockquote>",
            "<pre><code",
            "<table>",
            "<td>2</td>",
        ] {
            assert!(html.contains(needle), "missing {needle} in:\n{html}");
        }
        assert!(
            !html.contains("<del>"),
            "strikethrough must not be <del>: {html}"
        );
    }

    #[test]
    fn risky_fence_and_box_shapes_render_safely() {
        // The corpus shapes behind the 2026-09-20 fence bugs, rendered through
        // the engine now that the JS snapshot no longer pins their HTML.
        let unclosed = render("```js\nconst x = _a_;");
        assert!(
            unclosed.contains("<pre><code"),
            "unclosed fence must be code: {unclosed}"
        );
        assert!(
            unclosed.contains("_a_"),
            "code must survive verbatim: {unclosed}"
        );
        assert!(
            !unclosed.contains("<em>"),
            "code must not be emphasised: {unclosed}"
        );

        let indented = render("- item:\n\n  ```js\n  const y = snake_case_x;\n  ```");
        assert!(
            indented.contains("<pre><code"),
            "indented fence must be code: {indented}"
        );
        assert!(
            indented.contains("const y = snake_case_x;"),
            "code must survive: {indented}"
        );

        // cleanToMarkdown fences a box diagram, so the engine sees it fenced and
        // keeps its alignment as <pre> (the 2026-09-20 fix, carried across the
        // move of rendering into Rust).
        let box_art =
            render("```\n\u{250C}\u{2500}\u{2500}\u{2510}\n\u{2502} a \u{2502}\n\u{2514}\u{2500}\u{2500}\u{2518}\n```");
        assert!(
            box_art.contains("<pre>"),
            "a fenced box must be <pre>: {box_art}"
        );
        assert!(
            box_art.contains('\u{250C}'),
            "box characters must survive: {box_art}"
        );
    }

    #[test]
    fn snapshot_markdown_renders_without_leaks() {
        // The seam test. Every cleanToMarkdown output the JS snapshot pins is
        // rendered through this engine and checked for the corruptions the two
        // halves could otherwise hide from each other: a fence or diagram that
        // leaked its ``` as text, a masking sentinel that survived, or a block
        // the JS side shaped for a parse this side did not actually give it.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/snapshots.json");
        let raw = std::fs::read_to_string(path).expect("read test/snapshots.json");
        let snaps: serde_json::Value = serde_json::from_str(&raw).expect("parse snapshots.json");
        let mut checked = 0;
        for (_name, sets) in snaps.as_object().expect("top-level object") {
            for (_set, entry) in sets.as_object().expect("per-input object") {
                let md = entry["markdown"].as_str().expect("markdown field");
                let html = render(md);
                assert!(
                    !html.contains("```"),
                    "fence markers leaked into HTML for:\n{md}\n=>\n{html}"
                );
                assert!(
                    !html.chars().any(|c| ('\u{E000}'..='\u{E00F}').contains(&c)),
                    "a masking sentinel survived for:\n{md}\n=>\n{html}"
                );
                checked += 1;
            }
        }
        assert!(
            checked >= 100,
            "expected the corpus grid, only checked {checked}"
        );
    }

    #[test]
    fn empty_input_renders_empty() {
        assert_eq!(render("").trim(), "");
    }
}
