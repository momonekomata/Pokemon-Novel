# Free hosting on Cloudflare Pages

This puts the site on the internet at an address like `https://manyo.pages.dev`, reachable from any
phone or computer, whether or not your NAS or your home internet is on. It costs nothing:

- **GitHub** does the work: every hour it pulls your chapters from Google Drive and builds the site. It only
  rebuilds when something changed, so the free allowance for private repositories (2,000 minutes a month)
  is plenty.
- **Cloudflare Pages** serves the site. It's free, with no limit on visitors.
- Optional: **Cloudflare Access** makes it private, so only email addresses you list can open it.

You'll copy four secrets into GitHub. Allow about 20 minutes. Do the steps in order.

## Step 1. Make a Cloudflare account

1. Go to <https://dash.cloudflare.com/sign-up> and sign up with your email. Free plan; no card needed.
2. Confirm the email Cloudflare sends you.

## Step 2. Copy your Cloudflare Account ID

1. In the Cloudflare dashboard, open **Workers & Pages** in the left menu (if it asks what you want to
   build, just close that).
2. On the right-hand side there's **Account ID**, a long string of letters and numbers. Click **Click to
   copy** (or select it and copy). Paste it into a note for now.

   (Also findable in the address bar: `dash.cloudflare.com/`**this part**`/…`.)

## Step 3. Make a Cloudflare API token

This lets GitHub upload the site to your account, and nothing else.

1. Top right, click the person icon → **My Profile** → **API Tokens** → **Create Token**.
2. At the bottom, next to **Create Custom Token**, click **Get started**.
3. Fill in:
   - **Token name:** `GitHub publishes manyo`
   - **Permissions:** pick **Account** · **Cloudflare Pages** · **Edit**
   - **Account Resources:** **Include** · your account
4. **Continue to summary** → **Create Token**.
5. Copy the token it shows (it's shown only once) into your note.

## Step 4. Find your Google key file and author password

These are the same two things the NAS uses.

- **Google key:** the `google-key.json` file you downloaded from Google Cloud when you set up the NAS
  (check your Downloads folder). If you can't find it (it's also in the NAS's `secrets` folder, but the NAS
  is off), make a new one: <https://console.cloud.google.com/> → **IAM & Admin** → **Service Accounts** →
  click your service account → **Keys** → **Add key** → **Create new key** → **JSON**. A new file downloads.
  The old key keeps working on the NAS.
- **Author password:** the `AUTHOR_PASSWORD` line in your NAS `settings.env`. Use the same one so it
  stays the same password everywhere (or pick a new long one; the NAS copy then keeps the old password).

## Step 5. Put the four secrets into GitHub

1. Open the repository on GitHub: <https://github.com/momonekomata/Pokemon-Novel>.
2. **Settings** (top bar of the repository) → left menu **Secrets and variables** → **Actions**.
3. Click **New repository secret** four times, once for each:

   | Name (type exactly) | Secret |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | the token from step 3 |
   | `CLOUDFLARE_ACCOUNT_ID` | the Account ID from step 2 |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | open `google-key.json` in Notepad / TextEdit, select all, copy, paste the whole thing |
   | `AUTHOR_PASSWORD` | your author password |

## Step 6. Publish for the first time

1. In the repository, click **Actions** (top bar).
2. On the left, click **Sync from Drive and publish to Cloudflare** → **Run workflow** (right side) →
   green **Run workflow** button.
3. Wait two or three minutes until the run gets a green tick. Click the run → **publish** → open the step
   **Upload to Cloudflare Pages**: the last lines show your address, ending in `.pages.dev`.
   Normally `https://manyo.pages.dev`; if somebody else already has that name, Cloudflare adds a few
   letters, like `https://manyo-4xk.pages.dev`. It's also under **Workers & Pages** in Cloudflare.
4. Open it. That's your site, served from Cloudflare. Bookmark it on your phone.

From now on it updates by itself every hour, and right after any code change.

A red cross on a run means something went wrong. Click it, find the step with the red cross, and send me what
it says. The usual causes are a secret pasted with a missing character, or the Google key not being the
whole file.

## Step 7 (recommended). Make it private

Without this step, anyone who finds the address can read the chapters and the reader wiki. The author
area is always safe either way: it's encrypted with your author password.

1. In the Cloudflare dashboard, open **Zero Trust** in the left menu.
2. The first time, it asks for a **team name** (anything, e.g. `manyo`) and a plan: choose **Free**
   (up to 50 people). It may ask for card details even for the Free plan; the Free plan isn't charged.
3. Go to **Access** → **Applications** → **Add an application** → **Self-hosted**.
4. Fill in:
   - **Application name:** `Manyo`
   - **Domain / public hostname:** your address without `https://`, e.g. `manyo.pages.dev`.
     Click **Add domain** / **+** once more and add `*.manyo.pages.dev` too (covers Cloudflare's
     per-upload preview addresses).
5. Next, add a **policy**: name `Me`, **Action: Allow**, and under **Include** choose **Emails** and type your
   email address (add more emails later to let friends in).
6. Save through the remaining pages, keeping the defaults.

Now opening the site asks for your email and sends a one-time code. Once you've entered it, the browser
remembers you for a while (24 hours by default, adjustable in the application's settings).

## The NAS

It no longer matters whether the NAS is on. When the power comes back it carries on as before: a second
copy on your Tailscale network. Each copy keeps its own "Latest updates" and "What changed" history, and
the Cloudflare copy starts its history from Drive's file dates. If you don't want the NAS copy any more,
stop the project in Container Manager.

## Good to know

- To change the address name, add a repository **variable** (Settings → Secrets and variables → Actions
  → **Variables** tab) called `CLOUDFLARE_PROJECT` with the name you want (lowercase letters, numbers,
  dashes), then run the workflow again. You get a new `….pages.dev` address. Update the Access application
  to match it.
- You can also use your own domain: Cloudflare → **Workers & Pages** → your project → **Custom domains**.
- To pause publishing: Actions → the workflow → **…** (top right) → **Disable workflow**.
