# 一键起依赖服务：Tender(8080) + 记忆边车(8090)
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\start-services.ps1
$ErrorActionPreference = 'Stop'

$tender = 'D:\Tender\Tender-Product'
$python = Join-Path $tender '.venv\Scripts\python.exe'
$sidecar = 'D:\Tender\daoql-edu-serve\target\debug\daoql-edu-serve.exe'

if (-not (Test-Path $python)) { throw "找不到 Tender 的 python: $python" }

Write-Host '启动记忆边车 8090 ...'
$env:DAOQL_EDU_PATH = Join-Path (Split-Path $tender) 'daoql-edu-serve\data'
$env:DAOQL_EDU_PORT = '8090'
Start-Process -FilePath $sidecar -WorkingDirectory (Split-Path $sidecar) -WindowStyle Hidden

Write-Host '启动 Tender 8080 ...'
$env:HEART_MEMORY_URL = 'http://127.0.0.1:8090'
$env:PYTHONIOENCODING = 'utf-8'
Start-Process -FilePath $python -WorkingDirectory (Join-Path $tender 'agent_layer') `
  -ArgumentList @('-X', 'utf8', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8080') `
  -WindowStyle Hidden

Start-Sleep -Seconds 8
foreach ($url in 'http://127.0.0.1:8080/health', 'http://127.0.0.1:8090/health') {
  try {
    $r = Invoke-RestMethod -Uri $url -TimeoutSec 5
    Write-Host ("OK  {0}  {1}" -f $url, ($r | ConvertTo-Json -Compress))
  } catch {
    Write-Warning ("FAIL {0}  {1}" -f $url, $_.Exception.Message)
  }
}
