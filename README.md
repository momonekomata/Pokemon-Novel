# Pokemon-Novel

Pokemon alternated reality novel, and the website for reading it.

The site is built from the novel's Google Drive folder (**Pokemon Novel - Reference Files and Chapters**).
Every hour a GitHub Action pulls the Markdown files from Drive, rebuilds the site and publishes it to
Cloudflare Pages (free, always on; setup in [cloudflare/README.md](cloudflare/README.md)). A second copy
can run on a Synology NAS over Tailscale ([nas/README.md](nas/README.md)). Nothing from Drive is committed
to this repository.

## What gets published

**Reader tier (public)**

- **Chapters**: `Chapter_NN_-_Title.md` files in number order. Interludes that have a reading slot in
  `wiki/plot/interlude-index.md` (22.5, 29.5 …), or whose file name carries one (`Chapter_29_5_-_…`),
  are slotted in between.
- **Side stories**: every other `Interlude_-_….md`, grouped and ordered by `Side_Stories.md` (see below),
  or without it in the order the interlude index mentions them.
- **Latest updates**: new chapters, and chapters whose prose changed. A change is detected by comparing
  the text readers see, so a file that is only re-saved or touched in Drive doesn't count.
- **Wiki**: `wiki/characters` and `wiki/world`, with author material stripped: the Type/Status line,
  source citations, dated rulings, and the Sources / Continuity notes / Open threads sections.
  Pages whose status starts with CANDIDATE or PLANNED, and `characters/future-roster.md`, are left out,
  until the character is named in a published chapter or side story: then her page goes public (the
  spoiler shield still hides it from readers who haven't opened that story).
- A character page can carry its own reader-facing one-liner, written the same way as a chapter's intro:
  a line `- Intro: …` on her wiki page. It replaces the summary at the top of the page on her public page,
  her character card, the wiki list and the Before you read box, and the line itself isn't shown. Without
  one, those use the wiki summary; the build report lists characters still missing an Intro line.
  Links to pages readers can't see become plain text.
- The italic `*( … )*` author note at the top of an interlude (also when it sits under a subtitle line) is
  never shown. A **Before you read** box gives readers what they need instead:
  - for interludes and side stories, the story's one-line intro: the `- Intro:` line on its wiki manuscript page;
  - the point of view: the name from that page's `- POV:` line, or the note's "Name POV" opening, plus a
    short "first person" / "third person" if given, and who she is (species and Intro line from her public
    character page);
  - for interludes and side stories, every character appearing for the first time.

  Chapters and interludes told by Yuu skip the POV line; main chapters introduce their characters in the
  prose. Lines can be written plain (`- POV: …`) or bold (`- **POV:** …`), and a character's species can be
  `**Species:**` or `**Species and basics:**` (then the first sentence is used).

**Author tier (password)**

Footer → **Author**. Everything under `wiki/` unfiltered, plus the reference files at the folder root
(Characters.md, Plot_Threads.md, Change_Log.md …). Each page is encrypted (AES-256-GCM, with a key
derived from the password by PBKDF2) before it's published, so without the password the files can't be
read even by opening them directly. The browser remembers the key until you sign out.

All of these rules live in `site.config.json`: which sections are public, which headings to strip, which
statuses to hide, and files to exclude (e.g. `Interlude_-_Seven_Hundred_And_Forty-Three.md`, which became Ch. 42).

## Adding illustrations

Light-novel style: each picture appears as a full-width plate between paragraphs, wherever you put it.

1. In the Drive folder *Pokemon Novel - Reference Files and Chapters*, make a folder called **illustrations**
   (once) and put your pictures in it: JPG, PNG, WebP or GIF, any size.
2. In the chapter, on **its own line** with a blank line before and after, write either:

   ```markdown
   ![[ch01-sakura-evolves.png]]
   ```
   (Obsidian style: drag the image into the note in Obsidian and it writes this for you).
   To add a caption under the picture, type `|` and the caption before the closing brackets:
   `![[ch01-sakura-evolves.png|Your caption here]]`. Or use the standard form:
   ```markdown
   ![Sakura mid-evolution, ribbons everywhere](illustrations/ch01-sakura-evolves.png "Optional caption under the picture")
   ```
   The text in `[ ]` describes the picture for screen readers. The quoted part is an optional caption.
3. That's it. The next sync publishes it.

Good to know:

- The site finds a picture by its file name, so `![[name.png]]` works wherever in the folder it lives.
- Big files are shrunk automatically (1400 px wide in the page, 2400 px when tapped), so phones load quickly.
- Only pictures used in a published chapter or a public wiki page go public. Spare or spoiler art in
  the folder stays private, and pictures on author-only wiki pages are published only in the author area.
- Readers can tap a picture to see it full-screen, or switch illustrations off under the **T** (reading settings) button.
- A misspelled file name doesn't break anything: the picture is skipped and the builder log says
  `Image not found: …`.
- Works the same in wiki pages, e.g. a character portrait at the top of a character's page.

## Character cards

The first time a character's name appears in a chapter, it gets a dotted underline. Tapping it opens a
small card with her name, species, one-line summary and portrait (the first picture on her wiki page),
plus a link to the page. Readers can switch this off under the **T** button.

- Cards come from public character pages (`wiki/characters`) that have a `**Species:**` line.
- A character is found by her full page title ("Inumaru Runa") and, for two-word names, her given
  name ("Runa"). A given name shared by two characters is never linked on its own; the build report lists
  these. Add extra names in `site.config.json`, keyed by the page's file name:
  `"characterCards": { "aliases": { "inumaru-runa": ["Runa-chan"] } }`.

## Build report

The author area opens with a **Build report**, refreshed on every sync: links to missing files, missing
pictures, gaps in chapter numbers, duplicate chapter numbers, interludes not yet in the reading order,
given names too ambiguous for character cards, wiki pages held back from readers, and chapter-like files
that weren't published as chapters. The builder log also prints a one-line summary.

## Search

The magnifying glass at the top searches every chapter and public wiki page. Matching ignores capitals,
accents (ō = o) and curly vs straight quotes; several words must all appear, and `"quoted words"` must appear
together. Opening a chapter from the results highlights every match, with ↑ ↓ to jump between them.

## What changed

When a chapter's text changes, the build compares it with the previous version. "Latest updates" then
links the **Revised** chapter to a page showing just the changed passages (added words in green, removed
words struck through), and the chapter itself says "Revised … · See what changed". Only the latest revision
is shown. The previous versions are kept in `data/snapshots/` on the NAS (never committed); the first build
after this feature only records them, so differences show from the next edit on.

## Spoiler shield

Readers only see characters they've met. A character counts as met once the reader has opened a chapter
that mentions her (worked out from where her character card first appears). Until then her wiki card is
blurred ("Not met yet · tap to peek"), her page opens behind a "Show anyway" veil, and her page is left out
of search results. Readers can turn the shield off under the **T** button. Progress is per device.

## Arcs in the contents

Put a file called **Arcs.md** at the top of the Drive folder, with one line per arc giving the chapter it
starts at:

```markdown
# Arcs

- Chapter 1: The Overwrite
- Chapter 10: Campus Qualifiers
```

The chapter list then groups chapters (and the interludes between them) under those headings, and each
chapter shows its arc next to its number. No Arcs.md means no grouping.

## Side story groups

Put a file called **Side_Stories.md** at the top of the Drive folder. Each `## ` heading is a group, and
the list under it gives its side stories in reading order, by title:

```markdown
## Runa, after the awakening
Read these after the confrontation, in this order.

1. Water Resistance — first: Yuu-kun-sama's debut
2. The Hypocrisy Coefficient
```

A line of text right under a heading is shown to readers as the group's note. Anything after ` — ` on a
list line is a private reminder and isn't shown. The contents then show the side stories under those
headings, previous/next follows that order, and each story shows its group next to "Side story". Side
stories you haven't listed come last, under "More side stories"; the build report lists them, and any line
that matches no side story. A title, a file name or an Obsidian `[[link]]` all work, and a leading
"The" doesn't matter.

## Writing stats

In the author area: total words, words this week and over the last 30 days, chapter counts, average and
longest chapter, a chart of total words over time (hover or use ← → for exact numbers, or open it as a
table) and words per chapter. The history is one total per day, kept in `data/stats.json` on the NAS.
The first build estimates earlier days from when each chapter file was created in Drive.

## Hosting on Cloudflare Pages (free)

Follow [cloudflare/README.md](cloudflare/README.md): a free Cloudflare account, four GitHub secrets, and
optionally Cloudflare Access so only people you list can open the site. The workflow is
`.github/workflows/cloudflare.yml`; it keeps the revision log and "What changed" snapshots in the
Actions cache, never in git.

## Hosting on a Synology NAS instead

To run the site on your own NAS, visible only on your Tailscale network, follow
[nas/README.md](nas/README.md). It replaces GitHub Pages and the secrets below with a
`settings.env` file on the NAS.

## One-time setup (GitHub Pages)

The workflow in `.github/workflows/pages.yml` is manual-only right now, because the site runs on the NAS.
To use GitHub Pages instead, restore its `push` and hourly `schedule` triggers (see the comment in that file).

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
- Illustrations between paragraphs; tap to view full-screen, or switch them off
- Character cards: tap a character's name for a quick reminder of who she is
- Search across every chapter and wiki page, with matches highlighted in the chapter
- "What changed" pages for revised chapters
- Spoiler shield: characters you haven't met yet stay hidden in the wiki and search
- Chapters grouped into arcs, side stories grouped in reading order
