<#
.SYNOPSIS
  Adds your React dev-server origin(s) to the IPFS daemon's API.HTTPHeaders (MERGE: existing origins are kept),
  using the daemon's own HTTP API with URL-encoded JSON values (no PowerShell quoting problems).
  It does NOT run 'ipfs init', does NOT replace the config file, and does NOT touch keys, pins or blocks.

.DESCRIPTION
  Kubo reads API.HTTPHeaders ONLY when the daemon starts. This script therefore ends by telling you to restart,
  and (with -Shutdown) can stop the daemon for you; then start IPFS Desktop again.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\fix-ipfs-cors.ps1
  powershell -ExecutionPolicy Bypass -File scripts\fix-ipfs-cors.ps1 -Shutdown     # also stops the daemon so you can start it again
  powershell -ExecutionPolicy Bypass -File scripts\fix-ipfs-cors.ps1 -Origins http://localhost:8080,http://localhost:3000
#>
param(
  [string]$Api = "http://127.0.0.1:5001",
  [string[]]$Origins = @("http://localhost:8080", "http://127.0.0.1:8080"),
  [switch]$Shutdown
)

# Kubo answers 403 to any request whose User-Agent starts with "Mozilla/" and has no allowed Origin
# (anti-CSRF for browsers) - and PowerShell's DEFAULT User-Agent is "Mozilla/5.0 (...) PowerShell/x".
# So every call below sets a neutral User-Agent.
$UA = "fix-ipfs-cors.ps1"

function Ipfs-Config([string]$Key, [string]$JsonValue) {
  # Query string must be URL-encoded; EscapeDataString handles quotes, brackets, colons and slashes.
  $enc = [uri]::EscapeDataString($JsonValue)
  $url = "$Api/api/v0/config?arg=$([uri]::EscapeDataString($Key))&arg=$enc&json=true"
  Invoke-RestMethod -Method Post -UserAgent $UA -Uri $url
}
function Ipfs-GetConfig([string]$Key) {
  Invoke-RestMethod -Method Post -UserAgent $UA -Uri "$Api/api/v0/config?arg=$([uri]::EscapeDataString($Key))"
}

try { $null = Invoke-RestMethod -Method Post -UserAgent $UA -Uri "$Api/api/v0/version" }
catch {
  Write-Host "Cannot reach the IPFS daemon at $Api ($($_.Exception.Message))." -ForegroundColor Red
  Write-Host "If IPFS Desktop will not start, your config file may be unloadable: run  node scripts\repair-ipfs-config.mjs  first."
  exit 2
}

# --- merge, never replace: keep every origin that is already there
$existing = @()
try { $existing = @((Ipfs-GetConfig "API.HTTPHeaders.Access-Control-Allow-Origin").Value) } catch {}
$merged = @($existing + $Origins | Where-Object { $_ } | Select-Object -Unique)
Write-Host "Existing Allow-Origin : $($existing -join ', ')"
Write-Host "Resulting Allow-Origin: $($merged -join ', ')"

$methods = @("GET", "POST", "OPTIONS")
$curM = @(); try { $curM = @((Ipfs-GetConfig "API.HTTPHeaders.Access-Control-Allow-Methods").Value) } catch {}
$methods = @($curM + $methods | Where-Object { $_ } | Select-Object -Unique)
$hdrs = @("Content-Type")
$curH = @(); try { $curH = @((Ipfs-GetConfig "API.HTTPHeaders.Access-Control-Allow-Headers").Value) } catch {}
$hdrs = @($curH + $hdrs | Where-Object { $_ } | Select-Object -Unique)

# ConvertTo-Json would unwrap single-element arrays in PS 5.1, so build the JSON arrays by hand.
function To-JsonArray([string[]]$items) { "[" + (($items | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ",") + "]" }

$r1 = Ipfs-Config "API.HTTPHeaders.Access-Control-Allow-Origin"  (To-JsonArray $merged)
$r2 = Ipfs-Config "API.HTTPHeaders.Access-Control-Allow-Methods" (To-JsonArray $methods)
$r3 = Ipfs-Config "API.HTTPHeaders.Access-Control-Allow-Headers" (To-JsonArray $hdrs)
Write-Host "Saved to the config file:"
Write-Host "  Allow-Origin  = $($r1.Value -join ', ')"
Write-Host "  Allow-Methods = $($r2.Value -join ', ')"
Write-Host "  Allow-Headers = $($r3.Value -join ', ')"
Write-Host ""
Write-Host "IMPORTANT: this is NOT active yet. The running daemon loaded its HTTP headers at startup." -ForegroundColor Yellow

if ($Shutdown) {
  Write-Host "Stopping the daemon (POST /api/v0/shutdown)..."
  try { $null = Invoke-RestMethod -Method Post -UserAgent $UA -Uri "$Api/api/v0/shutdown" } catch { }
  Write-Host "Now START IPFS Desktop again (or run 'ipfs daemon'), then run:  scripts\diagnose-ipfs.ps1"
} else {
  Write-Host "Restart it now: IPFS Desktop tray icon -> Restart  (or quit and reopen IPFS Desktop; or re-run with -Shutdown)."
  Write-Host "Then verify with:  powershell -ExecutionPolicy Bypass -File scripts\diagnose-ipfs.ps1"
}
