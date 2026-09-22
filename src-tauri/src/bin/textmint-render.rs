// textmint-render: read markdown on stdin, write HTML on stdout, through the
// same engine the app uses (textmint_lib::engine). The CLI (bin/textmint.js)
// shells to this for its `html` command, so there is never a second markdown
// converter to drift from the app.
use std::io::{Read, Write};

fn main() {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("textmint-render: failed to read stdin: {e}");
        std::process::exit(1);
    }
    let html = textmint_lib::engine::render(&input);
    if let Err(e) = std::io::stdout().write_all(html.as_bytes()) {
        eprintln!("textmint-render: failed to write stdout: {e}");
        std::process::exit(1);
    }
}
