Set-StrictMode -Version Latest

function ConvertTo-Phase5ExtendedLengthPath {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\?\', [StringComparison]::Ordinal)) {
        return $full
    }
    if ($full.StartsWith('\\', [StringComparison]::Ordinal)) {
        return '\\?\UNC\' + $full.Substring(2)
    }
    return '\\?\' + $full
}

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
        $parentCursorNative = ConvertTo-Phase5ExtendedLengthPath -Path $parentCursor
        if (-not (Test-Path -LiteralPath $parentCursorNative)) { break }
        $parentItem = Get-Item -LiteralPath $parentCursorNative -Force
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
        $cursorNative = ConvertTo-Phase5ExtendedLengthPath -Path $cursor
        if (-not (Test-Path -LiteralPath $cursorNative)) { break }
        $item = Get-Item -LiteralPath $cursorNative -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing recursive operation through a reparse point: $($item.FullName)"
        }
    }

    $pathNative = ConvertTo-Phase5ExtendedLengthPath -Path $pathFull
    if (-not (Test-Path -LiteralPath $pathNative)) { return }
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($pathNative)
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
    $pathNative = ConvertTo-Phase5ExtendedLengthPath -Path $Path
    if (Test-Path -LiteralPath $pathNative) {
        Remove-Item -LiteralPath $pathNative -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $pathNative) {
        throw "Recursive removal returned without deleting the exact target: $Path"
    }
}
