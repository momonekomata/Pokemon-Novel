// Parses the wiki's punch list (wiki/tidy-report.md) and wiki/ambiguities.md into items for the
// author area's Tidy board. The report's own format rules live in the vault's CLAUDE.md § TIDY:
// Open items carry "· CHECK: …" and "last verified YYYY-MM-DD"; decisions carry no check; Resolved
// items sit under one "### " heading per fix pass.

const FILE_RE = /([A-Za-z0-9_\-/.']+\.md)\b/g;

function kindOf(heading) {
  const h = heading.toUpperCase();
  if (/DECISION/.test(h)) return "decision";
  if (h.startsWith("OPEN")) return "open";
  if (h.startsWith("RESOLVED")) return "resolved";
  return null;
}

// Top-level list items ("- …" or "12. …") with their indented continuation lines.
function listItems(lines) {
  const items = [];
  let cur = null;
  for (const line of lines) {
    const li = line.match(/^(?:(\d+)\.|-)\s+(.*)$/);
    if (li) {
      cur = { num: li[1] || null, text: li[2] };
      items.push(cur);
    } else if (cur && /^\s{2,}\S/.test(line)) cur.text += " " + line.trim();
    else cur = null;
  }
  return items;
}

function enrich(item, kind, group) {
  let text = item.text;
  let check = null;
  let verified = null;
  const ci = text.search(/·\s*CHECK:/);
  if (ci >= 0) {
    check = text.slice(ci).replace(/^·\s*CHECK:\s*/, "");
    text = text.slice(0, ci).trim();
    verified = check.match(/last verified (\d{4}-\d{2}-\d{2})/i)?.[1] || null;
    check = check.replace(/\s*·\s*last verified.*$/i, "").trim();
  }
  let title = "";
  let body = text;
  const bold = text.match(/^\*\*(.+?)\*\*\s*(.*)$/);
  if (bold) [title, body] = [bold[1], bold[2]];
  else {
    const cut = text.search(/\.\s|:\s|\s—\s/);
    if (cut > 0 && cut < 140) [title, body] = [text.slice(0, cut + 1), text.slice(cut + 1).trim()];
    else [title, body] = [text, ""];
  }
  const files = [...new Set([...item.text.matchAll(FILE_RE)].map((m) => m[1].split("/").pop()))];
  return {
    kind,
    group,
    num: item.num,
    title: title.replace(/[.:]$/, ""),
    body,
    check,
    verified,
    judgement: !!check && /^judgement/i.test(check),
    unverified: /UNVERIFIED/.test(item.text),
    noCheck: kind === "open" && !check,
    files,
  };
}

export function parseTidyReport(src) {
  const items = [];
  const notes = {};
  const updated = src.match(/last updated (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)/)?.[1] || "";
  const passes = src.match(/(\d+) fix passes/)?.[1] || "";
  for (const sec of src.split(/^(?=## )/m)) {
    const h = sec.match(/^## +(.+)/);
    const kind = h && kindOf(h[1]);
    if (!kind) continue;
    const body = sec.slice(h[0].length);
    if (kind === "resolved") {
      for (const sub of body.split(/^(?=### )/m)) {
        const g = sub.match(/^### +(.+)/);
        const lines = (g ? sub.slice(g[0].length) : sub).split("\n");
        for (const it of listItems(lines)) items.push(enrich(it, kind, g ? g[1].trim() : ""));
      }
      continue;
    }
    const lines = body.split("\n").filter((l) => !/^>/.test(l));
    const found = listItems(lines);
    for (const it of found) items.push(enrich(it, kind, ""));
    // A section with no items still says something ("The Open section is empty as of …").
    if (!found.length) notes[kind] = lines.find((l) => l.trim() && !/^[-*#]/.test(l))?.trim() || "";
  }
  return { items, notes, updated, passes };
}

export function parseAmbiguities(src) {
  const items = [];
  let section = "";
  let page = "";
  for (const sec of src.split(/^(?=##+ )/m)) {
    const h = sec.match(/^(##+) +(.+)/);
    if (!h) continue;
    if (h[1] === "##") {
      section = h[2].trim();
      page = "";
      if (/^(related|sources)$/i.test(section)) section = "";
    } else page = h[2].replace(/`/g, "").trim();
    if (!section) continue;
    for (const it of listItems(sec.slice(h[0].length).split("\n"))) items.push(enrich(it, "ambiguity", page ? `${section} · ${page}` : section));
  }
  return items;
}
