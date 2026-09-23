# Command line

`textmint` is a CLI over the same cleaning passes (`src/pipeline.js`) and, for
HTML, the same Rust engine (`engine::render_with`, `html::clean_html`,
`html::html_to_markdown`) the app uses, so its output matches the app's. It is the interface for scripts and AI agents: data in, data out, no
GUI and no window running.

```
textmint clean    [options] [file]   Clean text, markdown removed (stdin -> stdout)
textmint markdown [options] [file]   Clean text, markdown kept   (stdin -> stdout)
textmint html     [options] [file]   Clean to markdown, then render to HTML
textmint open     [file|-]           Load text into the Textmint window to review
```

A file argument (or `-`) is read as input; with none, it reads stdin.

## Examples

```sh
echo "$messy" | textmint clean                 # cleaned plain text
textmint markdown < notes.md                    # cleaned, markdown kept
cat report.md | textmint html > report.html     # the same HTML Copy HTML produces
textmint open notes.md                          # push into the GUI to review
pbpaste | textmint open -                        # push the clipboard into the GUI
```

## Options

For `clean`, `markdown` and `html`. Every pass is on by default, matching the
app's shipped defaults. Turn one off with its `--no-` flag:

```
--no-strip-noise --no-strip-unicode --no-strip-markdown --no-bullets
--no-join-lines --no-strip-indent --no-collapse-blank --no-wrap
--wrap <n>            Wrap width (default 80)
-h, --help           Show help
-v, --version        Show version
```

`markdown` and `html` keep markdown regardless of `--no-strip-markdown`: that
path exists to preserve markup for the renderer, so it never strips it, and it
also skips bullet normalization and wrapping.

## HTML input

Input that looks like HTML source (a saved web page, a Word export, a clipboard
dump) is handled like the app's rich paste: `clean` and `markdown` convert it to
markdown first (`textmint-render --from-html`), and `html` cleans it with its
formatting kept (`textmint-render --clean-html`), using the app's default HTML
settings.

```
--from-html           Treat the input as HTML even if it does not look like it
--plain               Treat the input as plain text, never as HTML
--flavor <f>          commonmark, github (default) or obsidian: the renderer's
                      extensions, and whether ==highlights== are kept
--html-mode <m>       For html from HTML input: clean (default) keeps the
                      formatting; markdown renders the converted markdown
```

```sh
pbpaste -Prefer html | textmint markdown          # a copied web page as markdown
textmint html --html-mode markdown < page.html    # uniform HTML from any source
textmint markdown --flavor obsidian < note.html   # keeps ==highlights==
```

## How `open` works, and why it is safe

`textmint open` writes the text to a private (owner-only) one-shot handoff file,
then launches the app with `TEXTMINT_OPEN` pointing at it. The app reads it once
on start (`startup.rs` + `src/main.js`). It deletes only its own handoff file
(named `textmint-open-*.txt`): if you set `TEXTMINT_OPEN` to one of your own
files, it is read but never deleted. User-initiated and one-shot, so unlike the
dev bridge (`docs/AUTOMATION.md`) it is not an always-listening channel: nothing
loads unless you run the command.

`open` launches a runnable app: the repo's release build
(`src-tauri/target/release/textmint`) or an installed `Textmint.app`. It will not
launch a debug build, which only loads its UI under `tauri dev` and would open
blank. If neither exists it tells you to build one.

## Install

The CLI lives at `bin/textmint.js` (the `textmint` bin in `package.json`). In the
repo, run it as `node bin/textmint.js ...` or `npm link` to put `textmint` on
your PATH. The `html` command needs the render binary built once:

```sh
cd src-tauri && cargo build --release --bin textmint-render
```
