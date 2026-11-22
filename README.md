# **Apple Music Discord Rich Presence**

## **Contents**
1. Project Overview
2. App Features
3. App Installation
4. Running From Source

## **Project Overview**

This app bridges [Discord](https://discord.com) and [Apple Music](https://www.apple.com/apple-music/). Apple's Music app (macOS) and iTunes (Windows) don't support [Discord Rich Presence](https://discord.com/rich-presence) out of the box, so this app adds it. Spotify has had full Discord integration for years, so it's about time Apple Music got something efficient too.

### **Project Goals:**
* Accurate song timing that stays in sync when you skip or seek
* Use as little CPU as possible, so your computer doesn't lag and your fans stay quiet

## **App Features**

### **1. "Listening to Apple Music"**
  * Shows as **Listening to Apple Music** on your profile, just like Spotify
  * Song name, artist and album
  * A progress bar with elapsed and total time (you can turn it off)

### **2. Album Artwork**
  * Shows the song's real album cover instead of the Apple Music logo
  * Looked up once per song with Apple's public iTunes Search API. You can turn this off from the menu.

### **3. Paused Status**
  * Shows that the song is paused, with no timer running

### **4. Buttons**
  * **Listen on Apple Music**: opens the song itself when it can be found, or an Apple Music search when it can't
  * **Search on Spotify**
  * Note: Discord doesn't show your own buttons to you. Your friends see them.

### **5. Menu Bar / Tray Icon**
  * See what's playing and whether Discord is connected
  * Turn the status, progress bar or artwork on and off
  * Open the app automatically at login
  * Quit the app

### **Good to know**
  * Starting it before Discord is fine. It connects once Discord opens and reconnects if Discord restarts.
  * It never opens Music or iTunes by itself. Quitting the player clears your status.
  * Internet radio streams show the song that's playing, not just the station name.

## **App Installation**

* ###  macOS 12+

  1. Go to [releases](https://github.com/rohilpatel1/Apple-Music-Rich-Presence/releases) and choose a version. The most recent version is highly recommended.

  2. Under "Assets" at the bottom of the release, download the file for your operating system (e.g. `darwin-universal.zip` for **macOS**).

  3. Open the file from your **Downloads** folder, unzipping it if needed.

  4. Drag the "AppleMusicRPC" app into your **Applications** folder.

  5. Open the app. If you get an "Unidentified Developer" error, right-click the app in Applications and choose "Open".

  6. The first time it runs, macOS asks whether AppleMusicRPC can control Music. Click **OK**. The app then appears in your menu bar.

* ### Windows 10 / 11
  1. Go to [releases](https://github.com/rohilpatel1/Apple-Music-Rich-Presence/releases) and choose a version. The most recent version is highly recommended.

  2. Under "Assets" at the bottom of the release, download the file for your operating system (e.g. `win32-x64.zip` for 64-bit **Windows**).

  3. Open the file from your **Downloads** folder, unzipping it if needed.

  4. Open the folder and run "AppleMusicRPC.exe". The app appears in the system tray, and your status shows up once iTunes is playing.

## **Running From Source**

You'll need [Node.js](https://nodejs.org) 22.12 or newer.

```bash
npm install
npm start        # run the app
npm test         # run the tests
npm run build    # package for Windows (x64 and ia32) and macOS (universal) into dist/
```
