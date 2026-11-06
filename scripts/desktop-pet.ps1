# 大肥鱼心情小窗（纯文字版）：always-on-top，读 emotional-state.json 显示当前心情。
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\desktop-pet.ps1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 高 DPI 下 WorkingArea 会被虚拟化，先把进程标成 DPI 感知，坐标才是物理像素
Add-Type @'
using System.Runtime.InteropServices;
public class DpiAware { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
[void][DpiAware]::SetProcessDPIAware()

$logFile = Join-Path $env:TEMP 'dafeiyu-pet.log'
function Write-PetLog($message) {
  try { Add-Content -Path $logFile -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $message) -Encoding UTF8 } catch { }
}

$stateFile = if ($env:DAFEIYU_STATE_FILE) { $env:DAFEIYU_STATE_FILE }
             else { Join-Path $env:USERPROFILE '.dsh\bili-duty\life-memory\emotional-state.json' }

$moods = @{
  joyful    = @{ label = '开心'; color = '#e3ba69' }
  curious   = @{ label = '好奇'; color = '#73ddb5' }
  warm      = @{ label = '温暖'; color = '#f0a06a' }
  calm      = @{ label = '平静'; color = '#7fb3d5' }
  tired     = @{ label = '疲惫'; color = '#9aa7a3' }
  sad       = @{ label = '低落'; color = '#8fa3c4' }
  irritated = @{ label = '烦躁'; color = '#e0736a' }
  neutral   = @{ label = '平稳'; color = '#cfd8d3' }
}

function Read-Mood {
  if (-not (Test-Path $stateFile)) {
    return @{ mood = 'offline'; label = '未连接'; color = '#5b6b66'; intensity = 0 }
  }
  try {
    $data = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $mood = [string]$data.current.mood
    $meta = $moods[$mood]
    if (-not $meta) { $meta = $moods['neutral'] }
    return @{ mood = $mood; label = $meta.label; color = $meta.color; intensity = [int]$data.current.intensity }
  } catch {
    return @{ mood = 'offline'; label = '读取失败'; color = '#5b6b66'; intensity = 0 }
  }
}

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.Size = New-Object System.Drawing.Size(230, 116)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(20, ($screen.Bottom - 140))
$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#0d211b')
$form.ShowInTaskbar = $false
# WinForms 双缓冲：避免重绘时闪一块底色
$dbProp = [System.Windows.Forms.Form].GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic')
if ($dbProp) { $dbProp.SetValue($form, $true) }
Write-PetLog ("screen={0}x{1} at {2},{3}  form={4},{5}" -f $screen.Width, $screen.Height, $screen.Left, $screen.Top, $form.Location.X, $form.Location.Y)

$title = New-Object System.Windows.Forms.Label
$title.Text = '大肥鱼 · Tender 心脏'
$title.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#8fb8a8')
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei', 8)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(14, 12)
$form.Controls.Add($title)

$moodLabel = New-Object System.Windows.Forms.Label
$moodLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#eef8f3')
$moodLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei', 17, [System.Drawing.FontStyle]::Bold)
$moodLabel.AutoSize = $true
$moodLabel.Location = New-Object System.Drawing.Point(14, 32)
$form.Controls.Add($moodLabel)

$detail = New-Object System.Windows.Forms.Label
$detail.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#7f9a8f')
$detail.Font = New-Object System.Drawing.Font('Microsoft YaHei', 8)
$detail.AutoSize = $true
$detail.Location = New-Object System.Drawing.Point(14, 78)
$form.Controls.Add($detail)

$script:state = Read-Mood
$script:stateKey = ''

function Apply-State {
  $script:stateKey = "$($script:state.mood)|$($script:state.intensity)|$($script:state.label)"
  $moodLabel.Text = $script:state.label
  $moodLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($script:state.color)
  $detail.Text = if ($script:state.mood -eq 'offline') { '启动 Tender 与插件后自动连接' }
                 else { "mood: $($script:state.mood)   强度 $($script:state.intensity)" }
}
Apply-State

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({
  $next = Read-Mood
  $key = "$($next.mood)|$($next.intensity)|$($next.label)"
  if ($key -eq $script:stateKey) { return }   # 状态没变就不重绘，避免无谓闪烁
  $script:state = $next
  Apply-State
})
$timer.Start()

# 拖动
$drag = $false; $offset = New-Object System.Drawing.Point
foreach ($ctrl in @($form, $title, $moodLabel, $detail)) {
  $ctrl.Add_MouseDown({ param($s, $e) $script:drag = $true; $script:offset = $e.Location })
  $ctrl.Add_MouseMove({
    param($s, $e)
    if ($script:drag) {
      $form.Location = New-Object System.Drawing.Point(
        ($form.Location.X + $e.X - $script:offset.X),
        ($form.Location.Y + $e.Y - $script:offset.Y))
    }
  })
  $ctrl.Add_MouseUp({ $script:drag = $false })
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('打开心情文件')
$openItem.Add_Click({ if (Test-Path $stateFile) { Start-Process notepad.exe $stateFile } })
$quitItem = $menu.Items.Add('退出')
$quitItem.Add_Click({ $form.Close() })
$form.ContextMenuStrip = $menu

[System.Windows.Forms.Application]::Run($form)
