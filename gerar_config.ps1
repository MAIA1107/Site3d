$ErrorActionPreference = 'Stop'
$tmp = "C:\Users\Diones\AppData\Local\Temp\opencode"
$sis = "D:\Documents\Default Project\sistema"
$cache = "$sis\cache"

function Read-Fast($name) {
  Get-Content "$cache\$name-fast.json" -Raw -Encoding UTF8 | ConvertFrom-Json
}

$tabs = @()

$updatesTab = @{ name = 'Atualizações'; type = 'updates'; max = 80 }
$tabs += $updatesTab

$bustosTab = @{
  name = 'Bustos'
  type = 'drive'
  expand = $true
  links = @(
    'https://drive.google.com/drive/folders/1e-aTud-1ppDP3E8PLKQ3Z3t3GiULqhA4',
    'https://drive.google.com/drive/folders/1x8qHYYHtm7fzJcTYdaveoQoSPQ1DqNFI'
  )
}
$tabs += $bustosTab

$driveTabs = @(
  @{ name = 'Dobráveis'; json = 'Dobraveis' },
  @{ name = 'Utensílios'; json = 'Utensilios' },
  @{ name = 'Articulados'; json = 'Articulados' },
  @{ name = 'Luminárias'; json = 'Luminarias' },
  @{ name = 'Decoração'; json = 'Decoracao' },
  @{ name = 'Multipartes'; json = 'Multipartes' },
  @{ name = 'Veículos'; json = 'Veiculos' }
)

foreach ($dt in $driveTabs) {
  $entries = @()
  foreach ($f in (Read-Fast $dt.json)) {
    $entries += @{ url = "https://drive.google.com/drive/folders/$($f.id)"; label = $f.label }
  }
  $tabs += @{ name = $dt.name; type = 'drive'; links = $entries }
}

$tabs += @{ name = 'Aviões'; type = 'static'; file = 'tab_avioes.js' }

$chaveirosTab = @{
  name = 'Chaveiros'
  type = 'drive'
  expand = $true
  links = @(
    'https://drive.google.com/drive/folders/16eFrKqqUXBnLViAJWgH8IpOgQeG82XPY'
  )
}
$tabs += $chaveirosTab

$brinquedosTab = @{
  name = 'Brinquedos'
  type = 'drive'
  expand = $true
  links = @(
    'https://drive.google.com/drive/folders/1Bo9UQporeBZfFzye9THAtxxhoyvcyrzH'
  )
}
$tabs += $brinquedosTab

$tabs += @{ name = '2026'; type = 'static'; file = 'tab_2026.js' }

$cfg = @{ tabs = $tabs }
$cfg | ConvertTo-Json -Depth 8 | Set-Content "$sis\colecoes.json" -Encoding UTF8
Write-Output "colecoes.json gerado: $($tabs.Count) abas"
