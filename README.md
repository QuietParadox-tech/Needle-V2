# NEEDLE — a Spotify vinyl player

A full-screen record-player view of whatever Spotify is playing: album sleeve on the left, spinning vinyl in the middle, tonearm on the right, background tinted from the cover art. Plain HTML/CSS/JS, no build step, no backend.

NEEDLE **displays and remote-controls** Spotify, and can also **play the audio itself**: it uses Spotify's Web Playback SDK to register the open page as a Spotify device called "NEEDLE" (Premium only). Turn it on or off in the device picker. With it on, you don't need the Spotify app open; pick a song and it plays in the page. Keep the page open and the screen awake while listening, since iOS pauses web pages in the background. You can still send audio to another device from the same picker.

## What Spotify currently allows (checked Oct 2026)

- **Auth:** Authorization Code + PKCE only. The implicit grant and `localhost` / plain-HTTP redirect URIs were removed on 27 Nov 2025. NEEDLE uses PKCE, so there is **no client secret** anywhere.
- **Development Mode (Feb/Mar 2026 rules):** the app *owner* must have Premium; one Client ID per developer; max **5 authorized users** per app; some endpoints were removed. The player endpoints NEEDLE uses (`/me/player`, `/play`, `/pause`, `/next`, `/previous`, `/seek`, `/devices`) were not on the removal list I found, but I could not test against a live account, so verify on first run.
- **Playback control needs Premium** (you have it). Spotify can also refuse commands during ads or on some devices; NEEDLE shows the error and never fakes success.
- **Scopes requested:** `user-read-playback-state`, `user-modify-playback-state`, `playlist-read-private`, `playlist-read-collaborative`, `user-library-read` (list your playlists and saved songs), `user-read-recently-played` (the Recently Played shelf), `user-library-modify` (the heart button; asked for at login, and if your login predates it the heart offers a one-tap Reconnect), `streaming`, `user-read-email`, `user-read-private` (needed by Spotify to play audio inside the page). Nothing else. If you connected before the Record Room existed, only the Recently Played shelf needs it, so everything else keeps working until you tap Reconnect there.

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

- Vinyl spins while playing, stops on pause; tonearm lifts and drops on track change and slowly tracks across the record. Next/previous: the song pauses and the tonearm lifts, the new record's label swaps in, then the tonearm lowers and only then does the new song start.
- Sleeve, label and background update with each track; colours are sampled from the real cover art.
- Up next: the queue icon (or **Q**) shows what's playing and what's queued. Tap a song to skip ahead to it (Spotify has no direct jump, so NEEDLE skips forward that many times).
- Background: tinted from the real colours of the current cover (dominant colour, a second accent colour and a dark base), cross-fading between songs and drifting slowly. Greyscale covers fall back to their greys.
- Record Room: the crate icon (or **P**) slides a 1970s record-shop cabinet in from the right, with the player still visible behind it. Sections: **All Songs** (saved songs + the first 30 of your playlists + recent plays, de-duplicated), **Playlists**, **Albums**, **Recently Played**, **Liked Songs**. Every song is a sleeve with its own album artwork, title, artist, album and a play button. Tap the artwork for details, tap the title or play button to play that exact track (full tracks through the same Spotify playback as the rest of NEEDLE, never 30-second previews). Tap a playlist or album to open its songs, with a Back button. Search filters instantly, **Shuffle collection** plays a shuffled batch, the playing record gets a glowing frame with an equalizer badge, and a "Now spinning" strip keeps pause/play in reach. When you play something, the record slides out of its sleeve (and from then on is an exact copy of the turntable record, with the new song's gold label on it), the drawer slides shut and the record is shown to the screen under a soft spotlight while the old record is lifted off and the tonearm swings back to rest, then it is set down on the platter and the tonearm comes down last. The song only starts once the tonearm is lowering onto the record (a song that was already playing is stopped the moment you tap), and if Spotify refuses, the tonearm goes back to rest and an error shows. Reduce Motion skips the flight. Close with the X, a tap outside, **Esc**, or by swiping the header to the right. Playlists Spotify won't let NEEDLE read (often ones you don't own) say so instead of showing nothing. Header counts come from your account.
- Look: **Retro** is the default (the 1970s record-shop style shared with the Record Room: Shrikhand and typewriter type, burnt orange / butter / cream paper, walnut-grain player panel, chunky push-down buttons, cream sleeve border, orange pressing label, paper-card dialogs, halftone grain). The settings (cog) menu's Retro look switch changes to the **Classic** look (the original minimal style) and remembers the choice on this device. Fonts load from Google Fonts; Georgia and American Typewriter are the fallbacks.
- Fit: the scene scales and nudges itself (transforms only) so the record always sits between the top bar and the player panel on any screen; on short landscape screens the panel becomes one slim row. The page canvas carries a horizontal copy of the cover colours so any strip iPadOS paints outside the page matches the background.
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

The look setting covers everything: in Classic the Record Room, dialogs, lyrics and menus all use the original minimal style (dark glass, cream type, gold accents); the cabinet, wood, stickers and typewriter type only appear in Retro.

## Extras in the settings menu
- **Shuffle** (H) and **Repeat** (R: off → all → this song) use Spotify's own shuffle/repeat on whatever device is playing.
- **Volume** slider sets the playing device's volume. (On iPhone/iPad Safari the NEEDLE browser player itself always follows the device's volume buttons; the slider works for Spotify Connect devices.)
- **Sleep timer** (15 / 30 / 45 / 60 min): when it ends the tonearm lifts and the music stops.
- **Lock-screen controls**: the title, artist and cover show in the iOS / Android / desktop media controls, with play, pause, next, previous and seek.
- **Like** heart next to the transport buttons saves / removes the song in Liked Songs. **Share song** (menu) opens the share sheet or copies the link. **Add to queue** is in a song's details in the Record Room. **Swipe** the album sleeve left / right for next / previous.

## Customize (Menu → Customize…)
- **Record speed** – Lazy, Slow, 33⅓ rpm.
- **Vinyl colour** – Black, Crimson, Navy, Forest, Amber, Ivory.
- **Background** – *Cover colours* (follows the album art), Default, Espresso, Midnight, Pine, Wine or Sunset. Works in both looks.
- **Record label** – Orange, Gold, Cream, Teal, Pink, Red, or *Cover colours* (follows the album art). Works in both Retro and Classic.
- **Retro colours** – Ember, Teal, Avocado, Plum, Cobalt accent palettes.
- **Clock in Ambient mode** – an animated dial with a sweeping second hand, a digital readout, a greeting and the date; styled per look. And a **Film grain** toggle.
- **Reset to defaults**. Everything is saved in your browser (`localStorage: needle.custom`).

## Lock screen / Control Centre
iOS shows the Spotify player's hidden iframe ("Spotify Embedded Player") as the Now Playing app. NEEDLE plays a silent looping audio clip of its own and sets Media Session metadata (title, artist, artwork) so the song can appear there. This is a best-effort workaround and can vary by iOS version.

## Options menu
The gear menu stays open until you press **Close** (top or bottom), tap the gear again, or press Esc.

## More Customize options (Build 38)
- **Clock style** – Dial + digital, Dial only or Digital only, plus a **24-hour clock** switch.
- **Auto Ambient mode** – switches to Ambient by itself after 1, 5 or 10 minutes without a touch while a song plays (never while a menu or panel is open).
- **Vinyl crackle** – a soft synthesised hiss and pops under the music (it is NEEDLE's own sound, mixed with Spotify's audio).

## Build 39: stack, patterns, tour
- **Record Room → Stack** (default; the Grid button switches back): your records as a 3D stack. Drag, scroll, or use the arrow keys; tap the front record (or ▶ Play) and it slides out of its sleeve onto the turntable. A soft glow of the cover colours fills the room behind it.
- **Vinyl pattern** (Customize): Solid, Splatter, Starburst, Marble – painted from each song's cover colours.
- **Record label → Cover art**: the whole album cover on the label.
- **Take the tour** (menu): a seven-step guided tour. It also appears once on first run.

## Build 40
Customize is now grouped (The record / Record Room / Colours / Clock and Ambient mode / Extras) and every new feature has a switch: Record Room view (3D stack or Grid), the record peeking out of its sleeve, the cover-colour glow, vinyl pattern, cover-art label, crackle, and a button to replay the tour. In wide drawers the stack is a true stack with the song details beside the record, so there is no empty space.

## Build 41
New switch in Customize → The record → **Dust and scratches**: fine specks and hairline scratches on the vinyl that spin with it.

## Build 42
Fix: the song Details panel now opens on top of the 3D stack instead of showing the stack through it.
