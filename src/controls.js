// The eight cleaning-option checkbox ids in src/index.html, in one place so the
// preferences loader (src/main.js) and the automation bridge (src/bridge.js)
// cannot drift. Adding a cleaning option adds one id here, not one in each.
export const CHECK_IDS = [
  "opt-strip-noise", "opt-strip-unicode", "opt-strip-markdown", "opt-wrap",
  "opt-collapse-blank", "opt-strip-indent", "opt-bullets", "opt-join-lines",
];
