use crate::commands::{
    CreateSessionRequest, CreateWorktreeRequest, KillSessionRequest, OpenTerminalRequest,
    PreviewWorktreeBaseRefRequest, PreviewWorktreeLaunchContextRequest,
};
use crate::runtime::{load_runtime_config, RuntimeConfig, OPEN_TERMINAL_ACTION_BRIDGE_SOCKET_ENV};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const ACTION_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub struct CommandError {
    public_message: String,
    detail: Option<String>,
}

impl CommandError {
    pub fn new(public_message: impl Into<String>) -> Self {
        Self {
            public_message: public_message.into(),
            detail: None,
        }
    }

    pub fn with_detail(public_message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            public_message: public_message.into(),
            detail: Some(detail.into()),
        }
    }

    pub fn into_public_message(self) -> String {
        if let Some(detail) = self.detail {
            eprintln!("{detail}");
        }
        self.public_message
    }
}

pub fn load_snapshot() -> Result<Value, CommandError> {
    let runtime_config = load_config_for_command()?;
    let output = run_helper(
        &runtime_config,
        HelperSpec {
            script_path: &runtime_config.snapshot_helper_path,
            stdin_payload: None,
            timeout: SNAPSHOT_TIMEOUT,
            bridge_socket_path: None,
            public_error_message:
                "Session Deck snapshot is unavailable. Open desktop diagnostics for details.",
        },
    )?;

    if !output.success {
        return Err(CommandError::with_detail(
            "Session Deck snapshot is unavailable. Open desktop diagnostics for details.",
            format!(
                "Snapshot helper exited with a non-zero status. {}",
                format_process_detail(&output.stdout, &output.stderr)
            ),
        ));
    }

    parse_json_object(
        &output.stdout,
        "Session Deck snapshot helper returned invalid JSON.",
        "snapshot-helper-invalid-json",
    )
}

pub fn preview_worktree_base_ref(
    request: PreviewWorktreeBaseRefRequest,
) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.worktree_action_helper_path,
        json!({
            "action": "preview-base-ref",
            "repoIntent": request.repo_intent,
        }),
        "Create-worktree preview is unavailable. Open desktop diagnostics for details.",
    )
}

pub fn preview_worktree_launch_context(
    request: PreviewWorktreeLaunchContextRequest,
) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.worktree_action_helper_path,
        json!({
            "action": "preview-launch-context",
            "launch": request.launch,
        }),
        "Pi config preview is unavailable. Open desktop diagnostics for details.",
    )
}

pub fn create_worktree(request: CreateWorktreeRequest) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.worktree_action_helper_path,
        serde_json::to_value(&request).map_err(|error| {
            CommandError::with_detail(
                "Create-worktree request is invalid.",
                format!("Could not serialize the worktree request: {error}"),
            )
        })?,
        "Create-worktree action is unavailable. Open desktop diagnostics for details.",
    )
}

pub fn create_session(request: CreateSessionRequest) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.worktree_action_helper_path,
        serde_json::to_value(&request).map_err(|error| {
            CommandError::with_detail(
                "Create-session request is invalid.",
                format!("Could not serialize the create-session request: {error}"),
            )
        })?,
        "Create-session action is unavailable. Open desktop diagnostics for details.",
    )
}

pub fn open_terminal(request: OpenTerminalRequest) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.open_action_helper_path,
        serde_json::to_value(&request).map_err(|error| {
            CommandError::with_detail(
                "Open-terminal request is invalid.",
                format!("Could not serialize the open-terminal request: {error}"),
            )
        })?,
        "Open-terminal action is unavailable. Open desktop diagnostics for details.",
    )
}

pub fn kill_session(request: KillSessionRequest) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.kill_action_helper_path,
        serde_json::to_value(&request).map_err(|error| {
            CommandError::with_detail(
                "End-session request is invalid.",
                format!("Could not serialize the end-session request: {error}"),
            )
        })?,
        "End-session action is unavailable. Open desktop diagnostics for details.",
    )
}

fn load_config_for_command() -> Result<RuntimeConfig, CommandError> {
    load_runtime_config().map_err(|detail| {
        CommandError::with_detail(
            "Session Deck desktop runtime is unavailable. Open desktop diagnostics for details.",
            detail,
        )
    })
}

fn run_action_helper(
    runtime_config: &RuntimeConfig,
    script_path: &std::path::Path,
    payload: Value,
    public_error_message: &str,
) -> Result<Value, CommandError> {
    let output = run_helper(
        runtime_config,
        HelperSpec {
            script_path,
            stdin_payload: Some(serde_json::to_vec(&payload).map_err(|error| {
                CommandError::with_detail(
                    public_error_message,
                    format!("Could not encode JSON payload: {error}"),
                )
            })?),
            timeout: ACTION_TIMEOUT,
            bridge_socket_path: if script_path == runtime_config.open_action_helper_path.as_path() {
                Some(runtime_config.bridge_socket_path.as_path())
            } else {
                None
            },
            public_error_message,
        },
    )?;

    let parsed = parse_json_object(
        &output.stdout,
        public_error_message,
        "action-helper-invalid-json",
    )?;

    if output.success {
        return Ok(parsed);
    }

    Ok(parsed)
}

fn parse_json_object(
    stdout: &str,
    public_error_message: &str,
    detail_code: &str,
) -> Result<Value, CommandError> {
    let parsed: Value = serde_json::from_str(stdout).map_err(|error| {
        CommandError::with_detail(
            public_error_message,
            format!("{detail_code}: could not parse helper stdout as JSON: {error}"),
        )
    })?;

    if !parsed.is_object() {
        return Err(CommandError::with_detail(
            public_error_message,
            format!("{detail_code}: helper stdout was not a JSON object."),
        ));
    }

    Ok(parsed)
}

struct HelperSpec<'a> {
    script_path: &'a std::path::Path,
    stdin_payload: Option<Vec<u8>>,
    timeout: Duration,
    bridge_socket_path: Option<&'a std::path::Path>,
    public_error_message: &'a str,
}

struct HelperOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

fn run_helper(
    runtime_config: &RuntimeConfig,
    helper_spec: HelperSpec<'_>,
) -> Result<HelperOutput, CommandError> {
    let mut command = Command::new(&runtime_config.node_executable_path);
    command
        .arg(helper_spec.script_path)
        .stdin(if helper_spec.stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", &runtime_config.effective_command_path.value);

    if let Some(bridge_socket_path) = helper_spec.bridge_socket_path {
        command.env(
            OPEN_TERMINAL_ACTION_BRIDGE_SOCKET_ENV,
            bridge_socket_path.as_os_str(),
        );
    }

    let mut child = command.spawn().map_err(|error| {
        CommandError::with_detail(
            helper_spec.public_error_message,
            format!(
                "Could not spawn helper {} with node {}: {error}",
                helper_spec.script_path.display(),
                runtime_config.node_executable_path.display()
            ),
        )
    })?;

    if let Some(stdin_payload) = helper_spec.stdin_payload {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            CommandError::with_detail(
                helper_spec.public_error_message,
                "Helper stdin was not available after spawning the process.",
            )
        })?;
        stdin.write_all(&stdin_payload).map_err(|error| {
            CommandError::with_detail(
                helper_spec.public_error_message,
                format!("Could not write helper stdin payload: {error}"),
            )
        })?;
    }

    match child.wait_timeout(helper_spec.timeout) {
        Ok(Some(status)) => {
            let output = child.wait_with_output().map_err(|error| {
                CommandError::with_detail(
                    helper_spec.public_error_message,
                    format!("Could not collect helper output: {error}"),
                )
            })?;

            Ok(HelperOutput {
                success: status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            })
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(CommandError::with_detail(
                helper_spec.public_error_message,
                format!(
                    "Helper process timed out after {} seconds.",
                    helper_spec.timeout.as_secs()
                ),
            ))
        }
        Err(error) => Err(CommandError::with_detail(
            helper_spec.public_error_message,
            format!("Could not wait for helper completion: {error}"),
        )),
    }
}

fn format_process_detail(stdout: &str, stderr: &str) -> String {
    let stdout = stdout.trim();
    let stderr = stderr.trim();

    if !stderr.is_empty() {
        return format!("stderr: {stderr}");
    }

    if !stdout.is_empty() {
        return format!("stdout: {stdout}");
    }

    String::from("no stdout or stderr was captured")
}
