<#
UltraRig USB audio guard: keeps Windows from opening the pedal's USB sound card.

Why: from alpha 13 the pedal is also a USB sound card ("UltraRig Audio"). While Windows streams sound to
or from it (a call app using it as the communications speaker, a browser tab, any program that picks it),
the pedal gives that stream part of its CPU and its room for effects shrinks by about a quarter: heavy
presets then load with blocks switched off. alpha 13.1 has no setting to turn the sound card off, so this
disables the pedal's sound devices in Windows instead. Nothing on the pedal changes.

    usb_audio_guard.ps1 -Install     once (asks for administrator): disables the devices now, and adds a
                                     task that disables them again at every sign-in and whenever UltraRig
                                     Editor opens (new USB port = new devices, which come back enabled)
    usb_audio_guard.ps1 -Uninstall   removes the task and enables the devices again (to record or re-amp)
    usb_audio_guard.ps1 -Status      shows the devices and whether the task is installed (no admin needed)
    usb_audio_guard.ps1              (no switch) what the task runs: disable any enabled UltraRig Audio device
#>
param([switch]$Install, [switch]$Uninstall, [switch]$Status)

$TaskName = 'UltraRig USB audio off'
$Home_ = Join-Path $env:LOCALAPPDATA 'UltraRigUsbGuard'
$Log = Join-Path $Home_ 'guard.log'

function Write-Log($msg) {
    try { New-Item -ItemType Directory -Force $Home_ | Out-Null; Add-Content -Path $Log -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg) } catch {}
}

function Get-UltraRigAudio {
    # the playback and recording endpoints Windows made for the pedal ("Speakers (UltraRig Audio)", "Line (UltraRig Audio)")
    Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'UltraRig Audio' }
}

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Disable-Now {
    $n = 0
    foreach ($d in (Get-UltraRigAudio | Where-Object { $_.Status -eq 'OK' })) {
        try { Disable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false -ErrorAction Stop; $n++; Write-Log "disabled: $($d.FriendlyName)" }
        catch { Write-Log "could not disable $($d.FriendlyName): $($_.Exception.Message)" }
    }
    return $n
}

if ($Status) {
    $devs = @(Get-UltraRigAudio)
    if (-not $devs.Count) { 'No UltraRig Audio devices (pedal unplugged, or not on alpha 13+).' }
    foreach ($d in $devs) { '{0,-34} {1}' -f $d.FriendlyName, $(if ($d.Status -eq 'OK') { 'ENABLED (can take CPU from the pedal)' } else { 'disabled' }) }
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { "Guard task: installed ($($t.State))" } else { 'Guard task: not installed' }
    if (Test-Path $Log) { 'Last log lines:'; Get-Content $Log -Tail 3 }
    return
}

if (($Install -or $Uninstall) -and -not (Test-Admin)) {
    # ask Windows for administrator once, then run this same script elevated
    $arg = '-NoProfile -ExecutionPolicy Bypass -File "{0}" {1}' -f $PSCommandPath, $(if ($Install) { '-Install' } else { '-Uninstall' })
    try { $p = Start-Process powershell -Verb RunAs -ArgumentList $arg -Wait -PassThru; exit $p.ExitCode }
    catch { Write-Host 'Cancelled: Windows needs administrator rights for this.'; exit 1 }
}

if ($Install) {
    New-Item -ItemType Directory -Force $Home_ | Out-Null
    $script = Join-Path $Home_ 'usb_audio_guard.ps1'
    Copy-Item -Path $PSCommandPath -Destination $script -Force
    $user = "$env:USERDOMAIN\$env:USERNAME"
    if ($env:UR_GUARD_USER) { $user = $env:UR_GUARD_USER }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $script)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'Disables the UltraRig pedal''s USB sound devices so they cannot take CPU from its effects. Undo: usb_audio_guard.ps1 -Uninstall' -Force | Out-Null
    $n = Disable-Now
    Write-Log "installed for $user; disabled $n device(s) now"
    Write-Host "Installed. UltraRig Audio devices disabled now: $n. The task keeps them off at sign-in and when UltraRig Editor opens."
    Start-Sleep -Seconds 4
    exit 0
}

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    foreach ($d in (Get-UltraRigAudio | Where-Object { $_.Status -ne 'OK' })) {
        try { Enable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false -ErrorAction Stop; Write-Log "enabled: $($d.FriendlyName)" } catch {}
    }
    Write-Log 'uninstalled'
    Write-Host 'Removed. The UltraRig Audio devices are enabled again (you can record and re-amp over USB).'
    Start-Sleep -Seconds 4
    exit 0
}

# the task: disable whatever is enabled (a new USB port makes new, enabled devices)
$n = Disable-Now
if ($n) { Write-Log "run: disabled $n device(s)" }
