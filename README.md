# NEEDLE — shared Spotify vinyl player

NEEDLE is one static website shared by all approved users. The owner configures **one Spotify Client ID** in `config.js`; each visitor connects using their own Spotify account. Visitors do not create a developer app or enter a Client ID.

## Shared app configuration

`config.js` already contains the NEEDLE owner's Spotify Client ID. A Client ID is public and is safe to include in this static site. **Never add a Spotify Client Secret.**

If the owner ever replaces the Spotify app, update `CLIENT_ID` in `config.js` and add the exact deployed URL below to that app's Redirect URIs.

## Deploy to this GitHub Pages repository

Repository: `QuietParadox-tech/Needle-V2`

1. Upload and replace the files in this folder at the repository root (same level as `README.md`).
2. Commit the changes to the `main` branch.
3. In GitHub, open **Settings → Pages** and confirm Pages deploys from `main` / root.
4. Wait for the Pages deployment to finish.
5. Open: `https://quietparadox-tech.github.io/Needle-V2/`

## Spotify Dashboard setup (owner does this once)

In the owner's Spotify Developer Dashboard, for the NEEDLE app:

- Add this exact Redirect URI: `https://quietparadox-tech.github.io/Needle-V2/`
- Save the settings.
- Under **User Management**, add the Spotify account email for every person who will test the app.
- Development Mode has a maximum of five authorized users, including the app owner, under the applicable Spotify rules. This is not an unrestricted public app; people not on the allow-list cannot connect.
- The developer/app owner must meet Spotify's current Development Mode eligibility requirements.

## What each visitor can do

- Each person signs in with their own Spotify account. Their OAuth tokens are stored in that browser's local storage, not shared with other visitors.
- NEEDLE reads the current playback state and displays the current track, artwork, progress and vinyl animation.
- A Spotify Free listener can play music in Spotify and have NEEDLE display it. Spotify may restrict playback-control API actions for Free accounts; they can use Spotify itself for play, pause, previous and next.
- Premium is required for Spotify playback control through NEEDLE and for the Spotify Web Playback SDK. Device availability and Spotify's API restrictions also apply.
- Each person should use their own device/browser profile. On a shared device, use **Disconnect Spotify** before another person signs in.

## Features

- Full-screen responsive turntable, sleeve artwork, animated vinyl and tonearm.
- Dynamic background colours derived from album artwork when image CORS permits.
- Current track and playback progress synchronisation.
- Playlist browsing and track selection, subject to Spotify's current API restrictions.
- Playback device picker, ambient mode, fullscreen and demo mode.
- Authorization Code with PKCE; no client secret or backend.

## Files

`index.html` · `style.css` · `app.js` · `config.js` · `manifest.webmanifest` · `icon.svg` · `apple-touch-icon.png`

## Important limitations

Spotify controls which endpoints and playlist data are available to Development Mode apps and can change those rules. The app displays API errors rather than pretending a blocked action succeeded. The Spotify Web Playback SDK is best-effort on iPad Safari; Spotify officially targets desktop browsers for that SDK. For reliable iPad playback, start audio in the Spotify app and let NEEDLE mirror it.
