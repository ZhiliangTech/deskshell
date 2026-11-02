# Test-only perturbation of an already-bound, uniquely marked synthetic document.
# Never accepts an arbitrary target or command and never uses global keyboard input.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
 $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
 if($request.operation -notin @('change-buffer','verify-changed-buffer','open-save-dialog','cancel-save-dialog')) {throw 'INVALID_TEST_OPERATION'}
 if([string]$request.marker -notmatch '^deskshell-notepad-[a-f0-9-]{36}$' -or -not ([string]$request.expected.text).Contains([string]$request.marker)) {throw 'SYNTHETIC_MARKER_REQUIRED'}
 Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
 Add-Type @'
using System; using System.Runtime.InteropServices;
public static class DshFault {
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint c);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint c);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] public static extern IntPtr Message(IntPtr h,uint m,IntPtr w,IntPtr l,uint f,uint t,out UIntPtr r);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode)] public static extern IntPtr Text(IntPtr h,uint m,IntPtr w,string l,uint f,uint t,out UIntPtr r);
}
'@
 $parts=([string]$request.expected.windowId).Split(':')
 if($parts.Count -ne 3) {throw 'INVALID_BINDING'}
 $ownedProcess=Get-Process -Id ([int]$parts[0])
 if([string]$ownedProcess.StartTime.ToUniversalTime().Ticks -cne $parts[1]) {throw 'PROCESS_CHANGED'}
 $ae=[Windows.Automation.AutomationElement];$ts=[Windows.Automation.TreeScope]::Descendants
 $main=[IntPtr]::new([long]$parts[2]);$w=$ae::FromHandle($main)
 if($w.Current.ProcessId -ne [int]$parts[0] -or $w.Current.ClassName -cne 'Notepad') {throw 'WINDOW_CHANGED'}
 $doc=$w.FindFirst($ts,[Windows.Automation.PropertyCondition]::new($ae::ControlTypeProperty,[Windows.Automation.ControlType]::Document))
 $tabs=@($w.FindAll($ts,[Windows.Automation.PropertyCondition]::new($ae::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem)) | Where-Object {($_.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)).Current.IsSelected})
 if($tabs.Count -ne 1) {throw 'TAB_CHANGED'}
 $actualId='document:'+(@($doc.GetRuntimeId()) -join '.')+':tab:'+(@($tabs[0].GetRuntimeId()) -join '.')
 if($actualId -cne [string]$request.expected.documentId) {throw 'DOCUMENT_CHANGED'}
 $expected=([string]$request.expected.text).Replace("`r`n","`r").Replace("`n","`r")
 $raw=($doc.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern)).DocumentRange.GetText(-1)
 $requiredRaw=if($request.operation -ceq 'verify-changed-buffer') {$expected+'Simulated human edit.'+"`r"} else {$expected}
 if($raw -cne $requiredRaw) {throw 'BUFFER_CHANGED'}
 $r=[UIntPtr]::Zero
 if($request.operation -ceq 'change-buffer') {
  $editor=[IntPtr]$doc.Current.NativeWindowHandle
  if($doc.Current.ClassName -cne 'RichEditD2DPT' -or [DshFault]::GetAncestor($editor,2) -ne $main) {throw 'EDITOR_CHANGED'}
  if([DshFault]::Message($editor,0x00B1,[IntPtr]::Zero,[IntPtr](-1),2,1000,[ref]$r) -eq [IntPtr]::Zero) {throw 'SELECTION_UNKNOWN'}
  if([DshFault]::Text($editor,0x00C2,[IntPtr]1,($expected+'Simulated human edit.'+"`r"),2,1000,[ref]$r) -eq [IntPtr]::Zero) {throw 'EDIT_UNKNOWN'}
  $after=($doc.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern)).DocumentRange.GetText(-1)
  if($after -cne ($expected+'Simulated human edit.'+"`r")) {throw 'FAULT_NOT_VERIFIED'}
 } elseif($request.operation -cne 'verify-changed-buffer') {
  if($request.operation -ceq 'open-save-dialog') {
   $file=$w.FindFirst($ts,[Windows.Automation.PropertyCondition]::new($ae::AutomationIdProperty,'File'))
   ($file.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)).Invoke()
   $until=[DateTime]::UtcNow.AddSeconds(3);$menus=@()
   do {
    $menus=@($w.FindAll($ts,[Windows.Automation.PropertyCondition]::new($ae::ControlTypeProperty,[Windows.Automation.ControlType]::MenuItem)) | Where-Object {$_.Current.ClassName -ceq 'MenuFlyoutItem' -and $_.Current.Name -ceq ([string][char]0x53e6+[char]0x5b58+[char]0x4e3a)})
    if($menus.Count -eq 0) {Start-Sleep -Milliseconds 80}
   } while($menus.Count -eq 0 -and [DateTime]::UtcNow -lt $until)
   if($menus.Count -ne 1) {throw 'MENU_CHANGED'}
   ($menus[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)).Invoke()
  }
  $until=[DateTime]::UtcNow.AddSeconds(3);$dialogs=@()
  do {
   $dialogs=@($w.FindAll($ts,[Windows.Automation.PropertyCondition]::new($ae::ClassNameProperty,'#32770')) | Where-Object {[DshFault]::GetWindow([IntPtr]$_.Current.NativeWindowHandle,4) -eq $main})
   if($dialogs.Count -eq 0) {Start-Sleep -Milliseconds 80}
  } while($dialogs.Count -eq 0 -and [DateTime]::UtcNow -lt $until)
  if($dialogs.Count -ne 1) {throw 'DIALOG_CHANGED'}
  $dialog=[IntPtr]$dialogs[0].Current.NativeWindowHandle
  if($request.operation -ceq 'cancel-save-dialog') {
   if([string]$dialog.ToInt64() -cne [string]$request.dialogHandle) {throw 'CANCEL_DIALOG_CHANGED'}
   $buttons=@($dialogs[0].FindAll($ts,[Windows.Automation.PropertyCondition]::new($ae::ClassNameProperty,'Button')) | Where-Object {$_.Current.NativeWindowHandle -ne 0 -and [DshFault]::GetDlgCtrlID([IntPtr]$_.Current.NativeWindowHandle) -eq 2 -and [DshFault]::GetAncestor([IntPtr]$_.Current.NativeWindowHandle,2) -eq $dialog})
   if($buttons.Count -ne 1) {throw 'CANCEL_CHANGED'}
   if([DshFault]::Message([IntPtr]$buttons[0].Current.NativeWindowHandle,245,[IntPtr]::Zero,[IntPtr]::Zero,2,1500,[ref]$r) -eq [IntPtr]::Zero) {throw 'CANCEL_UNKNOWN'}
   $until=[DateTime]::UtcNow.AddSeconds(2)
   while([DshFault]::IsWindow($dialog) -and [DateTime]::UtcNow -lt $until) {Start-Sleep -Milliseconds 80}
   if([DshFault]::IsWindow($dialog)) {throw 'CANCEL_NOT_VERIFIED'}
  }
 }
 @{ok=$true;operation=$request.operation;dialogHandle=$(if($null -ne $dialog){[string]$dialog.ToInt64()}else{$null})} | ConvertTo-Json -Compress
} catch {
 @{ok=$false;code='SYNTHETIC_NATIVE_FAULT_FAILED'} | ConvertTo-Json -Compress
 exit 1
}
