# APEX-2026 — Build Rust core library
# Produces: target/release/apex_core.dll (Windows) or libapex_core.so (Linux)

Write-Host "🔨 Building apex_core (release)..."
$ErrorActionPreference = "Stop"

Push-Location $PSScriptRoot

try {
    cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "Cargo build failed" }

    $dll = "target\release\apex_core.dll"
    if (Test-Path $dll) {
        $size = (Get-Item $dll).Length / 1KB
        Write-Host "✅ Built: $dll ($([math]::Round($size, 1)) KB)"
    } else {
        Write-Host "⚠️  DLL not found at $dll"
    }
} finally {
    Pop-Location
}
