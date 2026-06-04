# Stage StructureWorkbench artifacts for d:\huiji-wiki\wiki.py push.
# Wiki names match 零件定义:StructureWorkbench (launcher .js + bundle .bundle.js + .css).
#
#   cd d:\Projects\Lightning\web
#   npm run build:wiki-workbench
#   npm run stage:wiki-workbench

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$web = Join-Path $root 'web'
$dist = Join-Path $web 'dist-wiki-workbench'
$bundled = Join-Path $dist 'bundled'
$push = Join-Path $dist 'push'

$launcher = Join-Path $root 'scripts\huiji\StructureWorkbench.js'
$bundle = Join-Path $bundled 'StructureWorkbench.bundle.js'
$css = Join-Path $bundled 'StructureWorkbench.css'

foreach ($p in @($launcher, $bundle, $css)) {
  if (-not (Test-Path $p)) {
    throw "Missing: $p (run npm run build:wiki-workbench first)"
  }
}

New-Item -ItemType Directory -Force -Path $push | Out-Null
Copy-Item $launcher (Join-Path $push 'StructureWorkbench.js') -Force
Copy-Item $bundle (Join-Path $push 'StructureWorkbench.bundle.js') -Force
Copy-Item $css (Join-Path $push 'StructureWorkbench.css') -Force

Write-Host "Staged: $push"
Write-Host ""
Write-Host 'Wiki page mapping (under d:\huiji-wiki\wikitext\):'
Write-Host '  push/StructureWorkbench.js         -> %E9%9B%B6%E4%BB%B6%3AStructureWorkbench.js'
Write-Host '  push/StructureWorkbench.bundle.js  -> %E9%9B%B6%E4%BB%B6%3AStructureWorkbench.bundle.js'
Write-Host '  push/StructureWorkbench.css        -> %E9%9B%B6%E4%BB%B6%3AStructureWorkbench.css'
Write-Host '  (same as 零件%3A* filenames in wikitext cache)'
