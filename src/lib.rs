//! LinkUnzip: extract a ZIP file straight from a URL without ever saving the ZIP to disk.
//!
//! The binary (`src/main.rs`) is a thin CLI over this library; the integration tests call the
//! library directly.

pub mod browse;
pub mod disk;
pub mod error;
pub mod extract;
pub mod fmt;
pub mod host;
pub mod http;
pub mod inspect;
pub mod picker;
pub mod plan;
pub mod resume;
pub mod safety;
pub mod stats;
pub mod stream;
pub mod ui;
pub mod zip;
