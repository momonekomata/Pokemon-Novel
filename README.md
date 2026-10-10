# Pokemon-Novel

The reading website for a serialized Pokémon alternate-reality novel: chapters, interludes, side stories
and a character/world wiki, with an author area behind a password.

This repository holds only the site's code. The novel's text lives in a separate private repository and
its illustrations in Google Drive; nothing from either is committed here.

## How it's built

`.github/workflows/cloudflare.yml` checks out the text, downloads the illustrations, builds the site
with `scripts/build.mjs` and uploads it to Cloudflare Pages. It runs after each push to the text
repository, after each push here, every 6 hours, and on demand. A copy can also run on a NAS
(`docker-compose.yml`, `nas/`).

What gets published is set in `site.config.json`: which wiki sections are public, which headings and
statuses are held back, and file-name patterns for chapters and interludes. Author-area pages are
encrypted in the build (PBKDF2 + AES-256-GCM) and only open with the author password.

## Reader features

- Clean, adjustable reading view: serif/sans, text size, line width, light/sepia/dark
- Chapters grouped into arcs; side stories grouped in reading order
- A "Before you read" box for interludes: the story's intro, the point of view, and newcomers
- Character cards on first mention, and a spoiler shield for characters not met yet
- Illustrations between paragraphs, search, "Latest updates" and "What changed" pages
- Extras: a "Who Said It?" quiz and a "Cast Shuffle" prompt toy, both behind the spoiler shield and both
  growing with the story. The quiz mixes the lines in `Quiz_Lines.md` (text repository) with lines mined
  from every chapter, the speaker worked out from the prose (speech tags, action beats, first-person
  narrators, she/he, back-and-forth dialogue) and a hint built from the same prose. Cast Shuffle deals met
  characters, places (`Cast_Shuffle.md`, plus places linked to a chapter on the wiki's locations page),
  moods and sparks.
- Author area: the full wiki, reference files, a build report, a tidy board for the wiki's punch list,
  and writing stats

## Working locally

```sh
npm install
CONTENT_DIR=path/to/content AUTHOR_PASSWORD=… npm run preview   # build and serve on http://localhost:8000
```

`CONTENT_DIR` is a folder laid out like the text repository (Markdown at the top, `wiki/` beneath, an
`illustrations/` folder for pictures).
