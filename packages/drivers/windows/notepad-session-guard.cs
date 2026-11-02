// Product monitor only. Metadata and HWND identity checks; no UIA, window text,
// keyboard hooks, key values, screenshots, document paths or document contents.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class DeskshellNotepadSessionGuard {
  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint cbSize; public uint dwTime; }
  delegate void WinEvent(IntPtr hook, uint evt, IntPtr hwnd, int obj, int child, uint thread, uint time);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint process, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int maximum);
  delegate bool EnumWindow(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr data);
  sealed class Work { public Dictionary<string,object> Value; public bool Pipe; public string Reply; public ManualResetEventSlim Done = new ManualResetEventSlim(); public long NotBefore; }
  static readonly ConcurrentQueue<Work> queue = new ConcurrentQueue<Work>();
  static readonly ThreadLocal<JavaScriptSerializer> serializers = new ThreadLocal<JavaScriptSerializer>(()=>new JavaScriptSerializer { MaxJsonLength=8192, RecursionLimit=8 });
  static JavaScriptSerializer json { get { return serializers.Value; } }
  static readonly Stopwatch clock = Stopwatch.StartNew();
  static string nonce, pipeName, invalid, leaseId, leaseKind;
  static uint inputTick, targetPid; static long sequence, leaseDeadline, lastPump, lastEvent, lastHeartbeat, started, targetStart;
  static int leaseTimeout, desktopSession; static Process parent; static long parentStart;
  static IntPtr target = IntPtr.Zero, dialog = IntPtr.Zero, hookSystem, hookObjects;
  static readonly HashSet<IntPtr> menuWindows = new HashSet<IntPtr>();
  static bool bound, dialogClosed, ended; static WinEvent callback; static GCHandle callbackHandle;
  static int queued; static System.Windows.Forms.Timer timer;
  static object Get(Dictionary<string,object> value, string key) { object result; return value.TryGetValue(key,out result) ? result : null; }
  static string Str(Dictionary<string,object> value,string key) { return Get(value,key) as string; }
  static void Write(string type, Dictionary<string,object> extra) {
    var frame = new Dictionary<string,object> { {"version",1},{"nonce",nonce},{"sequence",++sequence},{"type",type},{"inputTick",inputTick} };
    if(extra != null) foreach(var pair in extra) frame[pair.Key]=pair.Value;
    Console.Out.WriteLine(json.Serialize(frame)); Console.Out.Flush();
  }
  static void Invalidate(string code) {
    if(invalid != null) return; invalid=code;
    Write("invalid", new Dictionary<string,object>{{"code",code}});
  }
  static bool InputUnchanged() {
    var info = new LastInput { cbSize=(uint)Marshal.SizeOf(typeof(LastInput)) };
    if(!GetLastInputInfo(ref info)) { Invalidate("GUARD_INPUT_UNAVAILABLE"); return false; }
    if(info.dwTime != inputTick) { Invalidate("GUARD_INPUT_CHANGED"); return false; }
    return true;
  }
  static string ClassOf(IntPtr hwnd) { var buffer=new StringBuilder(256); return GetClassName(hwnd,buffer,256)>0 ? buffer.ToString() : ""; }
  static bool Owned(IntPtr hwnd) {
    uint pid; GetWindowThreadProcessId(hwnd,out pid); if(pid!=targetPid) return false;
    var owner=GetWindow(hwnd,4); for(int i=0;i<16 && owner!=IntPtr.Zero;i++) { if(owner==target) return true; owner=GetWindow(owner,4); }
    return false;
  }
  static bool AnyOwnedWindow() {
    bool found=false; EnumWindows(delegate(IntPtr hwnd,IntPtr ignored) { if(IsWindowVisible(hwnd) && Owned(hwnd)) { found=true; return false; } return true; },IntPtr.Zero); return found;
  }
  static bool Identity() {
    if(!bound) return true;
    try {
      using(var process=Process.GetProcessById((int)targetPid)) {
        if(process.StartTime.ToUniversalTime().Ticks!=targetStart || process.SessionId!=desktopSession) { Invalidate("GUARD_PROCESS_CHANGED"); return false; }
      }
      uint pid; GetWindowThreadProcessId(target,out pid);
      if(!IsWindow(target) || pid!=targetPid || GetWindow(target,4)!=IntPtr.Zero) { Invalidate("GUARD_WINDOW_CHANGED"); return false; }
      return true;
    } catch { Invalidate("GUARD_PROCESS_CHANGED"); return false; }
  }
  static bool Healthy() {
    if(invalid!=null || ended) return false;
    if(clock.ElapsedMilliseconds-started>600000) Invalidate("GUARD_SESSION_EXPIRED");
    if(leaseId!=null && clock.ElapsedMilliseconds>leaseDeadline) Invalidate("GUARD_LEASE_EXPIRED");
    try { if(parent.HasExited || parent.StartTime.ToUniversalTime().Ticks!=parentStart) Invalidate("GUARD_PARENT_EXITED"); } catch { Invalidate("GUARD_PARENT_EXITED"); }
    return invalid==null && InputUnchanged() && Identity();
  }
  static void Event(IntPtr hook,uint evt,IntPtr hwnd,int obj,int child,uint thread,uint eventTime) {
    try {
      if(invalid!=null || !bound) return;
      // Targeted operations may run in the background. Focus alone is not document
      // identity; genuine desktop input is independently latched by InputUnchanged.
      if(evt==3) return;
      if(hwnd==target && (evt==0x8001 || evt==0x8003) && obj==0) { Invalidate("GUARD_WINDOW_CHANGED"); return; }
      bool owned=hwnd==dialog || Owned(hwnd);
      bool system=evt>=4 && evt<=0x17;
      if(!owned && !(hwnd==target && system)) return;
      bool structure=obj==0 && evt>=0x8000 && evt<=0x8003;
      // Modern Notepad keeps hidden IME and popup HWNDs alive. Their existence is
      // not a modal operation. A future visible SHOW is still monitored normally.
      if(structure && !IsWindowVisible(hwnd) && hwnd!=dialog && !menuWindows.Contains(hwnd)) return;
      lastEvent=clock.ElapsedMilliseconds;
      if(leaseId==null || (leaseKind!="open" && leaseKind!="save-copy")) { Invalidate("GUARD_UNLEASED_EVENT"); return; }
      if(owned && structure) {
        if(evt==0x8000 || evt==0x8002) {
          string windowClass=ClassOf(hwnd);
          // Exact native class observed for this Notepad build's File menu. This
          // is never counted as proof of an Open/Save dialog; end requires it hidden.
          if(windowClass=="Microsoft.UI.Content.PopupWindowSiteBridge") { menuWindows.Add(hwnd); return; }
          if(windowClass!="#32770" || dialog!=IntPtr.Zero && (dialog!=hwnd || dialogClosed)) { Invalidate("GUARD_UNEXPECTED_DIALOG"); return; }
          dialog=hwnd;
        } else if(hwnd==dialog) dialogClosed=true;
        else menuWindows.Remove(hwnd);
      }
    } catch { Invalidate("GUARD_HOOK_FAILED"); }
  }
  static string ReadBounded(TextReader reader,int maximum) {
    var text=new StringBuilder(); while(true) { int next=reader.Read(); if(next<0) return text.Length==0 ? null : text.ToString(); if(next==10) return text.ToString(); if(text.Length>=maximum) throw new InvalidDataException(); if(next!=13) text.Append((char)next); }
  }
  static void Enqueue(Work work) {
    if(Interlocked.Increment(ref queued)>64) { Interlocked.Decrement(ref queued); throw new InvalidDataException(); }
    queue.Enqueue(work);
  }
  static void PipeLoop() {
    try {
      while(!ended && invalid==null) {
        var security=new PipeSecurity(); var sid=WindowsIdentity.GetCurrent().User;
        security.SetAccessRuleProtection(true,false); security.AddAccessRule(new PipeAccessRule(sid,PipeAccessRights.FullControl,AccessControlType.Allow));
        using(var server=new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,security)) {
          server.WaitForConnection();
          using(var reader=new StreamReader(server,new UTF8Encoding(false,true),false,1024,true))
          using(var writer=new StreamWriter(server,new UTF8Encoding(false),1024,true)) {
            var read=Task.Run(()=>ReadBounded(reader,2048)); if(!read.Wait(1000)) continue;
            var value=json.Deserialize<Dictionary<string,object>>(read.Result); var work=new Work { Value=value, Pipe=true };
            Enqueue(work); if(!work.Done.Wait(1000)) continue;
            writer.WriteLine(work.Reply); writer.Flush();
          }
        }
      }
    } catch { try { Enqueue(new Work { Value=new Dictionary<string,object>{{"command","pipe-failed"}} }); } catch { } }
  }
  static void ProcessWork(Work work) {
    var value=work.Value;
    bool valid=Healthy(); string command=Str(value,"command");
    bool authenticated=Get(value,"version") is int && (int)value["version"]==1 && Str(value,"nonce")==nonce;
    if(work.Pipe) {
      bool allowed=valid && authenticated && command=="check" && leaseId!=null && Str(value,"leaseId")==leaseId;
      work.Reply=json.Serialize(allowed ? new Dictionary<string,object>{{"ok",true}} : new Dictionary<string,object>{{"ok",false},{"code",invalid??"GUARD_PROTOCOL_FAILED"}}); work.Done.Set(); return;
    }
    if(command=="pipe-failed") { Invalidate("GUARD_PIPE_FAILED"); return; }
    if(command=="parent-eof") { Invalidate("GUARD_PARENT_EXITED"); return; }
    if(!valid) return;
    if(!authenticated || Str(value,"requestId")==null) { Invalidate("GUARD_PROTOCOL_FAILED"); return; }
    if(command=="bind") {
      if(bound || leaseId!=null) { Invalidate("GUARD_PROTOCOL_FAILED"); return; }
      var binding=Get(value,"binding") as Dictionary<string,object>;
      if(binding==null) { Invalidate("GUARD_PROTOCOL_FAILED"); return; }
      targetPid=Convert.ToUInt32(binding["pid"]); targetStart=Int64.Parse((string)binding["startedTicks"]); target=new IntPtr(Int64.Parse((string)binding["hwnd"])); bound=true;
      if(!Identity()) return; if(AnyOwnedWindow()) { Invalidate("GUARD_DIALOG_LEFT_OPEN"); return; }
    } else if(command=="begin") {
      string kind=Str(value,"kind"), id=Str(value,"leaseId"); Guid ignored;
      if(leaseId!=null || !Guid.TryParse(id,out ignored) || kind!="open" && kind!="observe" && kind!="edit" && kind!="save-copy" || kind=="open" && bound || kind!="open" && !bound) { Invalidate("GUARD_PROTOCOL_FAILED"); return; }
      if(bound && AnyOwnedWindow()) { Invalidate("GUARD_UNLEASED_EVENT"); return; }
      leaseId=id; leaseKind=kind; leaseDeadline=clock.ElapsedMilliseconds+leaseTimeout; dialog=IntPtr.Zero; dialogClosed=false; menuWindows.Clear();
    } else if(command=="end") {
      if(leaseId==null || Str(value,"leaseId")!=leaseId) { Invalidate("GUARD_PROTOCOL_FAILED"); return; }
      // Let queued WinEvents reach the same pumping thread before acknowledging.
      if(work.NotBefore==0) { work.NotBefore=clock.ElapsedMilliseconds+100; Enqueue(work); return; }
      if(bound && AnyOwnedWindow()) { Invalidate("GUARD_DIALOG_LEFT_OPEN"); return; }
      if(leaseKind=="save-copy" && (dialog==IntPtr.Zero || !dialogClosed)) { Invalidate("GUARD_UNEXPECTED_DIALOG"); return; }
      if(clock.ElapsedMilliseconds-lastEvent<80) { work.NotBefore=clock.ElapsedMilliseconds+80; Enqueue(work); return; }
      leaseId=null; leaseKind=null;
    } else if(command!="check") { Invalidate("GUARD_PROTOCOL_FAILED"); return; }
    if(Healthy()) Write("reply",new Dictionary<string,object>{{"requestId",Str(value,"requestId")},{"ok",true}});
  }
  [STAThread] public static void Run() {
    try {
      var initial=json.Deserialize<Dictionary<string,object>>(ReadBounded(Console.In,4096)); Guid ignored;
      nonce=Str(initial,"nonce"); pipeName=Str(initial,"pipe");
      if(!Guid.TryParse(nonce,out ignored) || pipeName==null || !pipeName.StartsWith("deskshell-notepad-guard-") || pipeName.Length>80) return;
      leaseTimeout=Convert.ToInt32(initial["leaseTimeoutMs"]); if(leaseTimeout<20 || leaseTimeout>30000) return;
      parent=Process.GetProcessById(Convert.ToInt32(initial["parentPid"])); parentStart=parent.StartTime.ToUniversalTime().Ticks;
      using(var current=Process.GetCurrentProcess()) desktopSession=current.SessionId;
      var info=new LastInput { cbSize=(uint)Marshal.SizeOf(typeof(LastInput)) }; if(!GetLastInputInfo(ref info)) { Invalidate("GUARD_INPUT_UNAVAILABLE"); return; } inputTick=info.dwTime;
      callback=Event; callbackHandle=GCHandle.Alloc(callback);
      hookSystem=SetWinEventHook(3,0x17,IntPtr.Zero,callback,0,0,0); hookObjects=SetWinEventHook(0x8000,0x8003,IntPtr.Zero,callback,0,0,0);
      if(hookSystem==IntPtr.Zero || hookObjects==IntPtr.Zero) { Invalidate("GUARD_HOOK_FAILED"); return; }
      started=lastPump=lastHeartbeat=clock.ElapsedMilliseconds;
      Task.Run((Action)PipeLoop);
      Task.Run(()=> { try { string line; while((line=ReadBounded(Console.In,4096))!=null) Enqueue(new Work { Value=json.Deserialize<Dictionary<string,object>>(line) }); Enqueue(new Work { Value=new Dictionary<string,object>{{"command","parent-eof"}} }); } catch { try { Enqueue(new Work { Value=new Dictionary<string,object>{{"command","parent-eof"}} }); } catch { } } });
      timer=new System.Windows.Forms.Timer { Interval=20 };
      timer.Tick+=(sender,args)=> {
        try {
          long now=clock.ElapsedMilliseconds;
          if(now-lastPump>1000) Invalidate("GUARD_PUMP_GAP"); lastPump=now;
          if(!Healthy()) { Application.ExitThread(); return; }
          int count=Volatile.Read(ref queued); Work work;
          for(int i=0;i<count && queue.TryDequeue(out work);i++) { Interlocked.Decrement(ref queued); if(work.NotBefore>now) Enqueue(work); else ProcessWork(work); }
          if(now-lastHeartbeat>=250 && invalid==null) { lastHeartbeat=now; Write("heartbeat",null); }
        } catch { Invalidate("GUARD_PROTOCOL_FAILED"); Application.ExitThread(); }
      };
      timer.Start(); Write("ready",null); Application.Run();
    } finally {
      ended=true; if(timer!=null) timer.Dispose(); if(hookSystem!=IntPtr.Zero) UnhookWinEvent(hookSystem); if(hookObjects!=IntPtr.Zero) UnhookWinEvent(hookObjects); if(callbackHandle.IsAllocated) callbackHandle.Free(); if(parent!=null) parent.Dispose();
    }
  }
}
