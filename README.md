# Pokemon-Novel

Pokemon alternated reality novel, and the website for reading it.

The site is built from the novel's Google Drive folder (**Pokemon Novel - Reference Files and Chapters**).
Every hour a GitHub Action pulls the Markdown files from Drive, rebuilds the site and publishes it to
GitHub Pages. Nothing from Drive is committed to this repository; the only thing the Action commits back
is `data/updates.json`, the revision log behind "Latest updates".

## What gets published

**Reader tier (public)**

- **Chapters**: `Chapter_NN_-_Title.md` files in number order. Interludes that have a reading slot in
  `wiki/plot/interlude-index.md` (22.5, 29.5 …), or whose file name carries one (`Chapter_29_5_-_…`),
  are slotted in between.
- **Side stories**: every other `Interlude_-_….md`, in the order the interlude index mentions them.
- **Latest updates**: new chapters, and chapters whose prose changed. A change is detected by comparing
  the text readers see, so a file that is only re-saved or touched in Drive doesn't count.
- **Wiki**: `wiki/characters` and `wiki/world`, with author material stripped: the Type/Status line,
  source citations, dated rulings, and the Sources / Continuity notes / Open threads sections.
  Pages whose status starts with CANDIDATE or PLANNED, and `characters/future-roster.md`, are left out.
  Links to pages readers can't see become plain text.
- The italic `*( … )*` author note at the top of an interlude is hidden.

**Author tier (password)**

Footer → **Author**. Everything under `wiki/` unfiltered, plus the reference files at the folder root
(Characters.md, Plot_Threads.md, Change_Log.md …). Each page is encrypted (AES-256-GCM, with a key
derived from the password by PBKDF2) before it's published, so without the password the files can't be
read even by opening them directly. The browser remembers the key until you sign out.

All of these rules live in `site.config.json`: which sections are public, which headings to strip, which
statuses to hide, and files to exclude (e.g. `Interlude_-_Seven_Hundred_And_Forty-Three.md`, which became Ch. 42).

## Hosting on a Synology NAS instead

To run the site on your own NAS, visible only on your Tailscale network, follow
[nas/README.md](nas/README.md). It replaces GitHub Pages and the secrets below with a
`settings.env` file on the NAS.

## One-time setup (GitHub Pages)

### 1. Let the Action read your Drive folder

1. Go to [Google Cloud Console](https://console.cloud.google.com/), create a project (any name).
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **IAM & Admin → Service Accounts → Create service account** (any name, no roles needed).
4. Open the service account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
5. In Google Drive, **Share** the folder *Pokemon Novel - Reference Files and Chapters* with the service
   account's email (`…@….iam.gserviceaccount.com`) as **Viewer**.

### 2. Add two repository secrets

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The entire contents of the downloaded `.json` key file |
| `AUTHOR_PASSWORD` | The password for the author area. Use a long one: it is the only thing protecting the encrypted pages. |

### 3. Turn on Pages

**Settings → Pages → Source: GitHub Actions.** Then run the workflow once from the **Actions** tab
(*Sync from Drive and publish → Run workflow*), or just wait for the next hour.

To sign everyone out of the author area, change `AUTHOR_PASSWORD` (and optionally `authorTier.salt` in
`site.config.json`).

## Working locally

```sh
npm install
GOOGLE_SERVICE_ACCOUNT_JSON="$(cat key.json)" npm run sync   # mirror Drive into content/
AUTHOR_PASSWORD=… npm run preview                              # build and serve on http://localhost:8000
```

You can also point the build at any folder laid out like the Drive folder: `CONTENT_DIR=path npm run build`.

## Reader features

- Serif body text (Literata) at a comfortable line length, with light, sepia and dark themes
- Adjustable text size, font (serif/sans) and line width, remembered per reader
- Reading progress bar; the header hides while you read and comes back when you scroll up
- Remembers where each reader left off, with a "Continue" button on the home page
- Previous/next chapter links, and ← / → keyboard shortcuts
- Wiki filter box for finding a character or place quickly
