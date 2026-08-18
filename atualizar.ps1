param(
  [switch]$Refresh
)
$ErrorActionPreference = 'Stop'
$sis = "D:\Documents\Default Project\sistema"
$cache = "$sis\cache"
$folders = "$cache\folders"
if (-not (Test-Path $folders)) { New-Item -ItemType Directory -Path $folders -Force | Out-Null }

$today = Get-Date -Format 'yyyy-MM-dd'
$cutoff = (Get-Date).AddDays(-30).ToString('yyyy-MM-dd')

# ---------------------------------------------------------------- helpers
function Get-Norm($s) { ($s.ToLowerInvariant() -replace '[^a-z0-9]','') }

function Test-GenericZip($name) {
  $n = Get-Norm ([System.IO.Path]::GetFileNameWithoutExtension($name))
  return ($n -eq 'stl' -or $n -eq 'stlfiles' -or $n -eq 'stlfile' -or $n -eq 'stls')
}

function Clean-Title($zipName, $folderLabel) {
  if (Test-GenericZip $zipName) { return $folderLabel }
  $t = ([System.IO.Path]::GetFileNameWithoutExtension($zipName) -replace '\+',' ' -replace '_',' ' -replace '%20',' ' -replace '\s+',' ').Trim()
  if ((Get-Norm $t) -in @('stl','stlfiles','stlfile','stls') -or $t.Length -eq 0) { return $folderLabel }
  return $t
}

function Get-Tokens($s) {
  $common = @('fab365','foldable','caneca','stl','files','mug','set')
  $base = [System.IO.Path]::GetFileNameWithoutExtension($s).ToLowerInvariant()
  return @($base -split '[^a-z0-9]+' | Where-Object { $_.Length -ge 5 -and $_ -notin $common -and $_ -notmatch '^\d+$' })
}

function Get-ZipScore($zipName, $imgName) {
  $zn = Get-Norm ([System.IO.Path]::GetFileNameWithoutExtension($zipName))
  $in = Get-Norm ([System.IO.Path]::GetFileNameWithoutExtension($imgName))
  if ($zn.Length -eq 0 -or $in.Length -eq 0) { return -1 }
  if ($zn -eq $in) { return 1000 }
  if ($in.Contains($zn) -or $zn.Contains($in)) { return 800 }
  $zt = @(Get-Tokens $zipName); $it = @(Get-Tokens $imgName)
  $score = 0
  foreach ($t in $zt) { if ($t -in $it) { $score += $t.Length } }
  return $score
}

function Sanitize($s) {
  return ($s -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;' -replace '"','&quot;')
}

# ---------------------------------------------------------------- drive fetch
function Fetch-Html($id) {
  $u = "https://drive.google.com/drive/folders/$id"
  $tmp = "$env:TEMP\gf_$([guid]::NewGuid()).html"
  try {
    & curl.exe -s -L --connect-timeout 10 --max-time 40 -A "Mozilla/5.0" -o $tmp $u 2>$null
    if (Test-Path -LiteralPath $tmp) {
      $t = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      return $t
    }
  } catch {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    return $null
  }
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  return $null
}

function Unescape-Js($s) {
  $s = [regex]::Replace($s, '\\x([0-9a-fA-F]{2})', { param($m) [string][char][int]('0x' + $m.Groups[1].Value) })
  $s = [regex]::Replace($s, '\\u([0-9a-fA-F]{4})', { param($m) [string][char][int]('0x' + $m.Groups[1].Value) })
  $s = $s -replace '\\/', '/' -replace '\\"', '"' -replace '\\\\', '\'
  return $s
}

function Get-Items($html) {
  $items = @()
  $m = [regex]::Match($html, "_DRIVE_ivd = '([^']+)';")
  if ($m.Success) {
    $j = Unescape-Js $m.Groups[1].Value | ConvertFrom-Json
    foreach ($e in $j[0]) {
      $items += @{ type = 'FILE'; id = $e[0]; name = $e[2]; mime = $e[3] }
    }
  } else {
    $all = [regex]::Matches($html, 'by9fbe38:([A-Za-z0-9_\-]+)-0-16[^>]*?data-tooltip="([^"]+)"')
    foreach ($mm in $all) {
      $fid = $mm.Groups[1].Value
      $tip = $mm.Groups[2].Value
      $mime = ''
      if ($tip -match ' Shared folder$') { $mime = 'application/vnd.google-apps.folder'; $name = $tip.Substring(0, $tip.Length - 13) }
      elseif ($tip -match ' Image$') { $mime = 'image'; $name = $tip.Substring(0, $tip.Length - 6) }
      elseif ($tip -match ' Compressed archive$') { $mime = 'archive'; $name = $tip.Substring(0, $tip.Length - 19) }
      else { $name = $tip }
      $items += @{ type = 'FILE'; id = $fid; name = $name; mime = $mime }
    }
  }
  return $items
}

function Fetch-FolderItems($id) {
  $all = @()
  $h = Fetch-Html $id
  if (-not $h) { return $all }
  $top = @(Get-Items $h)
  $subDirs = @($top | Where-Object { $_.mime -eq 'application/vnd.google-apps.folder' })
  foreach ($i in @($top | Where-Object { $_.mime -ne 'application/vnd.google-apps.folder' })) { $all += $i }
  foreach ($sd in $subDirs) {
    $h2 = Fetch-Html $sd.id
    if (-not $h2) { continue }
    $subAll = @(Get-Items $h2)
    $subSub = @($subAll | Where-Object { $_.mime -eq 'application/vnd.google-apps.folder' })
    foreach ($i in @($subAll | Where-Object { $_.mime -ne 'application/vnd.google-apps.folder' })) { $all += $i }
    foreach ($ssd in $subSub) {
      $h3 = Fetch-Html $ssd.id
      if (-not $h3) { continue }
      foreach ($i in @(Get-Items $h3 | Where-Object { $_.mime -ne 'application/vnd.google-apps.folder' })) { $all += $i }
      Start-Sleep -Milliseconds 80
    }
    Start-Sleep -Milliseconds 80
  }
  return $all
}

function Get-FolderId($url) {
  $m = [regex]::Match($url, '/folders/([^/?#]+)')
  if ($m.Success) { return $m.Groups[1].Value }
  $m2 = [regex]::Match($url, 'id=([^&]+)')
  if ($m2.Success) { return $m2.Groups[1].Value }
  throw "URL invalida: $url"
}

function Load-Folder($url, $label) {
  $id = Get-FolderId $url
  $cf = "$folders\$id.json"
  if (-not $Refresh -and (Test-Path -LiteralPath $cf)) {
    return (Get-Content -LiteralPath $cf -Raw -Encoding UTF8 | ConvertFrom-Json)
  }
  Write-Host "FETCH $id | $label"
  $items = Fetch-FolderItems $id
  $obj = @{ id = $id; label = $label; items = $items }
  [System.IO.File]::WriteAllText($cf, ($obj | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($true)))
  Start-Sleep -Milliseconds 120
  return $obj
}

function Expand-Root($url) {
  $id = Get-FolderId $url
  $h = Fetch-Html $id
  if (-not $h) { return @() }
  $root = @(Get-Items $h)
  $subs = @($root | Where-Object { $_.mime -eq 'application/vnd.google-apps.folder' })
  $out = @()
  foreach ($s in $subs) {
    $out += Expand-Folder $s.id $s.name 0
  }
  return $out
}

function Expand-Folder($id, $label, $depth) {
  $out = @()
  if ($depth -gt 3) { return $out }
  $cf = "$folders\$id.json"
  if (-not $Refresh -and (Test-Path -LiteralPath $cf)) {
    return @((Get-Content -LiteralPath $cf -Raw -Encoding UTF8 | ConvertFrom-Json))
  }
  Write-Host "EXPAND $id | $label"
  $h = Fetch-Html $id
  if (-not $h) { return $out }
  $all = @(Get-Items $h)
  $direct = @($all | Where-Object { $_.mime -ne 'application/vnd.google-apps.folder' })
  $subs = @($all | Where-Object { $_.mime -eq 'application/vnd.google-apps.folder' })
  if ($direct.Count -gt 0 -or $subs.Count -eq 0) {
    $items = @(Fetch-FolderItems $id)
    $obj = @{ id = $id; label = $label; items = $items }
    [System.IO.File]::WriteAllText($cf, ($obj | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($true)))
    $out += $obj
    Start-Sleep -Milliseconds 120
  } else {
    foreach ($s in $subs) { $out += Expand-Folder $s.id $s.name ($depth + 1) }
  }
  return $out
}

# ---------------------------------------------------------------- build cards
function Build-Items($folders) {
  $out = @()
  foreach ($f in $folders) {
    $imgs = @($f.items | Where-Object { $_.mime -eq 'image' })
    $zips = @($f.items | Where-Object { $_.mime -eq 'archive' })
    if ($zips.Count -eq 0) {
      $img = if ($imgs.Count -gt 0) { $imgs[0].id } else { '' }
      $out += @{ title = $f.label; sub = 'Pasta (vários arquivos)'; img = $img; zip = ''; link = "https://drive.google.com/drive/folders/$($f.id)"; label = 'Abrir no Drive' }
    } elseif ($zips.Count -eq 1) {
      $img = if ($imgs.Count -gt 0) { $imgs[0].id } else { '' }
      $out += @{ title = $f.label; sub = $f.label; img = $img; zip = $zips[0].id; link = ''; label = 'Baixar ZIP' }
    } else {
      $used = @{}
      $folderCards = @()
      $ordered = @($zips | Sort-Object { @(Test-GenericZip $_.name) })
      foreach ($z in $ordered) {
        $best = $null; $bestScore = -1
        foreach ($im in $imgs) {
          if ($used.ContainsKey($im.id)) { continue }
          $s = Get-ZipScore $z.name $im.name
          if ($s -gt $bestScore) { $bestScore = $s; $best = $im }
        }
        if (-not $best) { foreach ($im in $imgs) { if (-not $used.ContainsKey($im.id)) { $best = $im; break } } }
        $imgId = ''
        if ($best) { $imgId = $best.id; $used[$best.id] = $true }
        $folderCards += @{ title = (Clean-Title $z.name $f.label); sub = $f.label; img = $imgId; zip = $z.id; link = ''; label = 'Baixar ZIP' }
      }
      $titleCounts = @{}
      foreach ($c in $folderCards) { $n = Get-Norm $c.title; if ($titleCounts.ContainsKey($n)) { $titleCounts[$n]++ } else { $titleCounts[$n] = 1 } }
      $hasDup = @($titleCounts.GetEnumerator() | Where-Object { $_.Value -gt 1 }).Count -gt 0
      if ($hasDup) {
        $img = if ($folderCards.Count -gt 0) { $folderCards[0].img } else { '' }
        $out += @{ title = $f.label; sub = 'Pasta (vários arquivos)'; img = $img; zip = ''; link = "https://drive.google.com/drive/folders/$($f.id)"; label = 'Abrir no Drive' }
      } else {
        foreach ($c in $folderCards) { $out += $c }
      }
    }
  }
  return $out
}

function Get-CardKey($it) {
  if ($it.zip) { return "z:$($it.zip)" }
  if ($it.link) { return "l:$($it.link)" }
  return 'x:noid'
}

function Emit-Cards($items) {
  $lines = @()
  foreach ($it in $items) {
    $t = Sanitize $it.title
    $s = Sanitize $it.sub
    if ($it.link) {
      $lines += "      { title: `"$t`", sub: `"$s`", img: `"$($it.img)`", link: `"$($it.link)`", label: `"$($it.label)`" },"
    } else {
      $lines += "      { title: `"$t`", sub: `"$s`", img: `"$($it.img)`", zip: `"$($it.zip)`" },"
    }
  }
  return $lines
}

# ---------------------------------------------------------------- snapshot (aba Atualizações)
$snapPath = "$cache\snapshot.json"
$snapshot = @{}
if (Test-Path $snapPath) {
  $snapObj = (Get-Content $snapPath -Raw -Encoding UTF8 | ConvertFrom-Json)
  foreach ($sp in $snapObj.PSObject.Properties) { $snapshot[$sp.Name] = $sp.Value }
}

# seed inicial: marcar zips legados como antigos
function Seed-Legacy {
  $legacy = @('Dobraveis','Utensilios','Articulados','Luminarias','Decoracao','Multipartes','Veiculos')
  foreach ($l in $legacy) {
    $j = Get-Content "$cache\$l-fast.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($f in $j) {
      foreach ($it in @($f.items)) {
        if ($it.mime -eq 'archive') { $key = $it.id; if (-not $snapshot.ContainsKey($key)) { $snapshot[$key] = '2000-01-01' } }
      }
    }
  }
}
if (-not $snapshot) { Seed-Legacy }

# ---------------------------------------------------------------- processar abas
$cfg = Get-Content "$sis\colecoes.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$globalSeen = @{}
$updatesName = ''
$blocks = @()
$updatesItems = @()

for ($ti = 0; $ti -lt $cfg.tabs.Count; $ti++) {
  $tab = $cfg.tabs[$ti]
  if ($tab.type -eq 'updates') {
    $updatesName = $tab.name
    $blocks += @{ name = $tab.name; raw = $false; updates = $true; items = @() }
    continue
  }

  if ($tab.type -eq 'static') {
    $raw = Get-Content "$sis\$($tab.file)" -Raw -Encoding UTF8
    $blocks += @{ name = $tab.name; raw = $true; content = $raw }
    Write-Output "STATIC $($tab.name)"
    continue
  }

  if ($tab.type -eq 'drive') {
    $acc = @()
    $seenUrls = @{}
    if ($tab.expand) {
      foreach ($link in @($tab.links)) {
        $norm = ($link -replace '/$','').ToLowerInvariant()
        if ($seenUrls.ContainsKey($norm)) { Write-Output "SKIP duplicate link in $($tab.name): $link"; continue }
        $seenUrls[$norm] = $true
        $acc += Expand-Root $link
      }
    } else {
      foreach ($link in @($tab.links)) {
        $norm = ($link.url -replace '/$','').ToLowerInvariant()
        if ($seenUrls.ContainsKey($norm)) { Write-Output "SKIP duplicate link in $($tab.name): $($link.url)"; continue }
        $seenUrls[$norm] = $true
        $acc += Load-Folder $link.url $link.label
      }
    }
    $items = @(Build-Items $acc)
    # dedup global
    $uniq = @()
    foreach ($it in $items) {
      $key = Get-CardKey $it
      if ($globalSeen.ContainsKey($key)) { continue }
      $globalSeen[$key] = $true
      $uniq += $it
    }
    $blocks += @{ name = $tab.name; raw = $false; items = $uniq }
    Write-Output "TAB $($tab.name): $($uniq.Count) cards ($(($items.Count - $uniq.Count)) dups removidos)"

    # alimentar feed de atualizações
    $fromUpdates = $tab.name -match 'atualiza'
    foreach ($it in $items) {
      if (-not $it.zip) { continue }
      $key = $it.zip
      $known = $snapshot[$key]
      if (-not $known) {
        $snapshot[$key] = $today
        $known = $today
      }
      $date = [string]$known
      $isNew = ($date -ge $cutoff) -or ($fromUpdates)
      if ($isNew) {
        $updatesItems += @{ title = $it.title; sub = "$($it.sub) - $date"; img = $it.img; zip = $it.zip; link = $it.link; label = $it.label; date = $date }
      }
    }
  }
}

# ---------------------------------------------------------------- montar aba Atualizações
$maxUpdates = 80
$updatesTab = @($cfg.tabs | Where-Object { $_.type -eq 'updates' } | Select-Object -First 1)
if ($updatesTab.Count -gt 0 -and $updatesTab[0].max) { $maxUpdates = $updatesTab[0].max }
$updatesItems = @($updatesItems | Sort-Object @{ Expression = { $_.date }; Descending = $true }, @{ Expression = { $_.title } })
$updatesItems = @($updatesItems | Select-Object -First $maxUpdates)

# ---------------------------------------------------------------- emitir new_collections.js
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("const COLLECTIONS = [")

for ($k = 0; $k -lt $blocks.Count; $k++) {
  $b = $blocks[$k]
  if ($b.updates) {
    [void]$sb.AppendLine("  {")
    [void]$sb.AppendLine("    name: `"$($b.name)`",")
    [void]$sb.AppendLine("    items: [")
    foreach ($l in (Emit-Cards $updatesItems)) { [void]$sb.AppendLine($l) }
    [void]$sb.AppendLine("    ]")
    if ($k -lt $blocks.Count - 1) { [void]$sb.AppendLine("  },") } else { [void]$sb.AppendLine("  }") }
    continue
  }
  if ($b.raw) {
    $inner = [regex]::Match($b.content, '\{([\s\S]*)\}').Groups[1].Value.Trim()
    [void]$sb.AppendLine("  {")
    [void]$sb.AppendLine($inner)
    if ($k -lt $blocks.Count - 1) { [void]$sb.AppendLine("  },") } else { [void]$sb.AppendLine("  }") }
    continue
  }
  [void]$sb.AppendLine("  {")
  [void]$sb.AppendLine("    name: `"$($b.name)`",")
  [void]$sb.AppendLine("    items: [")
  foreach ($l in (Emit-Cards $b.items)) { [void]$sb.AppendLine($l) }
  [void]$sb.AppendLine("    ]")
  if ($k -lt $blocks.Count - 1) { [void]$sb.AppendLine("  },") } else { [void]$sb.AppendLine("  }") }
}
[void]$sb.AppendLine("];")
[System.IO.File]::WriteAllText("$cache\new_collections.js", $sb.ToString(), (New-Object System.Text.UTF8Encoding($true)))

# ---------------------------------------------------------------- persistir snapshot
$snapOut = @{}
$snapshot.GetEnumerator() | ForEach-Object { $snapOut[$_.Key] = $_.Value }
[System.IO.File]::WriteAllText($snapPath, ($snapOut | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($true)))

# ---------------------------------------------------------------- rebuild página
$tpl = Get-Content "$sis\page_template.html" -Raw -Encoding UTF8
$js = Get-Content "$cache\new_collections.js" -Raw -Encoding UTF8
$page = $tpl -replace '__COLLECTIONS__', $js
[System.IO.File]::WriteAllText("$sis\..\2026-colecoes.html", $page, (New-Object System.Text.UTF8Encoding($true)))
Write-Output "PAGINA OK: $sis\..\2026-colecoes.html"
Write-Output "UPDATES: $($updatesItems.Count) itens"
