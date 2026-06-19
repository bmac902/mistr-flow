var shell = WScript.CreateObject("WScript.Shell");
var fso = WScript.CreateObject("Scripting.FileSystemObject");

var scriptPath = WScript.ScriptFullName;
var scriptsDir = fso.GetParentFolderName(scriptPath);
var repoRoot = fso.GetParentFolderName(scriptsDir);
var desktop = shell.SpecialFolders("Desktop");
var shortcutPath = fso.BuildPath(desktop, "Mistr Flow.lnk");
var hiddenLauncherPath = fso.BuildPath(scriptsDir, "launch-mistr-flow-hidden.ps1");
var iconPath = fso.BuildPath(repoRoot, "assets\\mr-flo-head.ico");

var shortcut = shell.CreateShortcut(shortcutPath);
shortcut.TargetPath = "powershell.exe";
shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + hiddenLauncherPath + "\"";
shortcut.WorkingDirectory = repoRoot;
shortcut.Description = "Launch Mistr Flow";
shortcut.IconLocation = iconPath + ",0";
shortcut.WindowStyle = 7;
shortcut.Save();

WScript.Echo("Created " + shortcutPath);
