# Jiaolong Labeler

English README: `README.md`

Jiaolong Labeler 是一个可配置的 YOLO 关键点标注工具。

- 支持通过模板配置关键点，不再固定 4 点。
- 支持两种部署方式：`local`（本地单机）和 `shared`（多人共享）。
- 标注结果输出到 `labels/<图片名>.txt`，格式为 YOLO pose。

## 1）环境要求

- Node.js `>=18`
- 待标注图片放入 `images`（支持多级子文件夹）
- 支持的图片后缀在 `server.js` 的 `IMAGE_EXTS` 中定义

## 2）配置方式

运行时配置文件：`config/app-config.json`

1. 先复制示例配置：

```bash
cp config/app-config.example.json config/app-config.json
```

2. 再按需修改。

示例（`config/app-config.json`）：

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

### 关键字段说明

- `deploymentMode`: `local` 或 `shared`
  - `local`：无需登录/注册，直接使用 `localUser`
  - `shared`：启用登录/注册，适合多人协作
- `server.host` / `server.port`：服务监听地址和端口
  - 本地建议：`127.0.0.1`
  - 局域网/服务器共享建议：`0.0.0.0`
- `annotation.cornerCount`：角点数量（`corner_0 ... corner_n`）
- `annotation.templateFile`：模板文件路径

也支持环境变量覆盖：

- `APP_MODE` 覆盖 `deploymentMode`
- `HOST` 覆盖 `server.host`
- `PORT` 覆盖 `server.port`

## 3）关键点模板与个数

模板由 `annotation.templateFile` 指定（默认 `data/template.json`）。

示例：

```json
{
  "classId": 0,
  "cornerNames": ["top_left", "bottom_left", "bottom_right", "top_right"],
  "exportOrder": ["corner_0", "corner_1", "corner_2", "corner_3"],
  "internalPoints": []
}
```

- `cornerNames`：界面中角点显示名称
- `exportOrder`：YOLO 输出顺序
- `internalPoints`：可选内部点

最终关键点数量规则：

- 角点数 = `max(annotation.cornerCount, cornerNames.length)`
- 总关键点数 = 角点数 + 内部点数

若使用 Ultralytics YOLO pose，数据集配置应设置：

```yaml
kpt_shape: [<总关键点数>, 3]
```

例如总关键点数是 6，则设为 `kpt_shape: [6, 3]`。

## 4）运行方式

### 本地模式（单机）

```bash
npm run start:local
```

访问：`http://127.0.0.1:3000`

### 共享模式（局域网/服务器）

```bash
npm run start:shared
```

访问：`http://服务器IP:3000`

后台运行脚本：

```bash
./scripts/start-intranet.sh
./scripts/stop-intranet.sh
```

## 5）systemd 部署（Linux）

仓库里提供了服务文件：`deploy/jiaolong-labeler.service`。

启用前请先修改：

1. `WorkingDirectory` 和 `ExecStart` 为你的服务器实际路径。
2. 按需调整 `Environment`（`APP_MODE`、`HOST`、`PORT`）。

安装并启用：

```bash
sudo cp deploy/jiaolong-labeler.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jiaolong-labeler.service
```

常用命令：

```bash
sudo systemctl status jiaolong-labeler.service
sudo systemctl restart jiaolong-labeler.service
sudo journalctl -u jiaolong-labeler.service -f
```

## 6）数据目录

- 图片目录：`images`（支持递归子目录）
- 运行状态：`data/store.json`
- 标注输出：`labels/<图片相对路径>.txt`
- 导出摘要：`exports/last-export.json`

## 7）验证建议

本项目当前未配置自动化 test/lint。

建议手工验证：

1. 分别以 `local` 与 `shared` 模式启动。
2. 在 `/` 页面完成标注流程。
3. 在 `/visualize.html` 页面完成可视化编辑流程。
4. 检查导出的关键点数量和顺序是否与模板一致。
