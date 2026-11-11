# The iPhone app

The app is in `mobile/`. It is a React Native app built with Expo (SDK 58), so it can
be developed on Windows or Linux and built for iPhone in Expo's cloud. No Mac needed.

## Run it on your iPhone today (free)

1. Start the server on your PC:

   ```bash
   docker compose -f deploy/docker-compose.dev.yml up -d --build
   ```

2. Start the app's dev server:

   ```bash
   cd mobile
   npm install
   npx expo start
   ```

3. Install **Expo Go** from the App Store and scan the QR code with the iPhone camera.
   The phone and the PC must be on the same Wi-Fi.
4. Log in:
   - Server: `http://<your PC's IP address>:8000` (find the IP with `ipconfig`)
   - Email: `admin@pivault.dev`
   - Password: `pivault-dev-pass`

If the QR code does not connect, run `npx expo start --tunnel` instead.

Once the Pi is running, log in to it instead: server `pivault.<your-tailnet>.ts.net`,
with the email and password from `sudo pivault-info`. Tailscale must be connected on
the phone.

### What works in Expo Go

Everything except background backup: login, the timeline, the viewer, video, Files,
uploads, downloads, the trash, and camera-roll backup while the app is open.

Expo Go is a shared sandbox app, so two things differ from your own build:

- **Background backup** does not run. iOS only wakes apps that registered their own
  background task, and Expo Go cannot do that on your behalf.
- **Photo access** prompts say "Expo Go" rather than "PiVault".

## Your own installed app (US$99 per year)

To get a real home-screen icon and background backup you need your own build.
Without a Mac, the only way to install one is through the Apple Developer Program.

1. Join the [Apple Developer Program](https://developer.apple.com/programs/).
2. Create a free [Expo](https://expo.dev) account.
3. In `mobile/app.json`, change `ios.bundleIdentifier` to something of your own, for
   example `com.yourname.pivault`. It must be unique across the App Store.
4. Build:

   ```bash
   cd mobile
   npx eas-cli@latest login
   npx eas-cli@latest build --platform ios --profile preview
   ```

   The first build asks you to sign in to your Apple account and registers your
   iPhone. Expo builds and signs the app in the cloud (about 15 minutes).
5. Open the link it prints on your iPhone to install.

For TestFlight instead, use `--profile production` and then
`npx eas-cli@latest submit --platform ios`.

After the one-time signing setup, the **EAS build (iOS)** workflow in GitHub Actions
can start builds for you.

## How backup behaves on iOS

- **Opening the app is what backs photos up.** A backup pass runs every time the app
  comes to the foreground.
- **Started uploads finish.** Uploads use iOS background transfers, so files already
  handed to iOS keep going if you switch apps or lock the phone.
- **Background backup is a bonus.** With your own build, the app asks iOS to wake it
  now and then. iOS decides when, based on battery, network and how often you use the
  app. It is often overnight while charging, and can be many hours apart.
- **Wi-Fi only** is on by default. 4K video is roughly 400 MB per minute.
- **Nothing is uploaded twice.** The app keeps a local record of what is backed up, the
  server knows each camera-roll item, and identical files are stored once.
- **Photos kept only in iCloud** ("Optimise iPhone Storage") have to be downloaded by
  iOS before they can be uploaded, so the first backup of a large library takes time.

Keep iCloud Photos turned on until you have restored from a PiVault backup at least once.

## The web version

The same code runs in a browser. On the Pi it is served at the root of the PiVault
address, so `https://pivault.<tailnet>.ts.net` works from any computer on your tailnet.
Camera-roll backup is iPhone-only; in a browser you upload by hand.

## Project layout

```
mobile/
  src/app/            screens (expo-router): login, (tabs)/index|files|backup|settings,
                      viewer/[id], trash
  src/components/     shared UI: grid thumbnail, dialogs, progress ring
  src/lib/            API client, login session, backup engine, local backup ledger
  e2e/                Playwright tests and sample media
```

Files ending in `.web.ts` are the browser versions of a module. For example
`backup.ts` reads the camera roll, and `backup.web.ts` explains that a browser cannot.

## Checks

```bash
npm run typecheck     # TypeScript
npm run lint          # ESLint
npm run build:web     # bundle for the browser
npm run test:e2e      # Playwright, needs the dev server stack running
```

## What has and has not been tested

Tested automatically:

- The app's screens and flows, in a browser, against a real server: login and errors,
  upload (JPEG, HEIC, video), duplicates, the timeline, the viewer, video playback and
  seeking, download, trash and restore, multi-select, folders, rename, move, storage
  stats, session recovery after an expired token, logout. 17 Playwright tests.
- The iOS bundle compiles, and the code type-checks against the Expo SDK 58 APIs.

Not tested, because they need a real iPhone:

- **Camera-roll backup.** The scan, the permission prompts and the background uploads
  are written against the SDK 58 media-library and file-system APIs but have never run
  on a phone. Expect to fix small things the first time.
- **Background backup**, which also needs your own build.
- **Pinch to zoom**, save to camera roll, and the share sheet.
- Behaviour with a very large library (tens of thousands of photos).

If backup misbehaves, the place to look is `src/lib/backup.ts`. The Backup tab shows
the error message from the last run.
