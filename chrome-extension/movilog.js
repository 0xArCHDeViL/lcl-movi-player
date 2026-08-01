// Debug: open player.html?movilog to route the player bundle's internal logs to
// the DevTools console.
//
// The bundle calls window.__movilog (that name survives minification; plain
// console.* is stripped by terser's drop_console), so the sink MUST exist
// before the bundle script runs — hence a separate classic script loaded ahead
// of the module rather than a line at the top of player.js, whose imports are
// evaluated before any of its own statements. MV3's CSP (script-src 'self')
// rules out an inline <script>, which is what the web build uses.
if (new URLSearchParams(location.search).has("movilog")) {
  (function () {
    var f = function (n) {
      return function () {
        console[n].apply(
          console,
          ["%c[movi]", "color:#6c5dd3"].concat([].slice.call(arguments)),
        );
      };
    };
    var m = f("log");
    m.log = f("log");
    m.info = f("info");
    m.warn = f("warn");
    m.error = f("error");
    m.debug = f("debug");
    window.__movilog = m;
  })();
}
