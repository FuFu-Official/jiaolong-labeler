# AGENTS

## Repo shape
- Single-process Node app (no framework): backend + static hosting are both in `server.js`.
- Frontend entrypoints are `public/index.html` + `public/app.js` (annotation UI) and `public/visualize.html` + `public/visualize.js` (label review/edit UI).
- Images must be placed in `images/total`; only files with extensions in `IMAGE_EXTS` in `server.js` are considered tasks.

## Runtime + commands
- Required runtime: Node `>=18` (`package.json` engines).
- Main local start: `npm start` (binds `0.0.0.0`, default port `3000` from `PORT`).
- LAN helper: `npm run start:intranet` (sets `HOST=0.0.0.0 PORT=3000`, but current server only reads `PORT`).
- Background scripts: `scripts/start-intranet.sh` and `scripts/stop-intranet.sh` use PID/log files in repo root.

## Data and persistence (important)
- Live state is file-based, not DB-backed: `data/store.json`.
- Label outputs are written per image to `labels/<image-basename>.txt` in YOLO pose format.
- Export summary writes to `exports/last-export.json`.
- `data/template.json` is the source of truth for keypoint naming and export order (`exportOrder` drives label point order).

## API/workflow quirks that affect edits
- `GET /api/task/next` can return images that already have a label file (`labels/*.txt`) as a fallback candidate; do not assume next-task means unlabeled-only.
- Annotation writes happen in multiple flows (`/api/annotation`, `/api/visualize/save`, export); keep YOLO serialization/parsing logic (`annotationToYolo` / `parseYoloLabel`) consistent when editing.
- Visualizer endpoints (`/api/visualize*`) are handled before auth checks; this is current behavior by code, not a doc typo.

## Verification expectations
- There is no configured test/lint/typecheck pipeline in this repo (no scripts beyond start).
- Practical verification is manual: run `npm start`, test annotation flow on `/`, and visualizer flow on `/visualize.html`.

## Git hygiene in this repo
- `.gitignore` excludes `data/store.json`, `labels/*.txt`, and `exports/*.json`.
- `.gitignore` does **not** exclude `four-keypoint-labeler.log` / `four-keypoint-labeler.pid` (the current script defaults), so check `git status` before committing after using background scripts.
