param(
  [ValidateSet('app', 'backend')]
  [string]$Mode = 'app'
)

$ErrorActionPreference = 'Stop'

$env:BAILONGMA_HOST = '0.0.0.0'
$env:BAILONGMA_ALLOW_LAN = '1'

# ── LAN 鉴权：没有 BAILONGMA_API_TOKEN 时自动生成并持久化到 .env ──
# 未设置 token 时，局域网内任何设备都能向 Agent 下令/读媒体/控会议室，属高危暴露。
# 这里生成随机 token 写入 .env，保证重启后稳定，并提示 LAN 设备如何带 token 访问。
$envFile = Join-Path $PSScriptRoot '..\.env'
$envFile = [System.IO.Path]::GetFullPath($envFile)
$env:BAILONGMA_API_TOKEN = $env:BAILONGMA_API_TOKEN

if (-not $env:BAILONGMA_API_TOKEN) {
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^BAILONGMA_API_TOKEN\s*=\s*(.+)$' | Select-Object -First 1
    if ($m -and $m.Matches[0].Groups[1].Value.Trim()) {
      $env:BAILONGMA_API_TOKEN = $m.Matches[0].Groups[1].Value.Trim()
    }
  }
}

if (-not $env:BAILONGMA_API_TOKEN) {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $env:BAILONGMA_API_TOKEN = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  if (Test-Path $envFile) {
    if (Select-String -Path $envFile -Pattern '^BAILONGMA_API_TOKEN\s*=' -Quiet) {
      (Get-Content $envFile -Raw) -replace '^BAILONGMA_API_TOKEN\s*=.*$', "BAILONGMA_API_TOKEN=$env:BAILONGMA_API_TOKEN" | Set-Content $envFile -Encoding UTF8
    } else {
      Add-Content $envFile "`nBAILONGMA_API_TOKEN=$env:BAILONGMA_API_TOKEN"
    }
  } else {
    Set-Content $envFile "BAILONGMA_API_TOKEN=$env:BAILONGMA_API_TOKEN" -Encoding UTF8
  }
  Write-Host "[lan] 已生成并保存 BAILONGMA_API_TOKEN 到 .env（重启后不变）" -ForegroundColor Yellow
}

function Test-PrivateLanAddress {
  param([string]$Address)

  $parts = $Address.Split('.') | ForEach-Object { [int]$_ }
  return $parts[0] -eq 10 -or
    ($parts[0] -eq 172 -and $parts[1] -ge 16 -and $parts[1] -le 31) -or
    ($parts[0] -eq 192 -and $parts[1] -eq 168)
}

$addresses = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.PrefixOrigin -ne 'WellKnown' -and
    (Test-PrivateLanAddress $_.IPAddress)
  } |
  Select-Object -ExpandProperty IPAddress -Unique

Write-Host ''
Write-Host 'Bailongma LAN mode is enabled.'
Write-Host 'Open one of these URLs on another device connected to the same network:'
foreach ($address in $addresses) {
  $tok = $env:BAILONGMA_API_TOKEN
  if ($tok) {
    Write-Host "  http://$address`:3721/?token=$tok"
  } else {
    Write-Host "  http://$address`:3721/"
  }
}
Write-Host ''
Write-Host 'LAN access is authenticated with BAILONGMA_API_TOKEN (set in .env / printed above).'
Write-Host 'Without the token, command/private APIs are rejected; only the public site opens.'
Write-Host 'If the page does not open, allow Node/Electron through Windows Firewall for private networks.'
Write-Host ''

if ($Mode -eq 'backend') {
  # 统一走 Electron 运行时（ELECTRON_RUN_AS_NODE），native 模块保持 Electron ABI，无需切换
  $env:ELECTRON_RUN_AS_NODE = '1'
  & .\node_modules\.bin\electron.cmd --env-file=.env src/index.js
} else {
  electron .
}
