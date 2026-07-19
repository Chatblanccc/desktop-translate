Set-StrictMode -Version Latest

function Assert-Phase5NoReparsePoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedParent
    )

    $parentFull = [IO.Path]::GetFullPath($AllowedParent).TrimEnd('\')
    $pathFull = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $pathRoot = [IO.Path]::GetPathRoot($parentFull)
    $parentCursor = $pathRoot
    $parentRemainder = $parentFull.Substring($pathRoot.Length)
    foreach ($segment in $parentRemainder.Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
        $parentCursor = Join-Path $parentCursor $segment
        if (-not (Test-Path -LiteralPath $parentCursor)) { break }
        $parentItem = Get-Item -LiteralPath $parentCursor -Force
        if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing recursive operation through a reparse-point parent path: $($parentItem.FullName)"
        }
    }
    if ([string]::Equals($parentFull, $pathFull, [StringComparison]::OrdinalIgnoreCase) -or
        -not $pathFull.StartsWith($parentFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing recursive operation outside a strict child of '$parentFull': $pathFull"
    }

    $relative = $pathFull.Substring($parentFull.Length + 1)
    $cursor = $parentFull
    foreach ($segment in $relative.Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
        $cursor = Join-Path $cursor $segment
        if (-not (Test-Path -LiteralPath $cursor)) { break }
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing recursive operation through a reparse point: $($item.FullName)"
        }
    }

    if (-not (Test-Path -LiteralPath $pathFull)) { return }
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($pathFull)
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing recursive operation over a reparse point: $($item.FullName)"
            }
            if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
        }
    }
}

function Remove-Phase5DirectoryTree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedParent
    )

    Assert-Phase5NoReparsePoint -Path $Path -AllowedParent $AllowedParent
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $Path) {
        throw "Recursive removal returned without deleting the exact target: $Path"
    }
}
