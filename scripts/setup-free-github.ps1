param(
  [Parameter(Mandatory = $true)]
  [string]$RepositoryUrl
)

$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git is not installed or not available in PATH."
}

if (-not (Test-Path ".git")) {
  git init
  git branch -M main
}

git config user.name "Techno Funda Bot"
git config user.email "techno-funda@example.local"

git add .github config public scripts src supabase data package.json package-lock.json README.md .gitignore render.yaml

git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m "Set up free techno funda screener"
}

$origin = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0 -and $origin) {
  git remote set-url origin $RepositoryUrl
} else {
  git remote add origin $RepositoryUrl
}

git push -u origin main
