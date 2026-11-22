// JavaScript for Automation (JXA) script that reports what the macOS Music
// app is playing as a single line of JSON.
// Run with: osascript -l JavaScript OSABridge.js

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
  // quitting Music would make it reopen a second later.
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

function run() {
  // Escape non-ASCII characters so song titles in any language survive
  // osascript's output encoding.
  return JSON.stringify(getStatus()).replace(/[\u007f-￿]/g, function (c) {
    return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
  });
}
