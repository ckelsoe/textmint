// Markdown -> HTML for the Rendered preview and Copy HTML.
//
// A real CommonMark parser (pulldown-cmark) replaces the hand-rolled regex
// converter the JS side used to carry. The frontend sends already-cleaned
// markdown (the non-destructive passes of src/pipeline.js `cleanToMarkdown`)
// and this renders it, so the Rendered view and Copy HTML are the same bytes:
// one source of truth for the rich paste.
//
// Two deliberate departures from a plain render:
//   1. Raw HTML never passes through as written. The result goes straight into
//      a preview div's innerHTML and onto the clipboard, so a pasted `<script>`
//      must never survive. Inline raw HTML is dropped. A raw HTML block is run
//      through a strict ammonia allowlist (table structure and inline
//      formatting, no images, no attributes beyond colspan/rowspan/href): that
//      is how a table with merged cells, kept as HTML when pasted HTML became
//      markdown, still renders. Link and image schemes are filtered too, so a
//      paste cannot make the app reach the network or run script (the CSP is
//      the hard backstop).
//   2. Strikethrough is emitted as an inline style, not `<del>`. Word's HTML
//      importer treats `<del>` as a tracked deletion and removes the text from
//      the document body; Outlook does not render it struck at all. An inline
//      style survives both. Verified 2026-09-20 against the retired JS path.

use pulldown_cmark::{html, BlockQuoteKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use std::sync::OnceLock;

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

/// Render already-cleaned markdown to HTML with the GitHub flavour, the
/// default. Pure and browser-free, so the tests below drive it directly.
pub fn render(markdown: &str) -> String {
    render_with(markdown, Flavor::Github)
}

/// The markdown dialect to render. Serde names match the frontend's values.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Flavor {
    /// Plain CommonMark: no tables, strikethrough, task lists, math.
    Commonmark,
    /// GitHub-flavored markdown, with > [!NOTE] alerts. The default.
    Github,
    /// GitHub plus Obsidian's callouts, wikilinks, ==highlight==, %%comments%%.
    Obsidian,
}

impl Flavor {
    /// Parse a CLI or JSON value; None for anything unknown.
    pub fn parse(s: &str) -> Option<Flavor> {
        match s {
            "commonmark" => Some(Flavor::Commonmark),
            "github" => Some(Flavor::Github),
            "obsidian" => Some(Flavor::Obsidian),
            _ => None,
        }
    }
}

fn options_for(flavor: Flavor) -> Options {
    let mut options = Options::empty();
    // Frontmatter is parsed as a metadata block, which the writer skips, so a
    // note's YAML header never shows up as a rule and a paragraph.
    options.insert(Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);
    if flavor != Flavor::Commonmark {
        options.insert(Options::ENABLE_TABLES);
        options.insert(Options::ENABLE_STRIKETHROUGH);
        options.insert(Options::ENABLE_TASKLISTS);
        options.insert(Options::ENABLE_FOOTNOTES);
        options.insert(Options::ENABLE_MATH);
        options.insert(Options::ENABLE_GFM); // > [!NOTE] alerts
    }
    options
}

/// The strict allowlist for a raw HTML block: structure and inline formatting,
/// nothing that loads or runs.
fn block_sanitizer() -> &'static ammonia::Builder<'static> {
    static B: OnceLock<ammonia::Builder<'static>> = OnceLock::new();
    B.get_or_init(|| {
        let mut b = ammonia::Builder::empty();
        b.tags(
            [
                "table",
                "thead",
                "tbody",
                "tfoot",
                "tr",
                "td",
                "th",
                "caption",
                "colgroup",
                "col",
                "p",
                "br",
                "strong",
                "em",
                "b",
                "i",
                "u",
                "s",
                "sub",
                "sup",
                "code",
                "pre",
                "ul",
                "ol",
                "li",
                "blockquote",
                "a",
                "mark",
            ]
            .into_iter()
            .collect(),
        )
        .tag_attributes(
            [
                ("td", ["colspan", "rowspan"].into_iter().collect()),
                ("th", ["colspan", "rowspan"].into_iter().collect()),
                ("a", ["href"].into_iter().collect()),
            ]
            .into_iter()
            .collect(),
        )
        .clean_content_tags(["script", "style"].into_iter().collect())
        .url_schemes(["http", "https", "mailto"].into_iter().collect())
        .link_rel(None)
        .strip_comments(true);
        b
    })
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
        None => String::new(),
    }
}

/// Text with Obsidian's inline extras resolved: %%comments%% removed,
/// [[target|alias]] and ![[embed]] to their display text, ==x== to <mark>.
/// Returns events; the <mark> tags are ours, added after raw HTML was filtered.
fn obsidian_inline(text: &str) -> Vec<Event<'static>> {
    let mut out = Vec::new();
    let mut plain = String::new();
    let mut rest = text;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("%%") {
            if let Some(end) = after.find("%%") {
                rest = &after[end + 2..];
                continue;
            }
        }
        let embed = rest.starts_with("![[");
        if embed || rest.starts_with("[[") {
            let start = if embed { 3 } else { 2 };
            if let Some(end) = rest[start..].find("]]") {
                let inner = &rest[start..start + end];
                if !inner.contains('\n') {
                    let shown = inner
                        .split('|')
                        .nth(1)
                        .unwrap_or(inner.split('|').next().unwrap_or(""));
                    plain.push_str(shown.trim());
                    rest = &rest[start + end + 2..];
                    continue;
                }
            }
        }
        if let Some(after) = rest.strip_prefix("==") {
            if let Some(end) = after.find("==") {
                let inner = &after[..end];
                if !inner.is_empty()
                    && !inner.starts_with(' ')
                    && !inner.ends_with(' ')
                    && !inner.contains('\n')
                {
                    if !plain.is_empty() {
                        out.push(Event::Text(CowStr::from(std::mem::take(&mut plain))));
                    }
                    out.push(Event::InlineHtml("<mark>".into()));
                    out.push(Event::Text(CowStr::from(inner.to_string())));
                    out.push(Event::InlineHtml("</mark>".into()));
                    rest = &after[end + 2..];
                    continue;
                }
            }
        }
        let ch = rest.chars().next().unwrap();
        plain.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    if !plain.is_empty() {
        out.push(Event::Text(CowStr::from(plain)));
    }
    out
}

/// `[!type] Title` at the start of a quote's first line, Obsidian style.
fn callout_marker(text: &str) -> Option<(String, String)> {
    let t = text.strip_prefix("[!")?;
    let end = t.find(']')?;
    let kind = &t[..end];
    if kind.is_empty() || !kind.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let title = t[end + 1..]
        .trim_start_matches(['+', '-'])
        .trim()
        .to_string();
    Some((kind.to_ascii_lowercase(), title))
}

fn callout_open(kind: &str, title: &str) -> String {
    let label = if title.is_empty() {
        capitalize(kind)
    } else {
        title.to_string()
    };
    format!(
        "<blockquote class=\"callout callout-{}\">\n<p class=\"callout-title\"><strong>{}</strong></p>\n",
        escape(kind),
        escape(&label)
    )
}

/// Render already-cleaned markdown to HTML for a flavor.
pub fn render_with(markdown: &str, flavor: Flavor) -> String {
    let events = sanitize_events(Parser::new_ext(markdown, options_for(flavor)));
    let events = rewrite_callouts(events, flavor == Flavor::Obsidian);

    let mut html_out = String::new();
    html::push_html(&mut html_out, events.into_iter());

    // The only `<del>` in the output is from strikethrough: raw inline HTML is
    // dropped, block HTML is sanitized without <del>, and any user angle
    // bracket is escaped to `&lt;`, so a plain replace cannot touch anything
    // else.
    html_out
        .replace("<del>", "<span style=\"text-decoration: line-through\">")
        .replace("</del>", "</span>")
}

/// Pass 1: drop inline raw HTML, sanitize raw HTML blocks, scrub URLs, and
/// coalesce adjacent text (the parser splits text at brackets, which would
/// hide a [[wikilink]] or a [!note] marker across events).
fn sanitize_events<'a>(parser: impl Iterator<Item = Event<'a>>) -> Vec<Event<'a>> {
    let mut events: Vec<Event> = Vec::new();
    let mut block_html: Option<String> = None;
    for event in parser {
        match event {
            Event::Start(Tag::HtmlBlock) => block_html = Some(String::new()),
            Event::End(TagEnd::HtmlBlock) => {
                let raw = block_html.take().unwrap_or_default();
                let clean = block_sanitizer().clean(&raw).to_string();
                if !clean.trim().is_empty() {
                    events.push(Event::Html(format!("{clean}\n").into()));
                }
            }
            Event::Html(h) => {
                if let Some(buf) = block_html.as_mut() {
                    buf.push_str(&h);
                }
            }
            Event::InlineHtml(_) => {}
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => events.push(Event::Start(Tag::Link {
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
            }) => events.push(Event::Start(Tag::Image {
                link_type,
                dest_url: sanitize_url(dest_url, true),
                title,
                id,
            })),
            Event::Text(t) => match events.last_mut() {
                Some(Event::Text(prev)) => {
                    *prev = CowStr::from(format!("{prev}{t}"));
                }
                _ => events.push(Event::Text(t)),
            },
            other => events.push(other),
        }
    }
    events
}

/// An Obsidian callout opening a quote: `> [!type] Title` as the first line of
/// its first paragraph. Returns the kind, the title, and the rest of that first
/// text event after the marker line.
fn obsidian_callout_at(events: &[Event], i: usize) -> Option<(String, String, String)> {
    let (Some(Event::Start(Tag::Paragraph)), Some(Event::Text(t))) =
        (events.get(i + 1), events.get(i + 2))
    else {
        return None;
    };
    let first = t.split('\n').next().unwrap_or("");
    let (kind, title) = callout_marker(first)?;
    Some((kind, title, t[first.len()..].trim_start().to_string()))
}

/// Pass 2: callouts (GitHub alerts in both flavors, any [!type] in Obsidian)
/// and Obsidian's inline extras. Our own tags are added here, after the
/// raw-HTML filter, so they are the only HTML that gets through.
fn rewrite_callouts(events: Vec<Event>, obsidian: bool) -> Vec<Event> {
    let mut out: Vec<Event> = Vec::with_capacity(events.len());
    let mut quotes: Vec<bool> = Vec::new(); // per open blockquote: is it a callout?
    let mut in_code = false; // fenced or indented code is never rewritten
    let mut i = 0;
    while i < events.len() {
        match &events[i] {
            Event::Start(Tag::BlockQuote(Some(kind))) => {
                let k = match kind {
                    BlockQuoteKind::Note => "note",
                    BlockQuoteKind::Tip => "tip",
                    BlockQuoteKind::Important => "important",
                    BlockQuoteKind::Warning => "warning",
                    BlockQuoteKind::Caution => "caution",
                };
                out.push(Event::Html(callout_open(k, "").into()));
                quotes.push(true);
            }
            Event::Start(Tag::BlockQuote(None)) => {
                let callout = if obsidian {
                    obsidian_callout_at(&events, i)
                } else {
                    None
                };
                let Some((kind, title, body)) = callout else {
                    quotes.push(false);
                    out.push(events[i].clone());
                    i += 1;
                    continue;
                };
                out.push(Event::Html(callout_open(&kind, &title).into()));
                quotes.push(true);
                // Skip the quote start, the paragraph start and the marker
                // text; the title line ends at a soft break.
                let mut j = i + 3;
                if body.is_empty() && matches!(events.get(j), Some(Event::SoftBreak)) {
                    j += 1;
                }
                if body.is_empty() && matches!(events.get(j), Some(Event::End(TagEnd::Paragraph))) {
                    i = j + 1; // the marker paragraph held nothing else
                    continue;
                }
                out.push(Event::Start(Tag::Paragraph));
                if !body.is_empty() {
                    out.extend(obsidian_inline(&body));
                }
                i = j;
                continue;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                if quotes.pop() == Some(true) {
                    out.push(Event::Html("</blockquote>\n".into()));
                } else {
                    out.push(events[i].clone());
                }
            }
            Event::Start(Tag::CodeBlock(_)) => {
                in_code = true;
                out.push(events[i].clone());
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code = false;
                out.push(events[i].clone());
            }
            Event::Text(t) if obsidian && !in_code => out.extend(obsidian_inline(t)),
            other => out.push(other.clone()),
        }
        i += 1;
    }
    out
}

#[tauri::command]
pub fn render_markdown(input: String, flavor: Option<Flavor>) -> String {
    render_with(&input, flavor.unwrap_or(Flavor::Github))
}

#[cfg(test)]
mod tests {
    use super::{render, render_with, Flavor};

    #[test]
    fn github_alerts_render_as_labelled_callouts() {
        let html = render("> [!NOTE]\n> Read this.");
        assert!(html.contains("class=\"callout callout-note\""), "{html}");
        assert!(html.contains("<strong>Note</strong>"), "{html}");
        assert!(html.contains("Read this."), "{html}");
        assert!(!html.contains("[!NOTE]"), "{html}");
    }

    #[test]
    fn obsidian_callouts_take_any_type_and_a_title() {
        let html = render_with("> [!question] Why so?\n> Because.", Flavor::Obsidian);
        assert!(html.contains("callout-question"), "{html}");
        assert!(html.contains("<strong>Why so?</strong>"), "{html}");
        assert!(html.contains("<p>Because.</p>"), "{html}");
        // GitHub does not know [!question]; it stays a plain quote there.
        let gh = render("> [!question] Why so?\n> Because.");
        assert!(gh.contains("<blockquote>"), "{gh}");
    }

    #[test]
    fn obsidian_inline_extras() {
        let html = render_with(
            "See [[Target Note|the note]] and [[Other]] and ==this== %%hidden%% here.",
            Flavor::Obsidian,
        );
        assert!(
            html.contains("See the note and Other and <mark>this</mark>  here."),
            "{html}"
        );
        assert!(!html.contains("[["), "{html}");
        assert!(!html.contains("hidden"), "{html}");
        // Outside Obsidian they are left as written.
        let gh = render("==this== [[Other]]");
        assert!(gh.contains("==this=="), "{gh}");
    }

    #[test]
    fn obsidian_extras_do_not_reach_into_code() {
        let html = render_with("`==x== [[y]]`\n\n```\n%%keep%%\n```", Flavor::Obsidian);
        assert!(html.contains("<code>==x== [[y]]</code>"), "{html}");
        assert!(html.contains("%%keep%%"), "{html}");
    }

    #[test]
    fn frontmatter_is_not_rendered() {
        let html = render_with("---\ntitle: Note\ntags: [a]\n---\n\nBody", Flavor::Obsidian);
        assert!(!html.contains("title:"), "{html}");
        assert!(!html.contains("<hr"), "{html}");
        assert!(html.contains("<p>Body</p>"), "{html}");
    }

    #[test]
    fn commonmark_has_no_tables_or_strikethrough() {
        let md = "| a | b |\n|---|---|\n| 1 | 2 |\n\n~~x~~";
        let cm = render_with(md, Flavor::Commonmark);
        assert!(!cm.contains("<table>"), "{cm}");
        assert!(!cm.contains("line-through"), "{cm}");
        let gh = render(md);
        assert!(gh.contains("<table>"), "{gh}");
    }

    #[test]
    fn a_merged_cell_table_kept_as_html_renders_safely() {
        let md = "<table><tr><th colspan=\"2\" onclick=\"x()\">Region</th></tr><tr><td>a</td><td>b</td></tr></table>\n\n<p>after <script>alert(1)</script></p>";
        let html = render(md);
        assert!(html.contains("<th colspan=\"2\">Region</th>"), "{html}");
        assert!(!html.contains("onclick"), "{html}");
        assert!(!html.contains("<script"), "{html}");
        assert!(
            !html.contains("alert(1)"),
            "script content goes with the tag: {html}"
        );
    }

    #[test]
    fn math_renders_as_a_marked_span() {
        let html = render("Area $\\pi r^2$ here.");
        assert!(html.contains("math-inline"), "{html}");
    }

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
