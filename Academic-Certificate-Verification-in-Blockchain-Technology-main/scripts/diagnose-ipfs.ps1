<#
.SYNOPSIS
  Proves (against the LIVE IPFS daemon) whether browser CORS requests from your React app will work, and if not, why.
  READ-ONLY: it changes nothing.

.DESCRIPTION
  Why this does more than "ipfs config": the daemon's /api/v0/config endpoint re-reads the config FILE on every call,
  so it shows the headers even when the running daemon never loaded them. The only proof is the real behaviour:
  an OPTIONS preflight carrying an Origin header. This script does that, and also reports
    - which repo the live daemon is really using (repo/stat -> RepoPath) vs the repo you edited,
    - whether the config file is newer than the running daemon (=> restart needed),
    - whether the config file itself is loadable by Kubo (Identity.PrivKey present, Version is an object).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\diagnose-ipfs.ps1
  powershell -ExecutionPolicy Bypass -File scripts\diagnose-ipfs.ps1 -Origin http://127.0.0.1:8080
#>
param(
  [string]$Api = "http://127.0.0.1:5001",
  [string]$Origin = "http://localhost:8080",
  [string]$RepoPath = ""
)

Add-Type -AssemblyName System.Net.Http
$script:client = New-Object System.Net.Http.HttpClient
$script:client.Timeout = [TimeSpan]::FromSeconds(10)

function Send-Http([string]$Method, [string]$Url, [string]$OriginHeader) {
  $req = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::new($Method), $Url)
  if ($OriginHeader) { [void]$req.Headers.TryAddWithoutValidation("Origin", $OriginHeader) }
  if ($Method -eq "OPTIONS") { [void]$req.Headers.TryAddWithoutValidation("Access-Control-Request-Method", "POST") }
  if ($Method -eq "POST" -and $Url -like "*/add*") {
    $form = New-Object System.Net.Http.MultipartFormDataContent
    $form.Add((New-Object System.Net.Http.StringContent("cors-probe")), "file", "probe.txt")
    $req.Content = $form
  }
  $resp = $script:client.SendAsync($req).GetAwaiter().GetResult()
  $vals = $null
  $acao = $null
  if ($resp.Headers.TryGetValues("Access-Control-Allow-Origin", [ref]$vals)) { $acao = ($vals -join ",") }
  $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  [pscustomobject]@{ Status = [int]$resp.StatusCode; AllowOrigin = $acao; Body = $body }
}
function Ipfs-Post([string]$PathAndQuery) { (Send-Http "POST" "$Api/api/v0/$PathAndQuery" $null) }

$problems = @()
Write-Host ""
Write-Host "=== 1. Is the daemon reachable? ($Api) ===" -ForegroundColor Cyan
try {
  $v = Ipfs-Post "version"
  $ver = $v.Body | ConvertFrom-Json
  Write-Host "  OK  Kubo $($ver.Version)  (repo version $($ver.Repo))"
} catch {
  Write-Host "  FAIL  cannot reach $Api : $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "        Start IPFS Desktop (or 'ipfs daemon'), then re-run."
  exit 2
}

Write-Host ""
Write-Host "=== 2. Which repo is the LIVE daemon using? ===" -ForegroundColor Cyan
$live = (Ipfs-Post "repo/stat").Body | ConvertFrom-Json
$liveRepo = $live.RepoPath
Write-Host "  live daemon RepoPath : $liveRepo"
if (-not $RepoPath) {
  if ($env:IPFS_PATH) { $RepoPath = $env:IPFS_PATH } else { $RepoPath = Join-Path $HOME ".ipfs" }
}
Write-Host "  repo you (probably) edited : $RepoPath"
$sameRepo = $false
try { $sameRepo = ([IO.Path]::GetFullPath($liveRepo).TrimEnd('\','/') -ieq [IO.Path]::GetFullPath($RepoPath).TrimEnd('\','/')) } catch {}
if ($sameRepo) { Write-Host "  OK  same repo" } else {
  Write-Host "  WARN  the daemon is NOT using the repo you edited -> your config edits can never apply." -ForegroundColor Yellow
  $problems += "Daemon uses a different repo ($liveRepo). Edit THAT repo's config (or set IPFS_PATH), then restart."
}

Write-Host ""
Write-Host "=== 3. What does the config say? (file vs what the daemon reports) ===" -ForegroundColor Cyan
$liveHdr = (Ipfs-Post "config?arg=API.HTTPHeaders").Body
Write-Host "  daemon /config API.HTTPHeaders : $liveHdr"
Write-Host "  (NOTE: this endpoint re-reads the file, so it does NOT prove the headers are active. Step 5 does.)"
$cfgFile = Join-Path $liveRepo "config"
$fileHasOrigin = $false
if (Test-Path $cfgFile) {
  $raw = [IO.File]::ReadAllText($cfgFile)
  try {
    $cfg = $raw | ConvertFrom-Json
    $o = $cfg.API.HTTPHeaders.'Access-Control-Allow-Origin'
    Write-Host "  config file Allow-Origin       : $($o -join ', ')"
    $fileHasOrigin = ($o -contains $Origin)
    if (-not $fileHasOrigin) { $problems += "'$Origin' is not in API.HTTPHeaders.Access-Control-Allow-Origin of the config file." }
    # --- is the file even loadable by Kubo 0.4x?
    $ident = $cfg.Identity
    if (-not $ident.PrivKey) {
      Write-Host "  FAIL  config has no Identity.PrivKey -> Kubo CANNOT start from this file (a restart would fail)." -ForegroundColor Red
      $problems += "config file has no Identity.PrivKey: daemon cannot restart from it. Run: node scripts\repair-ipfs-config.mjs"
    }
    if ($cfg.Version -isnot [pscustomobject] -and $null -ne $cfg.Version) {
      Write-Host "  FAIL  config 'Version' is $($cfg.Version.GetType().Name) ($($cfg.Version)); Kubo 0.4x expects an object -> startup error." -ForegroundColor Red
      $problems += "config 'Version' has the wrong type (legacy config). Run: node scripts\repair-ipfs-config.mjs"
    }
  } catch {
    Write-Host "  FAIL  config file is not valid JSON: $($_.Exception.Message)" -ForegroundColor Red
    $problems += "config file is not valid JSON."
  }
  $cfgTime = (Get-Item $cfgFile).LastWriteTime
  Write-Host "  config file last modified      : $cfgTime"
} else {
  Write-Host "  (cannot see $cfgFile from this machine)" -ForegroundColor Yellow
}
foreach ($f in @("api", "repo.lock")) {
  $p = Join-Path $liveRepo $f
  if (Test-Path $p) { Write-Host "  repo has '$f' (a daemon is attached to this repo)" } else { Write-Host "  repo has no '$f' file" }
}

Write-Host ""
Write-Host "=== 4. Was the daemon started before the config file was last written? ===" -ForegroundColor Cyan
$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^ipfs' -and $_.ProcessName -notmatch 'desktop' })
if ($procs.Count -gt 0 -and (Test-Path $cfgFile)) {
  foreach ($p in $procs) {
    $started = $null
    try { $started = $p.StartTime } catch {}
    if ($started) {
      Write-Host "  process '$($p.ProcessName)' pid $($p.Id) started $started"
      if (($cfgTime - $started).TotalSeconds -gt 5) { # the daemon itself rewrites config a few ms after start
        Write-Host "  WARN  config was written AFTER the daemon started -> Kubo only reads API.HTTPHeaders at startup." -ForegroundColor Yellow
        $problems += "Config file changed after the daemon started: restart the daemon."
      } else { Write-Host "  OK  daemon started after the last config write" }
    }
  }
} else { Write-Host "  (no local ipfs process visible; skipping)" }

Write-Host ""
Write-Host "=== 5. REAL BEHAVIOUR: what does the daemon answer to a browser from $Origin ? ===" -ForegroundColor Cyan
$pre = Send-Http "OPTIONS" "$Api/api/v0/add" $Origin
Write-Host "  preflight  OPTIONS /api/v0/add -> HTTP $($pre.Status), Access-Control-Allow-Origin: $(if ($pre.AllowOrigin) { $pre.AllowOrigin } else { '<missing>' })"
$post = Send-Http "POST" "$Api/api/v0/add?only-hash=true" $Origin
Write-Host "  POST /api/v0/add (Origin: $Origin) -> HTTP $($post.Status), Access-Control-Allow-Origin: $(if ($post.AllowOrigin) { $post.AllowOrigin } else { '<missing>' })"
$works = ($pre.AllowOrigin -eq $Origin) -and ($post.Status -eq 200)
Write-Host ""
if ($works) {
  Write-Host "VERDICT: CORS is ACTIVE for $Origin. The browser upload will work." -ForegroundColor Green
  if ($problems.Count -gt 0) { Write-Host "Other things to know:"; $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow } }
  exit 0
}
Write-Host "VERDICT: CORS is NOT active for $Origin  (preflight HTTP $($pre.Status) without Allow-Origin, POST HTTP $($post.Status))." -ForegroundColor Red
if ($problems.Count -eq 0) { $problems += "Headers are not loaded by the running daemon: set them (scripts\fix-ipfs-cors.ps1) and RESTART the daemon." }
Write-Host "Most likely cause(s):"
$problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
exit 1
