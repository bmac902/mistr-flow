import { execFile } from "node:child_process";

export interface SystemAudioMuteHandle {
  readonly wasMuted: boolean;
  restore(): Promise<void>;
}

export async function muteSystemAudio(): Promise<SystemAudioMuteHandle> {
  const wasMuted = await setSystemAudioMute(true);
  return {
    wasMuted,
    async restore() {
      await setSystemAudioMute(wasMuted);
    },
  };
}

function setSystemAudioMute(muted: boolean): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        buildAudioMuteScript(muted),
      ],
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        resolve(stdout.trim().toLowerCase() === "true");
      },
    );
  });
}

function buildAudioMuteScript(muted: boolean): string {
  const targetMute = muted ? "$true" : "$false";

  return String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace MistrFlowAudio {
  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  internal class MMDeviceEnumerator {}

  internal enum EDataFlow {
    eRender,
    eCapture,
    eAll
  }

  internal enum ERole {
    eConsole,
    eMultimedia,
    eCommunications
  }

  [ComImport]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
  }

  [ComImport]
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IAudioEndpointVolume ppInterface);
  }

  [ComImport]
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out uint pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute(bool bMute, Guid pguidEventContext);
    int GetMute(out bool pbMute);
    int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
    int VolumeStepUp(Guid pguidEventContext);
    int VolumeStepDown(Guid pguidEventContext);
    int QueryHardwareSupport(out uint pdwHardwareSupportMask);
    int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
  }

  public static class EndpointVolume {
    public static bool SetMute(bool mute) {
      IAudioEndpointVolume volume = GetEndpointVolume();
      bool wasMuted;
      volume.GetMute(out wasMuted);
      volume.SetMute(mute, Guid.Empty);
      return wasMuted;
    }

    private static IAudioEndpointVolume GetEndpointVolume() {
      IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice speakers;
      enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out speakers);
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      IAudioEndpointVolume volume;
      speakers.Activate(ref iid, 23, IntPtr.Zero, out volume);
      return volume;
    }
  }
}
"@

$wasMuted = [MistrFlowAudio.EndpointVolume]::SetMute(${targetMute})
if ($wasMuted) { [Console]::Out.WriteLine("true") } else { [Console]::Out.WriteLine("false") }
`;
}
