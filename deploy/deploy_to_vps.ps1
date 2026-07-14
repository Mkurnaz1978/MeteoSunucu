$ErrorActionPreference = 'Stop'

$VpsHost = '31.220.94.67'
$VpsUser = 'root'
$RemoteDir = '/root/meteo-sunucu-upload'

Write-Host 'Packaging MeteoSunucu project...'

Push-Location $PSScriptRoot\..
try {
    if (Test-Path dist) {
        Remove-Item dist -Recurse -Force
    }

    npm install
    npm run build

    Write-Host 'Preparing remote staging directory. Password prompt may appear in terminal.'
    ssh ${VpsUser}@${VpsHost} "mkdir -p ${RemoteDir}"

    Write-Host 'Copying files to VPS. Password prompt may appear in terminal.'
    scp -r package.json package-lock.json ecosystem.config.cjs .env.example README.md deploy src dist ${VpsUser}@${VpsHost}:${RemoteDir}

    Write-Host 'Run these commands on the VPS after copy:'
    Write-Host "cd ${RemoteDir} && chmod +x deploy/install-ubuntu.sh && ./deploy/install-ubuntu.sh"
}
finally {
    Pop-Location
}