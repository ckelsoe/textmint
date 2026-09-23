// textmint-render: the Rust engine behind the CLI (bin/textmint.js), so there is
// never a second converter to drift from the app. Reads stdin, writes stdout.
//
//   textmint-render [--flavor f]              markdown -> HTML (engine::render_with)
//   textmint-render --from-html [--options j] HTML -> markdown (html::html_to_markdown)
//   textmint-render --clean-html [--options j] HTML -> clean HTML (html::clean_html)
//
// --options takes the same JSON the app sends (camelCase keys); anything left
// out keeps its default.
use std::io::{Read, Write};

fn fail(msg: &str) -> ! {
    eprintln!("textmint-render: {msg}");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut mode = "render";
    let mut flavor = String::from("github");
    let mut options = String::from("{}");
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--from-html" => mode = "from-html",
            "--clean-html" => mode = "clean-html",
            "--flavor" => {
                i += 1;
                flavor = args
                    .get(i)
                    .cloned()
                    .unwrap_or_else(|| fail("--flavor needs a value"));
            }
            "--options" => {
                i += 1;
                options = args
                    .get(i)
                    .cloned()
                    .unwrap_or_else(|| fail("--options needs JSON"));
            }
            other => fail(&format!("unknown argument: {other}")),
        }
        i += 1;
    }

    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        fail(&format!("failed to read stdin: {e}"));
    }
    let out = match mode {
        "from-html" => {
            let o = serde_json::from_str(&options)
                .unwrap_or_else(|e| fail(&format!("bad --options: {e}")));
            textmint_lib::html::html_to_markdown(&input, &o)
        }
        "clean-html" => {
            let o = serde_json::from_str(&options)
                .unwrap_or_else(|e| fail(&format!("bad --options: {e}")));
            textmint_lib::html::clean_html(&input, &o)
        }
        _ => {
            let f = textmint_lib::engine::Flavor::parse(&flavor)
                .unwrap_or_else(|| fail("--flavor must be commonmark, github or obsidian"));
            textmint_lib::engine::render_with(&input, f)
        }
    };
    if let Err(e) = std::io::stdout().write_all(out.as_bytes()) {
        eprintln!("textmint-render: failed to write stdout: {e}");
        std::process::exit(1);
    }
}
