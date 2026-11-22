# Reports what Apple Music (the Microsoft Store app) or iTunes is playing.
# It keeps running and prints one line of JSON whenever that changes.
# bridge/player.js starts it with Windows PowerShell and stops it when the app
# quits. It also stops by itself if the app that started it is gone.
#
# Apple Music has no scripting interface, so it's read from the Windows media
# controls: the same info as the media pop-up next to the volume control.
# iTunes is read through its COM scripting interface.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$parentId = 0
[void][int]::TryParse("$env:AMRPC_PARENT_PID", [ref]$parentId)

# ------------------------------------------------------------------ output

function Write-Line([string]$Text) {
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
}

# Escape non-ASCII characters so song titles in any language survive the
# console's code page.
function ConvertTo-AsciiJson($Value) {
    $json = ConvertTo-Json -InputObject $Value -Compress
    [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

# ------------------------------------------------- Windows media controls

$mediaManager = $null
$mediaError = $null
$asTaskMethod = $null
$propertiesType = $null

function Wait-WinRT($Operation, [Type]$ResultType) {
    $task = $asTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait(5000)) { throw 'Windows took too long to respond' }
    $task.Result
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
    $mediaManager = Wait-WinRT ($managerType::RequestAsync()) $managerType
} catch {
    $mediaError = $_.Exception.Message
}

# ------------------------------------------------------------- Apple Music

# Used when Apple Music doesn't share the song's position: time it ourselves.
$script:trackKey = $null
$script:elapsedBefore = 0.0
$script:playingSince = $null

function Get-AppleMusicStatus {
    if (-not (Get-Process -Name AppleMusic -ErrorAction SilentlyContinue)) { return $null }
    if (-not $mediaManager) { throw "Windows media controls unavailable ($mediaError)" }

    $session = $mediaManager.GetSessions() |
        Where-Object { $_.SourceAppUserModelId -like '*AppleMusic*' } |
        Select-Object -First 1
    if (-not $session) { return [ordered]@{ state = 'Stopped'; player = 'Apple Music' } }

    # PlaybackStatus: 4 = playing, 5 = paused
    $state = switch ([int]$session.GetPlaybackInfo().PlaybackStatus) {
        4 { 'Playing' }
        5 { 'Paused' }
        default { 'Stopped' }
    }
    if ($state -eq 'Stopped') { return [ordered]@{ state = 'Stopped'; player = 'Apple Music' } }

    $media = Wait-WinRT ($session.TryGetMediaPropertiesAsync()) $propertiesType
    $timeline = $session.GetTimelineProperties()
    $now = [DateTimeOffset]::UtcNow

    $duration = ($timeline.EndTime - $timeline.StartTime).TotalSeconds
    if ($duration -gt 0) {
        $elapsed = $timeline.Position.TotalSeconds
        # The position is from when Apple Music last reported it.
        if ($state -eq 'Playing' -and $timeline.LastUpdatedTime.Year -gt 2000) {
            $elapsed += ($now - $timeline.LastUpdatedTime).TotalSeconds
        }
        $elapsed = [math]::Min($elapsed, $duration)
    } else {
        $key = "$($media.Title)|$($media.Artist)|$($media.AlbumTitle)"
        if ($key -ne $script:trackKey) {
            $script:trackKey = $key
            $script:elapsedBefore = 0.0
            $script:playingSince = $null
        }
        if ($state -eq 'Playing') {
            if (-not $script:playingSince) { $script:playingSince = $now }
            $elapsed = $script:elapsedBefore + ($now - $script:playingSince).TotalSeconds
        } else {
            if ($script:playingSince) {
                $script:elapsedBefore += ($now - $script:playingSince).TotalSeconds
                $script:playingSince = $null
            }
            $elapsed = $script:elapsedBefore
        }
        $duration = 0
    }

    # Apple Music may report "Artist - Album" (joined with an em dash) as the
    # artist; lib/presence.js splits that up.
    [ordered]@{
        state    = $state
        player   = 'Apple Music'
        name     = $media.Title
        artist   = $media.Artist
        album    = $media.AlbumTitle
        duration = [math]::Round($duration, 3)
        elapsed  = [math]::Round([math]::Max(0, $elapsed), 3)
    }
}

# ------------------------------------------------------------------ iTunes

function Get-ITunesStatus {
    # Connecting to iTunes launches it, so check first. Otherwise quitting
    # iTunes would make it reopen.
    if (-not (Get-Process -Name iTunes -ErrorAction SilentlyContinue)) { return $null }

    $itunes = New-Object -ComObject iTunes.Application
    $track = $null
    try {
        $track = $itunes.CurrentTrack
        # PlayerState: 1 = playing, 2 = fast forwarding, 3 = rewinding
        $playerState = [int]$itunes.PlayerState
        if ($playerState -ge 1 -and $playerState -le 3) { $state = 'Playing' }
        elseif ($track) { $state = 'Paused' }
        else { $state = 'Stopped' }

        $status = [ordered]@{ state = $state; player = 'iTunes' }
        if ($track) {
            $status.name = $track.Name
            $status.artist = $track.Artist
            $status.album = $track.Album
            $status.duration = $track.Duration
            $status.elapsed = $itunes.PlayerPosition
            $status.streamTitle = $itunes.CurrentStreamTitle
        }
        $status
    } finally {
        # Let go straight away: while anything holds on to iTunes, quitting it
        # shows a "scripting interface in use" warning.
        if ($track) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($track) }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($itunes)
    }
}

# --------------------------------------------------------------- main loop

# Whichever player is playing wins, then paused, then any error.
function Get-Status {
    $found = @()
    foreach ($player in 'iTunes', 'Apple Music') {
        try {
            $status = if ($player -eq 'iTunes') { Get-ITunesStatus } else { Get-AppleMusicStatus }
            if ($status) { $found += , $status }
        } catch {
            $found += , [ordered]@{ state = 'Error'; player = $player; error = $_.Exception.Message }
        }
    }
    foreach ($state in 'Playing', 'Paused', 'Error', 'Stopped') {
        $match = $found | Where-Object { $_.state -eq $state } | Select-Object -First 1
        if ($match) { return $match }
    }
    [ordered]@{ state = 'Not Running' }
}

$lastKey = $null
$lastStart = 0.0
while ($true) {
    if ($parentId -and -not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { exit 0 }

    $status = Get-Status

    # Only print when something changed. While playing, the position always
    # moves, so compare when the song started instead: that only jumps when
    # the user seeks.
    $start = 0.0
    if ($status.state -eq 'Playing' -and $null -ne $status.elapsed) {
        $start = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$status.elapsed * 1000
    }
    $key = '{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}' -f $status.state, $status.player, $status.name,
        $status.artist, $status.album, $status.duration, $status.streamTitle, $status.error
    if ($key -ne $lastKey -or [math]::Abs($start - $lastStart) -gt 2000) {
        $lastKey = $key
        $lastStart = $start
        Write-Line (ConvertTo-AsciiJson $status)
    }

    Start-Sleep -Milliseconds 1000
}
