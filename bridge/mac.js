// JavaScript for Automation (JXA) script that reports what the macOS Music app
// is playing. It keeps running and prints one line of JSON whenever that
// changes. bridge/player.js starts it with `osascript -l JavaScript -e <this
// file's text>` (text rather than a path, so it works wherever macOS runs the
// app from) and stops it when the app quits.
//
// Music announces every track change, play and pause with a
// "com.apple.Music.playerInfo" notification, so this mostly sleeps. While a
// song plays it also checks every few seconds, to catch seeking, which Music
// doesn't announce.

ObjC.import("Foundation");
ObjC.import("stdlib");

var CHECK_SECONDS = { Playing: 5, "Not Running": 2, other: 15 };

function getPlayerState(music) {
  switch (music.playerState()) {
    case "playing":
    case "fast forwarding":
    case "rewinding":
      return "Playing";
    case "paused":
      return "Paused";
    default:
      return "Stopped";
  }
}

function getStatus() {
  var music = Application("Music");

  // Asking a closed app anything launches it, so check first. Otherwise
  // quitting Music would make it reopen.
  if (!music.running()) return { state: "Not Running" };

  var status = { state: getPlayerState(music) };
  if (status.state === "Stopped") return status;

  try {
    var track = music.currentTrack;
    status.name = track.name();
    status.artist = track.artist();
    status.album = track.album();
    status.duration = track.duration();
    status.elapsed = music.playerPosition();
  } catch (e) {}

  try {
    status.streamTitle = music.currentStreamTitle();
  } catch (e) {}

  return status;
}

function safeGetStatus() {
  try {
    return getStatus();
  } catch (e) {
    return { state: "Error", error: String(e.message || e), errorNumber: e.errorNumber };
  }
}

// ------------------------------------------------------------------ output

var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
var stderr = $.NSFileHandle.fileHandleWithStandardError;
var debugEnabled = Boolean(ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment).AMRPC_DEBUG);

function writeLine(handle, text) {
  handle.writeData($(text + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
}

function debug(text) {
  if (debugEnabled) writeLine(stderr, text);
}

// Escape non-ASCII characters so song titles in any language survive the
// trip through osascript's output.
function toAsciiJson(value) {
  return JSON.stringify(value).replace(/[^\x00-\x7e]/g, function (c) {
    return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

// ----------------------------------------------------------- notifications

var checkNow = true;
var stdin = $.NSFileHandle.fileHandleWithStandardInput;

ObjC.registerSubclass({
  name: "AMRPCObserver",
  methods: {
    "musicChanged:": {
      types: ["void", ["id"]],
      implementation: function () {
        checkNow = true;
        debug("playerInfo");
      },
    },
    // The app keeps our stdin open. When it closes, the app has quit (or
    // crashed), so stop too.
    "stdinRead:": {
      types: ["void", ["id"]],
      implementation: function (notification) {
        var data = notification.userInfo.objectForKey("NSFileHandleNotificationDataItem");
        if (data.length == 0) $.exit(0);
        stdin.readInBackgroundAndNotify;
      },
    },
  },
});

var observer = $.AMRPCObserver.alloc.init;
// $() is nil here (null would become NSNull): notifications from any sender.
// 4 = NSNotificationSuspensionBehaviorDeliverImmediately
$.NSDistributedNotificationCenter.defaultCenter.addObserverSelectorNameObjectSuspensionBehavior(
  observer,
  "musicChanged:",
  "com.apple.Music.playerInfo",
  $(),
  4
);
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(
  observer,
  "stdinRead:",
  "NSFileHandleReadCompletionNotification",
  stdin
);
stdin.readInBackgroundAndNotify;

// --------------------------------------------------------------- main loop

var nextCheck = 0;
var lastKey = null;
var lastStart = 0;

function check() {
  var status = safeGetStatus();
  var now = Date.now();
  nextCheck = now + (CHECK_SECONDS[status.state] || CHECK_SECONDS.other) * 1000;

  // Only print when something changed. While playing, the position always
  // moves, so compare when the song started instead: that only jumps when
  // the user seeks.
  var start = status.state === "Playing" ? now - (status.elapsed || 0) * 1000 : 0;
  var key = JSON.stringify([
    status.state,
    status.name,
    status.artist,
    status.album,
    status.duration,
    status.streamTitle,
    status.error,
  ]);
  if (key !== lastKey || Math.abs(start - lastStart) > 2000) {
    lastKey = key;
    lastStart = start;
    writeLine(stdout, toAsciiJson(status));
  }
}

while (true) {
  if (checkNow || Date.now() >= nextCheck) {
    checkNow = false;
    check();
  }
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(1));
}
