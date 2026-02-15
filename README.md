---
title: Chaoxing Sync Cinema
emoji: 🎬
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
---

# 超星同步放映厅（无 AList 依赖）

当前版本特性：

- 大厅页与房间页分离：先在大厅建房/选房，再进入播放页
- 访问密码门禁（默认 `520`）
- 超星小组盘目录浏览
- 直连播放（不走服务器视频代理）
- 多直连地址回退（提升特定视频播放成功率）
- 自定义播放器控制条（播放、进度、倍速、音量、全屏）
- 房间同步播放（播放、暂停、拖动、倍速、心跳校准）
- 聊天、表情、弹幕
- 全屏底部弹幕输入栏
- 移动端友好布局

## 1. 本地运行

```bash
npm install
cp .env.example .env
npm start
```

浏览器访问 `http://127.0.0.1:3000`。

## 2. 环境变量

推荐使用 `CX_ADDITION_JSON`，也支持分字段配置：

```env
PORT=3000
APP_ACCESS_PASSWORD=520

CX_USER_NAME=
CX_PASSWORD=
CX_BBSID=
CX_ROOT_FOLDER_ID=-1
CX_COOKIE=
CX_ADDITION_JSON=

SYNC_DRIFT_THRESHOLD=0.4
ROOM_CHAT_LIMIT=300
ROOM_DANMAKU_LIMIT=500
```

`CX_ADDITION_JSON` 示例：

```env
CX_ADDITION_JSON={"user_name":"...","password":"...","bbsid":"...","root_folder_id":"-1","cookie":"..."}
```

## 3. Hugging Face Spaces 部署

1. 创建 `Docker Space`
2. 推送本项目代码
3. 在 `Settings -> Variables and secrets` 配置环境变量和机密
4. 等待构建完成并访问 Space 地址

默认监听 `PORT=7860`，与 HF Space 约定一致。

## 4. 页面与流程

1. 打开 `/`（大厅页），输入访问密码
2. 在大厅随机生成昵称和房间号，或加入在线房间
3. 进入 `/room.html` 后主控选择视频并播放
4. 其他端自动同步播放状态
5. 聊天和弹幕可在普通/全屏模式下发送与显示

## 5. 安全建议

- 不要把超星账号、密码、Cookie 提交到仓库
- 生产环境只放在环境变量和 Space Secrets
- 如凭据泄露，立即改密码并使旧 Cookie 失效
