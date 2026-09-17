# Repo Manager

A fully static, client-side file manager for your GitHub repositories. No backend,
no build step — GitHub itself is the source of truth, and every change goes
through the GitHub REST API directly from your browser.

## Features

- Connect with a GitHub personal access token (stored only in your browser)
- Browse every repo you have access to, with branch switching
- Full file tree with search, breadcrumbs, and folder expand/collapse
- Open and edit text files with the Monaco editor (VS Code's editor), with
  syntax highlighting for common languages
- Markdown live preview
- Create, delete, rename/move, and upload files; create folders
- Download any file
- Commit history per file, with a side-by-side diff view and one-click restore
  of an older version
- Commit dates shown with relative time and the Jalali (Shamsi) calendar date
- Dark/light mode
- Responsive layout for desktop and mobile
- A local cache of each repo's file tree for faster reloads (refresh button
  available any time)

## Deploying to GitHub Pages

1. Push the contents of this folder to a repository (the files can live at the
   repo root, or under `/docs` — either works).
2. In that repository, go to **Settings → Pages**, and set the source to the
   branch/folder you pushed to.
3. Wait a minute for GitHub to publish the site, then open the URL GitHub
   gives you. That's it — no build step, no dependencies to install.

You can also open `index.html` directly from disk for local testing, but a
few browsers restrict ES module imports over `file://`; if that happens, serve
the folder with any static file server (e.g. `npx serve .`).

## Connecting your GitHub account

This app is 100% static, so it can't run GitHub's standard OAuth flow (that
requires a server to keep a client secret). Instead, sign in with a
**personal access token**:

1. Go to <https://github.com/settings/tokens/new?scopes=repo> (a link is also
   provided on the login screen).
2. Give it a name, choose an expiration, and make sure the **repo** scope is
   checked (this is what allows reading and writing repository contents).
3. Generate the token and paste it into the app.

The token is sent only to `api.github.com` and is stored in `localStorage`
(if you check "remember this token") or `sessionStorage` otherwise — never to
any third-party server, since there is no server at all.

To disconnect, use the power icon in the top bar; this clears the stored
token from your browser.

## Notes and limitations

- Files over 1 MB can't be read or written through GitHub's Contents API,
  which is what this app uses for simplicity; very large files will show an
  error when opened or saved.
- Rename/move is done as a single atomic commit via the Git Data API (it
  doesn't just add+delete in two commits).
- Binary files (images, archives, fonts, etc.) can be uploaded and downloaded,
  but aren't opened in the text editor.
- Empty folders aren't a Git concept — creating a "folder" adds a small
  `.gitkeep` placeholder file inside it, same as most Git tools do.

## Project structure

```
index.html          App shell and markup
css/style.css        Design tokens + all styling (light/dark themes)
js/app.js            State, rendering, and event wiring
js/github-api.js      GitHub REST API wrapper (fetch-based)
js/editor.js         Monaco Editor loader + language/binary detection
js/jalali.js         Gregorian → Jalali date conversion and formatting
```

Everything is vanilla JavaScript (ES modules) — no framework, no bundler, no
`node_modules`. Monaco Editor and `marked` (for Markdown rendering) are loaded
from a CDN at runtime.
