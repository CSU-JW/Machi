param(
  [string]$Server = '49.235.114.142',
  [Parameter(Mandatory = $true)][string]$Bundle,
  [string]$User = 'root',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\machi_deploy'),
  [string]$RemoteDir = '/root/machi'
)

if (-not (Test-Path -LiteralPath $Bundle)) { throw "找不到部署包：$Bundle" }
if (-not (Test-Path -LiteralPath $KeyPath)) { throw "找不到部署私钥：$KeyPath" }

$remote = "$User@$Server"
$sshOptions = @('-i', $KeyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10')

Write-Host "[deploy] 上传 $Bundle -> ${remote}:/root/machi-deploy.tar.gz"
& scp @sshOptions $Bundle "${remote}:/root/machi-deploy.tar.gz"
if ($LASTEXITCODE -ne 0) { throw 'scp 上传失败' }

$remoteScript = @'
set -e
echo "node: $(node -v)"
cd /root
tar -czf /root/machi-backup-$(date +%s).tar.gz --exclude=machi/node_modules machi
cd /root/machi
tar -xzf /root/machi-deploy.tar.gz
npm install --omit=dev
node --test test
pm2 restart machi
sleep 1
curl -fsS http://127.0.0.1:3000/api/health
'@

Write-Host '[deploy] 服务器上执行：备份 -> 解压 -> 安装依赖 -> 测试 -> 重启 PM2'
& ssh @sshOptions $remote $remoteScript
if ($LASTEXITCODE -ne 0) { throw '远程部署失败' }

Write-Host '[deploy] 完成'
