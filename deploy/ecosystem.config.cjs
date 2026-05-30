/** pm2 进程配置：在项目根目录执行 pm2 start deploy/ecosystem.config.cjs */
module.exports = {
  apps: [
    {
      name: 'meeting-signal',
      script: 'server/signaling-server.js',
      cwd: '/opt/meeting-app',
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
        BIND_HOST: '127.0.0.1',
      },
    },
  ],
}
