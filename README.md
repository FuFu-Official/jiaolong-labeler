# Jiaolong Labeler

中文文档：`README.zh-CN.md`

Jiaolong Labeler is a configurable keypoint annotation tool.

- Supports flexible keypoint setup by template file (not limited to 4 points).
- Supports two deployment modes: `local` (single machine) and `shared` (multi-user collaboration).
- Writes labels to `labels/<image-name>.txt` in a template-defined format.

## 1) Requirements

- Node.js `>=18`
- Place images under `images` (nested subfolders are supported)
- Supported image extensions are controlled in `server.js` (`IMAGE_EXTS`)

## 2) Configuration

The app loads runtime config from `config/app-config.json`.

1. Copy example:

```bash
cp config/app-config.example.json config/app-config.json
```

2. Edit config file.

Example (`config/app-config.json`):

```json
{
  "appName": "Jiaolong Labeler",
  "deploymentMode": "local",
  "localUser": {
    "id": "local-user",
    "username": "local"
  },
  "server": {
    "host": "127.0.0.1",
    "port": 3000
  },
  "annotation": {
    "cornerCount": 4,
    "templateFile": "data/template.json"
  }
}
```

### Key config fields

- `deploymentMode`: `local` or `shared`
  - `local`: no login/register required; uses `localUser` directly
  - `shared`: login/register enabled for collaboration
- `server.host` / `server.port`: bind address and port
  - local recommended: `127.0.0.1`
  - shared/LAN recommended: `0.0.0.0`
- `annotation.cornerCount`: expected number of corner keypoints (`corner_0 ... corner_n`)
- `annotation.templateFile`: template file path

Environment variables can override config values:

- `APP_MODE` overrides `deploymentMode`
- `HOST` overrides `server.host`
- `PORT` overrides `server.port`

## 3) Template and keypoints

Template source of truth is configured by `annotation.templateFile` (default `data/template.json`).

Example:

```json
{
  "classId": 0,
  "labelFormat": {
    "type": "yolo_pose"
  },
  "cornerNames": ["top_left", "bottom_left", "bottom_right", "top_right"],
  "exportOrder": ["corner_0", "corner_1", "corner_2", "corner_3"],
  "internalPoints": []
}
```

- `cornerNames`: UI display names for corner points
- `labelFormat.type`: output/input label format
- `exportOrder`: point order in the exported label
- `internalPoints`: optional generated/internal points

Supported label formats:

- `yolo_pose` (default): `class cx cy w h x y v ...`
- `yolo_obb`: `class_index x1 y1 x2 y2 x3 y3 x4 y4`
- `xy_pairs`: plain point coordinates only, such as `x1 y1 x2 y2 x3 y3 x4 y4`

Example for YOLO OBB output:

```json
{
  "classId": 0,
  "labelFormat": {
    "type": "yolo_obb"
  },
  "cornerNames": ["top_left", "bottom_left", "bottom_right", "top_right"],
  "exportOrder": ["corner_0", "corner_1", "corner_2", "corner_3"],
  "internalPoints": []
}
```

Example for 4-corner coordinate-only output:

```json
{
  "labelFormat": {
    "type": "xy_pairs"
  },
  "cornerNames": ["top_left", "bottom_left", "bottom_right", "top_right"],
  "exportOrder": ["corner_0", "corner_1", "corner_2", "corner_3"],
  "internalPoints": []
}
```

Notes:

- `yolo_obb` writes class id plus ordered normalized corner coordinates.
- `xy_pairs` does not store visibility or bounding boxes.
- When using `yolo_obb` or `xy_pairs`, every exported point must be present before saving.

Effective keypoint count is determined by the normalized template:

- corner count = max(`annotation.cornerCount`, `cornerNames.length`)
- total keypoints = corner points + internal points

For Ultralytics YOLO pose, set:

```yaml
kpt_shape: [<total_keypoint_count>, 3]
```

Example: if 6 keypoints in total, use `kpt_shape: [6, 3]`.

## 4) Run

### Local mode (single machine)

```bash
npm run start:local
```

Open: `http://127.0.0.1:3000`

### Shared mode (LAN/server)

```bash
npm run start:shared
```

Open: `http://<server-ip>:3000`

Background helper scripts:

```bash
./scripts/start-intranet.sh
./scripts/stop-intranet.sh
```

## 5) systemd deployment (Linux)

The repository includes a service unit file: `deploy/jiaolong-labeler.service`.

Before enabling it:

1. Update `WorkingDirectory` and `ExecStart` to your server path.
2. Adjust `Environment` values (`APP_MODE`, `HOST`, `PORT`) as needed.

Install and enable:

```bash
sudo cp deploy/jiaolong-labeler.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jiaolong-labeler.service
```

Common operations:

```bash
sudo systemctl status jiaolong-labeler.service
sudo systemctl restart jiaolong-labeler.service
sudo journalctl -u jiaolong-labeler.service -f
```

## 6) Data layout

- Images: `images` (supports recursive subfolders)
- Runtime state: `data/store.json`
- Labels output: `labels/<relative-image-path>.txt`
- Export summary: `exports/last-export.json`

## 7) Manual verification

No test/lint pipeline is configured in this repo.

Recommended checks:

1. Start server in `local` and `shared` modes.
2. Verify annotation flow on `/`.
3. Verify visualize/edit flow on `/visualize.html`.
4. Confirm output keypoint count/order matches template.
