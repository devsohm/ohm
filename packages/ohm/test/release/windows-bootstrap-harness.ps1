[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Installer,

    [Parameter(Mandatory = $true)]
    [string]$FixtureRoot,

    [Parameter(Mandatory = $true)]
    [string]$TestHome,

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [switch]$FailLauncherRestore
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$resolvedHome = [IO.Path]::GetFullPath($TestHome)
$env:USERPROFILE = $resolvedHome
$env:HOME = $resolvedHome
$env:LOCALAPPDATA = Join-Path $resolvedHome "AppData\Local"
Set-Variable -Name HOME -Scope Global -Value $resolvedHome -Force

$global:OhmTestFixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
$global:OhmTestVersion = $Version
$global:OhmTestFailLauncherRestore = [bool]$FailLauncherRestore
$global:OhmTestLauncherRestoreFailed = $false
$global:OhmTestExpectedLauncher = Join-Path $resolvedHome ".ohm\bin\ohm.cmd"

function global:Invoke-RestMethod {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [uri]$Uri,

        [hashtable]$Headers,

        [int]$TimeoutSec
    )

    [pscustomobject]@{
        tag_name = "v$global:OhmTestVersion"
        draft = $false
        prerelease = $false
    }
}

function global:Move-Item {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath,

        [Parameter(Mandatory = $true)]
        [string]$Destination,

        [switch]$Force
    )

    if ($global:OhmTestFailLauncherRestore -and
        -not $global:OhmTestLauncherRestoreFailed -and
        $LiteralPath.EndsWith(".previous", [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals(
            [IO.Path]::GetFullPath($Destination),
            [IO.Path]::GetFullPath($global:OhmTestExpectedLauncher),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        $global:OhmTestLauncherRestoreFailed = $true
        throw "injected launcher restore failure"
    }

    Microsoft.PowerShell.Management\Move-Item @PSBoundParameters
}

$installerContents = [IO.File]::ReadAllText([IO.Path]::GetFullPath($Installer))
$fixtureUri = ([Uri]([IO.Path]::GetFullPath($global:OhmTestFixtureRoot))).AbsoluteUri.TrimEnd("/")
$latestReleasePath = Join-Path $global:OhmTestFixtureRoot "latest-release.json"
$latestRelease = @{
    tag_name = "v$global:OhmTestVersion"
    draft = $false
    prerelease = $false
} | ConvertTo-Json -Compress
[IO.File]::WriteAllText($latestReleasePath, $latestRelease)
$latestApiSource = '"https://api.github.com/repos/devsohm/ohm/releases/latest"'
$latestApiFixture = '"' + $fixtureUri + '/latest-release.json"'
$secureSchemeSource = '                $Uri.Scheme -ieq "https" -and'
$secureSchemeFixture = '                ($Uri.Scheme -ieq "https" -or $Uri.Scheme -ieq "file") -and'
$assetRootSource = '        $assetRoot = "$releaseRoot/download/$tag"'
$assetRootFixture = '        $assetRoot = "' + $fixtureUri + '"'
if (-not $installerContents.Contains($latestApiSource) -or
    -not $installerContents.Contains($secureSchemeSource) -or
    -not $installerContents.Contains($assetRootSource)) {
    throw "installer fixture asset root replacement failed"
}
$installerContents = $installerContents.Replace($latestApiSource, $latestApiFixture)
$installerContents = $installerContents.Replace($secureSchemeSource, $secureSchemeFixture)
$installerContents = $installerContents.Replace($assetRootSource, $assetRootFixture)
& ([ScriptBlock]::Create($installerContents))
