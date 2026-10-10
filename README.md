# Azure Blob Sync for Obsidian

Live-sync your Obsidian vault with **your own Azure Blob Storage container**. You connect with a
SAS token, so anyone can point the plugin at their own storage account. There's no server in
between and the plugin is free; your notes stay in your own Azure subscription.

- **Live sync**: edits are uploaded a few seconds after you stop typing. Changes from your other
  devices are pulled in on a schedule (every 30 s by default), when Obsidian starts, when it
  regains focus and when you click the ribbon icon.
- **Two-way, safe merging**: a three-way comparison (this device ↔ Azure ↔ last sync) works out
  which side changed. Edits, new files, renames and deletions go in the right direction.
- **Conflicts never lose data**: if a note was edited on two devices, both versions are kept by
  default (`Note (conflict 2026-10-09 14-03-12).md`). Writes use Azure ETag preconditions, so a
  device never overwrites a change it hasn't seen.
- **Deletion safety**: deleted files go to the trash. If a sync would delete a large part of the
  vault (for example, the container was emptied), it stops and asks first.
- **Desktop and mobile**: requests go through Obsidian's own HTTP client, so **no CORS setup** is
  needed on the storage account.
- Optional: sync the `.obsidian` settings folder, ignore patterns, upload-only (backup) or
  download-only (mirror) mode, a size limit, and a folder prefix so several vaults can share one
  container.

## Disclosures

- **Network use**: the plugin connects only to the Azure Blob Storage endpoint you configure
  (by default `https://<account>.blob.core.windows.net`). It uses that connection to list, upload,
  download and delete your vault's files in your container. Nothing is sent anywhere else: no
  telemetry, no analytics, no third-party servers.
- **Account required**: you need a Microsoft Azure account with a storage account. The plugin is
  free; Microsoft bills you for the storage and requests (typically cents a month, see *Cost*
  under [Good to know](#good-to-know)).
- **Files outside the vault**: none. The plugin only reads and writes files inside your vault.

## 1. Prepare Azure (one time, about 5 minutes)

1. **Create a storage account** in the [Azure portal](https://portal.azure.com) → *Storage accounts*
   → *Create*. *Standard* performance with *LRS* redundancy is plenty.
2. **Create a container**: open the storage account → *Data storage* → *Containers* → *+ Container*,
   e.g. `obsidian`. Keep the access level **Private**.
3. **Generate a SAS URL for the container**: open the container → *Settings* →
   *Shared access tokens*:
   - Signing method: *Account key*
   - Permissions: **Read, Add, Create, Write, Delete, List**
   - Expiry: choose a date far enough out, e.g. a year. The plugin warns a week before it expires.
   - Allowed protocols: *HTTPS only*
   - Click **Generate SAS token and URL** and copy the **Blob SAS URL**.

   With the Azure CLI instead:

   ```bash
   az storage container generate-sas --account-name <account> --name obsidian \
     --permissions racwdl --expiry 2027-12-31T00:00Z --https-only --auth-mode key -o tsv
   ```

4. *(Recommended)* Turn on **blob soft delete** and **versioning** under *Data management* →
   *Data protection*. Then even a bad sync can be undone from the portal.

An account-level SAS works too. It needs the Blob service, the *Container* and *Object* resource
types, and read/write/delete/list permissions.

## 2. Install the plugin

Once the plugin is listed in Obsidian's Community plugins, install it from *Settings → Community
plugins → Browse* by searching for "Azure Blob Sync". Until then, install it one of these ways:

- **BRAT** (easiest, also on mobile): install the *Obsidian42 - BRAT* community plugin, choose
  *Add beta plugin* and enter `stefanmayer06/obsidian-blob-sync`. BRAT installs the files
  attached to the latest GitHub release (see [Publishing a release](#publishing-a-release)).
- **Manually**: download `main.js`, `manifest.json` and `styles.css` from the latest release, or
  build them yourself (`npm install && npm run build`). Copy them into
  `<your vault>/.obsidian/plugins/azure-blob-sync/`, then enable *Azure Blob Sync* under
  *Settings → Community plugins*.

### Publishing a release

BRAT reads `manifest.json`, `main.js` and `styles.css` from the release's **assets**, not from
the repository. The *Release* GitHub Action builds and attaches them:

1. Set the new version in `manifest.json` and `package.json`, add it to `versions.json`, then
   commit to `main`. Run `npm run lint` first: it applies Obsidian's official plugin rules, the
   same kind of checks the Community directory runs on every release.
2. Publish a release on GitHub whose tag is **exactly** that version, e.g. `1.0.1` (no `v`
   prefix). Pushing the tag with git works too.
3. The *Release* action attaches the three files to the release within a minute or two. It also
   publishes a signed [build provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)
   for each file, so anyone can check that a download was built from this repository:
   `gh attestation verify main.js --repo stefanmayer06/obsidian-blob-sync`.

If a release is missing its files, open *Actions → Release → Run workflow* and enter the tag.
The files are then built and attached to that existing release.

## 3. Connect

Open *Settings → Azure Blob Sync*:

1. Paste the **Blob SAS URL** into *Quick setup* and click **Fill in**. This fills in the account,
   container and SAS token. You can also type each value yourself:
   | Field | Example |
   | --- | --- |
   | Storage account name | `mystorageaccount` |
   | Container name | `obsidian` |
   | SAS token | `sv=2022-11-02&sr=c&sp=racwdl&se=…&sig=…` |
   | Remote folder *(optional)* | `vaults/personal`: lets several vaults share one container |
   | Blob service URL *(advanced, optional)* | Only for sovereign clouds, custom domains, private endpoints or the Azurite emulator |
2. Click **Test connection**. It checks list, write, read and delete permissions and shows when the
   token expires.
3. Turn on **Live sync**.

Repeat on every device. A second device that already has notes merges with what is in Azure:
identical files are recognised and kept, files that differ are kept side by side as conflict
copies, and nothing is deleted.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Live sync | off | Upload on change, poll for remote changes, sync on startup/focus |
| Sync direction | Two-way | *Upload only* backs the vault up and never changes local files. *Download only* mirrors the container and never changes it |
| When a file changed on both sides | Keep both | Or: newest wins, this device wins, Azure wins. With "keep both", files in the settings folder use "newest wins" instead of conflict copies |
| Upload delay | 3 s | Wait after the last edit before uploading. While you keep typing, it still uploads at least every 30 s |
| Check for remote changes every | 30 s | One small *List Blobs* request per check. 0 turns polling off |
| Sync settings folder | off | Also syncs `.obsidian` (themes, snippets, plugins, settings). `workspace*.json` and this plugin's own folder are never synced |
| Ignore patterns | – | One per line: `*.tmp`, `Private/`, `/Archive`, `Daily/2023/**` |
| Maximum file size | 200 MB | Larger files are skipped. 0 means no limit |

Commands: *Sync now*, *Toggle live sync*, *Show sync log*, *Reset sync state*. The status bar shows
the last sync time; click it to sync.

## How it works

Each vault file is stored as a block blob named `<remote folder>/<path in vault>`, with its
modification time and SHA-256 hash in the blob metadata. Notes stay readable in the portal and
in Storage Explorer.

The plugin remembers the ETag, hash, size and modification time of every file after it syncs.
This record lives on the device in `.obsidian/plugins/azure-blob-sync/sync-state.json`. On each
sync the plugin compares the current state on both sides with that record:

| This device | Azure | Result |
| --- | --- | --- |
| changed | unchanged | upload (`If-Match: <last ETag>`) |
| unchanged | changed | download |
| changed | changed | conflict → keep both (default) |
| deleted | unchanged | delete in Azure |
| unchanged | deleted | move the local file to the trash |
| deleted | changed | download (an edit wins over a deletion) |
| changed | deleted | upload (an edit wins over a deletion) |
| new | – | upload (`If-None-Match: *`) |
| – | new | download |

If another device writes between the listing and the upload, Azure rejects the upload and the
plugin re-syncs instead of overwriting. Files whose content is unchanged (only the timestamp
moved) are never re-uploaded. Folders that become empty because of a remote deletion are cleaned
up too.

### Good to know

- **Security**: the SAS token grants access to the container. On Obsidian 1.11.4 and later it is
  kept in Obsidian's secret storage (*Settings → Keychain*) on each device. Older versions keep
  it in `.obsidian/plugins/azure-blob-sync/data.json`. That folder is never uploaded, but be
  careful if you also sync the vault with something else, like git. Use a container-scoped SAS
  with an expiry date. To revoke it, rotate the storage account key or use a stored access
  policy.
- **Not real-time push**: Azure can't notify the app, so remote changes arrive on the next poll.
- **Empty folders** aren't synced, because blob storage has no real folders.
- **Cost**: storage for a typical vault costs cents. Polling every 30 s while Obsidian is open
  adds at most ~86k list requests per device per month, which is well under US$1 at Hot-tier
  prices. A longer interval costs less.
- If something looks wrong, *Show sync log* explains what each sync did.

## Development

```bash
npm install
npm run build              # type-check + bundle main.js
npm run dev                # rebuild on change
npm run lint               # Obsidian's official plugin lint rules (eslint-plugin-obsidianmd)
npm test                   # unit tests (engine, SAS parsing, XML, ignore rules, scheduler)
npm run test:integration   # real HTTP against the Azurite storage emulator (started automatically)
OBSIDIAN_BIN=/path/to/obsidian npm run test:e2e   # runs the built plugin inside the real Obsidian app
```

The end-to-end test launches Obsidian (under Xvfb when there is no display) with a temporary
vault. It installs the built plugin, connects to Azurite and simulates a second device. Then it
checks the startup sync, live uploads, renames, folder moves, remote edits and deletions,
conflict copies, the mass-deletion dialog, secret storage, the settings tab and settings search.
It passes on Obsidian 1.14 and on 1.6.7, the oldest version the plugin supports. On Linux, extract
the AppImage with `--appimage-extract` and point `OBSIDIAN_BIN` at `squashfs-root/obsidian`.

Code layout:

```
src/azure/sas.ts           SAS URL/token parsing and validation
src/azure/client.ts        Azure Blob REST client (List/Get/Put/Delete, ETag conditions, retries)
src/azure/xml.ts           DOM-free List Blobs XML parser
src/sync/engine.ts         three-way sync engine
src/sync/controller.ts     debouncing, polling and coalescing of sync runs
src/sync/filter.ts         ignore rules
src/obsidian/*.ts          vault file system adapter and requestUrl transport
src/main.ts, src/ui/*      plugin wiring, settings tab, dialogs
```

## License

MIT
