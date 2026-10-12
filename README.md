# Notebook → Notes

A mobile-friendly, static web app that turns a photo of handwritten notes or a whiteboard into organized, editable Markdown. The frontend calls Google’s Gemini API directly; there is no backend, proxy, analytics, or third-party runtime library.

## Run locally

This app uses plain HTML, CSS, and JavaScript—there is no build step.

```sh
cd notebook-to-notes
python3 -m http.server 8000
```

Open `http://localhost:8000`. A local HTTP server is needed for camera permissions and the service worker; opening `index.html` as a `file://` URL is not recommended.

## Get a Gemini API key

1. Open [Google AI Studio](https://aistudio.google.com/app/apikey) and sign in.
2. Create an API key.
3. On the app’s first-launch setup screen, paste the key and save it. You can test it first.

The key is stored in this browser’s `localStorage` and sent only to Google’s Gemini API in an `x-goog-api-key` request header. It is never sent to an app server, analytics service, or other third party. Use **Settings → Delete key** to remove it from this browser. Anyone with access to this browser profile may be able to inspect its local storage, so do not save a key on a shared device.

**Free-tier privacy:** Google may use submitted data to improve its models on the free tier. Do not upload sensitive or personal content.

## Images and privacy

Photos are decoded, resized to a maximum 2,000 px on the long side, and contrast/lighting adjusted in browser memory. They are not written to `localStorage`, IndexedDB, Cache Storage, or an app server. A photo is included in a Gemini API request only when you convert it (or explicitly choose **Try harder** / a strip retry). Requests set `store: false` so interactions are not saved for later API retrieval; Google’s separate free-tier data-use policies still apply. The service worker caches only app shell files, never photos or API responses. Closing or reloading the page releases the in-memory images.

## Use

1. Choose a subject and note language.
2. Tap **Take a photo** or select an existing image. For better recognition, use bright, even light and photograph the page from directly above.
3. Optionally crop or rotate, then choose **Convert to notes**. The normal conversion uses one Gemini request; 429 responses are retried with exponential backoff.
4. Review and edit the result. Yellow uncertain words can be tapped to choose a suggestion or enter a correction.
5. **Try harder on a crop** is shown only when the transcription contains several unreadable `[???]` marks. It sends one user-selected crop in a follow-up request. If the whole-page reading fails or remains very unclear, you can explicitly choose **Read in strips**; that option sends three overlapping horizontal crops and uses extra calls.
6. Add pages to the same note, copy the Markdown, or download `.md` / `.txt`.

The small counter in the header tracks Gemini API requests made today in this browser. It counts key tests and retry attempts too.

## Deploy free with GitHub Pages

1. Create a GitHub repository.
2. Copy the **contents** of this `notebook-to-notes` folder to the repository root (so `index.html` is at the root).
3. Push the files to the `main` branch.
4. In the repository, open **Settings → Pages**.
5. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/(root)`, then save.
6. Open the published Pages address and add it to your phone’s home screen using the browser’s install/share menu.

The manifest, service worker, relative asset paths, and static hosting are compatible with GitHub Pages project sites. Netlify and Vercel static hosting work too.

## Model setting

The editable default model ID is `gemini-3.8-flash` (checked against the Gemini model catalog on October 12, 2026). Model availability, names, and free-tier limits can change. Use **Settings → Model name** to enter another model ID available to your key, and **Test key** to check the current key/model combination.
