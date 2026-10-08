"""一次性用密码登录服务器，把部署公钥追加到 root 的 authorized_keys。

用法（密码与公钥都从环境变量读取，不写入文件）：
  MACHI_SSH_PASSWORD=... MACHI_PUBKEY=... python scripts/install-deploy-key.py [host] [user]
"""
import os
import sys

import paramiko

host = sys.argv[1] if len(sys.argv) > 1 else "49.235.114.142"
user = sys.argv[2] if len(sys.argv) > 2 else "root"
password = os.environ.get("MACHI_SSH_PASSWORD")
public_key = (os.environ.get("MACHI_PUBKEY") or "").strip()

if not password:
    raise SystemExit("缺少 MACHI_SSH_PASSWORD")
if not public_key.startswith("ssh-ed25519 ") or "'" in public_key:
    raise SystemExit("MACHI_PUBKEY 不是合法的 ed25519 公钥")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=15, allow_agent=False, look_for_keys=False)

remote = "\n".join([
    "set -e",
    "mkdir -p /root/.ssh",
    "chmod 700 /root/.ssh",
    "touch /root/.ssh/authorized_keys",
    "chmod 600 /root/.ssh/authorized_keys",
    f"grep -qxF '{public_key}' /root/.ssh/authorized_keys || echo '{public_key}' >> /root/.ssh/authorized_keys",
    "wc -l /root/.ssh/authorized_keys",
    "echo KEY_INSTALLED",
    "hostname",
    "node -v",
])
_, stdout, stderr = client.exec_command(remote, timeout=30)
out = stdout.read().decode("utf-8", "replace")
err = stderr.read().decode("utf-8", "replace")
code = stdout.channel.recv_exit_status()
print(out)
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()
raise SystemExit(code)
