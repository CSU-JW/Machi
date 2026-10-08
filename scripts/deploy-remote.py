"""通过密码通道部署：上传 tar.gz -> 备份 -> 解压 -> 测试 -> PM2 重启 -> 健康检查。

用法：
  MACHI_SSH_PASSWORD=... python scripts/deploy-remote.py <bundle.tar.gz>
"""
import glob
import os
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

host = os.environ.get("MACHI_SSH_HOST", "49.235.114.142")
user = os.environ.get("MACHI_SSH_USER", "root")
password = os.environ.get("MACHI_SSH_PASSWORD")
if not password:
    raise SystemExit("缺少 MACHI_SSH_PASSWORD")

if len(sys.argv) > 1:
    bundle = sys.argv[1]
else:
    candidates = sorted(glob.glob(os.path.join(os.environ.get("TEMP", "."), "machi-deploy-*.tar.gz")))
    if not candidates:
        raise SystemExit("找不到部署包")
    bundle = candidates[-1]
if not os.path.isfile(bundle):
    raise SystemExit(f"找不到部署包：{bundle}")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
print(f"[deploy] 连接 {user}@{host} ...")
client.connect(host, username=user, password=password, timeout=20, allow_agent=False, look_for_keys=False)

print(f"[deploy] 上传 {os.path.basename(bundle)} -> /root/machi-deploy.tar.gz")
sftp = client.open_sftp()
sftp.put(bundle, "/root/machi-deploy.tar.gz")
sftp.close()

remote_script = r"""
set -e
echo "[remote] node $(node -v)"
cd /root
backup="/root/machi-backup-$(date +%s).tar.gz"
tar -czf "$backup" --exclude=machi/node_modules machi
echo "[remote] backup -> $backup"
cd /root/machi
tar -xzf /root/machi-deploy.tar.gz
if [ ! -d node_modules/ws ]; then
  npm install --omit=dev
else
  echo "[remote] node_modules/ws already present, skip npm install"
fi
echo "[remote] run tests"
node --test test
echo "[remote] restart pm2"
pm2 restart machi
sleep 1
echo "[remote] health"
curl -fsS http://127.0.0.1:3000/api/health
echo
echo DEPLOY_DONE
"""

stdin, stdout, stderr = client.exec_command(remote_script, timeout=600, get_pty=True)
for line in iter(stdout.readline, ""):
    print(line, end="")
code = stdout.channel.recv_exit_status()
error_output = stderr.read().decode("utf-8", "replace")
if error_output.strip():
    print("STDERR:", error_output, file=sys.stderr)
client.close()
raise SystemExit(code)
