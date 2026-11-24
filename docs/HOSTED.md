# Running Brink on your own server

This guide puts Brink on the internet so you can:

- upload bid packages from your phone (zips of hundreds of MB are fine), and
- use your projects from Claude (web, phone app, desktop, Claude Code) at any
  hour, through a connector that only you can sign in to.

It takes about an hour the first time. You do not need to be a developer, but
you will copy a few commands into a terminal. Everything in `ANGLE BRACKETS`
or marked `example` is a placeholder: put your own value there.

What it uses:

| Piece | What it does | Where |
|---|---|---|
| Cloudflare R2 | Stores every file you upload and everything Claude makes | cloudflare.com |
| Fly.io | Runs the Brink server around the clock | fly.io |
| Your domain (optional) | A nice address like `https://brink.yourcompany.com` | wherever your domain is |

**Costs.** Both services charge by usage and plan. The server here runs all
the time (1 shared CPU, 2 GB memory, a 10 GB disk), and R2 charges for the
gigabytes you keep stored. Prices change, so check the current pricing pages
of Fly.io and Cloudflare R2 before you start, and set a spending alert in each
account.

---

## 1. Get the tools onto your computer

1. **The code.** Download this repository (on GitHub: Code → Download ZIP, then
   unzip it), or `git clone` it if you use git. Open a terminal in that folder.
   (Mac: Terminal app. Windows: PowerShell.)
2. **Node.js 24.** Install the "LTS" or "Current" version 24 from
   <https://nodejs.org>. Check it in the terminal: `node -v` should print
   `v24...`.
3. **Fly.io command line.** Follow <https://fly.io/docs/flyctl/install/>
   (Mac with Homebrew: `brew install flyctl`). Then sign up / sign in:

   ```sh
   fly auth login
   ```

## 2. Choose the server's address

Pick the address you will type on your phone. It is used in several places
below, so decide now:

- your own subdomain, e.g. `https://brink.yourcompany.com` (recommended), or
- the free Fly address `https://<APP-NAME>.fly.dev`, where `<APP-NAME>` is the
  unique name you give the app in step 5.

Below, this is called **PUBLIC_URL**. Write it down exactly: `https://`, the
host, and nothing after it (no `/` at the end).

## 3. Create the storage (Cloudflare R2)

1. Sign in at <https://dash.cloudflare.com> and open **R2 Object Storage**
   (you may need to enable R2 and add a payment method first).
2. **Create bucket.** Name it, for example, `brink-plans` (lowercase letters,
   digits and dashes). Location: Automatic. Leave it private (no public access).
3. Note your **Account ID**: it is shown on the R2 overview page (a 32-character
   code of letters and digits).
4. **Create an API token** for the server: R2 overview → **Manage API tokens**
   → **Create API token**.
   - Permissions: **Object Read & Write**
   - Specify bucket(s): **Apply to specific buckets only** → your bucket
   - TTL: Forever
   - Create, then copy the **Access Key ID** and **Secret Access Key** now (the
     secret is shown only once). Keep them somewhere safe, like a password manager.

### Allow uploads from your site (CORS)

Your phone sends files straight to R2, so the bucket must allow your
PUBLIC_URL to do that and to read back each part's `ETag`. Without this,
uploads stop at once with a message about CORS.

In the Cloudflare dashboard: your bucket → **Settings** → **CORS Policy** →
**Add CORS policy** (or Edit), and paste this, with your PUBLIC_URL in place of
the example:

```json
[
  {
    "AllowedOrigins": ["https://brink.yourcompany.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Save. If you change PUBLIC_URL later, change it here too.

> There is also a script that sets the same policy, `brink-server/scripts/r2-cors.ts`.
> It needs a token that may change bucket settings (an "Admin Read & Write"
> token; the Object Read & Write token above usually cannot). The dashboard
> is simpler; use the script only if you prefer:
>
> ```sh
> cd brink-server
> npm ci
> PUBLIC_URL=https://brink.yourcompany.com R2_ACCOUNT_ID=<ACCOUNT-ID> R2_BUCKET=brink-plans \
>   R2_ACCESS_KEY_ID=<ADMIN-KEY-ID> R2_SECRET_ACCESS_KEY=<ADMIN-SECRET> \
>   node --import tsx scripts/r2-cors.ts
> ```

## 4. Make your password and the session secret

The server never stores your password, only a scrambled version of it (a
"hash"). Make the hash on your computer:

```sh
cd brink-server
npm ci
node --import tsx scripts/hash-password.ts
```

Type your password twice (nothing shows while you type). Use at least 12
characters; four or five unrelated words is a good password. The command
prints one line starting with `scrypt$`. That is your **OWNER_PASSWORD_HASH**.

Then make a random **SESSION_SECRET** (it signs the sign-in cookie):

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

## 5. Create the server on Fly.io

From the top folder of the repository (not inside `brink-server`):

1. Copy the example config and edit it:

   ```sh
   cp brink-server/fly.toml.example fly.toml
   ```

   Open `fly.toml` in a text editor and change:
   - `app` — a unique name, e.g. `brink-yourcompany`
   - `primary_region` — a region near you (`fly platform regions` lists them)
   - `PUBLIC_URL` — your address from step 2

2. Create the app on Fly without starting it yet:

   ```sh
   fly launch --copy-config --no-deploy
   ```

   If it asks whether to change settings, or to add a database or Redis, answer **no**.

3. Create the 10 GB disk, in the same region you put in `fly.toml`:

   ```sh
   fly volumes create brink_data --size 10 --region <REGION>
   ```

4. Give the server its secrets. Put the whole thing on one line, and keep the
   **single quotes** around the password hash (it contains `$` signs):

   ```sh
   fly secrets set R2_ACCOUNT_ID=<ACCOUNT-ID> R2_BUCKET=brink-plans R2_ACCESS_KEY_ID=<ACCESS-KEY-ID> R2_SECRET_ACCESS_KEY=<SECRET-ACCESS-KEY> SESSION_SECRET='<SESSION-SECRET>' OWNER_PASSWORD_HASH='<THE scrypt$... LINE>'
   ```

5. Deploy:

   ```sh
   fly deploy
   ```

   The first build takes several minutes. When it finishes, check it:

   ```sh
   fly status
   fly logs
   ```

   In a browser, `https://<APP-NAME>.fly.dev/api/health` should show
   `{"ok":true,...}`. If the logs show "brink-server configuration problems",
   they list exactly which setting is missing or wrong: fix it with
   `fly secrets set ...` (the server restarts by itself).

## 6. Add your domain (skip if you use the .fly.dev address)

1. Ask Fly for a certificate:

   ```sh
   fly certs add brink.yourcompany.com
   ```

2. It prints the DNS records to add. At your DNS provider, add a **CNAME**
   record: name `brink`, target `<APP-NAME>.fly.dev`. If your DNS is at
   Cloudflare, set the record's proxy status to **DNS only** (grey cloud), so
   the server sees each visitor's real address for its sign-in protection.
3. Wait until this says the certificate is issued (usually a few minutes):

   ```sh
   fly certs check brink.yourcompany.com
   ```

Sign in only at your PUBLIC_URL. The server refuses sign-ins that come from
any other address (that is a security check), so if PUBLIC_URL is your own
domain, the `.fly.dev` address will not let you sign in.

## 7. Use it from your phone

1. Open your PUBLIC_URL on the phone and sign in with your password.
2. Add it to your home screen (iPhone: Share → Add to Home Screen; Android:
   menu → Add to Home screen).
3. Tap **New project**, give it a name and notes (solicitation number, due date,
   GC, site visit), then **Choose files or a zip** and pick the bid package.

While a file uploads, keep the page open; the screen is kept awake when the
phone allows it. If the upload stops (the phone locked, the signal dropped),
tap **Resume**: it continues with the parts that are missing instead of
starting over. If you reloaded the page, pick the same file again and it
resumes. Afterwards the server unpacks the zip and reads every document; the
project page shows each file, its page count and whether its text could be read.

## 8. Add Brink to Claude

Custom connectors depend on your Claude plan. In Claude on the web:

1. **Settings → Connectors → Add custom connector.**
2. Name: `Brink`. URL: `https://<YOUR-HOST>/mcp` (your PUBLIC_URL followed by `/mcp`).
3. Click **Connect**. A Brink page opens: enter your password and press
   **Sign in and allow** (if you are already signed in on that browser, it is a
   single **Allow** button). You are sent back to Claude, connected.
4. For the parts list and schematic tools, add a second connector the same way:
   name `Brink parts`, URL `https://<YOUR-HOST>/mcp/brink`.

Connectors you add on claude.ai also appear in the Claude phone and desktop apps
signed in to the same account. In **Claude Code**:

```sh
claude mcp add --transport http brink https://<YOUR-HOST>/mcp
claude mcp add --transport http brink-parts https://<YOUR-HOST>/mcp/brink
```

then run `/mcp` inside Claude Code and choose the server to sign in.

Claude stays connected: its access renews itself in the background. If you
remove the connector or change your password hash, connect again the same way.

## 9. Your first bid

Do this once, in any Claude chat with the Brink connector on:

1. **Give Claude your playbook and settings.** Paste your quoting playbook and
   say: "Save this as my playbook with set_playbook, then fill my settings from
   it with update_settings: company (name, address, UEI, CAGE), labor units,
   target bill rate, true cost rate, crew size, hours per day, PM %, material
   markup, overhead, profit, SD excise, bond, mileage rate, validity, payment
   terms, warranty, standard exclusions and clarifications." Percentages are
   stored as fractions (15% is 0.15). Check the result with get_settings.
   Anything left unset shows up later as a gap in the bid, never as a guess.
2. **Calibrate before trusting traced lengths.** Upload a past job whose
   Bluebeam lengths you know, have Claude trace it, and compare the averages
   per device type before the first live bid.

Then for every bid: upload the package on your phone, and in Claude say which
project to bid. Claude reads the SOW and specs, takes off, prices it
(price_bid), looks up and records missing prices with their source and date,
re-prices until nothing is unpriced, writes the proposal words
(set_proposal_content) and exports the workbook and the quote (GC sub-bid) or
the federal cover letter and technical package. Everything says DRAFT.

On your phone, open the project: the **Bid** card shows the price, the links
over 250 ft and floor crossings to check first, and the documents. Tell
Claude what to fix; each re-price is a new draft revision. When it is right,
press **Approve this bid**: the final files are made without DRAFT and appear
under Documents. Only you can approve; if Claude re-prices afterwards, that is
a new draft to approve again. You fill and sign the federal forms yourself.

## 10. When you win: the install package

1. On the project page, once the bid is approved, press **Start install
   phase**.
2. In Claude: "Draft the install design for <project>." Claude tags every
   device by room (DO-101, WAP-102…), puts a rack at each telecom room with
   patch panels and port assignments, labels every cable by the job's spec
   labeling section (or D01, V01, S01, F01 when the spec has none), and lists
   what it could not know. Then ask it to fill the gaps: rack sizes and
   circuits, mounting heights from the spec or legend, and the rack gear
   (switches, amps, recorders) from the manufacturers' spec sheets, which it
   records with their source.
3. Ask for the package: "Export the install package." You get the 11x17
   drawings (cover, device plans, pull-label plans, pull schedule by room,
   rack elevations with power and heat, signal flow, mounting details) and the
   pull schedule as CSV for your label printer and as Excel. All marked
   DRAFT.
4. On your phone the **Install** card lists what must be fixed before
   approval first, then the counts, the label scheme and the files. When it
   is right, press **Approve for construction**: the package is re-made as
   ISSUED FOR CONSTRUCTION. A later change by Claude is a new draft to
   approve again; cable labels already given never change.

## 11. Connect D-Tools Cloud

D-Tools Cloud is where you keep the catalog, pricing, proposals and project
management. Brink keeps what D-Tools does not do (bid-package intake, the plan
takeoff with measured cable, reading specs, federal documents) and stays in
sync with D-Tools, so Claude can work across both.

1. **Make an API key in D-Tools:** Settings → Integration → Developer →
   generate a key. Copy it.
2. **Get the two Basic-auth values.** Every D-Tools API call also carries an
   HTTP Basic username and password that D-Tools publishes for all API users
   in its Postman collection for the D-Tools Cloud API (they are the same for
   everyone, not your login). Copy both from that collection.
3. **Make a webhook token:** any long random text, for example
   `openssl rand -hex 32`.
4. **Give the server all four** (one line, from the repository's top folder):

   ```sh
   fly secrets set DTOOLS_API_KEY=<YOUR-KEY> DTOOLS_BASIC_USER=<USER-FROM-POSTMAN> DTOOLS_BASIC_PASSWORD=<PASSWORD-FROM-POSTMAN> DTOOLS_WEBHOOK_TOKEN=<RANDOM-TOKEN>
   ```

   The server restarts by itself. Never put these values in a file in the
   repository. Until `DTOOLS_API_KEY` is set, Claude's D-Tools tools answer
   "D-Tools is not connected".
5. **Create the webhook in D-Tools** (**New Webhook**, in its integration
   settings): URL `https://<YOUR-HOST>/webhooks/dtools`, auth type **Bearer
   Token**, token = the `DTOOLS_WEBHOOK_TOKEN` from step 3, and choose the
   changes it offers for opportunities, projects, quotes and clients. When something changes in
   D-Tools, Brink re-reads it through the API (it never trusts what the
   webhook says) and refreshes the projects linked to it.

**What Claude can and cannot change in D-Tools**

| Claude may, on its own (every change is logged) | Waits for you | The API cannot do it |
|---|---|---|
| Create and update clients; create opportunities and change their header (client, name, number, addresses, quote template, budget, owner, close date, contacts); change project details (dates, project manager, budget, contacts) | Catalog price changes (MSRP, cost, price): Claude only proposes them with a source and date; they appear as **D-Tools price changes** on the project page and change D-Tools only when you press **Approve** | Write quote items. Quotes are read-only in the D-Tools API |

**Getting the takeoff into a quote.** Because quote items cannot be written
through the API, ask Claude for the quote inputs ("make the D-Tools quote
inputs for <project>"). You get two files:

- `catalog-import.csv`: only the products the takeoff needs that your catalog
  does not have yet, in D-Tools' own import columns. Import it in D-Tools
  (Catalog → My Products → Import/Export → Import products).
- `scope-by-location.txt`: "Office 101: 2 x Data outlet, 2-port (CAT6A) ..."
  room by room, with the cable footage. Paste it into Quote Assist, or build
  the quote from it.

When the quote exists, tell Claude which one it is (or let it find it) and ask
it to **reconcile**: it compares the quote with the takeoff (device counts per
product and per room, cable feet, items only on one side) and lists the
differences, biggest money first.

## Everyday care

- **Update the server** after pulling new code: `fly deploy` from the
  repository's top folder.
- **Change your password:** make a new hash (step 4), then
  `fly secrets set OWNER_PASSWORD_HASH='<NEW-HASH>'`.
- **Sign out every browser:** set a new `SESSION_SECRET` the same way.
- **Disconnect Claude:** remove the connector in Claude's settings.
- **Bigger uploads:** single files up to 4 GB are accepted. To change that,
  `fly secrets set MAX_UPLOAD_BYTES=<BYTES>`.
- **Backups:** your files and everything Claude makes are in R2. The Fly disk
  is mostly a cache, except the parts database when `DATABASE_URL` is not
  set; Fly takes daily snapshots of volumes, and you can point `DATABASE_URL`
  at a hosted Postgres database instead.

## When something goes wrong

| What you see | What to do |
|---|---|
| Upload stops at once with a message about **CORS** or the **ETag** | Redo "Allow uploads from your site" in step 3 with exactly your PUBLIC_URL. |
| "This sign-in request did not come from this site" | You opened the site at an address other than PUBLIC_URL. Use PUBLIC_URL. |
| "Too many attempts. Try again in …" | Several wrong passwords: wait the time shown. Existing sign-ins and Claude keep working. |
| Claude says it cannot connect | Open `https://<YOUR-HOST>/api/health`. If it does not load, check `fly status` and `fly logs`. |
| The server will not start | `fly logs` lists every configuration problem in plain words. |
| A file shows "no text" | It is a scan without a text layer; Claude can still look at its pages, but search will not find words in it. |

## What the server protects

- Every page and file needs your password (or, for Claude, a connector you
  approved). Downloads are short-lived links (1 hour).
- Your password is stored only as a scrypt hash. Wrong passwords lock that
  address out for longer and longer, and many wrong passwords from anywhere
  pause all password sign-ins for a while.
- Claude's access tokens are stored only as fingerprints (hashes), last one
  hour, and renew through single-use refresh tokens; a stolen, reused refresh
  token cancels that whole connection.
- Only Claude's own addresses (claude.ai, claude.com) and your own computer
  (Claude Code / desktop) can receive a sign-in approval.
