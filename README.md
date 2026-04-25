# Four Keypoint Labeler

一个面向多人协作的图片四关键点标注小站。把待标注图片放到 `images/total`，标注员注册或登录后领取图片，依次点击四个关键点，切换图片或完成提交时会自动写入 `labels/` 下的同名 `.txt` 文件。

## 启动

```bash
npm start
```

打开 `http://localhost:3000`。如果需要给局域网内其他机器访问，可以使用服务器机器的局域网 IP，例如 `http://192.168.x.x:3000`。

如需和原项目同时运行，换一个端口：

```bash
PORT=3001 npm start
```

## 标注流程

1. 标注员注册或登录。
2. 点击“下一张”，系统会领取一张未被占用、未标注的图片。
3. 在图片上依次点击四个关键点：左上、左下、右下、右上。
4. 拖拽任意点微调位置，选中点后点击“切换可见”可标为不可见。键盘 `V` 也可以切换当前点可见性，右键点击某个点可直接翻转该点可见性。
5. 点击“下一张”或“完成提交并下一张”都会自动写入 `labels/` 下的同名 `.txt` 文件。返回修改时，系统会优先读取这个 label 文件并在修改后覆盖它。

快捷键：

- `A` 或 `←`：上一张
- `D` 或 `→`：下一张
- `V`：切换当前选中点可见性

视图操作：

- 鼠标滚轮：以鼠标位置为中心缩放图片
- 鼠标右键拖拽：平移图片
- 鼠标左键拖动关键点：移动关键点，拖动时会显示局部放大框和准星

## 关键点模板

模板文件是 `data/template.json`：

```json
{
  "classId": 0,
  "cornerNames": ["top_left", "bottom_left", "bottom_right", "top_right"],
  "exportOrder": ["corner_0", "corner_1", "corner_2", "corner_3"],
  "internalPoints": []
}
```

`cornerNames` 控制界面显示名称，`exportOrder` 控制 label 文件里的关键点顺序。默认顺序是：

```text
top_left bottom_left bottom_right top_right
```

## Label 文件

标注会自动写入 `labels/`，每张图一个同名 `.txt` 文件。这个文件使用 YOLO pose 的行格式：前 5 个字段描述类别和目标框，后面按 `data/template.json` 的顺序依次写 4 个关键点。

输出格式为：

```text
class_id center_x center_y width height kp1_x kp1_y kp1_visibility kp2_x kp2_y kp2_visibility kp3_x kp3_y kp3_visibility kp4_x kp4_y kp4_visibility
```

每个关键点包含 `x y v` 三个数据。整行前面的 5 个字段不是关键点，它们是 YOLO pose 训练格式要求的目标类别和目标框：

- `class_id`：类别编号
- `center_x center_y width height`：目标框，当前由已标注点的最小外接框计算

所有坐标都是相对图片宽高归一化后的值。可见性使用常见 keypoint 约定：`2` 表示可见，`1` 表示已标注但不可见，`0` 表示模板里有这个点但当前没有有效标注。

如果使用 Ultralytics YOLO pose，数据集配置里的关键点形状应为：

```yaml
kpt_shape: [4, 3]
```

## 数据文件

运行时数据保存在 `data/store.json`，导出摘要保存在 `exports/last-export.json`。这些文件已加入 `.gitignore`，避免把实际标注过程数据误提交。
