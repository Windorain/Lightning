$ErrorActionPreference = 'Stop'
$path = $args[0]
$tokens = $null
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
    $errors | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }
    exit 1
}
"PARSE OK: $path"
