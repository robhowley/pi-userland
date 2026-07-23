use dirs::home_dir;
use libc::{geteuid, getpwuid};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::{CStr, OsStr};
use std::fs::{self, File};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

pub const DOCTOR_COMMAND: &str = "/session-deck desktop doctor";
pub const OPEN_TERMINAL_ACTION_BRIDGE_SOCKET_ENV: &str =
    "PI_SESSION_DECK_ITERM2_BRIDGE_SOCKET_PATH";
const DESKTOP_INSTALL_COMMAND: &str = "/session-deck desktop install";
const DESKTOP_STATE_SCHEMA_VERSION: u64 = 1;
const DESKTOP_STATE_PRODUCT: &str = "session-deck-desktop";
const SESSION_DECK_PACKAGE_NAME: &str = "@robhowley/pi-session-deck";
const ITERM2_STATE_SCHEMA_VERSION: u64 = 1;
const ITERM2_STATE_PRODUCT: &str = "pi-session-deck-iterm2";
const SNAPSHOT_HELPER_RELATIVE_PATH: &str = "dist/extensions/session-deck/iterm2/snapshot-cli.js";
const OPEN_HELPER_RELATIVE_PATH: &str = "dist/extensions/session-deck/iterm2/open-action-cli.js";
const KILL_HELPER_RELATIVE_PATH: &str = "dist/extensions/session-deck/iterm2/kill-action-cli.js";
const WORKTREE_HELPER_RELATIVE_PATH: &str = "dist/extensions/session-deck/worktree/action-cli.js";
const WEB_ROOT_RELATIVE_PATH: &str = "extensions/session-deck/iterm2/web";
const FALLBACK_COMMAND_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
const EFFECTIVE_COMMAND_PATH_TIMEOUT: Duration = Duration::from_secs(3);
const EFFECTIVE_COMMAND_PATH_START: &str = "__SESSION_DECK_EFFECTIVE_PATH__START";
const EFFECTIVE_COMMAND_PATH_END: &str = "__SESSION_DECK_EFFECTIVE_PATH__END";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeMetadataSource {
    Desktop,
    Iterm2Fallback,
}

impl RuntimeMetadataSource {
    fn as_str(self) -> &'static str {
        match self {
            RuntimeMetadataSource::Desktop => "desktop",
            RuntimeMetadataSource::Iterm2Fallback => "iterm2-fallback",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorIssue {
    pub code: String,
    pub message: String,
    pub repair: String,
    pub blocking: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveCommandPath {
    pub value: String,
    pub provenance: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableStatus {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPrereqReport {
    pub path_provenance: String,
    pub tmux: ExecutableStatus,
    pub pi: ExecutableStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSummary {
    pub metadata_source: String,
    pub package_root: String,
    pub package_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declared_helper_package_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub helper_package_version: Option<String>,
    pub node_executable_path: String,
    pub snapshot_helper_path: String,
    pub open_action_helper_path: String,
    pub kill_action_helper_path: String,
    pub worktree_action_helper_path: String,
    pub web_root_path: String,
    pub bridge_socket_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorStatus {
    pub ok: bool,
    pub doctor_command: String,
    pub metadata_source: String,
    pub state_path: String,
    pub desktop_state_path: String,
    pub iterm2_fallback_state_path: String,
    pub effective_command_path: EffectiveCommandPath,
    pub launch_prereqs: LaunchPrereqReport,
    pub issues: Vec<DoctorIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeSummary>,
}

#[derive(Debug, Clone)]
pub struct ResolvedInstallState {
    pub metadata_source: RuntimeMetadataSource,
    pub state_path: PathBuf,
    pub package_root: PathBuf,
    pub package_version: String,
    pub declared_helper_package_version: Option<String>,
    pub node_executable_path: PathBuf,
    pub snapshot_helper_path: PathBuf,
    pub open_action_helper_path: PathBuf,
    pub kill_action_helper_path: PathBuf,
    pub worktree_action_helper_path: PathBuf,
    pub web_root_path: PathBuf,
    pub bridge_socket_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub metadata_source: RuntimeMetadataSource,
    pub state_path: PathBuf,
    pub package_root: PathBuf,
    pub package_version: String,
    pub helper_package_version: Option<String>,
    pub node_executable_path: PathBuf,
    pub snapshot_helper_path: PathBuf,
    pub open_action_helper_path: PathBuf,
    pub kill_action_helper_path: PathBuf,
    pub worktree_action_helper_path: PathBuf,
    pub web_root_path: PathBuf,
    pub bridge_socket_path: PathBuf,
    pub effective_command_path: EffectiveCommandPath,
}

pub struct RuntimeDiscovery {
    pub status: DoctorStatus,
    pub config: Option<RuntimeConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDesktopInstallState {
    schema_version: u64,
    product: String,
    package_name: String,
    package_version: String,
    installed_at: String,
    #[serde(default)]
    app: Option<Value>,
    #[serde(default)]
    source: Option<Value>,
    runtime: RawDesktopRuntimeState,
    #[serde(default)]
    owned_paths: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawDesktopRuntimeState {
    node_executable_path: String,
    package_root: String,
    helper_package_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawIterm2InstallState {
    schema_version: u64,
    product: String,
    package_version: String,
    script: Value,
    scripts_dir: String,
    installed_at: String,
    runtime: RawIterm2RuntimeState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawIterm2RuntimeState {
    node_executable_path: String,
    snapshot_helper_path: String,
    web_root_path: String,
    bridge_socket_path: String,
}

pub fn default_desktop_state_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| String::from("Could not determine the home directory."))?;
    Ok(home.join(".pi/session-deck/desktop/install.json"))
}

pub fn default_iterm2_fallback_state_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| String::from("Could not determine the home directory."))?;
    Ok(home.join(".pi/session-deck/iterm2/install.json"))
}

pub fn default_state_path() -> Result<PathBuf, String> {
    default_desktop_state_path()
}

pub fn derive_open_action_helper_path(snapshot_helper_path: &Path) -> PathBuf {
    snapshot_helper_path
        .parent()
        .unwrap_or(snapshot_helper_path)
        .join("open-action-cli.js")
}

pub fn derive_kill_action_helper_path(snapshot_helper_path: &Path) -> PathBuf {
    snapshot_helper_path
        .parent()
        .unwrap_or(snapshot_helper_path)
        .join("kill-action-cli.js")
}

pub fn derive_worktree_action_helper_path(snapshot_helper_path: &Path) -> PathBuf {
    snapshot_helper_path
        .parent()
        .and_then(Path::parent)
        .unwrap_or(snapshot_helper_path)
        .join("worktree/action-cli.js")
}

pub fn parse_desktop_install_state(
    contents: &str,
    state_path: &Path,
) -> Result<ResolvedInstallState, String> {
    let raw: RawDesktopInstallState = serde_json::from_str(contents)
        .map_err(|error| format!("Invalid desktop install state JSON: {error}"))?;

    if raw.schema_version != DESKTOP_STATE_SCHEMA_VERSION {
        return Err(format!(
            "Expected schemaVersion {DESKTOP_STATE_SCHEMA_VERSION}, got {}.",
            raw.schema_version
        ));
    }

    if raw.product != DESKTOP_STATE_PRODUCT {
        return Err(format!(
            "Expected product {DESKTOP_STATE_PRODUCT}, got {}.",
            raw.product
        ));
    }

    if raw.package_name != SESSION_DECK_PACKAGE_NAME {
        return Err(format!(
            "Expected packageName {SESSION_DECK_PACKAGE_NAME}, got {}.",
            raw.package_name
        ));
    }

    if raw.package_version.trim().is_empty() {
        return Err(String::from("packageVersion must be a non-empty string."));
    }

    if raw.installed_at.trim().is_empty() {
        return Err(String::from("installedAt must be a non-empty string."));
    }

    if raw.runtime.helper_package_version.trim().is_empty() {
        return Err(String::from(
            "runtime.helperPackageVersion must be a non-empty string.",
        ));
    }

    let _ = (raw.app, raw.source, raw.owned_paths);

    let node_executable_path = parse_absolute_path(
        &raw.runtime.node_executable_path,
        "runtime.nodeExecutablePath",
    )?;
    let package_root = parse_absolute_path(&raw.runtime.package_root, "runtime.packageRoot")?;

    Ok(ResolvedInstallState {
        metadata_source: RuntimeMetadataSource::Desktop,
        state_path: state_path.to_path_buf(),
        package_root: package_root.clone(),
        package_version: raw.package_version,
        declared_helper_package_version: Some(raw.runtime.helper_package_version),
        node_executable_path,
        snapshot_helper_path: package_root.join(SNAPSHOT_HELPER_RELATIVE_PATH),
        open_action_helper_path: package_root.join(OPEN_HELPER_RELATIVE_PATH),
        kill_action_helper_path: package_root.join(KILL_HELPER_RELATIVE_PATH),
        worktree_action_helper_path: package_root.join(WORKTREE_HELPER_RELATIVE_PATH),
        web_root_path: package_root.join(WEB_ROOT_RELATIVE_PATH),
        bridge_socket_path: default_bridge_socket_path(),
    })
}

pub fn parse_iterm2_install_state(
    contents: &str,
    state_path: &Path,
) -> Result<ResolvedInstallState, String> {
    let raw: RawIterm2InstallState = serde_json::from_str(contents)
        .map_err(|error| format!("Invalid iTerm2 install state JSON: {error}"))?;

    if raw.schema_version != ITERM2_STATE_SCHEMA_VERSION {
        return Err(format!(
            "Expected schemaVersion {ITERM2_STATE_SCHEMA_VERSION}, got {}.",
            raw.schema_version
        ));
    }

    if raw.product != ITERM2_STATE_PRODUCT {
        return Err(format!(
            "Expected product {ITERM2_STATE_PRODUCT}, got {}.",
            raw.product
        ));
    }

    if raw.package_version.trim().is_empty() {
        return Err(String::from("packageVersion must be a non-empty string."));
    }

    if raw.scripts_dir.trim().is_empty() {
        return Err(String::from("scriptsDir must be a non-empty string."));
    }

    if raw.installed_at.trim().is_empty() {
        return Err(String::from("installedAt must be a non-empty string."));
    }

    let _ = raw.script;

    let node_executable_path = parse_absolute_path(
        &raw.runtime.node_executable_path,
        "runtime.nodeExecutablePath",
    )?;
    let snapshot_helper_path = parse_absolute_path(
        &raw.runtime.snapshot_helper_path,
        "runtime.snapshotHelperPath",
    )?;
    let web_root_path = parse_absolute_path(&raw.runtime.web_root_path, "runtime.webRootPath")?;
    let bridge_socket_path =
        parse_absolute_path(&raw.runtime.bridge_socket_path, "runtime.bridgeSocketPath")?;
    let package_root = derive_package_root_from_snapshot_helper_path(&snapshot_helper_path)
        .unwrap_or_else(|| {
            snapshot_helper_path
                .parent()
                .unwrap_or(&snapshot_helper_path)
                .to_path_buf()
        });

    Ok(ResolvedInstallState {
        metadata_source: RuntimeMetadataSource::Iterm2Fallback,
        state_path: state_path.to_path_buf(),
        package_root,
        package_version: raw.package_version,
        declared_helper_package_version: None,
        node_executable_path,
        open_action_helper_path: derive_open_action_helper_path(&snapshot_helper_path),
        kill_action_helper_path: derive_kill_action_helper_path(&snapshot_helper_path),
        worktree_action_helper_path: derive_worktree_action_helper_path(&snapshot_helper_path),
        snapshot_helper_path,
        web_root_path,
        bridge_socket_path,
    })
}

pub fn parse_install_state(
    contents: &str,
    state_path: &Path,
) -> Result<ResolvedInstallState, String> {
    parse_iterm2_install_state(contents, state_path)
}

pub fn discover_runtime() -> RuntimeDiscovery {
    let desktop_state_path = default_desktop_state_path()
        .unwrap_or_else(|_| PathBuf::from("~/.pi/session-deck/desktop/install.json"));
    let iterm2_fallback_state_path = default_iterm2_fallback_state_path()
        .unwrap_or_else(|_| PathBuf::from("~/.pi/session-deck/iterm2/install.json"));

    discover_runtime_from_state_paths(
        &desktop_state_path,
        &iterm2_fallback_state_path,
        resolve_effective_command_path(),
    )
}

fn discover_runtime_from_state_paths(
    desktop_state_path: &Path,
    iterm2_fallback_state_path: &Path,
    effective_command_path: EffectiveCommandPath,
) -> RuntimeDiscovery {
    let launch_prereqs = collect_launch_prereqs(&effective_command_path);
    let mut issues = Vec::new();
    let mut runtime_summary = None;
    let mut runtime_config = None;

    let resolved_state =
        select_install_state(desktop_state_path, iterm2_fallback_state_path, &mut issues);
    let selected_metadata_source = resolved_state
        .as_ref()
        .map(|state| state.metadata_source.as_str())
        .unwrap_or("unavailable")
        .to_string();
    let selected_state_path = resolved_state
        .as_ref()
        .map(|state| state.state_path.clone())
        .unwrap_or_else(|| desktop_state_path.to_path_buf());

    if let Some(resolved_state) = resolved_state {
        let helper_package_version =
            read_helper_package_version(&resolved_state.package_root).unwrap_or(None);

        validate_resolved_install_state(
            &resolved_state,
            helper_package_version.as_deref(),
            &launch_prereqs,
            &mut issues,
        );

        runtime_summary = Some(RuntimeSummary {
            metadata_source: resolved_state.metadata_source.as_str().to_string(),
            package_root: resolved_state.package_root.display().to_string(),
            package_version: resolved_state.package_version.clone(),
            declared_helper_package_version: resolved_state.declared_helper_package_version.clone(),
            helper_package_version: helper_package_version.clone(),
            node_executable_path: resolved_state.node_executable_path.display().to_string(),
            snapshot_helper_path: resolved_state.snapshot_helper_path.display().to_string(),
            open_action_helper_path: resolved_state.open_action_helper_path.display().to_string(),
            kill_action_helper_path: resolved_state.kill_action_helper_path.display().to_string(),
            worktree_action_helper_path: resolved_state
                .worktree_action_helper_path
                .display()
                .to_string(),
            web_root_path: resolved_state.web_root_path.display().to_string(),
            bridge_socket_path: resolved_state.bridge_socket_path.display().to_string(),
        });

        if !issues.iter().any(|issue| issue.blocking) {
            runtime_config = Some(RuntimeConfig {
                metadata_source: resolved_state.metadata_source,
                state_path: resolved_state.state_path,
                package_root: resolved_state.package_root,
                package_version: resolved_state.package_version,
                helper_package_version,
                node_executable_path: resolved_state.node_executable_path,
                snapshot_helper_path: resolved_state.snapshot_helper_path,
                open_action_helper_path: resolved_state.open_action_helper_path,
                kill_action_helper_path: resolved_state.kill_action_helper_path,
                worktree_action_helper_path: resolved_state.worktree_action_helper_path,
                web_root_path: resolved_state.web_root_path,
                bridge_socket_path: resolved_state.bridge_socket_path,
                effective_command_path: effective_command_path.clone(),
            });
        }
    } else {
        add_launch_prereq_issues(&launch_prereqs, &mut issues);
    }

    let ok = !issues.iter().any(|issue| issue.blocking);
    RuntimeDiscovery {
        status: DoctorStatus {
            ok,
            doctor_command: String::from(DOCTOR_COMMAND),
            metadata_source: selected_metadata_source,
            state_path: selected_state_path.display().to_string(),
            desktop_state_path: desktop_state_path.display().to_string(),
            iterm2_fallback_state_path: iterm2_fallback_state_path.display().to_string(),
            effective_command_path,
            launch_prereqs,
            issues,
            runtime: runtime_summary,
        },
        config: runtime_config,
    }
}

pub fn load_runtime_config() -> Result<RuntimeConfig, String> {
    let discovery = discover_runtime();
    match discovery.config {
        Some(config) => Ok(config),
        None => {
            let mut issues = discovery.status.issues.into_iter();
            let first_blocking = issues
                .find(|issue| issue.blocking)
                .map(|issue| format!("{} {}", issue.message, issue.repair));
            Err(first_blocking
                .unwrap_or_else(|| String::from("Session Deck desktop runtime is unavailable.")))
        }
    }
}

fn select_install_state(
    desktop_state_path: &Path,
    iterm2_fallback_state_path: &Path,
    issues: &mut Vec<DoctorIssue>,
) -> Option<ResolvedInstallState> {
    match fs::read_to_string(desktop_state_path) {
        Ok(contents) => match parse_desktop_install_state(&contents, desktop_state_path) {
            Ok(resolved_state) => Some(resolved_state),
            Err(error) => {
                issues.push(DoctorIssue {
                    code: String::from("desktop-install-state-invalid"),
                    message: format!(
                        "Desktop install state at {} is invalid: {error}.",
                        desktop_state_path.display()
                    ),
                    repair: format!(
                        "Run {DESKTOP_INSTALL_COMMAND} to repair the desktop runtime metadata, or {DOCTOR_COMMAND} for details."
                    ),
                    blocking: true,
                });
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            select_iterm2_fallback_state(desktop_state_path, iterm2_fallback_state_path, issues)
        }
        Err(error) => {
            issues.push(DoctorIssue {
                code: String::from("desktop-install-state-unreadable"),
                message: format!(
                    "Could not read desktop install state at {}: {error}.",
                    desktop_state_path.display()
                ),
                repair: format!(
                    "Check filesystem permissions for the Session Deck desktop install state, then run {DESKTOP_INSTALL_COMMAND}."
                ),
                blocking: true,
            });
            None
        }
    }
}

fn select_iterm2_fallback_state(
    desktop_state_path: &Path,
    iterm2_fallback_state_path: &Path,
    issues: &mut Vec<DoctorIssue>,
) -> Option<ResolvedInstallState> {
    match fs::read_to_string(iterm2_fallback_state_path) {
        Ok(contents) => match parse_iterm2_install_state(&contents, iterm2_fallback_state_path) {
            Ok(resolved_state) => {
                issues.push(DoctorIssue {
                    code: String::from("iterm2-install-state-fallback"),
                    message: format!(
                        "Desktop install state was not found at {}; using legacy iTerm2 install metadata at {} for development/back-compat.",
                        desktop_state_path.display(),
                        iterm2_fallback_state_path.display()
                    ),
                    repair: format!(
                        "Run {DESKTOP_INSTALL_COMMAND} to create first-class desktop runtime metadata."
                    ),
                    blocking: false,
                });
                Some(resolved_state)
            }
            Err(error) => {
                issues.push(DoctorIssue {
                    code: String::from("desktop-install-state-missing-iterm2-fallback-invalid"),
                    message: format!(
                        "Desktop install state was not found at {}; legacy iTerm2 fallback metadata at {} is invalid: {error}.",
                        desktop_state_path.display(),
                        iterm2_fallback_state_path.display()
                    ),
                    repair: format!(
                        "Run {DESKTOP_INSTALL_COMMAND} to create desktop runtime metadata, or {DOCTOR_COMMAND} for details."
                    ),
                    blocking: true,
                });
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            issues.push(DoctorIssue {
                code: String::from("desktop-install-state-missing"),
                message: format!(
                    "Desktop install state was not found at {}; no legacy iTerm2 fallback metadata was found at {}.",
                    desktop_state_path.display(),
                    iterm2_fallback_state_path.display()
                ),
                repair: format!(
                    "Run {DESKTOP_INSTALL_COMMAND} to create the runtime config used by the desktop companion."
                ),
                blocking: true,
            });
            None
        }
        Err(error) => {
            issues.push(DoctorIssue {
                code: String::from("desktop-install-state-missing-iterm2-fallback-unreadable"),
                message: format!(
                    "Desktop install state was not found at {}; legacy iTerm2 fallback metadata at {} could not be read: {error}.",
                    desktop_state_path.display(),
                    iterm2_fallback_state_path.display()
                ),
                repair: format!(
                    "Run {DESKTOP_INSTALL_COMMAND} to create first-class desktop runtime metadata."
                ),
                blocking: true,
            });
            None
        }
    }
}

fn validate_resolved_install_state(
    resolved_state: &ResolvedInstallState,
    helper_package_version: Option<&str>,
    launch_prereqs: &LaunchPrereqReport,
    issues: &mut Vec<DoctorIssue>,
) {
    let repair = runtime_metadata_repair(resolved_state.metadata_source);

    validate_executable_path(
        &resolved_state.node_executable_path,
        issues,
        "node-executable-missing",
        "Node executable is missing or not executable.",
        repair,
    );
    validate_readable_file(
        &resolved_state.snapshot_helper_path,
        issues,
        "snapshot-helper-missing",
        "Snapshot helper is missing or unreadable.",
        repair,
    );
    validate_readable_file(
        &resolved_state.open_action_helper_path,
        issues,
        "open-helper-missing",
        "Open-terminal helper is missing or unreadable.",
        repair,
    );
    validate_readable_file(
        &resolved_state.kill_action_helper_path,
        issues,
        "kill-helper-missing",
        "End-session helper is missing or unreadable.",
        repair,
    );
    validate_readable_file(
        &resolved_state.worktree_action_helper_path,
        issues,
        "worktree-helper-missing",
        "Worktree helper is missing or unreadable.",
        repair,
    );
    validate_directory(
        &resolved_state.web_root_path,
        issues,
        "web-root-missing",
        "Installed Session Deck web root is missing.",
        repair,
    );
    validate_bridge_socket(&resolved_state.bridge_socket_path, issues);
    add_launch_prereq_issues(launch_prereqs, issues);

    let expected_web_root = derive_expected_web_root(&resolved_state.package_root);
    if expected_web_root != resolved_state.web_root_path {
        issues.push(DoctorIssue {
            code: String::from("web-root-mismatch"),
            message: format!(
                "Install metadata web root does not match the helper package layout: {}",
                expected_web_root.display()
            ),
            repair: String::from(repair),
            blocking: false,
        });
    }

    if let Some(declared_helper_package_version) =
        resolved_state.declared_helper_package_version.as_deref()
    {
        if declared_helper_package_version != resolved_state.package_version {
            issues.push(DoctorIssue {
                code: String::from("metadata-helper-package-version-mismatch"),
                message: format!(
                    "Desktop install metadata packageVersion {} does not match runtime.helperPackageVersion {}.",
                    resolved_state.package_version, declared_helper_package_version
                ),
                repair: String::from(repair),
                blocking: false,
            });
        }
    }

    if let Some(helper_package_version) = helper_package_version {
        let expected_helper_package_version = resolved_state
            .declared_helper_package_version
            .as_deref()
            .unwrap_or(&resolved_state.package_version);
        if helper_package_version != expected_helper_package_version {
            issues.push(DoctorIssue {
                code: String::from("helper-package-version-mismatch"),
                message: format!(
                    "Install metadata helper version {} does not match helper package version {}.",
                    expected_helper_package_version, helper_package_version
                ),
                repair: String::from(repair),
                blocking: false,
            });
        }
    }
}

fn runtime_metadata_repair(metadata_source: RuntimeMetadataSource) -> &'static str {
    match metadata_source {
        RuntimeMetadataSource::Desktop => {
            "Run /session-deck desktop install to refresh the desktop runtime metadata."
        }
        RuntimeMetadataSource::Iterm2Fallback => {
            "Run /session-deck desktop install to replace the legacy fallback metadata with desktop runtime metadata."
        }
    }
}

fn derive_expected_web_root(package_root: &Path) -> PathBuf {
    package_root.join(WEB_ROOT_RELATIVE_PATH)
}

fn read_helper_package_version(package_root: &Path) -> Result<Option<String>, String> {
    let package_json_path = package_root.join("package.json");
    let package_json = fs::read_to_string(&package_json_path)
        .map_err(|error| format!("Could not read {}: {error}", package_json_path.display()))?;
    let parsed: Value = serde_json::from_str(&package_json)
        .map_err(|error| format!("Could not parse {}: {error}", package_json_path.display()))?;
    Ok(parsed
        .get("version")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned))
}

fn derive_package_root_from_snapshot_helper_path(snapshot_helper_path: &Path) -> Option<PathBuf> {
    snapshot_helper_path
        .ancestors()
        .nth(5)
        .map(Path::to_path_buf)
}

fn default_bridge_socket_path() -> PathBuf {
    let uid = unsafe { geteuid() };
    std::env::temp_dir()
        .join(format!("pi-session-deck-{uid}"))
        .join("iterm2.sock")
}

fn parse_absolute_path(raw_path: &str, field_name: &str) -> Result<PathBuf, String> {
    if raw_path.trim().is_empty() {
        return Err(format!("{field_name} must be a non-empty string."));
    }

    let path = PathBuf::from(raw_path);
    if !path.is_absolute() {
        return Err(format!("{field_name} must be an absolute path."));
    }

    Ok(path)
}

fn validate_executable_path(
    path: &Path,
    issues: &mut Vec<DoctorIssue>,
    code: &str,
    message: &str,
    repair: &str,
) {
    if !path.is_file() || !is_executable(path) {
        issues.push(DoctorIssue {
            code: String::from(code),
            message: format!("{message} Path: {}", path.display()),
            repair: String::from(repair),
            blocking: true,
        });
    }
}

fn validate_readable_file(
    path: &Path,
    issues: &mut Vec<DoctorIssue>,
    code: &str,
    message: &str,
    repair: &str,
) {
    if !path.is_file() {
        issues.push(DoctorIssue {
            code: String::from(code),
            message: format!("{message} Path: {}", path.display()),
            repair: String::from(repair),
            blocking: true,
        });
        return;
    }

    if File::open(path).is_err() {
        issues.push(DoctorIssue {
            code: String::from(code),
            message: format!("{message} Path: {}", path.display()),
            repair: String::from(repair),
            blocking: true,
        });
    }
}

fn validate_directory(
    path: &Path,
    issues: &mut Vec<DoctorIssue>,
    code: &str,
    message: &str,
    repair: &str,
) {
    if !path.is_dir() {
        issues.push(DoctorIssue {
            code: String::from(code),
            message: format!("{message} Path: {}", path.display()),
            repair: String::from(repair),
            blocking: true,
        });
    }
}

fn validate_bridge_socket(path: &Path, issues: &mut Vec<DoctorIssue>) {
    match fs::metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => {}
        Ok(_) => issues.push(DoctorIssue {
            code: String::from("bridge-socket-invalid"),
            message: format!(
                "Bridge socket path exists but is not a Unix socket: {}",
                path.display()
            ),
            repair: String::from(
                "Fully quit and reopen iTerm2 so the Session Deck AutoLaunch bridge can recreate its socket.",
            ),
            blocking: false,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => issues.push(DoctorIssue {
            code: String::from("bridge-socket-missing"),
            message: format!("Bridge socket is missing: {}", path.display()),
            repair: String::from(
                "Start iTerm2 and ensure the Session Deck AutoLaunch runtime is running.",
            ),
            blocking: false,
        }),
        Err(error) => issues.push(DoctorIssue {
            code: String::from("bridge-socket-unreadable"),
            message: format!("Could not inspect bridge socket {}: {error}", path.display()),
            repair: String::from(
                "Check the Session Deck bridge socket permissions and fully restart iTerm2.",
            ),
            blocking: false,
        }),
    }
}

fn add_launch_prereq_issues(report: &LaunchPrereqReport, issues: &mut Vec<DoctorIssue>) {
    if report.tmux.status == "missing" {
        issues.push(DoctorIssue {
            code: String::from("tmux-missing"),
            message: format!(
                "tmux is missing on the effective command PATH derived from {}.",
                report.path_provenance
            ),
            repair: String::from(
                "Install tmux or fix the shell PATH used by Finder-launched apps.",
            ),
            blocking: false,
        });
    }

    if report.pi.status == "missing" {
        issues.push(DoctorIssue {
            code: String::from("pi-missing"),
            message: format!(
                "pi is missing on the effective command PATH derived from {}.",
                report.path_provenance
            ),
            repair: String::from("Install Pi or fix the shell PATH used by Finder-launched apps."),
            blocking: false,
        });
    }
}

fn collect_launch_prereqs(effective_command_path: &EffectiveCommandPath) -> LaunchPrereqReport {
    LaunchPrereqReport {
        path_provenance: effective_command_path.provenance.clone(),
        tmux: resolve_executable_on_path("tmux", effective_command_path),
        pi: resolve_executable_on_path("pi", effective_command_path),
    }
}

fn resolve_executable_on_path(
    command: &str,
    effective_command_path: &EffectiveCommandPath,
) -> ExecutableStatus {
    for entry in std::env::split_paths(OsStr::new(&effective_command_path.value)) {
        let candidate = entry.join(command);
        if candidate.is_file() && is_executable(&candidate) {
            return ExecutableStatus {
                status: String::from("available"),
                path: Some(candidate.display().to_string()),
                message: None,
            };
        }
    }

    ExecutableStatus {
        status: String::from("missing"),
        path: None,
        message: None,
    }
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn resolve_effective_command_path() -> EffectiveCommandPath {
    let fallback = fallback_effective_command_path();
    let Some((shell_path, provenance)) = select_login_shell() else {
        return fallback;
    };

    let shell_name = match shell_path.file_name().and_then(|value| value.to_str()) {
        Some(value) => value,
        None => return fallback,
    };

    let mut command = Command::new(&shell_path);
    command
        .arg("-i")
        .arg("-c")
        .arg(build_effective_command_path_probe_command())
        .arg0(format!("-{shell_name}"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let Ok(mut child) = command.spawn() else {
        return fallback;
    };

    match child.wait_timeout(EFFECTIVE_COMMAND_PATH_TIMEOUT) {
        Ok(Some(status)) if status.success() => match child.wait_with_output() {
            Ok(output) => match parse_effective_command_path_output(&output.stdout) {
                Some(path_value) => EffectiveCommandPath {
                    value: path_value,
                    provenance,
                },
                None => fallback,
            },
            Err(_) => fallback,
        },
        Ok(Some(_)) => fallback,
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            fallback
        }
        Err(_) => fallback,
    }
}

fn fallback_effective_command_path() -> EffectiveCommandPath {
    let inherited_path = std::env::var("PATH").ok();
    if let Some(value) = inherited_path {
        if !value.trim().is_empty() {
            return EffectiveCommandPath {
                value,
                provenance: String::from("inherited process PATH fallback"),
            };
        }
    }

    EffectiveCommandPath {
        value: String::from(FALLBACK_COMMAND_PATH),
        provenance: String::from("system fallback PATH"),
    }
}

fn select_login_shell() -> Option<(PathBuf, String)> {
    if let Some(shell_path) = configured_login_shell_path() {
        return Some((
            shell_path.clone(),
            format!("configured login shell ({})", shell_path.display()),
        ));
    }

    let env_shell = std::env::var("SHELL").ok()?;
    normalize_login_shell_path(&env_shell).map(|shell_path| {
        (
            shell_path.clone(),
            format!("$SHELL login shell fallback ({})", shell_path.display()),
        )
    })
}

fn configured_login_shell_path() -> Option<PathBuf> {
    let uid = unsafe { geteuid() };
    let passwd = unsafe { getpwuid(uid) };
    if passwd.is_null() {
        return None;
    }

    let shell_ptr = unsafe { (*passwd).pw_shell };
    if shell_ptr.is_null() {
        return None;
    }

    let shell = unsafe { CStr::from_ptr(shell_ptr) }
        .to_string_lossy()
        .into_owned();
    normalize_login_shell_path(&shell)
}

fn normalize_login_shell_path(candidate: &str) -> Option<PathBuf> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return None;
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() || !path.is_file() || !is_executable(&path) {
        return None;
    }

    Some(path)
}

fn build_effective_command_path_probe_command() -> String {
    format!(
        "/usr/bin/printf '%s\\n' {EFFECTIVE_COMMAND_PATH_START}; /usr/bin/printenv PATH; /usr/bin/printf '%s\\n' {EFFECTIVE_COMMAND_PATH_END}"
    )
}

fn parse_effective_command_path_output(stdout: &[u8]) -> Option<String> {
    let output = String::from_utf8_lossy(stdout);
    let lines: Vec<&str> = output.lines().collect();
    let start_index = lines
        .iter()
        .position(|line| *line == EFFECTIVE_COMMAND_PATH_START)?;
    let end_index = lines
        .iter()
        .skip(start_index + 1)
        .position(|line| *line == EFFECTIVE_COMMAND_PATH_END)?
        + start_index
        + 1;

    if end_index != start_index + 2 {
        return None;
    }

    let path_value = lines[start_index + 1].trim();
    if path_value.is_empty() {
        return None;
    }

    Some(String::from(path_value))
}

#[cfg(test)]
mod tests {
    use super::{
        derive_kill_action_helper_path, derive_open_action_helper_path,
        derive_worktree_action_helper_path, discover_runtime_from_state_paths,
        parse_desktop_install_state, parse_install_state, EffectiveCommandPath,
        RuntimeMetadataSource, KILL_HELPER_RELATIVE_PATH, OPEN_HELPER_RELATIVE_PATH,
        SNAPSHOT_HELPER_RELATIVE_PATH, WEB_ROOT_RELATIVE_PATH, WORKTREE_HELPER_RELATIVE_PATH,
    };
    use serde_json::json;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn derives_helper_paths_from_snapshot_helper_path() {
        let snapshot_helper_path =
            Path::new("/tmp/pi-session-deck/dist/extensions/session-deck/iterm2/snapshot-cli.js");

        assert_eq!(
            derive_open_action_helper_path(snapshot_helper_path),
            Path::new(
                "/tmp/pi-session-deck/dist/extensions/session-deck/iterm2/open-action-cli.js"
            )
        );
        assert_eq!(
            derive_kill_action_helper_path(snapshot_helper_path),
            Path::new(
                "/tmp/pi-session-deck/dist/extensions/session-deck/iterm2/kill-action-cli.js"
            )
        );
        assert_eq!(
            derive_worktree_action_helper_path(snapshot_helper_path),
            Path::new("/tmp/pi-session-deck/dist/extensions/session-deck/worktree/action-cli.js")
        );
    }

    #[test]
    fn parses_desktop_install_state_and_derives_allowlisted_helper_paths() {
        let package_root = Path::new("/tmp/pi-session-deck");
        let contents = desktop_state_json(
            package_root,
            Path::new("/usr/local/bin/node"),
            "0.10.0",
            "0.10.0",
        );

        let parsed =
            parse_desktop_install_state(&contents, Path::new("/tmp/install.json")).unwrap();

        assert_eq!(parsed.metadata_source, RuntimeMetadataSource::Desktop);
        assert_eq!(parsed.package_root, package_root);
        assert_eq!(
            parsed.snapshot_helper_path,
            package_root.join(SNAPSHOT_HELPER_RELATIVE_PATH)
        );
        assert_eq!(
            parsed.open_action_helper_path,
            package_root.join(OPEN_HELPER_RELATIVE_PATH)
        );
        assert_eq!(
            parsed.kill_action_helper_path,
            package_root.join(KILL_HELPER_RELATIVE_PATH)
        );
        assert_eq!(
            parsed.worktree_action_helper_path,
            package_root.join(WORKTREE_HELPER_RELATIVE_PATH)
        );
    }

    #[test]
    fn parses_install_state_and_derives_allowlisted_helper_paths() {
        let contents = r#"
        {
          "schemaVersion": 1,
          "product": "pi-session-deck-iterm2",
          "packageVersion": "0.9.0",
          "installedAt": "2026-07-17T00:00:00.000Z",
          "scriptsDir": "/Users/tester/Library/Application Support/iTerm2/Scripts",
          "script": {
            "path": "/Users/tester/Library/Application Support/iTerm2/Scripts/AutoLaunch/session_deck.py",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "runtime": {
            "nodeExecutablePath": "/usr/local/bin/node",
            "snapshotHelperPath": "/tmp/pi-session-deck/dist/extensions/session-deck/iterm2/snapshot-cli.js",
            "webRootPath": "/tmp/pi-session-deck/extensions/session-deck/iterm2/web",
            "bridgeSocketPath": "/tmp/pi-session-deck/bridge.sock"
          }
        }
        "#;

        let parsed = parse_install_state(contents, Path::new("/tmp/install.json")).unwrap();

        assert_eq!(
            parsed.metadata_source,
            RuntimeMetadataSource::Iterm2Fallback
        );
        assert_eq!(parsed.package_root, Path::new("/tmp/pi-session-deck"));
        assert_eq!(
            parsed.open_action_helper_path,
            Path::new(
                "/tmp/pi-session-deck/dist/extensions/session-deck/iterm2/open-action-cli.js"
            )
        );
        assert_eq!(
            parsed.kill_action_helper_path,
            Path::new(
                "/tmp/pi-session-deck/dist/extensions/session-deck/iterm2/kill-action-cli.js"
            )
        );
        assert_eq!(
            parsed.worktree_action_helper_path,
            Path::new("/tmp/pi-session-deck/dist/extensions/session-deck/worktree/action-cli.js")
        );
    }

    #[test]
    fn rejects_relative_runtime_paths() {
        let contents = r#"
        {
          "schemaVersion": 1,
          "product": "pi-session-deck-iterm2",
          "packageVersion": "0.9.0",
          "installedAt": "2026-07-17T00:00:00.000Z",
          "scriptsDir": "/tmp/scripts",
          "script": {
            "path": "/tmp/scripts/AutoLaunch/session_deck.py",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "runtime": {
            "nodeExecutablePath": "node",
            "snapshotHelperPath": "/tmp/pi-session-deck/dist/extensions/session-deck/iterm2/snapshot-cli.js",
            "webRootPath": "/tmp/pi-session-deck/extensions/session-deck/iterm2/web",
            "bridgeSocketPath": "/tmp/pi-session-deck/bridge.sock"
          }
        }
        "#;

        let error = parse_install_state(contents, Path::new("/tmp/install.json")).unwrap_err();
        assert!(error.contains("runtime.nodeExecutablePath must be an absolute path"));
    }

    #[test]
    fn discovers_desktop_metadata_before_iterm2_fallback() {
        let temp = tempdir().unwrap();
        let node_path = temp.path().join("bin/node");
        write_executable(&node_path);
        let effective_path = write_effective_path_tools(temp.path());

        let desktop_package_root = temp.path().join("desktop-package");
        let fallback_package_root = temp.path().join("fallback-package");
        write_helper_package(&desktop_package_root, "1.2.0");
        write_helper_package(&fallback_package_root, "0.9.0");

        let desktop_state_path = temp
            .path()
            .join("home/.pi/session-deck/desktop/install.json");
        let fallback_state_path = temp
            .path()
            .join("home/.pi/session-deck/iterm2/install.json");
        write_state(
            &desktop_state_path,
            desktop_state_json(&desktop_package_root, &node_path, "1.2.0", "1.2.0"),
        );
        write_state(
            &fallback_state_path,
            iterm2_state_json(&fallback_package_root, &node_path, temp.path()),
        );

        let discovery = discover_runtime_from_state_paths(
            &desktop_state_path,
            &fallback_state_path,
            effective_path,
        );
        let config = discovery.config.expect("desktop metadata should be usable");

        assert_eq!(config.metadata_source, RuntimeMetadataSource::Desktop);
        assert_eq!(config.package_root, desktop_package_root);
        assert_eq!(config.package_version, "1.2.0");
        assert_eq!(config.helper_package_version.as_deref(), Some("1.2.0"));
        assert_eq!(discovery.status.metadata_source, "desktop");
        assert_eq!(
            discovery.status.state_path,
            desktop_state_path.display().to_string()
        );
        assert!(discovery
            .status
            .issues
            .iter()
            .all(|issue| issue.code != "iterm2-install-state-fallback"));
    }

    #[test]
    fn falls_back_to_iterm2_metadata_when_desktop_metadata_is_missing() {
        let temp = tempdir().unwrap();
        let node_path = temp.path().join("bin/node");
        write_executable(&node_path);
        let effective_path = write_effective_path_tools(temp.path());

        let fallback_package_root = temp.path().join("fallback-package");
        write_helper_package(&fallback_package_root, "0.9.0");

        let desktop_state_path = temp
            .path()
            .join("home/.pi/session-deck/desktop/install.json");
        let fallback_state_path = temp
            .path()
            .join("home/.pi/session-deck/iterm2/install.json");
        write_state(
            &fallback_state_path,
            iterm2_state_json(&fallback_package_root, &node_path, temp.path()),
        );

        let discovery = discover_runtime_from_state_paths(
            &desktop_state_path,
            &fallback_state_path,
            effective_path,
        );
        let config = discovery
            .config
            .expect("fallback metadata should be usable");

        assert_eq!(
            config.metadata_source,
            RuntimeMetadataSource::Iterm2Fallback
        );
        assert_eq!(config.package_root, fallback_package_root);
        assert_eq!(discovery.status.metadata_source, "iterm2-fallback");
        assert_eq!(
            discovery.status.state_path,
            fallback_state_path.display().to_string()
        );

        let fallback_issue = discovery
            .status
            .issues
            .iter()
            .find(|issue| issue.code == "iterm2-install-state-fallback")
            .expect("fallback diagnostic should be explicit");
        assert!(!fallback_issue.blocking);
        assert!(fallback_issue
            .message
            .contains("legacy iTerm2 install metadata"));
        assert!(fallback_issue
            .repair
            .contains("/session-deck desktop install"));
        assert!(!fallback_issue.repair.contains("/session-deck iterm2"));
    }

    #[test]
    fn invalid_desktop_metadata_does_not_silently_fallback_to_iterm2() {
        let temp = tempdir().unwrap();
        let node_path = temp.path().join("bin/node");
        write_executable(&node_path);
        let effective_path = write_effective_path_tools(temp.path());

        let fallback_package_root = temp.path().join("fallback-package");
        write_helper_package(&fallback_package_root, "0.9.0");

        let desktop_state_path = temp
            .path()
            .join("home/.pi/session-deck/desktop/install.json");
        let fallback_state_path = temp
            .path()
            .join("home/.pi/session-deck/iterm2/install.json");
        write_state(&desktop_state_path, String::from("not json"));
        write_state(
            &fallback_state_path,
            iterm2_state_json(&fallback_package_root, &node_path, temp.path()),
        );

        let discovery = discover_runtime_from_state_paths(
            &desktop_state_path,
            &fallback_state_path,
            effective_path,
        );

        assert!(discovery.config.is_none());
        let issue = discovery
            .status
            .issues
            .iter()
            .find(|issue| issue.code == "desktop-install-state-invalid")
            .expect("invalid desktop metadata should be reported");
        assert!(issue.blocking);
        assert!(issue.repair.contains("/session-deck desktop install"));
        assert!(!issue.repair.contains("/session-deck iterm2"));
    }

    fn desktop_state_json(
        package_root: &Path,
        node_path: &Path,
        package_version: &str,
        helper_package_version: &str,
    ) -> String {
        serde_json::to_string_pretty(&json!({
          "schemaVersion": 1,
          "product": "session-deck-desktop",
          "packageName": "@robhowley/pi-session-deck",
          "packageVersion": package_version,
          "installedAt": "2026-07-17T00:00:00.000Z",
          "app": {
            "path": "/Users/tester/Applications/Session Deck.app",
            "bundleIdentifier": "dev.pi-userland.session-deck.desktop",
            "version": package_version,
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "source": {
            "kind": "local-path",
            "path": "/tmp/Session Deck.app",
            "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          },
          "runtime": {
            "nodeExecutablePath": node_path,
            "packageRoot": package_root,
            "helperPackageVersion": helper_package_version
          },
          "ownedPaths": ["/Users/tester/Applications/Session Deck.app"]
        }))
        .unwrap()
    }

    fn iterm2_state_json(package_root: &Path, node_path: &Path, temp_root: &Path) -> String {
        serde_json::to_string_pretty(&json!({
          "schemaVersion": 1,
          "product": "pi-session-deck-iterm2",
          "packageVersion": "0.9.0",
          "installedAt": "2026-07-17T00:00:00.000Z",
          "scriptsDir": temp_root.join("scripts"),
          "script": {
            "path": temp_root.join("scripts/AutoLaunch/session_deck.py"),
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "runtime": {
            "nodeExecutablePath": node_path,
            "snapshotHelperPath": package_root.join(SNAPSHOT_HELPER_RELATIVE_PATH),
            "webRootPath": package_root.join(WEB_ROOT_RELATIVE_PATH),
            "bridgeSocketPath": temp_root.join("bridge.sock")
          }
        }))
        .unwrap()
    }

    fn write_helper_package(package_root: &Path, version: &str) {
        fs::create_dir_all(package_root).unwrap();
        fs::write(
            package_root.join("package.json"),
            serde_json::to_string(&json!({
                "name": "@robhowley/pi-session-deck",
                "version": version
            }))
            .unwrap(),
        )
        .unwrap();
        write_readable_file(&package_root.join(SNAPSHOT_HELPER_RELATIVE_PATH));
        write_readable_file(&package_root.join(OPEN_HELPER_RELATIVE_PATH));
        write_readable_file(&package_root.join(KILL_HELPER_RELATIVE_PATH));
        write_readable_file(&package_root.join(WORKTREE_HELPER_RELATIVE_PATH));
        fs::create_dir_all(package_root.join(WEB_ROOT_RELATIVE_PATH)).unwrap();
    }

    fn write_effective_path_tools(temp_root: &Path) -> EffectiveCommandPath {
        let bin = temp_root.join("bin");
        write_executable(&bin.join("pi"));
        write_executable(&bin.join("tmux"));
        EffectiveCommandPath {
            value: bin.display().to_string(),
            provenance: String::from("test PATH"),
        }
    }

    fn write_state(path: &Path, contents: String) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn write_readable_file(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "// helper\n").unwrap();
    }

    fn write_executable(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "#!/bin/sh\n").unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }
}
