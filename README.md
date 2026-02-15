---
title: Chaoxing Sync Cinema
emoji: 🎬
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
---

# 超星同步放映厅（无 AList 依赖）

本项目已实现：

- 超星小组盘目录浏览与播放（直连超星接口，不依赖 AList 服务）
- 视频流代理转发（修复跨域/鉴权导致的在线播放失败）
- 房间同步播放（播放、暂停、拖动、倍速、心跳校准）
- 实时聊天、表情、弹幕
- 全屏底部弹幕输入栏（类似 B 站交互）
- 访问密码门禁（默认 `520`）
- 在线大厅（显示当前在线房间）
- 随机昵称 / 随机房间号快速建房
- 移动端适配布局

## 1. 本地运行

```bash
npm install
cp .env.example .env
npm start
```

浏览器访问 `http://127.0.0.1:3000`。

## 2. 环境变量

优先推荐使用 `CX_ADDITION_JSON`，也支持分字段配置：

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
3. 在 `Settings -> Variables and secrets` 配置环境变量与机密
4. 等待构建完成并访问 Space 地址

默认使用 `PORT=7860`，与 HF Space 约定一致。

## 4. 使用流程

1. 打开页面先输入访问密码（默认 `520`）
2. 在大厅随机生成昵称和房间号，或加入已有在线房间
3. 进入房间后主控选择视频并播放，其他端自动同步
4. 在聊天区发送消息/表情
5. 在普通模式或全屏模式发送弹幕，双方实时显示

## 5. 安全建议

- 不要把超星账号、密码、Cookie 写入仓库文件
- 将敏感信息放到环境变量和 Space Secrets
- 如果凭据泄露，立即修改密码并让旧 Cookie 失效
