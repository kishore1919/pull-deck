# PullDeck

**PullDeck** is a full-stack, stateless media downloader studio for **Instagram**, **Reddit**, and **RedGIFs**. It supports public profiles, single links, and bulk batches with cursor pagination (**Load more** and **Load all**), single-file downloads, video-aware multi-part ZIP streaming, and `.txt` URL export—with zero database, zero saved history, and zero server disk writes.

---

## Features

- **Platform-Focused Workspace (`Instagram` | `Reddit` | `RedGIFs`)**: Dedicated page per platform with per-platform input memory, live staged counts, and a stateless **Dark / Light** theme switcher.
- **Single, Profile & Bulk Queue Intake**: Paste a username (`@handle`, `u/user`, `r/subreddit`), a direct URL, or up to 25 mixed links (paste or `.txt` file import).
- **Large Profile Pagination (600+ Photos & Videos)**:
  - Configurable per-page fetch limits (`12`, `25`, `50`, `80`, `100`) and feed sorting (`Latest`, `Top`, `Hot`).
  - **Load more** and **Load all** (with a live counter and **Stop** button) across RedGIFs, Reddit, and Instagram.
  - Native `FrozenNodeIterator` cursor resumption for deep Instagram pagination via Python Instaloader.
  - Windowed client rendering (60 thumbnails per view page with **Prev / Next**) so 600+ loaded items remain responsive.
- **Flexible Downloads**:
  - **Direct single-file download** or **Lightbox Preview** (image zoom + HTML5 video playback).
  - **Video-Aware Multi-Part ZIP Bundling**: Automatically splits large selections into sequential ZIP parts (**up to 50 photos** or **up to 12 HD videos** per ZIP part, up to 300 MB/part) with optional platform/profile folder grouping and `metadata.json`.
  - **1-Click Export `.txt`**: Exports direct media URLs for optional bulk downloading with local tools (`aria2c`, `curl`).
- **Stateless Privacy Mode**: No database, no `localStorage` history, no user accounts, and direct stream-through proxying/ZIP creation.

---

## Supported Platforms & Formats

| Platform | Supported Targets | Extraction Engine |
| :--- | :--- | :--- |
| **Instagram** | Public Profiles (`instagram.com/<user>/`), Posts & Carousels (`/p/<id>/`), Reels (`/reel/<id>/`), Stories (`/stories/<user>/`), Highlights (`/stories/highlights/<id>/`) | Python **Instaloader** worker + public embed fallback (optional server session or RapidAPI for Stories, Highlights, and cloud-IP profile grids) |
| **Reddit** | User Profiles (`reddit.com/u/<user>`), Subreddits (`reddit.com/r/<sub>`), Posts, Galleries, Videos, Share links (`redd.it/<id>`) | Live public JSON + automatic **Arctic Shift** fallback + automatic embedded **RedGIFs** unwrapping |
| **RedGIFs** | Public Profiles (`redgifs.com/users/<user>`), Single HD Clips (`redgifs.com/watch/<id>`, `/ifr/<id>`) | Live RedGIFs API v2 with consistent page-size pagination |

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, Lucide Icons
- **Backend**: Node.js, Express, `archiver` (streaming ZIP), `cheerio`
- **Python Worker**: Python 3.11+, `instaloader` (`requirements.txt`)

---

## Quick Start

### 1. Install Node.js dependencies
```bash
npm install
```

### 2. Install Python Instaloader (for Instagram workloads)
Create a local virtual environment and install `requirements.txt`:
```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```
PullDeck automatically detects `.venv/bin/python` (or `PYTHON_BIN` / system `python3`) at startup.

### 3. Configure environment variables (Optional)
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

| Variable | Required | Description |
| :--- | :---: | :--- |
| `PORT` | No | Server port (defaults to `3000`) |
| `INSTAGRAM_SESSION_ID` | No | Optional server-side Instagram `sessionid` cookie for Instaloader (unlocks Stories, Highlights, and prevents cloud-IP rate limits on public profiles) |
| `INSTAGRAM_USERNAME` | No | Optional Instagram handle matching `INSTAGRAM_SESSION_ID` to speed up Instaloader session initialization |
| `PYTHON_BIN` | No | Optional custom path to Python executable containing `instaloader` |
| `INSTAGRAM_RAPIDAPI_KEY` | No | Optional RapidAPI key for a managed Instagram scraper provider |
| `INSTAGRAM_RAPIDAPI_HOST` | No | Optional RapidAPI host (e.g., `instagram-scraper-api2.p.rapidapi.com`) |

> **Note on Instagram from Cloud Servers**: Running PullDeck locally on a residential network allows anonymous Instaloader requests for many public profiles/posts. When hosted on cloud datacenter IPs (Cloud Run, AWS, GCP), Instagram aggressively rate-limits (`HTTP 429`) or login-gates anonymous profile calls—configuring `INSTAGRAM_SESSION_ID` or a RapidAPI connector resolves this on the server without exposing credentials to the browser.

### 4. Run in development
```bash
npm run dev
```
The Express backend + Vite dev middleware starts on `http://localhost:3000`.

### 5. Production build & start
```bash
npm run build
npm start
```

### 6. Type-check
```bash
npm run lint
```

---

## API Endpoints

| Method & Route | Purpose |
| :--- | :--- |
| `GET /api/capabilities` | Returns backend extractor readiness flags (Instaloader availability/version, batch/ZIP limits). Never exposes secrets. |
| `POST /api/extract/batch` | Accepts `{ urls, subredditLimit, subredditSort, cursor, pageNumber }` and returns normalized `ExtractionJob[]` and `MediaItem[]`. |
| `GET /api/proxy` | Streams allowlisted upstream images/videos (`?url=...&download=1&filename=...`) with safe headers and an 80 MB single-file limit. |
| `POST /api/download/zip` | Streams selected items on the fly into a `.zip` archive (up to 50 items / 300 MB per part) with optional folder organization and `metadata.json`. |

---

## Project Structure

```text
├── server.ts                          # Express server, proxy & streaming ZIP routes
├── server/
│   ├── security.ts                    # URL allowlist, private IP blocking, safeFetch, filename sanitization
│   ├── extractors/
│   │   ├── instagram.ts               # Instagram pipeline (Instaloader + fallbacks)
│   │   ├── instaloaderBridge.ts       # Node-to-Python Instaloader subprocess bridge
│   │   ├── reddit.ts                  # Reddit JSON + Arctic Shift fallback + RedGIFs unwrapper
│   │   └── redgifs.ts                 # RedGIFs v2 API extractor with exact pagination
│   └── python/
│       └── instaloader_worker.py      # Stateless Python Instaloader worker (in-memory, frozen cursors)
├── src/
│   ├── App.tsx                        # Platform state, pagination, smart ZIP chunking, URL export
│   ├── types.ts                       # Shared frontend/backend TypeScript interfaces
│   ├── utils/urlParser.ts             # URL classifier, handle builder & bulk parser
│   └── components/
│       ├── TopBar.tsx                 # Instagram / Reddit / RedGIFs switcher & theme toggle
│       ├── IntakeRail.tsx             # Platform-scoped input bar, bulk queue & options drawer
│       ├── StagingDeck.tsx            # Per-page Download ZIP, Export .txt, 60/page grid/table & Load All
│       ├── MediaThumbnail.tsx         # Lazy proxied media thumbnails with resilient fallbacks
│       └── LightboxModal.tsx          # Full-resolution image/video viewer with keyboard navigation
├── requirements.txt                   # Python Instaloader dependency
└── .env.example                       # Environment variable template
```

---

## Security & Privacy Architecture

- **Host Allowlisting & Network Protection**: All extraction and proxy requests validate `http:`/`https:` URLs against explicit Instagram, Reddit, Arctic Shift, and RedGIFs domains, verify DNS resolution, block loopback/private/metadata IP ranges, and validate every redirect hop.
- **Safe Python Subprocess Execution**: The Python Instaloader worker is invoked directly without a shell, receives structured JSON over `stdin`, validates all usernames/shortcodes/IDs and cursor sizes, enforces a 25-second timeout and 4 MB stdout cap, and validates every returned media URL before reaching the client.
- **Zero Persistence**: Media streams directly from upstream CDNs to the user's browser; filenames and ZIP folder paths are sanitized against path traversal, and clearing the session or refreshing the tab wipes all in-memory state immediately.
