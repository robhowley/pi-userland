use crate::doctor;
use crate::helper_runner::{self, CommandError};
use crate::runtime::DoctorStatus;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

const MAX_RUNTIME_ID_LENGTH: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoIntentRequest {
    pub candidate_runtime_ids: Vec<String>,
    #[serde(default)]
    pub preferred_runtime_id: Option<String>,
    #[serde(default)]
    pub qualified_repo_name: Option<String>,
    #[serde(default)]
    pub repo_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum LaunchMode {
    #[serde(rename = "tmux-detached")]
    TmuxDetached,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum LaunchAgentDirMode {
    #[serde(rename = "ambient")]
    Ambient,
    #[serde(rename = "default")]
    Default,
    #[serde(rename = "custom")]
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchAgentDirRequest {
    pub mode: LaunchAgentDirMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchRequest {
    pub mode: LaunchMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_dir: Option<LaunchAgentDirRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewWorktreeBaseRefRequest {
    pub repo_intent: RepoIntentRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewWorktreeLaunchContextRequest {
    #[serde(default = "default_launch_request")]
    pub launch: LaunchRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWorktreeRequest {
    pub repo_intent: RepoIntentRequest,
    pub branch_name: String,
    #[serde(default)]
    pub base_ref: Option<String>,
    #[serde(default = "default_launch_request")]
    pub launch: LaunchRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSessionRequest {
    pub action: CreateSessionAction,
    pub cwd: String,
    #[serde(default = "default_launch_request")]
    pub launch: LaunchRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CreateSessionAction {
    #[serde(rename = "create-session")]
    CreateSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenTerminalRequest {
    pub runtime_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KillSessionRequest {
    pub runtime_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationStatus {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl RepoIntentRequest {
    pub fn validate(&self) -> Result<(), CommandError> {
        if self.candidate_runtime_ids.is_empty()
            && self.preferred_runtime_id.is_none()
            && self.qualified_repo_name.is_none()
            && self.repo_name.is_none()
        {
            return Err(CommandError::new(
                "repoIntent must identify at least one repository or runtime.",
            ));
        }

        for runtime_id in &self.candidate_runtime_ids {
            validate_runtime_id(runtime_id)?;
        }

        if let Some(preferred_runtime_id) = &self.preferred_runtime_id {
            validate_runtime_id(preferred_runtime_id)?;
        }

        Ok(())
    }
}

impl LaunchAgentDirRequest {
    pub fn validate(&self) -> Result<(), CommandError> {
        match self.mode {
            LaunchAgentDirMode::Ambient | LaunchAgentDirMode::Default => {
                if self.custom_dir.is_some() {
                    return Err(CommandError::new(
                        "launch.agentDir.customDir is only valid for custom mode.",
                    ));
                }
                Ok(())
            }
            LaunchAgentDirMode::Custom => {
                let custom_dir = self.custom_dir.as_deref().ok_or_else(|| {
                    CommandError::new("launch.agentDir.customDir is required for custom mode.")
                })?;
                validate_custom_agent_dir(custom_dir)
            }
        }
    }
}

impl LaunchRequest {
    pub fn validate(&self) -> Result<(), CommandError> {
        if let Some(agent_dir) = &self.agent_dir {
            agent_dir.validate()?;
        }
        Ok(())
    }
}

impl PreviewWorktreeBaseRefRequest {
    pub fn validate(&self) -> Result<(), CommandError> {
        self.repo_intent.validate()
    }
}

impl PreviewWorktreeLaunchContextRequest {
    pub fn validate(&self) -> Result<(), CommandError> {
        self.launch.validate()
    }
}

impl CreateWorktreeRequest {
    pub fn validate(&self) -> Result<(), CommandError> {
        self.repo_intent.validate()?;
        if self.branch_name.trim().is_empty() {
            return Err(CommandError::new("branchName must be a non-empty string."));
        }

        if let Some(base_ref) = &self.base_ref {
            if base_ref.trim().is_empty() {
                return Err(CommandError::new(
                    "baseRef must not be empty when provided.",
                ));
            }
        }

        self.launch.validate()
    }
}

impl CreateSessionRequest {
    pub fn validate(&self) -> Result<(), CommandError> {
        validate_cwd(&self.cwd)?;
        self.launch.validate()
    }
}

impl OpenTerminalRequest {
    pub fn validate(&self) -> Result<(), CommandError> {
        validate_runtime_id(&self.runtime_id)
    }
}

impl KillSessionRequest {
    pub fn validate(&self) -> Result<(), CommandError> {
        validate_runtime_id(&self.runtime_id)
    }
}

#[tauri::command]
pub async fn load_snapshot() -> Result<Value, String> {
    run_blocking(helper_runner::load_snapshot).await
}

#[tauri::command]
pub async fn preview_worktree_base_ref(
    request: PreviewWorktreeBaseRefRequest,
) -> Result<Value, String> {
    run_blocking(move || helper_runner::preview_worktree_base_ref(request)).await
}

#[tauri::command]
pub async fn preview_worktree_launch_context(
    request: PreviewWorktreeLaunchContextRequest,
) -> Result<Value, String> {
    run_blocking(move || helper_runner::preview_worktree_launch_context(request)).await
}

#[tauri::command]
pub async fn create_worktree(request: CreateWorktreeRequest) -> Result<Value, String> {
    run_blocking(move || helper_runner::create_worktree(request)).await
}

#[tauri::command]
pub async fn create_session(request: CreateSessionRequest) -> Result<Value, String> {
    run_blocking(move || helper_runner::create_session(request)).await
}

#[tauri::command]
pub async fn open_terminal(request: OpenTerminalRequest) -> Result<Value, String> {
    run_blocking(move || helper_runner::open_terminal(request)).await
}

#[tauri::command]
pub async fn kill_session(request: KillSessionRequest) -> Result<Value, String> {
    run_blocking(move || helper_runner::kill_session(request)).await
}

#[tauri::command]
pub fn open_external(url: String) -> OperationStatus {
    if !is_supported_external_url(&url) {
        return OperationStatus::failed("Only http:// and https:// URLs are supported.");
    }

    match open::that_detached(url) {
        Ok(()) => OperationStatus::ok(),
        Err(_) => OperationStatus::failed("Could not open the external link."),
    }
}

#[tauri::command]
pub fn copy_text(text: String) -> OperationStatus {
    match arboard::Clipboard::new().and_then(|mut clipboard| clipboard.set_text(text)) {
        Ok(()) => OperationStatus::ok(),
        Err(_) => OperationStatus::failed("Could not copy text to the clipboard."),
    }
}

#[tauri::command]
pub fn doctor_status() -> DoctorStatus {
    doctor::doctor_status()
}

impl OperationStatus {
    fn ok() -> Self {
        Self {
            ok: true,
            message: None,
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: Some(message.into()),
        }
    }
}

fn default_launch_request() -> LaunchRequest {
    LaunchRequest {
        mode: LaunchMode::TmuxDetached,
        agent_dir: None,
    }
}

fn is_supported_external_url(url: &str) -> bool {
    Url::parse(url)
        .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn validate_cwd(cwd: &str) -> Result<(), CommandError> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err(CommandError::new("cwd must be a non-empty string."));
    }

    if cwd.contains('\0') || cwd.contains('\r') || cwd.contains('\n') {
        return Err(CommandError::new(
            "cwd must not contain newlines or NUL bytes.",
        ));
    }

    if !(trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with('/')) {
        return Err(CommandError::new(
            "cwd must be absolute, ~, or start with ~/.",
        ));
    }

    Ok(())
}

fn validate_runtime_id(runtime_id: &str) -> Result<(), CommandError> {
    if runtime_id.is_empty() {
        return Err(CommandError::new("runtimeId must be a non-empty string."));
    }

    if runtime_id.trim() != runtime_id || runtime_id.chars().any(char::is_whitespace) {
        return Err(CommandError::new(
            "runtimeId must be a safe identity segment.",
        ));
    }

    if runtime_id.len() > MAX_RUNTIME_ID_LENGTH {
        return Err(CommandError::new("runtimeId is too long."));
    }

    if runtime_id == "." || runtime_id == ".." {
        return Err(CommandError::new(
            "runtimeId must be a safe identity segment.",
        ));
    }

    if runtime_id.contains('/')
        || runtime_id.contains('\\')
        || runtime_id.chars().any(is_control_character)
    {
        return Err(CommandError::new(
            "runtimeId must be a safe identity segment.",
        ));
    }

    Ok(())
}

fn validate_custom_agent_dir(custom_dir: &str) -> Result<(), CommandError> {
    if custom_dir.contains('\0') || custom_dir.contains('\r') || custom_dir.contains('\n') {
        return Err(CommandError::new(
            "launch.agentDir.customDir must not contain newlines or NUL bytes.",
        ));
    }

    let trimmed = custom_dir.trim();
    if trimmed.is_empty() {
        return Err(CommandError::new(
            "launch.agentDir.customDir must be a non-empty string.",
        ));
    }

    if !(trimmed.starts_with('/') || trimmed.starts_with("~/")) {
        return Err(CommandError::new(
            "launch.agentDir.customDir must be absolute or start with ~/.",
        ));
    }

    Ok(())
}

fn is_control_character(character: char) -> bool {
    character.is_control()
}

async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Desktop command worker failed: {error}"))?
        .map_err(CommandError::into_public_message)
}

#[cfg(test)]
mod tests {
    use super::{
        CreateSessionAction, CreateSessionRequest, CreateWorktreeRequest, KillSessionRequest,
        LaunchAgentDirMode, LaunchMode, OpenTerminalRequest, PreviewWorktreeLaunchContextRequest,
    };
    use serde_json::json;

    #[test]
    fn create_worktree_defaults_to_tmux_detached_launch() {
        let parsed: CreateWorktreeRequest = serde_json::from_value(json!({
            "repoIntent": {
                "candidateRuntimeIds": ["runtime-1"],
                "repoName": "pi-userland"
            },
            "branchName": "feat/desktop-shell"
        }))
        .unwrap();

        assert_eq!(parsed.launch.mode, LaunchMode::TmuxDetached);
        assert_eq!(parsed.launch.agent_dir, None);
    }

    #[test]
    fn preview_worktree_launch_context_defaults_to_tmux_detached_launch() {
        let parsed: PreviewWorktreeLaunchContextRequest =
            serde_json::from_value(json!({})).unwrap();

        assert_eq!(parsed.launch.mode, LaunchMode::TmuxDetached);
        assert_eq!(parsed.launch.agent_dir, None);
    }

    #[test]
    fn create_worktree_accepts_custom_agent_dir() {
        let parsed: CreateWorktreeRequest = serde_json::from_value(json!({
            "repoIntent": {
                "candidateRuntimeIds": ["runtime-1"],
                "repoName": "pi-userland"
            },
            "branchName": "feat/desktop-shell",
            "launch": {
                "mode": "tmux-detached",
                "agentDir": {
                    "mode": "custom",
                    "customDir": "~/agent-work"
                }
            }
        }))
        .unwrap();

        assert_eq!(parsed.launch.mode, LaunchMode::TmuxDetached);
        assert_eq!(
            parsed
                .launch
                .agent_dir
                .as_ref()
                .map(|agent_dir| agent_dir.mode.clone()),
            Some(LaunchAgentDirMode::Custom)
        );
    }

    #[test]
    fn create_session_accepts_custom_agent_dir() {
        let parsed: CreateSessionRequest = serde_json::from_value(json!({
            "action": "create-session",
            "cwd": "~/scratch",
            "launch": {
                "mode": "tmux-detached",
                "agentDir": {
                    "mode": "custom",
                    "customDir": "~/agent-work"
                }
            }
        }))
        .unwrap();

        parsed.validate().unwrap();
        assert_eq!(parsed.action, CreateSessionAction::CreateSession);
        assert_eq!(parsed.launch.mode, LaunchMode::TmuxDetached);
        assert_eq!(
            parsed
                .launch
                .agent_dir
                .as_ref()
                .map(|agent_dir| agent_dir.mode.clone()),
            Some(LaunchAgentDirMode::Custom)
        );
    }

    #[test]
    fn create_session_rejects_relative_cwd() {
        let request: CreateSessionRequest = serde_json::from_value(json!({
            "action": "create-session",
            "cwd": "relative/path"
        }))
        .unwrap();

        let error = request.validate().unwrap_err().into_public_message();
        assert!(error.contains("cwd must be absolute"));
    }

    #[test]
    fn open_terminal_request_rejects_whitespace_runtime_ids() {
        let request = OpenTerminalRequest {
            runtime_id: "runtime id".into(),
        };

        let error = request.validate().unwrap_err();
        assert_eq!(
            error.into_public_message(),
            "runtimeId must be a safe identity segment."
        );
    }

    #[test]
    fn kill_session_request_rejects_unsafe_runtime_ids() {
        let request = KillSessionRequest {
            runtime_id: String::from("../runtime-1"),
        };

        let error = request.validate().unwrap_err();
        assert_eq!(
            error.into_public_message(),
            "runtimeId must be a safe identity segment."
        );
    }
}
