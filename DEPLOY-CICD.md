# CI/CD 自动上线说明

本项目推荐：**GitHub 存代码 → push 自动构建 → SSH 部署到 `/opt/meeting-app`**。

```
开发者 push 代码
    ↓
GitHub Actions（云端 npm build）
    ↓
SCP 上传 dist + server + deploy
    ↓
服务器 npm ci --omit=dev + pm2 restart
    ↓
用户访问 https://你的IP
```

## 一、前置条件

1. 代码放在 **GitHub**（或 Gitee，见文末）
2. 服务器已能 SSH 登录（如 `root@112.124.13.31`）
3. 服务器**首次**已装好环境，且 **`.env` 只在服务器上**（不要提交到 Git）

首次在服务器：

```bash
mkdir -p /opt/meeting-app
# 把仓库 clone 上来，或 WinSCP 上传一次
cd /opt/meeting-app
cp .env.example .env && nano .env   # 填 AI、MySQL 等
bash deploy/remote-install.sh 112.124.13.31
```

## 二、配置 GitHub Secrets

仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：

| Secret 名 | 示例值 | 说明 |
|-----------|--------|------|
| `DEPLOY_HOST` | `112.124.13.31` | ECS 公网 IP |
| `DEPLOY_USER` | `root` | SSH 用户名 |
| `DEPLOY_SSH_KEY` | 私钥全文 | 本机 `~/.ssh/id_rsa` 内容 |
| `DEPLOY_SSH_PORT` | `22` | 可选，默认 22 |

### 生成 SSH 密钥（本机 PowerShell）

```powershell
ssh-keygen -t ed25519 -C "github-deploy" -f $env:USERPROFILE\.ssh\ecs_deploy
```

- 公钥 `ecs_deploy.pub` 内容追加到服务器：`/root/.ssh/authorized_keys`
- 私钥 `ecs_deploy` 全文粘贴到 Secret **`DEPLOY_SSH_KEY`**

## 三、触发部署

1. 把项目 push 到 GitHub 的 **`main`** 或 **`master`** 分支
2. 打开仓库 **Actions** 页，查看 **Deploy to ECS** 是否绿色成功
3. 浏览器访问 `https://你的IP` 验证

也可在 Actions 里点 **Run workflow** 手动部署。

## 四、CI 做了什么（`.github/workflows/deploy.yml`）

1. `npm ci` + `npm run build`（含 `dist/mediapipe`）
2. `deploy/verify-dist.sh` 检查构建产物
3. SCP 上传：`dist`、`server`、`deploy`、`package.json`、`package-lock.json`
4. SSH 执行：`npm ci --omit=dev`、`pm2 restart meeting-signal`
5. **不会覆盖服务器上的 `.env`**（已在 `.gitignore`）

## 五、分支与环境

| 做法 | 说明 |
|------|------|
| 仅 `main` 自动上线 | 默认 workflow 已配置 |
| 测试环境 | 可复制 workflow 为 `deploy-staging.yml`，改 `DEPLOY_HOST` 为测试机 Secret |
| 手动上线 | Actions → Run workflow |

## 六、不用 GitHub 时（本机脚本）

仍可用 WinSCP + 手动命令，见 `DEPLOY-IP.md`。

```powershell
npm run build
# 上传 dist 等到服务器后：
```

```bash
cd /opt/meeting-app && npm ci --omit=dev && pm2 restart meeting-signal
```

## 七、Gitee / GitLab

- **Gitee Go**：新建流水线，构建步骤同 `npm ci && npm run build`，发布用 **SSH 部署** 插件，脚本同 `remote-install.sh` 末尾。
- **GitLab CI**：用 `gitlab-ci.yml`，`rsync` + `ssh pm2 restart`，变量放在 CI/CD Variables。

## 八、常见问题

| 现象 | 处理 |
|------|------|
| Actions SSH 失败 | 检查安全组 22、公钥是否在 `authorized_keys` |
| 登录页 JSON 报错 | 服务器 `pm2 status` 是否 online |
| 虚拟背景失效 | 确认 CI 上传了完整 `dist`（含 `mediapipe`） |
| 密钥泄露 | 立即轮换 ARK/STT 密钥，勿把 `.env` 提交 Git |

## 九、开机自启（服务器重启后）

```bash
pm2 startup    # 按提示执行一条命令
pm2 save
sudo systemctl enable nginx
sudo systemctl enable mysql    # 若使用 MySQL
```

CI/CD 只负责**发版**；机器重启后需 PM2/Nginx 自启（`pm2 save` + `startup` 一次即可）。
