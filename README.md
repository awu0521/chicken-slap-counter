# chicken-slap-counter

Counts how many times you slap a raw chicken breast, using your webcam and
[MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker).
Everything runs in the browser; the server only serves static files.

## Using it

Click **Start camera**, then drag a box around the chicken. The stopwatch in
the bottom-left starts and stops independently of the counter. Settings live
in the slide-out drawer behind the top-right button (Esc closes it).

## How it detects a slap

1. Hand Landmarker tracks your palm (midpoint of wrist and middle knuckle) each frame.
2. A slap = fast palm movement **toward the chicken** followed by a sudden stop
   on the box you drew. Direction-free, so it works with the phone upright, on
   its side or with rotation lock on; the wind-up (moving away from the chicken)
   is ignored. A hand that vanishes mid-swing toward the chicken (motion blur)
   also counts.
3. Optional: with "Require slap sound" on, the motion must coincide (±150 ms)
   with a loud transient from the mic. This cuts false positives a lot.
4. 250 ms cooldown so one slap isn't counted twice.

## Setup tips

- Film from the **side**, roughly level with the counter, so the downward swing
  is visible in the image. Overhead views track poorly.
- Bright light and a 60 fps camera reduce motion blur.
- Light-coloured nitrile gloves track fine; black gloves may not.
- Tune the speed threshold by watching the blue meter while you slap: set the
  red mark below your slap peaks but above normal hand movement.

## Run locally

Camera access needs `localhost` or HTTPS.

```sh
npx wrangler dev          # http://localhost:8787
# or: python3 -m http.server -d public 8000
```

## Deploy to Cloudflare

```sh
npx wrangler login
npx wrangler deploy
```

This deploys `public/` as a static-assets Worker (see `wrangler.jsonc`). You can
also connect the repo in the Cloudflare dashboard (Workers & Pages → Create →
import from Git) with the build output directory set to `public`.
