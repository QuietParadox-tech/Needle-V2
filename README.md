# NEEDLE — a Spotify vinyl player

A full-screen record-player view of whatever Spotify is playing: album sleeve on the left, spinning vinyl in the middle, tonearm on the right, background tinted from the cover art. Plain HTML/CSS/JS, no build step, no backend.

NEEDLE **displays and remote-controls** Spotify, and can also **play the audio itself**: it uses Spotify's Web Playback SDK to register the open page as a Spotify device called "NEEDLE" (Premium only). Turn it on or off in the device picker. With it on, you don't need the Spotify app open; pick a song and it plays in the page. Keep the page open and the screen awake while listening, since iOS pauses web pages in the background. You can still send audio to another device from the same picker.

## What Spotify currently allows (checked Oct 2026)

- **Auth:** Authorization Code + PKCE only. The implicit grant and `localhost` / plain-HTTP redirect URIs were removed on 27 Nov 2025. NEEDLE uses PKCE, so there is **no client secret** anywhere.
- **Development Mode (Feb/Mar 2026 rules):** the app *owner* must have Premium; one Client ID per developer; max **5 authorized users** per app; some endpoints were removed. The player endpoints NEEDLE uses (`/me/player`, `/play`, `/pause`, `/next`, `/previous`, `/seek`, `/devices`) were not on the removal list I found, but I could not test against a live account, so verify on first run.
- **Playback control needs Premium** (you have it). Spotify can also refuse commands during ads or on some devices; NEEDLE shows the error and never fakes success.
- **Scopes requested:** `user-read-playback-state`, `user-modify-playback-state`, `playlist-read-private`, `playlist-read-collaborative`, `user-library-read` (list your playlists and saved songs), `user-read-recently-played` (the Recently Played shelf), `streaming`, `user-read-email`, `user-read-private` (needed by Spotify to play audio inside the page). Nothing else. If you connected before the Record Room existed, only the Recently Played shelf needs it, so everything else keeps working until you tap Reconnect there.

## 1. Create the Spotify app (once)

1. Go to <https://developer.spotify.com/dashboard> (signed in to your Premium account) → **Create app**.
2. Name: `NEEDLE`. API/SDK: tick **Web API**.
3. **Redirect URI:** the exact address where NEEDLE will be hosted, including the trailing slash:
   - GitHub Pages: `https://YOURNAME.github.io/needle/`
   - Local testing: `http://127.0.0.1:8080/` (must be `127.0.0.1`, not `localhost`)
   
   NEEDLE's first-run screen shows the exact URI it will send; copy that.
4. Save, open **Settings**, copy the **Client ID** (not the secret).
5. Under **User Management**, make sure your own Spotify account email is listed.

## 2. Configure the shared Client ID (owner only)

Paste the app owner's Client ID into `config.js` (`CLIENT_ID: "..."`) and redeploy. Every visitor uses this same app Client ID and signs in with their own Spotify account. Friends do **not** create developer apps or enter Client IDs. Add each permitted tester's Spotify account to the app's User Management list. A Client ID is public by design; never publish a Client Secret. The first-run screen now only shows the redirect URI and explains when the owner has not configured the app.

## 3. Deploy to GitHub Pages

1. Create a GitHub repo named `needle`, upload all files in this folder to the root.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main` / `/ (root)`.
3. Wait a minute, open `https://YOURNAME.github.io/needle/`.
4. Make sure that exact URL (with trailing slash) is in the Dashboard's Redirect URIs.

Local test instead: `python3 -m http.server 8080 --bind 127.0.0.1`, then open `http://127.0.0.1:8080/`.

## 4. Use it on iPad

1. Open the URL in Safari → **Connect Spotify** → approve.
2. Start music in the Spotify app (or tap the device icon in NEEDLE to choose where it plays).
3. Share → **Add to Home Screen** for a chrome-free full-screen launch.
4. Eye icon = ambient mode (hides controls; tap the scene to peek). Screen stays awake while playing where iPadOS allows it.

## Features

- Vinyl spins while playing, stops on pause; tonearm lifts and drops on track change and slowly tracks across the record.
- Sleeve, label and background update with each track; colours are sampled from the real cover art.
- Up next: the queue icon (or **Q**) shows what's playing and what's queued. Tap a song to skip ahead to it (Spotify has no direct jump, so NEEDLE skips forward that many times).
- Background: tinted from the real colours of the current cover (dominant colour, a second accent colour and a dark base), cross-fading between songs and drifting slowly. Greyscale covers fall back to their greys.
- Record Room: the crate icon (or **P**) slides a 1970s record-shop cabinet in from the right, with the player still visible behind it. Sections: **All Songs** (saved songs + the first 30 of your playlists + recent plays, de-duplicated), **Playlists**, **Albums**, **Recently Played**, **Liked Songs**. Every song is a sleeve with its own album artwork, title, artist, album and a play button. Tap the artwork for details, tap the title or play button to play that exact track (full tracks through the same Spotify playback as the rest of NEEDLE, never 30-second previews). Tap a playlist or album to open its songs, with a Back button. Search filters instantly, **Shuffle collection** plays a shuffled batch, the playing record gets a glowing frame with an equalizer badge, and a "Now spinning" strip keeps pause/play in reach. When you play something, the record lifts out of its sleeve, flies across to the turntable and lands on the platter while the drawer slides shut (skipped if your device's Reduce Motion setting is on, and never shown if Spotify refuses to play). Close with the X, a tap outside, **Esc**, or by swiping the header to the right. Playlists Spotify won't let NEEDLE read (often ones you don't own) say so instead of showing nothing. Header counts come from your account.
- Dark mode: the moon/sun button in the top bar of the main page turns the cover-colour background into a really dark shade of the same colours, and it keeps following each new song's cover. The Record Room cabinet goes dark too. It follows your device's light/dark setting until you press the button, then remembers your choice on this device.
- Lyrics: the lines icon (or **L**) blurs the album sleeve and shows time-synced lyrics on it while the record keeps spinning. The current line is highlighted and scrolls with the song. Scroll the lyrics yourself to read ahead or back (a "Back to current line" button appears, and following resumes by itself after about 5 s), and tap any line to start playing from there, even if the song is paused. Your choice is remembered. Tracks with only unsynced lyrics show as a scrollable page; instrumentals and tracks with no match say so.
- Turntable gestures: tap the tonearm, or drag it off/onto the record, to pause/play. Turn the record by hand to scrub: clockwise fast-forwards, anticlockwise rewinds (one full turn = 30 s), with synthesised vinyl scratch sounds that follow your speed and direction (speaker icon or **S** turns them off). While you turn the record the song is paused so only the vinyl sounds are heard; the tonearm lifts off the record, and both come back (arm last) from the new spot when you let go. The arm and the time only settle if Spotify accepts the command.
- Full screen: the scene is sized from the real visible area, so it fits the whole screen in any orientation and after entering full screen. The full-screen button works on iPad and desktop; on iPhone Safari it shows how to add NEEDLE to the Home Screen, which is the way to get true full screen there (the button hides itself when launched from the Home Screen).
- Controls: play/pause, previous, next, click-to-seek, device picker. Keyboard: Space, ← →, P (playlists), L (lyrics), A (ambient), F (fullscreen).
- Polls Spotify every 3 s (6 s paused) and interpolates progress locally; pauses polling when the tab is hidden.
- Demo mode (`?demo`, or the link on the first screen) uses made-up tracks and is labelled as such.

## Lyrics source and privacy

There is no single free lyrics service that is perfectly reliable, and Spotify's own lyrics are not available through its public API. So NEEDLE uses the best open source and defends against its weak spots:

1. **LRCLIB** ([lrclib.net](https://lrclib.net), free, no key, time-synced) is the main source. NEEDLE asks for an exact match, then widens to a search (title with "Remastered / Live / feat." stripped, all artists tried), and **rejects results whose length differs by more than 10 s** so you never get timings from the wrong edit. Failed requests are retried automatically.
2. If LRCLIB has nothing, **lyrics.ovh** is tried for plain (unsynced) text.
3. If both fail you get an honest message with **Try again** (network trouble) or **Search manually** (no match). The manual picker searches LRCLIB, shows length and whether each result is synced, and your choice is remembered.
4. **Change lyrics** (top of the lyrics view) reopens that picker for any track.

Results, including your manual picks, are saved in this browser (last 80 tracks), so replays need no network. Privacy: with lyrics on, the track's title, artist, album and length go to lrclib.net, and the title and first artist also go to api.lyrics.ovh if LRCLIB finds nothing. Nothing is sent while lyrics are off. `?demo` mode uses invented lyrics.

## Known limits

- Only one device plays at a time; if nothing is active Spotify returns "no device" and NEEDLE tells you to open Spotify or pick a device.
- Tokens live in this browser's `localStorage` (normal for a static PKCE app). "Disconnect" clears them.
- If your Premium lapses, Development Mode apps stop working.
- Cover-art colour sampling needs Spotify's image CDN to allow CORS; if a cover can't be sampled the background falls back to the default bronze palette.
- Lyrics logic was tested against mocked LRCLIB / lyrics.ovh responses, not the live services (lyrics.ovh availability and browser access are unverified).
- Not tested against a real Spotify account or on a physical iPad (see delivery notes).

## Files

The Record Room headings use the Google Fonts *Shrikhand* and *Special Elite* (loaded from fonts.googleapis.com; if they can't load, serif and typewriter system fonts are used instead).

`index.html` · `style.css` · `app.js` · `config.js` · `manifest.webmanifest` · `icon.svg` · `apple-touch-icon.png`
