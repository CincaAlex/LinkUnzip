//! The system folder picker behind the extension's Browse... buttons (`pick_folder`) and
//! `linkunzip debug pick-folder`.

use std::path::{Path, PathBuf};

use anyhow::Result;

/// Show the "Select folder" dialog and wait for the user. `Ok(None)` means they cancelled.
///
/// `start` is the folder it opens in (when it exists; otherwise the Downloads folder). `parent` is
/// the window Chrome named with `--parent-window=` when it started the helper (0 or `None` = the
/// window in front, which is the browser right after a click on Browse...).
///
/// The dialog runs a message loop until it closes, so call this from a thread of its own.
pub fn pick_folder(start: Option<&Path>, parent: Option<isize>) -> Result<Option<PathBuf>> {
    let start = start
        .filter(|p| p.is_dir())
        .map(Path::to_path_buf)
        .unwrap_or_else(crate::host::downloads_dir);
    imp::pick_folder(&start, parent)
}

#[cfg(windows)]
mod imp {
    use std::path::{Path, PathBuf};

    use anyhow::{Context, Result};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance,
        CoInitializeEx, CoTaskMemFree, CoUninitialize,
    };
    use windows::Win32::UI::Shell::{
        FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, FileOpenDialog, IFileOpenDialog,
        IShellItem, SHCreateItemFromParsingName, SIGDN_FILESYSPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GA_ROOTOWNER, GetAncestor, GetForegroundWindow, IsWindow,
    };
    use windows::core::{HRESULT, HSTRING};

    pub fn pick_folder(start: &Path, parent: Option<isize>) -> Result<Option<PathBuf>> {
        // SAFETY: COM is set up for this thread only and torn down before it returns; every
        // interface pointer is released (dropped) before CoUninitialize.
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
                .ok()
                .context("could not start the folder picker (COM)")?;
            let picked = show(start, parent);
            CoUninitialize();
            picked
        }
    }

    unsafe fn show(start: &Path, parent: Option<isize>) -> Result<Option<PathBuf>> {
        unsafe {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
                    .context("could not create the folder picker")?;
            let options = dialog.GetOptions()?;
            dialog
                .SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)?;
            dialog.SetTitle(&HSTRING::from("Choose where LinkUnzip puts the files"))?;
            dialog.SetOkButtonLabel(&HSTRING::from("Use this folder"))?;
            if let Ok(item) =
                SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(start), None)
            {
                // Best effort: without it the dialog opens wherever it was last.
                let _ = dialog.SetFolder(&item);
            }
            match dialog.Show(owner(parent)) {
                Ok(()) => {}
                Err(e) if e.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => return Ok(None),
                Err(e) => return Err(e).context("the folder picker failed"),
            }
            let item = dialog.GetResult()?;
            let name = item.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = name.to_string();
            CoTaskMemFree(Some(name.0 as *const _));
            Ok(Some(PathBuf::from(path?)))
        }
    }

    /// The window the dialog belongs to: it stays in front of it, and that window waits while
    /// the dialog is open. Always the top-level browser window: the toolbar popup is a window of
    /// its own that closes when the dialog takes the focus, and it would take the dialog with it.
    unsafe fn owner(parent: Option<isize>) -> Option<HWND> {
        unsafe {
            let window = match parent {
                Some(handle) if handle != 0 => HWND(handle as *mut _),
                _ => GetForegroundWindow(),
            };
            if window.is_invalid() || !IsWindow(Some(window)).as_bool() {
                return None;
            }
            let top = GetAncestor(window, GA_ROOTOWNER);
            Some(if top.is_invalid() { window } else { top })
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::{Path, PathBuf};

    use anyhow::Result;

    use crate::error::{Coded, ErrorCode};

    pub fn pick_folder(_start: &Path, _parent: Option<isize>) -> Result<Option<PathBuf>> {
        Err(Coded::new(
            ErrorCode::Unsupported,
            "the folder picker is only available on Windows",
        )
        .into())
    }
}
