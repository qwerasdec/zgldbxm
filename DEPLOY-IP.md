# 用公网 IP 上线（无域名）

示例公网 IP：`112.124.13.31`（请换成你控制台里的 **公网 IP**）。

## 一、阿里云安全组

入方向放行：

| 端口 | 说明 |
|------|------|
| 22 | SSH |
| 80 | 网站 HTTP |
| 443 | 可选，启用自签 HTTPS 时 |

**不要**对公网开放 3001，信令只在本机，由 Nginx 反代。

## 二、本机打包上传

在项目根目录（Windows PowerShell）：

```powershell
cd "C:\Users\31469\Desktop\专高六答辩项目"
npm install
npm run build
```

把整个项目上传到服务器（任选一种）：

```powershell
# 需已配置 SSH 密钥；把 IP 和用户名改成你的
scp -r . root@112.124.13.31:/opt/meeting-app
```

或在服务器上用 `git clone` 再 `npm run build`。

服务器上要有文件：`/opt/meeting-app/dist`、`/opt/meeting-app/server`、`/opt/meeting-app/package.json`、`/opt/meeting-app/.env`（从 `.env.example` 复制并填好密钥）。

## 三、服务器首次配置（SSH 登录后）

```bash
ssh root@112.124.13.31
cd /opt/meeting-app
cp .env.example .env   # 编辑 .env，填 AI、MySQL 等
npm ci --omit=dev
npm run build            # 若在本机已 build 可跳过

sudo bash deploy/setup-ubuntu.sh 112.124.13.31
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup              # 按提示执行一条命令，开机自启
```

浏览器访问：**http://112.124.13.31/**

## 四、需要摄像头/麦克风时（强烈建议）

纯 **http://IP** 下，浏览器会拦截摄像头（和本机局域网 http 一样）。

在服务器上生成自签 HTTPS：

```bash
cd /opt/meeting-app
bash deploy/gen-ssl-ip.sh 112.124.13.31
```

编辑 `deploy/nginx-ip.conf`，**取消文件末尾 443 `server { ... }` 整段注释**，然后：

```bash
sudo cp deploy/nginx-ip.conf /etc/nginx/sites-available/meeting
# 再次替换 IP（若改过）
sudo sed -i 's/__DEPLOY_IP__/112.124.13.31/g' /etc/nginx/sites-available/meeting
sudo nginx -t && sudo systemctl reload nginx
```

访问：**https://112.124.13.31/**（首次点「高级」→ 继续访问）。

上传 `dist` 时请包含 **`dist/mediapipe/`** 整个目录（虚拟背景依赖），不要只传 `dist/assets`。

**手机参会**：见 **[deploy/MOBILE-IOS.md](MOBILE-IOS.md)**。iPhone 若提示「此连接非私人连接」，需点「显示详细信息」→「访问此网站」，或先用 `http://IP/ios-cert.crt` 安装证书。Nginx 需包含 `location = /ios-cert.crt`（见 `nginx-ip-with-https.conf`）。

**多人互相看不到画面**：多为网络 NAT 限制；两人先都确认已点「开启摄像头」，并尽量用 https。仍不行需自建 TURN（进阶，见 coturn 文档）。

## 五、更新版本

```bash
cd /opt/meeting-app
git pull   # 或重新 scp 上传
npm ci --omit=dev
npm run build
pm2 restart meeting-signal
```

## 六、常见问题

- **打不开页面**：查安全组 80、Nginx `systemctl status nginx`、`curl -I http://127.0.0.1`
- **页面能开，会议连不上**：`pm2 logs meeting-signal`，确认 `pm2 status` 为 online
- **注册/登录显示 `Failed to fetch`**（英文）：
  1. 服务器 `.env` 里**删掉或注释** `VITE_SIGNAL_SERVER_URL=...`（不要用 https 写死 IP，你又用 http://IP 打开页面时会请求错地址）。
  2. 在项目目录执行 **`npm ci`**（需要 dev 依赖才能 `build`），再 **`npm run build`**，最后 **`pm2 restart meeting-signal`**。
  3. 浏览器 **Ctrl+F5** 强刷后再注册。
  4. 在服务器自测：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/api/auth/login -X POST -H "Content-Type: application/json" -d '{}'` 应得到 **400/401/503** 等数字，而不是连不上。
- **MySQL 报错 / 注册提示数据库**：信令会启动但登录注册要库；在服务器安装 MySQL，`MYSQL_*` 与 `.env` 一致后 `pm2 restart meeting-signal`，日志应出现 `DB: enabled`。

生产环境 Socket/API **与网站同源**（Nginx 反代 `/api`、`/socket.io`），**不要**再设 `VITE_SIGNAL_SERVER_URL`。
