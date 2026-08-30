# Stremio Account Addon Cloner + AIOStreams Variant Manager

Fork of [oozmakafa/stremio-account-addon-cloner](https://github.com/oozmakafa/stremio-account-addon-cloner), extended with multi-account AIOStreams variant management.

The app is built with **Next.js 15** and **Tailwind CSS**.

## Features

### Original cloner features

- Login with Stremio Email/Password or AuthKey
- Fetch addons from a primary Stremio account
- Clone selected addons to multiple secondary accounts
- Sync or append mode
- View/remove installed addons on target accounts
- Existing supported debrid-key overrides

### AIOStreams Variant Manager

Each Stremio account can keep its **own AIOStreams variant manifest URL**.

- **Detect** the AIOStreams variant already installed on one account
- **Detect All** variants for the primary + selected target accounts
- Store a different variant URL per account
- **Refresh** one account
- **Refresh All** configured accounts in one operation
- Fetch the current `manifest.json` with cache disabled
- Replace the installed AIOStreams manifest **in place**
- Preserve the addon collection order, flags, transport name, and every other installed addon
- Show per-account success/error status

This is intended for AIOStreams changes that modify the Stremio manifest and would normally require manually reinstalling the addon on every account.

The variant must already be installed at least once on an account. The manager deliberately refuses to guess a new Stremio collection entry when AIOStreams is missing; this avoids modifying the wrong addon.

## How the AIOStreams refresh works

For each account the manager:

1. Authenticates to Stremio.
2. Reads the current addon collection with `addonCollectionGet`.
3. Detects the installed AIOStreams/variant transport URL, or uses the URL saved for that account.
4. Downloads a fresh `manifest.json` from that variant.
5. Replaces only the AIOStreams entry at the same collection position.
6. Writes the updated collection using `addonCollectionSet`.

No other addon is reordered or replaced by the AIOStreams refresh operation.

## Local setup

### Prerequisites

- Node.js 18+
- npm 9+
- Git

### Install

```bash
git clone https://github.com/dav1dera/stremio-account-addon-cloner.git
cd stremio-account-addon-cloner
npm install
npm run dev
```

For a production build:

```bash
npm run build
npm start
```

## Notes

When **Remember my details** is enabled, the upstream app stores the account configuration in browser `localStorage`; this fork includes the saved AIOStreams variant URL in the same local browser payload.
