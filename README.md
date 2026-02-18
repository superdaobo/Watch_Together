---
title: Chaoxing Sync Cinema
emoji: 🎬
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
---

# 超星同步放映厅（HF 托管 + 移动端壳应用）

## 1. 功能概览

- 大厅页 + 房间页分离，先建房再进入播放页
- 访问密码门禁（默认 `520`）
- S3 目录浏览与直连播放
- 房间同步播放（播放、暂停、拖动、倍速、心跳校准）
- 聊天 / 表情 / 弹幕（含全屏输入栏）
- 移动端优化布局（底部标签切换：播放/片库/聊天）
- Capacitor 移动端壳（Android + iOS）

## 2. 本地运行（Web）

```bash
npm install
cp .env.example .env
npm start
```

访问：`http://127.0.0.1:3000`

## 3. 环境变量

```env
PORT=3000
APP_ACCESS_PASSWORD=520

S3_ENDPOINT=https://s3.cstcloud.cn
S3_BUCKET=
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=true
S3_PLAY_MODE=signed-header
S3_URL_EXPIRE_SECONDS=1800
S3_MAX_KEYS=1000

SYNC_DRIFT_THRESHOLD=0.4
ROOM_CHAT_LIMIT=300
ROOM_DANMAKU_LIMIT=500

# Capacitor 壳应用加载的线上地址（建议指向你的 HF Space）
MOBILE_WEB_URL=https://mini-hbut-video-online.hf.space
```

## 4. Hugging Face Spaces 部署

1. 创建 Docker Space
2. 推送代码
3. 在 `Settings -> Variables and secrets` 填入环境变量
4. 等待构建完成

HF 默认端口：`7860`

## 5. 移动端构建（Capacitor）

```bash
npm run mobile:doctor
npm run mobile:add:android
npm run mobile:add:ios
npm run mobile:sync
```

说明：
- Android 需要 Android SDK / JDK
- iOS 需要 macOS + Xcode
- 壳应用加载 `MOBILE_WEB_URL` 指向的 HF 服务

## 6. GitHub Actions 自动构建与 Release

工作流：`.github/workflows/mobile-release.yml`

触发方式：
- push 到 `main`
- 手动 `workflow_dispatch`

产物：
- Android：`app-debug.apk`
- iOS：`watch-together-ios-simulator.zip`（模拟器 app 包）

工作流会在构建成功后自动创建 GitHub Release。

## 7. 安全建议

- 不要把 S3 密钥提交到仓库
- 生产环境变量仅放在 HF / GitHub Secrets
- 凭据泄露后立即轮换
