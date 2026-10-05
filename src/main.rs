use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};

use linkunzip::error::{self, RetryPolicy};
use linkunzip::extract::{self, ExtractOptions};
use linkunzip::{host, http, inspect, picker, ui};

#[derive(Parser)]
#[command(
    name = "linkunzip",
    version,
    about = "Extract a ZIP file straight from a URL without ever saving the ZIP to disk"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Read the ZIP index over HTTP and show what extracting would need
    Inspect {
        /// URL of the .zip (the server must support HTTP Range requests)
        url: String,
        /// Folder whose drive is used for the free-space comparison
        #[arg(short, long, default_value = ".")]
        output: PathBuf,
        /// Also list every entry
        #[arg(long)]
        list: bool,
    },
    /// Download and extract the ZIP in one pass, never storing the ZIP itself
    Extract {
        /// URL of the .zip (the server must support HTTP Range requests)
        url: String,
        /// Folder to extract into (created if missing)
        #[arg(short, long)]
        output: PathBuf,
        /// Only extract entries matching this glob, e.g. "*.csv" or "logs/*" (repeatable)
        #[arg(long, value_name = "GLOB")]
        include: Vec<String>,
        /// Number of parallel connections
        #[arg(long, default_value_t = 4)]
        jobs: usize,
        /// Extract even if the free-space check says the files will not fit
        #[arg(long)]
        force: bool,
        /// Read the file once from start to finish instead of using Range requests, for servers
        /// that cannot send parts of a file (e.g. GitHub's "Download ZIP"). One connection.
        #[arg(long)]
        stream: bool,
        /// Extract every file again. Without it, files already in the folder with the right size
        /// and CRC-32 (from an earlier, interrupted run) are skipped and not downloaded.
        #[arg(long)]
        overwrite: bool,
    },
    /// Connect LinkUnzip to the Chrome/Edge extension (install, uninstall, status)
    Host {
        #[command(subcommand)]
        action: HostAction,
    },
    /// Try pieces of the browser helper by hand
    #[command(hide = true)]
    Debug {
        #[command(subcommand)]
        action: DebugAction,
    },
}

#[derive(Subcommand)]
enum DebugAction {
    /// Show the folder picker the extension's Browse... buttons use and print the chosen folder
    PickFolder {
        /// Folder the picker opens in (default: Downloads)
        #[arg(long)]
        start: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum HostAction {
    /// Register LinkUnzip with Chrome, Edge, Brave and Chromium for the current user
    Install {
        /// Extension ID allowed to talk to LinkUnzip (defaults to the bundled extension's)
        #[arg(long = "extension-id")]
        extension_ids: Vec<String>,
    },
    /// Undo `host install`
    Uninstall,
    /// Show where the host is registered
    Status,
    /// Speak the native-messaging protocol on stdin/stdout (for testing; browsers start this themselves)
    Run,
}

fn main() -> ExitCode {
    // Chrome starts a native-messaging host as `program chrome-extension://<id>/` (plus
    // `--parent-window=N` on Windows): that is not a command line clap should see.
    let args: Vec<String> = std::env::args().collect();
    if args
        .get(1)
        .is_some_and(|a| a.starts_with("chrome-extension://"))
    {
        return report(host::run_stdio(host::parent_window_arg(&args)), None);
    }
    let cli = Cli::parse();
    let host = match &cli.command {
        Command::Inspect { url, .. } | Command::Extract { url, .. } => http::host_of(url),
        Command::Host { .. } | Command::Debug { .. } => None,
    };
    report(run(cli), host.as_deref())
}

/// Print a failure the way people should read it: the plain-English message, the technical
/// details when they say more, and what to try next.
fn report(result: Result<()>, host: Option<&str>) -> ExitCode {
    let Err(e) = result else {
        return ExitCode::SUCCESS;
    };
    let d = error::describe(&e, host);
    eprintln!("error: {}", d.message);
    if d.detail != d.message {
        eprintln!("details: {}", d.detail);
    }
    if let Some(hint) = d.code.cli_hint() {
        eprintln!("hint: {hint}");
    }
    ExitCode::FAILURE
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Host { action } => {
            match action {
                HostAction::Install { extension_ids } => {
                    let ids = if extension_ids.is_empty() {
                        vec![host::EXTENSION_ID.to_string()]
                    } else {
                        extension_ids
                    };
                    print!("{}", host::install(&ids)?);
                }
                HostAction::Uninstall => print!("{}", host::uninstall()?),
                HostAction::Status => print!("{}", host::status()?),
                HostAction::Run => host::run_stdio(None)?,
            }
            Ok(())
        }
        Command::Debug {
            action: DebugAction::PickFolder { start },
        } => {
            match picker::pick_folder(start.as_deref(), None)? {
                Some(path) => println!("{}", path.display()),
                None => println!("(cancelled)"),
            }
            Ok(())
        }
        Command::Inspect { url, output, list } => {
            let report = inspect::inspect(&url, &output, RetryPolicy::default())?;
            print!("{}", report.render(list));
            Ok(())
        }
        Command::Extract {
            url,
            output,
            include,
            jobs,
            force,
            stream,
            overwrite,
        } => {
            if !(1..=64).contains(&jobs) {
                bail!("--jobs must be between 1 and 64");
            }
            let opts = ExtractOptions {
                url,
                output,
                include,
                select: None,
                jobs,
                force,
                retry: RetryPolicy::default(),
                progress: true,
                headers: Vec::new(),
                cancel: None,
                on_progress: None,
                stream,
                resume: !overwrite,
            };
            let summary = extract::run(&opts)?;
            print!("{}", ui::render_summary(&summary));
            Ok(())
        }
    }
}
