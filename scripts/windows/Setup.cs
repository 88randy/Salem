// Windows 10/11 bootstrapper. Built with the Windows .NET Framework 4.x compiler.
// It installs only the embedded Salem payload for the current user, without UAC.
using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Diagnostics;
using System.Text;
using System.Windows.Forms;

class SalemSetup {
  static string Quote(string value) {
    if(String.IsNullOrWhiteSpace(value) || value.IndexOf('"') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0) throw new Exception("Ruta no válida.");
    // CommandLineToArgvW consumes backslashes before a closing quote. Preserve
    // them by doubling that trailing run; C:\ must never become drive-relative C:.
    int trailing=0;for(int i=value.Length-1;i>=0 && value[i]=='\\';i--)trailing++;
    return "\"" + value + new String('\\',trailing) + "\"";
  }
  static string Argument(string[] args, string flag, string fallback) {
    for(int i=0;i<args.Length;i++) if(args[i]==flag) { if(i+1>=args.Length) throw new Exception("Falta valor de " + flag); return args[i+1]; }
    return fallback;
  }
  static bool Flag(string[] args,string flag) {return Array.IndexOf(args,flag)>=0;}
  static string Install(string installDir,string dataDir,string shortcutDir) {
    string temp=Path.Combine(Path.GetTempPath(),"SalemSetup-"+Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(temp);
    try {
      using(Stream resource=Assembly.GetExecutingAssembly().GetManifestResourceStream("SalemPayload.zip"))
      using(ZipArchive archive=new ZipArchive(resource,ZipArchiveMode.Read)) {
        foreach(ZipArchiveEntry entry in archive.Entries) {
          string target=Path.GetFullPath(Path.Combine(temp,entry.FullName));
          if(!target.StartsWith(temp+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new Exception("Archivo fuera del paquete.");
          if(entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\")) {Directory.CreateDirectory(target);continue;}
          Directory.CreateDirectory(Path.GetDirectoryName(target));
          entry.ExtractToFile(target,false);
        }
      }
      ProcessStartInfo start=new ProcessStartInfo(Path.Combine(temp,"runtime","node.exe"));
      start.Arguments=Quote(Path.Combine(temp,"windows","manager.mjs"))+" install --payload "+Quote(temp)+" --install-dir "+Quote(installDir)+" --data-dir "+Quote(dataDir);
      if(shortcutDir!=null)start.Arguments+=" --shortcut-dir "+Quote(shortcutDir);
      start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;start.StandardOutputEncoding=Encoding.UTF8;start.StandardErrorEncoding=Encoding.UTF8;start.WorkingDirectory=temp;
      using(Process process=Process.Start(start)) {
        string output=process.StandardOutput.ReadToEnd();string error=process.StandardError.ReadToEnd();process.WaitForExit();
        if(process.ExitCode!=0)throw new Exception(error.Length>0?error:output);
        return output;
      }
    } finally {
      // This generated temporary folder contains only entries from our own
      // embedded archive. Never delete an arbitrary command-line path.
      if(Path.GetFileName(temp).StartsWith("SalemSetup-",StringComparison.Ordinal) && Path.GetDirectoryName(temp).Equals(Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase)) {
        try {Directory.Delete(temp,true);}catch{}
      }
    }
  }
  [STAThread] static int Main(string[] args) {
    string local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    string install=Argument(args,"--install-dir",Path.Combine(local,"Programs","Salem"));
    string data=Argument(args,"--data-dir",Path.Combine(local,"Salem"));
    string shortcuts=Argument(args,"--shortcut-dir",null);
    bool silent=Flag(args,"--silent");
    try {
      if(silent) {Install(install,data,shortcuts);return 0;}
      Application.EnableVisualStyles();
      Form form=new Form();form.Text="Instalar Salem";form.Width=610;form.Height=315;form.StartPosition=FormStartPosition.CenterScreen;form.FormBorderStyle=FormBorderStyle.FixedDialog;form.MaximizeBox=false;
      Label title=new Label();title.Text="Salem · interfaz local para tus agentes";title.SetBounds(22,18,560,24);form.Controls.Add(title);
      Label note=new Label();note.Text="Instalación por usuario. Incluye Node.js. Tus datos se guardan fuera de la aplicación.\nCierra Salem antes de actualizar; las versiones anteriores se conservan.";note.SetBounds(22,48,560,45);form.Controls.Add(note);
      Label il=new Label();il.Text="Carpeta de instalación";il.SetBounds(22,100,540,18);form.Controls.Add(il);
      TextBox it=new TextBox();it.Text=install;it.SetBounds(22,121,550,23);form.Controls.Add(it);
      Label dl=new Label();dl.Text="Carpeta de datos (se conserva al desinstalar)";dl.SetBounds(22,154,540,18);form.Controls.Add(dl);
      TextBox dt=new TextBox();dt.Text=data;dt.SetBounds(22,175,550,23);form.Controls.Add(dt);
      CheckBox launch=new CheckBox();launch.Text="Abrir Salem al terminar";launch.Checked=true;launch.SetBounds(22,218,300,25);form.Controls.Add(launch);
      Button button=new Button();button.Text="Instalar / actualizar";button.SetBounds(402,215,170,32);form.Controls.Add(button);
      button.Click+=delegate {
        button.Enabled=false;form.UseWaitCursor=true;
        try {
          Install(it.Text,dt.Text,shortcuts);
          MessageBox.Show("Salem está instalado. Encontrarás Salem y Salir de Salem en el menú Inicio.\nPara desinstalar, usa Desinstalar Salem. Tus datos se conservan.","Salem",MessageBoxButtons.OK,MessageBoxIcon.Information);
          if(launch.Checked)Process.Start(new ProcessStartInfo("wscript.exe",Quote(Path.Combine(it.Text,"Launch.vbs"))){UseShellExecute=false,CreateNoWindow=true});
          form.Close();
        } catch(Exception error) {MessageBox.Show(error.Message,"No se pudo instalar Salem",MessageBoxButtons.OK,MessageBoxIcon.Error);button.Enabled=true;form.UseWaitCursor=false;}
      };
      Application.Run(form);return 0;
    } catch(Exception error) {
      if(!silent)MessageBox.Show(error.Message,"Salem",MessageBoxButtons.OK,MessageBoxIcon.Error);
      else {try{File.WriteAllText(Path.Combine(Path.GetTempPath(),"SalemSetup-last-error.log"),error.Message);}catch{}}
      return 1;
    }
  }
}
