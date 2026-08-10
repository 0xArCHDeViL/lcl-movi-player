// Per-URL log files, kept only while the extension is running unpacked.
//
// The console is fine while you are watching it and useless an hour later: the
// tab is closed, the buffer is gone, and the one playback that misbehaved is
// the one nobody was looking at. This keeps a file per URL instead — every line
// the player emits, on disk in IndexedDB, readable long after the fact.
//
// A classic script and not part of player.js for the same reason movilog.js is:
// the bundle calls window.__movilog (that name survives minification, plain
// console.* does not), so the sink has to exist BEFORE the module's imports
// evaluate. Loaded ahead of it in player.html.
//
// Never on a published install. Dev mode is read off the manifest — Chrome adds
// update_url only for extensions it installed from the Web Store, so its
// absence means this copy was loaded unpacked. No extra permission, and a real
// user's machine never writes a byte.
(function () {
  var dev = false;
  try {
    dev = !chrome.runtime.getManifest().update_url;
  } catch (e) {
    return; // not in an extension page at all
  }
  var forced = new URLSearchParams(location.search).has("movilog");
  if (!dev && !forced) return;

  var DB = "movi-player-logs";
  var STORE = "sessions";
  var MAX_LINES = 20000; // ~2-4MB of text, and far more than one playback makes
  var MAX_SESSIONS = 25; // oldest are dropped, so this cannot grow forever
  var FLUSH_MS = 2000;

  var params = new URLSearchParams(location.search);
  var url = params.get("url") || "(no url)";
  var startedAt = Date.now();
  var id = startedAt + "::" + url;
  var lines = [];
  var dropped = 0;
  var dirty = false;
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
    return dbPromise;
  }

  function stamp() {
    var t = (Date.now() - startedAt) / 1000;
    return t.toFixed(3).padStart(9, " ");
  }

  // Arguments as text. Errors keep their stack — the stack is the whole reason
  // anyone opens one of these files.
  function render(args) {
    var out = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a instanceof Error) out.push(a.stack || a.name + ": " + a.message);
      else if (typeof a === "string") out.push(a);
      else {
        try { out.push(JSON.stringify(a)); }
        catch (e) { out.push(String(a)); }
      }
    }
    return out.join(" ");
  }

  function write(level, args) {
    if (lines.length >= MAX_LINES) {
      // Keep the START of the session, not the end: what went wrong is nearly
      // always upstream of where it surfaced, and the tail is the part a live
      // console already showed you.
      dropped++;
      return;
    }
    lines.push(stamp() + "  " + level.toUpperCase().padEnd(5) + "  " + render(args));
    dirty = true;
  }

  function flush() {
    if (!dirty) return Promise.resolve();
    dirty = false;
    var payload = {
      id: id,
      url: url,
      startedAt: startedAt,
      updatedAt: Date.now(),
      dropped: dropped,
      userAgent: navigator.userAgent,
      text: lines.join("\n"),
    };
    return openDb().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(payload);
      } catch (e) {}
    });
  }

  function prune() {
    return openDb().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(STORE, "readwrite");
        var store = tx.objectStore(STORE);
        var all = store.getAll();
        all.onsuccess = function () {
          var rows = (all.result || []).sort(function (a, b) { return b.startedAt - a.startedAt; });
          for (var i = MAX_SESSIONS; i < rows.length; i++) store.delete(rows[i].id);
        };
      } catch (e) {}
    });
  }

  // ── The sink the bundle calls ────────────────────────────
  var mirror = function (level) {
    return function () {
      write(level, arguments);
      if (forced) {
        console[level].apply(console, ["%c[movi]", "color:#6c5dd3"].concat([].slice.call(arguments)));
      }
    };
  };
  var sink = mirror("log");
  sink.log = mirror("log");
  sink.info = mirror("info");
  sink.warn = mirror("warn");
  sink.error = mirror("error");
  sink.debug = mirror("debug");
  window.__movilog = sink;

  // The page's own console.warn / console.error too: player.js reports thumbnail
  // and file-load failures that way, and they belong in the same file as the
  // player's own account of the same playback.
  ["warn", "error"].forEach(function (level) {
    var original = console[level].bind(console);
    console[level] = function () {
      write(level, arguments);
      original.apply(console, arguments);
    };
  });

  // Anything that got past every handler.
  window.addEventListener("error", function (e) {
    write("error", ["uncaught", e.message, "at", (e.filename || "") + ":" + e.lineno]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    write("error", ["unhandled rejection", e.reason]);
  });

  setInterval(flush, FLUSH_MS);
  // pagehide, not unload: unload does not fire reliably when a tab is closed,
  // and the last seconds before a close are exactly the ones worth keeping.
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });

  write("info", ["── session", new Date(startedAt).toISOString(), "·", url]);
  prune();

  // ── Reading them back ───────────────────────────────────
  // In the console of any player tab:
  //   moviLogs.list()          every session, newest first
  //   moviLogs.text()          this session so far, as text
  //   moviLogs.text(id)        an older one
  //   moviLogs.download()      save this session as a .log file
  //   moviLogs.download(id)    save an older one
  //   moviLogs.clear()         throw them all away
  function all() {
    return openDb().then(function (db) {
      if (!db) return [];
      return new Promise(function (resolve) {
        try {
          var req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
          req.onsuccess = function () {
            resolve((req.result || []).sort(function (a, b) { return b.startedAt - a.startedAt; }));
          };
          req.onerror = function () { resolve([]); };
        } catch (e) { resolve([]); }
      });
    });
  }

  function fileName(row) {
    var name = (row.url || "session").split("/").pop().split("?")[0] || "session";
    return "movi-" + new Date(row.startedAt).toISOString().replace(/[:.]/g, "-") + "-" + name + ".log";
  }

  window.moviLogs = {
    list: function () {
      return all().then(function (rows) {
        return rows.map(function (r) {
          return {
            id: r.id,
            when: new Date(r.startedAt).toLocaleString(),
            url: r.url,
            lines: (r.text.match(/\n/g) || []).length + 1,
            dropped: r.dropped || 0,
          };
        });
      });
    },
    text: function (which) {
      if (!which) return flush().then(function () { return lines.join("\n"); });
      return all().then(function (rows) {
        var row = rows.find(function (r) { return r.id === which; }) || rows[which];
        return row ? row.text : null;
      });
    },
    download: function (which) {
      var pick = which
        ? all().then(function (rows) {
            return rows.find(function (r) { return r.id === which; }) || rows[which];
          })
        : flush().then(function () {
            return { id: id, url: url, startedAt: startedAt, text: lines.join("\n") };
          });
      return pick.then(function (row) {
        if (!row) return null;
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([row.text], { type: "text/plain" }));
        a.download = fileName(row);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
        return a.download;
      });
    },
    clear: function () {
      return openDb().then(function (db) {
        if (!db) return;
        try { db.transaction(STORE, "readwrite").objectStore(STORE).clear(); } catch (e) {}
        lines.length = 0;
        dropped = 0;
      });
    },
  };

  console.info(
    "%c[movi]%c dev build — logging this URL to a file. moviLogs.list() / moviLogs.download()",
    "color:#6c5dd3", "color:inherit"
  );
})();
