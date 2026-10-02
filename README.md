# Pokemon-Novel

Pokemon alternated reality novel — and the website for reading it.

## Adding a chapter

1. Create a Markdown file in `chapters/`, e.g. `chapters/002-the-first-meeting.md`.
   Files are listed in filename order, so keep the number prefix.
2. Start it with a short header:

   ```markdown
   ---
   title: The First Meeting
   number: 2
   ---

   Your chapter text starts here.
   ```

   Use `label: Interlude` instead of `number:` for chapters that aren't numbered.
3. Push to `main`. The site rebuilds and publishes automatically.

### Formatting

| Write                         | Get                         |
| ----------------------------- | --------------------------- |
| Blank line between paragraphs | New paragraph               |
| `*italics*` / `**bold**`      | *italics* / **bold**        |
| A line with only `* * *`      | Scene break                 |
| `> text`                      | Indented passage (letters, signs, Pokédex entries) |
| `## Heading`                  | Section heading             |
| `"quotes"`, `--`, `...`       | “curly quotes”, em dash, …  |

Book title, subtitle, author and blurb live in `novel.json`.

## Preview locally

```sh
node build.mjs
python3 -m http.server -d _site
```

Then open http://localhost:8000.

## Publishing

One-time setup: in the GitHub repo go to **Settings → Pages** and set **Source** to **GitHub Actions**.
After that, every push to `main` publishes the site.

## Reader features

- Serif body text (Literata) at a comfortable line length, with light, sepia and dark themes
- Adjustable text size, font (serif/sans) and line width — remembered per reader
- Reading progress bar; the header hides while you read and returns when you scroll up
- Remembers where each reader left off, with a “Continue” button on the home page
- Previous/next chapter links, and ← / → keyboard shortcuts
