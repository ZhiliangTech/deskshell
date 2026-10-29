// axbridge — macOS 原生 AX 桥
//
// System Events（AppleScript）在真机上枚举窗口要 20 秒级，且 `entire contents`
// 基本不可用。这里直接用 AXUIElement + CGWindowList，毫秒级。
//
// 用法:
//   axbridge windows
//   axbridge tree --pid <pid> [--depth 6]
//
// 输出: 单行 JSON

import Foundation
import Cocoa
import ApplicationServices

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return err == .success ? v : nil
}

func text(_ el: AXUIElement, _ name: String) -> String {
    if let s = attr(el, name) as? String { return s }
    return ""
}

func rectOf(_ el: AXUIElement) -> [String: Double] {
    var out: [String: Double] = ["x": 0, "y": 0, "w": 0, "h": 0]
    if let p = attr(el, kAXPositionAttribute) {
        var pt = CGPoint.zero
        if AXValueGetValue(p as! AXValue, .cgPoint, &pt) {
            out["x"] = Double(pt.x)
            out["y"] = Double(pt.y)
        }
    }
    if let s = attr(el, kAXSizeAttribute) {
        var sz = CGSize.zero
        if AXValueGetValue(s as! AXValue, .cgSize, &sz) {
            out["w"] = Double(sz.width)
            out["h"] = Double(sz.height)
        }
    }
    return out
}

func node(_ el: AXUIElement, depth: Int, maxDepth: Int, budget: inout Int) -> [String: Any] {
    budget -= 1
    let r = rectOf(el)
    var d: [String: Any] = [
        "name": text(el, kAXTitleAttribute),
        "automationId": text(el, kAXIdentifierAttribute),
        "controlType": text(el, kAXRoleAttribute).replacingOccurrences(of: "AX", with: ""),
        "className": text(el, kAXSubroleAttribute),
        "value": text(el, kAXValueAttribute),
        "enabled": true,
        "x": r["x"]!, "y": r["y"]!, "w": r["w"]!, "h": r["h"]!,
        "children": [] as [[String: Any]],
    ]
    if depth < maxDepth && budget > 0, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
        var cs: [[String: Any]] = []
        for k in kids.prefix(120) {
            if budget <= 0 { break }
            cs.append(node(k, depth: depth + 1, maxDepth: maxDepth, budget: &budget))
        }
        d["children"] = cs
    }
    return d
}

func windowsJSON() -> [[String: Any]] {
    let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
    guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [[String: Any]] = []
    for w in raw {
        guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
        let title = (w[kCGWindowName as String] as? String) ?? ""
        let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
        out.append([
            "name": title.isEmpty ? owner : title,
            "owner": owner,
            "pid": (w[kCGWindowOwnerPID as String] as? Int) ?? 0,
            "x": (b["X"] as? Double) ?? 0,
            "y": (b["Y"] as? Double) ?? 0,
            "w": (b["Width"] as? Double) ?? 0,
            "h": (b["Height"] as? Double) ?? 0,
        ])
    }
    return out
}

let args = CommandLine.arguments
func flag(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func findElement(_ el: AXUIElement, role: String?, name: String?, ident: String?, depth: Int, maxDepth: Int, budget: inout Int) -> AXUIElement? {
    budget -= 1
    if budget <= 0 || depth > maxDepth { return nil }
    let r = text(el, kAXRoleAttribute)
    let t = text(el, kAXTitleAttribute)
    let i = text(el, kAXIdentifierAttribute)
    let roleOK = role == nil || r == role
    let nameOK = name == nil || t == name
    let idOK = ident == nil || i == ident
    if roleOK && nameOK && idOK && (role != nil || name != nil || ident != nil) {
        return el
    }
    if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
        for k in kids {
            if let hit = findElement(k, role: role, name: name, ident: ident, depth: depth + 1, maxDepth: maxDepth, budget: &budget) {
                return hit
            }
        }
    }
    return nil
}

func clickAt(_ x: Double, _ y: Double) {
    let src = CGEventSource(stateID: .hidSystemState)
    let pt = CGPoint(x: x, y: y)
    let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)
    let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)
    down?.post(tap: .cghidEventTap)
    usleep(20000)
    up?.post(tap: .cghidEventTap)
}

func windowElement(_ pid: pid_t) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    if let wins = attr(app, kAXWindowsAttribute) as? [AXUIElement], let first = wins.first {
        return first
    }
    return nil
}

var output: Any
switch args.count > 1 ? args[1] : "windows" {
case "windows":
    output = windowsJSON()
case "tree":
    let pid = pid_t(flag("--pid") ?? "0") ?? 0
    let depth = Int(flag("--depth") ?? "6") ?? 6
    let app = AXUIElementCreateApplication(pid)
    var budget = 1200
    output = node(app, depth: 0, maxDepth: depth, budget: &budget)
case "press":
    let pid = pid_t(flag("--pid") ?? "0") ?? 0
    let role = flag("--role").map { $0.hasPrefix("AX") ? $0 : "AX" + $0 }
    let app = AXUIElementCreateApplication(pid)
    var budget = 6000
    guard let el = findElement(app, role: role, name: flag("--name"), ident: flag("--id"), depth: 0, maxDepth: 24, budget: &budget) else {
        output = ["ok": false, "error": "element not found"]
        let d = try! JSONSerialization.data(withJSONObject: output, options: [])
        FileHandle.standardOutput.write(d)
        exit(2)
    }
    let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
    let rect = rectOf(el)
    output = [
        "ok": err == .success,
        "action": "AXPress",
        "role": text(el, kAXRoleAttribute),
        "title": text(el, kAXTitleAttribute),
        "x": rect["x"]!, "y": rect["y"]!, "w": rect["w"]!, "h": rect["h"]!,
    ]
case "click":
    let x = Double(flag("--x") ?? "0") ?? 0
    let y = Double(flag("--y") ?? "0") ?? 0
    clickAt(x, y)
    output = ["ok": true, "x": x, "y": y]
case "move":
    let pid = pid_t(flag("--pid") ?? "0") ?? 0
    let x = Double(flag("--x") ?? "0") ?? 0
    let y = Double(flag("--y") ?? "0") ?? 0
    let w = Double(flag("--w") ?? "0") ?? 0
    let h = Double(flag("--h") ?? "0") ?? 0
    guard let win = windowElement(pid) else {
        output = ["ok": false, "error": "window not found"]
        let d = try! JSONSerialization.data(withJSONObject: output, options: [])
        FileHandle.standardOutput.write(d)
        exit(2)
    }
    var pt = CGPoint(x: x, y: y)
    var sz = CGSize(width: w, height: h)
    let pv = AXValueCreate(.cgPoint, &pt)!
    let sv = AXValueCreate(.cgSize, &sz)!
    let e1 = AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, pv)
    let e2 = AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, sv)
    output = ["ok": e1 == .success, "position": e1 == .success, "size": e2 == .success, "x": x, "y": y, "w": w, "h": h]
case "type":
    // 直接投递 Unicode 事件，绕过输入法：AppleScript 的 keystroke 会走当前输入法
    // （中文输入法下 "hello" 会变成"和力量"这种拼音候选）。
    let text = flag("--text") ?? ""
    let src = CGEventSource(stateID: .hidSystemState)
    let units = Array(text.utf16)
    var i = 0
    while i < units.count {
        let chunk = Array(units[i..<min(i + 20, units.count)])
        chunk.withUnsafeBufferPointer { buf in
            let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)!
            down.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress!)
            down.post(tap: .cghidEventTap)
            let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)!
            up.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress!)
            up.post(tap: .cghidEventTap)
        }
        usleep(8000)
        i += 20
    }
    output = ["typed": units.count]
case "trusted":
    output = ["trusted": AXIsProcessTrusted()]
default:
    output = ["error": "unknown command \(args[1])"]
}

let data = try! JSONSerialization.data(withJSONObject: output, options: [])
FileHandle.standardOutput.write(data)
