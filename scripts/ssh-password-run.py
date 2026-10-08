"""用密码执行一条远程命令（命令从 MACHI_SSH_COMMAND 读取），仅用于一次性排查。"""
import os
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

host = os.environ.get("MACHI_SSH_HOST", "49.235.114.142")
user = os.environ.get("MACHI_SSH_USER", "root")
password = os.environ.get("MACHI_SSH_PASSWORD")
command = os.environ.get("MACHI_SSH_COMMAND")

if not password or not command:
    raise SystemExit("缺少 MACHI_SSH_PASSWORD 或 MACHI_SSH_COMMAND")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=15, allow_agent=False, look_for_keys=False)
_, stdout, stderr = client.exec_command(command, timeout=60)
print(stdout.read().decode("utf-8", "replace"))
err = stderr.read().decode("utf-8", "replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
code = stdout.channel.recv_exit_status()
client.close()
raise SystemExit(code)
