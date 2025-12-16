# OpenOverlay - A Tangia Overlay Linux Alternative
This is for all my linux ladies and gentlemen that want to stream on linux but don't have a linux alternative for the Tangia desktop overlay. Feel free to build the appimage yourself, or download it ready to use from the [releases](https://github.com/cobalt1981/openoverlay/releases). 

I have tested this on both Hyprland and KDE. Results may vary in other WMs and DEs. This was put together in very short order, so there could be bugs I haven't caught. If so, you're welcome to fork this repo and go wild!

## Prerequisites
- Node.js 18+ and npm
- Wayland and X11 should both be supported

## Install and run
```sh
npm install
npm start
```

## Build an AppImage (from repo root)
```sh
npm run dist
```
The AppImage and unpacked build will appear in `dist/` (e.g. `dist/OpenOverlay-X.X.X.AppImage`).
