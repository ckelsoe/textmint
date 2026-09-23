// Pasted HTML: clean it while keeping its formatting, or convert it to markdown.
//
// Rich pastes (Word, Outlook, Google Docs, chat apps, web pages) arrive as HTML
// on the clipboard. The frontend holds that HTML and calls in here twice:
//   - html_to_markdown: the markdown that goes into the input box, so the Text
//     and Markdown outputs keep headings, lists, bold and tables.
//   - clean_html: the HTML output in "Clean HTML" mode, which keeps the source's
//     formatting and drops the junk. See docs/plans/html-input.md.
//
// Both run the same three stages:
//   1. prepare (html5ever DOM): rewrite source quirks that only make sense
//      before sanitizing. Word's fake list bullets, KaTeX math, the Google Docs
//      wrapper, and <font>.
//   2. sanitize (ammonia): the security boundary. Only allowlisted tags and
//      attributes survive, comments go, and URLs are scheme-checked. Nothing
//      after this stage adds markup from the input, only removes or renames.
//   3. tidy (html5ever DOM): the settings. Style filtering, Word lists to real
//      lists, tracking parameters, empty-element cleanup, Unicode junk.
//
// The DOM crates are pinned to the html5ever version htmd uses, so there is one
// parser copy for both. ammonia carries its own, which it needs internally.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::OnceLock;

use html5ever::serialize::{SerializeOpts, TraversalScope};
use html5ever::tendril::TendrilSink;
use html5ever::{ns, parse_document, serialize, Attribute, LocalName, ParseOpts, QualName};
use markup5ever_rcdom::{Handle, Node, NodeData, RcDom, SerializableHandle};
use serde::Deserialize;

// --- Options --------------------------------------------------------------

/// Which inline styles Clean HTML keeps.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Styles {
    /// Formatting only: weight, style, decoration, alignment, colors.
    Safe,
    /// Everything but the unsafe list.
    All,
    /// No styles at all.
    #[serde(rename = "none")]
    Off,
}

/// What Clean HTML does with images.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Images {
    Keep,
    /// Drop embedded data: images, keep linked ones.
    NoData,
    #[serde(rename = "none")]
    Off,
}

/// How KaTeX math is written in markdown.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Math {
    /// $...$ and $$...$$.
    Dollar,
    /// The bare TeX.
    Text,
}

/// What markdown does with a table that has merged cells.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MergedTables {
    /// Keep the table as HTML inside the markdown.
    Html,
    /// Force a pipe table, splitting merged cells into a grid.
    Pipe,
}

/// Settings for Clean HTML mode. Field names match the frontend's JSON, and an
/// unknown value is rejected here rather than quietly degrading the output.
/// The defaults must equal HTML_DEFAULTS in src/controls.js; a test reads that
/// file and compares.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct HtmlOptions {
    pub styles: Styles,
    /// Keep font-family and font-size.
    pub fonts: bool,
    /// Keep color and background-color.
    pub colors: bool,
    /// Keep class and id attributes (Word's Mso* classes are dropped anyway).
    pub classes: bool,
    /// Keep table borders, padding and widths; off keeps structure only.
    pub table_style: bool,
    pub images: Images,
    /// Remove utm_* and similar tracking parameters from links.
    pub strip_tracking: bool,
    /// b/i to strong/em, drop empty elements, unwrap bare spans.
    pub tidy: bool,
    /// Run the Unicode junk pass over text nodes.
    pub strip_unicode: bool,
}

impl Default for HtmlOptions {
    fn default() -> Self {
        HtmlOptions {
            styles: Styles::Safe,
            fonts: false,
            colors: true,
            classes: false,
            table_style: true,
            images: Images::Keep,
            strip_tracking: true,
            tidy: true,
            strip_unicode: false,
        }
    }
}

/// Settings for HTML to markdown. The rest of the markdown style (bullets,
/// emphasis, headings) is applied by the frontend's restyle pass, so it covers
/// typed markdown too.
#[derive(Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkdownOptions {
    pub math: Math,
    pub merged_tables: MergedTables,
}

impl Default for MarkdownOptions {
    fn default() -> Self {
        MarkdownOptions {
            math: Math::Dollar,
            merged_tables: MergedTables::Html,
        }
    }
}

// --- DOM helpers ------------------------------------------------------------

fn parse(html: &str) -> Handle {
    parse_document(RcDom::default(), ParseOpts::default())
        .one(html)
        .document
}

fn qual(local: &str) -> QualName {
    QualName::new(None, ns!(html), LocalName::from(local))
}

fn tag(node: &Handle) -> Option<String> {
    match &node.data {
        NodeData::Element { name, .. } => Some(name.local.to_string()),
        _ => None,
    }
}

fn attr(node: &Handle, key: &str) -> Option<String> {
    match &node.data {
        NodeData::Element { attrs, .. } => attrs
            .borrow()
            .iter()
            .find(|a| a.name.local.as_ref() == key)
            .map(|a| a.value.to_string()),
        _ => None,
    }
}

fn set_attr(node: &Handle, key: &str, value: Option<&str>) {
    if let NodeData::Element { attrs, .. } = &node.data {
        let mut attrs = attrs.borrow_mut();
        attrs.retain(|a| a.name.local.as_ref() != key);
        if let Some(v) = value {
            attrs.push(Attribute {
                name: QualName::new(None, ns!(), LocalName::from(key)),
                value: v.into(),
            });
        }
    }
}

fn has_class(node: &Handle, class: &str) -> bool {
    attr(node, "class").is_some_and(|c| c.split_whitespace().any(|x| x == class))
}

fn new_element(local: &str, attrs: Vec<(&str, &str)>) -> Handle {
    Node::new(NodeData::Element {
        name: qual(local),
        attrs: RefCell::new(
            attrs
                .into_iter()
                .map(|(k, v)| Attribute {
                    name: QualName::new(None, ns!(), LocalName::from(k)),
                    value: v.into(),
                })
                .collect(),
        ),
        template_contents: RefCell::new(None),
        mathml_annotation_xml_integration_point: false,
    })
}

fn new_text(text: &str) -> Handle {
    Node::new(NodeData::Text {
        contents: RefCell::new(text.into()),
    })
}

fn append(parent: &Handle, child: Handle) {
    child.parent.set(Some(Rc::downgrade(parent)));
    parent.children.borrow_mut().push(child);
}

/// Replace `children` of `parent` wholesale, fixing each child's parent link.
fn set_children(parent: &Handle, children: Vec<Handle>) {
    for c in &children {
        c.parent.set(Some(Rc::downgrade(parent)));
    }
    *parent.children.borrow_mut() = children;
}

fn take_children(node: &Handle) -> Vec<Handle> {
    std::mem::take(&mut *node.children.borrow_mut())
}

/// All text under a node, in order.
fn text_of(node: &Handle) -> String {
    let mut out = String::new();
    fn walk(n: &Handle, out: &mut String) {
        if let NodeData::Text { contents } = &n.data {
            out.push_str(&contents.borrow());
        }
        for c in n.children.borrow().iter() {
            walk(c, out);
        }
    }
    walk(node, &mut out);
    out
}

fn find_first(node: &Handle, pred: &dyn Fn(&Handle) -> bool) -> Option<Handle> {
    for c in node.children.borrow().iter() {
        if pred(c) {
            return Some(c.clone());
        }
        if let Some(f) = find_first(c, pred) {
            return Some(f);
        }
    }
    None
}

fn body_of(doc: &Handle) -> Option<Handle> {
    find_first(doc, &|n| tag(n).as_deref() == Some("body"))
}

/// Serialize the body's children (the fragment), not the document shell.
fn serialize_body(doc: &Handle) -> String {
    let Some(body) = body_of(doc) else {
        return String::new();
    };
    let mut out = Vec::new();
    let opts = SerializeOpts {
        traversal_scope: TraversalScope::ChildrenOnly(None),
        ..Default::default()
    };
    let handle: SerializableHandle = body.into();
    if serialize(&mut out, &handle, opts).is_err() {
        return String::new();
    }
    String::from_utf8(out).unwrap_or_default()
}

// --- Stage 1: prepare -------------------------------------------------------

/// Rewrite source quirks that the sanitizer would otherwise destroy.
fn prepare(html: &str) -> String {
    let doc = parse(html);
    if let Some(body) = body_of(&doc) {
        prepare_node(&body);
    }
    serialize_body(&doc)
}

fn prepare_node(node: &Handle) {
    let old = take_children(node);
    let mut out: Vec<Handle> = Vec::with_capacity(old.len());
    let mut iter = old.into_iter();
    while let Some(child) = iter.next() {
        if let NodeData::Comment { contents } = &child.data {
            if contents.trim() == "[if !supportLists]" {
                out.push(wrap_word_bullet(&mut iter));
            }
            continue; // every other comment goes (conditional XML, fragments)
        }
        // Each source quirk either replaces the node or leaves it be.
        let replaced = match tag(&child).as_deref() {
            Some("span") => katex_to_tex(&child),
            Some("b") => unwrap_google_docs(&child),
            Some("pre") => chat_code_block(&child),
            Some("font") => font_to_span(&child),
            _ => None,
        };
        match replaced {
            Some(nodes) => out.extend(nodes),
            None => {
                prepare_node(&child);
                out.push(child);
            }
        }
    }
    set_children(node, out);
}

/// Word's fake list bullet: <![if !supportLists]> glyph <![endif]>. The markers
/// parse as comments. Wrap what sits between them so the tidy stage can read
/// the glyph (ordered or not) and then drop it.
fn wrap_word_bullet(rest: &mut impl Iterator<Item = Handle>) -> Handle {
    let wrap = new_element("span", vec![("data-tm-bullet", "1")]);
    for next in rest.by_ref() {
        if matches!(&next.data, NodeData::Comment { contents } if contents.trim() == "[endif]") {
            break;
        }
        append(&wrap, next);
    }
    wrap
}

/// KaTeX (ChatGPT, Claude, Gemini): the TeX source sits in a MathML
/// <annotation>; the visible part is dozens of styled spans that mean nothing
/// without KaTeX's CSS. Keep the TeX, marked inline or display.
fn katex_to_tex(span: &Handle) -> Option<Vec<Handle>> {
    let display = has_class(span, "katex-display");
    if !display && !has_class(span, "katex") {
        return None;
    }
    let annotation = find_first(span, &|n| {
        tag(n).as_deref() == Some("annotation")
            && attr(n, "encoding").as_deref() == Some("application/x-tex")
    })?;
    let m = new_element(
        "span",
        vec![("data-tm-math", if display { "display" } else { "inline" })],
    );
    append(&m, new_text(text_of(&annotation).trim()));
    Some(vec![m])
}

/// Google Docs wraps the whole paste in <b style="font-weight:normal"
/// id="docs-internal-guid-...">. Kept, it would make everything bold.
fn unwrap_google_docs(b: &Handle) -> Option<Vec<Handle>> {
    if !attr(b, "id").is_some_and(|i| i.starts_with("docs-internal-guid")) {
        return None;
    }
    prepare_node(b);
    Some(take_children(b))
}

/// Chat apps put a language label, a "Copy code" button and wrapper divs inside
/// <pre>. Keep only the code text, and the language.
fn chat_code_block(pre: &Handle) -> Option<Vec<Handle>> {
    let code = find_first(pre, &|n| tag(n).as_deref() == Some("code"));
    let lang = code
        .as_ref()
        .and_then(|c| attr(c, "class"))
        .and_then(|c| {
            c.split_whitespace()
                .find_map(|x| x.strip_prefix("language-").map(str::to_string))
        })
        .unwrap_or_default();
    let text = text_of(code.as_ref().unwrap_or(pre));
    let out = new_element("pre", vec![]);
    let code_el = if lang.is_empty() {
        new_element("code", vec![])
    } else {
        new_element("code", vec![("data-tm-lang", lang.as_str())])
    };
    append(&code_el, new_text(&text));
    append(&out, code_el);
    Some(vec![out])
}

/// <font color face> is obsolete and the sanitizer drops it; carry its meaning
/// over as a styled span so the tidy stage can keep or drop it.
fn font_to_span(font: &Handle) -> Option<Vec<Handle>> {
    let mut style = String::new();
    if let Some(c) = attr(font, "color") {
        style.push_str(&format!("color:{c};"));
    }
    if let Some(f) = attr(font, "face") {
        style.push_str(&format!("font-family:{f};"));
    }
    let span = new_element("span", vec![("style", style.as_str())]);
    prepare_node(font);
    set_children(&span, take_children(font));
    Some(vec![span])
}

// --- Stage 2: sanitize ------------------------------------------------------

const TAGS: &[&str] = &[
    "a",
    "abbr",
    "b",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "input",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "q",
    "s",
    "small",
    "span",
    "strike",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
];

fn sanitize(html: &str, images: Images, classes: bool) -> String {
    let mut tags: HashSet<&str> = TAGS.iter().copied().collect();
    if images == Images::Off {
        tags.remove("img");
    }
    let mut generic: HashSet<&str> = ["style", "title", "dir"].into_iter().collect();
    if classes {
        generic.insert("class");
        generic.insert("id");
    }
    let mut per_tag: HashMap<&str, HashSet<&str>> = HashMap::new();
    let mut allow = |t: &'static str, a: &[&'static str]| {
        per_tag.insert(t, a.iter().copied().collect());
    };
    allow("a", &["href"]);
    allow("img", &["src", "alt", "width", "height"]);
    allow("td", &["colspan", "rowspan", "align", "valign", "width"]);
    allow(
        "th",
        &["colspan", "rowspan", "align", "valign", "width", "scope"],
    );
    allow("table", &["border", "cellpadding", "cellspacing", "width"]);
    allow("col", &["span", "width"]);
    allow("colgroup", &["span"]);
    allow("ol", &["start", "type", "reversed"]);
    allow("li", &["value"]);
    allow("span", &["data-tm-bullet", "data-tm-math"]);
    allow("code", &["data-tm-lang"]);
    allow("input", &["type", "checked", "disabled"]);

    ammonia::Builder::default()
        .tags(tags)
        .clean_content_tags(
            [
                "script", "style", "title", "noscript", "template", "textarea", "select", "button",
                "svg",
            ]
            .into_iter()
            .collect(),
        )
        .generic_attributes(generic)
        .tag_attributes(per_tag)
        .url_schemes(["http", "https", "mailto", "data"].into_iter().collect())
        .link_rel(None)
        .strip_comments(true)
        .attribute_filter(move |element, attribute, value| {
            let is_data = value.trim_start().to_ascii_lowercase().starts_with("data:");
            match (element, attribute) {
                // data: is for inline images only, never a link target.
                ("img", "src") if is_data && images == Images::NoData => None,
                ("img", "src") => Some(Cow::Borrowed(value)),
                (_, "href") if is_data => None,
                _ => Some(Cow::Borrowed(value)),
            }
        })
        .clean(html)
        .to_string()
}

// --- Stage 3: tidy ----------------------------------------------------------

const TABLE_TAGS: &[&str] = &[
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "col", "colgroup", "caption",
];
const SAFE_PROPS: &[&str] = &[
    "font-weight",
    "font-style",
    "text-decoration",
    "text-decoration-line",
    "text-align",
    "vertical-align",
    "list-style-type",
];
const COLOR_PROPS: &[&str] = &["color", "background-color"];
const FONT_PROPS: &[&str] = &["font-family", "font-size"];
const TABLE_PROPS: &[&str] = &[
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border-collapse",
    "border-spacing",
    "border-color",
    "border-width",
    "border-style",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "width",
    "height",
];
// Dropped even under "all": they can lay content over the page or fetch.
const UNSAFE_PROPS: &[&str] = &[
    "position",
    "z-index",
    "top",
    "left",
    "right",
    "bottom",
    "behavior",
    "-moz-binding",
    "content",
    "cursor",
    "pointer-events",
    "background",
    "mask",
    "filter",
    "src",
    "list-style",
    "border-image",
    "shape-outside",
    "offset-path",
    "clip-path",
];
/// The no-fetch guarantee docs/SECURITY.md makes for Clean HTML: true for any
/// style that could load content or overlay the page, however it is spelled.
/// Every Styles mode runs this first. A backslash is refused outright, since a
/// CSS escape (\\75rl) would slip a url( past a substring check; image-set()
/// fetches without url(, and any *image property or the unsafe list can take
/// one. `lower_value` is the value lowercased.
fn can_fetch(prop: &str, lower_value: &str) -> bool {
    prop.starts_with("mso-")
        || prop.starts_with('-')
        || prop.contains("image")
        || UNSAFE_PROPS.contains(&prop)
        || lower_value.contains('\\')
        || lower_value.contains("url(")
        || lower_value.contains("image-set")
        || lower_value.contains("expression(")
        || lower_value.contains("javascript:")
        || lower_value.contains("@import")
}

const TRACKING: &[&str] = &[
    "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid", "yclid", "_hsenc",
    "_hsmi", "ref_src",
];

/// What the tidy stage is producing.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Clean HTML: keep formatting as the options allow.
    Html,
    /// Input for htmd: semantic tags only, no attributes it does not read.
    Markdown,
}

struct Tidy<'a> {
    o: &'a HtmlOptions,
    mode: Mode,
    /// Markdown with pipe tables forced: merged cells are split out, or the
    /// columns after them shift.
    expand_spans: bool,
}

fn decls(style: &str) -> Vec<(String, String)> {
    style
        .split(';')
        .filter_map(|d| {
            let (k, v) = d.split_once(':')?;
            let k = k.trim().to_ascii_lowercase();
            let v = v.trim().to_string();
            (!k.is_empty() && !v.is_empty()).then_some((k, v))
        })
        .collect()
}

impl Tidy<'_> {
    fn keep_prop(&self, element: &str, prop: &str, value: &str) -> bool {
        let lv = value.to_ascii_lowercase();
        // The security gate comes first and nothing above it may return true.
        if can_fetch(prop, &lv) {
            return false;
        }
        // Values that restate the default: Google Docs writes all of them on
        // every span, and keeping them pins black text in a dark-mode email.
        let default = match prop {
            "color" => matches!(
                lv.replace(' ', "").as_str(),
                "#000" | "#000000" | "black" | "windowtext" | "rgb(0,0,0)"
            ),
            "background-color" => lv == "transparent",
            "text-decoration" | "text-decoration-line" => lv == "none",
            "vertical-align" => lv == "baseline",
            "text-align" => lv == "left" || lv == "start",
            "font-style" => lv == "normal",
            "font-weight" => lv == "normal" || lv == "400",
            _ => false,
        };
        if default {
            return false;
        }
        let styles_on = self.o.styles != Styles::Off;
        if FONT_PROPS.contains(&prop) {
            return self.o.fonts && styles_on;
        }
        if COLOR_PROPS.contains(&prop) {
            return self.o.colors && styles_on;
        }
        let is_table = TABLE_TAGS.contains(&element);
        if TABLE_PROPS.contains(&prop) && is_table {
            return self.o.table_style && styles_on;
        }
        match self.o.styles {
            Styles::All => true,
            Styles::Safe => SAFE_PROPS.contains(&prop),
            Styles::Off => false,
        }
    }

    fn filter_style(&self, node: &Handle, element: &str) {
        let Some(style) = attr(node, "style") else {
            return;
        };
        let kept: Vec<String> = decls(&style)
            .into_iter()
            .filter(|(k, v)| self.keep_prop(element, k, v))
            .map(|(k, v)| format!("{k}: {v}"))
            .collect();
        if kept.is_empty() {
            set_attr(node, "style", None);
        } else {
            set_attr(node, "style", Some(&kept.join("; ")));
        }
    }

    /// Visit a node's children and return the replacement list for them.
    fn children(&self, node: &Handle) {
        let old = take_children(node);
        let mut out = Vec::with_capacity(old.len());
        for child in old {
            out.extend(self.node(child));
        }
        set_children(node, out);
        self.word_lists(node);
    }

    /// Returns what replaces `node`: itself, its children, or nothing. Shared
    /// normalization first, then exactly one mode's finisher.
    fn node(&self, node: Handle) -> Vec<Handle> {
        if let NodeData::Text { contents } = &node.data {
            let mut t = contents.borrow().to_string();
            // Word pads with runs of non-breaking spaces; one is kept as a real
            // space, since a lone one is usually deliberate.
            if t.contains("\u{a0}\u{a0}") {
                t = collapse_nbsp(&t);
            }
            if self.o.strip_unicode {
                t = strip_unicode(&t);
            }
            *contents.borrow_mut() = t.into();
            return vec![node];
        }
        let Some(t) = tag(&node) else {
            return vec![]; // comments and anything else non-element
        };

        // Recurse first, so a parent sees its final children.
        self.children(&node);

        let node = match self.normalize(node, &t) {
            Ok(node) => node,
            Err(done) => return done,
        };
        let t = tag(&node).unwrap_or_default();
        // A Word list paragraph's style is still needed by word_lists on the
        // parent, which runs after this returns, so the finishers leave it.
        let list_para = mso_list_level(&node).is_some();
        match self.mode {
            Mode::Html => self.finish_html(node, &t, list_para),
            Mode::Markdown => self.finish_markdown(node, &t, list_para),
        }
    }

    /// The steps both modes share. Err carries a final replacement.
    fn normalize(&self, node: Handle, t: &str) -> Result<Handle, Vec<Handle>> {
        if t == "input" && attr(&node, "type").as_deref() != Some("checkbox") {
            return Err(vec![]);
        }
        if t == "img" && attr(&node, "src").is_none_or(|s| s.trim().is_empty()) {
            return Err(vec![]);
        }
        // A Word bullet glyph stays marked until the parent's word_lists reads
        // it; unmark() unwraps any left over at the end.
        if t == "span" && attr(&node, "data-tm-bullet").is_some() {
            return Err(vec![node]);
        }
        if t == "code" {
            if let Some(lang) = attr(&node, "data-tm-lang") {
                set_attr(&node, "data-tm-lang", None);
                if self.mode == Mode::Markdown || self.o.classes {
                    set_attr(&node, "class", Some(&format!("language-{lang}")));
                }
                return Err(vec![node]);
            }
        }
        if t == "a" && self.o.strip_tracking {
            if let Some(href) = attr(&node, "href") {
                set_attr(&node, "href", Some(&strip_tracking(&href)));
            }
        }
        // Styling spans (Google Docs, Word) to semantic tags, so bold survives
        // when styles are dropped and markdown conversion sees **bold**.
        if t == "span" && attr(&node, "data-tm-math").is_none() && self.semantic_tags() {
            return Ok(self.semantic(node));
        }
        Ok(node)
    }

    fn semantic_tags(&self) -> bool {
        self.o.tidy || self.mode == Mode::Markdown
    }

    // The finishers run after the sanitizer. They may only remove nodes and
    // attributes, rename tags, or add fixed wrappers of their own (a <p> for
    // display math, a list for Word paragraphs). Nothing here may turn input
    // text or attribute values into markup; that is the sanitizer's boundary.

    /// Clean HTML: keep formatting as the options allow.
    fn finish_html(&self, node: Handle, t: &str, list_para: bool) -> Vec<Handle> {
        if t == "span" {
            if let Some(kind) = attr(&node, "data-tm-math") {
                let tex = text_of(&node);
                if kind == "display" {
                    let p = new_element("p", vec![]);
                    append(&p, new_text(&format!("$${tex}$$")));
                    return vec![p];
                }
                return vec![new_text(&format!("${tex}$"))];
            }
        }
        if !self.o.classes {
            set_attr(&node, "class", None);
            set_attr(&node, "id", None);
        } else if let Some(c) = attr(&node, "class") {
            let kept: Vec<&str> = c
                .split_whitespace()
                .filter(|x| !x.starts_with("Mso") && !x.starts_with("mso"))
                .collect();
            set_attr(
                &node,
                "class",
                (!kept.is_empty()).then(|| kept.join(" ")).as_deref(),
            );
        }
        if !self.o.table_style && TABLE_TAGS.contains(&t) {
            for a in ["border", "cellpadding", "cellspacing", "width", "valign"] {
                set_attr(&node, a, None);
            }
        }
        if !list_para {
            self.filter_style(&node, t);
        }
        if self.o.tidy {
            return tidy_tags(node, t, list_para);
        }
        vec![node]
    }

    /// Markdown: htmd's input. Semantic tags only, no attributes it does not
    /// read, and structure markdown can express.
    fn finish_markdown(&self, node: Handle, t: &str, list_para: bool) -> Vec<Handle> {
        if t == "span" && attr(&node, "data-tm-math").is_some() {
            return vec![node]; // the markdown handler writes the TeX
        }
        // Markdown cannot carry attributes, and in faithful mode one stray
        // dir="ltr" keeps a whole paragraph as HTML. Keep only what the
        // converter reads, plus the style the list pass still needs.
        let keep: &[&str] = match t {
            "a" => &["href"],
            "img" => &["src", "alt"],
            "td" | "th" => &["colspan", "rowspan"],
            "ol" => &["start"],
            "input" => &["type", "checked"],
            "code" => &["class"],
            "p" if list_para => &["style"],
            _ => &[],
        };
        if let NodeData::Element { attrs, .. } = &node.data {
            attrs
                .borrow_mut()
                .retain(|a| keep.contains(&a.name.local.as_ref()));
        }
        // No markdown for underline and friends: keep the text.
        if matches!(
            t,
            "u" | "ins" | "small" | "abbr" | "cite" | "q" | "sup" | "sub" | "font" | "div"
        ) {
            return take_children(&node);
        }
        // A cell or list item holding one paragraph is just its text, or the
        // list turns loose and the table breaks.
        if matches!(t, "td" | "th" | "li") && only_paragraph(&node) {
            let p = node
                .children
                .borrow()
                .iter()
                .find(|c| tag(c).is_some())
                .cloned();
            if let Some(p) = p {
                set_children(&node, take_children(&p));
            }
        }
        if t == "table" {
            promote_header(&node);
            if self.expand_spans {
                expand_spans(&node);
            }
        }
        tidy_tags(node, t, list_para)
    }

    /// Wrap a styled span's children in strong/em/u/s for its font styles, and
    /// drop those declarations from the style.
    fn semantic(&self, span: Handle) -> Handle {
        let Some(style) = attr(&span, "style") else {
            return span;
        };
        let mut rest = Vec::new();
        let mut wrappers: Vec<&str> = Vec::new();
        for (k, v) in decls(&style) {
            let lv = v.to_ascii_lowercase();
            match k.as_str() {
                "font-weight"
                    if lv == "bold"
                        || lv == "bolder"
                        || lv.parse::<u32>().is_ok_and(|n| n >= 600) =>
                {
                    wrappers.push("strong")
                }
                "font-weight" if lv == "normal" || lv == "400" => {}
                "font-style" if lv == "italic" || lv == "oblique" => wrappers.push("em"),
                "font-style" if lv == "normal" => {}
                // Markdown has no underline; the text is kept either way.
                "text-decoration" | "text-decoration-line" if lv.contains("underline") => {
                    if self.mode == Mode::Html {
                        wrappers.push("u")
                    }
                }
                "text-decoration" | "text-decoration-line" if lv.contains("line-through") => {
                    wrappers.push("s")
                }
                "text-decoration" | "text-decoration-line" if lv == "none" => {}
                _ => rest.push(format!("{k}: {v}")),
            }
        }
        if wrappers.is_empty() {
            return span;
        }
        let mut inner = take_children(&span);
        for w in wrappers.iter().rev() {
            let el = new_element(w, vec![]);
            set_children(&el, inner);
            inner = vec![el];
        }
        set_children(&span, inner);
        set_attr(
            &span,
            "style",
            (!rest.is_empty()).then(|| rest.join("; ")).as_deref(),
        );
        span
    }

    /// Word writes list items as <p style="mso-list:l0 level2 lfo1"> with a
    /// fake bullet. Turn each run of them into real, nested <ul>/<ol>.
    fn word_lists(&self, parent: &Handle) {
        let old = take_children(parent);
        let mut out: Vec<Handle> = Vec::with_capacity(old.len());
        // Stack of (level, ordered, list element) for the run in progress.
        let mut stack: Vec<(u32, bool, Handle)> = Vec::new();
        for child in old {
            let Some(level) = mso_list_level(&child) else {
                // Whitespace between list paragraphs does not end the run.
                if !stack.is_empty() && is_whitespace_text(&child) {
                    continue;
                }
                stack.clear();
                out.push(child);
                continue;
            };
            let (glyph, kids) = take_bullet_glyph(&child);
            let ordered = is_ordered_marker(glyph.trim_matches(is_space));

            while stack.last().is_some_and(|(l, _, _)| *l > level) {
                stack.pop();
            }
            let need_new = match stack.last() {
                None => true,
                Some((l, o, _)) => *l < level || *o != ordered,
            };
            if need_new {
                if stack.last().is_some_and(|(l, _, _)| *l == level) {
                    stack.pop(); // same level, different list type
                }
                let list = new_element(if ordered { "ol" } else { "ul" }, vec![]);
                match stack.last() {
                    // Nest inside the last item of the enclosing list.
                    Some((_, _, enclosing)) => {
                        let last_li = enclosing.children.borrow().last().cloned();
                        append(last_li.as_ref().unwrap_or(enclosing), list.clone());
                    }
                    None => out.push(list.clone()),
                }
                stack.push((level, ordered, list));
            }
            let li = new_element("li", vec![]);
            set_children(&li, kids);
            trim_leading_space(&li);
            if let Some((_, _, list)) = stack.last() {
                append(list, li);
            }
        }
        set_children(parent, out);
    }
}

fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{a0}'
}

/// The nesting level of a Word list paragraph (mso-list: l0 level2 lfo1), or
/// None for anything that is not one.
fn mso_list_level(node: &Handle) -> Option<u32> {
    if tag(node).as_deref() != Some("p") {
        return None;
    }
    let style = attr(node, "style")?.to_ascii_lowercase();
    if !style.contains("mso-list") {
        return None;
    }
    let digits: String = style
        .split("level")
        .nth(1)
        .unwrap_or("")
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    Some(digits.parse().unwrap_or(1))
}

/// Take a list paragraph's children, splitting out the fake bullet's text.
fn take_bullet_glyph(p: &Handle) -> (String, Vec<Handle>) {
    let mut glyph = String::new();
    let kids = take_children(p)
        .into_iter()
        .filter(|k| {
            let is_bullet = attr(k, "data-tm-bullet").is_some();
            if is_bullet {
                glyph.push_str(&text_of(k));
            }
            !is_bullet
        })
        .collect();
    (glyph, kids)
}

/// Trim the whitespace a removed bullet left at the start of an item.
fn trim_leading_space(li: &Handle) {
    if let Some(first) = li.children.borrow().first() {
        if let NodeData::Text { contents } = &first.data {
            let t = contents.borrow().trim_start_matches(is_space).to_string();
            *contents.borrow_mut() = t.into();
        }
    }
}

/// b/i/strike/del to strong/em/s, unwrap bare spans, drop empty elements.
/// <del> becomes <s>: Word files <del> as a tracked deletion and drops the text
/// (the same trap engine::render_with avoids).
fn tidy_tags(node: Handle, t: &str, list_para: bool) -> Vec<Handle> {
    let renamed = match t {
        "b" => Some("strong"),
        "i" => Some("em"),
        "strike" | "del" => Some("s"),
        _ => None,
    };
    if let Some(to) = renamed {
        return vec![rename(&node, to)];
    }
    if t == "span" && attrs_empty(&node) {
        return take_children(&node); // a bare span means nothing
    }
    const EMPTIABLE: &[&str] = &[
        "p", "span", "strong", "em", "u", "s", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li",
        "sup", "sub", "mark",
    ];
    if EMPTIABLE.contains(&t) && !list_para && is_empty(&node) {
        return vec![];
    }
    vec![node]
}

/// True when an element's only non-blank child is a single <p>.
fn only_paragraph(node: &Handle) -> bool {
    let kids = node.children.borrow();
    let elems: Vec<&Handle> = kids.iter().filter(|c| tag(c).is_some()).collect();
    elems.len() == 1
        && tag(elems[0]).as_deref() == Some("p")
        && kids
            .iter()
            .filter(|c| tag(c).is_none())
            .all(is_whitespace_text)
}

/// Word and Outlook tables have no <th>. Markdown tables need a header row, so
/// the first row's cells become header cells, which is what they almost always
/// are (bold labels).
fn promote_header(table: &Handle) {
    let has_th = find_first(table, &|n| {
        matches!(tag(n).as_deref(), Some("th" | "thead"))
    })
    .is_some();
    if has_th {
        return;
    }
    let Some(first_row) = find_first(table, &|n| tag(n).as_deref() == Some("tr")) else {
        return;
    };
    let cells = take_children(&first_row);
    let cells = cells
        .into_iter()
        .map(|c| {
            if tag(&c).as_deref() == Some("td") {
                rename(&c, "th")
            } else {
                c
            }
        })
        .collect();
    set_children(&first_row, cells);
}

/// Split merged cells into a plain grid: a colspan or rowspan cell keeps its
/// text in the first slot and leaves empty cells in the others. htmd reorders
/// a cell whose kind differs from its row's, so a colspan filler matches the
/// cell it splits from, and a rowspan filler (in the rows below) is a <td>.
fn expand_spans(table: &Handle) {
    let mut rows: Vec<Handle> = Vec::new();
    fn collect(n: &Handle, rows: &mut Vec<Handle>) {
        for c in n.children.borrow().iter() {
            match tag(c).as_deref() {
                Some("tr") => rows.push(c.clone()),
                Some("thead" | "tbody" | "tfoot") => collect(c, rows),
                _ => {}
            }
        }
    }
    collect(table, &mut rows);
    // pending[col] = rows still covered by a rowspan from above.
    let mut pending: Vec<u32> = Vec::new();
    let filler = |kind: &str| new_element(kind, vec![]);
    for row in rows {
        let mut cells = take_children(&row)
            .into_iter()
            .filter(|c| matches!(tag(c).as_deref(), Some("td" | "th")));
        let mut out: Vec<Handle> = Vec::new();
        let mut col = 0usize;
        loop {
            if pending.get(col).is_some_and(|n| *n > 0) {
                pending[col] -= 1;
                out.push(filler("td"));
                col += 1;
                continue;
            }
            let Some(cell) = cells.next() else {
                // Rowspans that reach past this row's last real cell.
                while pending.get(col).is_some_and(|n| *n > 0) {
                    pending[col] -= 1;
                    out.push(filler("td"));
                    col += 1;
                }
                break;
            };
            let span = |k: &str| {
                attr(&cell, k)
                    .and_then(|v| v.trim().parse::<u32>().ok())
                    .filter(|n| *n > 1 && *n < 1000)
                    .unwrap_or(1)
            };
            let (cs, rs) = (span("colspan"), span("rowspan"));
            let kind = tag(&cell).unwrap_or_else(|| "td".into());
            set_attr(&cell, "colspan", None);
            set_attr(&cell, "rowspan", None);
            for k in 0..cs as usize {
                out.push(if k == 0 { cell.clone() } else { filler(&kind) });
                if rs > 1 {
                    if pending.len() <= col {
                        pending.resize(col + 1, 0);
                    }
                    pending[col] = rs - 1;
                }
                col += 1;
            }
        }
        set_children(&row, out);
    }
}

fn rename(node: &Handle, to: &str) -> Handle {
    let attrs = match &node.data {
        NodeData::Element { attrs, .. } => attrs.borrow().clone(),
        _ => vec![],
    };
    let el = Node::new(NodeData::Element {
        name: qual(to),
        attrs: RefCell::new(attrs),
        template_contents: RefCell::new(None),
        mathml_annotation_xml_integration_point: false,
    });
    set_children(&el, take_children(node));
    el
}

fn attrs_empty(node: &Handle) -> bool {
    match &node.data {
        NodeData::Element { attrs, .. } => attrs.borrow().is_empty(),
        _ => true,
    }
}

fn is_whitespace_text(node: &Handle) -> bool {
    matches!(&node.data, NodeData::Text { contents } if contents.borrow().chars().all(|c| c.is_whitespace() || c == '\u{a0}'))
}

/// No visible text and nothing that renders without text.
fn is_empty(node: &Handle) -> bool {
    let has_media = find_first(node, &|n| {
        matches!(
            tag(n).as_deref(),
            Some("img" | "br" | "hr" | "input" | "table")
        )
    })
    .is_some();
    !has_media
        && text_of(node)
            .chars()
            .all(|c| c.is_whitespace() || c == '\u{a0}')
}

/// 1. 2) a. iv. -> ordered; bullets, dashes, Wingdings glyphs -> unordered.
fn is_ordered_marker(raw: &str) -> bool {
    let Some(m) = raw.strip_suffix('.').or_else(|| raw.strip_suffix(')')) else {
        return false;
    };
    !m.is_empty()
        && (m.chars().all(|c| c.is_ascii_digit())
            || (m.len() == 1 && m.chars().all(|c| c.is_ascii_alphabetic()))
            || m.chars().all(|c| "ivxlcdmIVXLCDM".contains(c)))
}

fn collapse_nbsp(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut run = 0;
    for c in t.chars() {
        if c == '\u{a0}' {
            run += 1;
            continue;
        }
        if run == 1 {
            out.push('\u{a0}');
        } else if run > 1 {
            out.push(' ');
        }
        run = 0;
        out.push(c);
    }
    if run == 1 {
        out.push('\u{a0}');
    } else if run > 1 {
        out.push(' ');
    }
    out
}

fn strip_tracking(href: &str) -> String {
    let (base, frag) = match href.split_once('#') {
        Some((b, f)) => (b, Some(f)),
        None => (href, None),
    };
    let Some((path, query)) = base.split_once('?') else {
        return href.to_string();
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|kv| {
            let k = kv.split('=').next().unwrap_or("").to_ascii_lowercase();
            !k.is_empty() && !k.starts_with("utm_") && !TRACKING.contains(&k.as_str())
        })
        .collect();
    let mut out = path.to_string();
    if !kept.is_empty() {
        out.push('?');
        out.push_str(&kept.join("&"));
    }
    if let Some(f) = frag {
        out.push('#');
        out.push_str(f);
    }
    out
}

/// The Rust twin of stripUnicode in src/pipeline.js, for HTML text nodes. The
/// ranges and the order match the JS pass, and emoji use the same Unicode
/// property (Extended_Pictographic), not block ranges. test/fixtures/
/// unicode-parity.json holds boundary characters (check marks, arrows, flags,
/// skin tones) and both test suites assert the same output from it.
pub fn strip_unicode(text: &str) -> String {
    static PICTO: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let kept: String = text
        .chars()
        .filter(|&c| {
            let u = c as u32;
            !(matches!(u, 0xAD | 0x200B..=0x200F | 0xFEFF)
                || (0xFE00..=0xFE0F).contains(&u)
                || (0xE0100..=0xE01EF).contains(&u)
                || (0x202A..=0x202E).contains(&u)
                || (0x2066..=0x2069).contains(&u)
                || (u <= 0x1F && !matches!(u, 0x09 | 0x0A | 0x0D))
                || (0x7F..=0x9F).contains(&u))
        })
        .collect();
    let picto = PICTO.get_or_init(|| {
        fancy_regex::Regex::new(r"\p{Extended_Pictographic}").expect("valid property regex")
    });
    let no_picto = picto.replace_all(&kept, "");
    no_picto
        .chars()
        .filter(|&c| {
            let u = c as u32;
            !((0x2200..=0x22FF).contains(&u)
                || (0x2A00..=0x2AFF).contains(&u)
                || (0x20A0..=0x20CF).contains(&u)
                || matches!(u, 0xA2 | 0xA3 | 0xA5))
        })
        .collect()
}

fn tidy(html: &str, o: &HtmlOptions, mode: Mode, expand_spans: bool) -> String {
    let doc = parse(html);
    if let Some(body) = body_of(&doc) {
        Tidy {
            o,
            mode,
            expand_spans,
        }
        .children(&body);
        unmark(&body);
        // A paste often ends with a stray <br> (Chrome's Apple-interchange-
        // newline). Trailing ones render as a blank line, so they go.
        loop {
            let last = body.children.borrow().last().cloned();
            match last {
                Some(n) if tag(&n).as_deref() == Some("br") || is_whitespace_text(&n) => {
                    body.children.borrow_mut().pop();
                }
                _ => break,
            }
        }
    }
    serialize_body(&doc)
}

/// Unwrap any Word bullet marker the list pass did not consume, so no internal
/// attribute reaches the output.
fn unmark(node: &Handle) {
    let old = take_children(node);
    let mut out = Vec::with_capacity(old.len());
    for c in old {
        unmark(&c);
        if attr(&c, "data-tm-bullet").is_some() {
            out.extend(take_children(&c));
        } else {
            out.push(c);
        }
    }
    set_children(node, out);
}

// --- Entry points -----------------------------------------------------------

/// Clean pasted HTML, keeping its formatting as the options allow.
pub fn clean_html(html: &str, o: &HtmlOptions) -> String {
    let prepared = prepare(html);
    let safe = sanitize(&prepared, o.images, o.classes);
    tidy(&safe, o, Mode::Html, false).trim().to_string()
}

/// Convert pasted HTML to markdown, through the same clean first.
pub fn html_to_markdown(html: &str, m: &MarkdownOptions) -> String {
    let strict = HtmlOptions {
        styles: Styles::Off,
        classes: false,
        tidy: true,
        ..HtmlOptions::default()
    };
    let prepared = prepare(html);
    let safe = sanitize(&prepared, Images::Keep, false);
    let clean = tidy(
        &safe,
        &strict,
        Mode::Markdown,
        m.merged_tables == MergedTables::Pipe,
    );
    markdown_converter(m)
        .convert(&clean)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn markdown_converter(m: &MarkdownOptions) -> htmd::HtmlToMarkdown {
    use htmd::element_handler::Handlers;
    use htmd::options::{BulletListMarker, Options, TranslationMode};
    use htmd::Element;

    let options = Options {
        bullet_list_marker: BulletListMarker::Dash,
        ul_bullet_spacing: 1,
        ol_number_spacing: 1,
        translation_mode: if m.merged_tables == MergedTables::Html {
            TranslationMode::Faithful
        } else {
            TranslationMode::Pure
        },
        ..Options::default()
    };
    let dollar = m.math == Math::Dollar;
    let attr_of = |e: &Element, k: &str| {
        e.attrs
            .iter()
            .find(|a| a.name.local.as_ref() == k)
            .map(|a| a.value.to_string())
    };
    let wrap = |marker: &'static str| {
        move |h: &dyn Handlers, e: Element| -> Option<htmd::element_handler::HandlerResult> {
            let inner = h.walk_children(e.node).content;
            let t = inner.trim();
            (!t.is_empty()).then(|| format!("{marker}{t}{marker}").into())
        }
    };
    htmd::HtmlToMarkdown::builder()
        .options(options)
        .add_handler(vec!["span"], move |h: &dyn Handlers, e: Element| {
            match attr_of(&e, "data-tm-math") {
                // Raw TeX, not walked: the walker would escape its backslashes.
                Some(kind) => {
                    let tex = text_of(e.node);
                    let tex = tex.trim();
                    Some(match (dollar, kind.as_str()) {
                        (true, "display") => format!("\n\n$$\n{tex}\n$$\n\n").into(),
                        (true, _) => format!("${tex}$").into(),
                        (false, _) => tex.to_string().into(),
                    })
                }
                None => h.fallback(e),
            }
        })
        .add_handler(vec!["mark"], wrap("=="))
        .add_handler(vec!["del", "s", "strike"], wrap("~~"))
        .add_handler(vec!["input"], move |_: &dyn Handlers, e: Element| {
            let checked = attr_of(&e, "checked").is_some();
            Some(if checked { "[x] " } else { "[ ] " }.into())
        })
        .build()
}

// --- Tauri commands -----------------------------------------------------------

#[tauri::command]
pub fn html_clean(input: String, options: Option<HtmlOptions>) -> String {
    clean_html(&input, &options.unwrap_or_default())
}

#[tauri::command]
pub fn html_markdown(input: String, options: Option<MarkdownOptions>) -> String {
    html_to_markdown(&input, &options.unwrap_or_default())
}

#[cfg(test)]
mod tests;
