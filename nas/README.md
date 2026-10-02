# Running the site on your Synology NAS (private, Tailscale only)

When you're done, your NAS will:

- check your Google Drive folder **every hour** and rebuild the site with your latest chapters and wiki;
- show the site at an address like **https://manyo.your-tailnet.ts.net**, with a padlock;
- let **only your own devices** (the ones logged into your Tailscale) open it. Nobody else on the internet can.

It runs as three small "containers" (think of them as tiny apps living inside the NAS):

| Container | Its one job |
| --- | --- |
| `builder` | Every hour: downloads your files from Google Drive and builds the website |
| `web` | Hands the website to your browser |
| `tailscale` | Puts the website on your private Tailscale network, with https |

Set aside about 30 minutes. You'll do things in four places: your **computer**, the **Tailscale** website,
**GitHub**, and your **Synology** (the DSM page you log into).

---

## Step 1: Find your Google key file (on your computer)

You already made a Google "service account" called `web-reader`, and your Drive folder is already shared
with it. Good, that part's done. What you need now is its **key file**: a file ending in `.json` that you
downloaded when you made it. It's probably in your Downloads folder, named something like
`pokemon-novel-reader-1a2b3c4d5e6f.json`.

**Can't find it?** Make a new one:

1. Go to https://console.cloud.google.com and make sure the project at the top says **pokemon-novel-reader**.
2. Menu (☰) → **IAM & Admin** → **Service Accounts**.
3. Click **web-reader** → **Keys** tab → **Add key** → **Create new key** → **JSON** → **Create**.
4. A `.json` file downloads. That's it.

> This file is like a house key to your Drive folder. Don't email it, don't post it, don't put it on GitHub.

---

## Step 2: Prepare Tailscale (on the Tailscale website)

Go to https://login.tailscale.com/admin and log in.

**2a. Turn on https addresses** (one time only)

1. Click **DNS** at the top.
2. Make sure **MagicDNS** is **enabled**. If there's a button saying *Enable MagicDNS*, click it.
3. Scroll down to **HTTPS Certificates** and click **Enable HTTPS**.

**2b. Make a one-time "join code" for the NAS** (Tailscale calls it an *auth key*)

1. Click **Settings** at the top → **Keys** on the left.
2. Click **Generate auth key…**
3. Leave everything as it is and click **Generate key**.
4. You'll see a long code starting with `tskey-auth-`. Click **Copy** and paste it somewhere for a moment
   (Notepad is fine). You can't see it again after closing the box.

---

## Step 3: Download the site from GitHub (on your computer)

1. Go to https://github.com/momonekomata/Pokemon-Novel.
2. Click the button that says **main** (top left, above the file list) and pick
   **claude/affectionate-lamport-8i272q**. (Once that's merged into main, you can skip this.)
3. Click the green **Code** button → **Download ZIP**.
4. Find the ZIP in your Downloads and unzip it (Windows: right-click → *Extract All*. Mac: double-click).
   You'll get a folder like `Pokemon-Novel-claude-affectionate-lamport-8i272q`.
5. Rename that folder to **manyo-site**. Inside it you should see `docker-compose.yml`, `package.json`,
   and folders called `assets`, `lib`, `nas`, `scripts`.

---

## Step 4: Fill in your settings (on your computer, inside `manyo-site`)

**4a. The settings file**

1. Open the `nas` folder. Find `settings.example.env`.
2. **Copy** it (don't move it) into the main `manyo-site` folder, next to `docker-compose.yml`.
3. Rename the copy to exactly **settings.env**.
   - **Windows:** Windows hides file endings, so you might accidentally make `settings.env.txt`.
     In File Explorer click **View** → tick **File name extensions** first, then rename.
4. Open `settings.env` with **Notepad** (Windows) or **TextEdit** (Mac: then menu **Format → Make Plain Text**).
5. Change these lines:
   - `TS_AUTHKEY=` → paste your `tskey-auth-…` code from Step 2b right after the `=`. No spaces.
   - `AUTHOR_PASSWORD=` → type a long password for the Author area of the site (a short sentence works well).
6. Leave `TS_HOSTNAME=manyo` (that's the name in your address) and `SYNC_INTERVAL_MINUTES=60` as they are. Save.

It should look like this (with your own values):

```
TS_AUTHKEY=tskey-auth-kAbCdEf123-AbCdEfGhIjKlMnOpQrStUv
TS_HOSTNAME=manyo
AUTHOR_PASSWORD=the frog wore boots to the library
SYNC_INTERVAL_MINUTES=60
```

**4b. The Google key**

1. Inside `manyo-site`, make a new folder called **secrets**.
2. Put your `.json` key file from Step 1 into it.
3. Rename it to exactly **google-key.json** (again, watch out for `google-key.json.json` on Windows).

Your `manyo-site` folder now has, among other things:

```
manyo-site/
├── docker-compose.yml
├── settings.env          ← you made this
├── secrets/
│   └── google-key.json   ← you put this here
├── nas/
├── scripts/
└── …
```

---

## Step 5: Install Container Manager (on your Synology)

1. Log into your Synology (the DSM page in your browser).
2. Open **Package Center**.
3. Search for **Container Manager** and click **Install**. If it asks where to put things, pick your main
   volume and click OK. This also creates a shared folder named **docker**.

> Don't see Container Manager, only "Docker"? Your DSM is older than 7.2. Go to
> **Control Panel → Update & Restore** and update DSM first, then come back.

---

## Step 6: Copy your folder onto the NAS

1. On the Synology, open **File Station**.
2. Click the **docker** folder on the left.
3. Drag your whole **manyo-site** folder from your computer into the File Station window and drop it there.
   Wait for the upload to finish (bottom right corner shows progress).
4. Double-click `docker` → `manyo-site` and check that `docker-compose.yml`, `settings.env` and the `secrets`
   folder are all there.

---

## Step 7: Start it (on your Synology)

1. Open **Container Manager**.
2. Click **Project** on the left → **Create**.
3. Fill in:
   - **Project name:** `manyo-site`
   - **Path:** click **Set path** → choose `docker` → `manyo-site` → **Select**
   - **Source:** it should say **Use existing docker-compose.yml**. (It found the `docker-compose.yml` file.)
4. Click **Next**. If it shows a page about **Web portal / Web Station**, leave it **off** and click **Next**.
5. Click **Done**. The NAS now downloads the three containers and starts them. The first time takes a few
   minutes.

---

## Step 8: Check it worked

1. In Container Manager → **Container**, you should see three running (green) containers whose names
   contain `builder`, `web` and `tailscale`.
2. Click the **builder** one → **Log** (or **Details → Log**). Within a few minutes you should see:
   ```
   Pulling from Google Drive...
   Synced … Markdown files from Drive into content/
   Built … chapters/interludes, … side stories, … public wiki pages, … author pages
   Site updated. Next check in 60 minutes.
   ```
3. Now go back to the Tailscale admin page (https://login.tailscale.com/admin/machines). There's a new
   machine called **manyo**. Click it and copy its full name under **Domains / DNS name**: something like
   `manyo.tail1234.ts.net`.

**Important, one time:** on that same machine page, click the **⋯** menu → **Disable key expiry**.
Otherwise Tailscale will log the site out after about six months.

---

## Step 9: Open your site 🎉

On any device where **Tailscale is switched on** (phone, laptop…), open:

**https://manyo.tail1234.ts.net** (use your own name from Step 8)

The very first visit can take up to a minute while Tailscale makes the padlock certificate. After that it's instant.

The **Author** link at the bottom of the page asks for the `AUTHOR_PASSWORD` you chose in Step 4.

---

## Everyday stuff

**"I edited a chapter in Drive. When does the site update?"** Within the hour, by itself. Want it now?
Container Manager → **Container** → select the **builder** → **Action → Restart**. It checks Drive
right away.

**Change the password, or check Drive more or less often:** File Station → `docker/manyo-site` → right-click
`settings.env` → **Open with Text Editor** (install *Text Editor* from Package Center if it isn't there).
Change it, save, then Container Manager → **Project** → `manyo-site` → **Stop**, then **Build** (that
restarts everything with your new settings).

**Getting a newer version of the site's design or code:** download the ZIP again (Step 3). On the NAS, copy
the new files into `docker/manyo-site`, letting them replace the old ones. Your `settings.env`, `secrets`
folder and everything the site saved are not in the ZIP, so they stay. Then do **Stop** and **Build** on the project.

**Want people to see it later?** Ask Claude: it's a small change to make the Tailscale address public
("Funnel"), or to move to a regular public host.

---

## If something goes wrong

Look at the **builder** log first (Step 8). Find the line that says `FAILED` and read the line just above it.

| You see… | What it means | Fix |
| --- | --- | --- |
| `Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE` or `no such file … google-key.json` | The key file isn't where it should be | It must be `docker/manyo-site/secrets/google-key.json`, named exactly that |
| `Token request failed: 400` / `invalid_grant` | The key file is wrong or was deleted in Google Cloud | Make a new key (Step 1) and replace the file |
| `Drive API … 404` or `Synced 0 Markdown files` | The Drive folder isn't shared with `web-reader@…` | In Drive, share the folder with that address as **Viewer** |
| The page won't open at all | Your device isn't on Tailscale, or the NAS hasn't joined | Turn Tailscale on. In the Tailscale admin, check that **manyo** is listed and online. Check the **tailscale** container's log |
| The **manyo** machine never shows up in Tailscale | The join code was wrong or already used up | Make a new auth key (Step 2b), put it in `settings.env`, delete the `tailscale-state` folder inside `docker/manyo-site`, then **Stop** and **Build** |
| Certificate or "not secure" warning | HTTPS isn't enabled in Tailscale | Do Step 2a, wait a minute, reload |
| The name became `manyo-1` | An older machine called `manyo` exists | Delete the old one in the Tailscale admin, or just use `manyo-1` |
