---
title: Chaoxing Sync Cinema
emoji: 🎬
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
---

# 超星同步放映室（无 AList 依赖）

这个项目实现了：

- 超星小组盘目录浏览与视频播放地址获取（直连超星接口，不使用 AList 服务）
- 双人/多人房间同步播放（播放、暂停、拖动、倍速、心跳校准）
- 实时聊天 + 表情
- 视频全屏下的底部弹幕输入栏（类似 B 站交互）
- 弹幕跨端实时展示

## 1. 本地运行

```bash
npm install
cp .env.example .env
npm start
```

打开 `http://127.0.0.1:3000`。

## 2. 环境变量

可二选一配置：

1. 分字段配置（推荐）
2. `CX_ADDITION_JSON` 一次性传入

`.env` 示例：

```env
PORT=3000
CX_USER_NAME=你的超星账号
CX_PASSWORD=你的超星密码
CX_BBSID=你的小组 bbsid
CX_ROOT_FOLDER_ID=-1
CX_COOKIE=
SYNC_DRIFT_THRESHOLD=0.4
ROOM_CHAT_LIMIT=300
ROOM_DANMAKU_LIMIT=500
```

如果你已有 `addition` JSON，可直接：

```env
CX_ADDITION_JSON={"user_name":"...","password":"...","bbsid":"...","root_folder_id":"-1","cookie":"..."}
```

## 3. Hugging Face Spaces 部署

1. 在 Hugging Face 新建 `Docker Space`
2. 上传本仓库代码
3. 在 Space 的 `Settings -> Variables and secrets` 配置上面的环境变量
4. 启动后访问 Space 地址

本项目默认监听 `PORT=7860`，与 HF Space 约定一致。

## 4. 使用流程

1. 左侧选择超星小组盘目录，点击视频文件加载播放地址
2. 顶部填写房间号和昵称，双方加入同一房间
3. 点击“成为主控”，主控端控制播放，另一端自动跟随
4. 右侧发送聊天消息/表情，双方实时显示
5. 输入弹幕，或全屏后在底部栏发送弹幕

## 5. 安全建议

你在对话里贴过完整账号与 Cookie。建议立刻：

1. 修改超星账号密码
2. 让旧 Cookie 失效后再使用新凭据部署

避免将真实凭据提交到代码仓库。
